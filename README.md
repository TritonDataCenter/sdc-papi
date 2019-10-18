<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2019 Joyent, Inc.
-->

# sdc-papi

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md)
and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

Packages API is an HTTP interface to packages used for provisioning.

## Testing

Just run `./test/runtests` from within the PAPI VM.

Note that every package needed by the tests cases will be created and removed
by the test suite setup/teardown.

The packages required to test other Triton components, like CloudAPI, can be
created using `sdcadm post-setup dev-sample-data` from Triton's Headnode Global
Zone.
