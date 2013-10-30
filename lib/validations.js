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
    if (!min) {
        min = 0;
    }

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
var MAX_VCPUS = 16;

/*
 * Check that attributes on a package object are of the correct type. Return an
 * array of error messages.
 *
 * TODO: this is hardcoded, instead of obeying the schema in config.json.
 */

function validate(pkg, cb) {
    var errors = [];

    if (!validUUID(pkg.uuid)) {
        errors.push('Package uuid: \'' + pkg.uuid +
                    '\' is invalid (must be a UUID)');
    }

    if (pkg.owner_uuid && !validUUID(pkg.owner_uuid)) {
        errors.push('Package owner_uuid: \'' + pkg.owner_uuid +
                    '\' is invalid (must be a UUID)');
    }

    if (!validNumber(pkg.max_physical_memory, MIN_RAM)) {
        errors.push('RAM: \'' + pkg.max_physical_memory +
                '\' is invalid ' +
                '(must be greater or equal than ' + MIN_RAM + ')');
    }

    if (!validNumber(pkg.max_swap, MIN_SWAP)) {
        errors.push('Swap: \'' + pkg.max_swap + '\' is invalid ' +
                    '(must be greater or equal than ' + MIN_SWAP + ')');
    }

    if (parseInt(pkg.max_swap, 10) <
        parseInt(pkg.max_physical_memory, 10)) {
        errors.push('Swap: \'' + pkg.max_swap +
                        '\' is invalid ' +
                        '(cannot be less than RAM: ' +
                        pkg.max_physical_memory + ')');
    }

    if (!validNumber(pkg.quota, MIN_DISK)) {
        errors.push('Disk: \'' + pkg.quota + '\' is invalid ' +
                    '(must be greater or equal than ' + MIN_DISK + ')');
    }

    if (!validNumber(pkg.cpu_cap, MIN_CPUCAP)) {
        errors.push('CPU Cap: \'' + pkg.cpu_cap + '\' is invalid ' +
                    '(must be greater or equal than ' + MIN_CPUCAP + ')');
    }

    if (!validNumber(pkg.max_lwps, MIN_LWPS)) {
        errors.push('Lightweight Processes: \'' + pkg.max_lwps +
                    '\' is invalid (must be greater or equal than ' +
                    MIN_LWPS + ')');
    }

    if (!validNumber(pkg.zfs_io_priority, 0, MAX_ZFSIO)) {
        errors.push('ZFS IO Priority: \'' + pkg.zfs_io_priority +
                    '\' is invalid (must be greater or equal than 0 and less ' +
                    ' than ' + MAX_ZFSIO + ')');
    }

    if (pkg.vcpus !== undefined &&
        !validNumber(pkg.vcpus, MIN_VCPUS, MAX_VCPUS)) {

        errors.push('Virtual CPUs: \'' + pkg.vcpus + '\' is invalid ' +
                    '(must be greater or equal than ' + MIN_VCPUS +
                    ' and less or equal than ' + MAX_VCPUS + ')');
    }


    if (errors.length) {
        return cb(errors.join(', '));
    }

    return cb();
}



module.exports = {
    validate: validate
};
