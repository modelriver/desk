# syntax=docker/dockerfile:1
# Desk in a container: one Node.js process and a SQLite file. Your data,
# database and branding live in the /data volume.
#
# Published as ghcr.io/modelriver/desk for each release (.github/workflows/docker.yml).
#
#   docker compose up -d        (the published image, with Caddy for HTTPS; see deploy/README.md)
#   docker build -t desk .      (just the image, from this copy of the code)

ARG NODE_VERSION=26.12.1

# --- Build: install everything, build, then drop the dev packages ---
FROM node:${NODE_VERSION}-trixie-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm run check-versions \
 && npm run build \
 && npm prune --omit=dev --no-audit --no-fund

# --- Run: only what the server needs ---
FROM node:${NODE_VERSION}-trixie-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data/data \
    DATABASE_PATH=/data/desk.db
WORKDIR /app
COPY --from=build /app/package.json /app/server.mjs /app/support.config.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# server.mjs and the admin script load TypeScript from src/ directly.
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/examples ./examples
COPY --chmod=755 deploy/docker/entrypoint.sh /usr/local/bin/desk-entrypoint
# A new named volume starts with this folder's owner, so Desk can write to it.
RUN mkdir -p /data && chown node:node /data
# No USER here: hosts like Railway and Render mount their volumes owned by
# root, so the entrypoint starts as root, hands /data to the node user and
# runs Desk as node. docker-compose.yml starts it as node directly.
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/robots.txt`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["desk-entrypoint"]
CMD ["node", "server.mjs"]
