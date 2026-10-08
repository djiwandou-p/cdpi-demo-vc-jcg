// Unit tests for the wallet BFF HTTP API handlers (walt.id VC end-to-end demo).
//
// Coverage maps to design.md "Wallet BFF HTTP API" and "Error Handling":
//   - GET  /healthz        liveness returns { status:'ok' }.
//   - POST /wallet/offer    success path stores the credential and returns a
//                           confirmation; GET /wallet/credential then returns a
//                           REDACTED summary that never includes the raw SD-JWT
//                           VC (Req 2.3).
//   - POST /wallet/offer    invalid offer -> 400 attributed to step
//                           'offer-intake'; stored state is left unchanged
//                           (Req 6.3, Req 2.5).
//   - POST /wallet/offer    OpenID4VCI issuance error -> 502 attributed to the
//                           failing step with the relayed protocol code (Req 6.3).
//   - GET  /wallet/credential with no session -> 404 { stored:false }.
//
// All collaborators are injected as fakes via `createApp(deps)`, so no real
// issuer/verifier is contacted and no outbound network is touched. The Express
// app is exercised over loopback without `supertest` (not a dependency): each
// test starts the app on an ephemeral port (`app.listen(0)`), reads the assigned
// port from the server address, and uses Node 20's built-in `fetch`. Servers are
// always closed in `afterEach` so vitest exits cleanly.

import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp, type AppDependencies } from '../src/httpApi.js';
import { Oid4vciError, type runPreAuthorizedCodeFlow } from '../src/oid4vciClient.js';
import { createSessionStore } from '../src/sessionStore.js';
import type { StoredCredential } from '../src/types.js';

// -----------------------------------------------------------------------------
// Server lifecycle helper (no supertest)
// -----------------------------------------------------------------------------

interface RunningApp {
  baseUrl: string;
  close: () => Promise<void>;
}

// Track every server started so afterEach can tear them all down even if a test
// throws before closing its own.
const openServers: Server[] = [];

/**
 * Start the given app on an ephemeral loopback port and resolve a base URL plus
 * a close function. Uses `app.listen(0)` so the OS assigns a free port.
 */
async function startApp(deps: AppDependencies): Promise<RunningApp> {
  const app = createApp(deps);
  return new Promise<RunningApp>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      openServers.push(server);
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
    server.on('error', reject);
  });
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((res) => {
          server.close(() => res());
        }),
    ),
  );
});

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

// A valid OpenID4VCI offer JSON string the real `normalizeOffer` accepts.
const VALID_OFFER = JSON.stringify({
  credential_issuer: 'https://issuer.test',
  credential_configuration_ids: ['EducationCertificate'],
  grants: {
    'urn:ietf:params:oauth:grant-type:pre-authorized_code': {
      'pre-authorized_code': 'pac',
    },
  },
});

/**
 * A fake issuance flow that succeeds, echoing the injected `sessionId` into the
 * stored credential. Cast to the real signature because the handler only ever
 * invokes it as `runIssuance(offer, options)` and reads `result.credential` /
 * `result.holderKey`; a minimal holder key stand-in is sufficient here.
 */
const fakeSuccessfulIssuance = ((_offer, options) =>
  Promise.resolve({
    credential: {
      sessionId: options.sessionId,
      format: 'sd-jwt-vc',
      sdJwtVc: 'ISSUER.JWT.SIG~disc~',
      vct: 'EducationCertificate',
    } satisfies StoredCredential,
    // The presentation step would need a real holder key, but these tests never
    // exercise /wallet/present, so an empty object standing in is adequate.
    holderKey: {} as never,
  })) as unknown as typeof runPreAuthorizedCodeFlow;

/**
 * A fake issuance flow that fails at the OpenID4VCI credential step with an
 * `unsupported_credential_type` protocol error.
 */
const fakeFailingIssuance = (() =>
  Promise.reject(
    new Oid4vciError('credential', 'unsupported', {
      status: 400,
      code: 'unsupported_credential_type',
    }),
  )) as unknown as typeof runPreAuthorizedCodeFlow;

// Extract the `sid` cookie value from a response's Set-Cookie header.
function readSidCookie(response: Response): string | undefined {
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) {
    return undefined;
  }
  const match = /(?:^|,\s*)sid=([^;]+)/.exec(setCookie);
  return match?.[1];
}

// -----------------------------------------------------------------------------
// GET /healthz
// -----------------------------------------------------------------------------

describe('GET /healthz', () => {
  it('returns 200 with { status: "ok" } for liveness', async () => {
    const { baseUrl, close } = await startApp({});
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: 'ok' });
    } finally {
      await close();
    }
  });
});

