/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * The PAPI HTTP interface. Sets up routes and handles listing and updates of
 * packages.
 */

var fs = require('fs');
var util = require('util');
var assert = require('assert');

assert.argument = function assertArgument(name, type, arg) {
    if (typeof (arg) !== type) {
        throw new TypeError(name + ' (' + type + ') required');
    }
};

var http = require('http');
var https = require('https');

var restify = require('restify');
var Logger = require('bunyan');
var libuuid = require('libuuid');
function uuid() {
    return (libuuid.create());
}
var vasync = require('vasync');
var sapi = require('sdc-clients').SAPI;
var Backend = require('./backend');
var validations = require('./validations');
var tools = require('./tools');
var VERSION = false;

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

/**
 * Returns the current semver version stored in CloudAPI's package.json.
 * This is used to set in the API versioning and in the Server header.
 *
 * @return {String} version.
 */
function version() {
    if (!VERSION) {
        var pkg = fs.readFileSync(__dirname + '/../package.json', 'utf8');
        VERSION = JSON.parse(pkg).version;
    }
    return VERSION;
}


// -- API
module.exports = {

    /*
     * Create HTTP server and add handlers for creating and updating packages.
     */

    createServer: function (options, callback) {
        assert.argument('options', 'object', options);
        assert.argument('options.config', 'string', options.config);
        assert.argument('options.log', 'object', options.log);
        assert.argument('options.overrides', 'object', options.overrides);

        var config = tools.configure(options.config,
                options.overrides, options.log);
        var log = options.log;
        var globalAgentInterval;

        config.log = log;
        config.name = 'SDC Package API ' + version();
        config.version = [version()];
        config.acceptable = ['application/json'];

        if (!config.port && !config.path) {
            config.path = '/tmp/' + uuid();
        }

        var server  = restify.createServer(config);
        var backend = Backend(config);
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
            req.config = config;
            return next();
        });



        /*
         * If a package UUID was given in the request, attempt to load it.
         * This is used to load a package for later steps in the HTTP handler.
         */

        function loadPkg(req, res, next) {
            if (!req.params.uuid) {
                return next();
            }
            // If Request-Id hasn't been set, we'll set it to pkg UUID:
            if (!req.headers['request-id']) {
                res.header('request-id',  req.params.uuid);
            }

            var meta = {
                req_id: req.id
            };

            return backend.getPkg(req.params.uuid, meta, function (err, pkg) {
                if (pkg) {
                    req.pkg = pkg;
                }
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
            var meta = {
                offset: req.params.offset || 0,
                limit: req.params.limit || 0
            };

            delete req.params.offset;
            delete req.params.limit;

            if (req.params.order) {
                req.params.order = req.params.order.toUpperCase();
                if (req.params.order !== 'ASC' && req.params.order !== 'DESC') {
                    req.params.order = 'ASC';
                }
            }

            if (req.params.sort) {
                meta.sort = {
                    attribute: req.params.sort,
                    order: req.params.order || 'ASC'
                };
            } else {
                meta.sort =  {
                    attribute: '_id',
                    order: 'ASC'
                };
            }

            delete req.params.order;
            delete req.params.sort;

            var filter;

            if (req.params.filter) {
                filter = req.params.filter;
            } else {
                var keys = Object.keys(req.config.schema);
                keys = keys.concat(['group', 'default']);

                var pieces = [];
                keys.forEach(function (p) {
                    if (req.params[p]) {
                        var k = p;
                        if (p === 'group') {
                            k = 'group_name';
                        } else if (p === 'default') {
                            k = 'is_default';
                        }
                        // Search packages either with the given owner_uuid
                        // or none at all
                        if (p === 'owner_uuid') {
                            pieces.push(util.format(
                                    '(|(%s=%s)(!(owner_uuid=*)))',
                                    k, req.params[p]));
                        } else {
                            pieces.push(util.format('(%s=%s)',
                                    k, req.params[p]));
                        }
                    }
                });

                if (!pieces.length) {
                    pieces.push('(uuid=*)');
                }

                filter = '(&' + pieces.join('') + ')';
            }

            req.log.info({filter: filter}, 'Get Packages filter');

            backend.getPackages(filter, meta, function (err, r) {
                if (err) {
                    if (err.name === 'InvalidQueryError') {
                        return next(new restify.InvalidArgumentError(
                                'Provided search filter is not valid'));
                    }
                    return next(new restify.InternalError(err));
                }
                res.header('x-resource-count',  r.total);
                res.send(200, r.results);
                return next();
            });
        }



        /*
         * Create a new package after running validations. A new UUID is
         * assigned if one wasn't provided, and replacing existing packages is
         * not allowed. If param 'skip_validations' is true, the validation
         * step can be skipped.
         *
         * TODO: Add loop over required and make sure everything
         * required is here.
         */

        function postPkg(req, res, next) {
            if (req.pkg) {
                return next(new restify.ConflictError(
                    'A package with the given UUID already exists'));
            }

            var pkg = {};
            var keys = Object.keys(req.config.schema);
            keys = keys.concat(['group', 'default']);
            // var required = req.config.required;
            var meta = {};

            // Up to the user if want to identify the pkg
            // with self.cooked uuid:
            keys.forEach(function (p) {
                if (req.params[p]) {
                    pkg[p] = req.params[p];
                }
            });

            // If uuid is not set, it's our turn to set it here:
            if (!pkg.uuid) {
                pkg.uuid = uuid();
            }

            if (req.headers['request-id']) {
                meta.req_id = req.headers['request-id'];
            } else {
                meta.req_id = pkg.uuid;
            }

            function savePackage() {
                return backend.createPkg(pkg, meta, function (err) {
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
                    if (!req.headers['request-id']) {
                        res.header('request-id',  pkg.uuid);
                    }

                    return backend.getPkg(pkg.uuid, meta, function (er1, p) {
                        if (er1) {
                            return next(new restify.InternalError(er1));
                        }
                        res.send(201, p);
                        return next();
                    });
                });
            }

            if (!req.params.skip_validation) {
                var missing = [];
                req.config.required.forEach(function (r) {
                    if (!pkg[r]) {
                        missing.push(r);
                    }
                });
                if (missing.length) {
                    return next(new restify.MissingParameterError(
                            'Missing required fields: ' + missing.join(', ')));
                } else {
                    return validations.validate(pkg, function (er) {
                        if (er) {
                            return next(new restify.InvalidArgumentError(er));
                        }
                        return savePackage();
                    });
                }
            } else {
                return savePackage();
            }
        }



        /*
         * Fetch a package. More specifically, return a package that was
         * already loaded in a previous step by loadPkg. Also check that
         * package belongs to owner_uuid if it was provided in the request.
         */

        function getPkg(req, res, next) {
            if (!req.pkg) {
                return next(new restify.ResourceNotFoundError('Package ' +
                        req.params.uuid + ' does not exist'));
            }

            if (req.params.owner_uuid && req.pkg.owner_uuid &&
                req.params.owner_uuid !== req.pkg.owner_uuid) {
                return next(new restify.ResourceNotFoundError('Package ' +
                        req.params.uuid + ' does not exist'));
            }

            res.send(200, req.pkg);
            return next();
        }



        /*
         * Update values in a specific package. Ensure that immutable attributes
         * are not changed. The usual package validations are performed,
         * although they can be ignored using the 'skip_validation' param.
         *
         * TODO: How to validate when not all fields will be present?
         */

        function updatePkg(req, res, next) {
            if (!req.pkg) {
                return next(new restify.ResourceNotFoundError('Package ' +
                        req.params.uuid + ' does not exist'));
            }

            var errors = [];
            var meta = {};
            var keys = Object.keys(req.config.schema);
            keys = keys.concat(['group', 'default']);

            // If Request-Id hasn't been set, we'll set it to pkg UUID:
            if (!req.headers['request-id']) {
                res.header('request-id',  req.params.uuid);
            }

            meta.req_id = req.id;

            req.config.immutable.forEach(function (k) {
                if (typeof (req.params[k]) !== 'undefined' &&
                    req.params[k] !== req.pkg[k]) {
                    errors.push('Field \'' + k + '\' is immutable');
                }
            });

            if (errors.length) {
                return next(new restify.ConflictError(errors.join(', ')));
            }

            keys.forEach(function (p) {
                if (typeof (req.params[p]) !== 'undefined' && (p !== 'uuid')) {
                    req.pkg[p] = req.params[p];
                }
            });

            function savePackage() {
                return backend.updatePkg(req.params.uuid, req.pkg, meta,
                    function (err) {
                        if (err) {
                            return next(new restify.ConflictError(err));
                        }
                        return backend.getPkg(req.params.uuid, meta,
                            function (err2, pkg) {
                            if (err) {
                                return next(new restify.InternalError(err));
                            }
                            res.send(200, pkg);
                            return next();
                        });
                    });
            }

            if (!req.params.skip_validation) {
                return validations.validate(req.pkg, function (er) {
                    if (er) {
                        return next(new restify.InvalidArgumentError(er));
                    }
                    return savePackage();
                });
            } else {
                return savePackage();
            }
        }



        /*
         * Delete a package. Normally deleting packages is not allowed, since it
         * will cause problems for systems that need a package history, like
         * billing. However, deletion will be allowed if the 'force' param is
         * true; please only use this if you really know what you're doing.
         */

        function deletePkg(req, res, next) {
            if (!req.pkg) {
                return next(new restify.ResourceNotFoundError('Package ' +
                        req.params.uuid + ' does not exist'));
            }
            // If Request-Id hasn't been set, we'll set it to pkg UUID:
            if (!req.headers['request-id']) {
                res.header('request-id',  req.params.uuid);
            }

            var meta = {
                req_id: req.id
            };

            if (!req.params.force) {
                return next(new restify.BadMethodError(
                     'Packages cannot be deleted'));
            } else {
                return backend.deletePkg(req.params.uuid, meta, function (err) {
                    if (err) {
                        return next(new restify.InternalError(err));
                    }

                    res.send(204);
                    return next();
                });
            }
        }


        // Register an audit logger (avoid it while testing):
        if (typeof (options.test) === 'undefined') {
            server.on('after', restify.auditLogger({
                log: new Logger({
                    name: 'audit',
                    streams: [
                        {
                            level: 'info',
                            stream: process.stdout
                        }
                    ]
                })
            }));
        }



        /*
         * Set handers for routes.
         */

        // Packages:
        server.get(PACKAGES_ROUTE, listPkgs);
        server.head(PACKAGES_ROUTE, listPkgs);
        server.post(PACKAGES_ROUTE, loadPkg, postPkg);
        // Package:
        server.get(PACKAGE_ROUTE, loadPkg, getPkg);
        server.head(PACKAGE_ROUTE, loadPkg, getPkg);
        server.put(PACKAGE_ROUTE, loadPkg, updatePkg);
        server.del(PACKAGE_ROUTE, loadPkg, deletePkg);
        server.get(PING_ROUTE, function (req, res, next) {
            var data = {
                pid: process.pid
            };

            return backend.ping(function (err) {
                if (err) {
                    data.backend = 'down';
                    data.backend_error = err.message;

                    res.send(data);
                    return next();

                } else {
                    data.backend = 'up';
                    res.send(data);
                    return next();
                }
            });

        });



        /*
         * On first_boot, when PAPI is bring brought up for the first time,
         * load all default packages into Moray, unless they're already there.
         */

        function createSDCPackages(_, next) {
            tools.defaultPackages(function (err, pkgs) {
                if (err) {
                    return next(err);
                }
                return vasync.forEachParallel({
                    func: function createSDCPackage(p, cback) {
                        backend.getPkg(p.uuid, {
                            req_id: p.uuid
                        }, function (err2, pkg) {
                            if (err2) {
                                return backend.createPkg(p, {
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
                    log.debug({sdc_packages: res}, 'SDC Packages');
                    return next(er, JSON.stringify(res));
                });
            });
        }



        /*
         * Load PAPI metadata from SAPI.
         */

        function getMetadata(_, next) {
            var opts = {
                url: config.sapi.url,
                log: log
            };

            SAPI = new sapi(opts);

            SAPI.listServices({name: 'papi'}, function (err, services) {
                if (err) {
                    return next(err);
                }

                if (!services.length) {
                    return next('papi service not found');
                }

                SERVICE_UUID = services[0].uuid;
                METADATA = services[0].metadata;

                return next(null, JSON.stringify(METADATA));
            });
        }



        /*
         * Inform SAPI that PAPI has now had its first_boot methods run.
         * SERVICE_IS_FIRST_BOOT is used to set first_boot in config.json by
         * SAPI, so setting false here means default package won't occur more
         * than once.
         */

        function updateMetadata(_, next) {
            if (typeof (SAPI) === 'undefined' ||
                typeof (METADATA) === 'undefined') {
                return next('Skipping updateMetadata b/c getMetadata failed');
            }

            METADATA.SERVICE_IS_FIRST_BOOT = false;

            return SAPI.updateService(SERVICE_UUID, {
                action: 'update',
                metadata: METADATA
            }, function (err, service) {
                log.debug({service: service}, 'updateMetadata');
                // We are done with SAPI, no need to keep the connection around
                SAPI.client.close();
                return next(err, JSON.stringify(service));
            });
        }



        /*
         * Start server. If this is first_boot, load default packages and inform
         * SAPI of that fact.
         */

        server.start = function start(cb) {
            return server.listen(config.port, function () {
                backend.init(function () {
                    // PAPI-2: Create default SDC Packages here
                    if (config.first_boot) {
                        return vasync.pipeline({
                            funcs: [
                                createSDCPackages,
                                getMetadata,
                                updateMetadata
                            ]
                        }, function (err, results) {
                            if (err) {
                                log.error({err: err}, 'first_boot');
                            } else {
                                log.info({results: results}, 'first_boot');
                            }
                            return cb();
                        });
                    } else {
                        return cb();
                    }
                });
            });
        };



        /*
         * Log every second how deep the HTTP(S) request queue is.
         */

        globalAgentInterval = setInterval(function () {
            var agent = http.globalAgent;
            if (agent.requests && agent.requests.length > 0) {
                log.warn('http.globalAgent queueing, depth=%d',
                            agent.requests.length);
            }

            agent = https.globalAgent;
            if (agent.requests && agent.requests.length > 0) {
                log.warn('https.globalAgent queueing, depth=%d',
                            agent.requests.length);
            }
        }, 1000);



        // If we make JSON main format, res.send(error) will send our
        // Restify formatted error objects, and properly hide the v8
        // backtrace.
        server.acceptable.unshift('application/json');

        server.on('close', function () {
            clearInterval(globalAgentInterval);
        });

        return callback(server);
    }
};
