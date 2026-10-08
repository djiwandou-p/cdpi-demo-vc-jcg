// offerIntake — normalize an OpenID4VCI credential offer into the canonical
// `CredentialOffer` shape used across the wallet BFF.
//
// Paste and scan inputs are both plain strings, so they flow through a single
// normalization path (`normalizeOffer`); this guarantees they produce identical
// results (design "Correctness Properties" — Property 4: paste/scan equivalence).
//
// Normalization is purely local and fails fast: a string that cannot be parsed
// into a valid credential offer is rejected with `InvalidOfferError` before any
// network round-trip is attempted (design "Error Handling — Invalid offer",
// Property 5: unparseable offers are rejected).

import type { CredentialOffer } from './types.js';

/**
 * Error raised when an input string cannot be normalized into a valid
 * OpenID4VCI credential offer. Callers (e.g. `httpApi`) map this to a 400 and a
 * user-facing "invalid offer" message, leaving stored credential state untouched.
 */
export class InvalidOfferError extends Error {
  override readonly name = 'InvalidOfferError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    // Preserve the prototype chain when targeting older runtimes / transpilers.
    Object.setPrototypeOf(this, InvalidOfferError.prototype);
  }
}

// The OpenID4VCI custom scheme that carries a credential offer in a deep link / QR.
const OFFER_URI_SCHEME = 'openid-credential-offer://';

// The pre-authorized code grant identifier defined by OpenID4VCI.
const PRE_AUTHORIZED_CODE_GRANT =
  'urn:ietf:params:oauth:grant-type:pre-authorized_code';

// Minimal structural view of an OpenID4VCI credential offer object. Only the
// fields the wallet needs are modelled; unknown fields are ignored.
interface RawCredentialOffer {
  credential_issuer?: unknown;
  credential_configuration_ids?: unknown;
  grants?: unknown;
}

/**
 * Normalize a pasted or scanned credential-offer string into a canonical
 * `CredentialOffer`.
 *
 * Accepts either:
 *  - an `openid-credential-offer://` URI carrying the offer by value in the
 *    `credential_offer` query parameter (URL-encoded JSON), or
 *  - a raw OpenID4VCI credential offer JSON object as a string.
 *
 * By-reference offers (`credential_offer_uri`) require a network fetch to
 * resolve and so cannot be normalized by this fail-fast, offline step; they are
 * rejected with `InvalidOfferError`.
 *
 * @param input the raw offer string from paste or scan
 * @returns the canonical offer
 * @throws {InvalidOfferError} if the input cannot be parsed into a valid offer
 */
export function normalizeOffer(input: string): CredentialOffer {
  if (typeof input !== 'string') {
    throw new InvalidOfferError('Offer input must be a string.');
  }

  const raw = input.trim();
  if (raw.length === 0) {
    throw new InvalidOfferError('Offer input is empty.');
  }

  const offerObject = parseOfferObject(raw);
  const issuer = requireNonEmptyString(
    offerObject.credential_issuer,
    'credential_issuer',
  );
  const credentialConfigurationIds = requireConfigurationIds(
    offerObject.credential_configuration_ids,
  );
  const preAuthorizedCode = requirePreAuthorizedCode(offerObject.grants);

  return {
    issuer,
    preAuthorizedCode,
    credentialConfigurationIds,
    // Preserve the exact original input so downstream steps / logs can refer
    // back to what the user supplied.
    raw,
  };
}

/**
 * Extract the credential offer JSON object from either an
 * `openid-credential-offer://` URI (by value) or a raw JSON string.
 */
function parseOfferObject(raw: string): RawCredentialOffer {
  const jsonSource = isOfferUri(raw) ? extractOfferJsonFromUri(raw) : raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSource);
  } catch (cause) {
    throw new InvalidOfferError(
      'Offer is not a valid credential offer URI or JSON object.',
      { cause },
    );
  }

  if (!isObject(parsed)) {
    throw new InvalidOfferError('Offer must be a JSON object.');
  }

  return parsed;
}

function isOfferUri(raw: string): boolean {
  return raw.toLowerCase().startsWith(OFFER_URI_SCHEME);
}

/**
 * Pull the by-value `credential_offer` parameter out of an
 * `openid-credential-offer://` URI and return its decoded JSON text.
 */
function extractOfferJsonFromUri(raw: string): string {
  const queryIndex = raw.indexOf('?');
  if (queryIndex === -1) {
    throw new InvalidOfferError(
      'Credential offer URI has no query parameters.',
    );
  }

  const params = new URLSearchParams(raw.slice(queryIndex + 1));

  if (params.has('credential_offer_uri')) {
    throw new InvalidOfferError(
      'By-reference credential offers (credential_offer_uri) are not supported; provide the offer by value.',
    );
  }

  const byValue = params.get('credential_offer');
  if (byValue === null || byValue.trim().length === 0) {
    throw new InvalidOfferError(
      'Credential offer URI is missing the credential_offer parameter.',
    );
  }

  // URLSearchParams already percent-decodes values.
  return byValue;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidOfferError(`Offer is missing a valid "${field}".`);
  }
  return value;
}

function requireConfigurationIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((id) => typeof id === 'string' && id.trim().length > 0)
  ) {
    throw new InvalidOfferError(
      'Offer is missing a valid "credential_configuration_ids" array.',
    );
  }
  return [...value];
}

/**
 * Resolve the pre-authorized code from the offer's `grants` map. The wallet
 * drives the pre-authorized code flow, so an offer without this grant cannot be
 * processed.
 */
function requirePreAuthorizedCode(grants: unknown): string {
  if (!isObject(grants)) {
    throw new InvalidOfferError('Offer is missing a valid "grants" object.');
  }

  const grant = grants[PRE_AUTHORIZED_CODE_GRANT];
  if (!isObject(grant)) {
    throw new InvalidOfferError(
      'Offer does not contain a pre-authorized_code grant.',
    );
  }

  return requireNonEmptyString(
    grant['pre-authorized_code'],
    'pre-authorized_code',
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
