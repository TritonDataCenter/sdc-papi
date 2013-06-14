#!/usr/bin/env node
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
var vasync = require('vasync');

var Backend = require('../lib/backend');
var tools = require('../lib/tools');

// ./bin/ldap-import.js --url ldaps://ufds.coal.joyent.us \
// --binddn 'cn=root' --password 'secret'

// If binder is running, ufds.coal.joyent.us addresses can be set using:
//      dig +short @10.99.99.11 ufds.coal.joyent.us A

// --- Globals

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

var DEFAULT_CFG = path.normalize(__dirname + '/../etc/config.json');

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

var Packages = [];
var attrs2ignore = ['dn', 'objectclass', 'controls'];
var attrs2numerify = ['max_physical_memory', 'max_swap',
    'vcpus', 'cpu_cap', 'max_lwps', 'quota', 'zfs_io_priority',
    'fss', 'cpu_burst_ratio', 'ram_ratio', 'overprovision_cpu',
    'overprovision_memory', 'overprovision_storage', 'overprovision_network',
    'overprovision_io'];
var booleans = ['active', 'default'];


function importPackages() {
    var cfg = tools.configure(DEFAULT_CFG, {}, log);
    cfg.log = log;
    var backend = Backend(cfg);
    backend.init(function () {
        var done = 0;
        Packages.forEach(function (p) {
            backend.createPkg(p, function (err) {
                if (err) {
                    process.stdout.write(util.format(
                            'Error importing package %s: %s\n', p.uuid, err));
                } else {
                    process.stdout.write(util.format(
                            'Package %s created successfully\n', p.uuid));
                }
                done += 1;
            });
        });

        function checkDone() {
            if (done === Packages.length) {
                process.exit(1);
            } else {
                setTimeout(checkDone, 200);
            }
        }
        checkDone();
    });
}

client.bind(parsed.binddn, parsed.password, function (err, r) {
    if (err) {
        perror(err);
    }

    var req = {
        scope: 'sub',
        filter: '(&(objectclass=sdcpackage))'
    };

    client.search('o=smartdc', req, function (er, res) {
        if (er) {
            perror(er);
        }

        res.on('searchEntry', function (entry) {
            // We have some LDAP attributes we're not interested into:
            var obj = entry.object;
            attrs2ignore.forEach(function (a) {
                delete obj[a];
            });
            attrs2numerify.forEach(function (a) {
                if (obj[a]) {
                    obj[a] = Number(obj[a]);
                }
            });
            booleans.forEach(function (a) {
                if (obj[a] === 'true') {
                    obj[a] = true;
                } else {
                    obj[a] = false;
                }
            });
            Packages.push(obj);
        });

        res.on('error', function (err2) {
            perror(err2);
        });

        res.on('end', function (res2) {
            if (res2.status !== 0) {
                process.stderr.write(ldap.getMessage(res2.status) + '\n');
            }
            client.unbind(function () {
                return importPackages();
            });
        });
    });
});
