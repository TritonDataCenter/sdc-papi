/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Utility to import sdcPackages from UFDS LDAP into sdc_packages bucket.
 */

var nopt = require('nopt');
var url = require('url');
var path = require('path');
var util = require('util');

var restify = require('restify');
var Logger = require('bunyan');
var ldap = require('ldapjs');

// ./bin/ldap-import.js --url ldaps://ufds.coal.joyent.us --binddn 'cn=root' --password 'secret'

///--- Globals

nopt.typeDefs.DN = {
    type: ldap.DN,
    validate: function (data, k, val) {
        data[k] = ldap.parseDN(val);
    }
};

var parsed;

var opts = {
    'debug': Number,
    'binddn': ldap.DN,
    'password': String,
    'timeout': Number,
    'url': url
};

var shortOpts = {
    'd': ['--debug'],
    'D': ['--binddn'],
    'w': ['--password'],
    't': ['--timeout'],
    'u': ['--url']
};


var logLevel = 'info';

///--- Helpers

function usage(code, message) {
    var _opts = '';
    Object.keys(shortOpts).forEach(function (k) {
        if (!Array.isArray(shortOpts[k])) {
            return;
        }
        var longOpt = shortOpts[k][0].replace('--', '');
        var type = opts[longOpt].name || 'string';
        if (type && type === 'boolean') {
            type = '';
        }
        type = type.toLowerCase();

        _opts += ' [--' + longOpt + ' ' + type + ']';
    });
    _opts += ' filter [attributes...]';

    var msg = (message ? message + '\n' : '') +
        'usage: ' + path.basename(process.argv[1]) + _opts;

    process.stderr.write(msg + '\n');
    process.exit(code);
}


function perror(err) {
    if (parsed.debug) {
        process.stderr.write(err.stack + '\n');
    } else {
        process.stderr.write(err.message + '\n');
    }
    process.exit(1);
}



///--- Mainline


try {
    parsed = nopt(opts, shortOpts, process.argv, 2);
} catch (e) {
    usage(1, e.toString());
}

if (parsed.help) {
    usage(0);
}

if (parsed.debug) {
    logLevel = (parsed.debug > 1 ? 'trace' : 'debug');
}

if (!parsed.url) {
    parsed.url = 'ldaps://ufds.coal.joyent.us';
}

if (!parsed.binddn) {
    parsed.binddn = 'cn=root';
}

if (!parsed.password) {
    parsed.password = 'secret';
}

var log = new Logger({
    name: 'ldapjs',
    component: 'client',
    stream: process.stderr,
    level: logLevel
});


var client = ldap.createClient({
    url: parsed.url,
    log: log,
    timeout: parsed.timeout || false
});

client.on('error', function (err) {
    perror(err);
});

client.on('timeout', function () {
    process.stderr.write('Timeout reached\n');
    process.exit(1);
});

client.bind(parsed.binddn, parsed.password, function (err, res) {
    if (err) {
        perror(err);
    }

    var req = {
        scope: 'sub',
        filter: '(&(objectclass=sdcpackage))',
        attributes: []
    };

    client.search('o=smartdc', req, function (err, res) {
        if (err) {
            perror(err);
        }

        res.on('searchEntry', function (entry) {
            process.stdout.write(util.inspect(entry.object, false, 8, true));
        });
    
        res.on('error', function (err) {
            perror(err);
        });
    
        res.on('end', function (res) {
            if (res.status !== 0) {
                process.stderr.write(ldap.getMessage(res.status) + '\n');
            }
            client.unbind(function () {
                return;
            });
        });
    });
});
