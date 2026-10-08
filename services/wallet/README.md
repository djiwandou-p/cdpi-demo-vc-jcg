# Wallet (Holder) — walt.id VC end-to-end demo

A minimal web **wallet BFF** (backend-for-frontend) plus a thin static UI that
plays the **Holder** role in the demo. It receives credential offers from the
issuer, runs OpenID4VCI to obtain an SD-JWT VC, stores it per browser session,
and later presents selectively-disclosed claims to the verifier via OpenID4VP.

TypeScript / Node ESM app built on Express. Compiled with `tsc --build` to
`dist/`; the entry point is `dist/server.js`, which listens on **port 3000**
(overridable with `PORT` for local runs).

## HTTP endpoints

The static UI talks to the BFF through four endpoints:

| Method & path            | Purpose |
| ------------------------ | ------- |
| `POST /wallet/offer`     | Accept an offer string, run OpenID4VCI (pre-authorized code flow), store the issued credential, and return a confirmation (`vct`, `format`, `stored`). |
| `GET  /wallet/credential`| Return a **redacted** summary of the stored credential (type/format/presence only — never the raw SD-JWT or holder key). `404` when nothing is stored. |
| `POST /wallet/present`   | Accept a presentation-request string, apply selective disclosure, submit the `vp_token` to the verifier, and relay the verification result (with per-step attribution). |
| `GET  /healthz`          | Liveness probe used by the Docker/Compose health checks. Returns `{ "status": "ok" }`. |

The static web UI is served from `public/` at the site root (`/`).

## Configuration

Runtime configuration is read from the environment:

| Variable            | Purpose                              | Compose value              |
| ------------------- | ------------------------------------ | -------------------------- |
| `ISSUER_BASE_URL`   | Base URL of the walt.id issuer API   | `http://issuer:7005`       |
| `VERIFIER_BASE_URL` | Base URL of the walt.id verifier API | `http://verifier:7004`     |
| `PORT`              | Listen port (local override only)    | `3000` (default)           |

## Run locally

Requires Node >= 20.9.0.

```bash
cd services/wallet
npm ci                 # install dependencies
npm run build          # compile TypeScript -> dist/
ISSUER_BASE_URL=http://localhost:7005 \
VERIFIER_BASE_URL=http://localhost:7004 \
  npm start            # node dist/server.js  (listens on :3000)
```

Open <http://localhost:3000> for the UI. Other scripts: `npm run lint`
(`eslint .`) and `npm test` (`vitest run`).

## Run with Docker

The image is a multi-stage build (builder compiles TypeScript; the runtime
stage ships only production dependencies plus `dist/` and `public/`). The base
image is pinned to `node:20.19.5-alpine`.

```bash
# From services/wallet (the build context used by docker-compose).
docker build -t cdpi-wallet .

docker run --rm -p 3000:3000 \
  -e ISSUER_BASE_URL=http://host.docker.internal:7005 \
  -e VERIFIER_BASE_URL=http://host.docker.internal:7004 \
  cdpi-wallet
```

The image `EXPOSE`s 3000 and defines a `HEALTHCHECK` that polls
`GET /healthz`. It runs as the unprivileged `node` user.

## Role in docker-compose

The root `docker-compose.yml` builds this service from `./services/wallet`,
maps `3000:3000`, caps memory at `512m`, injects `ISSUER_BASE_URL` /
`VERIFIER_BASE_URL` for the on-network issuer and verifier, and gates startup on
both of those services being `healthy` (`depends_on ... condition:
service_healthy`). Bring the whole demo up with:

```bash
docker compose up --build
```
