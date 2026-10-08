// Property test for the wallet session store.
//
// Design reference: design.md "Correctness Properties" -> Property 2
// (Credential storage round-trip). Validates Requirements 2.2: a credential
// stored for a session can be retrieved unchanged for the duration of that
// session.
//
// Property 2 (storage round-trip): for a fresh store, after store(cred),
// retrieve(cred.sessionId) returns a StoredCredential deep-equal to the one
// stored, so the raw SD-JWT VC round-trips unchanged.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { createSessionStore } from '../src/sessionStore.js';
import type { StoredCredential } from '../src/types.js';

// Smart generator constrained to the StoredCredential input space:
// - non-empty sessionId (keys must be usable session identifiers)
// - arbitrary sdJwtVc string (represents the raw compact SD-JWT VC)
// - arbitrary vct string
// - format fixed to the only supported value
const storedCredentialArb: fc.Arbitrary<StoredCredential> = fc.record({
  sessionId: fc.string({ minLength: 1 }),
  format: fc.constant('sd-jwt-vc' as const),
  sdJwtVc: fc.string(),
  vct: fc.string(),
});

describe('sessionStore', () => {
  it('Feature: waltid-vc-e2e-demo, Property 2: Credential storage round-trip', () => {
    fc.assert(
      fc.property(storedCredentialArb, (cred) => {
        // Fresh store per iteration keeps iterations isolated.
        const store = createSessionStore();

        store.store(cred);

        // The retrieved credential must deep-equal the stored one, meaning the
        // same sdJwtVc (and all other fields) round-trips unchanged.
        expect(store.retrieve(cred.sessionId)).toEqual(cred);
      }),
      { numRuns: 100 },
    );
  });

  it('returns undefined for a sessionId that was never stored', () => {
    const store = createSessionStore();
    expect(store.retrieve('never-stored')).toBeUndefined();
  });

  it('overwrites: storing twice under the same sessionId returns the latest', () => {
    const store = createSessionStore();

    const first: StoredCredential = {
      sessionId: 'session-overwrite',
      format: 'sd-jwt-vc',
      sdJwtVc: 'first.sd-jwt.vc',
      vct: 'DegreeCredential',
    };
    const second: StoredCredential = {
      sessionId: 'session-overwrite',
      format: 'sd-jwt-vc',
      sdJwtVc: 'second.sd-jwt.vc',
      vct: 'DegreeCredential',
    };

    store.store(first);
    store.store(second);

    expect(store.retrieve('session-overwrite')).toEqual(second);
  });
});
