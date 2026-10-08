// oid4vciClient — drive the OpenID4VCI pre-authorized code flow against the
// issuer and turn the returned SD-JWT VC into a `StoredCredential`.
//
// Responsibilities (design: Components -> Wallet Service -> `oid4vciClient`,
// End-to-End Flow -> Issuance):
//   1. Token request — exchange the offer's `pre-authorized_code` grant at the
//      issuer token endpoint for an `access_token` (+ `c_nonce`).
//   2. Credential request — call the credential endpoint presenting a holder
//      proof JWT (`openid4vci-proof+jwt`) bound to the issuer `c_nonce`, and
//      receive the Education Certificate as an SD-JWT VC (compact serialization).
//   3. Parse — split the returned SD-JWT VC into a `StoredCredential`, reading
//      the `vct` from the issuer-signed JWT body.
//
// Error handling (design: Error Handling -> Unsupported credential type, Req 1.5):
//   OpenID4VCI error responses (e.g. `unsupported_credential_type`) from either
//   endpoint are mapped to an `Oid4vciError` tagged with the failing step
//   (`'token' | 'credential'`), so callers can surface *which* step failed and
//   relay the real protocol error code/description.
//
// The four-attribute Education Certificate claim set (name, degree, institution,
// grades) is assembled by `buildEducationClaimSet` (design "Data Model", Req 1.3,
// Property 1). The issuer owns the authoritative claim template; this claim set
// is what the wallet proposes for issuance where a runtime claim set is required.
//
// HTTP uses Node's built-in `fetch` (Node 20+). The issuer base URL is taken
// from the normalized offer's `issuer`, falling back to `ISSUER_BASE_URL`.

import {
  buildKeyBindingJwt,
  generateHolderKey,
  type HolderKey,
} from './holderKeys.js';
import type { CredentialOffer, StoredCredential } from './types.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// The pre-authorized code grant identifier defined by OpenID4VCI.
const PRE_AUTHORIZED_CODE_GRANT =
  'urn:ietf:params:oauth:grant-type:pre-authorized_code';

// JOSE `typ` for the OpenID4VCI credential-request holder proof JWT.
const PROOF_TYP = 'openid4vci-proof+jwt';

// The IETF SD-JWT VC credential format advertised by the issuer (issuer config
// `format = "dc+sd-jwt"`).
const SD_JWT_VC_FORMAT = 'dc+sd-jwt';

// The four Education Certificate subject attributes (design "Data Model").
export const EDUCATION_CERTIFICATE_ATTRIBUTES = [
  'name',
  'degree',
  'institution',
  'grades',
] as const;

// The stable credential type / `vct` for the demo Education Certificate.
const EDUCATION_CERTIFICATE_VCT = 'EducationCertificate';

// -----------------------------------------------------------------------------
// Public shapes
// -----------------------------------------------------------------------------

// The step of the OpenID4VCI exchange a failure is attributed to.
export type Oid4vciStep = 'token' | 'credential';

// The four-attribute Education Certificate subject record used to assemble the
// issuance claim set.
export interface EducationCertificateSubject {
  name: string;
  degree: string;
  institution: string;
  grades: string;
}

// The assembled issuance claim set: the `vct` plus all four subject attributes.
export interface EducationCertificateClaimSet {
  vct: string;
  name: string;
  degree: string;
  institution: string;
  grades: string;
}

// Options for `runPreAuthorizedCodeFlow`.
export interface Oid4vciClientOptions {
  // The session id the resulting `StoredCredential` is keyed under.
  sessionId: string;
  // Issuer base URL override. Defaults to the offer's `issuer`, then
  // `ISSUER_BASE_URL`.
  issuerBaseUrl?: string;
  // Holder key to bind the credential to. A fresh key is generated when omitted.
  holderKey?: HolderKey;
  // Injectable fetch (defaults to the global `fetch`) — eases testing.
  fetchImpl?: typeof fetch;
}

// The outcome of a successful flow: the stored credential plus the holder key
// used for binding (needed later for the OpenID4VP key-binding proof).
export interface Oid4vciResult {
  credential: StoredCredential;
  holderKey: HolderKey;
}

