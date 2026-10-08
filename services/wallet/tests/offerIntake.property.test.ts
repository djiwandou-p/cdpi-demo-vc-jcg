// Property tests for the offerIntake module.
//
// These validate two of the design document's "Correctness Properties"
// (.kiro/specs/waltid-vc-e2e-demo/design.md):
//
//   Property 4 — Paste and scan intake are equivalent (Requirement 2.4):
//     Paste and scan inputs are both plain strings and flow through the single
//     `normalizeOffer` path, so the same offer expressed as raw JSON (paste) or
//     as an `openid-credential-offer://` by-value URI (scan) must yield the same
//     canonical offer (modulo the `raw` field, which preserves the exact input).
//
//   Property 5 — Unparseable offers are rejected (Requirement 2.5):
//     Any input that is not a well-formed, by-value credential offer is rejected
//     with `InvalidOfferError` before any network round-trip (fail fast).
//
// Framework: vitest 3.2.4. Property testing: fast-check 3.23.2. ESM + strict TS.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { normalizeOffer, InvalidOfferError } from '../src/offerIntake.js';

const PRE_AUTHORIZED_CODE_GRANT =
  'urn:ietf:params:oauth:grant-type:pre-authorized_code';
const OFFER_URI_SCHEME = 'openid-credential-offer://';

// A non-empty, JSON/URI round-trip-safe token: alphanumerics only, so it never
// collides with the offer-URI scheme, never introduces control characters, and
// survives `encodeURIComponent` / `URLSearchParams` decoding unchanged.
const safeToken = (): fc.Arbitrary<string> =>
  fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(
          '',
        ),
      ),
      { minLength: 1, maxLength: 24 },
    )
    .filter((s) => s.trim().length > 0);

interface ValidOfferParts {
  issuer: string;
  configurationIds: string[];
  preAuthorizedCode: string;
}

const validOfferParts = (): fc.Arbitrary<ValidOfferParts> =>
  fc.record({
    // URL-ish issuer identifier built from safe tokens.
    issuer: safeToken().map((host) => `https://${host}.example.com`),
    configurationIds: fc.array(safeToken(), { minLength: 1, maxLength: 4 }),
    preAuthorizedCode: safeToken(),
  });

// Build the canonical OpenID4VCI credential-offer JSON object string.
function buildOfferJson(parts: ValidOfferParts): string {
  return JSON.stringify({
    credential_issuer: parts.issuer,
    credential_configuration_ids: parts.configurationIds,
    grants: {
      [PRE_AUTHORIZED_CODE_GRANT]: {
        'pre-authorized_code': parts.preAuthorizedCode,
      },
    },
  });
}

describe('offerIntake property tests', () => {
  it('Feature: waltid-vc-e2e-demo, Property 4: Paste and scan intake are equivalent', () => {
    fc.assert(
      fc.property(validOfferParts(), (parts) => {
        const offerJson = buildOfferJson(parts);

        // paste input = raw offer JSON string.
        const pasteInput = offerJson;
        // scan input = by-value offer URI carrying the same JSON.
        const scanInput = `${OFFER_URI_SCHEME}?credential_offer=${encodeURIComponent(
          offerJson,
        )}`;

        const pasted = normalizeOffer(pasteInput);
        const scanned = normalizeOffer(scanInput);

        // Semantic fields must be identical across both intake paths.
        expect(scanned.issuer).toBe(pasted.issuer);
        expect(scanned.preAuthorizedCode).toBe(pasted.preAuthorizedCode);
        expect(scanned.credentialConfigurationIds).toEqual(
          pasted.credentialConfigurationIds,
        );

        // And they must match what we put in.
        expect(pasted.issuer).toBe(parts.issuer);
        expect(pasted.preAuthorizedCode).toBe(parts.preAuthorizedCode);
        expect(pasted.credentialConfigurationIds).toEqual(parts.configurationIds);

        // The `raw` field legitimately differs: it preserves the original input.
        expect(pasted.raw).toBe(pasteInput);
        expect(scanned.raw).toBe(scanInput);
      }),
      { numRuns: 100 },
    );
  });

  it('Feature: waltid-vc-e2e-demo, Property 5: Unparseable offers are rejected', () => {
    // JSON object missing a required field (so it can never be a valid offer).
    const missingFieldOffer: fc.Arbitrary<string> = fc
      .record(
        {
          credential_issuer: safeToken().map((h) => `https://${h}.example.com`),
          credential_configuration_ids: fc.array(safeToken(), {
            minLength: 1,
            maxLength: 3,
          }),
          grants: fc.constant({
            [PRE_AUTHORIZED_CODE_GRANT]: {
              'pre-authorized_code': 'code-123',
            },
          }),
        },
        // Make at least one required key absent on every generated object.
        { requiredKeys: [] },
      )
      .filter(
        (o) =>
          o.credential_issuer === undefined ||
          o.credential_configuration_ids === undefined ||
          o.grants === undefined,
      )
      .map((o) => JSON.stringify(o));

    const badInput: fc.Arbitrary<string> = fc.oneof(
      // Arbitrary free-form strings (most are not JSON at all).
      fc.string(),
      // Empty / whitespace-only strings.
      fc.constantFrom('', '   ', '\t', '\n', '  \n  '),
      // Non-offer JSON objects: missing a required field.
      missingFieldOffer,
      // JSON that parses to a non-object (arrays, primitives).
      fc
        .array(safeToken(), { maxLength: 4 })
        .map((a) => JSON.stringify(a)),
      fc.constantFrom('null', 'true', '42', '"just a string"', '[]', '{}'),
      // Offer object with an empty configuration-ids array (invalid).
      fc.constant(
        JSON.stringify({
          credential_issuer: 'https://issuer.example.com',
          credential_configuration_ids: [],
          grants: {
            [PRE_AUTHORIZED_CODE_GRANT]: { 'pre-authorized_code': 'c' },
          },
        }),
      ),
      // Offer object whose grants lack the pre-authorized_code grant.
      fc.constant(
        JSON.stringify({
          credential_issuer: 'https://issuer.example.com',
          credential_configuration_ids: ['cfg'],
          grants: { 'authorization_code': {} },
        }),
      ),
      // By-reference offer URI (credential_offer_uri) — unsupported, rejected.
      safeToken().map(
        (ref) =>
          `${OFFER_URI_SCHEME}?credential_offer_uri=${encodeURIComponent(
            `https://${ref}.example.com/offer`,
          )}`,
      ),
      // Offer URI with no query string at all.
      fc.constant(OFFER_URI_SCHEME),
      // Offer URI missing the credential_offer parameter.
      fc.constant(`${OFFER_URI_SCHEME}?foo=bar`),
    );

    fc.assert(
      fc.property(badInput, (bad) => {
        expect(() => normalizeOffer(bad)).toThrow(InvalidOfferError);
      }),
      { numRuns: 100 },
    );
  });
});
