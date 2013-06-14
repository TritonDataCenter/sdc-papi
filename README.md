# Packages API

Repository: <git@git.joyent.com:papi.git>
Browsing: <https://mo.joyent.com/papi>
Who: Pedro P. Candel
Docs: <https://mo.joyent.com/docs/papi>
Tickets/bugs: <https://devhub.joyent.com/jira/browse/PAPI>


# Overview

This is the repo for SDC 7 Packages API, an HTTP interface to
SDC Packages. See [docs](https://mo.joyent.com/docs/papi) for the details

Start with the guidelines: <https://mo.joyent.com/docs/papi>

# Development

To run the Packages API server:

    git clone git@git.joyent.com:papi.git
    cd papi
    git submodule update --init
    make all
    ./build/node/bin/node server.js | ./node_modules/.bin/bunyan

To update the docs, edit "docs/index.restdown" and run `make docs`
to update "docs/index.html".

Before commiting/pushing run `make prepush` and, if possible, get a code
review.



# Testing

    make test

If you project has setup steps necessary for testing, then describe those
here.


# PENDING

- Import packages from LDAP

- Figure out how to add a new zone with SAPI

- CMD line tool "sdc-packages"
- node-sdc-clients PAPI client.
- Docs.
