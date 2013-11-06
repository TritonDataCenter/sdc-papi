/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Backend for the packages API, which talks to Moray in order to created, list,
 * or modify packages stored therein.
 */

var moray  = require('moray');
var assert = require('assert');
var util   = require('util');
var clone  = require('clone');

var RETRY_BUCKET_CREATION_INTERVAL = 10000; // in ms



/*
 * Backend constructor. Returns a set of methods useful for fetching and
 * updating packages in Moray.
 */

var Backend = module.exports =
function (opts) {
    assert.ok(opts.log);
    assert.ok(opts.bucket);
    assert.ok(opts.schema);

    this.opts    = opts;
    this.log     = opts.log;
    this.bucket  = opts.bucket;
    this.backend = null;
    this.schema  = opts.schema;
    this.indices = schema2MorayIndex(opts.schema);
};



/*
 * Establish a connection to Moray, and set up listeners.
 */

Backend.prototype.init =
function (cb) {
    var self = this;

    var log     = self.log;
    var indices = self.indices;
    var bucket  = self.bucket;
    var opts    = self.opts;

    var backend = createMorayClient(self.opts);
    self.backend = backend;

    /*
     * Ensure bucket for packages in Moray exists. Keep retrying every 10s
     * until successful.
     */

    var morayConnectCallback = function () {
        log.info({ bucket: bucket, indices: indices },
                 'Configuring Packages bucket');

        backend.putBucket(bucket, {
            index: indices,
            // make sure packages have created_at and updated_at timestamps
            pre: [ function timestamps(req, callback) {
                var date = new Date().getTime();

                if (!req.value.created_at && !req.update)
                    req.value.created_at = date;

                req.value.updated_at = date;
                return callback();
            }],
            options: {
                guaranteeOrder: true,
                syncUpdates: true,
                version: opts.moray.version
            }
        }, function (err) {
            if (err) {
                log.fatal({ err: err }, 'Unable to put SDC Packages bucket');
                log.info('Trying again in ' + RETRY_BUCKET_CREATION_INTERVAL +
                         ' ms');

                setTimeout(function () {
                    morayConnectCallback();
                }, RETRY_BUCKET_CREATION_INTERVAL);
            } else {
                cb();
            }
        });
    };

    // Initial backend listeners:
    backend.once('error', function (err) {
        log.fatal({ err: err }, 'Moray Error');
        process.exit(1);
    });

    // Do not add the listener more than 'once' to moray connect, or it will
    // be called for every client reconnection:
    backend.once('connect', function () {
        log.info('Successfully connected to moray');
        backend.removeAllListeners('error');

        backend.on('error', function (err) {
            log.warn({ err: err.stack || err },
                     'Moray: unexpected error occurred');
        });

        morayConnectCallback();
    });

    backend.on('connectAttempt', function (mor, delay) {
        log.info({
            attempt: mor.toString(),
            delay: delay
        }, 'ring: moray connection attempted: %s', mor.toString());
    });
};



/*
 * Close connection to Moray.
 */

Backend.prototype.quit =
function () {
    return this.backend.close();
};



/*
 * Check that connection to Moray is live.
 *
 * TODO: none of the callers provides opts arg, so remove most of this
 */

Backend.prototype.ping =
function (opts, cb) {
    var self = this;

    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }

    var options = clone(self.opts);

    Object.keys(opts).forEach(function (k) {
        options[k] = opts[k];
    });

    return self.backend.ping(options, cb);
};



/*
 * Fetch an array of packages which matches the given filter, and apply
 * any requested ordering.
 */

Backend.prototype.getPackages =
function (filter, meta, cb) {
    var self = this;

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

    var req = self.backend.findObjects(self.bucket, filter, meta);

    req.once('error', cb);

    req.on('record', function (obj) {
        results.push(decode(obj.value, self.schema));

        if (count === 0)
            count = obj._count;
    });

    req.once('end', function () {
        return cb(null, {
            results: results,
            total: count
        });
    });
};



/*
 * Create a package in Moray. Add created_at and updated_at as
 * needed. We try to ensure we're not replacing an existing package, but
 * there's potential for races here since it's not an atomic operation.
 */

