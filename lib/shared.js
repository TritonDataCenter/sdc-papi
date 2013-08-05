/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Stuff shared by UFDS and Moray import.
 */

var bunyan = require('bunyan');
var fs = require('fs');
var moray = require('moray');

function morayClient(opts, callback) {
    var log;
    if (!opts.log) {
        log = bunyan.createLogger({
            name: 'Moray Client',
            level: (process.env.LOG_LEVEL || 'info'),
            stream: process.stderr,
            serializers: bunyan.stdSerializers
        });
        opts.log = log;
    } else {
        log = opts.log;
    }

    var conf = {
        connectTimeout: 10000,
        log: log,
        url: opts.moray.url,
        noCache: true,
        reconnect: true,
        retry: { // try to reconnect forever
            maxTimeout: 30000,
            retries: Infinity
        }
    };

    var client = moray.createClient(conf);

    function onMorayError(err) {
        return callback(err);
    }

    function onMorayConnect() {
        client.removeListener('error', onMorayError);
        client.on('close', function () {
            client.log.error('moray: closed');
        });

        client.on('connect', function () {
            client.log.info('moray: reconnected');
        });

        client.on('error', function (err) {
            client.log.warn(err, 'moray: error (reconnecting)');
        });

        return callback(null, client);
    }

    client.once('connect', onMorayConnect);
    client.once('error', onMorayError);
}

// Get an array with all the package UUIDs on a single read
// cb(err, results)
function loadPackages(client, bucket, cb) {
    var results = [];
    var req = client.findObjects(bucket, '(&(uuid=*))');
    req.once('error', function (err) {
        return cb(err);
    });

    req.on('record', function (obj) {
        results.push(obj.value.uuid);
    });

    req.once('end', function () {
        return cb(null, results);
    });
}

function savePackage(client, pkg, bucket, cb) {

    // Cannot use 'default' and 'group' as PG indexes, obviously:
    if (typeof (pkg['default']) !== 'undefined') {
        pkg.is_default = pkg['default'];
        delete pkg['default'];
    }
    if (pkg.group) {
        pkg.group_name = pkg.group;
        delete pkg.group;
    }

    if (pkg.traits) {
        if (typeof (pkg.traits) === 'object' &&
            Object.keys(pkg.traits).length) {
            pkg.traits = JSON.stringify(pkg.traits);
        } else {
            delete pkg.traits;
        }
    }

    if (pkg.networks && typeof (pkg.networks) !== 'string') {
        pkg.networks = JSON.stringify(pkg.networks);
    } else {
        delete pkg.networks;
    }

    if (pkg.min_platform && typeof (pkg.min_platform) !== 'string') {
        pkg.min_platform = JSON.stringify(pkg.min_platform);
    } else {
        delete pkg.min_platform;
    }

    return client.putObject(bucket, pkg.uuid, pkg, function (err) {
        if (err) {
            return cb(err);
        }
        return cb();
    });
}

module.exports = {
    morayClient: morayClient,
    loadPackages: loadPackages,
    savePackage: savePackage
};
