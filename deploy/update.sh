#!/usr/bin/env bash
# Updates a Desk set up by setup-server.sh, which installs this script as
# desk-update. It backs up your data, builds the new version next to the
# running one, switches over with a restart of a few seconds, and goes back
# on its own if the new version doesn't start.
#
#   sudo desk-update              # the newest release of the version you run (1.x)
#   sudo desk-update 1.1.1        # that release, newer or older
#   sudo desk-update --check      # what's installed and what's out, changing nothing
#   sudo desk-update --rollback   # back to the version before the last update
#
# Your settings (/etc/desk), data (/var/lib/desk), nginx and HTTPS are left
# alone. Run with --help for every option.

set -euo pipefail

# Tests point these at a scratch folder; on a server they're the real paths.
ROOT="${DESK_UPDATE_ROOT:-}"
APP_DIR="$ROOT/opt/desk"
NEXT_DIR="$ROOT/opt/desk.next"
PREV_DIR="$ROOT/opt/desk.prev"
STATE_DIR="$ROOT/var/lib/desk"
CONFIG_DIR="$ROOT/etc/desk"
ENV_FILE="$CONFIG_DIR/env"
SETUP_CONF="$CONFIG_DIR/setup.conf"
BACKUP_DIR="$ROOT/var/backups/desk"
NPM_CACHE="$ROOT/var/cache/desk-npm"
SERVICE_FILE="$ROOT/etc/systemd/system/desk.service"
SELF_BIN="$ROOT/usr/local/bin/desk-update"
LOCK_FILE="$ROOT/run/desk-update.lock"
NODE_ROOT="$ROOT/usr/local/lib/nodejs"
NODE_BIN="$ROOT/usr/bin"
KEEP_BACKUPS=3

ACTION=update
TARGET=""
FORCE=0

usage() {
  cat <<'EOF'
Usage: sudo desk-update [VERSION] [options]

  VERSION        A release such as 1.1.1. Without one: the newest release of
                 the major version you run (a new major version waits for you)
  --check        Show the installed and newest versions, change nothing
  --rollback     Go back to the version before the last update (run it
                 again to undo the rollback)
  --force        Reinstall the version you already run, or move to a new
                 major version without naming it
  -h, --help     Show this help

Before switching it saves your data and settings to /var/backups/desk
(the last 3 are kept). If the new version doesn't answer within 30 seconds
it goes back to the one you had.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) ACTION=check; shift ;;
    --rollback) ACTION=rollback; shift ;;
    --force) FORCE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
    *)
      [ -z "$TARGET" ] || { echo "Name one version." >&2; exit 2; }
      TARGET="${1#v}"; shift ;;
  esac
done

