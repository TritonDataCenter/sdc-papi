/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 * Copyright 2025 MNX Cloud, Inc.
 */

/*
 * Test the Package API endpoints,
 */

var fs      = require('fs');
var path    = require('path');
var qs      = require('querystring');
var os      = require('os');

var jsprim = require('jsprim');
var libuuid = require('libuuid');
var Logger  = require('bunyan');
var restify = require('restify');
var test    = require('@smaller/tap').test;

var papi = require('../lib/papi');

// If we're in the papi zone, use the papi config. Otherwise assume we're on
// someone's laptop and they're using the default COAL IP addresses.
var cfgFile = path.resolve(__dirname, '../etc/config.json');
cfgFile = fs.existsSync(cfgFile) ? cfgFile :
    path.resolve(__dirname, '../etc/config.test.json');

var config = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));

// For tests, override the port to 8080 so we don't block (or get queries for)
// real papi if we're running in the zone.
config.port = 8080;

var pkgNamePrefix = 'papitest-api-' + os.hostname() + '-';

var packages = [ {
    v: 1,
    uuid: '27543bf3-0c66-4f61-9ae4-7dda5cb4741b',
    name: pkgName(128),
    version: '1.0.0',
    os: 'smartos',
    max_physical_memory: 128,
    quota: 5120,
    max_swap: 256,
    cpu_cap: 350,
    cpu_burst_ratio: 0.5,
    max_lwps: 2000,
    zfs_io_priority: 1,
    default: true,
    vcpus: 1,
    active: true,
    networks: [
        'aefd7d3c-a4fd-4812-9dd7-24733974d861',
        'de749393-836c-42ce-9c7b-e81072ca3a23'
    ],
    traits: {
        bool: true,
        arr: ['one', 'two', 'three'],
        str: 'a string'
    },
    group: 'ramones',
    description: 'This is a package description, and should be present',
    common_name: 'API Test 128MiB',
    fss: 25,
    billing_tag: 'ApiTest128MiB',
    alloc_server_spread: 'random'
}, {
    v: 1,
    uuid: '43cedda8-f844-4a62-956a-85691fa21b36',
    name: pkgName(2048),
    version: '1.0.1',
    active: false,
    cpu_cap: 300,
    default: true,
    max_lwps: 2000,
    max_physical_memory: 2048,
    max_swap: 4096,
    quota: 81920,
    zfs_io_priority: 50,
    owner_uuids: ['7f5501af-12da-4727-8579-625e527ed1f2'],
    alloc_server_spread: 'min-owner'
}, {
    v: 1,
    uuid: '9cfe7e8b-d1c8-40a5-8e20-214d43f95124',
    name: pkgName(512),
    version: '1.0.1',
    active: true,
    cpu_cap: 300,
    default: false,
    max_lwps: 1000,
    max_physical_memory: 512,
    max_swap: 1024,
    quota: 10240,
    zfs_io_priority: 100,
    owner_uuids: [
        '7f5501af-12da-4727-8579-625e527ed1f2',
        'c39b6d6a-1c11-4d1b-b213-174974d71b45'
    ]
}, {
    v: 1,
    active: true,
    brand: 'bhyve',
    cpu_cap: 300,
    flexible_disk: true,
    max_lwps: 1000,
    max_physical_memory: 512,
    max_swap: 1024,
    name: pkgName('bhyve-512'),
    quota: 10240,
    version: '1.0.0',
    uuid: 'b87479f8-1ce1-11e8-8444-636ba22202b2',
    vcpus: 2,
    zfs_io_priority: 100
} ];

var backend;
var client;
var server;