// -----------------------------------------------------------------------------
// POST /wallet/offer — success + redacted credential summary (Req 2.3)
// -----------------------------------------------------------------------------

describe('POST /wallet/offer (success) + GET /wallet/credential', () => {
  it('stores the credential, confirms, and exposes only a redacted summary', async () => {
    const { baseUrl, close } = await startApp({
      sessionStore: createSessionStore(),
      runPreAuthorizedCodeFlow: fakeSuccessfulIssuance,
    });
    try {
      // POST a valid offer.
      const offerResponse = await fetch(`${baseUrl}/wallet/offer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offer: VALID_OFFER }),
      });

      expect(offerResponse.status).toBe(200);
      const offerBody = (await offerResponse.json()) as {
        stored: boolean;
        vct: string;
        format: string;
      };
      expect(offerBody.stored).toBe(true);
      expect(offerBody.vct).toBe('EducationCertificate');

      // The session is pinned by the httpOnly `sid` cookie.
      const sid = readSidCookie(offerResponse);
      expect(sid).toBeDefined();

      // GET the stored-credential summary with the same session cookie.
      const credentialResponse = await fetch(`${baseUrl}/wallet/credential`, {
        headers: { cookie: `sid=${sid}` },
      });

      expect(credentialResponse.status).toBe(200);
      const credentialBody = (await credentialResponse.json()) as Record<
        string,
        unknown
      >;
      expect(credentialBody.stored).toBe(true);
      expect(credentialBody.vct).toBe('EducationCertificate');
      expect(credentialBody.format).toBe('sd-jwt-vc');
      // Redaction (Req 2.3): the raw SD-JWT VC is never returned.
      expect(credentialBody).not.toHaveProperty('sdJwtVc');
    } finally {
      await close();
    }
  });
});

// -----------------------------------------------------------------------------
// POST /wallet/offer — invalid offer -> step attribution + unchanged state
// -----------------------------------------------------------------------------

describe('POST /wallet/offer (invalid offer)', () => {
  it('returns 400 attributed to offer-intake and leaves stored state unchanged', async () => {
    const { baseUrl, close } = await startApp({
      sessionStore: createSessionStore(),
      // Issuance must never be reached for an invalid offer.
      runPreAuthorizedCodeFlow: fakeSuccessfulIssuance,
    });
    try {
      const offerResponse = await fetch(`${baseUrl}/wallet/offer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offer: 'not-a-valid-offer' }),
      });

      expect(offerResponse.status).toBe(400);
      const body = (await offerResponse.json()) as {
        success: boolean;
        error: { step: string };
      };
      expect(body.success).toBe(false);
      expect(body.error.step).toBe('offer-intake');

      // Stored state is unchanged: a fresh read reports nothing stored (Req 2.5).
      const sid = readSidCookie(offerResponse);
      const credentialResponse = await fetch(`${baseUrl}/wallet/credential`, {
        headers: sid !== undefined ? { cookie: `sid=${sid}` } : {},
      });
      expect(credentialResponse.status).toBe(404);
      await expect(credentialResponse.json()).resolves.toEqual({ stored: false });
    } finally {
      await close();
    }
  });
});

// -----------------------------------------------------------------------------
// POST /wallet/offer — issuance error -> step attribution (Req 6.3)
// -----------------------------------------------------------------------------

describe('POST /wallet/offer (issuance error)', () => {
  it('returns 502 attributed to the failing step with the relayed protocol code', async () => {
    const { baseUrl, close } = await startApp({
      sessionStore: createSessionStore(),
      runPreAuthorizedCodeFlow: fakeFailingIssuance,
    });
    try {
      const offerResponse = await fetch(`${baseUrl}/wallet/offer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offer: VALID_OFFER }),
      });

      expect(offerResponse.status).toBe(502);
      const body = (await offerResponse.json()) as {
        success: boolean;
        error: { step: string; code?: string };
      };
      expect(body.success).toBe(false);
      expect(body.error.step).toBe('credential');
      expect(body.error.code).toBe('unsupported_credential_type');
    } finally {
      await close();
    }
  });
});

// -----------------------------------------------------------------------------
// GET /wallet/credential — no session
// -----------------------------------------------------------------------------

describe('GET /wallet/credential (no session)', () => {
  it('returns 404 { stored: false } when no session cookie is present', async () => {
    const { baseUrl, close } = await startApp({ sessionStore: createSessionStore() });
    try {
      const response = await fetch(`${baseUrl}/wallet/credential`);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ stored: false });
    } finally {
      await close();
    }
  });
});
