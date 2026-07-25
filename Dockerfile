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
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
# Operational scripts (demo seed/reset) run from this image too.
COPY scripts ./scripts
USER node
CMD ["npx", "tsx", "src/worker/index.ts"]
