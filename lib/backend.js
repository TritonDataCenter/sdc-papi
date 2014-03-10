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
var DB_RESERVED_NAMES = ['default', 'group'];



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
    this.indices = schema2MorayIndex(opts.schema, opts.log);
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

                if (!req.value.created_at)
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
 */

Backend.prototype.ping =
function (cb) {
    return this.backend.ping({}, cb);
};



/*
 * Fetch an array of packages which matches the given filter, and apply
 * any requested ordering.
 */

Backend.prototype.getPackages =
function (filter, meta, cb) {
    var self = this;

    if (typeof (meta.sort) === 'undefined') {
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
 * Create a package in Moray. We try to ensure we're not replacing an existing
 * package, but there's potential for races here since it's not an atomic
 * operation.
 */

Backend.prototype.createPkg =
function (uuid, params, meta, cb) {
    var self = this;

    var pkg = encode(params, self.schema);

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

    return self.backend.getObject(self.bucket, uuid, meta, function (err, obj) {
        if (err)
            return cb(err);

        var pkg = decode(obj.value, self.schema, self.log);
        return cb(null, pkg);
    });
};



/*
 * This is for updating packages in Moray, but can be used for
 * create-or-update as well.
 */

Backend.prototype.updatePkg =
function (uuid, params, meta, cb) {
    var self = this;

    var pkg = encode(params, self.schema);

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

function schema2MorayIndex(schema, log) {
    var indices = {};

    Object.keys(schema).forEach(function (k) {
        var attr = schema[k];

        if (attr.index || attr.unique) {
            var type = attr.type;

            if (type === 'object') {
                // cannot index hashes in moray (yet)
                log.fatal({ attr: attr }, 'Cannot index object');
                process.exit(1);

            } else if (type === 'double') {
                type = 'string';
            } else if (type === 'date') {
                type = 'number';
            } else if (type === 'uuid') {
                type = 'string';
            } else if (type === 'urn') {
                type = 'string';
            } else if (type === '[uuid]') {
                type = '[string]';
            }

            var index = { type: type };

            if (attr.unique)
                index.unique = true;

            indices[k] = index;
        }
    });

    DB_RESERVED_NAMES.forEach(function (name) {
        if (indices[name]) {
            indices['_' + name] = indices[name];
            delete indices[name];
        }
    });

    return (indices);
}



/*
 * Convert package data retrived from Moray into a JS representation more
 * suitable for JSONification.
 */

function decode(pkg, schema, log) {
    // Some names cannot be used as PG indexes, so we save them under slightly
    // different names
    for (var i = 0; i !== DB_RESERVED_NAMES.length; i++) {
        var stdName = DB_RESERVED_NAMES[i];
        var dbName = '_' + stdName;

        if (typeof (pkg[dbName]) !== 'undefined') {
            pkg[stdName] = pkg[dbName];
            delete pkg[dbName];
        }
    }

    var keys = Object.keys(schema);
    for (i = 0; i !== keys.length; i++) {
        var name = keys[i];
        var type = schema[name].type;
        var value = pkg[name];

        if (!value)
            continue;

        // for now we serialize doubles as strings, since moray doesn't
        // support floats yet
        if (type === 'double')
            pkg[name] = +value;

        if (type === 'date')
            pkg[name] = new Date(value).toISOString();
    }

    return (pkg);
}



/*
 * Convert hashes representing packages into a format which can be stored in
 * Moray.
 */

function encode(pkg, schema) {
    var p;

    // remove empty arrays or hashes
    for (p in pkg) {
        var attr = pkg[p];

        if (typeof (attr) === 'object') {
            if (Array.isArray(attr)) {
                if (attr.length === 0)
                    delete pkg[p];
            } else {
                if (Object.keys(attr).length === 0)
                    delete pkg[p];

            }
        }
    }

    // Some names cannot be used as PG indexes, so we save them under slightly
    // different names
    for (var i = 0; i !== DB_RESERVED_NAMES.length; i++) {
        var stdName = DB_RESERVED_NAMES[i];
        var dbName = '_' + stdName;

        if (typeof (pkg[stdName]) !== 'undefined') {
            pkg[dbName] = pkg[stdName];
            delete pkg[stdName];
        }
    }

    var keys = Object.keys(schema);
    for (i = 0; i !== keys.length; i++) {
        var name = keys[i];
        var type = schema[name].type;
        var value = pkg[name];

        if (!value)
            continue;

        // for now we serialize doubles as strings, since moray doesn't
        // support floats yet
        if (type === 'double')
            pkg[name] = '' + value;

        if (type === 'date' && typeof (value) === 'string')
            pkg[name] = +new Date(value);
    }

    return (pkg);
}
