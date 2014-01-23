/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Test the Package API endpoints,
 */


var fs      = require('fs');
var path    = require('path');
var qs      = require('querystring');
var restify = require('restify');
var test    = require('tap').test;
var util    = require('util');
var Logger  = require('bunyan');
var libuuid = require('libuuid');

var papi = require('../lib/papi');



var cfgFile = path.resolve(__dirname, '../etc/config.json');
cfgFile = fs.existsSync(cfgFile) ? cfgFile :
               path.resolve(__dirname, '../etc/config.test.json');

var config = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));

var entry = {
    uuid: '27543bf3-0c66-4f61-9ae4-7dda5cb4741b',
    name: 'regular_128',
    version: '1.0.0',
    urn: 'sdc:27543bf3-0c66-4f61-9ae4-7dda5cb4741b:regular_128:1.0.0',
    os: 'smartos',
    max_physical_memory: 128,
    quota: 5120,
    max_swap: 256,
    cpu_cap: 350,
    cpu_burst_ratio: 0.5,
    max_lwps: 2000,
    zfs_io_priority: 1,
    'default': true,
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
    common_name: 'Regular 128MiB',
    fss: 25,
    billing_tag: 'Regular128MiB'
};



var server, client, backend;
var PACKAGE;



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
        overrides: {},
        test: true
    }, function (err, s) {
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

        t.ok(client, 'client ok');
        t.end();
    });
});



test('GET /packages', function (t) {
    client.get('/packages', function (err, req, res, obj) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(res.headers['x-resource-count']);
        t.ok(Array.isArray(obj));
        t.end();
    });
});



test('POST /packages (OK)', function (t) {
    client.post('/packages', entry, function (err, req, res, pkg) {
        t.ifError(err);
        t.equal(res.statusCode, 201);
        t.ok(pkg);
        t.ok(pkg.uuid);
        t.equal(pkg.os, 'smartos');
        t.equal(pkg.vcpus, 1);
        t.equal(pkg.cpu_burst_ratio, 0.5);
        t.equal(pkg.max_swap, 256);
        t.equal(pkg.traits.bool, true);
        t.ok(Array.isArray(pkg.networks));
        t.equal(pkg.networks.length, 2);
        t.equivalent(pkg.traits.arr, ['one', 'two', 'three']);
        t.equal(pkg.traits.str, 'a string');
        t.ok(pkg.created_at);
        t.ok(pkg.updated_at);
        t.equal('string', typeof (pkg.created_at));
        t.ok(pkg.billing_tag);
        PACKAGE = pkg;
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

        t.equal(err.message,
                /* BEGIN JSSTYLED */
                "'active' is missing, 'cpu_cap' is missing, " +
                "'default' is missing, 'max_lwps' is missing, " +
                "'max_physical_memory' is missing, 'max_swap' is missing, " +
                "'name' is missing, 'quota' is missing, " +
                "'version' is missing, 'zfs_io_priority' is missing");
                /* END JSSTYLED */
        t.end();
    });
});



test('POST /packages (fields validation failed)', function (t) {
    var pkg = {
        name: 'regular_128',
        version: '1.0.0',
        os: 2,
        max_physical_memory: 32,
        quota: 512,
        max_swap: 256,
        cpu_cap: 350,
        max_lwps: 2000,
        zfs_io_priority: 10000,
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
        fss: 25
    };

    client.post('/packages', pkg, function (err, req, res, _) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        t.equal(err.message,
                /* BEGIN JSSTYLED */
                "'networks': '[\"aefd7d3c-a4fd-4812-9dd7-24733974d861\"," +
                "\"de749393-836c-42ce-9c7b-\"]' is invalid (contains " +
                "non-UUID items), 'os': '2' is invalid (must be a string), " +
                "'uuid': 'invalid-uuid-for-sure' is invalid (must be a " +
                "UUID), 'max_physical_memory': '32' is invalid (must be " +
                "greater or equal to 64), 'quota': '512' is invalid (must be " +
                "greater or equal to 1024), 'zfs_io_priority': '10000' is " +
                "invalid (must be greater or equal to 0 and less than 1000)");
                /* END JSSTYLED */
        t.end();
    });
});



test('POST /packages (duplicated unique field)', function (t) {
    client.post('/packages', entry, function (err, req, res, pkg) {
        t.ok(err);
        t.equal(res.statusCode, 409);
        t.ok(/already exist/.test(err.message));
        t.end();
    });
});



test('GET /packages/:uuid (OK)', function (t) {
    client.get('/packages/' + PACKAGE.uuid, function (err, req, res, pkg) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(pkg);
        t.equal(pkg.created_at, PACKAGE.created_at);
        t.equal(pkg.updated_at, PACKAGE.updated_at);
        t.equal(pkg.urn, PACKAGE.urn);
        t.ok(pkg.billing_tag);
        t.end();
    });
});



test('GET /packages/:uuid (404)', function (t) {
    client.get('/packages/' + uuid(), function (err, req, res, pkg) {
        t.ok(err);
        t.equal(res.statusCode, 404);
        t.ok(/does not exist/.test(err.message));
        t.end();
    });
});



test('GET /packages (Search by owner_uuid)', function (t) {
    var q = '/packages?owner_uuid=' + config.ufds_admin_uuid;

    client.get(q, function (err, req, res, obj) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(res.headers['x-resource-count']);
        t.ok(Array.isArray(obj));

        obj.forEach(function (p) {
            t.ok(typeof (p.owner_uuids) === 'undefined' ||
                p.owner_uuids[0] === config.ufds_admin_uuid);
        });

        t.end();
    });
});



