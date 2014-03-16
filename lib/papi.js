/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * The PAPI HTTP interface. Sets up routes and handles listing and updates of
 * packages.
 */

var fs = require('fs');
var util = require('util');
var http = require('http');
var https = require('https');
var restify = require('restify');
var Logger = require('bunyan');
var vasync = require('vasync');
var sapi = require('sdc-clients').SAPI;

var Backend = require('./backend');
var validations = require('./validations');
var tools = require('./tools');

var libuuid = require('libuuid');
function uuid() {
    return (libuuid.create());
}

var assert = require('assert');
assert.argument = function assertArgument(name, type, arg) {
    if (typeof (arg) !== type) {
        throw new TypeError(name + ' (' + type + ') required');
    }
};

var DISPLAY_QUEUES_INTERVAL = 1000; // in ms
var PKG_VERSION = 1;

// Define path and versioned routes:
var PACKAGES_PATH = '/packages';
var PACKAGE_PATH = PACKAGES_PATH + '/:uuid';
var PACKAGES_ROUTE = {
    path: PACKAGES_PATH,
    version: '7.0.0'
};
var PACKAGE_ROUTE = {
    path: PACKAGE_PATH,
    version: '7.0.0'
};

var PING_PATH = '/ping';
var PING_ROUTE = {
    path: PING_PATH,
    version: '7.0.0'
};



// No need to initialize, except on first_boot:
var SAPI;
var METADATA;
var SERVICE_UUID;



// --- Internal functions

/*
 * Returns the current semver version stored in CloudAPI's package.json.
 * This is used to set in the API versioning and in the Server header.
 *
 * @return {String} version.
 */

var VERSION;
function version() {
    if (!VERSION) {
        var pkg = fs.readFileSync(__dirname + '/../package.json', 'utf8');
        VERSION = JSON.parse(pkg).version;
    }
    return VERSION;
}



/*
 * Create HTTP server and add handlers for creating and updating packages.
 */

function createServer(options, callback) {
    assert.argument('options', 'object', options);
    assert.argument('options.config', 'string', options.config);
    assert.argument('options.log', 'object', options.log);
    assert.argument('options.overrides', 'object', options.overrides);

    var log = options.log;

    var config = tools.configure(options.config, options.overrides, log);

    config.log = log;
    config.name = 'SDC Package API ' + version();
    config.version = [version()];
    config.acceptable = ['application/json'];

    if (!config.port && !config.path)
        config.path = '/tmp/' + uuid();

    var server  = restify.createServer(config);
    var backend = new Backend(config);
    server.backend = backend;

    server.use(restify.acceptParser(server.acceptable));
    server.use(restify.authorizationParser());
    server.use(restify.dateParser());
    server.use(restify.queryParser());
    server.use(restify.bodyParser({
        overrideParams: true,
        mapParams: true
    }));
    server.use(restify.fullResponse());
    server.use(function setup(req, res, next) {
        req.backend = backend;
        req.config  = config;
        return next();
    });

    // Register an audit logger (avoid it while testing):
    if (typeof (options.test) === 'undefined') {
        var auditLogger = new Logger({
            name: 'audit',
            streams: [ { level: 'info', stream: process.stdout } ]
        });

        server.on('after', restify.auditLogger({ log: auditLogger }));
    }

    /*
     * Set handers for routes.
     */

    server.get(PACKAGES_ROUTE, listPkgs);
    server.head(PACKAGES_ROUTE, listPkgs);
    server.post(PACKAGES_ROUTE, loadPkg, postPkg);

    server.get(PACKAGE_ROUTE, loadPkg, getPkg);
    server.head(PACKAGE_ROUTE, loadPkg, getPkg);
    server.put(PACKAGE_ROUTE, loadPkg, updatePkg);
    server.del(PACKAGE_ROUTE, loadPkg, deletePkg);

    server.get(PING_ROUTE, ping);

    // If we make JSON main format, res.send(error) will send our
    // Restify formatted error objects, and properly hide the v8
    // backtrace.
    server.acceptable.unshift('application/json');

    var globalAgentInterval = setInterval(function () {
        displayHttpQueues(log);
    }, DISPLAY_QUEUES_INTERVAL);

    server.on('close', function () {
        clearInterval(globalAgentInterval);
    });

    /*
     * Start server. If this is first_boot, load default packages and inform
     * SAPI of that fact.
     */

    server.listen(config.port, function () {
        backend.init(function () {
            // PAPI-2: Create default SDC Packages here
            if (config.first_boot) {
                return vasync.pipeline({
                    funcs: [
                        createSDCPackages,
                        getMetadata,
                        updateMetadata
                    ],
                    arg:  {
                        log: log,
                        url: config.sapi.url,
                        backend: backend
                    }
                }, function (err, results) {
                    if (err) {
                        log.error({ err: err }, 'first_boot');
                    } else {
                        log.info({ results: results }, 'first_boot');
                    }

                    return callback(null, server);
                });
            } else {
                return callback(null, server);
            }
        });
    });
}



