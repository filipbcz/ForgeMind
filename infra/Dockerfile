FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/mobile-pwa/package.json apps/mobile-pwa/package.json
COPY apps/mobile-pwa/tsconfig.json apps/mobile-pwa/tsconfig.json
COPY apps/studio-api/package.json apps/studio-api/package.json
COPY apps/studio-api/tsconfig.json apps/studio-api/tsconfig.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/worker/tsconfig.json apps/worker/tsconfig.json
COPY packages/config/package.json packages/config/package.json
COPY packages/config/tsconfig.json packages/config/tsconfig.json
COPY packages/core/package.json packages/core/package.json
COPY packages/core/tsconfig.json packages/core/tsconfig.json
COPY packages/db/package.json packages/db/package.json
COPY packages/db/tsconfig.json packages/db/tsconfig.json
COPY packages/github/package.json packages/github/package.json
COPY packages/github/tsconfig.json packages/github/tsconfig.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/providers/tsconfig.json packages/providers/tsconfig.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json

RUN npm ci

COPY apps apps
COPY packages packages

RUN npm run db:generate
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ARG CODEX_VERSION=0.142.5

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && npm install --global "@openai/codex@${CODEX_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/mobile-pwa/package.json apps/mobile-pwa/package.json
COPY apps/studio-api/package.json apps/studio-api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/github/package.json packages/github/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --omit=dev \
  && npm install --no-save prisma@6.9.0

COPY packages/db/prisma packages/db/prisma
RUN npx prisma generate --schema packages/db/prisma/schema.prisma

COPY --from=build /app/apps/studio-api/dist apps/studio-api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/packages/config/dist packages/config/dist
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/github/dist packages/github/dist
COPY --from=build /app/packages/providers/dist packages/providers/dist
COPY --from=build /app/packages/shared/dist packages/shared/dist

FROM caddy:2.10-alpine AS web

COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/mobile-pwa/dist /srv
