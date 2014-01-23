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

var packages = [ {
    uuid: '27543bf3-0c66-4f61-9ae4-7dda5cb4741b',
    name: 'api_test_128',
    version: '1.0.0',
    urn: 'sdc:27543bf3-0c66-4f61-9ae4-7dda5cb4741b:api_test_128:1.0.0',
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
    billing_tag: 'ApiTest128MiB'
}, {
    uuid: '43cedda8-f844-4a62-956a-85691fa21b36'
}, {
    uuid: '9cfe7e8b-d1c8-40a5-8e20-214d43f95124'
} ];



var server, client, backend, startTime;



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

        t.ok(client);

        startTime = +new Date();

        t.end();
    });
});



test('Clean up stale state (before)', cleanUp);
test('Check no stale packages (before)', checkNoPkgs);



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
    client.post('/packages', packages[0], function (err, req, res, pkg) {
        t.ifError(err);
        t.equal(res.statusCode, 201);

        checkDate(t, pkg);
        t.equivalent(packages[0], pkg);

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
        t.equal(err.body.message,
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

        t.equal(err.body.code, 'InvalidArgument');
        t.equal(err.body.message,
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
    client.post('/packages', packages[0], function (err, req, res, pkg) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        var expected = {
            code: 'ConflictError',
            message: 'A package with the given UUID already exists'
        };

        t.equivalent(err.body, expected);
        t.end();
    });
});



test('GET /packages/:uuid (OK)', checkPkg1);



test('GET /packages/:uuid (404)', function (t) {
    var badUuid = uuid();

    client.get('/packages/' + badUuid, function (err, req, res, pkg) {
        t.equal(res.statusCode, 404);

        var expected = {
            code: 'ResourceNotFound',
            message: 'Package ' + badUuid + ' does not exist'
        };

        t.equivalent(err.body, expected);
        t.end();
    });
});



test('GET /packages (Search by owner_uuid)', function (t) {
    var query = '/packages?owner_uuid=' + config.ufds_admin_uuid;

    client.get(query, function (err, req, res, pkgs) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(res.headers['x-resource-count']);
        t.ok(Array.isArray(pkgs));

        pkgs.forEach(function (p) {
            t.ok(typeof (p.owner_uuids) === 'undefined' ||
                p.owner_uuids[0] === config.ufds_admin_uuid);
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





test('GET /packages (Search by name)', function (t) {
    var query = '/packages?name=api_test_128';

    var testFilter = function (p) {
        return p.name === 'api_test_128';
    };

    searchAndCheckPkgs(t, query, testFilter);
});



test('GET /packages (Search by multiple fields)', function (t) {
    var query = '/packages?name=api_test_128&owner_uuid=' + uuid();

    var testFilter = function (p) {
        return p.name === 'api_test_128' && !p.owner_uuids;
    };

    searchAndCheckPkgs(t, query, testFilter);
});



test('GET /packages (Custom filter)', function (t) {
    var filter = '(&(name=api_test*)(max_physical_memory>=64)' +
                 '(zfs_io_priority=1))';
    var query = '/packages?filter=' + qs.escape(filter);

    var testFilter = function (p) {
        return /^api/.test(p.name) &&
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

        t.equivalent(err.body, expected);
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

    client.put('/packages/' + packages[0].uuid, immutable,
        function (err, req, res, pkg) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        t.equal(err.body.code, 'ConflictError');
        t.equal(err.body.message,
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



test('GET /packages/:uuid (OK after failed PUT)', checkPkg1);



test('PUT /packages/:uuid (validation failed)', function (t) {
    client.put('/packages/' + packages[0].uuid, {
        owner_uuids: ['this-is-not-a-valid-uuid']
    }, function (err, req, res, pkg) {
        t.ok(err);
        t.equal(res.statusCode, 409);

        t.equal(err.body.code, 'InvalidArgument');
        t.equal(err.body.message,
                /* BEGIN JSSTYLED */
                "'owner_uuids': '[\"this-is-not-a-valid-uuid\"]' is invalid " +
                "(contains non-UUID items)");
                /* END JSSTYLED */
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
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(pkg);
        t.equivalent(pkg.owner_uuids, ownerUuids);

        client.get(url, function (err2, req2, res2, pkg2) {
            t.ifError(err2);
            t.equivalent(pkg2.owner_uuids, ownerUuids);
            t.end();
        });
    });
});



test('PUT /packages/:uuid (OK)', function (t) {
    var url = '/packages/' + packages[0].uuid;
    var ownerUuids = [config.ufds_admin_uuid];

    client.put(url, {
        owner_uuids: ownerUuids
    }, function (err, req, res, pkg) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(pkg);
        checkDate(t, pkg);
        t.equivalent(pkg.owner_uuids, ownerUuids);

        client.get(url, function (err2, req2, res2, pkg2) {
            t.ifError(err2);
            t.equivalent(pkg2.owner_uuids, ownerUuids);

//            client.put(url, {
//                ownerUuids: null
//            }, function (err, req, res, pkg) {
//                t.equivalent(pkg.owner_uuids, null);
                t.end();
//            });
        });
    });
});



test('PUT /packages/:uuid (404)', function (t) {
    var badUuid = uuid();

    client.put('/packages/' + badUuid, {}, function (err, req, res, pkg) {
        t.ok(err);
        t.equal(res.statusCode, 404);

        var expected = {
            code: 'ResourceNotFound',
            message: 'Package ' + badUuid + ' does not exist'
        };

        t.equivalent(err.body, expected);
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

        t.equivalent(err.body, expected);
        t.end();
    });
});



//test('GET /packages/:uuid (OK after failed DELETE)', checkPkg1);



test('DELETE /packages/:uuid (404)', function (t) {
    var badUuid = uuid();

    client.del('/packages/' + badUuid, function (err, req, res) {
        t.ok(err);
        t.equal(res.statusCode, 404);

        var expected = {
            code: 'ResourceNotFound',
            message: 'Package ' + badUuid + ' does not exist'
        };

        t.equivalent(err.body, expected);
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
    var deletePkgs = packages.map(function (p) { return p.uuid; });

    var deletePkg = function () {
        var pkgUuid = deletePkgs.pop();
        var url = '/packages/' + pkgUuid + '?force=true';

        client.del(url, function (err, req, res, obj) {
            if (err && err.statusCode !== 404)
                t.ifError(err);

            if (deletePkgs.length > 0)
                return deletePkg();

            return t.end();
        });
    };

    deletePkg();
}



function checkNoPkgs(t) {
    var checkPkgs = packages.map(function (p) { return p.uuid; });

    var checkPkg = function () {
        var pkgUuid = checkPkgs.pop();
        var url = '/packages/' + pkgUuid;

        client.get(url, function (err, req, res, obj) {
            t.equal(err.statusCode, 404);

            if (checkPkgs.length > 0)
                return checkPkg();

            return t.end();
        });
    };

    checkPkg();
}



function checkDate(t, pkg) {
    var allowedDelta = 5000;

    var created = +new Date(pkg.created_at);
    var updated = +new Date(pkg.updated_at);

    t.ok(created - startTime < allowedDelta);
    t.ok(updated - startTime < allowedDelta);

    delete pkg.created_at;
    delete pkg.updated_at;
}



function searchAndCheckPkgs(t, query, testFilter) {
    client.get(query, function (err, req, res, pkgs) {
        t.ifError(err);

        t.equal(res.statusCode, 200);
        t.ok(Array.isArray(pkgs));

        var expectedPkgs = packages.filter(testFilter);

        pkgs.forEach(function (p) { checkDate(t, p); });
        t.equal(+res.headers['x-resource-count'], expectedPkgs.length);
        t.equivalent(pkgs.sort(orderPkgs), expectedPkgs.sort(orderPkgs));

        t.end();
    });
}



function checkPkg1(t) {
    client.get('/packages/' + packages[0].uuid, function (err, req, res, pkg) {
        t.ifError(err);
        t.equal(res.statusCode, 200);

        checkDate(t, pkg);
        t.equivalent(packages[0], pkg);

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