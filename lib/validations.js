/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
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

    Object.keys(schema).sort().forEach(function (name) {
        var val  = pkg[name];
        var info = schema[name];
        var actualType = typeof (pkg[name]);

        if (info.required && actualType === 'undefined') {
            errors.push('\'' + name + '\' is missing');
            return;
        }

        if (actualType === 'undefined')
            return;

        var expectedType = info.type;

        if (expectedType === 'string' && actualType !== 'string') {
            errors.push('\'' + name + '\': \'' + val + '\' is invalid ' +
                        '(must be a string)');

        } else if (expectedType === 'number' && actualType !== 'number') {
            errors.push('\'' + name + '\': \'' + val + '\' is invalid ' +
                        '(must be an integer)');

        } else if (expectedType === 'double' && actualType !== 'number') {
            errors.push('\'' + name + '\': \'' + val + '\' is invalid' +
                        '(must be a float)');

        } else if (expectedType === '[string]') {
            if (!Array.isArray(val)) {
                errors.push('\'' + name + '\': \'' + val + '\' is invalid ' +
                            '(must be an array)');

            } else {
                var nonStrings = val.filter(function (i) {
                    return typeof (i) !== 'string';
                });

                if (nonStrings.length > 0) {
                    errors.push('\'' + name + '\': \'' + JSON.stringify(val) +
                                '\' is invalid (contains non-string items)');
                }
            }

        } else if (expectedType === 'object' &&
                   (actualType !== 'object' || Array.isArray(val))) {
            errors.push('\'' + name + '\' is invalid (must be a hash)');
        }
    });

    // hardcoded checks

    var uuid = pkg.uuid;
    if (!validUUID(uuid))
        errors.push('\'uuid\': \'' + uuid + '\' is invalid (must be a UUID)');

    var owners = pkg.owner_uuids;
    if (owners) {
        if (Array.isArray(owners)) {
            var badOwners = owners.filter(function (owner) {
                return !validUUID(owner);
            });
        }

        // if not an array, or has bad owners
        if (!badOwners || badOwners.length > 0) {
            errors.push('\'owner_uuids\': \'' + JSON.stringify(owners) +
                        '\' is invalid (must be an array containing UUIDs)');
        }
    }

    var networks = pkg.networks;
    if (networks) {
        if (Array.isArray(networks)) {
            var badNetworks = networks.filter(function (network) {
                return !validUUID(network);
            });
        }

        // if not an array, or has bad networks
        if (!badNetworks || badNetworks.length > 0) {
            errors.push('\'networks\': \'' + JSON.stringify(networks) +
                        '\' is invalid (must be an array containing UUIDs)');
        }
    }

    if (!validNumber(pkg.max_physical_memory, MIN_RAM)) {
        errors.push('\'max_physical_memory\': \'' + pkg.max_physical_memory +
                    '\' is invalid (must be greater or equal to ' +
                    MIN_RAM + ')');
    }

    if (!validNumber(pkg.max_swap, MIN_SWAP)) {
        errors.push('\'max_swap\': \'' + pkg.max_swap + '\' is invalid ' +
                    '(must be greater or equal to ' + MIN_SWAP + ')');
    }

    if (parseInt(pkg.max_swap, 10) < parseInt(pkg.max_physical_memory, 10)) {
        errors.push('\'max_swap\': \'' + pkg.max_swap +
                        '\' is invalid (cannot be less than ' +
                        'max_physical_memory: ' +
                        pkg.max_physical_memory + ')');
    }

    if (!validNumber(pkg.quota, MIN_DISK)) {
        errors.push('\'quota\': \'' + pkg.quota + '\' is invalid ' +
                    '(must be greater or equal to ' + MIN_DISK + ')');
    }

    if (!validNumber(pkg.cpu_cap, MIN_CPUCAP)) {
        errors.push('\'cpu_cap\': \'' + pkg.cpu_cap + '\' is invalid ' +
                    '(must be greater or equal to ' + MIN_CPUCAP + ')');
    }

    if (!validNumber(pkg.max_lwps, MIN_LWPS)) {
        errors.push('\'max_lwps\': \'' + pkg.max_lwps +
                    '\' is invalid (must be greater or equal to ' +
                    MIN_LWPS + ')');
    }

    if (!validNumber(pkg.zfs_io_priority, 0, MAX_ZFSIO)) {
        errors.push('\'zfs_io_priority\': \'' + pkg.zfs_io_priority +
                    '\' is invalid (must be greater or equal to 0 and less ' +
                    'than ' + MAX_ZFSIO + ')');
    }

    if (pkg.vcpus !== undefined &&
        !validNumber(pkg.vcpus, MIN_VCPUS, MAX_VCPUS)) {

        errors.push('\'vcpus\': \'' + pkg.vcpus + '\' is invalid ' +
                    '(must be greater or equal to ' + MIN_VCPUS +
                    ' and less or equal to ' + MAX_VCPUS + ')');
    }

    if (errors.length)
        return errors.join(', ');

    return null;
}



module.exports = {
    validate: validate
};
