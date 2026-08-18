# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
# ^ the builder stage sets a placeholder BETTER_AUTH_SECRET (see comment
#   there); it is not a real credential, so that check is a false positive.

FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder
COPY . .
# Validated at import time during `next build`; nothing connects to the
# database at build, so placeholder values are safe here.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build \
    BETTER_AUTH_SECRET=build-time-placeholder-secret-32chars \
    APP_URL=http://localhost:3000
RUN npm run build

# ---------------------------------------------------------------------------
# Web: minimal standalone Next.js server
# ---------------------------------------------------------------------------
FROM node:26-alpine AS web
WORKDIR /app
ENV NODE_ENV=production
# Next's standalone server binds to process.env.HOSTNAME. Docker sets that
# to the container id, which resolves to nothing (getaddrinfo EAI_AGAIN) and
# crashes startup — bind to all interfaces instead.
ENV HOSTNAME=0.0.0.0
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]

# ---------------------------------------------------------------------------
# Worker: runs pg-boss jobs via tsx; also carries drizzle migrations so the
# same image can run `npx drizzle-kit migrate` as a one-shot job.
# ---------------------------------------------------------------------------
FROM node:26-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
# `ping` monitors shell out to this binary, and this image runs as a
# non-root user, so something has to grant it an ICMP socket.
#
# Belt: `net.ipv4.ping_group_range`, set on the worker service in
# docker-compose.yml. Docker has defaulted that sysctl open since ~2019
# and busybox's own ping applet uses the datagram socket happily, so on
# stock Docker this alone is enough.
#
# Braces: Alpine's iputils ping is setuid root, so it also works where
# that sysctl is NOT open — Kubernetes classifies it as an "unsafe"
# sysctl requiring explicit opt-in, and the bare-metal path in `docs/`
# has no Docker defaults at all. Those are the deployments this line
# exists for.
#
# `cap_add: [NET_RAW]` is not an alternative to either: capabilities are
# not inherited by a non-root process without file capabilities.
RUN apk add --no-cache iputils
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
# Operational scripts (demo seed/reset) run from this image too.
COPY scripts ./scripts
# What this replica reports as its version on the Workers page, and what
# makes the rolling-deploy banner able to say two versions are running.
# Baked in rather than left to the environment: the entrypoint is `npx`,
# which does not set `npm_package_version` the way `npm run` does, so an
# image started any way other than through the compose file that passes
# VIGIL_WORKER_VERSION would report every replica as "unknown" - and a
# fleet view where every row says "unknown" cannot show a rolling deploy,
# which is the one moment it exists for.
ARG VIGIL_WORKER_VERSION=unknown
ENV VIGIL_WORKER_VERSION=$VIGIL_WORKER_VERSION
USER node
CMD ["npx", "tsx", "src/worker/index.ts"]
