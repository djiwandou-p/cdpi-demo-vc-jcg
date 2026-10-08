// Tests for the `oid4vciClient` module (walt.id VC end-to-end demo).
//
// Coverage maps to design.md "Correctness Properties" and "Error Handling":
//   - Property 1 ("Education Certificate carries all four attributes", Req 1.3):
//     a property-based test over arbitrary non-empty subjects proving the
//     assembled claim set always carries the `vct` plus all four attributes.
//   - "Error Handling — Unsupported credential type" (Req 1.5): a unit test
//     driving the pre-authorized code flow with an injected fake `fetch` that
//     returns an OpenID4VCI `unsupported_credential_type` error on the
//     credential step, asserting it is mapped to an `Oid4vciError` tagged with
//     the failing step and the protocol error code.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  buildEducationClaimSet,
  EDUCATION_CERTIFICATE_ATTRIBUTES,
  runPreAuthorizedCodeFlow,
  Oid4vciError,
  type EducationCertificateSubject,
} from '../src/oid4vciClient.js';
import type { CredentialOffer } from '../src/types.js';

// -----------------------------------------------------------------------------
// Property 1 — Education Certificate carries all four attributes (Req 1.3)
// -----------------------------------------------------------------------------

describe('buildEducationClaimSet', () => {
  it('Feature: waltid-vc-e2e-demo, Property 1: Education Certificate carries all four attributes', () => {
    // Non-empty string generator — the four attributes must be present and
    // non-empty, matching the input space `buildEducationClaimSet` accepts.
    const nonEmptyString = fc.string({ minLength: 1 }).filter((s) => s.length > 0);

    fc.assert(
      fc.property(
        nonEmptyString,
        nonEmptyString,
        nonEmptyString,
        nonEmptyString,
        (name, degree, institution, grades) => {
          const subject: EducationCertificateSubject = {
            name,
            degree,
            institution,
            grades,
          };

          const claimSet = buildEducationClaimSet(subject);

          // The assembled claim set carries the stable Education Certificate vct.
          expect(claimSet.vct).toBe('EducationCertificate');

          // Each of the four attributes is present as a key with the exact value.
          expect(claimSet.name).toBe(name);
          expect(claimSet.degree).toBe(degree);
          expect(claimSet.institution).toBe(institution);
          expect(claimSet.grades).toBe(grades);

          // Every declared attribute name is a key on the result (four-attribute
          // invariant, independent of input ordering).
          for (const attribute of EDUCATION_CERTIFICATE_ATTRIBUTES) {
            expect(Object.prototype.hasOwnProperty.call(claimSet, attribute)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('throws TypeError when an attribute is missing or empty', () => {
    const incomplete = {
      name: 'Ada Lovelace',
      degree: 'BSc Mathematics',
      institution: 'University of London',
      grades: '', // empty — violates the four-attribute invariant
    } as EducationCertificateSubject;

    expect(() => buildEducationClaimSet(incomplete)).toThrow(TypeError);
  });
});

// -----------------------------------------------------------------------------
// Error Handling — Unsupported credential type (Req 1.5)
// -----------------------------------------------------------------------------

describe('runPreAuthorizedCodeFlow — unsupported credential type error mapping', () => {
  it('maps an OpenID4VCI unsupported_credential_type credential error to Oid4vciError (step credential)', async () => {
    const jsonHeaders = { 'content-type': 'application/json' };

    // Fake fetch: route by URL path. The token call succeeds; the credential
    // call returns an OpenID4VCI error. No real network is used.
    const fakeFetch: typeof fetch = (input, _init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.endsWith('/token')) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'tok', c_nonce: 'n' }), {
            status: 200,
            headers: jsonHeaders,
          }),
        );
      }

      if (url.endsWith('/credential')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: 'unsupported_credential_type',
              error_description: 'The requested credential type is not supported.',
            }),
            { status: 400, headers: jsonHeaders },
          ),
        );
      }

      return Promise.reject(new Error(`unexpected request to ${url}`));
    };

    const offer: CredentialOffer = {
      issuer: 'http://issuer.test',
      preAuthorizedCode: 'pac',
      credentialConfigurationIds: ['Unknown'],
      raw: '{}',
    };

    const promise = runPreAuthorizedCodeFlow(offer, {
      sessionId: 's1',
      fetchImpl: fakeFetch,
    });

    await expect(promise).rejects.toBeInstanceOf(Oid4vciError);

    try {
      await promise;
      // Should not reach here — the flow must reject.
      expect.unreachable('runPreAuthorizedCodeFlow should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(Oid4vciError);
      const oid4vciError = error as Oid4vciError;
      expect(oid4vciError.step).toBe('credential');
      expect(oid4vciError.code).toBe('unsupported_credential_type');
      expect(oid4vciError.status).toBe(400);
    }
  });
});