test('setup', function (t) {
    var log = new Logger({
        level: process.env.LOG_LEVEL || 'info',
        name: 'sdc-package-api-test',
        stream: process.stdout,
        serializers: restify.bunyan.serializers
    });

    papi.createServer({
        config: cfgFile,
        log: log,
        overrides: config,
        test: true
    }, function (_err, s) {
        server  = s;
        backend = server.backend;

        t.ok(server);
        t.ok(backend);

        client = restify.createJsonClient({
            log: s.log,
            url: 'http://127.0.0.1:' + config.port,
            version: '*',
            retryOptions: {
                retry: 0
            }
        });

        t.ok(client);
        t.end();
    });
});

test('Clean up stale state (before)', cleanUp);
test('Check no stale packages (before)', checkNoPkgs);

test('GET /ping', function (t) {
    client.get('/ping', function (err, req, res, health) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(typeof (health) === 'object');
        t.ok(typeof (health.pid) === 'number');
        t.equal(health.backend, 'up');
        t.end();
    });
});

test('GET /packages', function (t) {
    client.get('/packages', function (err, req, res, pkgs) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(res.headers['x-resource-count']);
        t.ok(Array.isArray(pkgs));
        t.end();
    });
});

test('POST /packages (OK)', function (t) {
    var postPkgs = packages.slice();

    var postPkg = function () {
        var newPkg = postPkgs.pop();

        client.post('/packages', newPkg, function (err, req, res, storedPkg) {
            t.ifError(err);
            t.equal(res.statusCode, 201);

            checkAndStripDateFields(t, storedPkg);
            t.deepEqual(newPkg, storedPkg);

            var location = res.headers.location;
            t.equal(location, '/packages/' + newPkg.uuid);

            client.get(location, function (err2, req2, res2, storedPkg2) {
                t.ifError(err2);
                t.equal(res2.statusCode, 200);

                checkAndStripDateFields(t, storedPkg2);
                t.deepEqual(newPkg, storedPkg2);

                if (postPkgs.length > 0)
                    return postPkg();

                return t.end();
            });
        });
    };

    postPkg();
});

test('POST /packages/:uuid (bad fields)', function (t) {
    var badPkg = {
        active: false,
        cpu_cap: 100,
        max_lwps: 1000,
        max_physical_memory: 1024,
        max_swap: 2048,
        name: 'foo',
        quota: 10240,
        version: '1.0.0',
        zfs_io_priority: 100,
        foobarbaz: true  // unrecognised
    };

    client.post('/packages', badPkg, function (err, req, res, _pkg) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        t.equal(err.body.code, 'InvalidArgument');
        t.equal(err.body.message, 'Unrecognised attributes');

        var expectedErrs = [
            { field: 'foobarbaz',
              code: 'Invalid',
              message: 'is an unsupported attribute' }
        ];
        t.deepEqual(err.body.errors, expectedErrs);

        t.end();
    });
});

test('POST /packages/:uuid (invalid package name)', function (t) {
    var badPkg = {
        active: false,
        cpu_cap: 100,
        default: false,
        max_lwps: 1000,
        max_physical_memory: 1024,
        max_swap: 2048,
        name: '@#$\'!',
        quota: 10240,
        version: '1.0.0',
        zfs_io_priority: 100
    };

    client.post('/packages', badPkg, function (err, req, res, _pkg) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        t.equal(err.body.code, 'InvalidArgument');
        t.equal(err.body.message, 'Package is invalid');

        var expectedErrs = [
            { field: 'name',
              code: 'Invalid',
              message: 'must match ' +
                '/^[a-zA-Z0-9]([a-zA-Z0-9_\\-.]+)?[a-zA-Z0-9]$/ and not' +
                ' contain repeated \'-\', \'_\' or \'.\' characters'
            }
        ];
        t.deepEqual(err.body.errors, expectedErrs);

        t.end();
    });
});

