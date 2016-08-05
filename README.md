<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2016, Joyent, Inc.
-->

# sdc-papi

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md) --
*Triton does not use GitHub PRs* -- and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

Packages API is an HTTP interface to packages used for provisioning.

## Testing

Before running tests, consider pointing the config file at a different DB than
`moray`. There is a script, `tools/coal-test-env.sh`, which will create a
`moray_test` DB for you and run an additional `moray-test` instance listening
at port `2222`. Just scping into GZ and executing it should work.

Then make sure your test file points at the right port.

Then, to run the tests, either:

    make test

or, if you prefer some extra STDOUT info, go for the long version:

    ./build/node/bin/node test/*.test.js 2>&1 | bunyan