test('GET /packages (Search by group)', function (t) {
    var q = '/packages?group=ramones';

    client.get(q, function (err, req, res, obj) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(res.headers['x-resource-count']);
        t.ok(Array.isArray(obj));
        t.ok(obj.length);
        t.equal(obj[0].group, 'ramones');
        t.end();
    });
});



test('GET /packages (Search by name)', function (t) {
    var q = '/packages?name=regular_128';

    client.get(q, function (err, req, res, obj) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(res.headers['x-resource-count']);
        t.ok(Array.isArray(obj));
        t.ok(obj.length);
        t.equal(obj[0].max_physical_memory, 128);
        t.end();
    });
});



test('GET /packages (Search by multiple fields)', function (t) {
    var q = '/packages?name=regular_128&owner_uuid=' + uuid();

    client.get(q, function (err, req, res, obj) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(res.headers['x-resource-count']);
        t.ok(Array.isArray(obj));
        t.equal(obj.length, 1);
        t.end();
    });
});



test('GET /packages (Custom filter)', function (t) {
    var query = qs.escape('(&(max_physical_memory>=64)(zfs_io_priority=1))');
    var q = '/packages?filter=' + query;

    client.get(q, function (err, req, res, obj) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(res.headers['x-resource-count']);
        t.ok(Array.isArray(obj));
        t.ok(obj.length);
        t.end();
    });
});



test('GET /packages (Custom invalid filter)', function (t) {
    var query = qs.escape('(&(max_physical_memory>=64)zfs_io_priority=1)');
    var q = '/packages?filter=' + query;

    client.get(q, function (err, req, res, obj) {
        t.equal(res.statusCode, 409, 'status code (409)');
        t.equal(err.message, 'Provided search filter is not valid');
        t.end();
    });
});



test('PUT /packages/:uuid (immutable fields)', function (t) {
    var immutable = {
        'name': 'regular_129',
        'version': '1.0.1',
        'os': 'linux',
        'quota': 5124,
        'max_swap': 257,
        'max_physical_memory': 129,
        'cpu_cap': 351,
        'max_lwps': 1999,
        'zfs_io_priority': 2,
        'vcpus': 4
    };

    client.put('/packages/' + PACKAGE.uuid, immutable,
        function (err, req, res, pkg) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        t.equal(err.message,
                /* BEGIN JSSTYLED */
                "'cpu_cap' is immutable, 'max_lwps' is immutable, " +
                "'max_physical_memory' is immutable, 'max_swap' is immutable, "+
                "'name' is immutable, 'os' is immutable, " +
                "'quota' is immutable, 'vcpus' is immutable, " +
                "'version' is immutable, 'zfs_io_priority' is immutable");
                /* END JSSTYLED */
        t.end();
    });
});



test('PUT /packages/:uuid (validation failed)', function (t) {
    client.put('/packages/' + PACKAGE.uuid, {
        owner_uuids: ['this-is-not-a-valid-uuid']
    }, function (err, req, res, pkg) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        t.equal(err.message,
                /* BEGIN JSSTYLED */
                "'owner_uuids': '[\"this-is-not-a-valid-uuid\"]' is invalid " +
                "(contains non-UUID items)");
                /* END JSSTYLED */
        t.end();
    });
});



test('PUT /packages/:uuid (skip-validation)', function (t) {
    client.put('/packages/' + PACKAGE.uuid, {
        owner_uuids: ['this-is-not-a-valid-uuid'],
        skip_validation: true
    }, function (err, req, res, pkg) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(pkg);
        t.equal(pkg.owner_uuids[0], 'this-is-not-a-valid-uuid');
        t.equal(pkg.owner_uuids.length, 1);
        t.end();
    });
});



test('PUT /packages/:uuid (OK)', function (t) {
    client.put('/packages/' + PACKAGE.uuid, {
        owner_uuids: [config.ufds_admin_uuid]
    }, function (err, req, res, pkg) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(pkg);
        t.ok(pkg.updated_at);
        t.equal('string', typeof (pkg.updated_at));
        t.equal(pkg.created_at, PACKAGE.created_at);
        t.notEqual(pkg.updated_at, PACKAGE.updated_at);
        t.equal(pkg.owner_uuids[0], config.ufds_admin_uuid);
        t.equal(pkg.owner_uuids.length, 1);
        t.end();
    });
});



test('PUT /packages/:uuid (404)', function (t) {
    client.put('/packages/' + uuid(), {}, function (err, req, res, pkg) {
        t.ok(err);
        t.equal(res.statusCode, 404);
        t.ok(/does not exist/.test(err.message));
        t.end();
    });
});



test('DELETE /packages/:uuid (405)', function (t) {
    client.del('/packages/' + PACKAGE.uuid, function (err, req, res) {
        t.ok(err);
        t.equal(res.statusCode, 405);
        t.equal('Packages cannot be deleted', err.message);
        t.end();
    });
});



test('DELETE /packages/:uuid (404)', function (t) {
    client.del('/packages/' + uuid(), function (err, req, res) {
        t.ok(err);
        t.equal(res.statusCode, 404);
        t.ok(/does not exist/.test(err.message));
        t.end();
    });
});



test('DELETE /packages/:uuid (--force)', function (t) {
    client.del('/packages/' + PACKAGE.uuid + '?force=true',
        function (err, req, res) {
        t.ifError(err);
        t.equal(res.statusCode, 204);
        t.end();
    });
});



test('teardown', function (t) {
    client.close();
    server.close(function () {
        backend.quit();
        t.end();

        // hack until I figure out why process is hanging when tests complete
        setTimeout(function () { process.exit(0); }, 200);
    });
});



function uuid() {
    return libuuid.create();
}
