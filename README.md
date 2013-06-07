# Packages API

Repository: <git@git.joyent.com:papi.git>
Browsing: <https://mo.joyent.com/papi>
Who: Pedro P. Candel
Docs: <https://mo.joyent.com/docs/papi>
Tickets/bugs: <https://devhub.joyent.com/jira/browse/PAPI>


# Overview

This repo serves two purposes: (1) It defines the guidelines and best
practices for Joyent engineering work (this is the primary goal), and (2) it
also provides boilerplate for an SDC project repo, giving you a starting
point for many of the suggestion practices defined in the guidelines. This is
especially true for node.js-based REST API projects.

Start with the guidelines: <https://mo.joyent.com/docs/eng>

# Development

To run the boilerplate API server:

    git clone git@git.joyent.com:papi.git
    cd papi
    git submodule update --init
    make all
    ./build/node/bin/node server.js | ./node_modules/.bin/bunyan

To update the guidelines, edit "docs/index.restdown" and run `make docs`
to update "docs/index.html".

Before commiting/pushing run `make prepush` and, if possible, get a code
review.



# Testing

    make test

If you project has setup steps necessary for testing, then describe those
here.


# PENDING

- usb-headnode.git a523809b5a8cc8ad41ceef169837652b9a0bc807
- Import packages from LDAP
- Create sdc_* packages on PAPI bootstrap (1st boot, if needed). Need to populate `etc/bootstrap-packages.json` from zone setup usb-headnode/SAPI
- Figure out how to add a new zone with SAPI
- PAPI must boot side by side with ufds zone. Should I just try to run PAPI service
into ufds zone? => NO, wouldn't be able to upgrade PAPI using images w/o UFDS downtime.
- CMD line tool "sdc-packages"
- node-sdc-clients PAPI client.
- Docs.
- Add pending tests for package searches