Backend.prototype.createPkg =
function (params, meta, cb) {
    var self = this;

    if (typeof (meta) === 'function') {
        cb = meta;
        meta = null;
    }

    var uuid = params.uuid;
    var pkg = encode(params);
    var now = new Date().getTime();

    if (!pkg.created_at)
        pkg.created_at = now;

    pkg.updated_at = now;

    // Lookup first, we want to create new objects, not to update:
    var bucket  = self.bucket;
    var backend = self.backend;
    backend.getObject(bucket, uuid, function (err, obj) {
        if (err && err.name === 'ObjectNotFoundError') {
            return backend.putObject(bucket, uuid, pkg, meta, cb);
        } else {
            return cb(err || 'ObjectAlreadyExistsError');
        }
    });
};



/*
 * Fetch a package from Moray.
 */

Backend.prototype.getPkg =
function (uuid, meta, cb) {
    var self = this;

    if (typeof (meta) === 'function') {
        cb = meta;
        meta = null;
    }

    return self.backend.getObject(self.bucket, uuid, meta, function (err, obj) {
        if (err)
            return cb(err);

        var pkg = decode(obj.value, self.schema, self.log);
        return cb(null, pkg);
    });
};



/*
 * This is for updating packages in Moray, but can be used for
 * create-or-update as well. Sets package updated_at to time of invocation.
 */

Backend.prototype.updatePkg =
function (uuid, params, meta, cb) {
    var self = this;

    if (typeof (meta) === 'function') {
        cb = meta;
        meta = null;
    }

    var pkg = encode(params);
    pkg.updated_at = new Date().getTime();

    return self.backend.putObject(self.bucket, params.uuid, pkg, meta, cb);
};



/*
 * Remove a package from Moray. Be aware this should only be called in
 * exceptional circumstances, since packages that have been used to provision
 * machines should never be deleted; they're needed for billing and other
 * historic purposes.
 */

Backend.prototype.deletePkg =
function (uuid, meta, cb) {
    var self = this;

    if (typeof (meta) === 'function') {
        cb = meta;
        meta = null;
    }

    return self.backend.delObject(self.bucket, uuid, meta, cb);
};



/*
 * Create a client object to talk to Moray.
 */

function createMorayClient(options) {
    assert.ok(options);

    return moray.createClient({
        url: options.moray.url,
        log: options.log.child({ component: 'moray' }),
        dns: options.moray.dns || {},
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

            if (attr.unique)
                index.unique = true;

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

function decode(pkg, schema, log) {
    var p;

    for (p in pkg) {
        // Traits, networks, whatever else defined as object
        if (schema[p] && schema[p].type === 'object' &&
            typeof (pkg[p]) === 'string') {
            try {
                pkg[p] = JSON.parse(pkg[p]);
            } catch (e) {
                log.error({ pkg: pkg }, 'unable to decode');
            }
        }
    }

    // Couple fields we cannot define with their public name due to
    // PostgreSQL indexes definition rules:
    if (typeof (pkg.is_default) !== 'undefined') {
        pkg.default = pkg.is_default;
        delete pkg.is_default;
    }

    if (typeof (pkg.group_name) !== 'undefined') {
        pkg.group = pkg.group_name;
        delete pkg.group_name;
    }

    if (typeof (pkg.created_at) === 'number')
        pkg.created_at = new Date(pkg.created_at).toISOString();

    if (typeof (pkg.updated_at) === 'number')
        pkg.updated_at = new Date(pkg.updated_at).toISOString();

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
            if (attr.length > 0 || Object.keys(attr).length > 0) {
                pkg[p] = JSON.stringify(attr);
            } else {
                delete pkg[p];
            }
        }
    }

    // Cannot use 'default' and 'group' as PG indexes, so we save them under
    // slightly different names
    if (typeof (pkg.default) !== 'undefined') {
        pkg.is_default = pkg.default;
        delete pkg.default;
    }

    if (typeof (pkg.group) !== 'undefined') {
        pkg.group_name = pkg.group;
        delete pkg.group;
    }

    if (typeof (pkg.updated_at) === 'string')
        pkg.updated_at = new Date(pkg.updated_at).getTime();

    if (typeof (pkg.created_at) === 'string')
        pkg.created_at = new Date(pkg.created_at).getTime();

    return (pkg);
}
