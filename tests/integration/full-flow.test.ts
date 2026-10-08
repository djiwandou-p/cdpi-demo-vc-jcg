/**
 * full-flow.test.ts — end-to-end integration driver for the walt.id VC demo.
 *
 * Design reference: design.md "Integration Test Design".
 *
 * This test exercises the REAL running Docker Compose stack over HTTP — there
 * are NO mocks, no fakes, and no stubbed collaborators. It drives the complete
 * issue -> store -> present -> verify journey against the three services started
 * by `docker compose up`:
 *   - wallet   (custom TS/Node BFF + UI, Holder)   :3000
 *   - issuer   (waltid/issuer-api2, OpenID4VCI 1.0) :7005
 *   - verifier (waltid/verifier-api2, OpenID4VP 1.0):7004
 *
 * Requirements validated:
 *   - 6.1  A single automated test drives the full cross-service flow.
 *   - 6.2  The test asserts the verifier reports a successful verification.
 *   - 6.3  On failure, the error names the pipeline step that failed
 *          (step attribution via the `step()` helper + wallet error envelopes).
 *   - 3.1  The wallet stores the issued credential (confirmed via
 *          GET /wallet/credential returning stored:true).
 *   - 4.1  The presentation request names the `degree` + `institution` claims
 *          (sourced from services/verifier/config/presentation-request.json).
 *   - 4.2  The verifier validates the issuer signature / did:key resolution
 *          (implied by result.success === true from the real verifier).
 *   - 4.3  The disclosed claims include `degree` AND `institution`.
 *   - 4.4  The verifier returns an overall success result.
 *
 * Selective disclosure (design Property 3): the presentation discloses ONLY the
 * requested claims; `grades` is NOT requested and MUST NOT appear in the
 * disclosed claims.
 *
 * Node runtime: uses the Node 20 built-in global `fetch` (no node-fetch needed).
 *
 * Cookie handling: Node's built-in `fetch` does not persist cookies across
 * calls, so this driver implements a tiny cookie jar — it reads the `sid`
 * session cookie set by POST /wallet/offer and replays it on the subsequent
 * GET /wallet/credential and POST /wallet/present calls (the wallet is session
 * scoped via an httpOnly `sid` cookie).
 *
 * Endpoint ASSUMPTIONS (documented inline at each helper):
 *   - Issuer:   POST ${ISSUER}/openid4vci/offer      (walt.id issuer-api2)
 *   - Verifier: POST ${VERIFIER}/verification-session/create (walt.id verifier-api2)
 *
 * Run (from repo root, with the Compose stack already up):
 *   docker compose up    # in another terminal, wait for services to be healthy
 *   npm install && npm run test:integration
 */

import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

// -----------------------------------------------------------------------------
// Base URLs (env-configurable so the same test can target compose-internal or
// host-mapped ports).
// -----------------------------------------------------------------------------

const WALLET = process.env.WALLET_BASE_URL ?? 'http://localhost:3000';
const ISSUER = process.env.ISSUER_BASE_URL ?? 'http://localhost:7005';
const VERIFIER = process.env.VERIFIER_BASE_URL ?? 'http://localhost:7004';

// Repo root is two levels up from tests/integration/; the presentation-request
// fixture is resolved relative to this file via import.meta.url.
const PRESENTATION_REQUEST_PATH = new URL(
  '../../services/verifier/config/presentation-request.json',
  import.meta.url,
);

// -----------------------------------------------------------------------------
// Tiny cookie jar
// -----------------------------------------------------------------------------

/**
 * Minimal single-cookie jar. Node's built-in `fetch` does not store cookies, so
 * we capture the wallet's `sid=<value>` from a Set-Cookie header and replay it
 * as a `Cookie: sid=<value>` request header on later calls.
 */
class CookieJar {
  private sid: string | undefined;

  /** Parse and remember the `sid` token from a Set-Cookie header value. */
  capture(setCookie: string | null): void {
    if (setCookie === null) {
      return;
    }
    // Set-Cookie may contain attributes (Path, HttpOnly, ...); we only need the
    // first `sid=<value>` name/value pair.
    const match = /(?:^|[;,\s])sid=([^;,\s]+)/.exec(setCookie);
    if (match?.[1] !== undefined) {
      this.sid = match[1];
    }
  }

  /** Produce request headers carrying the stored cookie, if any. */
  header(): Record<string, string> {
    return this.sid !== undefined ? { Cookie: `sid=${this.sid}` } : {};
  }
}

