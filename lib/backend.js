/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Backend for the packages API, which talks to Moray in order to created, list,
 * or modify packages stored therein.
 */

var moray = require('moray');
var assert = require('assert');
var util = require('util');
var clone = require('clone');



/*
 * Create a client object to talk to Moray.
 */

function createMorayClient(options) {
    assert.ok(options);

    return moray.createClient({
        url: options.moray.url,
        log: options.log.child({
            component: 'moray'
        }),
        noCache: true,
        reconnect: true,
        retry: { // try to reconnect forever
            maxTimeout: 30000,
            retries: Infinity
        },
        connectTimeout: options.moray.connectTimeout || 1000
    });
}



/*
 * Convert a hash (as seen in config.json) describing indexing and uniqueness
 * constraints on package attributes to a schema Moray understands.
 */

function schema2MorayIndex(schema) {
    var indices = {};

    Object.keys(schema).forEach(function (k) {
        var attr = schema[k];

        if (attr.index || attr.unique) {
            var type = (attr.type === 'object') ? 'string' : attr.type;
            var index = { type: type };

            if (attr.unique) {
                index.unique = true;
            }

            indices[k] = index;
        }
    });

    return (indices);
}



/*
 * Convert package data retrived from Moray into a JS representation more
 * suitable for JSONification. I.e. convert date strings into actual dates,
 * and deserialize strings containing JSON representations of arrays or hashes.
 */

function decode(pkg, schema) {
    var p;

    for (p in pkg) {
        // Traits, networks, whatever else defined as object
        if (typeof (schema[p]) !== 'undefined' &&
                schema[p].type === 'object' &&
                typeof (pkg[p]) === 'string') {
            try {
                pkg[p] = JSON.parse(pkg[p]);
            } catch (e) {}
        }
    }

    // Couple fields we cannot define with their public name due to
    // PostgreSQL indexes definition rules:
    if (typeof (pkg.is_default) !== 'undefined') {
        pkg['default'] = pkg.is_default;
        delete pkg.is_default;
    }

    if (typeof (pkg.group_name) !== 'undefined') {
        pkg.group = pkg.group_name;
        delete pkg.group_name;
    }

    if (typeof (pkg.created_at) === 'number') {
        pkg.created_at = new Date(pkg.created_at).toISOString();
    }

    if (typeof (pkg.updated_at) === 'number') {
        pkg.updated_at = new Date(pkg.updated_at).toISOString();
    }

    return (pkg);
}



/*
 * Convert hashes representing packages into a format which can be stored in
 * Moray. For example, Moray cannot store arrays, so they need to be serialized
 * into JSON (which can be saved).
 */

function encode(pkg) {
    var p;

    for (p in pkg) {
        var attr = pkg[p];

        if (typeof (attr) === 'object') {
            if (Object.keys(attr).length || attr.length) {
                pkg[p] = JSON.stringify(attr);
            } else {
                // We don't want to add empty values for arrays, objects ...
                delete pkg[p];
            }
        }
    }

    // Cannot use 'default' and 'group' as PG indexes, so we save them under
    // slightly different names
    if (typeof (pkg['default']) !== 'undefined') {
        pkg.is_default = pkg['default'];
        delete pkg['default'];
    }

    if (pkg.group) {
        pkg.group_name = pkg.group;
        delete pkg.group;
    }

    if (pkg.updated_at && typeof (pkg.updated_at) === 'string') {
        pkg.updated_at = new Date(pkg.updated_at).getTime();
    }

    if (pkg.created_at && typeof (pkg.created_at) === 'string') {
        pkg.created_at = new Date(pkg.created_at).getTime();
    }

    return (pkg);
}



/*
 * Backend constructor. Returns a set of methods useful for fetching and
 * updating packages in Moray.
 */