test('POST /packages (missing required fields)', function (t) {
    var pkg = {
        vcpus: 1,
        networks: [
            'aefd7d3c-a4fd-4812-9dd7-24733974d861',
            'de749393-836c-42ce-9c7b-e81072ca3a23'
        ],
        traits: {
            bool: true,
            arr: ['one', 'two', 'three'],
            str: 'a string'
        }
    };

    client.post('/packages', pkg, function (err, req, res, _) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        t.equal(err.body.code, 'InvalidArgument');
        t.equal(err.body.message, 'Package is invalid');

        var expectedErrs = [
            { field: 'active', code: 'Missing', message: 'is missing' },
            { field: 'cpu_cap', code: 'Missing', message: 'is missing' },
            { field: 'max_lwps', code: 'Missing', message: 'is missing' },
            { field: 'max_physical_memory',
              code: 'Missing',
              message: 'is missing' },
            { field: 'max_swap', code: 'Missing', message: 'is missing' },
            { field: 'name', code: 'Missing', message: 'is missing' },
            { field: 'quota', code: 'Missing', message: 'is missing' },
            { field: 'version', code: 'Missing', message: 'is missing' },
            { field: 'zfs_io_priority',
              code: 'Missing',
              message: 'is missing' }
        ];
        t.deepEqual(err.body.errors, expectedErrs);

        t.end();
    });
});

test('POST /packages (empty required fields)', function (t) {
    var pkg = {
        uuid: '', // uuid gets set if empty or null
        name: '',
        version: '',
        active: true,
        cpu_cap: 300,
        default: false,
        max_lwps: 1000,
        max_physical_memory: 128,
        max_swap: 128,
        quota: 2048,
        zfs_io_priority: 10
    };

    client.post('/packages', pkg, function (err, req, res, _) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        t.equal(err.body.code, 'InvalidArgument');
        t.equal(err.body.message, 'Package is invalid');

        var expectedErrs = [
            { field: 'name', code: 'Missing', message: 'is empty' },
            { field: 'version', code: 'Missing', message: 'is empty' }
        ];
        t.deepEqual(err.body.errors, expectedErrs);

        t.end();
    });
});

test('POST /packages (fields validation failed)', function (t) {
    var pkg = {
        brand: 'WcDonalds',
        name: pkgName('fail-validation'),
        version: '1.0.0',
        os: 2,
        max_physical_memory: 32,
        quota: 512,
        max_swap: 256,
        cpu_cap: 350,
        max_lwps: 2000,
        zfs_io_priority: 100000,
        'default': true,
        vcpus: 30,
        active: true,
        networks: [
            'aefd7d3c-a4fd-4812-9dd7-24733974d861',
            'de749393-836c-42ce-9c7b-'
        ],
        traits: {
            bool: true,
            arr: ['one', 'two', 'three'],
            str: 'a string'
        },
        group: 'ramones',
        uuid: 'invalid-uuid-for-sure',
        description: 'This is a package description, and should be present',
        common_name: 'Regular 128MiB',
        fss: 25,
        alloc_server_spread: 'invalid',
        flexible_disk: 'ho-ho-ho!',
        disks: [ {'foo': 'bar'} ]
    };

    client.post('/packages', pkg, function (err, req, res, _) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        t.equal(err.body.code, 'InvalidArgument');
        t.equal(err.body.message, 'Package is invalid');

        var expectedErrs = [
            {
                field: 'disks',
                code: 'Invalid',
                message: 'must only contain Objects with "size" property'
            },
            {
                field: 'flexible_disk',
                code: 'Invalid',
                message: 'must be boolean'
            },
            {
                field: 'networks',
                code: 'Invalid',
                message: 'must only contain UUIDs'
            },
            {
                field: 'os',
                code: 'Invalid',
                message: 'must be string'
            },
            {
                field: 'uuid',
                code: 'Invalid',
                message: 'must be UUID'
            },
            {
                field: 'alloc_server_spread',
                code: 'Invalid',
                message: 'must be one of: min-ram, random, min-owner'
            },
            {
                field: 'brand',
                code: 'Invalid',
                message:
                    'must be one of: bhyve, joyent, joyent-minimal, kvm, lx'
            },
            {
                field: 'max_physical_memory',
                code: 'Invalid',
                message: 'must be greater or equal to 64'
            },
            {
                field: 'quota',
                code: 'Invalid',
                message: 'must be greater or equal to 1024'
            },
            {
                field: 'quota',
                code: 'Invalid',
                message: 'must be a multiple of 1024'
            },
            {
                field: 'zfs_io_priority',
                code: 'Invalid',
                message: 'must be greater or equal to 0, and less than or ' +
                  'equal to 16383'
            },
            {
                field: 'disks',
                code: 'Invalid',
                message: 'disks can be specified only for flexible_disk' +
                ' packages'
            }
        ];
        t.deepEqual(err.body.errors, expectedErrs);

        t.end();
    });
});

