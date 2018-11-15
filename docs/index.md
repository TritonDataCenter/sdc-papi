---
title: Triton Package API
markdown2extras: tables, code-friendly
apisections: PackageObjects, Packages, Ping, Changelog
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2018, Joyent, Inc.
-->

# Triton Package API

The collections of properties used by Triton internally to create a VM are
called "packages", and are referred to as packages by all the other APIs. For
example, packages can specify the amount of RAM and CPU a new machine will use,
and what the disk quota will be.

Some of the package attributes are used by `vmadm` to create or resize machines.
Please refer to the [vmadm man page](https://github.com/joyent/smartos-live/blob/master/src/vm/man/vmadm.1m.md#properties)
to review the meaning of these properties for the machines.


# Package objects

Package entries are stored in Moray in the form of JSON objects. Here is an
example of a package:


    {
        active: true,
        cpu_cap: 25,
        cpu_shares: 25
        description: "Micro 0.25 GB RAM 0.125 CPUs 16 GB Disk",
        group: "Standard",
        max_lwps: 4000,
        max_physical_memory: 256,
        max_swap: 512,
        name: "g3-standard-0.25-smartos",
        networks: ["1e7bb0e1-25a9-43b6-bb19-f79ae9540b39", "193d6804-256c-4e89-a4cd-46f045959993"],
        quota: 16384,
        uuid: "7fc87f43-2def-4e6f-9f8c-980b0385b36e",
        v: 1,
        version: "1.0.0",
        zfs_io_priority: 100
    }


## Attributes

| Attribute                                           | Required  | Unique | Immutable | Type    | Added In | Explanation                                                                                                |
| --------------------------------------------------- | --------- | ------ | --------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| [active](#package-active)                           | true      |        |           | boolean |          | Whether it can currently be used for provisioning.                                                         |
| [billing_tag](#package-billing_tag)                 |           |        |           | string  |          | Arbitrary tag that can be used by ops for billing purposes; it has no intrinsic meaning to Triton.         |
| [brand](#package-brand)                             |           |        | true      | string  |   v7.1.0 | Force this brand for zones using this package, one of: 'bhyve', 'joyent', 'joyent-minimal', 'kvm', 'lx'    |
| [common_name](#package-common_name)                 |           |        |           | string  |          | Name displayed in the Portal.                                                                              |
| `cpu_burst_ratio`                                   |           |        |           | float   |          | Typically computed value. See below for more.                                                              |
| [cpu_cap](#package-cpu_cap)                         | sometimes |        | true      | integer |          | Cap on how much CPU a machine can use. 100 = one core, 350 = 3.5 cores, etc.                               |
| [default](#package-default)                         |           |        |           | boolean |          | **DEPRECATED** Whether this is the default package of this name through the SDC 6.5 API                    |
| [description](#package-description)                 |           |        |           | string  |          | Human description of this package.                                                                         |
| [fss](#package-fss)                                 |           |        |           | integer |          | CPU shares for a VM. This operates relative to other machines on a CN. (also known as `cpu_shares`)        |
| [group](#package-group)                             |           |        |           | string  |          | Group of associated packages. E.g. High CPU, High Memory, High Storage, High IO or the customer's name.    |
| [max_lwps](#package-max_lwps)                       | true      |        | true      | integer |          | Max number of processes allowed                                                                            |
| [max_physical_memory](#package-max_physical_memory) | true      |        | true      | integer |          | Max RAM in MiB.                                                                                            |
| [max_swap](#package-max_swap)                       | true      |        | true      | integer |          | Max swap in MiB.                                                                                           |
| [min_platform](#package-min_platform)               |           |        |           | hash    |          | Minimum version(s) of OS platforms that this package can use.                                              |
| [name](#package-name)                               | true      |        | true      | string  |          | Name of package in API. See below for details on valid names.                                              |
| [networks](#package-networks)                       |           |        |           | array   |          | UUIDs of networks that the machine requires access to.                                                     |
| [os](#package-os)                                   |           |        | true      | string  |          | Operating system for this package.                                                                         |
| [owner_uuids](#package-owner_uuids)                 |           |        |           | array   |          | UUIDs of package owners.                                                                                   |
| [parent](#package-parent)                           |           |        |           | string  |          | `name` of instance this was cloned from. Useful if package is created from another package for a customer. |
| [quota](#package-quota)                             | true      |        | true      | integer |          | Disk size in MiB. Must be a multiple of 1024.                                                              |
| `ram_ratio`                                         |           |        |           | float   |          | Typically computed value. See below for more.                                                              |
| [traits](#package-traits)                           |           |        |           | hash    |          | Set of traits for provisioning to servers. See DAPI docs for details on traits.                            |
| [uuid](#package-uuid)                               | true      | true   | true      | uuid    |          | Package identifier.                                                                                        |
| [v](#package-v)                                     |           |        |           | integer |          | API version of PAPI.                                                                                       |
| [version](#package-version)                         | true      |        | true      | string  |          | Semver version number.                                                                                     |
| [vcpus](#package-vcpus)                             | sometimes |        | true      | integer |          | Number of cpus to show, between 1 - 64. Required during provisioning if `type` == 'kvm'.                   |
| [zfs_io_priority](#package-zfs_io_priority)         | true      |        | true      | integer |          | ZFS I/O priority. This operates relative to other machines on a CN, determining which get I/O first.       |
| [flexible_disk](#package-flexible_disk)             | sometimes |        |           | boolean |   v7.2.0 | If set to `true` the package's `quota` reflects the amount of space available for all disks                |
| [disks](#package-flexible_disk)                     |           |        |           | hash    |   v7.2.0 | The `size` for each package disk. Allowed when `flexible_disk` = `true`                                    |


## Package: active

If true, this package can be used for provisioning, otherwise not.

    "active": false


## Package: billing_tag

An arbitrary string that can be used by operators for billing purposes. This is
an opaque string, where no special meaning is enforced by SDC.

## Package: brand

Added In: v7.1.0

This optional parameter ties a package to a specific zone brand. The brand is
what's used to determine which type of virtualization to use for the instance.
Most commonly this should be set to one of: 'bhyve' or 'kvm' when a datacenter
supports both types of virtualization and a package is being used for one or the
other.

The value must be one of: 'bhyve', 'joyent', 'joyent-minimal', 'kvm', 'lx'.

    "brand": "kvm"


## Package: common_name

A human-readable name for the package. While [name](#package-name) is also text,
it's not meant for consumption by end-users.

    "common_name": "256MiB standard SmartOS VM"


## Package: cpu_cap

An upper limit on how much CPU a zone can use, as a percent. E.g. 100 = one full
core, 350 = 3.5 cores, and so forth.

    "cpu_cap": 1600

`cpu_cap` is required by default, but can be made optional by setting
`IGNORE_CPU_CAP` in papi's sapi metadata to boolean "true". See more details and
*important warnings* in the "SAPI Configuration" section below.


## Package: default

**DEPRECATED**

Was used for (old) packages requiring SDC6.5 compatibility.


## Package: description

A human-readable long-form description of a package.

    "description": "4GB RAM, 1 CPUs, and 131GB Disk. Required for Img Creation."


## Package: fss

Sets a limit on the number of fair share scheduler (FSS) CPU shares for a VM.
This value is relative, so a value only has meaning in relation to other VMs on
the same CN. If one VM has a value 2048 and one has a value 1024, the VM with
2048 should expect to get more time from the scheduler. The rest of SDC calls
this value `cpu_shares`.

For some more information, see also references to 'cpu-shares' in the [SmartOS
zonecfg(1M) man page.](https://smartos.org/man/1M/zonecfg)

    "fss": 1024


## Package: group

Packages can come in groups sharing many similar attributes. This is an opaque
string, where no special meaning is enforced by SDC, which can be used by ops to
keep track of similar packages.

    "group": "Image Creation"


## Package: max_lwps

The maximum number of threads that a zone is allowed to run concurrently. This
mostly applies to non-KVM zones.

    "max_lwps": 1000


## Package: max_physical_memory

The maximum amount of RAM that a zone may use, in megabytes.

    "max_physical_memory": 512


## Package: max_swap

The maximum amount of swap that a zone may use, in megabytes.

    "max_swap": 1024


## Package: min_platform

A hash which describes the minimum platform version to run this zone on, since
some zones require new features only available on newer platforms. Each key in
the hash is a version of SDC, while the value is a platform version.

    "min_platform": {"7.0": "20130917T001310Z"}


## Package: name

Name displayed through the API.

    "name": "g3-standard-0.25-smartos"

Must match `/^[a-zA-Z0-9]([a-zA-Z0-9\_\-\.]+)?[a-zA-Z0-9]$/` and not have
consecutive `_`, `-` or `.` characters.


## Package: networks

An array of UUIDs listing which networks a zone will be connected to. This isn't
required, but an unconnected VM is typically of no use in a datacenter.

    "networks": ["9ec60129-9034-47b4-b111-3026f9b1a10f", "5983940e-58a5-4543-b732-c689b1fe4c08"]


## Package: os

What operating system this is package for. When a package is used with an image,
their 'os' attributes must exactly match (e.g. a package with os 'linux' will
not work with an image with os 'windows').

If no OS is provided, the package will work with any OS, and thus will work with
an image with any OS specified.

    "os": "linux"


## Package: owner_uuids

An array of UUIDs identifying the specific owners who can use this package. If
there is no array, the package is treated as publicly available, thus anyone can
use this package to provision.

    "owner_uuids": ["ecc73356-f797-4cd2-8f80-514c27031efe", "ac503e10-a979-496d-a54e-0ec9eb2f999f"]


## Package: parent

New packages can be created by copying old packages, but changing a few
attributes. If you need to track from where a package was copied, set the parent
to point to the original package's name or UUID. Note that this is just an
opaque string, and no special meaning is enforced upon it.

    "parent": "g3-standard-4-smartos"


## Package: quota

The maximum amount of disk that a zone may use (barring some overhead), in
megabytes. This is unaffected by [max_swap](#package-max_swap). It must be a
multiple of 1024.

    "quota": 10240


## Package: traits

Free-form traits which are combined with image traits, and then used to match a
CN during VM allocation. See DAPI documentation for more information about how
traits work.

    "traits": {"img_mgmt": true}


## Package: uuid

A unique identifier for this package. When referring to or accessing a specific
package, track this.

    "uuid": "7fc87f43-2def-4e6f-9f8c-980b0385b36e"


## Package: v

The version of the format provided by PAPI. Version numbers change only if there
are backward-breaking changes; a new non-required attribute appearing won't
change the version number, but the removal of an attribute, or a change in the
range of values or their meaning will.

    "v": 1


## Package: vcpus

The number of virtual cpus (not cores!) presented by KVM inside the virtual
machine. This is only required when using KVM; regular zones do not need this.

    "vcpus": 2


## Package: version

Semver version number for a package, usually paired with a
[name](#package-name), e.g. small-1.0.0. There can be several packages with the
same name, but different versions.

    "version": "1.0.1"


## Package: zfs_io_priority

When I/O between different zones on a CN compete for disk, their
`zfs_io_priorities` are compared, and the ones with higher priority get a larger
proportion of disk accesses. The proportions are determined by the relative
differences between this attribute in zones.

    "zfs_io_priority": 50

## Package: flexible_disk

When set to `true` the package's `quota` attribute reflects the amount of
space available for all disks. It only applies when the brand is set to `bhyve`.

Consider the following packages:

**Inflexible package**

        {
          ...,
          "quota": 102400,
          ...,
        }


**Flexible package**

        {
          ...,
          "quota": 102400,
          "flexible_disk": true,
          ...,
        }


The following table outlines the results when used with various images.

| Image size | Inflexible boot disk size | Inflexible data disk size | Flexible boot disk size | Flexible data disk size |
| -----------| ------------------------- | ------------------------- | ----------------------- | ----------------------- |
| 10 GiB     | 10 GiB                    | 100 GiB                   | 10 GiB                  | 90 GiB                  |
| 90 GiB     | 90 GiB                    | 100 GiB                   | 90 GiB                  | 10 GiB                  |
| 1 TiB      | 1 TiB                     | 100 GiB                   | Error                   | Error                   |

### Default disks in package

A flexible disk package may specify the default size for disks through the `disks` property.
These sizes can be overridden by a `disks` attribute when creating a machine.

In this example, any image smaller than 102400 MiB is resized to occupy all of the instance's disk space (102400 MiB).

        {
          ...,
          "quota": 102400,
          "flexible_disk": true,
          "disks": [ { "size": "remaining" } ],
          ...,
        }


In this example, all space not allocated to the image remains free for future disk allocations and snapshots.


        {
          ...,
          "quota": 102400,
          "flexible_disk": true,
          "disks": [ { } ],
          ...,
        }

`disks`'s size property can take either the value `"remaining"` explained before,
or a numeric value of size in MiB. For more details see `flexible_disk_size` in `vmadm` man page.

## Immutable Attributes and Package Persistence

Some package attributes are immutable (see above table). Any attempt to modify
these attributes will result in a `409` HTTP response.

The reason these attributes are immutable is that packages are used as a source
of information about the dimensions of a machine. If certain package attributes
could be altered, it would invalidate packages as a reliable source for billing
information.

If an immutable value in a package needs to be altered, create a new package
with:

- Same [name](#package-name) and newest [version](#package-version) of the
  package we would like to modify.
- Use the altered value(s).
- Mark the new package as [active](#package-active), and set the old package to
  `active: false`

**Packages cannot be deleted** for the same reason, and any attempt to remove a
package will result in a `405` HTTP response.

Once a package has been used as the base specification to create a machine, it
must be available as source of information for billing systems forever.


## Formulas

| Attribute       | Formula                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| cpu_burst_ratio | (CPU_CAP / Burst Ratio) / FSS                                                                                                                                                                                |
| cpu_cap         | vCPU * Bursting Ratio * 100 + (vCPU <= 1 ? 50: 100)                                                                                                                                                          |
| fss             | CPU_CAP                                                                                                                                                                                                      |
| name            | JPC uses this formula to name packages: [version]-[familyname]-[RAM GB]-[type]-[flags], version is currently g3, familyname is group, type is either smartos or kvm, flags is to catch cluster computes (cc) |
| ram_ratio       | RAM GB / ((CPU_CAP / 100) * Bursting Ratio)                                                                                                                                                                  |




# SAPI Configuration

When using the config-agent service in the PAPI zone, which draws metadata from
SAPI, it's possible to change certain default behaviours of PAPI.

In the SAPI application named `sdc`, adding or changing the following keys in
`metadata` will affect PAPI's behaviour. This is useful for testing, or
specialized circumstances in production.

| Key                | Type    | Default | Description                                               |
| ------------------ | ------- | ------- | --------------------------------------------------------- |
| **IGNORE_CPU_CAP** | boolean | false   | Determines whether cpu_cap can be set on packages or not. |

If any of the keys above aren't in the `sdc` `metadata` section, it's treated as
if the default value was specified. Be careful when changing from the default
values in production.

Be careful when setting IGNORE_CPU_CAP to true; it should only be set on fresh
installs of SDC, or elsewhere where you can ensure that VMs provisioned without
cpu_cap will not be mixed with VMs having cpu_cap on the same CN. Mixing VMs
made with cpu_caps, and VMs made without cpu_caps, on the same CN will confuse
SDC's allocator. This is because it treats CNs hosting VMs with no cpu_cap as
having no available CPU for packages that *do* have a cpu_cap.


### Example

    papi_svc=$(sdc-sapi /services?name=papi | json -Ha uuid)
    sdc-sapi /services/$papi_svc -X PUT -d '{ "metadata": { "IGNORE_CPU_CAP": true } }'




# Packages

The Package API's HTTP endpoints let us fetch and modify information about the
packages in an SDC installation. PAPI acts as an HTTP interface to package data
stored in Moray.


## ListPackages (GET /packages)

Returns a list of Packages matching the specified search filter.

### Security Warning

Since PAPI allows wildcard searches, if you want your queries to only search for
literal strings, make sure to escape the '*' character with '{\\2a}'.
E.g. in Javascript:

    val = val.replace(/\*/g,  '{\\2a}');


### Inputs

All inputs are optional. Any attribute described in the
[Package Objects](#Package Objects) section can be used to build a search
filter.

PAPI provides the flexibility to add any arbitrary attributes to packages,
without the need to modify application code. These attributes will not be
indexed, and therefore shouldn't be used to build search filters.

Additional indexed fields can be added to PAPI by modifying the `schema` used by
the application through [SAPI](https://mo.joyent.com/docs/sapi/master/). Note
that adding a new indexed field will not backfill existing package records, so
this operation should be done manually.

Please refer to each setup `/opt/smartdc/papi/etc/config.json` file in order
to verify the fields being indexed, and thus searchable.


### Search filters

PAPI takes advantage of Moray facility to use
[LDAP Search Filters](http://ldapjs.org/filters.html) for object searches. If
you specify any of the aforementioned input attributes, like:

    GET /packages?owner_uuids=907e0dac-f01a-4ded-ac97-7c286fcf1785
    GET /packages?name=sdc_128
    GET /packages?owner_uuids=907e0dac-f01a-4ded-ac97-7c286fcf1785&name=sdc_128

these will be used to build an
[LDAP Equality Filter](http://ldapjs.org/filters.html#equalityfilter):

    (&(owner_uuids=907e0dac-f01a-4ded-ac97-7c286fcf1785))
    (&(name=sdc_128))
    (&(name=sdc_128)(owner_uuids=907e0dac-f01a-4ded-ac97-7c286fcf1785))

PAPI also allows searching for multiple values per attribute. For example, if
you're looking for all packages with the name "sdc_256" and "sdc_1024", then
encode the alternatives into a JSON array and provide that as the argument:

    GET /packages?name=["sdc_256","sdc_1024"]

The above will return any package that has either "sdc_256" or "sdc_1024" as a
name. This can be used to search any attributes with type float, double, number,
string, and boolean.

It is possible to search for matches within arrays. As an example, the networks
attribute can store several values. If you'd like to search for all packages
that use either the 33458263-d400-4a8b-8766-c260affa58f4 or
8582fa4e-8c57-49ce-ace5-3aa96ec0a792 networks, then:

    GET /packages?networks=["33458263-d400-4a8b-8766-c260affa58f4","8582fa4e-8c57-49ce-ace5-3aa96ec0a792"]

Another trick is that PAPI supports wildcards. To search for all packages
starting with the name "sdc_":

    GET /packages?name=sdc_*

And naturally, all of the above features can be combined:

    GET /packages?version=1.0.1&name=sdc_*&networks=["33458263-d400-4a8b-8766-c260affa58f4","8*"]

The one thing that cannot be searched are hashes. E.g. min_platform and traits.

Sometimes all the above simply isn't sufficiently powerful. You can also use any
of the other LDAP search filters by specifying the query string argument
`filter`. In that case, any of the above methods will be ignored, and whatever
you specify as the value of `filter` will be the only filter used to perform the
search.

For example, if you want to search for all the packages with a RAM greater than
or equal to 1 GiB, where the `fss` attribute is present, and with a name
including `sdc_`, the filter would be:

    (&(name=sdc_*)(fss=*)(max_physical_memory>=1024))

and your request:

    GET /packages?filter=(%26(name=sdc_*)(fss=*)(max_physical_memory>=1024))

Note how the '&' character is escaped as '%26', since the query must be URL-
encoded.


### Collection Size Control Inputs

ListPackages also allows controlling the size of the resulting collection with
use of the `sort`, `limit` and `offset` parameters. These three parameters can
be used on either the regular or LDAP filter version of the ListPackages
endpoint.

| Param  | Type    | Description                                     |
| ------ | ------- | ----------------------------------------------- |
| limit  | integer | Return only the given number of packages.       |
| offset | integer | Limit collection starting at the given offset.  |
| order  | string  | Order direction, either `ASC` or `DESC`.        |
| sort   | string  | Sort by any string or number package attribute. |

Note that every ListPackages request will return an `x-resource-count` HTTP
header, with a value equal to the total number of packages matching the given
search options.


### Responses

| Code | Description | Response                 |
| ---- | ----------- | ------------------------ |
| 200  |             | Array of Package objects |


## GetPackage (GET /packages/:uuid)

Returns the package with the specified UUID.

If owner_uuids are provided, the URL will return 404 if the package isn't
allowed to be listed for the given owner_uuids, even if that package UUID
exists. Packages which are allowed to be listed are all package which contain
the given owner_uuids, or no owner_uuids at all (univeral packages).

If providing owner_uuids, be aware that the multi-value trick using JSON arrays
which can be used with ListPackages also applies here.

*Important*: make sure to see the security warning in ListPackages when using
owner_uuids which could have come from adversaries, even indirectly.


### Inputs

| Param       | Type | Description    | Required? |
| ----------- | ---- | -------------- | --------- |
| owner_uuids | UUID | Package Owners |           |
| uuid        | UUID | Package UUID   | true      |


### Responses

| Code | Description       | Response       |
| ---- | ----------------- | -------------- |
| 200  | Package found     | Package object |
| 404  | Package not found | Error object   |


### Example

    GET /packages/00956725-4689-4e2c-9d25-f2172f496f9c


## CreatePackage (POST /packages)

Creates a new package.


### Required Inputs

All attributes listed in the `required` array in the `etc/config.json` schema.
See the first table above for the default required attributes.


### Optional inputs

Remaining attributes defined in the schema, plus any arbitrary attribute
meaningful for the current setup.


### Input validation

There are some attributes whose values must match some restrictions. In order
to get an updated list of these, you can check the
[PAPI validations file](https://mo.joyent.com/papi/blob/master/lib/validations.js).


### Response Codes

| Code | Description         | Response       |
| ---- | ------------------- | -------------- |
| 201  | New Package created | Package object |
| 409  | Missing parameter   | Error object   |
| 409  | Invalid parameter   | Error object   |


## UpdatePackage (PUT /packages/:uuid)

Performs an update operation on a package's mutable attributes.


### UpdatePackage General Inputs

Any attributes not listed as immutable in the `etc/config.json` schema. See the
first table above for the default required attributes.

Some attributes support having no values. To delete an existing value, pass in
'null' as its value.


### UpdatePackage Response Codes

| Code | Description                         | Response       |
| ---- | ----------------------------------- | -------------- |
| 200  | Package updated                     | Package object |
| 404  | Package not found                   | Error object   |
| 409  | Missing parameter                   | Error object   |
| 409  | Invalid parameter                   | Error object   |
| 409  | Will not modify immutable attribute | Error object   |


## DeletePackage (DELETE /package/:uuid)

Do *not* use this endpoint unless you are working in a non-production
environment, or have checked that this will not cause problems with
any callers (e.g. billing, which often depends on a correct record of
packages that were used by any VMs in the past). If you're in a production
environment and are attempting to delete a package that has *ever* been used
by *any* VM, you're asking for trouble and are on your own...

This endpoint will not delete the package unless the param force=true
is explicitly provided.


### Inputs

| Param | Type    | Description               | Required? |
| ------| ------- | ------------------------- | --------- |
| force | Boolean | Whether to allow deletion | false     |


### Responses

| Code | Description       | Response       |
| ---- | ----------------- | -------------- |
| 204  | Package deleted   |                |
| 405  | Request denied    | Error object   |



# Errors

Errors returned from PAPI are in a standard format:

    {
        "code", "...",
        "message", "...",
        "errors": [
            {
                "field": "...",
                "code": "...",
                "message": "..."
            },
            ...
        ]
    }

An error message will always contain a top "code" and "message" attribute.
Sometimes an error message will contain an "errors" attribute, which describes
more specifically what went wrong.

Here are top-level codes you're likely to see:

| Code             | Description                                            |
| ---------------- | ------------------------------------------------------ |
| ConflictError    | Attempt to create a package with an already-used UUID. |
| InvalidArgument  | An attribute failed validation.                        |
| ResourceNotFound | Effectively a 404.                                     |

Here are "errors"-level codes you're likely to see:

| Code    |
| ------- |
| Invalid |
| Missing |

Not much to explain here: the attribute the code is part of was either invalid
or missing.




# Ping (GET /ping)

    GET /ping

When everything appears healthy to PAPI, it should return something like:

    {
      "pid":1004,
      "backend":"up"
    }

If the backend connection or ping attempt isn't okay, it'll return `down`
along with the backend error message:

    {
      "pid":1037,
      "backend":"down",
      "backend_error":"no connection"
    }


