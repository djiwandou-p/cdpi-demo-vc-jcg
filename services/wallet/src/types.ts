// Internal wallet types for the walt.id VC end-to-end demo.
// These mirror the design document's "Internal Wallet Types (structured)" section
// and are the canonical shapes shared across the wallet BFF modules
// (offerIntake, oid4vciClient, holderKeys, sessionStore, disclosureSelector, oid4vpClient, httpApi).

// Canonical, parser-agnostic offer after normalizing paste/scan input.
export interface CredentialOffer {
  issuer: string; // issuer base URL / credential_issuer
  preAuthorizedCode: string; // pre-authorized_code grant value
  credentialConfigurationIds: string[];
  raw: string; // original offer string
}

// Server-side, session-scoped stored credential.
export interface StoredCredential {
  sessionId: string;
  format: 'sd-jwt-vc';
  sdJwtVc: string; // raw SD-JWT VC (compact serialization)
  vct: string;
}

// Verifier presentation request after normalization.
export interface PresentationRequest {
  verifier: string;
  nonce: string; // challenge the presentation must bind to
  requestedClaims: string[]; // e.g. ["degree", "institution"]
  raw: string;
}

export interface VerificationResult {
  success: boolean;
  disclosedClaims?: Record<string, unknown>;
  error?: { step: string; message: string };
}
