# Packages API

Repository: <git@git.joyent.com:papi.git>
Browsing: <https://mo.joyent.com/papi>
Who: Pedro P. Candel
Docs: <https://mo.joyent.com/docs/papi>
Tickets/bugs: <https://devhub.joyent.com/jira/browse/PAPI>


# Overview

This is the repo for the SDC 7 Packages API, an HTTP interface to
packages used for provisioning. See [docs](https://mo.joyent.com/docs/papi) for
the details.


# Development

To run the Packages API server:

    git clone git@git.joyent.com:papi.git
    cd papi
    git submodule update --init
    make all
    ./build/node/bin/node server.js | ./node_modules/.bin/bunyan

To update the docs, edit "docs/index.restdown" and run `make docs` to update
"docs/index.html".

Before commiting/pushing run `make prepush` and, if possible, get a code
review.

# Testing

Before running tests, consider pointing the config file at a different DB than
`moray`. There is a script, `tools/coal-test-env.sh`, which will create a
`moray_test` DB for you and run an additional `moray-test` instance listening
at port `2222`. Just scping into GZ and executing it should work.

Then make sure your test file points at the right port.

Then, to run the tests, either:

    make test

or, if you prefer some extra STDOUT info, go for the long version:

    ./build/node/bin/node test/api.test.js 2>&1 | bunyan


# PENDING

- Add PAPI zone to existing setups (JPC)
- Update CloudAPI, AdminUI and workflows (VMAPI) to use PAPI instead of UFDS
  sdcPackages. Note this means that both CloudAPI and AdminUI can remove the
  local, non-master UFDS from their config files.
- NOTE SOME DOWNTIME IS REQUIRED IN ORDER TO COMPLETE THE FOLLOWING STEPS:
  - Run `./bin/ldap-import` in the aforementioned setups.
  - Deploy the new zones using PAPI instead of UFDS sdcPackages.
