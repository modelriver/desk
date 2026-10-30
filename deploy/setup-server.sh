#!/usr/bin/env bash
# Sets up Desk on a fresh Ubuntu server (22.04 or later): Node.js, a `desk`
# system user, the app in /opt/desk, your data in /var/lib/desk, settings in
# /etc/desk/env, the systemd service, and nginx with a Let's Encrypt
# certificate.
#
#   sudo ./deploy/setup-server.sh --source . --domain support.acme.com --email you@acme.com
#
# Run it again to update: it fetches the app, rebuilds and restarts, and keeps
# your settings, secrets, data and nginx config.
#
# Run with --help for every option.

set -euo pipefail

APP_DIR=/opt/desk
STATE_DIR=/var/lib/desk
DATA_DIR="$STATE_DIR/data"
DB_PATH="$STATE_DIR/desk.db"
CONFIG_DIR=/etc/desk
ENV_FILE="$CONFIG_DIR/env"
NPM_CACHE=/var/cache/desk-npm
NODE_ROOT=/usr/local/lib/nodejs
NGINX_SITE=/etc/nginx/sites-available/desk
NGINX_LIMITS=/etc/nginx/conf.d/desk-limits.conf

DOMAIN="${DESK_DOMAIN:-}"
LE_EMAIL="${LETSENCRYPT_EMAIL:-}"
REPO="${DESK_REPO:-https://github.com/modelriver/desk.git}"
BRANCH="${DESK_BRANCH:-main}"
SOURCE="${DESK_SOURCE:-}"
PORT="${DESK_PORT:-3000}"
NODE_VERSION="${DESK_NODE_VERSION:-}"
WITH_NGINX=1
WITH_TLS=1
SAMPLE_DATA=0
FIREWALL=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: sudo ./deploy/setup-server.sh [options]

