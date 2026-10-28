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

Once `@modelriver/client` 1.7.0 is on npm you can skip the copy and let the script clone the repository: leave out `--source` (and pass `--repo`/`--branch` for a fork).

| Where | What |
| --- | --- |
| `/opt/desk` | The app (replaced on every update) |
| `/var/lib/desk` | Your data: `data/` (articles and notes), `desk.db`, `support.config.json`. Back this up |
| `/etc/desk/env` | Settings and secrets, root-only. The script fills in the paths and makes `DESK_SECRET_KEY` and `DESK_IDENTITY_SECRET` |
| `/etc/nginx/sites-available/desk` | The proxy config. Written once; certbot adds HTTPS to it |

Options: `--sample-data` starts with the example articles, `--firewall` turns on ufw (SSH, HTTP and HTTPS only), `--no-tls` or `--no-nginx` if you terminate HTTPS elsewhere, `--port`, `--node-version`, and `--dry-run` to see every command first. `--help` lists them all.

**Updating.** Run the script again with the same options. It fetches the app, rebuilds, restarts, and keeps `/etc/desk/env`, your data and the nginx config. To regenerate the nginx config, delete `/etc/nginx/sites-available/desk` first.

**After setup**

- Import `examples/support_assistant.workflow.json` in the ModelRiver console and publish it Live.
- Change settings with `sudoedit /etc/desk/env`, then `sudo systemctl restart desk`. Never change `DESK_SECRET_KEY`: connector keys saved on the Integrations page can't be read without it.
- Another admin, or a lost password or phone: `sudo /opt/desk/deploy/create-admin.sh`.
- Logs: `journalctl -u desk -f`.

**HTTPS is required.** Desk sets its sign-in cookies as secure in production, so the dashboard only works over HTTPS. If the certificate step fails (usually DNS not pointing at the server yet, or port 80 closed by your provider's firewall), fix that and run the script again.

**Small servers.** Building needs about 1 GB of memory. On a 1 GB VPS, add swap first (`sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`).

## Docker

`docker-compose.yml` runs Desk with [Caddy](https://caddyserver.com) in front, which gets and renews the HTTPS certificate on its own. It works on any server with Docker and Compose.

1. Point your domain's DNS at the server and open ports 80 and 443.
2. From a copy of Desk on the server (include `.local/` until `@modelriver/client` 1.7.0 is on npm):

```bash
cp deploy/docker/env.example .env
# Set DESK_DOMAIN, APP_URL and MODELRIVER_API_KEY in .env, then fill in the secrets:
sed -i "s|^DESK_SECRET_KEY=.*|DESK_SECRET_KEY=$(openssl rand -base64 32)|" .env
sed -i "s|^DESK_IDENTITY_SECRET=.*|DESK_IDENTITY_SECRET=$(openssl rand -base64 48 | tr -d '\n')|" .env
docker compose up -d --build
docker compose exec desk node scripts/create-admin.ts
```

Make the secrets once: never change `DESK_SECRET_KEY` afterwards, or connector keys saved on the Integrations page can't be read.

| What | Where |
| --- | --- |
| Settings | `.env` next to `docker-compose.yml` (kept out of git and the image). Desk reads all of it; Caddy is only given `DESK_DOMAIN` |
| Your data | The `desk-data` volume: `data/` (articles and notes), `desk.db` and `support.config.json`. Back it up. Its full name starts with your project folder's name (`docker volume ls`); for a folder named `desk`: `docker run --rm -v desk_desk-data:/data -v "$PWD":/backup alpine tar czf /backup/desk-data.tgz -C /data .` |
| Branding | `support.config.json` on the volume, with any logo next to it (copied there on the first start). Copy it out with `docker compose cp desk:/data/support.config.json .`, edit it, copy it back with `docker compose cp support.config.json desk:/data/`, then `docker compose restart desk` |
| Certificates | The `caddy-data` volume |

- **Updating:** `docker compose up -d --build` after updating your copy of Desk. Settings, data and certificates stay.
- **Sample articles:** set `DESK_SAMPLE_DATA=true` in `.env` before the first start.
- **Logs:** `docker compose logs -f desk`.
- **Your own proxy instead of Caddy:** remove the `caddy` service, give `desk` `ports: ["127.0.0.1:3000:3000"]`, and keep `TRUST_PROXY_HOPS=1` if exactly one proxy is in front.
- **One container only.** Rate limits live in memory and the database is one file, so don't scale `desk` beyond one.
- **Your own `.env`.** In a checkout you also develop in, `.env` holds your development settings; use a separate copy of Desk for Docker.

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
