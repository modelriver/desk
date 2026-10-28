#!/bin/sh
# Prepares the /data volume, then starts Desk (or runs the given command).
# - Creates the articles folders on the first start.
# - DESK_SAMPLE_DATA=true copies the example articles into an empty data folder.
# - Keeps support.config.json (your branding, and any logo next to it) on the
#   volume, so rebuilding the image doesn't replace it.
set -eu

mkdir -p "$DATA_DIR/public" "$DATA_DIR/private"

if [ "${DESK_SAMPLE_DATA:-}" = true ] && [ -z "$(ls -A "$DATA_DIR/public")" ] && [ -z "$(ls -A "$DATA_DIR/private")" ]; then
  cp -R /app/examples/data/. "$DATA_DIR/"
  echo "desk: copied the example articles into $DATA_DIR"
fi

if [ -z "${SUPPORT_CONFIG:-}" ]; then
  [ -f /data/support.config.json ] || cp /app/support.config.json /data/support.config.json
  export SUPPORT_CONFIG=/data/support.config.json
fi

exec "$@"