// -----------------------------------------------------------------------------
// Small HTTP + JSON utilities
// -----------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Return the first defined, non-empty string among the arguments. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

async function readBodyText(res: Response): Promise<string> {
  return res.text();
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run a named step; on throw, rethrow with the step name prefixed to the
 * message so a failure clearly attributes which pipeline stage broke (Req 6.3).
 */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[step:${name}] ${message}`);
  }
}

// -----------------------------------------------------------------------------
// Issuer helper — create an Education Certificate credential offer.
// -----------------------------------------------------------------------------

/**
 * Create an OpenID4VCI credential offer for the demo Education Certificate.
 *
 * ASSUMPTION (walt.id issuer-api2): the offer is created by
 *   POST ${ISSUER}/openid4vci/offer
 * with a JSON body naming the credential configuration id. This matches
 * services/issuer/README.md. The response may be either:
 *   - a plain-text offer URI (openid-credential-offer://...), or
 *   - a JSON body carrying the URI in a string field, or in a field named
 *     `credentialOffer` / `offerUri` / `offer`.
 * We handle both.
 */
async function createEducationOffer(): Promise<string> {
  const res = await fetch(`${ISSUER}/openid4vci/offer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credentialConfigurationId: 'EducationCertificate' }),
  });

  const text = await readBodyText(res);
  if (!res.ok) {
    throw new Error(`issuer offer failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = parseJsonObject(text);
    if (body !== undefined) {
      // Named fields first, then any string value that looks like an offer URI.
      const named = firstString(body.credentialOffer, body.offerUri, body.offer);
      if (named !== undefined) {
        return named;
      }
      for (const value of Object.values(body)) {
        if (
          typeof value === 'string' &&
          value.startsWith('openid-credential-offer://')
        ) {
          return value;
        }
      }
    }
    // A bare JSON string ("openid-credential-offer://...").
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'string' && parsed.trim().length > 0) {
        return parsed;
      }
    } catch {
      // fall through to raw text handling below
    }
  }

  const raw = text.trim();
  if (raw.length === 0) {
    throw new Error('issuer offer response was empty');
  }
  return raw;
}

// -----------------------------------------------------------------------------
// Verifier helper — create a presentation (verification session) request.
// -----------------------------------------------------------------------------

interface PresentationRequestResult {
  request: string;
  nonce: string | undefined;
}

/**
 * Create a verification session on the verifier and return its authorization
 * request string + nonce.
 *
 * ASSUMPTION (walt.id verifier-api2): a verification session is created by
 *   POST ${VERIFIER}/verification-session/create
 * with the body from services/verifier/config/presentation-request.json (which
 * requests ONLY `degree` + `institution`, Req 4.1). This matches
 * services/verifier/README.md. The authorization-request string is read from one
 * of `fullAuthorizationRequestUrl` / `authorizationRequestUrl` / `request`, and
 * the nonce from `nonce`.
 *
 * Host convenience: the verifier (running inside Compose) may emit URLs that
 * reference the service hostname `verifier:7004`. From the host-side test the
 * wallet reaches the verifier at `localhost:7004`, so we best-effort rewrite any
 * `verifier:7004` substring to `localhost:7004` in the returned request string.
 */
async function createPresentationRequest(): Promise<PresentationRequestResult> {
  const requestBodyText = await readFile(PRESENTATION_REQUEST_PATH, 'utf8');
  const requestBody: unknown = JSON.parse(requestBodyText);

  const res = await fetch(`${VERIFIER}/verification-session/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  const text = await readBodyText(res);
  if (!res.ok) {
    throw new Error(
      `verifier session create failed: HTTP ${res.status} — ${text.slice(0, 300)}`,
    );
  }

  const body = parseJsonObject(text);
  if (body === undefined) {
    throw new Error('verifier session response was not a JSON object');
  }

  const rawRequest = firstString(
    body.fullAuthorizationRequestUrl,
    body.authorizationRequestUrl,
    body.request,
  );
  if (rawRequest === undefined) {
    throw new Error(
      'verifier session response did not include an authorization request url',
    );
  }

  // Best-effort compose-host rewrite (see doc comment).
  const request = rawRequest.replaceAll('verifier:7004', 'localhost:7004');
  const nonce = firstString(body.nonce);

  return { request, nonce };
}

// -----------------------------------------------------------------------------
// Readiness gate
// -----------------------------------------------------------------------------

/**
 * Poll the wallet healthz endpoint until it reports ok, up to ~60s. Throws a
 * clear operator-facing message if the stack never becomes reachable.
 */
async function waitForWalletReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${WALLET}/healthz`);
      if (res.ok) {
        const body = parseJsonObject(await readBodyText(res));
        if (body?.status === 'ok') {
          return;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(2_000);
  }
  const detail = lastError instanceof Error ? ` (${lastError.message})` : '';
  throw new Error(
    `Compose stack not reachable at :3000 — run \`docker compose up\` before the integration test.${detail}`,
  );
}

