// oid4vpClient — produce an OpenID4VP presentation (SD-JWT VP) from a stored
// Education Certificate and submit it to the verifier, normalizing the outcome
// into a `VerificationResult`.
//
// Responsibilities (design: Components -> Wallet Service -> `oid4vpClient`,
// End-to-End Flow -> Presentation):
//   1. Build the SD-JWT VP — concatenate the issuer-signed JWT, the selected
//      disclosures (reveal `degree` + `institution`, drop `grades`), and a
//      key-binding JWT (KB-JWT) bound to the presentation request `nonce`
//      (challenge binding, Req 3.4 / Property 6) with `aud` = the verifier.
//   2. Submit — assemble the OpenID4VP authorization response carrying the
//      `vp_token` and POST it to the verifier (`request.verifier`, falling back
//      to `VERIFIER_BASE_URL`), using Node 20's built-in `fetch` (injectable for
//      tests via `fetchImpl`, mirroring `oid4vciClient`).
//   3. Normalize — parse the verifier response into a `VerificationResult`. A
//      verifier failure (e.g. signature validation failure, Req 4.5) is relayed
//      as `{ success: false, error: { step: 'verify', message } }` rather than
//      thrown — the task requires failures to flow back as a result the UI/
//      integration test can read and attribute to the `verify` step.
//
// SD-JWT VP compact serialization (SD-JWT VC §Key Binding JWT):
//   `<issuer-signed JWT>~<disclosure>*~<KB-JWT>`
// The KB-JWT carries an `sd_hash`: the base64url SHA-256 digest over the VP
// *presentation* string up to and including the trailing `~` that precedes the
// KB-JWT, binding the key-binding proof to the exact set of revealed disclosures.
//
// Integration with `disclosureSelector` (task 7.1, implemented in parallel):
//   This module consumes a `DisclosureSelection` — the issuer-signed JWT, the
//   ordered selected disclosure strings (degree, institution; grades dropped),
//   and a decoded `disclosedClaims` map. The expected selector contract is
//   captured locally as `SelectDisclosures` / `DisclosureSelection` so this
//   module compiles independently; at the checkpoint, reconcile these against
//   `disclosureSelector.ts`'s real export (import from `./disclosureSelector.js`)
//   — the field names below (`issuerSignedJwt`, `disclosures`, `disclosedClaims`)
//   are the integration surface to align on. The selector can be injected via
//   `selectDisclosures` (defaults are resolved by the caller / httpApi which
//   wires in the real selector).

import { createHash } from 'node:crypto';

import { buildKeyBindingJwt, type HolderKey } from './holderKeys.js';
import type {
  PresentationRequest,
  StoredCredential,
  VerificationResult,
} from './types.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// JOSE `typ` for the SD-JWT VC key-binding JWT.
const KB_JWT_TYP = 'kb+jwt';

// The single logical step this module attributes failures to in a
// `VerificationResult` (design "Error Handling", Req 4.5).
const VERIFY_STEP = 'verify';

// -----------------------------------------------------------------------------
// disclosureSelector contract (expected interface — see header note)
// -----------------------------------------------------------------------------

/**
 * The result of selecting which disclosures to reveal for a presentation.
 *
 * This mirrors the expected `disclosureSelector` (task 7.1) output so this
 * module type-checks on its own. Reconcile field names with the real module at
 * the integration checkpoint.
 */
export interface DisclosureSelection {
  // The issuer-signed JWT (first `~`-separated segment of the stored SD-JWT VC).
  issuerSignedJwt: string;
  // The disclosure strings to reveal, in presentation order (degree, institution).
  // `grades` is dropped by the selector and therefore absent here.
  disclosures: string[];
  // The decoded claims the selected disclosures reveal, e.g.
  // `{ degree, institution }`. Surfaced on a successful `VerificationResult`.
  disclosedClaims: Record<string, unknown>;
}

/**
 * The disclosure-selection function contract: given a stored credential and the
 * presentation request, return the issuer-signed JWT, the disclosures to reveal,
 * and the decoded disclosed claims (design: `disclosureSelector`; Property 3).
 */
export type SelectDisclosures = (
  credential: StoredCredential,
  request: PresentationRequest,
) => DisclosureSelection;

// -----------------------------------------------------------------------------
// Public shapes
// -----------------------------------------------------------------------------