/*
 * Returns a restify error describing validation errors, which conforms to
 * standard engineering format.
 */

function validationError(message, errs) {
    var errMsg = { code: 'InvalidArgument',
                   message: message,
                   errors: errs };

    return new restify.HttpError({ statusCode: 409, body: errMsg });
}



/*
 * If a package UUID was given in the request, attempt to load it.
 * This is used to load a package for later steps in the HTTP handler.
 */

function loadPkg(req, res, next) {
    var pkgUuid = req.params.uuid;
    if (!pkgUuid)
        return next();

    // If Request-Id hasn't been set, we'll set it to pkg UUID:
    if (!req.headers['request-id'])
        res.header('request-id',  req.params.uuid);

    return req.backend.getPkg(pkgUuid, { req_id: req.id }, function (err, pkg) {
        if (pkg)
            req.pkg = pkg;

        return next();
    });
}



/*
 * Fetch a list of packages. The list is determined by either a filter
 * provided in the request, or the set of params matching schema names
 * in config.json. The default is to list all packages. Ordering, and
 * well as limit and offset are applied.
 */

function listPkgs(req, res, next) {
    var params = req.params;

    var meta = {
        offset: params.offset || 0,
        limit:  params.limit || 0
    };

    if (params.order) {
        var order = params.order.toUpperCase();

        if (order !== 'ASC' && order !== 'DESC')
            order = 'ASC';

        params.order = order;
    }

    if (params.sort) {
        meta.sort = {
            attribute: params.sort,
            order:     params.order || 'ASC'
        };
    } else {
        meta.sort =  {
            attribute: '_id',
            order: 'ASC'
        };
    }

    delete params.offset;
    delete params.limit;
    delete params.order;
    delete params.sort;

    var filter = params.filter || searchFilter(params, req.config.schema);

    req.log.info({ filter: filter }, 'Get Packages filter');

    if (filter === undefined) {
        res.send(404);
        return next();
    }

    req.backend.getPackages(filter, meta, function (err, r) {
        if (err) {
            if (err.name !== 'InvalidQueryError')
                return next(new restify.InternalError(err));

            return next(new restify.InvalidArgumentError(
                        'Provided search filter is not valid'));
        }

        var packages = r.results;

        for (var i = 0; i !== packages.length; i++) {
            packages[i].v = PKG_VERSION;
        }

        res.header('x-resource-count',  r.total);
        res.send(200, packages);

        return next();
    });

    return null; // keep the linter happy
}



/*
 * Create a new package after running validations. A new UUID is assigned if one
 * wasn't provided, and replacing existing packages is not allowed. If param
 * 'skip_validations' is true, the validation step can be skipped.
 */

