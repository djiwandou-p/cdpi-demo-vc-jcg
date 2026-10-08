// disclosureSelector — given a stored Education Certificate SD-JWT VC and a
// verifier `PresentationRequest`, decide which selectively-disclosable claims to
// reveal and which to withhold.
//
// Responsibilities (design: Components -> Wallet Service -> `disclosureSelector`,
// End-to-End Flow -> Presentation):
//   1. Split the stored SD-JWT VC compact serialization into its issuer-signed
//      JWT and the trailing disclosure strings.
//   2. Decode each object-property disclosure (`[salt, claimName, claimValue]`)
//      and keep only those whose claim name appears in the request's
//      `requestedClaims` allow-list (for the demo: `degree`, `institution`).
//      Every non-requested disclosure — notably `grades` — is dropped.
//   3. Hand back the issuer-signed JWT, the selected disclosure strings (so
//      `oid4vpClient` can rebuild the compact SD-JWT VP), and a decoded view of
//      the disclosed claims (`claimName -> value`) for assertions / the UI.
//
// Correctness (design "Correctness Properties" — Property 3, Req 3.2 & 3.3):
//   selection is a strict allow-list filter. A disclosure is included *only if*
//   its claim name is in `requestedClaims`; a non-requested claim can never be
//   revealed. Because the demo request names `degree` and `institution` (and not
//   `grades`), this structurally guarantees `degree`+`institution` are disclosed
//   and `grades` is withheld — the invariant holds by construction, not by a
//   post-hoc check.
//
// SD-JWT VC compact serialization (SD-JWT / SD-JWT VC specs):
//   `<issuer-signed JWT>~<disclosure>*~[<KB-JWT>]`
// Each disclosure is a base64url-encoded JSON array. Object-property disclosures
// are `[salt, claimName, claimValue]` (3 elements); array-element disclosures are
// `[salt, value]` (2 elements) and carry no claim name. Only named
// (object-property) disclosures can be matched against `requestedClaims`; the
// Education Certificate's disclosable attributes are all object properties.
//
// No external dependencies — Node's `Buffer` handles base64url. The input is the
// already-stored credential, so this step performs no network I/O.

import type { PresentationRequest, StoredCredential } from './types.js';

// -----------------------------------------------------------------------------
// Public shapes
// -----------------------------------------------------------------------------

/**
 * A single decoded SD-JWT disclosure plus its original (encoded) string.
 *
 * `encoded` is the exact base64url segment from the compact serialization and is
 * what must be re-appended when assembling a presentation — re-encoding the
 * decoded value is avoided so the disclosure digest the issuer signed over is
 * preserved byte-for-byte.
 */
export interface Disclosure {
  // The exact base64url-encoded disclosure string from the credential.
  encoded: string;
  // The disclosure salt (first array element).
  salt: string;
  // The claim name for an object-property disclosure; `undefined` for an
  // array-element disclosure (which has the shape `[salt, value]`).
  claimName?: string;
  // The disclosed claim value.
  value: unknown;
}

/**
 * The result of applying selective disclosure to a stored credential.
 *
 * `oid4vpClient` rebuilds the SD-JWT VP compact serialization as
 * `issuerJwt` + `~` + each `disclosures[i].encoded` joined by `~` (+ a trailing
 * `~` and the KB-JWT). `disclosedClaims` is the decoded `claimName -> value`
 * view for tests, logging, and the UI.
 */
export interface DisclosureSelection {
  // The issuer-signed JWT (first `~`-separated segment of the stored VC).
  issuerJwt: string;
  // The disclosures selected for presentation, in their original order.
  disclosures: Disclosure[];
  // Just the encoded disclosure strings (convenience for rebuilding the VP).
  selectedDisclosureStrings: string[];
  // Decoded view of what is revealed: claim name -> disclosed value.
  disclosedClaims: Record<string, unknown>;
}

/**
 * Error raised when a stored credential cannot be parsed as an SD-JWT VC for
 * disclosure selection (malformed compact serialization or disclosures).
 */
export class DisclosureSelectionError extends Error {
  override readonly name = 'DisclosureSelectionError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    // Preserve the prototype chain across transpile targets.
    Object.setPrototypeOf(this, DisclosureSelectionError.prototype);
  }
}

// -----------------------------------------------------------------------------
// Selection
// -----------------------------------------------------------------------------

/**
 * Select the disclosures to reveal for a presentation.
 *
 * Given the stored Education Certificate SD-JWT VC and the verifier's
 * `PresentationRequest`, this returns the issuer-signed JWT, the subset of
 * disclosures whose claim name is in `request.requestedClaims`, and a decoded
 * map of the disclosed claims.
 *
 * Selection is a strict allow-list: only requested, named disclosures are kept,
 * so non-requested claims (e.g. `grades`) are always withheld (Property 3,
 * Req 3.2 & 3.3).
 *
 * @param credential the stored SD-JWT VC credential for the session
 * @param request the normalized verifier presentation request
 * @returns the issuer JWT, selected disclosures, and decoded disclosed claims
 * @throws {DisclosureSelectionError} if the credential cannot be parsed
 */