test('POST /packages (quota must be multiple of 1024)', function (t) {
    var pkg = {
        name: pkgName('fail-quota'),
        version: '1.0.0',
        os: 'smartos',
        max_physical_memory: 64,
        quota: 1280,
        max_swap: 256,
        cpu_cap: 350,
        max_lwps: 2000,
        zfs_io_priority: 100,
        'default': true,
        vcpus: 30,
        active: true,
        group: 'ramones',
        uuid: 'ebb58a8c-b77e-4559-bbf0-19ebd67973f0',
        description: 'This is a package description, and should be present',
        common_name: 'Regular 128MiB',
        fss: 25,
        flexible_disk: true,
        disks: [ {} ]
    };

    client.post('/packages', pkg, function (err, req, res, _) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        t.equal(err.body.code, 'InvalidArgument');
        t.equal(err.body.message, 'Package is invalid');

        var expectedErrs = [
            { field: 'quota',
              code: 'Invalid',
              message: 'must be a multiple of 1024' }
        ];
        t.deepEqual(err.body.errors, expectedErrs);

        t.end();
    });
});

test('POST /packages (duplicated unique field)', function (t) {
    client.post('/packages', packages[0], function (err, req, res, _pkg) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        var expected = {
            code: 'ConflictError',
            message: 'A package with the given UUID already exists'
        };

        t.deepEqual(err.body, expected);
        t.end();
    });
});

test('POST /packages (VCPUS exceeding MAX value)', function (t) {
    var pkg = {
        name: pkgName('fail-max-cpu'),
        version: '1.0.0',
        os: 'smartos',
        max_physical_memory: 64,
        quota: 1024,
        max_swap: 256,
        cpu_cap: 350,
        max_lwps: 3000,
        zfs_io_priority: 100,
        'default': true,
        vcpus: 72,
        active: true,
        group: 'ramones',
        uuid: 'ebb58a8c-b77e-4559-bbf0-19ebd67973f0',
        description: 'This is a package description, and should be present',
        common_name: 'Regular 128MiB',
        fss: 25,
        flexible_disk: true,
        disks: [ {
            size: 'remaining'
        } ]
    };

    client.post('/packages', pkg, function (err, req, res, _) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        t.equal(err.body.code, 'InvalidArgument');
        t.equal(err.body.message, 'Package is invalid');

        var expectedErrs = [ {
            field: 'vcpus',
            code: 'Invalid',
            message: 'must be greater or equal to 1, and less or equal to 64'
        }];
        t.deepEqual(err.body.errors, expectedErrs);

        t.end();
    });
});

test('GET /packages/:uuid (OK)', checkPkg1);

test('GET /packages/:uuid (404)', function (t) {
    var badUuid = uuid();

    client.get('/packages/' + badUuid, function (err, req, res, _pkg) {
        t.equal(res.statusCode, 404);

        var expected = {
            code: 'ResourceNotFound',
            message: 'Package ' + badUuid + ' does not exist'
        };

        t.deepEqual(err.body, expected);
        t.end();
    });
});