// Options for `presentCredential`.
export interface Oid4vpClientOptions {
  // The holder key that owns the credential binding — used to sign the KB-JWT.
  // The same key generated during issuance (`Oid4vciResult.holderKey`).
  holderKey: HolderKey;
  // The disclosure selector (task 7.1). Required: the caller (httpApi) wires in
  // the real `disclosureSelector` export; it is injectable so tests can supply a
  // fake selection without a full SD-JWT VC.
  selectDisclosures: SelectDisclosures;
  // Verifier base URL override. Defaults to `request.verifier`, then
  // `VERIFIER_BASE_URL`.
  verifierBaseUrl?: string;
  // Path on the verifier the authorization response is POSTed to. Defaults to
  // the OpenID4VP response endpoint used by verifier-api2.
  responsePath?: string;
  // Injectable fetch (defaults to the global `fetch`) — eases testing.
  fetchImpl?: typeof fetch;
}

// -----------------------------------------------------------------------------
// Presentation
// -----------------------------------------------------------------------------

/**
 * Produce an SD-JWT VP for a stored credential and submit it to the verifier.
 *
 * Builds the VP (issuer-signed JWT + selected disclosures + KB-JWT bound to
 * `request.nonce` with `aud` = verifier), posts the `vp_token` authorization
 * response, and normalizes the verifier's answer into a `VerificationResult`.
 *
 * Failures — a transport error, a non-OK verifier response, or an explicit
 * verifier failure result — are returned as
 * `{ success: false, error: { step: 'verify', message } }` (Req 4.5); this
 * function does not throw for those cases.
 */
