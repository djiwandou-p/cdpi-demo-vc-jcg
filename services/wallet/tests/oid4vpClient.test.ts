// Tests for the `oid4vpClient` module (walt.id VC end-to-end demo).
//
// Coverage maps to design.md "Correctness Properties" and "Error Handling":
//   - Property 6 ("Presentation binds to the request challenge", Req 3.4):
//     a property-based test over arbitrary non-empty nonces proving the KB-JWT
//     embedded in the SD-JWT VP always carries exactly the supplied nonce, so
//     the presentation is bound to the verifier's challenge for any nonce.
//   - "Error Handling — Failed signature validation" (Req 4.5): a unit test
//     driving `presentCredential` with an injected fake `fetch` that simulates
//     the verifier rejecting the presentation (signature validation failure),
//     asserting the outcome is relayed as a `verify`-step failure result rather
//     than thrown.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  buildSdJwtVp,
  presentCredential,
  type DisclosureSelection,
} from '../src/oid4vpClient.js';
import { decodeJwt, generateHolderKey } from '../src/holderKeys.js';
import type { PresentationRequest, StoredCredential } from '../src/types.js';

// base64url-encode a UTF-8 string (no padding) — matches the token encoding
// used throughout the wallet.
function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

// A structurally-valid issuer-signed JWT: three dot-separated base64url
// segments. `buildSdJwtVp` only checks the shape (3 parts), not the signature.
const issuerSignedJwt = `${b64url('{"alg":"EdDSA"}')}.${b64url(
  '{"vct":"EducationCertificate"}',
)}.${b64url('sig')}`;

// -----------------------------------------------------------------------------
// Property 6 — Presentation binds to the request challenge (Req 3.4)
// -----------------------------------------------------------------------------

describe('buildSdJwtVp', () => {
  it('Feature: waltid-vc-e2e-demo, Property 6: Presentation binds to the request challenge', () => {
    // Key generation is slow; the property is about the nonce binding, not the
    // key, so generate one holder key and reuse it across all iterations.
    const holderKey = generateHolderKey();

    // Two dummy disclosures (base64url of `[salt, name, value]` arrays).
    const disclosures = [
      b64url(JSON.stringify(['salt1', 'degree', 'BSc Mathematics'])),
      b64url(JSON.stringify(['salt2', 'institution', 'University of London'])),
    ];

    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (nonce) => {
        const selection: DisclosureSelection = {
          issuerSignedJwt,
          disclosures,
          disclosedClaims: {},
        };

        const vp = buildSdJwtVp({
          selection,
          holderKey,
          nonce,
          audience: 'https://verifier.test',
        });

        // Layout: `<issuer JWT>~<disclosure>*~<KB-JWT>`. The KB-JWT is the last
        // `~`-separated segment; the first segment is the issuer-signed JWT.
        const segments = vp.split('~');
        const kbJwt = segments[segments.length - 1] as string;

        // The first segment is exactly the supplied issuer-signed JWT.
        expect(segments[0]).toBe(selection.issuerSignedJwt);

        // Challenge binding: the KB-JWT's `nonce` equals the supplied nonce for
        // any nonce (Property 6 / Req 3.4).
        const { payload } = decodeJwt(kbJwt);
        expect(payload.nonce).toBe(nonce);
      }),
      { numRuns: 100 },
    );
  });
});

// -----------------------------------------------------------------------------
// Error Handling — Failed signature validation (Req 4.5)
// -----------------------------------------------------------------------------

describe('presentCredential — verifier signature-validation failure relay', () => {
  // A disclosure string embedded in the stored SD-JWT VC and echoed by the fake
  // selector so the presentation is well-formed.
  const disclosure = b64url(JSON.stringify(['salt', 'degree', 'BSc Mathematics']));

  const credential: StoredCredential = {
    sessionId: 's1',
    format: 'sd-jwt-vc',
    sdJwtVc: `${issuerSignedJwt}~${disclosure}~`,
    vct: 'EducationCertificate',
  };

  const request: PresentationRequest = {
    verifier: 'http://verifier.test',
    nonce: 'n1',
    requestedClaims: ['degree', 'institution'],
    raw: '{}',
  };

  const selectDisclosures: (
    c: StoredCredential,
    r: PresentationRequest,
  ) => DisclosureSelection = () => ({
    issuerSignedJwt,
    disclosures: [disclosure],
    disclosedClaims: { degree: 'BSc Mathematics', institution: 'University of London' },
  });

  it('relays a verifier signature-validation failure as a verify-step failure', async () => {
    // Fake fetch: the verifier rejects the presentation with HTTP 400 and an
    // OAuth-style error body describing a signature validation failure. This is
    // a non-OK status carrying `error`/`error_description`, so
    // `normalizeVerifierResponse` relays it as a `verify`-step failure.
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: false,
            error: 'invalid_signature',
            error_description: 'issuer signature validation failed',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      );

    const result = await presentCredential(credential, request, {
      holderKey: generateHolderKey(),
      selectDisclosures,
      verifierBaseUrl: 'http://verifier.test',
      fetchImpl: fakeFetch,
    });

    // The failure flows back as a result (not thrown), attributed to `verify`.
    expect(result.success).toBe(false);
    expect(result.error?.step).toBe('verify');
    expect(typeof result.error?.message).toBe('string');
    expect(result.error?.message.length ?? 0).toBeGreaterThan(0);
    // The relayed message reflects the verifier's reported failure.
    expect(result.error?.message).toBe('issuer signature validation failed');
  });

  it('returns success when the verifier accepts the presentation', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const result = await presentCredential(credential, request, {
      holderKey: generateHolderKey(),
      selectDisclosures,
      verifierBaseUrl: 'http://verifier.test',
      fetchImpl: fakeFetch,
    });

    expect(result.success).toBe(true);
  });
});