// -----------------------------------------------------------------------------
// Error envelope
// -----------------------------------------------------------------------------

// An OpenID4VCI error response body (RFC 6749 / OpenID4VCI shape). All fields
// are optional because issuers vary in what they populate.
export interface Oid4vciErrorResponse {
  error?: string;
  error_description?: string;
}

/**
 * Error raised when an OpenID4VCI step fails. Tags the failing step
 * (`'token' | 'credential'`) and preserves the issuer's OpenID4VCI error code /
 * description so callers can relay the real protocol error (design "Error
 * Handling — Unsupported credential type"; Req 1.5).
 */
export class Oid4vciError extends Error {
  override readonly name = 'Oid4vciError';

  // Which step failed.
  readonly step: Oid4vciStep;
  // HTTP status code of the failing response, when the failure was an HTTP error.
  readonly status?: number;
  // The OpenID4VCI error code (e.g. `unsupported_credential_type`), when present.
  readonly code?: string;
  // The issuer's `error_description`, when present.
  readonly description?: string;

  constructor(
    step: Oid4vciStep,
    message: string,
    options?: {
      status?: number;
      code?: string;
      description?: string;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    Object.setPrototypeOf(this, Oid4vciError.prototype);
    this.step = step;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.code !== undefined) this.code = options.code;
    if (options?.description !== undefined) this.description = options.description;
  }
}

// -----------------------------------------------------------------------------
// Claim set assembly (Property 1 / Req 1.3)
// -----------------------------------------------------------------------------

/**
 * Assemble the Education Certificate issuance claim set from a subject record.
 *
 * The returned claim set carries the `vct` plus all four subject attributes
 * (`name`, `degree`, `institution`, `grades`) — guaranteeing the four-attribute
 * invariant regardless of input ordering (design "Data Model", Req 1.3,
 * Property 1).
 *
 * @throws {TypeError} if any of the four attributes is missing or not a string.
 */
export function buildEducationClaimSet(
  subject: EducationCertificateSubject,
): EducationCertificateClaimSet {
  for (const attribute of EDUCATION_CERTIFICATE_ATTRIBUTES) {
    const value = subject[attribute];
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(
        `Education Certificate claim set is missing a non-empty "${attribute}".`,
      );
    }
  }

  // Build the object explicitly (rather than spreading) so the four-attribute
  // guarantee is structural and not dependent on the input object's keys.
  return {
    vct: EDUCATION_CERTIFICATE_VCT,
    name: subject.name,
    degree: subject.degree,
    institution: subject.institution,
    grades: subject.grades,
  };
}

// -----------------------------------------------------------------------------
// Flow
// -----------------------------------------------------------------------------

/**
 * Drive the OpenID4VCI pre-authorized code flow for a credential offer.
 *
 * Steps:
 *   1. Token request (pre-authorized_code grant) → `access_token` + `c_nonce`.
 *   2. Credential request with a holder proof JWT bound to `c_nonce` →
 *      SD-JWT VC (compact serialization).
 *   3. Parse the SD-JWT VC into a `StoredCredential`.
 *
 * @throws {Oid4vciError} tagged with the failing step on any OpenID4VCI error.
 */
export async function runPreAuthorizedCodeFlow(
  offer: CredentialOffer,
  options: Oid4vciClientOptions,
): Promise<Oid4vciResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Oid4vciError(
      'token',
      'No fetch implementation available (Node 20+ required, or pass fetchImpl).',
    );
  }

  const issuerBaseUrl = resolveIssuerBaseUrl(offer, options.issuerBaseUrl);
  const holderKey = options.holderKey ?? generateHolderKey();

  // 1. Token request.
  const token = await requestToken(fetchImpl, issuerBaseUrl, offer);

  // 2. Credential request (holder proof bound to the issuer c_nonce).
  const credentialConfigurationId = offer.credentialConfigurationIds[0];
  if (credentialConfigurationId === undefined) {
    throw new Oid4vciError(
      'credential',
      'Offer has no credential_configuration_ids to request.',
    );
  }
  const proofJwt = buildKeyBindingJwt({
    holderKey,
    nonce: token.cNonce,
    audience: issuerBaseUrl,
    typ: PROOF_TYP,
  });
  const sdJwtVc = await requestCredential(fetchImpl, issuerBaseUrl, {
    accessToken: token.accessToken,
    credentialConfigurationId,
    proofJwt,
  });

  // 3. Parse into a StoredCredential.
  const credential = parseSdJwtVc(options.sessionId, sdJwtVc);
  return { credential, holderKey };
}

