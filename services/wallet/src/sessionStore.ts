// sessionStore module for the walt.id VC end-to-end demo.
//
// In-memory, session-scoped storage of the raw SD-JWT VC keyed by session id.
// There is no persistence beyond the lifetime of the process/session: credentials
// live only in the Map below and are lost on restart. This backs the wallet BFF's
// "store the issued credential for the duration of the session" behavior
// (design: Components -> Wallet Service -> sessionStore; Requirements 2.2) and
// supports Property 2 (storage round-trip): retrieving a stored SD-JWT VC from the
// same session returns an SD-JWT VC equal to the one stored.

import type { StoredCredential } from './types.js';

export interface SessionStore {
  // Store a credential for its session. Overwrites any credential previously
  // stored under the same session id.
  store(credential: StoredCredential): void;

  // Retrieve the credential stored for the given session, or undefined if none.
  retrieve(sessionId: string): StoredCredential | undefined;

  // Remove the credential for a single session. Returns true if one was removed.
  clear(sessionId: string): boolean;

  // Remove all stored credentials (e.g. for test isolation).
  clearAll(): void;
}

// Create a fresh in-memory session store. Each instance owns its own Map, so
// callers can use a shared singleton for the running server or isolated
// instances in tests.
export function createSessionStore(): SessionStore {
  const credentialsBySession = new Map<string, StoredCredential>();

  return {
    store(credential: StoredCredential): void {
      credentialsBySession.set(credential.sessionId, credential);
    },

    retrieve(sessionId: string): StoredCredential | undefined {
      return credentialsBySession.get(sessionId);
    },

    clear(sessionId: string): boolean {
      return credentialsBySession.delete(sessionId);
    },

    clearAll(): void {
      credentialsBySession.clear();
    },
  };
}