export function selectDisclosures(
  credential: StoredCredential,
  request: PresentationRequest,
): DisclosureSelection {
  const { issuerJwt, disclosures } = parseSdJwtVc(credential.sdJwtVc);

  // Build the allow-list of requested claim names. Non-string / empty entries
  // are ignored defensively; the set makes membership checks O(1).
  const requested = new Set(
    (request.requestedClaims ?? []).filter(
      (name): name is string => typeof name === 'string' && name.length > 0,
    ),
  );

  const selected: Disclosure[] = [];
  const disclosedClaims: Record<string, unknown> = {};

  for (const disclosure of disclosures) {
    // Only named (object-property) disclosures can be matched against the
    // requested-claims allow-list. Array-element disclosures (no claim name)
    // are never revealed here — the Education Certificate's disclosables are
    // all object properties, so this does not withhold any requested claim.
    if (disclosure.claimName === undefined) {
      continue;
    }
    // Allow-list filter — this is the structural guarantee behind Property 3.
    if (!requested.has(disclosure.claimName)) {
      continue;
    }
    selected.push(disclosure);
    disclosedClaims[disclosure.claimName] = disclosure.value;
  }

  return {
    issuerJwt,
    disclosures: selected,
    selectedDisclosureStrings: selected.map((d) => d.encoded),
    disclosedClaims,
  };
}

// -----------------------------------------------------------------------------
// SD-JWT VC parsing
// -----------------------------------------------------------------------------

interface ParsedSdJwtVc {
  issuerJwt: string;
  disclosures: Disclosure[];
}

/**
 * Split a compact SD-JWT VC into its issuer-signed JWT and decoded disclosures.
 *
 * The serialization is `<issuer JWT>~<disclosure>*~[<KB-JWT>]`. The first
 * segment is the issuer JWT (three dot-separated parts). A trailing segment that
 * is itself a compact JWT is a key-binding JWT and is NOT a disclosure, so it is
 * excluded from the disclosure list. Any empty segment (from a trailing `~`) is
 * skipped.
 *
 * @throws {DisclosureSelectionError} if the issuer JWT is missing/malformed.
 */
function parseSdJwtVc(sdJwtVc: string): ParsedSdJwtVc {
  if (typeof sdJwtVc !== 'string' || sdJwtVc.trim().length === 0) {
    throw new DisclosureSelectionError('Stored SD-JWT VC is empty.');
  }

  const segments = sdJwtVc.trim().split('~');
  const issuerJwt = segments[0];
  if (issuerJwt === undefined || !isCompactJwt(issuerJwt)) {
    throw new DisclosureSelectionError(
      'Stored SD-JWT VC does not start with a valid issuer-signed JWT.',
    );
  }

  // Everything after the issuer JWT is either a disclosure or a trailing
  // key-binding JWT. A KB-JWT, when present, is the final non-empty segment and
  // has the `header.payload.signature` compact-JWT shape; disclosures are
  // single base64url tokens with no dots.
  const trailing = segments.slice(1);
  const disclosures: Disclosure[] = [];

  for (const segment of trailing) {
    if (segment.length === 0) {
      // Empty segment (e.g. from the trailing `~`); nothing to decode.
      continue;
    }
    if (isCompactJwt(segment)) {
      // A key-binding JWT, not a disclosure — skip it.
      continue;
    }
    disclosures.push(decodeDisclosure(segment));
  }

  return { issuerJwt, disclosures };
}

/**
 * Decode a single base64url disclosure string into a `Disclosure`.
 *
 * Object-property disclosures decode to `[salt, claimName, claimValue]`;
 * array-element disclosures to `[salt, value]`. The original encoded string is
 * retained so a presentation can reuse it verbatim.
 *
 * @throws {DisclosureSelectionError} if the segment is not a valid disclosure.
 */
function decodeDisclosure(encoded: string): Disclosure {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (cause) {
    throw new DisclosureSelectionError(
      'SD-JWT disclosure is not valid base64url-encoded JSON.',
      { cause },
    );
  }

  if (!Array.isArray(decoded) || decoded.length < 2 || decoded.length > 3) {
    throw new DisclosureSelectionError(
      'SD-JWT disclosure must be a JSON array of 2 (array element) or 3 (object property) items.',
    );
  }

  const salt = decoded[0];
  if (typeof salt !== 'string') {
    throw new DisclosureSelectionError(
      'SD-JWT disclosure salt must be a string.',
    );
  }

  if (decoded.length === 3) {
    // Object-property disclosure: [salt, claimName, claimValue].
    const claimName = decoded[1];
    if (typeof claimName !== 'string' || claimName.length === 0) {
      throw new DisclosureSelectionError(
        'SD-JWT object-property disclosure must have a string claim name.',
      );
    }
    return { encoded, salt, claimName, value: decoded[2] };
  }

  // Array-element disclosure: [salt, value]; no claim name.
  return { encoded, salt, value: decoded[1] };
}

/**
 * True when a segment looks like a compact JWT (`header.payload.signature`):
 * exactly three non-empty dot-separated parts. Disclosures never contain dots,
 * so this cleanly distinguishes a trailing key-binding JWT from a disclosure.
 */
function isCompactJwt(segment: string): boolean {
  const parts = segment.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}