function postPkg(req, res, next) {
    if (req.pkg) {
        return next(new restify.ConflictError(
            'A package with the given UUID already exists'));
    }

    var keys = Object.keys(req.config.schema);

    // Up to the user if want to identify the pkg with cooked uuid
    var pkg = {};
    keys.forEach(function (p) {
        if (req.params[p] !== undefined)
            pkg[p] = req.params[p];
    });

    // If uuid is not set, it's our turn to set it here:
    if (!pkg.uuid)
        pkg.uuid = uuid();

    if (!req.params.skip_validation) {
        var errs = validations.validate(pkg, req.config.schema);
        if (errs)
            return next(validationError('Package is invalid', errs));
    }

    var reqId = req.headers['request-id'];
    var meta = { req_id: reqId ? reqId : pkg.uuid };

    return req.backend.createPkg(pkg.uuid, pkg, meta, function (err) {
        if (err) {
            if (err === 'ObjectAlreadyExistsError') {
                return next(new restify.ConflictError(
                            'A package with the given UUID already exists'));
            } else if (err === 'UniqueAttributeError') {
                return next(new restify.ConflictError(
                            'A package with the same URN already exists'));
            }

            return next(new restify.ConflictError(err));
        }

        res.header('Location', req.path() + '/' + pkg.uuid);

        // If Request-Id hasn't been set, we'll set it to pkg UUID:
        if (!reqId)
            res.header('request-id',  pkg.uuid);

        return req.backend.getPkg(pkg.uuid, meta, function (er1, p) {
            if (er1)
                return next(new restify.InternalError(er1));

            p.v = PKG_VERSION;

            res.send(201, p);
            return next();
        });
    });
}



/*
 * Fetch a package. More specifically, return a package that was already loaded
 * in a previous step by loadPkg. Also check that package belongs to owner_uuid
 * if it was provided in the request.
 */

function getPkg(req, res, next) {
    if (!req.pkg) {
        return next(new restify.ResourceNotFoundError('Package ' +
                    req.params.uuid + ' does not exist'));
    }

    function send() {
        res.send(200, req.pkg);
        next();
    }

    req.pkg.v = PKG_VERSION;

    var reqOwners = req.params.owner_uuids;
    var pkgOwners = req.pkg.owner_uuids;

    if (!(reqOwners && pkgOwners))
        return send();

    try {
        reqOwners = JSON.parse(reqOwners);
    } catch (e) {}  // keep original value

    // check whether this package has an owner UUID in common with the request
    if (Array.isArray(reqOwners)) {
        for (var i = 0; i !== reqOwners.length; i++) {
            var owner = reqOwners[i];

            if (pkgOwners.indexOf(owner) !== -1)
                return send();
        }
    } else {
        if (pkgOwners.indexOf(reqOwners) !== -1)
            return send();
    }

    return next(new restify.ResourceNotFoundError('Package ' + req.params.uuid +
                ' does not exist'));
}



/*
 * Update values in a specific package. Ensure that immutable attributes are not
 * changed. The usual package validations are performed, although they can be
 * ignored using the 'skip_validation' param.
 *
 * TODO: How to validate when not all fields will be present?
 */

function updatePkg(req, res, next) {
    var pkg = req.pkg;
    var params = req.params;

    if (!pkg) {
        return next(new restify.ResourceNotFoundError('Package ' + params.uuid +
                                                      ' does not exist'));
    }

    // If Request-Id hasn't been set, we'll set it to pkg UUID:
    if (!req.headers['request-id'])
        res.header('request-id', params.uuid);

    var schema = req.config.schema;
    var entries = Object.keys(schema);

    if (!params.force) {
        var immutable = entries.filter(function (key) {
            return schema[key].immutable;
        }).sort();

        var errs = [];
        immutable.forEach(function (k) {
            if (params[k] !== undefined && params[k] !== pkg[k])
                validations.describeErr(k, 'Invalid', 'is immutable', errs);
        });

        if (errs.length > 0)
            return next(validationError('Attempt to update immutables', errs));
    }

    entries.forEach(function (p) {
        var value = params[p];

        if (value === undefined || p === 'uuid')
            return;

        if (value !== null) {
            pkg[p] = params[p];
        } else {
            delete pkg[p];
        }
    });

    if (!params.skip_validation) {
        errs = validations.validate(pkg, req.config.schema);
        if (errs)
            return next(validationError('Updated package is invalid', errs));
    }

    var backend = req.backend;
    var pkgUuid = params.uuid;
    var meta = { req_id: req.id };


    return backend.updatePkg(pkgUuid, pkg, meta, function (err) {
        if (err)
            return next(new restify.ConflictError(err));

        return backend.getPkg(pkgUuid, meta, function (err2, savedPkg) {
            if (err2)
                return next(new restify.InternalError(err2));

            savedPkg.v = PKG_VERSION;

            res.send(200, savedPkg);
            return next();
        });
    });
}



