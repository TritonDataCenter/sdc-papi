/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Backend for the Packages API.
 */

var moray = require('moray');
var assert = require('assert');
var util = require('util');
var clone = require('clone');

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


// Translate any field defined as 'object' into cfg schema:
function schema2MorayIndex(schema) {
    var index = {};
    Object.keys(schema).forEach(function (k) {
        if (schema[k].index || schema[k].unique) {
            index[k] = {
                type: (schema[k].type === 'object') ? 'string' : schema[k].type
            };
            if (schema[k].unique) {
                index[k].unique = true;
            }
        }
    });
    return (index);
}


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

function encode(pkg) {
    var p;
    for (p in pkg) {
        if (typeof (pkg[p]) === 'object') {
            if (Object.keys(pkg[p]).length || pkg[p].length) {
                pkg[p] = JSON.stringify(pkg[p]);
            } else {
                // We don't want to add empty values for arrays, objects ...
                delete pkg[p];
            }
        }
    }
    // Cannot use 'default' and 'group' as PG indexes, obviously:
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

module.exports = function Backend(opts) {
    assert.ok(opts.log);
    var backend;
    var schema = schema2MorayIndex(opts.schema);


    function morayConnectCalback(callback) {
        opts.log.info({
            bucket: opts.bucket,
            schema: schema
        }, 'Configuring Packages bucket');

        return backend.putBucket(opts.bucket, {
            index: schema,
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
                    morayConnectCalback(callback);
                }, 10000);
            } else {
                callback();
            }
        });
    }

    function quit() {
        return backend.close();
    }

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

    function createPkg(params, meta, cb) {
        if (typeof (meta) === 'function') {
            cb = meta;
            meta = null;
        }

        var uuid = params.uuid;
        var pkg = encode(params);

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

    function updatePkg(uuid, params, meta, cb) {
        if (typeof (meta) === 'function') {
            cb = meta;
            meta = null;
        }

        var pkg = encode(params);

        backend.putObject(opts.bucket, params.uuid, pkg, meta,
            function (err) {
                if (err) {
                    return cb(err);
                }
                return cb();
            });
    }

    function deletePkg(uuid, meta, cb) {
        if (typeof (meta) === 'function') {
            cb = meta;
            meta = null;
        }

        backend.getObject(opts.bucket, uuid, meta, function (err) {
            cb(err);
        });
    }

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

            morayConnectCalback(cb);
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