test('GET /packages (Search by owner_uuids)', function (t) {
    var query = '/packages?owner_uuids=' + config.ufds_admin_uuid;

    client.get(query, function (err, req, res, pkgs) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(res.headers['x-resource-count']);
        t.ok(Array.isArray(pkgs));
        t.ok(pkgs.length > 0);

        pkgs.forEach(function (p) {
            t.ok(p.owner_uuids === undefined ||
                 p.owner_uuids.indexOf(config.ufds_admin_uuid) !== -1);
        });

        t.end();
    });
});

test('GET /packages (Search by group)', function (t) {
    var query = '/packages?group=ramones';

    var testFilter = function (p) {
        return p.group === 'ramones';
    };

    searchAndCheckPkgs(t, query, testFilter);
});

test('GET /packages (Search by networks)', function (t) {
    var network = packages[0].networks[1];
    var query = '/packages?networks=' + network;

    var testFilter = function (p) {
        if (!p.networks)
            return false;

        return p.networks.indexOf(network) !== -1;
    };

    searchAndCheckPkgs(t, query, testFilter);
});

test('GET /packages (Search by name)', function (t) {
    var name = pkgName(128);
    var query = '/packages?name=' + name;

    var testFilter = function (p) {
        return p.name === name;
    };

    searchAndCheckPkgs(t, query, testFilter);
});

test('GET /packages (Search by flexible_disk)', function (t) {
    var query = '/packages?flexible_disk=true';

    client.get(query, function (err, req, res, pkgs) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(Array.isArray(pkgs));

        t.ok(pkgs.length > 0, 'Got flexible_disk packages');
        pkgs.forEach(function checkFlexibleDisk(pkg) {
            t.ok(pkg.flexible_disk, 'flexible disk');
        });

        t.end();
    });
});

test('GET /packages (Search by wildcard)', function (t) {
    var name = pkgName('');
    var query = '/packages?name=' + name + '*';

    var testFilter = function (p) {
        return new RegExp('^' + name).test(p.name);
    };

    searchAndCheckPkgs(t, query, testFilter);
});

test('GET /packages (Search by multiple wildcard)', function (t) {
    var name = pkgName('');
    var query = '/packages?name=*' + name.slice(1) + '*';

    var testFilter = function (p) {
        return new RegExp('^' + name).test(p.name);
    };

    searchAndCheckPkgs(t, query, testFilter);
});

test('GET /packages (Search by multiple fields)', function (t) {
    var name = pkgName('');
    var query = '/packages?name=' + name + '*&owner_uuids=' + uuid();

    var testFilter = function (p) {
        return new RegExp('^' + name).test(p.name) && !p.owner_uuids;
    };

    searchAndCheckPkgs(t, query, testFilter);
});

test('GET /packages (Search with LDIF injection attempt)', function (t) {
    client.get({
        path: '/packages',
        query: {
            name: 'api_test_*',
            networks: '*)(owner_uuids={\\2a}'
        }
    }, function (_err, req, res, body) {
        t.equal(res.statusCode, 500);

        t.deepEqual(body, {
            code: 'InternalError',
            message: 'sdc_packages does not have indexes that support ' +
                     '(networks=*{\\)}{\\(}owner_uuids{\\=}{\\*})'
        });

        t.end();
    });
});

test('GET /packages (Custom filter)', function (t) {
    var name = pkgName('');
    var filter = '(&(name=' + name + '*)(max_physical_memory>=64)' +
                 '(zfs_io_priority=1))';
    var query = '/packages?filter=' + qs.escape(filter);

    var testFilter = function (p) {
        return new RegExp('^' + name).test(p.name) &&
               p.max_physical_memory >= 64 &&
               p.zfs_io_priority === 1;
    };

    searchAndCheckPkgs(t, query, testFilter);
});

test('GET /packages (Custom invalid filter)', function (t) {
    // intentionally missing a '('
    var filter = '(&(max_physical_memory>=64)zfs_io_priority=1)';
    var query = '/packages?filter=' + qs.escape(filter);

    client.get(query, function (err, req, res, _) {
        t.equal(res.statusCode, 409);

        var expected = {
            code: 'InvalidArgument',
            message: 'Provided search filter is not valid'
        };

        t.deepEqual(err.body, expected);
        t.end();
    });
});

