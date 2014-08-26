/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Validations run on each package.
 */

var util = require('util');
var sprintf = util.format;

var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

///--- Validation helpers

function validUUID(uuid) {
    return UUID_RE.test(uuid);
}



function validNumber(attr, min, max) {
    if (!min)
        min = 0;

    // hack that works because required attrs have already been checked present
    if (attr === undefined)
        return true;

    var number = Number(attr);

    if (max) {
        return (number >= min && number <= max);
    } else {
        return (number >= min);
    }
}



function describeErr(field, code, message, errors) {
    var description = {
        field: field,
        code: code,
        message: message
    };

    errors.push(description);
}



var MIN_RAM = 64;
var MIN_SWAP = 128;
var MIN_DISK = 1024;
var MIN_CPUCAP = 20;
var MIN_LWPS = 250;
var MIN_VCPUS = 1;

var MAX_ZFSIO = 1000;
var MAX_VCPUS = 32;



/*
 * Check that attributes on a package object are of the correct type. Return an
 * array of error messages.
 *
 * TODO: this is hardcoded, instead of obeying the schema in config.json.
 */

function validate(pkg, schema) {
    var errors = [];

    var missing = function (field, message) {
        describeErr(field, 'Missing', message, errors);
    };

    var invalid = function (field, message) {
        describeErr(field, 'Invalid', message, errors);
    };

    // check types match up with what's in the schema
    Object.keys(schema).sort().forEach(function (name) {
        var val  = pkg[name];
        var info = schema[name];
        var actualType = typeof (pkg[name]);

        if (info.required) {
            if (actualType === 'undefined')
                return missing(name, 'is missing');

            if (actualType === 'string' && val.length === 0)
                return missing(name, 'is empty');
        }

        if (actualType === 'undefined')
            return null;

        var expectedType = info.type;

        if (expectedType === 'string' && actualType !== 'string') {
            invalid(name, 'must be string');

        } else if (expectedType === 'uuid' && !validUUID(val)) {
            invalid(name, 'must be UUID');

        } else if (expectedType === 'number' && actualType !== 'number') {
            invalid(name, 'must be integer');

        } else if (expectedType === 'double' && actualType !== 'number') {
            invalid(name, 'must be float');

        } else if (expectedType === '[string]') {
            if (!Array.isArray(val)) {
                invalid(name, 'must be an array');

            } else {
                var nonStrings = val.filter(function (i) {
                    return typeof (i) !== 'string';
                });

                if (nonStrings.length > 0)
                    invalid(name, 'must only contain strings');
            }

        } else if (expectedType === '[uuid]') {
            if (!Array.isArray(val)) {
                invalid(name, 'must be an array');

            } else {
                var nonUUIDs = val.filter(function (i) {
                    return !validUUID(i);
                });

                if (nonUUIDs.length > 0)
                    invalid(name, 'must only contain UUIDs');
            }

        } else if (expectedType === 'object' &&
                   (actualType !== 'object' || Array.isArray(val))) {
            invalid(name, 'must be a hash');
        }

        return null;  // keep jslint happy
    });

    // check there aren't any unrecognised entries (something not in the schema)
    // in the package
    Object.keys(pkg).sort().forEach(function (name) {
        if (!schema[name])
            invalid(name, 'is not a supported attribute');
    });

    // hardcoded checks

    if (!validNumber(pkg.max_physical_memory, MIN_RAM)) {
        invalid('max_physical_memory',
                'must be greater or equal to ' + MIN_RAM);
    }

    if (!validNumber(pkg.max_swap, MIN_SWAP))
        invalid('max_swap', 'must be greater or equal to ' + MIN_SWAP);

    if (parseInt(pkg.max_swap, 10) < parseInt(pkg.max_physical_memory, 10))
        invalid('max_swap', 'cannot be less than max_physical_memory');

    if (!validNumber(pkg.quota, MIN_DISK))
        invalid('quota', 'must be greater or equal to ' + MIN_DISK);

    if (pkg.quota && pkg.quota % 1024 !== 0)
        invalid('quota', 'must be a multiple of 1024');

    if (!validNumber(pkg.cpu_cap, MIN_CPUCAP))
        invalid('cpu_cap', 'must be greater or equal to ' + MIN_CPUCAP);

    if (!validNumber(pkg.max_lwps, MIN_LWPS))
        invalid('max_lwps', 'must be greater or equal to ' + MIN_LWPS);

    if (!validNumber(pkg.zfs_io_priority, 0, MAX_ZFSIO)) {
        invalid('zfs_io_priority', 'must be greater or equal to 0, and ' +
                'less than ' + MAX_ZFSIO);
    }

    if (!validNumber(pkg.vcpus, MIN_VCPUS, MAX_VCPUS)) {
        invalid('vcpus', 'must be greater or equal to ' + MIN_VCPUS +
                ', and less or equal to ' + MAX_VCPUS);
    }

    if (errors.length)
        return errors;

    return null;
}



module.exports = {
    validate: validate,
    describeErr: describeErr
};