/*
 * Delete a package. Normally deleting packages is not allowed, since it will
 * cause problems for systems that need a package history, like billing.
 * However, deletion will be allowed if the 'force' param is true; please only
 * use this if you know what you're doing.
 */

function deletePkg(req, res, next) {
    var pkgUuid = req.params.uuid;

    if (!req.pkg) {
        var errMsg = 'Package ' + pkgUuid + ' does not exist';
        return next(new restify.ResourceNotFoundError(errMsg));
    }

    // If Request-Id hasn't been set, we'll set it to pkg UUID:
    if (!req.headers['request-id'])
        res.header('request-id', pkgUuid);

    if (!req.params.force)
        return next(new restify.BadMethodError('Packages cannot be deleted'));

    return req.backend.deletePkg(pkgUuid, { req_id: req.id }, function (err) {
        if (err)
            return next(new restify.InternalError(err));

        res.send(204);
        return next();
    });
}



/*
 * Check whether the Moray connection is functional, return its state.
 */

function ping(req, res, next) {
    return req.backend.ping(function (err) {
        var data = { pid: process.pid };

        if (err) {
            data.backend = 'down';
            data.backend_error = err.message;
        } else {
            data.backend = 'up';
        }

        res.send(data);
        return next();
    });
}



/*
 * On first_boot, when PAPI is bring brought up for the first time,
 * load all default packages into Moray, unless they're already there.
 */

function createSDCPackages(args, next) {
    tools.defaultPackages(function (err, pkgs) {
        if (err)
            return next(err);

        return vasync.forEachParallel({
            func: function createSDCPackage(p, cback) {
                args.backend.getPkg(p.uuid, {
                    req_id: p.uuid
                }, function (err2, pkg) {
                    if (err2) {
                        return args.backend.createPkg(p.uuid, p, {
                            req_id: p.uuid
                        }, function (err3, pkg2) {
                            return cback(err3, pkg2);
                        });
                   } else {
                        return cback(null, pkg);
                    }
                });
            },
            inputs: pkgs
        }, function (er, res) {
            args.log.debug({ sdc_packages: res }, 'SDC Packages');
            return next(er, JSON.stringify(res));
        });
    });
}



/*
 * Load PAPI metadata from SAPI.
 */

function getMetadata(args, next) {
    SAPI = new sapi({ url: args.url, log: args.log });

    SAPI.listServices({ name: 'papi' }, function (err, services) {
        if (err)
            return next(err);

        if (!services.length)
            return next('papi service not found');

        SERVICE_UUID = services[0].uuid;
        METADATA = services[0].metadata;

        return next(null, JSON.stringify(METADATA));
    });
}



/*
 * Inform SAPI that PAPI has now had its first_boot methods run.
 * SERVICE_IS_FIRST_BOOT is used to set first_boot in config.json by SAPI, so
 * setting false here means default package won't occur more than once.
 */

function updateMetadata(args, next) {
    if (typeof (SAPI) === 'undefined' || typeof (METADATA) === 'undefined')
        return next('Skipping updateMetadata because getMetadata failed');

    METADATA.SERVICE_IS_FIRST_BOOT = false;

    return SAPI.updateService(SERVICE_UUID, {
        action: 'update',
        metadata: METADATA
    }, function (err, service) {
        args.log.debug({ service: service }, 'updateMetadata');
        // We are done with SAPI, no need to keep the connection around
        SAPI.client.close();
        return next(err, JSON.stringify(service));
    });
}



/*
 * Log every second how deep the HTTP(S) request queue is.
 */

function displayHttpQueues(log) {
    var requests = http.globalAgent.requests;
    if (requests && requests.length > 0)
        log.warn('http.globalAgent queueing, depth=%d', requests.length);

    requests = https.globalAgent.requests;
    if (requests && requests.length > 0)
        log.warn('https.globalAgent queueing, depth=%d', requests.length);
}



