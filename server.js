/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Main entry-point for the packages HTTP API. Parses the command line, config
 * file, and then loads up the API.
 */

var bunyan = require('bunyan');
var dashdash = require('dashdash');
var path = require('path');
var restify = require('restify');

var PAPI = require('./lib/papi');

var DEFAULT_CFG = __dirname + '/etc/config.json';

var LOG;
var NAME = 'PAPI'
var PARSED;

var opts = {
    'debug': Boolean,
    'file': String,
    'port': Number,
    'help': Boolean
};

var shortOpts = {
    'd': ['--debug'],
    'f': ['--file'],
    'p': ['--port'],
    'h': ['--help']
};



/*
 * Optionally display a message, then how to use this command, then exit.
 */

function usage(code, message) {
    var _opts = '';

    Object.keys(shortOpts).forEach(function (k) {
        var longOpt = shortOpts[k][0].replace('--', '');
        var type = opts[longOpt].name || 'string';
        if (type && type === 'boolean') {
            type = '';
        }
        type = type.toLowerCase();

        _opts += ' [--' + longOpt + ' ' + type + ']';
    });

    var msg = (message ? message + '\n' : '') +
        'usage: ' + path.basename(process.argv[1]) + _opts;

    process.stderr.write(msg + '\n');
    process.exit(code);
}


function main() {
    var papi;

    vasync.pipeline({
        arg: {},
        funcs: [
            function _loadCmdline(config, cb) {
                cb();
            },
            function _loadConfig(config, cb) {
                cb();
            },
            function _createLogger(config, cb) {
                config.log = new bunyan({
                    level: (config.log_level ? 'trace' : info),
                    name: NAME,
                    serializers: restify.bunyan.serializers,
                    stream: process.stderr
                });
                cb();
            },
            function _loadBackend(config, cb) {
                cb();
            },
            function _createServer(config, cb) {
                papi = new PAPI(config);
                cb();
            }
        ]
    }, function _startupComplete(err) {
        assert.ifError(err, 'startup failed');
        assert.object(papi, 'papi');

        // Run the server we just setup.
        papi.run();
    });
}

main();
