#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Supported package attributes have changed over time, and some attributes
 * are no longer used. This migration goes through every package, strips off
 * attributes which aren't listed in etc/config.json, and updates modified
 * packages back to Moray.
 */

var assert = require('assert');
var bunyan = require('bunyan');
var fs = require('fs');
var moray = require('moray');
var path = require('path');
var vasync = require('vasync');


//---- globals


var CONFIG_PATH = path.resolve(__dirname, '..', '..', 'etc', 'config.json');
var CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH));
var BUCKET = CONFIG.bucket;
var SCHEMA = CONFIG.schema;
var CLIENT = null;  // set in `main`


//---- functions


function getMorayClient(opts, cb) {
    opts.log = bunyan.createLogger({
        name: 'moray',
        level: 'INFO',
        stream: process.stdout,
        serializers: bunyan.stdSerializers
    });

    var client = moray.createClient(opts);
    console.log('Connecting...');

    client.once('error', function (err) {
        assert.ifError(err);
    });

    client.once('connect', function () {
        cb(null, client);
    });
}


function morayFind(bucket, filter, cb) {
    var hits = [];
    var opts = { limit: null };
    var req = CLIENT.findObjects(bucket, filter, opts);

    req.once('error', function (err) {
        assert.ifError(err);
    });

    req.on('record', function (object) {
        hits.push(object);
    });

    req.once('end', function () {
        cb(null, hits);
    });
}


function updatePackage(obj, cb) {
    var id = obj.key;
    var pkg = obj.value;
    var etag = obj._etag;

    var deleteAttrs = Object.keys(pkg).filter(function (key) {
        if (key[0] === '_')
            key = key.slice(1);

        return !SCHEMA[key];
    });

    if (deleteAttrs.length === 0) {
        console.log('Package %s needs no modifications', id);
        return cb();
    }

    deleteAttrs.forEach(function (key) {
        delete pkg[key];
    });

    console.log('Package %s will have following attributes removed: %s',
        id, deleteAttrs.sort().join(', '));

    var opts = { etag: etag };

    return CLIENT.putObject(BUCKET, id, pkg, opts, function (err) {
        assert.ifError(err);
        console.log('Package updated');
        cb();
    });
}


function updatePackages(cb) {
    console.log('Finding objects...');

    morayFind(BUCKET, '(uuid=*)', function (err, objs) {
        assert.ifError(err);

        console.log('%s objects found', objs.length);

        vasync.forEachPipeline({
            inputs: objs,
            func: updatePackage
        }, cb);
    });
}


//---- main


function main() {
    getMorayClient(CONFIG.moray, function (err, client) {
        assert.ifError(err);

        CLIENT = client;

        updatePackages(function (err2) {
            assert.ifError(err2);
            console.log('Done');
            process.exit(0);
        });
    });
}

if (require.main === module) {
    main();
}