Where the app comes from (pick one):
  --source DIR         Copy the app from DIR, e.g. "." from a checkout you
                       uploaded to the server
  --repo URL           Clone from git (default https://github.com/modelriver/desk.git)
  --branch NAME        Branch to clone or update (default main)

The site:
  --domain NAME        Your Desk's address, e.g. support.acme.com. Point its
                       DNS at this server first
  --email ADDRESS      Email for the Let's Encrypt certificate. Passing it
                       means you accept the Let's Encrypt terms of service
  --no-tls             Skip the certificate (HTTPS must then be added in front,
                       or the dashboard sign-in won't work)
  --no-nginx           Skip nginx and the certificate (bring your own proxy)
  --port N             Port Desk listens on, on 127.0.0.1 (default 3000)

Extras:
  --sample-data        Start with the example articles (only into an empty data folder)
  --firewall           Turn on ufw, allowing only SSH (port 22) and HTTP/HTTPS
  --node-version X     Node.js version to install (default: the app's .nvmrc)
  --dry-run            Print what would run, change nothing
  -h, --help           Show this help

Environment variables:
  MODELRIVER_API_KEY   Written to /etc/desk/env on the first run (asked for if unset)
  ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD
                       Create the first admin without prompts
  DESK_DOMAIN, LETSENCRYPT_EMAIL, DESK_REPO, DESK_BRANCH, DESK_SOURCE,
  DESK_PORT, DESK_NODE_VERSION
                       Same as the options above
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="${2:?--source needs a folder}"; shift 2 ;;
    --repo) REPO="${2:?--repo needs a URL}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch needs a name}"; shift 2 ;;
    --domain) DOMAIN="${2:?--domain needs a name}"; shift 2 ;;
    --email) LE_EMAIL="${2:?--email needs an address}"; shift 2 ;;
    --no-tls) WITH_TLS=0; shift ;;
    --no-nginx) WITH_NGINX=0; WITH_TLS=0; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --sample-data) SAMPLE_DATA=1; shift ;;
    --firewall) FIREWALL=1; shift ;;
    --node-version) NODE_VERSION="${2:?--node-version needs a version}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# --- Helpers ---

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m!   %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31mx   %s\033[0m\n' "$*" >&2; exit 1; }

# Runs a command, or only prints it with --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '    $'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

# Runs a command as the desk user, keeping the environment.
as_desk() {
  run setpriv --reuid=desk --regid=desk --init-groups -- \
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

# Sets KEY=VALUE in an env file: replaces the first KEY= line (or a commented
# "# KEY=" line), or appends one. Values are taken literally.
set_env() {
  local file="$3" tmp
  tmp="$(mktemp)"
  KEY="$1" VAL="$2" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"]; done = 0 }
    !done && ($0 ~ "^" k "=" || $0 ~ "^# ?" k "=") { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" >"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

# Only the setup helpers when sourced for tests.
if [ "${DESK_SETUP_TEST:-}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

# --- Checks ---

[ "$DRY_RUN" = 1 ] || [ "$(id -u)" = 0 ] || die "Run this as root: sudo $0 $*"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] || warn "This script is written for Ubuntu; found ${PRETTY_NAME:-unknown}. Continuing."
else
  warn "Can't tell which Linux this is; the script is written for Ubuntu."
fi
command -v apt-get >/dev/null || [ "$DRY_RUN" = 1 ] || die "apt-get not found: this script needs Ubuntu or Debian."
case "$PORT" in *[!0-9]* | '') die "--port must be a number." ;; esac
# The domain goes into the nginx config and the certbot command, so only accept a hostname.
if [ -n "$DOMAIN" ] && ! printf '%s' "$DOMAIN" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$'; then
  die "--domain must be a hostname like support.example.com."
fi
if [ -n "$SOURCE" ]; then
  SOURCE="$(cd "$SOURCE" && pwd)" || die "--source folder not found."
  [ -f "$SOURCE/package.json" ] && [ -f "$SOURCE/server.mjs" ] || die "$SOURCE doesn't look like Desk (no package.json and server.mjs)."
  [ "$SOURCE" != "$APP_DIR" ] || die "--source can't be $APP_DIR itself; upload the app somewhere else first."
fi
if [ "$WITH_TLS" = 1 ] && [ -z "$DOMAIN" ]; then WITH_TLS=0; fi

export DEBIAN_FRONTEND=noninteractive
# Ubuntu's needrestart otherwise stops apt-get with a dialog.
export NEEDRESTART_MODE=a

# --- 1. System packages ---

step "Installing system packages"
# libatomic1: the official Node.js binaries need it, and minimal cloud images
# (Lightsail, for one) leave it out.
PACKAGES="ca-certificates curl git rsync openssl xz-utils util-linux libatomic1"
[ "$WITH_NGINX" = 1 ] && PACKAGES="$PACKAGES nginx"
[ "$WITH_TLS" = 1 ] && PACKAGES="$PACKAGES certbot python3-certbot-nginx"
[ "$FIREWALL" = 1 ] && PACKAGES="$PACKAGES ufw"
run apt-get update -q
# shellcheck disable=SC2086
run apt-get install -y -q --no-install-recommends $PACKAGES

# --- 2. User and folders ---

step "Creating the desk user and folders"
if id desk >/dev/null 2>&1; then
  note "User desk already exists."
else
  run useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin desk
fi
run install -d -o desk -g desk -m 755 "$APP_DIR"
run install -d -o desk -g desk -m 750 "$STATE_DIR" "$DATA_DIR" "$DATA_DIR/public" "$DATA_DIR/private"
run install -d -o desk -g desk -m 750 "$NPM_CACHE"
run install -d -o root -g root -m 755 "$CONFIG_DIR"

# --- 3. The app ---

if [ -n "$SOURCE" ]; then
  step "Copying the app from $SOURCE"
  # Build output, installed packages and local data are made on the server.
  run rsync -a --delete \
    --exclude node_modules --exclude dist --exclude .output --exclude .tanstack \
    --exclude .env --exclude /var --exclude /data --exclude '*.db' --exclude '*.db-*' \
    --exclude .DS_Store \
    "$SOURCE/" "$APP_DIR/"
  run chown -R desk:desk "$APP_DIR"
elif [ -d "$APP_DIR/.git" ]; then
  step "Updating the app from $REPO ($BRANCH)"
  note "Local changes in $APP_DIR are replaced by the branch."
  cd "$APP_DIR" 2>/dev/null || [ "$DRY_RUN" = 1 ]
  as_desk git fetch --depth 1 origin "$BRANCH"
  as_desk git reset --hard FETCH_HEAD
else
  step "Cloning the app from $REPO ($BRANCH)"
  if [ "$DRY_RUN" = 0 ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
    die "$APP_DIR isn't empty and isn't a git checkout. Move it aside, or use --source."
  fi
  cd /
  as_desk git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

# --- 4. Node.js ---

if [ -z "$NODE_VERSION" ]; then
  for nvmrc in "$APP_DIR/.nvmrc" "${SOURCE:-$APP_DIR}/.nvmrc"; do
    [ -f "$nvmrc" ] && NODE_VERSION="$(tr -d ' \nv' <"$nvmrc")" && break
  done
  [ -n "$NODE_VERSION" ] || NODE_VERSION=26.12.1
fi
step "Node.js $NODE_VERSION"
CURRENT_NODE="$(/usr/bin/node -p 'process.versions.node' 2>/dev/null || true)"
if [ -n "$CURRENT_NODE" ] && version_at_least "$CURRENT_NODE" "$NODE_VERSION"; then
  note "Node.js $CURRENT_NODE is already installed."
else
  if dpkg -s nodejs >/dev/null 2>&1; then
    die "Node.js ${CURRENT_NODE:-?} from apt is installed and is older than $NODE_VERSION. Remove it (sudo apt-get remove nodejs) and run this again."
  fi
  case "$(uname -m)" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64 | arm64) NODE_ARCH=arm64 ;;
    *) die "No Node.js build for $(uname -m)." ;;
  esac
  NODE_NAME="node-v$NODE_VERSION-linux-$NODE_ARCH"
  NODE_URL="https://nodejs.org/dist/v$NODE_VERSION"
  if [ "$DRY_RUN" = 1 ]; then
    note "Would download $NODE_URL/$NODE_NAME.tar.xz, check it against SHASUMS256.txt and link it as /usr/bin/node."
  else
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    curl -fsSL -o "$TMP/$NODE_NAME.tar.xz" "$NODE_URL/$NODE_NAME.tar.xz"
    curl -fsSL -o "$TMP/SHASUMS256.txt" "$NODE_URL/SHASUMS256.txt"
    (cd "$TMP" && grep " $NODE_NAME.tar.xz\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "The Node.js download didn't match its checksum."
    install -d "$NODE_ROOT"
    rm -rf "${NODE_ROOT:?}/$NODE_NAME"
    tar -xJf "$TMP/$NODE_NAME.tar.xz" -C "$NODE_ROOT"
    ln -sfn "$NODE_ROOT/$NODE_NAME" "$NODE_ROOT/current"
    for bin in node npm npx; do ln -sf "$NODE_ROOT/current/bin/$bin" "/usr/bin/$bin"; done
    INSTALLED_NODE="$(/usr/bin/node --version 2>&1)" || die "Node.js was installed but won't start: $INSTALLED_NODE"
    note "Installed $INSTALLED_NODE as /usr/bin/node."
  fi
fi

# --- 5. Build ---

step "Installing packages and building"
cd "$APP_DIR" 2>/dev/null || [ "$DRY_RUN" = 1 ] || die "$APP_DIR is missing."
if ! as_desk npm ci --ignore-scripts --no-audit --no-fund; then
  if grep -q '"file:' package.json 2>/dev/null; then
    die "npm ci failed. package.json uses a local file dependency (see .local/), which a git clone doesn't include: copy the app with --source instead."
  fi
  die "npm ci failed (see above)."
fi
as_desk npm run check-versions
as_desk npm run build

# --- 6. Data and settings ---

step "Data folder and settings"
if [ "$SAMPLE_DATA" = 1 ]; then
  if [ -z "$(ls -A "$DATA_DIR/public" 2>/dev/null)" ] && [ -z "$(ls -A "$DATA_DIR/private" 2>/dev/null)" ]; then
    run cp -R "$APP_DIR/examples/data/." "$DATA_DIR/"
    run chown -R desk:desk "$DATA_DIR"
    note "Copied the example articles into $DATA_DIR."
  else
    note "$DATA_DIR already has content; leaving it alone."
  fi
fi
# Your branding, kept next to your data so updates don't replace it.
if [ ! -f "$STATE_DIR/support.config.json" ] && [ -f "$APP_DIR/support.config.json" ]; then
  run install -o desk -g desk -m 640 "$APP_DIR/support.config.json" "$STATE_DIR/support.config.json"
fi

if [ "$WITH_TLS" = 1 ]; then SCHEME=https; else SCHEME=http; fi
if [ -f "$ENV_FILE" ]; then
  note "Keeping $ENV_FILE."
  PORT="$(get_env PORT "$ENV_FILE")"; PORT="${PORT:-3000}"
elif [ "$DRY_RUN" = 1 ]; then
  note "Would create $ENV_FILE from deploy/env.example with new secrets."
else
  API_KEY="${MODELRIVER_API_KEY:-}"
  if [ -z "$API_KEY" ] && [ -t 0 ]; then
    read -rsp "    ModelRiver API key (input hidden, Enter to set later): " API_KEY; echo
  fi
  (
    umask 077
    cp "$APP_DIR/deploy/env.example" "$ENV_FILE"
  )
  set_env NODE_ENV production "$ENV_FILE"
  set_env MODELRIVER_API_KEY "$API_KEY" "$ENV_FILE"
  set_env DATA_DIR "$DATA_DIR" "$ENV_FILE"
  set_env DATABASE_PATH "$DB_PATH" "$ENV_FILE"
  set_env HOST 127.0.0.1 "$ENV_FILE"
  set_env PORT "$PORT" "$ENV_FILE"
  set_env TRUST_PROXY_HOPS 1 "$ENV_FILE"
  [ -f "$STATE_DIR/support.config.json" ] && set_env SUPPORT_CONFIG "$STATE_DIR/support.config.json" "$ENV_FILE"
  [ -n "$DOMAIN" ] && set_env APP_URL "$SCHEME://$DOMAIN" "$ENV_FILE"
  note "Created $ENV_FILE (readable by root only)."
  [ -n "$API_KEY" ] || warn "MODELRIVER_API_KEY is empty: the chat can't answer until you set it in $ENV_FILE."
fi
# Secrets Desk needs, made once and never changed (changing DESK_SECRET_KEY
# would make saved connector keys unreadable).
if [ "$DRY_RUN" = 0 ]; then
  if [ -z "$(get_env DESK_SECRET_KEY "$ENV_FILE")" ]; then
    set_env DESK_SECRET_KEY "$(openssl rand -base64 32)" "$ENV_FILE"
    note "Generated DESK_SECRET_KEY (encrypts connector keys)."
  fi
  if [ -z "$(get_env DESK_IDENTITY_SECRET "$ENV_FILE")" ]; then
    set_env DESK_IDENTITY_SECRET "$(openssl rand -base64 48 | tr -d '\n')" "$ENV_FILE"
    note "Generated DESK_IDENTITY_SECRET (signs identity tokens from your site)."
  fi
  chown root:root "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# --- 7. Service ---

step "Starting the desk service"
run install -m 644 "$APP_DIR/deploy/desk.service" /etc/systemd/system/desk.service
run systemctl daemon-reload
run systemctl enable desk
run systemctl restart desk
if [ "$DRY_RUN" = 0 ]; then
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/robots.txt"; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" = 0 ]; then
    journalctl -u desk -n 40 --no-pager || true
    die "Desk didn't answer on 127.0.0.1:$PORT within 30 seconds (log above)."
  fi
  note "Desk is running on 127.0.0.1:$PORT."
fi

# --- 8. First admin ---

if [ "$DRY_RUN" = 0 ]; then
  ADMINS="$(as_desk node -e '
    try {
      const { DatabaseSync } = require("node:sqlite")
      const db = new DatabaseSync(process.argv[1], { readOnly: true })
      console.log(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = ?").get("admin").n)
    } catch { console.log(0) }' "$DB_PATH" 2>/dev/null || echo 0)"
  if [ "$ADMINS" = 0 ]; then
    if [ -n "${ADMIN_EMAIL:-}" ] || [ -t 0 ]; then
      step "Creating the first admin"
      "$APP_DIR/deploy/create-admin.sh"
    else
      warn "No admin yet. In a terminal, run: sudo $APP_DIR/deploy/create-admin.sh"
    fi
  fi
fi

# --- 9. Firewall (before nginx, so Let's Encrypt can reach port 80) ---

if [ "$FIREWALL" = 1 ]; then
  step "Firewall"
  # sshd -T prints the effective config, including sshd_config.d/ drop-ins, so a
  # port set there is allowed too and enabling the firewall can't lock you out.
  SSH_PORTS="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' | sort -u)"
  if [ -z "$SSH_PORTS" ]; then
    SSH_PORTS="$(cat /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | awk 'tolower($1) == "port" { print $2 }' | sort -u)"
  fi
  for ssh_port in ${SSH_PORTS:-22}; do
    run ufw allow "$ssh_port/tcp"
    note "Allowed SSH on port $ssh_port."
  done
  [ "$WITH_NGINX" = 1 ] && run ufw allow 'Nginx Full'
  run ufw --force enable
fi

# --- 10. nginx and HTTPS ---

if [ "$WITH_NGINX" = 1 ]; then
  step "nginx"
  if [ -f "$NGINX_SITE" ]; then
    note "Keeping $NGINX_SITE (delete it to regenerate)."
  elif [ "$DRY_RUN" = 1 ]; then
    note "Would write $NGINX_SITE proxying ${DOMAIN:-any host} to 127.0.0.1:$PORT, and $NGINX_LIMITS."
  else
    cat >"$NGINX_LIMITS" <<'EOF'
# Per-IP limits for Desk (see Abuse protection in the Desk README).
limit_req_zone $binary_remote_addr zone=desk_req:10m rate=10r/s;
limit_conn_zone $binary_remote_addr zone=desk_conn:10m;
EOF
    if [ -n "$DOMAIN" ]; then
      LISTEN="listen 80;
    listen [::]:80;
    server_name $DOMAIN;"
    else
      LISTEN="listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;"
      rm -f /etc/nginx/sites-enabled/default
    fi
    cat >"$NGINX_SITE" <<EOF
# Desk, written by deploy/setup-server.sh. Certbot adds the HTTPS lines.
# Delete this file and run the script again to regenerate it.
server {
    $LISTEN

    client_max_body_size 2m;
    limit_req zone=desk_req burst=40 nodelay;
    limit_conn desk_conn 50;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}
EOF
    ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/desk
  fi
  run nginx -t
  run systemctl reload nginx

  if [ "$WITH_TLS" = 1 ]; then
    if [ -z "$LE_EMAIL" ]; then
      warn "No --email, so no HTTPS certificate. Desk only signs you in over HTTPS: the dashboard won't work until you add one."
    elif [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
      note "Certificate for $DOMAIN already exists (it renews automatically)."
    elif ! run certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect; then
      warn "Couldn't get a certificate for $DOMAIN. Check its DNS points here and port 80 is open, then run this again. Until then the dashboard sign-in won't work."
    fi
  elif [ -n "$DOMAIN" ]; then
    warn "--no-tls: Desk only signs you in over HTTPS, so terminate HTTPS in front of this server."
  fi
fi

# --- Done ---

step "Done"
if [ -n "$DOMAIN" ]; then
  note "Help center:  $SCHEME://$DOMAIN"
  note "Dashboard:    $SCHEME://$DOMAIN/dashboard"
elif [ "$WITH_NGINX" = 1 ]; then
  note "Desk is behind nginx on this server's address (port 80). Add --domain and --email for HTTPS."
else
  note "Desk listens on 127.0.0.1:$PORT. Point your proxy at it, with HTTPS."
fi
note "Settings:     sudoedit $ENV_FILE, then sudo systemctl restart desk"
note "Your data:    $DATA_DIR (back up all of $STATE_DIR)"
note "Logs:         journalctl -u desk -f"
note "Update:       run this script again with the same options"
note "Also import examples/support_assistant.workflow.json in the ModelRiver console and publish it."