export async function presentCredential(
  credential: StoredCredential,
  request: PresentationRequest,
  options: Oid4vpClientOptions,
): Promise<VerificationResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return verifyFailure(
      'No fetch implementation available (Node 20+ required, or pass fetchImpl).',
    );
  }

  let verifierBaseUrl: string;
  try {
    verifierBaseUrl = resolveVerifierBaseUrl(request, options.verifierBaseUrl);
  } catch (error) {
    return verifyFailure(messageOf(error));
  }

  // 1. Select disclosures and build the SD-JWT VP (KB-JWT bound to the nonce).
  let vpToken: string;
  let disclosedClaims: Record<string, unknown>;
  try {
    const selection = options.selectDisclosures(credential, request);
    disclosedClaims = selection.disclosedClaims;
    vpToken = buildSdJwtVp({
      selection,
      holderKey: options.holderKey,
      nonce: request.nonce,
      audience: verifierBaseUrl,
    });
  } catch (error) {
    return verifyFailure(
      `Failed to build the presentation: ${messageOf(error)}`,
    );
  }

  // 2. Submit the authorization response carrying the vp_token.
  const responsePath = options.responsePath ?? '/openid4vc/verify';
  let response: Response;
  try {
    const body = new URLSearchParams({ vp_token: vpToken, state: request.nonce });
    response = await fetchImpl(joinUrl(verifierBaseUrl, responsePath), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (error) {
    return verifyFailure(
      `Authorization response to the verifier failed: ${messageOf(error)}`,
    );
  }

  // 3. Normalize the verifier result.
  return normalizeVerifierResponse(response, disclosedClaims);
}

// -----------------------------------------------------------------------------
// SD-JWT VP assembly
// -----------------------------------------------------------------------------

interface BuildSdJwtVpInput {
  selection: DisclosureSelection;
  holderKey: HolderKey;
  nonce: string;
  audience: string;
}

/**
 * Assemble the SD-JWT VP compact serialization.
 *
 * Layout: `<issuer-signed JWT>~<disclosure>*~<KB-JWT>`. The KB-JWT is bound to
 * the request `nonce` (challenge binding, Property 6) and carries an `sd_hash`
 * digest over the presentation prefix (issuer JWT + revealed disclosures) so the
 * proof commits to exactly the disclosures being presented.
 *
 * Exported so unit/property tests can assert the serialization shape and the
 * nonce binding without a live verifier.
 */
export function buildSdJwtVp(input: BuildSdJwtVpInput): string {
  const { selection, holderKey, nonce, audience } = input;

  if (
    typeof selection.issuerSignedJwt !== 'string' ||
    selection.issuerSignedJwt.split('.').length !== 3
  ) {
    throw new Error('disclosure selection has no valid issuer-signed JWT.');
  }

  // The presentation prefix is the issuer-signed JWT and the revealed
  // disclosures, each followed by a `~` (including the trailing `~` that
  // precedes the KB-JWT). `sd_hash` is computed over this exact string.
  const prefix = [selection.issuerSignedJwt, ...selection.disclosures].join('~') + '~';
  const sdHash = base64UrlSha256(prefix);

  const kbJwt = buildKeyBindingJwt({
    holderKey,
    nonce,
    audience,
    typ: KB_JWT_TYP,
    sdHash,
  });

  return `${prefix}${kbJwt}`;
}

// Compute the base64url-encoded SHA-256 digest of a UTF-8 string.
function base64UrlSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

// -----------------------------------------------------------------------------
// Verifier response normalization
// -----------------------------------------------------------------------------

/**
 * Parse the verifier's authorization-response reply into a `VerificationResult`.
 *
 * Success is inferred from either an HTTP 2xx with no explicit failure signal,
 * or a body whose success/verified flag is truthy. Any explicit failure flag,
 * a non-OK status, or an `error`/`error_description`/`reason` field is relayed
 * as a `verify`-step failure (Req 4.5).
 */
async function normalizeVerifierResponse(
  response: Response,
  disclosedClaims: Record<string, unknown>,
): Promise<VerificationResult> {
  const text = await response.text().catch(() => '');
  const payload = parseJsonLoose(text);

  const failureMessage = extractFailureMessage(payload);

  if (!response.ok) {
    return verifyFailure(
      failureMessage ??
        `Verifier rejected the presentation (HTTP ${response.status}).`,
    );
  }

  // An OK response can still carry an explicit failure flag or error field.
  if (isExplicitFailure(payload) || failureMessage !== undefined) {
    return verifyFailure(
      failureMessage ?? 'Verifier reported the presentation as not verified.',
    );
  }

  // Prefer disclosed claims the verifier echoes back; otherwise report the ones
  // the wallet revealed in the presentation.
  const verifierClaims = extractDisclosedClaims(payload);
  return {
    success: true,
    disclosedClaims: verifierClaims ?? disclosedClaims,
  };
}

// Determine whether a verifier payload explicitly signals a failed verification
// via a boolean success/verified flag or a textual status.
function isExplicitFailure(payload: unknown): boolean {
  if (!isObject(payload)) {
    return false;
  }

  for (const key of ['success', 'verified', 'valid'] as const) {
    const value = payload[key];
    if (typeof value === 'boolean' && value === false) {
      return true;
    }
  }

  const status = payload.status;
  if (typeof status === 'string') {
    const normalized = status.toLowerCase();
    if (
      normalized === 'failed' ||
      normalized === 'failure' ||
      normalized === 'invalid' ||
      normalized === 'error'
    ) {
      return true;
    }
  }

  return false;
}

// Pull a human-readable failure message out of a verifier payload, if present.
function extractFailureMessage(payload: unknown): string | undefined {
  if (!isObject(payload)) {
    return undefined;
  }
  for (const key of [
    'error_description',
    'error',
    'reason',
    'message',
    'policyResults',
  ] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

// Extract disclosed claims the verifier echoes back, when present.
function extractDisclosedClaims(
  payload: unknown,
): Record<string, unknown> | undefined {
  if (!isObject(payload)) {
    return undefined;
  }
  for (const key of ['disclosedClaims', 'claims', 'vp', 'presentation'] as const) {
    const value = payload[key];
    if (isObject(value)) {
      return value;
    }
  }
  return undefined;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Build a normalized `verify`-step failure result (Req 4.5).
function verifyFailure(message: string): VerificationResult {
  return { success: false, error: { step: VERIFY_STEP, message } };
}

/**
 * Resolve the verifier base URL from (in priority order) an explicit override,
 * the request's `verifier`, then `VERIFIER_BASE_URL`.
 */
function resolveVerifierBaseUrl(
  request: PresentationRequest,
  override: string | undefined,
): string {
  const candidate =
    override?.trim() ||
    request.verifier?.trim() ||
    process.env.VERIFIER_BASE_URL?.trim() ||
    '';
  if (candidate.length === 0) {
    throw new Error(
      'No verifier base URL available (request.verifier or VERIFIER_BASE_URL).',
    );
  }
  // Strip a trailing slash so joinUrl produces clean paths.
  return candidate.replace(/\/+$/, '');
}

// Join a base URL and a path, collapsing any duplicate slash at the boundary.
function joinUrl(base: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

// Parse a response body as JSON, tolerating empty/non-JSON bodies (a plain-text
// verifier error is returned as a `{ message }` object so it still surfaces).
function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return { message: trimmed };
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