// -----------------------------------------------------------------------------
// Response shapes relied upon from the wallet BFF (httpApi.ts).
// -----------------------------------------------------------------------------

interface OfferResponse {
  sessionId?: string;
  vct?: string;
  format?: string;
  stored?: boolean;
}

interface CredentialResponse {
  stored?: boolean;
  vct?: string;
  format?: string;
}

interface VerificationResult {
  success?: boolean;
  disclosedClaims?: Record<string, unknown>;
  error?: { step?: string; message?: string };
}

// -----------------------------------------------------------------------------
// Suite
// -----------------------------------------------------------------------------

describe('walt.id VC end-to-end demo (Req 6.1)', () => {
  beforeAll(async () => {
    await waitForWalletReady();
  });

  it(
    'issues, stores, presents, and verifies with selective disclosure',
    async () => {
      const jar = new CookieJar();

      // 1. issue — create an offer at the issuer.
      const offer = await step('issue', () => createEducationOffer());

      // 2. offer — hand the offer to the wallet; it runs OpenID4VCI and stores
      //    the credential. Capture the `sid` cookie for later calls.
      const offerBody = await step('offer', async () => {
        const res = await fetch(`${WALLET}/wallet/offer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offer }),
        });
        jar.capture(res.headers.get('set-cookie'));
        const text = await readBodyText(res);
        if (res.status !== 200) {
          throw new Error(`HTTP ${res.status} — ${text.slice(0, 300)}`);
        }
        return (parseJsonObject(text) ?? {}) as OfferResponse;
      });
      expect(offerBody.stored).toBe(true);
      expect(offerBody.vct).toBe('EducationCertificate');

      // 3. store — confirm the credential is retrievable for this session
      //    (Req 3.1).
      const credentialBody = await step('store', async () => {
        const res = await fetch(`${WALLET}/wallet/credential`, {
          method: 'GET',
          headers: { ...jar.header() },
        });
        const text = await readBodyText(res);
        if (res.status !== 200) {
          throw new Error(`HTTP ${res.status} — ${text.slice(0, 300)}`);
        }
        return (parseJsonObject(text) ?? {}) as CredentialResponse;
      });
      expect(credentialBody.stored).toBe(true);

      // 4. request — create a verification session (requests degree +
      //    institution only; Req 4.1).
      const { request } = await step('request', () => createPresentationRequest());

      // 5. present — the wallet applies selective disclosure, submits the
      //    vp_token, and relays the verifier result.
      const result = await step('present', async () => {
        const res = await fetch(`${WALLET}/wallet/present`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...jar.header() },
          body: JSON.stringify({ request }),
        });
        const text = await readBodyText(res);
        const parsed = (parseJsonObject(text) ?? {}) as VerificationResult;
        // A non-2xx envelope carries { error: { step } } — surface that step.
        if (res.status < 200 || res.status >= 300) {
          const attributedStep = parsed.error?.step ?? 'unknown';
          const message = parsed.error?.message ?? text.slice(0, 300);
          throw new Error(
            `wallet present failed at [${attributedStep}]: HTTP ${res.status} — ${message}`,
          );
        }
        return parsed;
      });

      // 6. verify — the verifier reports success and the disclosed claims honour
      //    selective disclosure.
      await step('verify', async () => {
        // Req 6.2 / 4.4 — overall success from the real verifier.
        if (result.success !== true) {
          const attributedStep = result.error?.step ?? 'verify';
          const message = result.error?.message ?? 'verifier did not report success';
          throw new Error(`verification unsuccessful at [${attributedStep}]: ${message}`);
        }
        expect(result.success).toBe(true);

        // Req 4.3 — degree AND institution were disclosed.
        const disclosed = result.disclosedClaims ?? {};
        expect(Object.keys(disclosed)).toEqual(
          expect.arrayContaining(['degree', 'institution']),
        );

        // design Property 3 — selective disclosure: `grades` was NOT requested
        // and MUST NOT be disclosed.
        expect(Object.keys(disclosed)).not.toContain('grades');
      });
    },
    120_000,
  );
});