# --- Helpers (the same as setup-server.sh's) ---

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m!   %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31mx   %s\033[0m\n' "$*" >&2; exit 1; }

# Runs a command as the desk user, keeping the environment.
as_desk() {
  setpriv --reuid=desk --regid=desk --init-groups -- \
    env HOME="$APP_DIR" npm_config_cache="$NPM_CACHE" npm_config_update_notifier=false "$@"
}

# True when version $1 is at least version $2 (both like 26.12.1).
version_at_least() {
  local a b i x y
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    x="${a[$i]:-0}"; y="${b[$i]:-0}"
    x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"
    [ "${x:-0}" -gt "${y:-0}" ] && return 0
    [ "${x:-0}" -lt "${y:-0}" ] && return 1
  done
  return 0
}

# The value of KEY in an env file, or nothing.
get_env() {
  [ -f "$2" ] || return 0
  KEY="$1" awk -F= 'BEGIN { k = ENVIRON["KEY"] } $1 == k { sub(/^[^=]*=/, ""); v = $0 } END { if (v != "") print v }' "$2"
}

# The version in a folder's package.json, or nothing.
version_in() {
  [ -f "$1/package.json" ] || return 0
  node -p "require(process.argv[1]).version" "$1/package.json" 2>/dev/null || true
}

# Released versions (from v1.2.3 tags), oldest first.
released_versions() {
  git ls-remote --tags --refs "$REPO" 'v*' 2>/dev/null \
    | sed -n 's#.*refs/tags/v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$#\1#p' \
    | sort -t. -k1,1n -k2,2n -k3,3n
}

# Answers on the port in /etc/desk/env within 30 seconds.
healthy() {
  local _
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/robots.txt"; then return 0; fi
    sleep 1
  done
  return 1
}

restart_with() {
  install -m 644 "$APP_DIR/deploy/desk.service" "$SERVICE_FILE"
  systemctl daemon-reload
  systemctl restart desk
}

# Swaps the running app with the one in $1, so a second swap undoes it.
swap_in() {
  rm -rf "$APP_DIR.swap"
  mv "$APP_DIR" "$APP_DIR.swap"
  mv "$1" "$APP_DIR"
  mv "$APP_DIR.swap" "$2"
}

# Node.js $1 from nodejs.org, checked against its published checksums (as in
# setup-server.sh), when the installed one is older.
ensure_node() {
  local need="$1" have arch name url tmp
  have="$(node -p 'process.versions.node' 2>/dev/null || true)"
  if [ -n "$have" ] && version_at_least "$have" "$need"; then return 0; fi
  step "Node.js $need (you have ${have:-none})"
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "No Node.js build for $(uname -m)." ;;
  esac
  name="node-v$need-linux-$arch"
  url="https://nodejs.org/dist/v$need"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/$name.tar.xz" "$url/$name.tar.xz"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "$url/SHASUMS256.txt"
  (cd "$tmp" && grep " $name.tar.xz\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "The Node.js download didn't match its checksum."
  install -d "$NODE_ROOT"
  rm -rf "${NODE_ROOT:?}/$name"
  tar -xJf "$tmp/$name.tar.xz" -C "$NODE_ROOT"
  rm -rf "$tmp"
  # The running app keeps its own copy loaded until the restart.
  ln -sfn "$NODE_ROOT/$name" "$NODE_ROOT/current"
  for bin in node npm npx; do ln -sf "$NODE_ROOT/current/bin/$bin" "$NODE_BIN/$bin"; done
  have="$(node --version 2>&1)" || die "Node.js was installed but won't start: $have"
  note "Installed $have."
}

# --- Checks ---

[ -n "$ROOT" ] || [ "$(id -u)" = 0 ] || die "Run this as root: sudo desk-update $*"
[ -f "$APP_DIR/package.json" ] || die "No Desk in $APP_DIR. Install it with deploy/setup-server.sh first."
for cmd in git node curl tar; do command -v "$cmd" >/dev/null || die "$cmd is missing; run setup-server.sh again."; done

# One update at a time.
install -d "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || die "Another desk-update is running."

REPO="$(get_env REPO "$SETUP_CONF")"
REPO="${REPO:-https://github.com/modelriver/desk.git}"
PORT="$(get_env PORT "$ENV_FILE")"
PORT="${PORT:-3000}"
DB_PATH="$(get_env DATABASE_PATH "$ENV_FILE")"
DB_PATH="$ROOT${DB_PATH:-/var/lib/desk/desk.db}"
CURRENT="$(version_in "$APP_DIR")"

# --- Rollback ---

if [ "$ACTION" = rollback ]; then
  [ -f "$PREV_DIR/package.json" ] || die "There's no earlier version to go back to (it's kept after an update)."
  PREVIOUS="$(version_in "$PREV_DIR")"
  step "Going back from $CURRENT to $PREVIOUS"
  warn "Data saved by $CURRENT stays. If $CURRENT changed the database, restore its backup from $BACKUP_DIR instead."
  swap_in "$PREV_DIR" "$PREV_DIR"
  restart_with
  healthy || { journalctl -u desk -n 40 --no-pager || true; die "$PREVIOUS didn't answer on 127.0.0.1:$PORT (log above). Run desk-update --rollback again to return to $CURRENT."; }
  note "Desk $PREVIOUS is running. $CURRENT is kept: run desk-update --rollback again to return to it."
  exit 0
fi

# --- Which version ---

VERSIONS="$(released_versions)"
[ -n "$VERSIONS" ] || die "Couldn't list the releases at $REPO. Check this server can reach it."
MAJOR="${CURRENT%%.*}"
LATEST_ANY="$(printf '%s\n' "$VERSIONS" | tail -n 1)"
LATEST_SAME="$(printf '%s\n' "$VERSIONS" | awk -F. -v m="$MAJOR" '$1 == m' | tail -n 1)"

if [ "$ACTION" = check ]; then
  note "Installed: ${CURRENT:-unknown}"
  note "Newest ${MAJOR}.x:  ${LATEST_SAME:-none}"
  [ "$LATEST_ANY" = "$LATEST_SAME" ] || note "Newest:     $LATEST_ANY (a new major version: read its release notes first)"
  if [ -n "$LATEST_SAME" ] && [ "$LATEST_SAME" != "$CURRENT" ]; then note "Update with: sudo desk-update"; fi
  exit 0
fi

if [ -n "$TARGET" ]; then
  printf '%s\n' "$VERSIONS" | grep -qx "$TARGET" || die "There's no release $TARGET. Releases: $(printf '%s\n' "$VERSIONS" | tail -n 5 | paste -sd ' ' -)"
elif [ "$FORCE" = 1 ] && [ "$LATEST_ANY" != "$CURRENT" ]; then
  TARGET="$LATEST_ANY"
else
  TARGET="${LATEST_SAME:-$LATEST_ANY}"
fi

if [ "$TARGET" = "$CURRENT" ] && [ "$FORCE" = 0 ]; then
  note "Desk $CURRENT is the newest ${MAJOR}.x release; nothing to do."
  [ "$LATEST_ANY" = "$CURRENT" ] || note "Desk $LATEST_ANY is out: read its release notes, then run sudo desk-update $LATEST_ANY."
  exit 0
fi

# --- Backup ---

step "Updating Desk ${CURRENT:-?} to $TARGET"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_DIR/desk-${CURRENT:-unknown}-$STAMP.tgz"
install -d -m 700 "$BACKUP_DIR"
SNAP="$(mktemp -d)"
DB_NAME="$(basename "$DB_PATH")"
# A consistent copy of the database while Desk keeps running (it's in WAL
# mode, so the file alone could be mid-write).
if [ -f "$DB_PATH" ]; then
  node -e 'const { DatabaseSync } = require("node:sqlite"); new DatabaseSync(process.argv[1]).prepare("VACUUM INTO ?").run(process.argv[2])' \
    "$DB_PATH" "$SNAP/$DB_NAME" || die "Couldn't copy the database for the backup; nothing was changed."
fi
# Inside: var/lib/desk/ (without the live database), etc/desk/ and the
# database copy at the top, as desk.db. Only that file from the scratch
# folder, never "./": unpacked over / its permissions would land on / itself.
# Restore by unpacking into an empty folder and copying back (deploy/README.md).
STATE_REL="${STATE_DIR#"$ROOT"/}"
DB_COPY=()
[ -f "$SNAP/$DB_NAME" ] && DB_COPY=(-C "$SNAP" "$DB_NAME")
(
  umask 077
  tar -czf "$BACKUP" \
    --exclude="$STATE_REL/$DB_NAME" --exclude="$STATE_REL/$DB_NAME-wal" --exclude="$STATE_REL/$DB_NAME-shm" \
    -C "${ROOT:-/}" "$STATE_REL" "${CONFIG_DIR#"$ROOT"/}" \
    ${DB_COPY[@]+"${DB_COPY[@]}"}
)
rm -rf "$SNAP"
note "Saved your data and settings to $BACKUP."
# The newest few.
ls -1t "$BACKUP_DIR"/desk-*.tgz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do rm -f "$old"; done

# --- Build beside the running app ---

step "Building $TARGET"
rm -rf "$NEXT_DIR"
install -d -o desk -g desk -m 755 "$NEXT_DIR"
cd /
as_desk git -c advice.detachedHead=false clone -q --depth 1 --branch "v$TARGET" "$REPO" "$NEXT_DIR"
NEED_NODE="$(tr -d ' \nv' <"$NEXT_DIR/.nvmrc" 2>/dev/null || true)"
[ -z "$NEED_NODE" ] || ensure_node "$NEED_NODE"
cd "$NEXT_DIR"
as_desk npm ci --ignore-scripts --no-audit --no-fund || die "npm ci failed (see above). Desk ${CURRENT:-} is still running, unchanged."
as_desk npm run check-versions || die "Package check failed (see above). Desk ${CURRENT:-} is still running, unchanged."
as_desk npm run build || die "The build failed (see above). Desk ${CURRENT:-} is still running, unchanged."
cd /

# --- Switch over ---

step "Switching to $TARGET"
rm -rf "$PREV_DIR"
swap_in "$NEXT_DIR" "$PREV_DIR"
restart_with
if ! healthy; then
  journalctl -u desk -n 40 --no-pager || true
  warn "$TARGET didn't answer on 127.0.0.1:$PORT within 30 seconds (log above). Going back to ${CURRENT:-the previous version}."
  swap_in "$PREV_DIR" "$NEXT_DIR"
  restart_with
  healthy || die "${CURRENT:-The previous version} didn't come back either. Check journalctl -u desk; your data backup is $BACKUP."
  die "Desk ${CURRENT:-} is running again. The failed $TARGET build is in $NEXT_DIR."
fi

# This command, from the version now running.
install -m 755 "$APP_DIR/deploy/update.sh" "$SELF_BIN"

step "Done"
note "Desk $TARGET is running (was ${CURRENT:-?})."
note "Backup:    $BACKUP"
note "Go back:   sudo desk-update --rollback"
