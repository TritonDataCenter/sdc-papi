#!/usr/bin/bash
#
# Copyright (c) 2013, Joyent, Inc. All rights reserved.
#
# Script to add "papi" zone to existing SDC 7 setups
# You can either add latest available image at updates-imgadm or
# specify an image uuid/version as follows:
#
#   ./add-papi-zone.sh d7a36bca-4fdd-466f-9086-a2a22447c257 papi-zfs-master-20130711T073353Z-g7dcddeb
export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace
set -o errexit
# set -o pipefail

role=papi

# Step 1: Check we do have all the required files copied into
# /usbkey/extras/$role. Required files are:
#
#   bashrc
#   configure
#   configure.common
#   setup
#   setup.common
#   zoneconfig

if [[ ! -d /usbkey/extra/$role ]]; then
  echo "Directory '/usbkey/extra/$role' does not exist. Please, create it before continue"
  exit 1
fi

if [[ ! -e /usbkey/extra/$role/bashrc ]]; then
  echo "Missing '/usbkey/extra/papi/$role' file. You can copy it from any other zone"
  exit 1
fi

if [[ ! -e /usbkey/extra/$role/configure.common ]]; then
  echo "Missing '/usbkey/extra/$role/configure.common' file. You can copy it from any other zone"
  exit 1
fi

if [[ ! -e /usbkey/extra/$role/setup.common ]]; then
  echo "Missing '/usbkey/extra/$role/setup.common' file. You can copy it from any other zone"
  exit 1
fi

if [[ ! -e /usbkey/extra/$role/configure ]]; then
  echo "Missing '/usbkey/extra/$role/configure' file. You can copy it from usb-headnode.git repo"
  exit 1
fi

if [[ ! -e /usbkey/extra/$role/setup ]]; then
  echo "Missing '/usbkey/extra/$role/setup' file. You can copy it from usb-headnode.git repo"
  exit 1
fi

if [[ ! -e /usbkey/extra/$role/zoneconfig ]]; then
  echo "Missing '/usbkey/extra/$role/zoneconfig' file. You can copy it from usb-headnode.git repo"
  exit 1
fi

# Get SDC Application UUID from SAPI
SDC_APP_UUID=$(sdc-sapi --no-headers /applications?name=sdc|json 0.uuid)

NEW_IMAGE=$1
NEW_VERSION=$2

if [[ ! -n $NEW_IMAGE ]]; then
  echo "getting image details from updates-imgadm"
  # Get latest image details from updates-imgadm
  ary=($(updates-imgadm list name=$role -o uuid,name,version | tail -1))
  NEW_IMAGE=${ary[0]}
  NEW_VERSION="${ary[1]}-zfs-${ary[2]}"
else
  echo "Using the provided IMAGE UUID and VERSION"
fi

# Grab image manifest and file from updates-imgadm:
MANIFEST_TMP="$NEW_VERSION.imgmanifest.tmp"
MANIFEST="$NEW_VERSION.imgmanifest"
 
IMG_FILE="$NEW_VERSION.gz"
ADMIN_UUID=$(sdc-sapi --no-headers /applications?name=sdc | json -Ha metadata.ufds_admin_uuid)

cd /var/tmp

IS_IMAGE_IMPORTED=$(sdc-imgadm list -o uuid|grep $NEW_IMAGE)
if [[ -n "$IS_IMAGE_IMPORTED" ]]; then
  echo "Image is already imported, moving into next step"
else
  # Get the original manifest
  if [[ ! -e /var/tmp/$MANIFEST_TMP ]]; then
    echo "Fetching image manifest"
    updates-imgadm get "$NEW_IMAGE" > "$MANIFEST_TMP"
    # Replace the default admin uuid with the one at our setup
    sed -e "s/00000000-0000-0000-0000-000000000000/$ADMIN_UUID/" $MANIFEST_TMP > "$MANIFEST"
  else
    echo "Image Manifest already downloaded, moving into next step"
  fi

  if [[ ! -e /var/tmp/$IMG_FILE ]]; then
    # Get the new image file:
    updates-imgadm get-file $NEW_IMAGE > $IMG_FILE
  else
    echo "Image file already downloaded, moving into next step"
  fi

  echo "Importing image"
  # Import the new image
  sdc-imgadm import -m $MANIFEST -f $IMG_FILE
fi


# Before attempting to create the service, let's double check it doesn't exist:
SERVICE_UUID=$(sdc-sapi --no-headers /services?name=$role | json -Ha uuid)

if [[ -n "$SERVICE_UUID" ]]; then
  echo "Service $role already exists, moving into next step"
else
  echo "Service $role does not exist. Attempting to create it"
  SERVICE_UUID=$(sdc-sapi --no-headers /services -X POST -d "{
  \"application_uuid\": \"$SDC_APP_UUID\",
    \"name\": \"papi\",
    \"params\": {
        \"cpu_cap\": 300,
        \"max_lwps\": 1000,
        \"max_physical_memory\": 1024,
        \"max_swap\": 2048,
        \"quota\": 25,
        \"billing_id\": \"00000000-0000-0000-0000-000000000000\",
        \"vcpus\": 1,
        \"zfs_io_priority\": 10,
        \"package_name\": \"sdc_1024\",
        \"package_version\": \"1.0.0\",
        \"image_uuid\": \"$NEW_IMAGE\",
    \"networks\": [ \"admin\" ],
        \"tags\": {
            \"smartdc_role\": \"papi\",
            \"smartdc_type\": \"core\"
        }
    },
    \"metadata\": {
        \"SERVICE_NAME\": \"papi\",
        \"SERVICE_IS_FIRST_BOOT\": true
    },
    \"manifests\": {
    }
  }" | jsob -Ha uuid)
  echo "Service UUID is '$SERVICE_UUID'"
fi

# Same for instance. Check if already exists from a previous attempt or create:
a=($(sdc-sapi --no-headers /instances | json -Ha uuid params.alias | grep "$role"))
INSTANCE_ID=${a[0]}
if [[ -n "$INSTANCE_ID" ]]; then
  echo "Service $role instance already exists, moving into next step"
else
  echo "Attempting to create $role instance"
  INSTANCE_ID=$(sdc-sapi --no-headers /instances -X POST -d "{
      \"service_uuid\": \"$SERVICE_UUID\",
      \"params\": { \"alias\" : \"papi0\" }
  }")
fi


# And, finally, lookup service image_uuid and, eventually, update to the one
# we used:
SERVICE_IMAGE=$(sdc-sapi --no-headers /services?name=papi | json -Ha params.image_uuid)

if [ "$SERVICE_IMAGE" != "$NEW_IMAGE" ]; then
  echo "Updating service image"
  sapiadm update $SERVICE_UUID params.image_uuid="$NEW_IMAGE"
else
  echo "Service image already up2date."
fi

echo "Done!"
exit 0
