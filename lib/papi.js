/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * The PAPI HTTP interface. Sets up routes and handles listing and updates of
 * packages.
 */

var fs = require('fs');
var http = require('http');
var https = require('https');
var restify = require('restify');
var backoff = require('backoff');
var Logger = require('bunyan');
var vasync = require('vasync');
var VError = require('verror');
var sapi = require('sdc-clients').SAPI;
var tritonTracer = require('triton-tracer');

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

// old attributes that may appear in packages during update, and should be
// stripped
var STALE_ATTR = ['overprovision_cpu', 'overprovision_memory',
                  'overprovision_storage', 'overprovision_network',
                  'overprovision_io', 'urn'];

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
    name: 'ping',
    path: PING_PATH,
    version: '7.0.0'
};

var MAX_CREATE_PKG_TRIES = 10;


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

    if (!config.port && !config.path) {
        config.path = '/tmp/' + uuid();
    }

    var server = restify.createServer(config);
    var backend = new Backend(config);
    server.backend = backend;

    // Start the tracing backend and instrument this restify 'server'.
    tritonTracer.instrumentRestifyServer({
        server: server
    });

    server.use(restify.acceptParser(server.acceptable));
    server.use(restify.authorizationParser());
    server.use(restify.dateParser());
    server.use(restify.queryParser({allowDots: false, plainObjects: false}));
    server.use(restify.bodyParser({
        overrideParams: true,
        mapParams: true
    }));
    server.use(restify.fullResponse());
    server.use(function setup(req, res, next) {
        req.backend = backend;
        req.config = config;
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
                    arg: {
                        log: log,
                        url: config.sapi.url,
                        backend: backend
                    }
                }, function (err, results) {
                    if (!err) {
                        log.info({ results: results }, 'first_boot');
                    }

                    return callback(err, server);
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
    if (!pkgUuid) {
        next();
        return;
    }

    // If Request-Id hasn't been set, we'll set it to pkg UUID:
    if (!req.headers['request-id'] && !res.headers['request-id']) {
        res.header('request-id', req.params.uuid);
    }

    req.backend.getPkg(pkgUuid, { req_id: req.id }, function (err, pkg) {
        if (err) {
            req.log.debug({err: err, pkg_uuid: pkgUuid}, 'Package not found');
        }
        if (pkg) {
            req.pkg = pkg;
        }

        next();
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
        limit: params.limit || 0
    };

    if (params.order) {
        var order = params.order.toUpperCase();

        if (order !== 'ASC' && order !== 'DESC') {
            order = 'ASC';
        }

        params.order = order;
    }

    if (params.sort) {
        meta.sort = {
            attribute: params.sort,
            order: params.order || 'ASC'
        };
    } else {
        meta.sort = {
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
        next();
        return;
    }

    req.backend.getPackages(filter, meta, function (err, r) {
        if (err) {
            if (VError.hasCauseWithName(err, 'InvalidQueryError')) {
                next(new restify.InvalidArgumentError(
                            'Provided search filter is not valid'));
                return;
            } else if (VError.hasCauseWithName(err, 'NotIndexedError')) {
                var err2 = VError.findCauseByName(err, 'NotIndexedError');
                next(new restify.InternalError(err2.message));
                return;
            }
            next(new restify.InternalError(err.message || err));
            return;
        }

        var packages = r.results;

        for (var i = 0; i !== packages.length; i++) {
            packages[i].v = PKG_VERSION;
        }

        res.header('x-resource-count', r.total);
        res.send(200, packages);

        next();
        return;
    });
}



/*
 * Create a new package after running validations. A new UUID is assigned if one
 * wasn't provided, and replacing existing packages is not allowed. If param
 * 'skip_validations' is true, the validation step can be skipped.
 */

function postPkg(req, res, next) {
    if (req.pkg) {
        next(new restify.ConflictError(
            'A package with the given UUID already exists'));
        return;
    }

    var params = req.params;
    var schema = req.config.schema;
    var keys = Object.keys(schema);

    // Up to the user if want to identify the pkg with cooked uuid
    var pkg = {};
    keys.forEach(function (p) {
        if (params[p] !== undefined) {
            pkg[p] = params[p];
        }
    });

    // If uuid is not set, it's our turn to set it here:
    if (!pkg.uuid) {
        pkg.uuid = uuid();
    }

    // if invalid params, called function invokes next with errors
    if (unrecognisedParams(params, schema, next)) {
        return;
    }

    if (!params.skip_validation) {
        var errs = validations.validate(pkg, schema);
        if (errs) {
            next(validationError('Package is invalid', errs));
            return;
        }
    }

    var reqId = req.headers['request-id'];
    var meta = { req_id: reqId ? reqId : pkg.uuid };

    req.backend.createPkg(pkg.uuid, pkg, meta, function (err) {
        if (err) {
            if (err === 'ObjectAlreadyExistsError') {
                next(new restify.ConflictError(
                    'A package with the given UUID already exists'));
                return;
            } else if (err === 'UniqueAttributeError' ||
                VError.hasCauseWithName(err, 'UniqueAttributeError')) {
                next(new restify.ConflictError(
                    'A package with the same URN already exists'));
                return;
            }

            next(new restify.ConflictError(err));
            return;
        }

        res.header('Location', req.path() + '/' + pkg.uuid);

        // If Request-Id hasn't been set, we'll set it to pkg UUID:
        if (!reqId && !res.headers['request-id']) {
                res.header('request-id', pkg.uuid);
        }

        req.backend.getPkg(pkg.uuid, meta, function (er1, p) {
            if (er1) {
                next(new restify.InternalError(er1));
                return;
            }

            p.v = PKG_VERSION;

            res.send(201, p);
            next();
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
        next(new restify.ResourceNotFoundError('Package ' +
                req.params.uuid + ' does not exist'));
        return;
    }

    function send() {
        res.send(200, req.pkg);
        next();
    }

    req.pkg.v = PKG_VERSION;

    var reqOwners = req.params.owner_uuids;
    var pkgOwners = req.pkg.owner_uuids;

    if (!(reqOwners && pkgOwners)) {
        send();
        return;
    }

    try {
        reqOwners = JSON.parse(reqOwners);
    } catch (e) {
        req.log.debug({err: e}, 'JSON Parse error');
    } // keep original value

    // check whether this package has an owner UUID in common with the request
    if (Array.isArray(reqOwners)) {
        for (var i = 0; i !== reqOwners.length; i++) {
            var owner = reqOwners[i];

            if (pkgOwners.indexOf(owner) !== -1) {
                send();
                return;
            }
        }
    } else {
        if (pkgOwners.indexOf(reqOwners) !== -1) {
            send();
            return;
        }
    }

    next(new restify.ResourceNotFoundError('Package ' + req.params.uuid +
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
    var errs;

    if (!pkg) {
        next(new restify.ResourceNotFoundError(
            'Package ' + params.uuid + ' does not exist'));
        return;
    }

    // If Request-Id hasn't been set, we'll set it to pkg UUID:
    if (!req.headers['request-id'] && !res.headers['request-id']) {
            res.header('request-id', params.uuid);
    }

    var schema = req.config.schema;
    var entries = Object.keys(schema);

    // if invalid params, called function invokes next with errors
    if (unrecognisedParams(params, schema, next)) {
        return;
    }

    // prevent immutable attributes from being modified
    if (!params.force) {
        errs = [];
        var immutable = entries.filter(function (key) {
            return schema[key].immutable;
        }).sort();

        immutable.forEach(function (k) {
            if (params[k] !== undefined && params[k] !== pkg[k]) {
                validations.describeErr(k, 'Invalid', 'is immutable', errs);
            }
        });

        if (errs.length > 0) {
            next(validationError('Attempt to update immutables', errs));
            return;
        }
    }

    // copy over new entries in params which are recognised by the schema to pkg
    entries.forEach(function (p) {
        var value = params[p];

        if (value === undefined || p === 'uuid') {
            return;
        }

        if (value !== null) {
            pkg[p] = params[p];
        } else {
            delete pkg[p];
        }
    });

    // remove any old entries in a pkg which are no longer supported by the
    // schema
    STALE_ATTR.forEach(function (p) {
        delete pkg[p];
    });

    if (!params.skip_validation) {
        errs = validations.validate(pkg, schema);
        if (errs) {
            next(validationError('Updated package is invalid', errs));
            return;
        }
    }

    var backend = req.backend;
    var pkgUuid = params.uuid;
    var meta = { req_id: req.id };


    backend.updatePkg(pkgUuid, pkg, meta, function (err) {
        if (err) {
            next(new restify.ConflictError(err));
            return;
        }

        backend.getPkg(pkgUuid, meta, function (err2, savedPkg) {
            if (err2) {
                next(new restify.InternalError(err2));
                return;
            }

            savedPkg.v = PKG_VERSION;

            res.send(200, savedPkg);
            next();
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
        next(new restify.ResourceNotFoundError(errMsg));
        return;
    }

    // If Request-Id hasn't been set, we'll set it to pkg UUID:
    if (!req.headers['request-id'] && !res.headers['request-id']) {
        res.header('request-id', pkgUuid);
    }

    if (!req.params.force) {
        next(new restify.BadMethodError('Packages cannot be deleted'));
        return;
    }

    req.backend.deletePkg(pkgUuid, { req_id: req.id }, function (err) {
        if (err) {
            next(new restify.InternalError(err));
            return;
        }

        res.send(204);
        next();
    });
}



/*
 * Check whether the Moray connection is functional, return its state.
 */

function ping(req, res, next) {
    req.backend.ping(function (err) {
        var data = { pid: process.pid };

        if (err) {
            data.backend = 'down';
            data.backend_error = err.message;
        } else {
            data.backend = 'up';
        }

        res.send(data);
        next();
    });
}



/*
 * On first_boot, when PAPI is bring brought up for the first time,
 * load all default packages into Moray, unless they're already there.
 */

function createSDCPackages(args, next) {
    tools.defaultPackages(function (err, pkgs) {
        if (err) {
            next(err);
            return;
        }

        var backend = args.backend;

        function addPkg(pkg, cb) {
            backend.createPkg(pkg.uuid, pkg, {
                req_id: pkg.uuid
            }, function (err2) {
                if (!err2 || err2 === 'ObjectAlreadyExistsError') {
                    cb();
                    return;
                }

                cb(err2);
                return;
            });
        }

        vasync.forEachParallel({
            func: function createSDCPackage(pkg, cb) {
                var call = backoff.call(addPkg, pkg, cb);
                call.failAfter(MAX_CREATE_PKG_TRIES);
                call.start();
            },
            inputs: pkgs
        }, function (er, res) {
            args.log.debug({ sdc_packages: res }, 'SDC Packages');
            next(er, JSON.stringify(res));
        });
    });
}



/*
 * Load PAPI metadata from SAPI.
 */

function getMetadata(args, next) {
    SAPI = new sapi({ url: args.url, log: args.log });

    SAPI.listServices({ name: 'papi' }, function (err, services) {
        if (err) {
            next(err);
            return;
        }

        if (!services.length) {
            next('papi service not found');
            return;
        }

        SERVICE_UUID = services[0].uuid;
        METADATA = services[0].metadata;

        next(null, JSON.stringify(METADATA));
    });
}



/*
 * Inform SAPI that PAPI has now had its first_boot methods run.
 * SERVICE_IS_FIRST_BOOT is used to set first_boot in config.json by SAPI, so
 * setting false here means default package won't occur more than once.
 */

function updateMetadata(args, next) {
    if (typeof (SAPI) === 'undefined' || typeof (METADATA) === 'undefined') {
        next('Skipping updateMetadata because getMetadata failed');
        return;
    }

    METADATA.SERVICE_IS_FIRST_BOOT = false;

    SAPI.updateService(SERVICE_UUID, {
        action: 'update',
        metadata: METADATA
    }, function (err, service) {
        args.log.debug({ service: service }, 'updateMetadata');
        // We are done with SAPI, no need to keep the connection around
        SAPI.client.close();
        next(err, JSON.stringify(service));
    });
}



/*
 * Log every second how deep the HTTP(S) request queue is.
 */

function displayHttpQueues(log) {
    var requests = http.globalAgent.requests;
    if (requests && requests.length > 0) {
        log.warn('http.globalAgent queueing, depth=%d', requests.length);
    }

    requests = https.globalAgent.requests;
    if (requests && requests.length > 0) {
        log.warn('https.globalAgent queueing, depth=%d', requests.length);
    }
}



/*
 * Check that all params given to PAPI during POST or PUT are recognisable to
 * PAPI itself or the package schema. We don't want API users to use invalid
 * names, but get 200 responses in return.
 */

function unrecognisedParams(params, schema, next) {
    var errs = [];

    // warn if there are unrecognised params
    Object.keys(params).forEach(function (p) {
        if (p === 'force' || p === 'skip_validation' || p === 'v') {
            return;
        }

        if (!schema[p]) {
            validations.describeErr(
                p, 'Invalid', 'is an unsupported attribute', errs);
        }
    });

    if (errs.length > 0) {
        next(validationError('Unrecognised attributes', errs));
        return true;
    }

    return false;
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
 * TODO: raise error if date is unrecognized format.
 */

function searchFilter(params, schema) {
    var searchedOnIndex = false;
    var constraints = [];

    Object.keys(params).forEach(function (name) {
        var column = schema[name];
        if (column === undefined) {
            return;
        }

        searchedOnIndex = true;

        if (column.type === 'object') {
            return;
        }

        var value = params[name];
        if (value === undefined) {
            return;
        }

        try {
            value = JSON.parse(value);
        } catch (_e) {
            // leave value as is
        }

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

            if (name === 'owner_uuids') {
                chunks.push('(!(owner_uuids=*))');
            }

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

        if (constraint !== undefined) {
            constraints.push(constraint);
        }
    });

    if (!constraints.length && !searchedOnIndex) {
        constraints.push('(uuid=*)');
    }

    var filter;
    if (constraints.length > 1) {
        filter = '(&' + constraints.join('') + ')';
    } else {
        filter = constraints[0];
    }

    return filter;
}



/*
 * This function escapes text for LDIF search filters, with the exception of
 * '*', since it's useful in many queries.
 */

function esc(val, type) {
    if (type === 'date') {
        return +new Date(val);
    }

    if (typeof (val) !== 'string') {
        return val;
    }

    // first replace converts \ to {\5c}, except when that \ is a part of
    // an existing LDIF escape sequence (e.g. the string already contains an
    // escaped * as {\2a})
    return val.replace(/\\(?![0-9a-f][0-9a-f]})/gi, '{\\5c}')
               .replace(/\//g, '{\\2f}')
               .replace(/\(/g, '{\\28}')
               .replace(/\)/g, '{\\29}')
               /* BEGIN JSSTYLED */
               .replace(/=/g, '{\\3d}')
               .replace(/,/g, '{\\2c}');
               /* END JSSTYLED */
}



module.exports = { createServer: createServer };
