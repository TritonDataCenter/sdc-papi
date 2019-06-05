/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Random grab-bag of functions.
 */

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var assert = require('assert');



/*
 * Load default SDC packages which should be created during setup.
 */

function defaultPackages(cb) {
    var filepath = path.resolve(__dirname, '../etc/packages.json');
    fs.readFile(filepath, 'utf8', function (err, data) {
        if (err) {
            cb(err);
            return;
        }

        try {
            var packages = JSON.parse(data);

            packages.forEach(function (pkg) {
                if (pkg.owner_uuid) {
                    pkg.owner_uuids = [pkg.owner_uuid];
                }

                delete pkg.owner_uuid;
            });

            cb(null, packages);
        } catch (e) {
            cb(e);
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
        config.port = config.port || 80;
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
