/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Main entry-point for the packages HTTP API. Parses the command line, config
 * file, and then loads up the API.
 */

var restify = require('restify');
var Logger = require('bunyan');
var nopt = require('nopt');
var path = require('path');
var papi = require('./lib/papi');

var DEFAULT_CFG = __dirname + '/etc/config.json';

var LOG;
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



/*
 * Fire up HTTP server
 */

function run() {
    return papi.createServer({
        config: PARSED.file || DEFAULT_CFG,
        overrides: PARSED,
        log: LOG
    }, function (err, server) {
        if (err) {
            LOG.error(err, 'failed to start server');
            process.abort();
        }

        LOG.info('Packages API listening at %s', server.url);
    });
}

///--- Mainline

PARSED = nopt(opts, shortOpts, process.argv, 2);
if (PARSED.help) {
    usage(0);
}

LOG = new Logger({
    level: (PARSED.debug ? 'trace' : 'info'),
    name: 'PackagesAPI',
    stream: process.stderr,
    serializers: restify.bunyan.serializers
});

// There we go!:
run();

// Increase/decrease loggers levels using SIGUSR2/SIGUSR1:
var sigyan = require('sigyan');
sigyan.add([LOG]);
