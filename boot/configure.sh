#!/usr/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# Copyright (c) 2013 Joyent Inc., All rights reserved.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

role=papi

$(/opt/local/bin/gsed -i"" -e "s/@@PREFIX@@/\/opt\/smartdc\/papi/g" /opt/smartdc/$role/smf/manifests/$role.xml)

echo "Importing SMF Manifests"
$(/usr/sbin/svccfg import /opt/smartdc/$role/smf/manifests/$role.xml)

exit 0