module.exports = function Backend(opts) {
    assert.ok(opts.log);
    var backend;
    var schema = schema2MorayIndex(opts.schema);



    /*
     * Ensure bucket for packages in Moray exists. Keep retrying every 10s
     * until successful.
     */

    function morayConnectCallback(callback) {
        opts.log.info({
            bucket: opts.bucket,
            schema: schema
        }, 'Configuring Packages bucket');

        return backend.putBucket(opts.bucket, {
            index: schema,
            // make sure packages have created_at and updated_at timestamps
            pre: [ function timestamps(req, cb) {
                if (!req.value.created_at && !req.update) {
                    req.value.created_at = new Date().getTime();
                }
                req.value.updated_at = new Date().getTime();
                return cb();
            }],
            options: {
                guaranteeOrder: true,
                syncUpdates: true,
                version: opts.moray.version
            }
        }, function (err) {
            if (err) {
                opts.log.fatal({err: err}, 'Unable to put SDC Packages bucket');
                opts.log.info('Trying again in 10 seconds');
                setTimeout(function () {
                    morayConnectCallback(callback);
                }, 10000);
            } else {
                callback();
            }
        });
    }



    /*
     * Close connection to Moray.
     */

    function quit() {
        return backend.close();
    }



    /*
     * Check that connection to Moray is live.
     */

    function ping(_opts, cb) {
        var options = clone(opts);

        if (typeof (_opts) === 'function') {
            cb = _opts;
            _opts = {};
        }

        Object.keys(_opts).forEach(function (k) {
            options[k] = _opts[k];
        });

        return backend.ping(options, cb);
    }



    /*
     * Fetch an array of packages which matches the given filter, and apply
     * any requested ordering.
     */

    function getPackages(filter, meta, cb) {
        if (typeof (meta) === 'function') {
            cb = meta;
            meta = {
                sort: {
                    attribute: '_id',
                    order: 'DESC'
                }
            };
        } else if (typeof (meta.sort) === 'undefined') {
            meta.sort = {
                attribute: '_id',
                order: 'DESC'
            };
        }

        var results = [];
        var count = 0;

        var req = backend.findObjects(opts.bucket, filter, meta);

        req.once('error', function (err) {
            return cb(err);
        });

        req.on('record', function (obj) {
            results.push(decode(obj.value, opts.schema));
            if (count === 0) {
                count = obj._count;
            }
        });

        req.once('end', function () {
            return cb(null, {
                results: results,
                total: count
            });
        });
    }



    /*
     * Create a package in Moray. Add created_at and updated_at as
     * needed. We try to ensure we're not replacing an existing package, but
     * there's potential for races here since it's not an atomic operation.
     */

    function createPkg(params, meta, cb) {
        if (typeof (meta) === 'function') {
            cb = meta;
            meta = null;
        }

        var uuid = params.uuid;
        var pkg = encode(params);

        if (!pkg.created_at) {
            pkg.created_at = new Date().getTime();
        }
        pkg.updated_at = new Date().getTime();

        // Lookup first, we want to create new objects, not to update:
        backend.getObject(opts.bucket, uuid, function (err, obj) {
            if (err && err.name === 'ObjectNotFoundError') {
                return backend.putObject(opts.bucket, uuid, pkg, meta,
                    function (er1) {
                        if (er1) {
                            return cb(er1);
                        }
                        return cb();
                    });
            } else {
                var error = (err) ? err : 'ObjectAlreadyExistsError';
                return cb(error);
            }
        });
    }



    /*
     * Fetch a package from Moray.
     */

    function getPkg(uuid, meta, cb) {
        if (typeof (meta) === 'function') {
            cb = meta;
            meta = null;
        }

        return backend.getObject(opts.bucket, uuid, meta, function (err, obj) {
            if (err) {
                return cb(err);
            }

            var pkg = decode(obj.value, opts.schema);
            return cb(null, pkg);
        });
    }



    /*
     * This is for updating packages in Moray, but can be used for
     * create-or-update as well. Sets package updated_at to time of invocation.
     */

    function updatePkg(uuid, params, meta, cb) {
        if (typeof (meta) === 'function') {
            cb = meta;
            meta = null;
        }

        var pkg = encode(params);
        pkg.updated_at = new Date().getTime();

        backend.putObject(opts.bucket, params.uuid, pkg, meta,
            function (err) {
                if (err) {
                    return cb(err);
                }
                return cb();
            });
    }



    /*
     * Remove a package from Moray. Be aware this should only be called in
     * exceptional circumstances, since packages that have been used to
     * provision machines should never be deleted; they're needed for billing
     * and other historic purposes.
     */

    function deletePkg(uuid, meta, cb) {
        if (typeof (meta) === 'function') {
            cb = meta;
            meta = null;
        }

        backend.delObject(opts.bucket, uuid, meta, function (err) {
            cb(err);
        });
    }



    /*
     * Establish a connection to Moray, and set up listeners.
     */

    function init(cb) {
        backend = createMorayClient(opts);

        // Initial backend listeners:
        backend.once('error', function (err) {
            opts.log.fatal({err: err}, 'Moray Error');
            process.exit(1);
        });

        // Do not add the listener more than 'once' to moray connect, or it will
        // be called for every client reconnection:
        backend.once('connect', function () {
            opts.log.info('Successfully connected to moray');
            backend.removeAllListeners('error');

            backend.on('error', function (err) {
                opts.log.warn({err: err}, 'Moray: unexpected error occurred');
            });

            morayConnectCallback(cb);
        });

        backend.on('connectAttempt', function (mor, delay) {
            opts.log.info({
                attempt: mor.toString(),
                delay: delay
            }, 'ring: moray connection attempted: %s', mor.toString());
        });
    }

    return {
        init: init,
        quit: quit,
        ping: ping,
        getPackages: getPackages,
        createPkg: createPkg,
        getPkg: getPkg,
        updatePkg: updatePkg,
        deletePkg: deletePkg
    };
};