test('GET /packages (Custom substring filter ignoring case)', function (t) {
    var name = pkgName('');
    var filter = '(name:caseIgnoreSubstringsMatch:=' + name.toUpperCase() +
                 '*)';
    var query = '/packages?filter=' + qs.escape(filter);

    var testFilter = function (p) {
        return new RegExp('^' + name).test(p.name);
    };

    searchAndCheckPkgs(t, query, testFilter);
});

test('GET /packages (Custom filter ignoring case)', function (t) {
    var name = pkgName(256);
    var filter = '(name:caseIgnoreMatch:=' + name.toUpperCase() + ')';
    var query = '/packages?filter=' + qs.escape(filter);

    var testFilter = function (p) {
        return new RegExp('^' + name).test(p.name);
    };

    searchAndCheckPkgs(t, query, testFilter);
});

test('GET /packages (Search by multiple entries per field)', function (t) {
    var name256 = pkgName(256);
    var name512 = pkgName(512);
    var query = '/packages?name=["' + name256 + '","' + name512 + '"]';

    var testFilter = function (p) {
        return p.name === name256 || p.name === name512;
    };

    searchAndCheckPkgs(t, query, testFilter);
});

test('GET /packages (Search by multiple entries and fields)', function (t) {
    var name256 = pkgName(256);
    var name512 = pkgName(512);
    var ownerUuid = '7f5501af-12da-4727-8579-625e527ed1f2';
    var query = '/packages?name=["' + name256 + '","' + name512 + '"]' +
                '&owner_uuids=["' + ownerUuid + '"]';

    var testFilter = function (p) {
        return (p.name === name256 || p.name === name512) &&
               p.owner_uuids && p.owner_uuids.indexOf(ownerUuid) !== -1;
    };

    searchAndCheckPkgs(t, query, testFilter);
});

test('GET /packages (Search by empty multiple entries)', function (t) {
    client.get('/packages?name=[]', function (_err, req, res, _) {
        t.equal(res.statusCode, 404);
        t.end();
    });
});

test('PUT /packages/:uuid (immutable fields)', function (t) {
    var immutable = {
        name: pkgName('immutable'),
        version: '1.0.1',
        os: 'linux',
        quota: 5124,
        max_swap: 257,
        max_physical_memory: 129,
        cpu_cap: 351,
        max_lwps: 1999,
        zfs_io_priority: 2,
        vcpus: 4
    };

    client.put('/packages/' + packages[0].uuid, immutable,
        function (err, req, res, _pkg) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        t.equal(err.body.code, 'InvalidArgument');
        t.equal(err.body.message, 'Attempt to update immutables');

        var expectedErrs = [
            { field: 'cpu_cap', code: 'Invalid', message: 'is immutable' },
            { field: 'max_lwps', code: 'Invalid', message: 'is immutable' },
            { field: 'max_physical_memory',
              code: 'Invalid',
              message: 'is immutable' },
            { field: 'max_swap', code: 'Invalid', message: 'is immutable' },
            { field: 'name', code: 'Invalid', message: 'is immutable' },
            { field: 'os', code: 'Invalid', message: 'is immutable' },
            { field: 'quota', code: 'Invalid', message: 'is immutable' },
            { field: 'vcpus', code: 'Invalid', message: 'is immutable' },
            { field: 'version', code: 'Invalid', message: 'is immutable' },
            { field: 'zfs_io_priority',
              code: 'Invalid',
              message: 'is immutable' }
        ];
        t.deepEqual(err.body.errors, expectedErrs);

        t.end();
    });
});

test('GET /packages/:uuid (OK after failed PUT)', checkPkg1);

