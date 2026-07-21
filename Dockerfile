FROM node:22-bookworm-slim AS node-base

FROM node-base AS dependencies

WORKDIR /app

# Copy manifests first so dependency installation remains cacheable.
COPY package*.json ./
COPY tsconfig.base.json ./
COPY apps/api/package*.json ./apps/api/
COPY apps/web/package*.json ./apps/web/
COPY apps/tapo-export-runner/package*.json ./apps/tapo-export-runner/
COPY packages/contracts/package*.json ./packages/contracts/
COPY packages/spatial-layers/package*.json ./packages/spatial-layers/

RUN --mount=type=cache,target=/root/.npm \
  if [ -f package-lock.json ]; then \
    npm ci --no-audit --fetch-retries=10 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=30000; \
  else \
    npm install --no-audit --fetch-retries=10 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=30000; \
  fi

FROM dependencies AS api-build

COPY apps/api ./apps/api
COPY packages/contracts ./packages/contracts
COPY packages/spatial-layers ./packages/spatial-layers
COPY scripts/init-runtime-secrets.mjs scripts/migrate-telemetry-to-timescale.mjs \
  scripts/sqlite-snapshot-utils.mjs scripts/stuga-backup.mjs ./scripts/

RUN npm run build:packages && npm run build --workspace @climate-twin/api

FROM api-build AS production-dependencies
RUN npm prune --omit=dev

FROM dependencies AS web-build

COPY apps/web ./apps/web
COPY packages/contracts ./packages/contracts
COPY packages/spatial-layers ./packages/spatial-layers

# An empty value makes the browser use the same-origin /api/v1 default.
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ARG VITE_SPATIAL_MAX_SAMPLE_AGE_MS=900000
ENV VITE_SPATIAL_MAX_SAMPLE_AGE_MS=${VITE_SPATIAL_MAX_SAMPLE_AGE_MS}
ARG VITE_SPATIAL_REPLAY_MAX_SAMPLE_AGE_MS=5400000
ENV VITE_SPATIAL_REPLAY_MAX_SAMPLE_AGE_MS=${VITE_SPATIAL_REPLAY_MAX_SAMPLE_AGE_MS}

RUN npm run build:packages && npm run build --workspace @climate-twin/web

FROM dependencies AS tapo-export-runner-build

COPY apps/tapo-export-runner ./apps/tapo-export-runner

RUN npm run build --workspace @climate-twin/tapo-export-runner

FROM node-base AS api-runtime

ENV NODE_ENV=production \
    PORT=8787 \
    API_HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/climate-twin.sqlite \
    SPATIAL_LAYERS_ENABLED=true \
    SPATIAL_LAYERS_DATABASE_PATH=/app/data/experimental-spatial-layers.sqlite \
    INTEGRATION_SECRETS_FILE=/app/data/integration-secrets.json \
    HA_ENTITY_MAP_FILE=/app/config/home-assistant.entities.json \
    TP_LINK_DEVICE_MAP_FILE=/app/config/tp-link.devices.json \
    TP_LINK_PYTHON=/opt/tp-link-python/bin/python

WORKDIR /app

# Keep the comparatively slow native/Python runtime layer independent from
# TypeScript sources so normal backend edits do not reinstall it.
COPY apps/api/python/requirements.txt /tmp/tp-link-requirements.txt

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && python3 -m venv /opt/tp-link-python \
  && /opt/tp-link-python/bin/pip install --no-cache-dir -r /tmp/tp-link-requirements.txt \
  && rm -f /tmp/tp-link-requirements.txt \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/data /app/config /app/runtime/admin /app/runtime/db /app/runtime/proxy /app/runtime/tapo \
  && chown -R node:node /app/data /app/config /app/runtime

FROM api-runtime AS api

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=api-build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=api-build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=api-build --chown=node:node /app/apps/api/python ./apps/api/python
# npm keeps local workspaces as symlinks in node_modules. Copy the compiled
# contracts workspace so that the production symlink has a JavaScript target.
COPY --from=api-build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=api-build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=api-build --chown=node:node /app/packages/spatial-layers/package.json ./packages/spatial-layers/package.json
COPY --from=api-build --chown=node:node /app/packages/spatial-layers/dist ./packages/spatial-layers/dist
COPY --from=api-build --chown=node:node /app/scripts/init-runtime-secrets.mjs ./scripts/init-runtime-secrets.mjs
COPY --from=api-build --chown=node:node /app/scripts/migrate-telemetry-to-timescale.mjs ./scripts/migrate-telemetry-to-timescale.mjs
COPY --from=api-build --chown=node:node /app/scripts/sqlite-snapshot-utils.mjs ./scripts/sqlite-snapshot-utils.mjs
COPY --from=api-build --chown=node:node /app/scripts/stuga-backup.mjs ./scripts/stuga-backup.mjs

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "apps/api/dist/index.js"]

FROM node-base AS tapo-export-runner

ENV NODE_ENV=production
WORKDIR /app

RUN mkdir -p /app/data /app/config \
  && chown -R node:node /app/data /app/config

COPY --from=tapo-export-runner-build --chown=node:node /app/apps/tapo-export-runner/package.json ./apps/tapo-export-runner/package.json
COPY --from=tapo-export-runner-build --chown=node:node /app/apps/tapo-export-runner/dist ./apps/tapo-export-runner/dist

USER node

CMD ["node", "apps/tapo-export-runner/dist/index.js"]

# Backup tooling stays out of the production API image. This maintenance-only
# target combines Node's built-in SQLite support with a PostgreSQL 17 client,
# so a Compose backup can snapshot both stores without publishing PostgreSQL.
FROM postgres:17-bookworm AS backup

WORKDIR /app

COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
COPY scripts/sqlite-snapshot-utils.mjs scripts/stuga-backup.mjs scripts/stuga-backup-scheduler.mjs scripts/stuga-restore-drill.mjs ./scripts/

RUN mkdir -p /app/backups

USER 1000:1000

ENTRYPOINT ["node", "/app/scripts/stuga-backup.mjs"]

FROM nginx:alpine AS web

RUN rm -f /etc/nginx/conf.d/default.conf
COPY config/nginx.conf /etc/nginx/templates/nginx.conf.template
COPY config/nginx-entrypoint.sh /usr/local/bin/stuga-nginx-entrypoint
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html

RUN chmod 755 /usr/local/bin/stuga-nginx-entrypoint

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["wget", "--quiet", "--tries=1", "--spider", "http://127.0.0.1:8080/"]

CMD ["/usr/local/bin/stuga-nginx-entrypoint"]