// -----------------------------------------------------------------------------
// Token request
// -----------------------------------------------------------------------------

interface TokenResult {
  accessToken: string;
  cNonce: string;
}

async function requestToken(
  fetchImpl: typeof fetch,
  issuerBaseUrl: string,
  offer: CredentialOffer,
): Promise<TokenResult> {
  const body = new URLSearchParams({
    grant_type: PRE_AUTHORIZED_CODE_GRANT,
    'pre-authorized_code': offer.preAuthorizedCode,
  });

  let response: Response;
  try {
    response = await fetchImpl(joinUrl(issuerBaseUrl, '/token'), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (cause) {
    throw new Oid4vciError('token', 'Token request to the issuer failed.', {
      cause,
    });
  }

  const payload = await readJson(response, 'token');
  if (!response.ok) {
    throw toProtocolError('token', response.status, payload);
  }

  const accessToken = readString(payload, 'access_token');
  if (accessToken === undefined) {
    throw new Oid4vciError(
      'token',
      'Token response did not include an access_token.',
      { status: response.status },
    );
  }

  // `c_nonce` may arrive on the token response (OpenID4VCI) and the holder proof
  // must bind to it. Fall back to the pre-authorized code only if the issuer
  // omits it, so the proof still carries a deterministic challenge.
  const cNonce = readString(payload, 'c_nonce') ?? offer.preAuthorizedCode;

  return { accessToken, cNonce };
}

// -----------------------------------------------------------------------------
// Credential request
// -----------------------------------------------------------------------------

interface CredentialRequestInput {
  accessToken: string;
  credentialConfigurationId: string;
  proofJwt: string;
}

async function requestCredential(
  fetchImpl: typeof fetch,
  issuerBaseUrl: string,
  input: CredentialRequestInput,
): Promise<string> {
  const requestBody = {
    format: SD_JWT_VC_FORMAT,
    credential_configuration_id: input.credentialConfigurationId,
    proof: {
      proof_type: 'jwt',
      jwt: input.proofJwt,
    },
  };

  let response: Response;
  try {
    response = await fetchImpl(joinUrl(issuerBaseUrl, '/credential'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
  } catch (cause) {
    throw new Oid4vciError(
      'credential',
      'Credential request to the issuer failed.',
      { cause },
    );
  }

  const payload = await readJson(response, 'credential');
  if (!response.ok) {
    throw toProtocolError('credential', response.status, payload);
  }

  const sdJwtVc = extractCredentialString(payload);
  if (sdJwtVc === undefined) {
    throw new Oid4vciError(
      'credential',
      'Credential response did not contain an SD-JWT VC.',
      { status: response.status },
    );
  }
  return sdJwtVc;
}

/**
 * Extract the compact SD-JWT VC string from a credential response. OpenID4VCI
 * draft/1.0 variants return the credential either directly as `credential` or
 * as the first entry of a `credentials` array (object with a `credential`
 * member, or a bare string).
 */
function extractCredentialString(payload: unknown): string | undefined {
  if (!isObject(payload)) {
    return undefined;
  }

  const direct = payload.credential;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }

  const list = payload.credentials;
  if (Array.isArray(list) && list.length > 0) {
    const first = list[0];
    if (typeof first === 'string' && first.length > 0) {
      return first;
    }
    if (isObject(first) && typeof first.credential === 'string' && first.credential.length > 0) {
      return first.credential;
    }
  }

  return undefined;
}

// -----------------------------------------------------------------------------
// SD-JWT VC parsing
// -----------------------------------------------------------------------------

/**
 * Parse a compact SD-JWT VC string into a `StoredCredential`.
 *
 * An SD-JWT VC compact serialization is `<issuer-signed JWT>~<disclosure>*~`
 * (optionally ending with a key-binding JWT). The issuer-signed JWT's payload
 * carries the `vct`; we read it so the stored credential records its type.
 *
 * @throws {Oid4vciError} (step `credential`) if the string is not a parseable
 *   SD-JWT VC.
 */
export function parseSdJwtVc(
  sessionId: string,
  sdJwtVc: string,
): StoredCredential {
  if (typeof sdJwtVc !== 'string' || sdJwtVc.trim().length === 0) {
    throw new Oid4vciError('credential', 'SD-JWT VC is empty.');
  }

  const trimmed = sdJwtVc.trim();
  // The issuer-signed JWT is the first `~`-separated segment.
  const issuerJwt = trimmed.split('~')[0];
  if (issuerJwt === undefined || issuerJwt.split('.').length !== 3) {
    throw new Oid4vciError(
      'credential',
      'SD-JWT VC does not contain a valid issuer-signed JWT.',
    );
  }

  const vct = readVct(issuerJwt);

  return {
    sessionId,
    format: 'sd-jwt-vc',
    sdJwtVc: trimmed,
    vct,
  };
}

/**
 * Decode the issuer-signed JWT payload (no signature verification — the issuer
 * is trusted at this step) and read its `vct` claim. Falls back to the known
 * Education Certificate `vct` when the claim is absent/undecodable so storage
 * still records a usable type.
 */
function readVct(issuerJwt: string): string {
  const segments = issuerJwt.split('.');
  const encodedPayload = segments[1];
  if (encodedPayload === undefined) {
    return EDUCATION_CERTIFICATE_VCT;
  }
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    );
    if (isObject(payload) && typeof payload.vct === 'string' && payload.vct.length > 0) {
      return payload.vct;
    }
  } catch {
    // Fall through to the default vct below.
  }
  return EDUCATION_CERTIFICATE_VCT;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Resolve the issuer base URL from (in priority order) an explicit override,
 * the offer's `issuer`, then `ISSUER_BASE_URL`.
 */
function resolveIssuerBaseUrl(
  offer: CredentialOffer,
  override: string | undefined,
): string {
  const candidate =
    override?.trim() ||
    offer.issuer?.trim() ||
    process.env.ISSUER_BASE_URL?.trim() ||
    '';
  if (candidate.length === 0) {
    throw new Oid4vciError(
      'token',
      'No issuer base URL available (offer.issuer or ISSUER_BASE_URL).',
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

/**
 * Read a response body as JSON, tolerating empty bodies. A body that is present
 * but not valid JSON is itself an error attributable to the current step.
 */
async function readJson(response: Response, step: Oid4vciStep): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (text.length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Oid4vciError(
      step,
      `Issuer ${step} response was not valid JSON.`,
      { status: response.status, cause },
    );
  }
}

/**
 * Build an `Oid4vciError` from a non-OK HTTP response body, surfacing the
 * OpenID4VCI `error` code (e.g. `unsupported_credential_type`) and
 * `error_description` when present (Req 1.5).
 */
function toProtocolError(
  step: Oid4vciStep,
  status: number,
  payload: unknown,
): Oid4vciError {
  const errorBody: Oid4vciErrorResponse = isObject(payload)
    ? {
        error: typeof payload.error === 'string' ? payload.error : undefined,
        error_description:
          typeof payload.error_description === 'string'
            ? payload.error_description
            : undefined,
      }
    : {};

  const code = errorBody.error;
  const description = errorBody.error_description;
  const message =
    code !== undefined
      ? `Issuer ${step} request failed: ${code}${
          description !== undefined ? ` (${description})` : ''
        }`
      : `Issuer ${step} request failed with HTTP ${status}.`;

  return new Oid4vciError(step, message, {
    status,
    code,
    description,
  });
}

function readString(payload: unknown, key: string): string | undefined {
  if (isObject(payload)) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