test('PUT /packages/:uuid (validation failed)', function (t) {
    client.put('/packages/' + packages[0].uuid, {
        owner_uuids: ['this-is-not-a-valid-uuid']
    }, function (err, req, res, _pkg) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        t.equal(err.body.code, 'InvalidArgument');
        t.equal(err.body.message, 'Updated package is invalid');

        var expectedErrs = [
            { field: 'owner_uuids',
              code: 'Invalid',
              message: 'must only contain UUIDs' }
        ];
        t.deepEqual(err.body.errors, expectedErrs);

        t.end();
    });
});

test('GET /packages/:uuid (OK after failed PUT)', checkPkg1);

test('PUT /packages/:uuid (bad fields)', function (t) {
    client.put('/packages/' + packages[0].uuid, {
        foobarbaz: 21
    }, function (err, req, res, _pkg) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        t.equal(err.body.code, 'InvalidArgument');
        t.equal(err.body.message, 'Unrecognised attributes');

        var expectedErrs = [
            { field: 'foobarbaz',
              code: 'Invalid',
              message: 'is an unsupported attribute' }
        ];
        t.deepEqual(err.body.errors, expectedErrs);

        t.end();
    });
});

test('GET /packages/:uuid (OK after failed PUT)', checkPkg1);

test('PUT /packages/:uuid (skip-validation)', function (t) {
    var url = '/packages/' + packages[0].uuid;
    var ownerUuids = ['this-is-not-a-valid-uuid'];

    client.put(url, {
        owner_uuids: ownerUuids,
        skip_validation: true
    }, function (err, req, res, pkg) {
        t.ifError(err, 'should not be error creating package, err=' + err);
        t.equal(res.statusCode, 200,
            'CreatePackage status code: ' + res.statusCode);
        t.ok(pkg, 'created package UUID ' + pkg.uuid);

        checkAndStripDateFields(t, pkg);

        var newPkg = jsprim.deepCopy(packages[0]);
        newPkg.owner_uuids = ownerUuids;
        t.deepEqual(pkg, newPkg);

        client.get(url, function (err2, req2, res2, pkg2) {
            t.ifError(err2);

            checkAndStripDateFields(t, pkg2);
            t.deepEqual(pkg2, newPkg);

            t.end();
        });
    });
});

test('PUT /packages/:uuid (OK)', function (t) {
    var url = '/packages/' + packages[0].uuid;
    var ownerUuids = [config.ufds_admin_uuid];

    client.put(url, {
        owner_uuids: ownerUuids,
        common_name: null
    }, function (err, req, res, pkg) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(pkg);

        checkAndStripDateFields(t, pkg);

        var newPkg = jsprim.deepCopy(packages[0]);
        newPkg.owner_uuids = ownerUuids;
        delete newPkg.common_name;
        t.deepEqual(pkg, newPkg);

        client.get(url, function (err2, req2, res2, pkg2) {
            t.ifError(err2);

            checkAndStripDateFields(t, pkg2);
            t.deepEqual(pkg2, newPkg);

            client.put(url, {
                owner_uuids: [],
                common_name: packages[0].common_name
            }, function (err3, req3, res3, pkg3) {
                t.ifError(err3);

                checkAndStripDateFields(t, pkg3);
                t.deepEqual(pkg3, packages[0]);

                t.end();
            });
        });
    });
});

test('PUT /packages/:uuid (404)', function (t) {
    var badUuid = uuid();

    client.put('/packages/' + badUuid, {}, function (err, req, res, _pkg) {
        t.ok(err);
        t.equal(res.statusCode, 404);

        var expected = {
            code: 'ResourceNotFound',
            message: 'Package ' + badUuid + ' does not exist'
        };

        t.deepEqual(err.body, expected);
        t.end();
    });
});

test('DELETE /packages/:uuid (405)', function (t) {
    client.del('/packages/' + packages[0].uuid, function (err, req, res) {
        t.ok(err);
        t.equal(res.statusCode, 405);

        var expected = {
            code: 'BadMethod',
            message: 'Packages cannot be deleted'
        };

        t.deepEqual(err.body, expected);
        t.end();
    });
});

