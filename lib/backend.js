/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Backend for the Packages API.
 */

var moray = require('moray');
var assert = require('assert');
var util = require('util');

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

module.exports = function Backend(opts) {
    assert.ok(opts.log);
    var backend;

    function morayConnectCalback(cb) {
        opts.log.info({
            bucket: opts.bucket,
            schema: opts.schema
        }, 'Configuring Packages bucket');

        return backend.putBucket(opts.bucket, {
            index: opts.schema,
            options: {
                guaranteeOrder: true,
                syncUpdates: true
            }
        }, function (err) {
            if (err) {
                opts.log.fatal({err: err}, 'Unable to put SDC Packages bucket');
                opts.log.info('Trying again in 10 seconds');
                setTimeout(function () {
                    morayConnectCalback(cb);
                }, 10000);
            } else {
                cb();
            }
        });
    }

    function quit() {
        return backend.close();
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
            results.push(obj.value);
            if (count === 0) {
                count = obj._count;
            }
        });

        req.once('end', function () {
            results = results.map(function (r) {
                if (typeof (r.is_default) !== 'undefined') {
                    r['default'] = r.is_default;
                    delete r.is_default;
                }

                if (typeof (r.group_name) !== 'undefined') {
                    r.group = r.group_name;
                    delete r.group_name;
                }

                if (r.networks) {
                    try {
                        r.networks = JSON.parse(r.networks);
                    } catch (e) {
                        r.networks = [];
                    }
                }

                if (r.traits) {
                    try {
                        r.traits = JSON.parse(r.traits);
                    } catch (e1) {
                        r.traits = {};
                    }
                }
                return (r);
            });

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

        // Cannot use 'default' and 'group' as PG indexes, obviously:
        if (typeof (params['default']) !== 'undefined') {
            params.is_default = params['default'];
            delete params['default'];
        }
        if (params.group) {
            params.group_name = params.group;
            delete params.group;
        }

        if (params.traits) {
            if (typeof (params.traits) === 'object' &&
                Object.keys(params.traits).length) {
                params.traits = JSON.stringify(params.traits);
            } else {
                delete params.traits;
            }
        }

        if (params.networks && typeof (params.networks) !== 'string') {
            params.networks = JSON.stringify(params.networks);
        } else {
            delete params.networks;
        }

        // Lookup first, we want to create new objects, not to update:
        backend.getObject(opts.bucket, params.uuid, function (err, obj) {
            if (err && err.name === 'ObjectNotFoundError') {
                return backend.putObject(opts.bucket, params.uuid, params,
                    meta, function (er1) {
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

            var pkg = obj.value;
            if (typeof (pkg.is_default) !== 'undefined') {
                pkg['default'] = pkg.is_default;
                delete pkg.is_default;
            }

            if (typeof (pkg.group_name) !== 'undefined') {
                pkg.group = pkg.group_name;
                delete pkg.group_name;
            }

            if (pkg.networks) {
                try {
                    pkg.networks = JSON.parse(pkg.networks);
                } catch (e) {
                    pkg.networks = [];
                }
            }
            if (pkg.traits) {
                try {
                    pkg.traits = JSON.parse(pkg.traits);
                } catch (e1) {
                    pkg.traits = {};
                }
            }
            return cb(null, pkg);
        });
    }

    function updatePkg(uuid, params, meta, cb) {
        if (typeof (meta) === 'function') {
            cb = meta;
            meta = null;
        }

        // Cannot use 'default' and 'group' as PG indexes, obviously:
        if (typeof (params['default']) !== 'undefined') {
            params.is_default = params['default'];
            delete params['default'];
        }
        if (params.group) {
            params.group_name = params.group;
            delete params.group;
        }

        if (params.traits) {
            if (typeof (params.traits) === 'object' &&
                Object.keys(params.traits).length) {
                params.traits = JSON.stringify(params.traits);
            } else {
                delete params.traits;
            }
        }

        if (params.networks && typeof (params.networks) !== 'string') {
            params.networks = JSON.stringify(params.networks);
        } else {
            delete params.networks;
        }

        backend.putObject(opts.bucket, params.uuid, params, meta,
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

        // Do not add the listener more than 'once' to moray connect, or it will be
        // called for every client reconnection:
        backend.once('connect', function () {
            opts.log.info('Successfully connected to moray');
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
        moray: backend,
        init: init,
        quit: quit,
        getPackages: getPackages,
        createPkg: createPkg,
        getPkg: getPkg,
        updatePkg: updatePkg,
        deletePkg: deletePkg
    };
};
