#!/usr/bin/env bash
# Creates the first admin on a server set up with deploy/setup-server.sh, or
# resets an admin's password and two-factor. Prompts for the details, or reads
# ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD.
#
#   sudo /opt/desk/deploy/create-admin.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run this as root: sudo $0" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. /etc/desk/env
set +a
cd /opt/desk
exec setpriv --reuid=desk --regid=desk --init-groups -- env HOME=/opt/desk node scripts/create-admin.ts
