# syntax=docker/dockerfile:1
#
# services/wallet/Dockerfile — wallet BFF + static web UI (Holder).
#
# Build context is `services/wallet` (docker-compose `build: ./services/wallet`),
# so every COPY path below is relative to that directory.
#
# Multi-stage build:
#   1. builder  — installs ALL deps (npm ci) and runs `tsc --build` -> dist/.
#   2. runtime  — installs production deps only (npm ci --omit=dev) and copies
#                 dist/ + public/ + package.json. This keeps the image lean,
#                 within the 512 MB wallet memory budget (Req 5.3).
#
# Node is pinned to an explicit patch tag matching the package.json engine
# (node >= 20.9.0) and the @types/node 20.19.x line — NO `latest`/floating tag
# (Req 5.2). Alpine keeps the base small; it ships `wget` via busybox for the
# HEALTHCHECK probe.

# -----------------------------------------------------------------------------
# Stage 1 — builder: compile TypeScript to dist/.
# -----------------------------------------------------------------------------
FROM node:20.19.5-alpine AS builder

WORKDIR /app

# Install dependencies first (cached unless the manifests change). `npm ci`
# requires a committed lockfile and gives reproducible installs; when the
# lockfile is absent (not yet generated) we fall back to `npm install` so the
# image still builds. The wildcard copies package-lock.json only when present.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy the sources needed to compile and build dist/.
COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2 — runtime: production image.
# -----------------------------------------------------------------------------
FROM node:20.19.5-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Production dependencies only — no typescript/vitest/eslint in the final image.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
  && npm cache clean --force

# Compiled output and the static web UI. express.static resolves the UI from
# `../public` relative to dist/, so public/ must sit beside dist/ (i.e. at
# /app/public) at runtime.
COPY --from=builder /app/dist ./dist
COPY public ./public

# Drop privileges — the official node image provides an unprivileged `node`
# user. Ownership of /app is already fine (files copied as root are world
# readable); the `node` user only needs read + execute.
USER node

EXPOSE 3000

# Image-level liveness probe hitting GET /healthz (busybox wget on Alpine).
# Compose also defines its own health check; this makes the image self-describing.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "dist/server.js"]