test('GET /packages/:uuid (OK after failed DELETE)', checkPkg1);

test('DELETE /packages/:uuid (404)', function (t) {
    var badUuid = uuid();

    client.del('/packages/' + badUuid, function (err, req, res) {
        t.ok(err);
        t.equal(res.statusCode, 404);

        var expected = {
            code: 'ResourceNotFound',
            message: 'Package ' + badUuid + ' does not exist'
        };

        t.deepEqual(err.body, expected);
        t.end();
    });
});

test('DELETE /packages/:uuid (--force)', function (t) {
    var url = '/packages/' + packages[0].uuid;

    client.del(url + '?force=true', function (err, req, res) {
        t.ifError(err);
        t.equal(res.statusCode, 204);

        client.get(url, function (err2, req2, res2) {
            t.equal(err2.statusCode, 404);
            t.end();
        });
    });
});


test('Clean up stale state (after)', cleanUp);
test('Check no stale packages (after)', checkNoPkgs);

test('teardown', function (t) {
    client.close();
    server.close(function () {
        backend.quit();
        t.end();

        // hack until I figure out why process is hanging when tests complete
        setTimeout(function () { process.exit(0); }, 200);
    });
});

function cleanUp(t) {
    function deletePkgs(pkgs) {
        if (pkgs.length === 0)
            return t.end();

        var pkg = pkgs.pop();
        var url = '/packages/' + pkg.uuid + '?force=true';

        return client.del(url, function (err, req, res, _obj) {
            if (err && err.statusCode !== 404)
                t.ifError(err);

            deletePkgs(pkgs);
        });
    }

    client.get({
        path: '/packages?name=' + pkgName('') + '*'
    }, function (err, req, res, pkgs) {
        t.ifError(err);
        deletePkgs(pkgs);
    });
}

function checkNoPkgs(t) {
    function checkPkgs(pkgs) {
        if (pkgs.length === 0)
            return t.end();

        var pkg = pkgs.pop();
        var url = '/packages/' + pkg.uuid;

        return client.get(url, function (err, req, res, _obj) {
            t.equal(err.statusCode, 404);
            checkPkgs(pkgs);
        });
    }

    checkPkgs(packages.map(function (p) { return p.uuid; }));
}

// Ensure package date fields are like valid dates.
// Limitation: It would be nice to validate that they are ISO date strings.
function checkAndStripDateFields(t, pkg) {
    var created_at = new Date(pkg.created_at);
    t.ok(typeof (pkg.created_at) === 'string' && !isNaN(created_at),
        'pkg.created_at is a date string: ' + pkg.created_at);
    delete pkg.created_at;

    var updated_at = new Date(pkg.updated_at);
    t.ok(typeof (pkg.updated_at) === 'string' && !isNaN(updated_at),
        'pkg.updated_at is a date string: ' + pkg.updated_at);
    delete pkg.updated_at;
}

function searchAndCheckPkgs(t, query, testFilter) {
    client.get(query, function (err, req, res, pkgs) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(Array.isArray(pkgs));

        var expectedPkgs = packages.filter(testFilter);
        pkgs.forEach(function (p) { checkAndStripDateFields(t, p); });
        t.equal(+res.headers['x-resource-count'], expectedPkgs.length);
        t.deepEqual(pkgs.sort(orderPkgs), expectedPkgs.sort(orderPkgs));

        t.end();
    });
}

function checkPkg1(t) {
    client.get('/packages/' + packages[0].uuid, function (err, req, res, pkg) {
        t.ifError(err);
        t.equal(res.statusCode, 200);

        checkAndStripDateFields(t, pkg);
        t.deepEqual(packages[0], pkg);

        t.end();
    });
}

function uuid() {
    return libuuid.create();
}

function orderPkgs(a, b) {
    if (a.uuid < b.uuid)
        return 1;
    return -1;
}

function pkgName(suffix) {
    return pkgNamePrefix + suffix;
}
