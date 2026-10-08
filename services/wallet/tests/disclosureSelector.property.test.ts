// Property-based test for the `disclosureSelector` module (walt.id VC end-to-end demo).
//
// Maps to design.md "Correctness Properties" — Property 3 (Req 3.2 & 3.3):
//   Selective disclosure reveals the requested claims (`degree`, `institution`)
//   and withholds everything that was not requested (notably `grades`, and also
//   `name` since it is not in the demo request). Selection is a strict allow-list
//   keyed on the disclosure claim name, so the guarantee holds structurally for
//   any disclosed values — demonstrated here across arbitrary generated values.
//
// The `selectDisclosures` function only parses the compact SD-JWT VC
// serialization (no crypto), so the test builds a structurally-valid SD-JWT VC:
//   `<issuer JWT>~<disclosure>*~[<KB-JWT>]`
// where the issuer JWT and optional KB-JWT are dummy 3-part dotted tokens and each
// disclosure is `base64url(JSON.stringify([salt, claimName, claimValue]))`.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { selectDisclosures } from '../src/disclosureSelector.js';
import type { PresentationRequest, StoredCredential } from '../src/types.js';

// -----------------------------------------------------------------------------
// SD-JWT VC construction helpers (no real crypto — the selector only parses)
// -----------------------------------------------------------------------------

/** base64url-encode a UTF-8 string via Node's Buffer. */
function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/**
 * A dummy but structurally-valid compact JWT: three non-empty base64url
 * segments joined by dots (`header.payload.signature`).
 */
function dummyJwt(payloadJson: string): string {
  return `${b64url('{"alg":"EdDSA"}')}.${b64url(payloadJson)}.${b64url('sig')}`;
}

/** Encode one object-property disclosure: base64url(JSON.stringify([salt, claimName, value])). */
function encodeDisclosure(salt: string, claimName: string, value: unknown): string {
  return b64url(JSON.stringify([salt, claimName, value]));
}

interface BuiltVc {
  issuerJwt: string;
  sdJwtVc: string;
  /** Encoded disclosure string per claim name, in insertion order. */
  encodedByClaim: Record<string, string>;
}

/**
 * Build a compact SD-JWT VC embedding one object-property disclosure per entry
 * in `claims`. Optionally appends a dummy key-binding JWT after the final `~` to
 * prove the selector ignores it.
 */
function buildSdJwtVc(
  claims: Array<{ name: string; value: unknown }>,
  options: { appendKbJwt?: boolean } = {},
): BuiltVc {
  const issuerJwt = dummyJwt('{"vct":"EducationCertificate","_sd":[]}');

  const encodedByClaim: Record<string, string> = {};
  const encoded: string[] = [];
  claims.forEach((claim, i) => {
    const salt = `salt-${i}`;
    const d = encodeDisclosure(salt, claim.name, claim.value);
    encodedByClaim[claim.name] = d;
    encoded.push(d);
  });

  // `<issuer JWT>~<disclosure>*~` (trailing `~`), with optional KB-JWT after it.
  let sdJwtVc = `${issuerJwt}~${encoded.join('~')}~`;
  if (options.appendKbJwt) {
    sdJwtVc += dummyJwt('{"nonce":"kb","aud":"verifier"}');
  }

  return { issuerJwt, sdJwtVc, encodedByClaim };
}

function makeCredential(sdJwtVc: string): StoredCredential {
  return { sessionId: 'session-1', format: 'sd-jwt-vc', sdJwtVc, vct: 'EducationCertificate' };
}

function makeRequest(requestedClaims: string[], nonce: string, verifier = 'https://verifier.example', raw = 'raw'): PresentationRequest {
  return { verifier, nonce, requestedClaims, raw };
}

// -----------------------------------------------------------------------------
// Property 3 — Selective disclosure reveals degree & institution, withholds grades
// -----------------------------------------------------------------------------

describe('selectDisclosures', () => {
  it('Feature: waltid-vc-e2e-demo, Property 3: Selective disclosure reveals degree and institution and withholds grades', () => {
    // Non-empty strings excluding `~` (the SD-JWT segment separator) so the
    // generated values never corrupt the compact serialization. The property
    // under test is the allow-list selection, not `~` escaping.
    const claimValue = fc
      .string({ minLength: 1 })
      .filter((s) => s.length > 0 && !s.includes('~'));
    const nonEmpty = fc.string({ minLength: 1 }).filter((s) => s.length > 0);

    fc.assert(
      fc.property(
        claimValue, // name
        claimValue, // degree
        claimValue, // institution
        claimValue, // grades
        nonEmpty, // nonce
        (name, degree, institution, grades, nonce) => {
          // Credential embeds disclosures for ALL FOUR Education Certificate claims.
          const built = buildSdJwtVc([
            { name: 'name', value: name },
            { name: 'degree', value: degree },
            { name: 'institution', value: institution },
            { name: 'grades', value: grades },
          ]);
          const credential = makeCredential(built.sdJwtVc);

          // Demo verifier request: reveal degree + institution only.
          const request = makeRequest(['degree', 'institution'], nonce);

          const result = selectDisclosures(credential, request);

          // Req 3.2 — degree & institution revealed with their exact values; and
          // Req 3.3 — grades & name withheld. Comparing the whole object both
          // asserts the revealed values and that no other claim is present.
          expect(result.disclosedClaims).toEqual({ degree, institution });

          // Exactly the degree + institution encoded disclosure strings, and not
          // the grades/name ones.
          expect(result.selectedDisclosureStrings).toHaveLength(2);
          expect(result.selectedDisclosureStrings).toContain(built.encodedByClaim.degree);
          expect(result.selectedDisclosureStrings).toContain(built.encodedByClaim.institution);
          expect(result.selectedDisclosureStrings).not.toContain(built.encodedByClaim.grades);
          expect(result.selectedDisclosureStrings).not.toContain(built.encodedByClaim.name);

          // The issuer-signed JWT is preserved verbatim.
          expect(result.issuerJwt).toBe(built.issuerJwt);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Concise extra cases demonstrating the allow-list for other request shapes.
  it('reveals only grades when grades is requested, and nothing when the request is empty', () => {
    const built = buildSdJwtVc(
      [
        { name: 'name', value: 'Ada Lovelace' },
        { name: 'degree', value: 'BSc Mathematics' },
        { name: 'institution', value: 'Analytical University' },
        { name: 'grades', value: 'A+' },
      ],
      { appendKbJwt: true }, // prove a trailing KB-JWT is ignored, not disclosed
    );
    const credential = makeCredential(built.sdJwtVc);

    // requestedClaims = ['grades'] reveals only grades.
    const gradesOnly = selectDisclosures(credential, makeRequest(['grades'], 'n1'));
    expect(gradesOnly.disclosedClaims).toEqual({ grades: 'A+' });
    expect(gradesOnly.selectedDisclosureStrings).toEqual([built.encodedByClaim.grades]);

    // requestedClaims = [] reveals nothing.
    const none = selectDisclosures(credential, makeRequest([], 'n2'));
    expect(none.disclosedClaims).toEqual({});
    expect(none.selectedDisclosureStrings).toEqual([]);
    // The KB-JWT is never treated as a disclosure.
    expect(none.issuerJwt).toBe(built.issuerJwt);
  });
});
