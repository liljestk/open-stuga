# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

WORKDIR /app

# Copy manifests first so dependency installation remains cacheable.
COPY package*.json ./
COPY tsconfig.base.json ./
COPY apps/api/package*.json ./apps/api/
COPY apps/web/package*.json ./apps/web/
COPY packages/contracts/package*.json ./packages/contracts/

RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY packages/contracts ./packages/contracts

# An empty value makes the browser use the same-origin /api/v1 default.
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ARG VITE_SPATIAL_MAX_SAMPLE_AGE_MS=900000
ENV VITE_SPATIAL_MAX_SAMPLE_AGE_MS=${VITE_SPATIAL_MAX_SAMPLE_AGE_MS}
ARG VITE_SPATIAL_REPLAY_MAX_SAMPLE_AGE_MS=5400000
ENV VITE_SPATIAL_REPLAY_MAX_SAMPLE_AGE_MS=${VITE_SPATIAL_REPLAY_MAX_SAMPLE_AGE_MS}

RUN npm run build

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS api

ENV NODE_ENV=production \
    PORT=8787 \
    API_HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/climate-twin.sqlite \
    HA_ENTITY_MAP_FILE=/app/config/home-assistant.entities.json

WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist

RUN mkdir -p /app/data /app/config && chown -R node:node /app/data /app/config

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "apps/api/dist/index.js"]

FROM nginx:alpine AS web

RUN rm -f /etc/nginx/conf.d/default.conf
COPY config/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["wget", "--quiet", "--tries=1", "--spider", "http://127.0.0.1:8080/"]

CMD ["nginx", "-g", "daemon off;"]
