# Deploying

## One command (fresh Ubuntu server)

`setup-server.sh` sets up Desk on Ubuntu 22.04 or later: Node.js (the version in `.nvmrc`, checked against nodejs.org's checksums), a `desk` system user, the systemd service, nginx with per-IP limits, and a Let's Encrypt certificate.

1. Point your domain's DNS (an `A` record, and `AAAA` for IPv6) at the server.
2. Copy Desk to the server and run the script from it:

```bash
rsync -a --exclude node_modules --exclude dist --exclude /var --exclude .env ./ you@server:desk/
ssh you@server
cd desk
sudo ./deploy/setup-server.sh --source . \
  --domain support.acme.com --email you@acme.com
```

`--email` is for the certificate; passing it accepts the [Let's Encrypt terms](https://letsencrypt.org/repository/). The script asks for your ModelRiver API key without showing it on screen. You can pass `MODELRIVER_API_KEY` in the environment instead, but a key typed on the command line stays in your shell history. In a terminal, the script then asks for the first admin's email, name and password (or set `ADMIN_EMAIL`, `ADMIN_NAME` and `ADMIN_PASSWORD`).

Or skip the copy and let the script clone the repository: leave out `--source` (and pass `--repo`/`--branch` for a fork).

| Where | What |
| --- | --- |
| `/opt/desk` | The app (replaced on every update) |
| `/var/lib/desk` | Your data: `data/` (articles and notes), `desk.db`, `support.config.json`. Back this up |
| `/etc/desk/env` | Settings and secrets, root-only. The script fills in the paths and makes `DESK_SECRET_KEY` and `DESK_IDENTITY_SECRET` |
| `/etc/nginx/sites-available/desk` | The proxy config. Written once; certbot adds HTTPS to it |

Options: `--sample-data` starts with the example articles, `--firewall` turns on ufw (SSH, HTTP and HTTPS only), `--no-tls` or `--no-nginx` if you terminate HTTPS elsewhere, `--port`, `--node-version`, and `--dry-run` to see every command first. `--help` lists them all.

**Updating.** The script installs `desk-update` (from `deploy/update.sh`):

```bash
sudo desk-update --check      # what's installed, and what's out
sudo desk-update              # the newest release of the major version you run
sudo desk-update 1.1.1        # a given release, newer or older
sudo desk-update --rollback   # back to the version before the last update
```

It saves `/var/lib/desk` and `/etc/desk` to `/var/backups/desk` first (with a consistent copy of the database; the last 3 are kept), builds the new release in `/opt/desk.next` while the current one keeps running, then switches over and restarts, a few seconds of downtime. If the new version doesn't answer within 30 seconds it switches back on its own. A new major version waits until you name it. Settings, data, nginx and HTTPS aren't touched. Releases come from the repository you installed from (`--repo`, saved in `/etc/desk/setup.conf`).

To restore a backup: `sudo tar -xzf /var/backups/desk/FILE.tgz -C /`, then move the `desk.db` copy at the top of the archive to `/var/lib/desk/desk.db` (with Desk stopped).

Running the setup script again also still works, with the same options: it fetches the app, rebuilds in place, restarts, and keeps `/etc/desk/env`, your data and the nginx config. To regenerate the nginx config, delete `/etc/nginx/sites-available/desk` first. An install from before `desk-update` gets it by running the script once more.

**After setup**

- Import `examples/support_assistant.workflow.json` in the ModelRiver console and publish it Live.
- Change settings with `sudoedit /etc/desk/env`, then `sudo systemctl restart desk`. Never change `DESK_SECRET_KEY`: connector keys saved on the Integrations page can't be read without it.
- Another admin, or a lost password or phone: `sudo /opt/desk/deploy/create-admin.sh`.
- Logs: `journalctl -u desk -f`.

**HTTPS is required.** Desk sets its sign-in cookies as secure in production, so the dashboard only works over HTTPS. If the certificate step fails (usually DNS not pointing at the server yet, or port 80 closed by your provider's firewall), fix that and run the script again.

**Small servers.** Building needs about 1 GB of memory. On a 1 GB VPS, add swap first (`sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`).

## Docker

`docker-compose.yml` runs the published image, `ghcr.io/modelriver/desk` (amd64 and arm64), with [Caddy](https://caddyserver.com) in front, which gets and renews the HTTPS certificate on its own. Node.js, SQLite and Caddy all come in the containers; the server only needs Docker with Compose 2.23 or newer. Docker's own service takes a little memory on top of Desk; on a very small server (512 MB), the systemd setup below is the better fit.

1. Point your domain's DNS at the server and open ports 80 and 443.
2. In an empty folder on the server (its name becomes part of the volume names):

```bash
curl -fsSLO https://raw.githubusercontent.com/modelriver/desk/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/modelriver/desk/main/deploy/docker/env.example -o .env
# Set DESK_DOMAIN, APP_URL and MODELRIVER_API_KEY in .env, then fill in the secrets:
sed -i "s|^DESK_SECRET_KEY=.*|DESK_SECRET_KEY=$(openssl rand -base64 32)|" .env
sed -i "s|^DESK_IDENTITY_SECRET=.*|DESK_IDENTITY_SECRET=$(openssl rand -base64 48 | tr -d '\n')|" .env
docker compose up -d
docker compose exec desk node scripts/create-admin.ts
```

Make the secrets once: never change `DESK_SECRET_KEY` afterwards, or connector keys saved on the Integrations page can't be read.

| What | Where |
| --- | --- |
| Settings | `.env` next to `docker-compose.yml` (kept out of git and the image). Desk reads all of it; Caddy is only given `DESK_DOMAIN` |
| Your data | The `desk-data` volume: `data/` (articles and notes), `desk.db` and `support.config.json`. Back it up. Its full name starts with your project folder's name (`docker volume ls`); for a folder named `desk`: `docker run --rm -v desk_desk-data:/data -v "$PWD":/backup alpine tar czf /backup/desk-data.tgz -C /data .` |
| Branding | `support.config.json` on the volume, with any logo next to it (copied there on the first start). Copy it out with `docker compose cp desk:/data/support.config.json .`, edit it, copy it back with `docker compose cp support.config.json desk:/data/`, then `docker compose restart desk` |
| Certificates | The `caddy-data` volume |

- **Updating:** `docker compose pull && docker compose up -d`. Settings, data and certificates stay. The `1` image tag follows every 1.x release; set `DESK_VERSION=1.0.0` in `.env` to stay on one.
- **Your own changes:** from a copy of the code, add the override that builds it instead of pulling: `docker compose -f docker-compose.yml -f docker-compose.source.yml up -d --build`.
- **Sample articles:** set `DESK_SAMPLE_DATA=true` in `.env` before the first start.
- **Logs:** `docker compose logs -f desk`.
- **Your own proxy instead of Caddy:** remove the `caddy` service, give `desk` `ports: ["127.0.0.1:3000:3000"]`, and keep `TRUST_PROXY_HOPS=1` if exactly one proxy is in front.
- **One container only.** Rate limits live in memory and the database is one file, so don't scale `desk` beyond one.
- **Your own `.env`.** In a checkout you also develop in, `.env` holds your development settings; run Docker from a separate folder.
- **Releases:** pushing a version tag that matches `package.json` (`git tag v1.0.1 && git push origin v1.0.1`) publishes the image; see `.github/workflows/docker.yml`.

## Hosting platforms

Any platform that runs a Docker image with a persistent disk can run Desk: one instance, the disk mounted at `/data`, port 3000. The platform handles HTTPS. Configs for three of them are in this repo.

Desk needs a disk that survives restarts, since everything it keeps is in `/data`. Platforms without one don't fit as they are: Cloudflare Containers (the disk is reset when a container sleeps), Vercel and other serverless functions. Running there would mean moving the database to a hosted one and the in-memory parts (search index, rate limits, timers) to shared services.

After the first deploy on any platform: import `examples/support_assistant.workflow.json` in the ModelRiver console, create the first admin (below), and set `APP_URL` to the address you use (it's for links in emails and the sitemap).

### Fly.io

[`fly.toml`](../fly.toml) runs one machine with a 1 GB volume. With [flyctl](https://fly.io/docs/flyctl/install/) signed in, in an empty folder:

```bash
curl -fsSLO https://raw.githubusercontent.com/modelriver/desk/main/fly.toml
fly launch --copy-config --no-deploy --name your-desk
fly secrets set MODELRIVER_API_KEY=... \
  DESK_SECRET_KEY="$(openssl rand -base64 32)" \
  DESK_IDENTITY_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
fly deploy --ha=false
fly ssh console --pty -C "desk-entrypoint node /app/scripts/create-admin.ts"
```

It's at `https://your-desk.fly.dev`; add your own domain with `fly certs add`. `--ha=false` keeps it to one machine, which Desk needs. Set `APP_URL` with `fly secrets set APP_URL=https://...`.

### Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/modelriver/desk)

The button reads [`render.yaml`](../render.yaml): a web service from the published image with a 1 GB disk. It asks for your ModelRiver API key and makes the two secrets. A disk needs a paid instance type (Starter or above). Create the first admin from the service's **Shell** tab:

```bash
desk-entrypoint node /app/scripts/create-admin.ts
```

Add `APP_URL` under **Environment** once you know the address.

### Railway

1. **New → Docker Image**, `ghcr.io/modelriver/desk:1`.
2. Add a volume mounted at `/data`.
3. Variables: `MODELRIVER_API_KEY`, `DESK_SECRET_KEY` (`openssl rand -base64 32`), `DESK_IDENTITY_SECRET` (`openssl rand -base64 48`), `CLIENT_IP_HEADER=x-real-ip`, and `RAILWAY_RUN_UID=0`. Railway mounts volumes owned by root; with that variable Desk starts as root, takes over `/data`, and runs as an unprivileged user.
4. Under **Networking**, generate a domain, or add your own, on port 3000.
5. Create the first admin from the service's SSH console with `desk-entrypoint node /app/scripts/create-admin.ts`.

### Updating

Updates never touch your data. Database changes run on their own when the new version starts. Back up `/data` before a big jump; going back to an older version after one isn't supported.

| Where | Update now | Automatically |
| --- | --- | --- |
| Docker Compose | `docker compose pull && docker compose up -d` | A cron entry, e.g. weekly: `0 4 * * 1 cd /path/to/desk && docker compose pull -q && docker compose up -d` |
| Fly.io | `fly deploy` (pulls the newest image for the tag in `fly.toml`) | A scheduled job that runs `fly deploy`, e.g. a GitHub Action with a `FLY_API_TOKEN` |
| Render | **Manual Deploy → Deploy latest reference** | Call the service's deploy hook URL (Settings) from a scheduled job |
| Railway | **Redeploy** | **Settings → Image Auto Updates**: patches or minor versions, in a window you choose (e.g. weekends) |
| systemd | `sudo desk-update` | A root cron entry, e.g. weekly: `0 4 * * 1 /usr/local/bin/desk-update` |

The `1` tag moves to every 1.x release; a new major version (2.x) never arrives on its own. To stay on one exact version, use its full tag (`1.0.0`) instead.

## By hand (systemd)

The script does these steps; follow them yourself on another distribution.

```bash
# 1. User and folders
sudo useradd --system --home /opt/desk --shell /usr/sbin/nologin desk
sudo mkdir -p /opt/desk /var/lib/desk/data/{public,private} /etc/desk
sudo chown -R desk: /opt/desk /var/lib/desk

# 2. App (Node.js 26.12.1+ must be installed as /usr/bin/node)
sudo -u desk git clone https://github.com/modelriver/desk.git /opt/desk
cd /opt/desk && sudo -u desk sh -c 'npm ci && npm run build'

# 3. Config (secrets stay on the server)
sudo cp deploy/env.example /etc/desk/env && sudo chmod 600 /etc/desk/env
sudoedit /etc/desk/env

# 4. First admin
sudo /opt/desk/deploy/create-admin.sh

# 5. Service
sudo cp deploy/desk.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now desk
```

Put nginx or Caddy in front for TLS and proxy to `127.0.0.1:3000`. Set `TRUST_PROXY_HOPS` to the number of proxies in front of the app (1 for nginx alone) so rate limits see real client IPs. See "Abuse protection" in the main README for Cloudflare and nginx settings.

To update: `git pull && npm ci && npm run build && sudo systemctl restart desk`.

Keep your data folder in its own repository if you like, but never commit the env file: it holds your API key and secrets.