/*
 * Create a search filter for Moray to use, based on the params that were
 * provided in the HTTP request. Will return undefined if there's nothing to
 * search for.
 *
 * Normally, a request might contain something like ?name=foo&active=true,
 * which returns the filter (&(name=foo)(active=true)). However, there are a
 * few additional wrinkles:
 *
 * - we support providing arrays of acceptable values, in JSON format. If a
 *   request is looking for any packages with the name "foo" or "bar", then the
 *   argument would be ?name=["foo", "bar"].
 * - we need to convert dates from any string representation, like
 *   2014-07-11T01:52:39.001Z, to its ms-since-epoch representation in Moray,
 *   like 1405043559001.
 * - when searching for owner_uuids, we must return all packages that belong to
 *   those owner_uuids, as well as all packages that have no owner_uuid
 *   (universal packages).
 * - some column names in Postgres, Moray's backend, are reserved -- the two
 *   relevant examples here being "group" and "default". We need to change
 *   those names to something which isn't reserved.
 *
 * A large chunk of this code belongs conceptually in backend.js, such as the
 * reserved names, as well as the date format.
 *
 * An open question is whether to escape all values before passing them to
 * Moray in a search filter. The danger is that an outsider might somehow
 * manage to get a ?owner_uuids=* through, which will then return all packages,
 * including those the outsider should not have access to. However, there are
 * some nicities which this allows as well, for example:
 *
 * sdc-papi /packages?name=foo*
 *
 * For now I've left param values unescaped, but this also implies that API
 * consumers of PAPI which use external data must properly sanitize that data
 * before attempting to use it on PAPI. If you want to reenable escaping, fix
 * the esc() function further down.
 *
 * TODO: raise error if date is unrecognized format.
 */

function searchFilter(params, schema) {
    var searchedOnIndex = false;
    var constraints = [];

    Object.keys(params).forEach(function (name) {
        var column = schema[name];
        if (column === undefined)
            return;

        searchedOnIndex = true;

        if (column.type === 'object')
            return;

        var value = params[name];
        if (value === undefined)
            return;

        try {
            value = JSON.parse(value);
        } catch (e) {}  // leave value as is

        // TODO: update to use DB_RESERVED_NAMES in backend.js
        if (name === 'group') {
            name = '_group';
        } else if (name === 'default') {
            name = '_default';
        }

        var constraint;

        if (Array.isArray(value)) {
            var chunks = [];

            for (var i = 0; i !== value.length; i++) {
                chunks.push('(' + name + '=' + esc(value[i]) + ')');
            }

            if (name === 'owner_uuids')
                chunks.push('(!(owner_uuids=*))');

            if (chunks.length > 1) {
                constraint = '(|' + chunks.join('') + ')';
            } else {
                constraint = chunks[0]; // can be undefined on empty array
            }
        } else {
            if (name !== 'owner_uuids') {
                constraint = '(' + name + '=' + esc(value) + ')';
            } else {
                constraint = '(|(' + name + '=' + esc(value) +
                             ')(!(owner_uuids=*)))';
            }
        }

        if (constraint !== undefined)
            constraints.push(constraint);
    });

    if (!constraints.length && !searchedOnIndex)
        constraints.push('(uuid=*)');

    var filter;
    if (constraints.length > 1) {
        filter = '(&' + constraints.join('') + ')';
    } else {
        filter = constraints[0];
    }

    return filter;
}



/*
 * This function escapes text for LDIF search filters.
 *
 * It's currently disabled. If you want to reenable escaping, remove the
 * relevant return below.
 */

function esc(val, type) {
    if (type === 'date')
        return +new Date(val);

    if (typeof (val) !== 'string')
        return val;

    // disabled
    return val;

//    return val.replace('(',  '{\\28}').
//               replace(')',  '{\\29}').
//               replace('\\', '{\\5c}').
//               replace('*',  '{\\2a}').
//               replace('/',  '{\\2f}');
}



module.exports = { createServer: createServer };
