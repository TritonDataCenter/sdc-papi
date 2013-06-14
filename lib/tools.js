/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Backend for the Packages API.
 */

var util = require('util');
var fs = require('fs');
var path = require('path');

// Load default SDC packages created during setup.
// cb(err, packages)
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

module.exports = {
    defaultPackages: defaultPackages
};
