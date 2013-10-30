/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Random grab-bag of functions.
 */

var util = require('util');
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var assert = require('assert');



/*
 * Load default SDC packages which should be created during setup.
 */

function defaultPackages(cb) {
    fs.readFile(path.resolve(__dirname, '../etc/packages.json'), 'utf8',
            function (err, data) {
        if (err) {
            return cb(err);
        }

        try {
            var packages = JSON.parse(data);
            return cb(null, packages);
        } catch (e) {
            return cb(e);
        }
    });
}



/*
 * Load and return config.json.
 */

function configure(file, options, log) {
    assert.ok(file);
    var config;

    try {
        config = JSON.parse(fs.readFileSync(file, 'utf8'));

        if (!config.port) {
            config.port = 80;
        }
    } catch (e1) {
        console.error('Unable to parse %s: %s', file, e1.message);
        process.exit(1);
    }

    if (options.port) {
        config.port = options.port;
    }


    if (typeof (config.maxHttpSockets) === 'number') {
        log.info('Tuning max sockets to %d', config.maxHttpSockets);
        http.globalAgent.maxSockets = config.maxHttpSockets;
        https.globalAgent.maxSockets = config.maxHttpSockets;
    }

    return config;
}



module.exports = {
    defaultPackages: defaultPackages,
    configure: configure
};
