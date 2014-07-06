/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * Test the importer.
 */



var fs      = require('fs');
var Logger  = require('bunyan');
var path    = require('path');
var restify = require('restify');
var spawn   = require('child_process').spawn;
var test    = require('tap').test;
var papi    = require('../lib/papi');



var DEFAULT_CFG_PATH = path.resolve(__dirname, '../etc/config.json');
var TEST_LDIF_PATH   = path.resolve(__dirname, 'importer.test.ldif');
var TEST_JSON_PATH   = path.resolve(__dirname, 'importer.test.json');
var IMPORTER_PATH    = path.resolve(__dirname, '../bin/importer');



var server, client, backend, cfgPath, startTime;



test('setup', function (t) {
    cfgPath = fs.existsSync(DEFAULT_CFG_PATH) ? DEFAULT_CFG_PATH :
              path.resolve(__dirname, '../etc/config.test.json');

    var config = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));

    var logger = new Logger({
        level: process.env.LOG_LEVEL || 'info',
        name: 'sdc-package-importer-test',
        stream: process.stdout,
        serializers: restify.bunyan.serializers
    });

    papi.createServer({
        config: cfgPath,
        log: logger,
        overrides: {},
        test: true
    }, function (err, s) {
        t.ok(s, 'server ok');
        t.ok(s.backend, 'server backend ok');
        server = s;
        backend = s.backend;

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

test('Run importer with ldif', importLdif);
test('GET /packages/b65b8ce2-29e7-4f63-b529-357f42bf0742', checkPkg1);
test('GET /packages/b8c43025-cfd9-446d-a871-4444c15d9648', checkPkg2);
test('GET /packages/487997df-a4da-4fd3-bcfc-98f100178241', checkPkg3);

test('Mutate b8c43025-cfd9-446d-a871-4444c15d9648', mutatePkg2);
test('GET /packages/b8c43025-cfd9-446d-a871-4444c15d9648', checkMutatedPkg2);
test('Run importer with ldif', importLdif);
test('GET /packages/b8c43025-cfd9-446d-a871-4444c15d9648', checkMutatedPkg2);
test('Run importer with overwrite', importLdifOverwrite);
test('GET /packages/b8c43025-cfd9-446d-a871-4444c15d9648', checkPkg2);

test('Clean up stale state (after ldif)', cleanUp);
test('Check no stale packages (after ldif)', checkNoPkgs);

test('Run importer with json', importJson);
test('GET /packages/b65b8ce2-29e7-4f63-b529-357f42bf0742', checkPkg1);
test('GET /packages/b8c43025-cfd9-446d-a871-4444c15d9648', checkPkg2);
test('GET /packages/487997df-a4da-4fd3-bcfc-98f100178241', checkPkg3);

test('Clean up stale state (after json)', cleanUp);
test('Check no stale packages (after json)', checkNoPkgs);

test('Run importer with dryrun', importLdifDryrun);
test('Check no stale packages (after dryrun)', checkNoPkgs);



test('teardown', function (t) {
    t.end();

    // hack until I figure out why process is hanging when tests complete
    setTimeout(function () { process.exit(0); }, 200);
});



function importLdif(t) {
    var importer = spawn(IMPORTER_PATH, ['--config=' + cfgPath,
                                         '--ldif=' + TEST_LDIF_PATH]);

//    importer.stdout.on('data', function (data) {
//        console.log('stdout: ' + data);
//    });
//
//    importer.stderr.on('data', function (data) {
//        console.log('stderr: ' + data);
//    });

    importer.on('close', function (code) {
        t.end();
    });
}



function importLdifDryrun(t) {
    var importer = spawn(IMPORTER_PATH, ['--config=' + cfgPath,
                                         '--ldif=' + TEST_LDIF_PATH,
                                         '--dryrun']);
    importer.on('close', function (code) {
        t.end();
    });
}



function importLdifOverwrite(t) {
    var importer = spawn(IMPORTER_PATH, ['--config=' + cfgPath,
                                         '--ldif=' + TEST_LDIF_PATH,
                                         '--overwrite']);
    importer.on('close', function (code) {
        t.end();
    });
}



function importJson(t) {
    var importer = spawn(IMPORTER_PATH, ['--config=' + cfgPath,
                                         '--json=' + TEST_JSON_PATH]);

    importer.on('close', function (code) {
        t.end();
    });
}



function mutatePkg2(t) {
    var change = { max_physical_memory: 16384, max_swap: 32768 };

    client.put('/packages/b8c43025-cfd9-446d-a871-4444c15d9648?force=true',
               change, function (err, req, res, obj) {
        t.ifError(err, 'POST /packages error');
        t.equal(res.statusCode, 200);
        t.end();
    });
}



function cleanUp(t) {
    var deletePkgs = ['b65b8ce2-29e7-4f63-b529-357f42bf0742',
                      'b8c43025-cfd9-446d-a871-4444c15d9648',
                      '487997df-a4da-4fd3-bcfc-98f100178241'];

    var deletePkg = function () {
        var uuid = deletePkgs.pop();
        var url = '/packages/' + uuid + '?force=true';

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
    var checkPkgs = ['b65b8ce2-29e7-4f63-b529-357f42bf0742',
                     'b8c43025-cfd9-446d-a871-4444c15d9648',
                     '487997df-a4da-4fd3-bcfc-98f100178241'];

    var checkPkg = function () {
        var uuid = checkPkgs.pop();
        var url = '/packages/' + uuid;

        client.get(url, function (err, req, res, obj) {
            t.equal(err.statusCode, 404);

            if (checkPkgs.length > 0)
                return checkPkg();

            return t.end();
        });
    };

    checkPkg();
}




function checkMutatedPkg2(t) {
    client.get('/packages/b8c43025-cfd9-446d-a871-4444c15d9648',
               function (err, req, res, obj) {
        t.ifError(err);
        t.equal(res.statusCode, 200);

        checkDate(t, obj);

        var expectedResults = {
            v: 1,
            active: false,
            cpu_cap: 300,
            default: true,
            max_lwps: 2000,
            max_physical_memory: 16384,
            max_swap: 32768,
            name: 'test-2',
            quota: 81920,
            uuid: 'b8c43025-cfd9-446d-a871-4444c15d9648',
            version: '1.0.1',
            zfs_io_priority: 50
        };

        t.equivalent(obj, expectedResults);

        t.end();
    });
}



function checkPkg1(t) {
    client.get('/packages/b65b8ce2-29e7-4f63-b529-357f42bf0742',
               function (err, req, res, obj) {
        t.ifError(err);
        t.equal(res.statusCode, 200);

        checkDate(t, obj);

        var expectedResults = {
            v: 1,
            active: true,
            common_name: 'Test 1',
            cpu_burst_ratio: 0.5,
            cpu_cap: 200,
            default: false,
            description: '4GB RAM, 1 CPUs and bursting, and 131GB Disk.',
            fss: 200,
            group: 'Test',
            max_lwps: 4000,
            max_physical_memory: 4096,
            max_swap: 8192,
            min_platform: { '7.0': '20130917T001310Z' },
            name: 'test-1',
            networks: [ '9ec60129-9034-47b4-b111-3026f9b1a10f',
                        '5983940e-58a5-4543-b732-c689b1fe4c08' ],
            os: 'smartos',
            owner_uuids: [ '7b315468-c6be-46dc-b99b-9c1f59224693',
                           '1d09a48c-d1ee-42b0-a22f-0baf42daac2b',
                           '67e48d3a-35e7-40a3-beee-55a1e4588500',
                           'ec473ba8-0d5a-4000-9fc9-20b43397ac7d' ],
            parent: 'g3-standard-4-smartos',
            quota: 134144,
            ram_ratio: 3.990024938,
            traits: { ssd: true, img_mgmt: true },
            uuid: 'b65b8ce2-29e7-4f63-b529-357f42bf0742',
            vcpus: 2,
            version: '1.0.0',
            zfs_io_priority: 100
        };

        t.equivalent(obj, expectedResults);

        t.end();
    });
}



function checkPkg2(t) {
    client.get('/packages/b8c43025-cfd9-446d-a871-4444c15d9648',
               function (err, req, res, obj) {
        t.ifError(err);
        t.equal(res.statusCode, 200);

        checkDate(t, obj);

        var expectedResults = {
            v: 1,
            active: false,
            cpu_cap: 300,
            default: true,
            max_lwps: 2000,
            max_physical_memory: 2048,
            max_swap: 4096,
            name: 'test-2',
            quota: 81920,
            uuid: 'b8c43025-cfd9-446d-a871-4444c15d9648',
            version: '1.0.1',
            zfs_io_priority: 50
        };

        t.equivalent(obj, expectedResults);

        t.end();
    });
}



/*
 * This package is missing a required attribute (active), so shouldn't have
 * been imported.
 */

function checkPkg3(t) {
    client.get('/packages/487997df-a4da-4fd3-bcfc-98f100178241',
               function (err, req, res, obj) {
        t.equal(res.statusCode, 404);
        t.end();
    });
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
