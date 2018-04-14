#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2018, Joyent, Inc.
#

#
# Makefile: basic Makefile for template API service
#
# This Makefile is a template for new repos. It contains only repo-specific
# logic and uses included makefiles to supply common targets (javascriptlint,
# jsstyle, restdown, etc.), which are used by other repos as well. You may well
# need to rewrite most of this file, but you shouldn't need to touch the
# included makefiles.
#
# If you find yourself adding support for new targets that could be useful for
# other projects too, you should add these to the original versions of the
# included Makefiles (in eng.git) so that other teams can use them too.
#
NAME		:= papi
#
# Tools
#
TAP		:= ./node_modules/.bin/tape

#
# Files
#
DOC_FILES	 = index.md
RESTDOWN_FLAGS   = --brand-dir=deps/restdown-brand-remora
EXTRA_DOC_DEPS += deps/restdown-brand-remora/.git
JS_FILES	:= $(shell ls *.js) $(shell find lib test -name '*.js')
JSON_FILES	 = package.json
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
SMF_MANIFESTS_IN = smf/manifests/papi.xml.in

#
# Image Info
#
IMAGE_NAME = $(shell json name < build.json)
IMAGE_PACKAGES = $(shell json -o json-0 packages < build.json | tr -d ']["')
IMAGE_UUID = $(shell json image < build.json)

NODE_PREBUILT_VERSION=v4.6.1
ifeq ($(shell uname -s),SunOS)
        NODE_PREBUILT_TAG=zone
        # Allow building on other than sdc-minimal-multiarch-lts@15.4.1
        NODE_PREBUILT_IMAGE=18b094b0-eb01-11e5-80c1-175dac7ddf02
endif

include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	include ./tools/mk/Makefile.node.defs
endif
include ./tools/mk/Makefile.smf.defs

# Mountain Gorilla-spec'd versioning.


ROOT                    := $(shell pwd)
RELEASE_TARBALL         := $(NAME)-pkg-$(STAMP).tar.bz2
RELSTAGEDIR                  := /tmp/$(STAMP)

#
# Env vars
#
PATH	:= $(NODE_INSTALL)/bin:/opt/local/bin:${PATH}

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(TAP) $(REPO_DEPS) sdc-scripts
	$(NPM) install

$(TAP): | $(NPM_EXEC)
	$(NPM) install

CLEAN_FILES += $(TAP) ./node_modules/tap

.PHONY: release_dir
release_dir: check all docs
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/papi
	@mkdir -p $(RELSTAGEDIR)/site
	@touch $(RELSTAGEDIR)/site/.do-not-delete-me
	@mkdir -p $(RELSTAGEDIR)/root
	cp -r	$(ROOT)/build \
		$(ROOT)/etc \
		$(ROOT)/lib \
		$(ROOT)/server.js \
		$(ROOT)/node_modules \
		$(ROOT)/package.json \
		$(ROOT)/sapi_manifests \
		$(ROOT)/smf \
		$(ROOT)/test \
		$(RELSTAGEDIR)/root/opt/smartdc/papi/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -R $(ROOT)/deps/sdc-scripts/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cp -R $(ROOT)/boot/* $(RELSTAGEDIR)/root/opt/smartdc/boot/

.PHONY: image
image: release_dir
	#
	# This sucks.
	#
	# I want to be able to add:
	#
	#    "amon": "joyent/sdc-amon",
	#    "config-agent": "joyent/sdc-config-agent",
	#    "registrar": "joyent/registrar",
	#
	# to the package.json and then just make some symlinks, but this doesn't
	# work because:
	#
	#  * each of these components ships their own node
	#  * dtrace-provider
	#  * ELIFECYCLE
	#  * libuuid
	#  * amon includes *everything*
	#  * the Manta dir/file naming makes this really hard
	#
	# So for now, we just download a blob for this prototype. The next step is
	# probably to move up to a tool to install this bloatware based on a file,
	# then it can know about TRY_BRANCH too.
	#
	# I'd call that tool probably like:
	#
	#  whatever/bin/bloat --bit amon-agent --branch <master-latest|master-xxx|release-xxx> --dir $(RELSTAGEDIR)
	#
	# And then it would know how to find the appropriate bit, download it and
	# unpack it under $(RELSTAGEDIR).
	#
	# Until someone writes that, we've got this mess...
	#
	curl -o /tmp/amon-agent.tgz https://us-east.manta.joyent.com/Joyent_Dev/public/builds/amon/master-20180319T194304Z/amon/amon-agent-master-20180319T194304Z-gcb3a4e3.tgz
	(cd $(RELSTAGEDIR)/root/opt; tar -zxvf /tmp/amon-agent.tgz && rm /tmp/amon-agent.tgz)
	curl -o /tmp/config-agent.tbz2 https://us-east.manta.joyent.com/Joyent_Dev/public/builds/config-agent/master-20180404T030741Z/config-agent/config-agent-pkg-master-20180404T030741Z-g1575b94.tar.bz2
	(cd $(RELSTAGEDIR)/root/opt/smartdc; tar -jxvf /tmp/config-agent.tbz2 && rm /tmp/config-agent.tbz2)
	curl -o /tmp/registrar.tbz2 https://us-east.manta.joyent.com/Joyent_Dev/public/builds/registrar/master-20180223T204731Z/registrar/registrar-pkg-master-20180223T204731Z-g462748a.tar.bz2
	(cd $(RELSTAGEDIR); tar -jxvf /tmp/registrar.tbz2 && rm /tmp/registrar.tbz2)
	$(ROOT)/node_modules/buildymcbuildface/bin/build \
	    -i $(IMAGE_UUID) \
	    -d $(RELSTAGEDIR)/root \
	    -p $(IMAGE_PACKAGES) \
	    -m '{"name": "$(IMAGE_NAME)", "version": "$(STAMP)"}'

.PHONY: release
release: release_dir
	(cd $(RELSTAGEDIR) && $(TAR) -jcf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)

.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
	  echo "error: 'BITS_DIR' must be set for 'publish' target"; \
	  exit 1; \
	fi
	mkdir -p $(BITS_DIR)/$(NAME)
	cp $(ROOT)/$(RELEASE_TARBALL) $(BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)

.PHONY: test
test: $(TAP)
	TAP=1 $(TAP) test/*.test.js

include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
else
	include ./tools/mk/Makefile.node.targ
endif
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ

sdc-scripts: deps/sdc-scripts/.git
