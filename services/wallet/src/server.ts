// server — the wallet BFF process entrypoint.
//
// Builds the Express app from `createApp` (which wires offerIntake,
// oid4vciClient, holderKeys, sessionStore, disclosureSelector, and oid4vpClient
// together — see `httpApi.ts`) and listens on the Compose/Dockerfile port 3000.
//
// Configuration is taken from the environment (design: External Interfaces):
//   - ISSUER_BASE_URL   issuer base URL   (`http://issuer:7005` on Compose).
//   - VERIFIER_BASE_URL verifier base URL (`http://verifier:7004` on Compose).
// Both are read inside `createApp`; this entrypoint only needs the listen port.
//
// The static web UI (task 9.1) is served by `createApp` from
// `services/wallet/public`; the directory may be empty until the UI lands, which
// is handled gracefully (missing files simply 404).

import { createApp } from './httpApi.js';

// The port the wallet listens on — fixed to 3000 to match the Dockerfile EXPOSE
// and the Compose `3000:3000` mapping. Overridable via PORT for local runs.
const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);

const app = createApp();

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`wallet BFF listening on port ${PORT}`);
});

// Graceful shutdown so Compose/Docker stop signals terminate the process
// cleanly instead of waiting for the socket timeout.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
