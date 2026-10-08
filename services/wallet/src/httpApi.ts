// httpApi — the wallet BFF HTTP surface consumed by the thin web UI.
//
// Responsibilities (design: Components -> Wallet Service -> `httpApi`,
// "Wallet BFF HTTP API" table):
//   - `POST /wallet/offer`    accept an offer string, run OpenID4VCI, store the
//                             credential, return a confirmation.
//   - `GET  /wallet/credential` return a *redacted* summary of the stored
//                             credential for the confirmation panel (Req 2.3).
//   - `POST /wallet/present`  accept a presentation-request string, apply
//                             selective disclosure, submit the `vp_token`, and
//                             return the verifier result.
//   - `GET  /healthz`         liveness for Compose health checks.
//
// This module wires together the independently-implemented wallet modules:
//   offerIntake (normalize) -> oid4vciClient (issuance) -> sessionStore (persist)
//   -> disclosureSelector (select) -> oid4vpClient (present) -> VerificationResult.
//
// Step attribution (Req 6.3): each handler stage is wrapped and tagged with a
// step name (`offer-intake`, `token`, `credential`, `present`, `verify`). A
// thrown error becomes a JSON error response that names the failing step, so the
// integration test (task 6.x) and the UI can report *which* step failed.
//
// -----------------------------------------------------------------------------
// Integration reconciliation: disclosureSelector <-> oid4vpClient
// -----------------------------------------------------------------------------
// `disclosureSelector.selectDisclosures` returns:
//     { issuerJwt, disclosures: Disclosure[], selectedDisclosureStrings: string[],
//       disclosedClaims }
// but `oid4vpClient`'s injected `SelectDisclosures` contract expects:
//     { issuerSignedJwt, disclosures: string[], disclosedClaims }
// Rather than edit either module (both are complete and tested in isolation),
// this module bridges them with `disclosureSelectionAdapter`, which calls the
// real selector and maps:
//     issuerSignedJwt  <- selection.issuerJwt
//     disclosures      <- selection.selectedDisclosureStrings
//     disclosedClaims  <- selection.disclosedClaims
// See `disclosureSelectionAdapter` below.
//
// -----------------------------------------------------------------------------
// Session + holder-key handling
// -----------------------------------------------------------------------------
// `runPreAuthorizedCodeFlow` generates (or accepts) the holder key the credential
// is bound to and RETURNS it. The presentation step must sign the KB-JWT with the
// SAME key, but `StoredCredential` carries no holder key. To avoid changing the
// `StoredCredential` shape in `types.ts`, this module keeps a parallel in-memory
// map `holderKeysBySession` (sessionId -> HolderKey) captured from the issuance
// result. Like `sessionStore`, it is in-memory and lost on restart — fine for the
// demo. Sessions are identified by a `sid` cookie; a fresh one is minted and set
// when absent.

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from 'express';

import { InvalidOfferError, normalizeOffer } from './offerIntake.js';
import {
  Oid4vciError,
  runPreAuthorizedCodeFlow,
  type Oid4vciResult,
} from './oid4vciClient.js';
import { selectDisclosures } from './disclosureSelector.js';
import {
  presentCredential,
  type DisclosureSelection as Oid4vpDisclosureSelection,
} from './oid4vpClient.js';
import { createSessionStore, type SessionStore } from './sessionStore.js';
import type { HolderKey } from './holderKeys.js';
import type {
  PresentationRequest,
  StoredCredential,
  VerificationResult,
} from './types.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Cookie carrying the opaque session id. HttpOnly so the browser UI never reads
// it directly; the wallet is the only consumer.
const SESSION_COOKIE = 'sid';

// Default requested claims when a presentation request carries only a
// presentation_definition / dcql_query without an explicit flat claim list that
// we can extract — matches the demo verifier request (degree + institution).
const DEFAULT_REQUESTED_CLAIMS = ['degree', 'institution'];

// -----------------------------------------------------------------------------
// Dependency injection surface (for tests)
// -----------------------------------------------------------------------------

/**
 * Injectable dependencies for `createApp`. All are optional and default to the
 * real implementations; tests override them with fakes (e.g. a fake `fetch`, a
 * fresh `sessionStore`, or a stub issuance flow) without a live issuer/verifier.
 */
export interface AppDependencies {
  // Session-scoped credential store. Defaults to a fresh in-memory store.
  sessionStore?: SessionStore;
  // The OpenID4VCI issuance flow. Defaults to `runPreAuthorizedCodeFlow`.
  runPreAuthorizedCodeFlow?: typeof runPreAuthorizedCodeFlow;
  // The OpenID4VP presentation flow. Defaults to `presentCredential`.
  presentCredential?: typeof presentCredential;
  // The disclosure selector. Defaults to the real `selectDisclosures`.
  selectDisclosures?: typeof selectDisclosures;
  // Injectable fetch passed through to the issuance / presentation flows.
  fetchImpl?: typeof fetch;
  // Issuer base URL override. Defaults to `ISSUER_BASE_URL`.
  issuerBaseUrl?: string;
  // Verifier base URL override. Defaults to `VERIFIER_BASE_URL`.
  verifierBaseUrl?: string;
  // Absolute path to the static web UI directory. Defaults to `../public`.
  publicDir?: string;
}

// -----------------------------------------------------------------------------
// Step attribution
// -----------------------------------------------------------------------------

// The handler stages a failure can be attributed to (Req 6.3).
type Step =
  | 'offer-intake'
  | 'token'
  | 'credential'
  | 'session'
  | 'request-intake'
  | 'present'
  | 'verify';

/**
 * An error carrying the pipeline step it failed at plus the HTTP status to use.
 * Thrown inside handler stages and rendered by `sendStepError`.
 */
class StepError extends Error {
  override readonly name = 'StepError';
  readonly step: Step;
  readonly status: number;
  readonly code: string | undefined;

  constructor(
    step: Step,
    status: number,
    message: string,
    options?: { code?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    Object.setPrototypeOf(this, StepError.prototype);
    this.step = step;
    this.status = status;
    this.code = options?.code;
  }
}

// -----------------------------------------------------------------------------
// App factory
// -----------------------------------------------------------------------------

/**
 * Build the wallet BFF Express application.
 *
 * All collaborating modules are resolved from `deps` (falling back to the real
 * implementations) so tests can inject fakes. The returned app is not yet
 * listening — `server.ts` calls `.listen(3000)`.
 */
export function createApp(deps: AppDependencies = {}): Express {
  const sessionStore = deps.sessionStore ?? createSessionStore();
  const runIssuance = deps.runPreAuthorizedCodeFlow ?? runPreAuthorizedCodeFlow;
  const present = deps.presentCredential ?? presentCredential;
  const select = deps.selectDisclosures ?? selectDisclosures;
  const fetchImpl = deps.fetchImpl;
  const issuerBaseUrl = deps.issuerBaseUrl ?? process.env.ISSUER_BASE_URL;
  const verifierBaseUrl = deps.verifierBaseUrl ?? process.env.VERIFIER_BASE_URL;
  // Default static dir: `services/wallet/public`, one level up from `dist/`.
  // `fileURLToPath` yields a platform-correct absolute path (handles Windows
  // drive letters and the Linux container path alike).
  const publicDir =
    deps.publicDir ?? fileURLToPath(new URL('../public', import.meta.url));

  // Parallel in-memory map holding the holder key bound at issuance so the
  // presentation step signs the KB-JWT with the same key (see header note).
  const holderKeysBySession = new Map<string, HolderKey>();

  const app = express();

  // Minimal body + cookie parsing. express.json for the JSON POST bodies; a tiny
  // cookie reader (no extra dependency) for the `sid` session cookie.
  app.use(express.json());
  app.use(cookieReader);

  // Serve the thin web UI (task 9.1). The directory may be empty until the UI
  // lands; `express.static` simply 404s missing files, so this is safe now.
  app.use(express.static(publicDir));

  // ---------------------------------------------------------------------------
  // POST /wallet/offer — run OpenID4VCI, store the credential, confirm.
  // ---------------------------------------------------------------------------
  app.post(
    '/wallet/offer',
    asyncHandler(async (req, res) => {
      const sessionId = ensureSession(req, res);

      const offerInput = readStringField(req.body, 'offer');
      if (offerInput === undefined) {
        throw new StepError(
          'offer-intake',
          400,
          'Request body must include a non-empty "offer" string.',
        );
      }

      // Stage 1 — normalize (fail fast, offline). InvalidOfferError -> 400 and
      // stored state is left untouched (Req 2.5).
      let offer;
      try {
        offer = normalizeOffer(offerInput);
      } catch (error) {
        if (error instanceof InvalidOfferError) {
          throw new StepError('offer-intake', 400, `Invalid offer: ${error.message}`, {
            cause: error,
          });
        }
        throw error;
      }

      // Stage 2 — OpenID4VCI issuance. Oid4vciError carries the failing step
      // (`token` | `credential`) which we relay (Req 1.5).
      let result: Oid4vciResult;
      try {
        result = await runIssuance(offer, {
          sessionId,
          ...(issuerBaseUrl !== undefined ? { issuerBaseUrl } : {}),
          ...(fetchImpl !== undefined ? { fetchImpl } : {}),
        });
      } catch (error) {
        if (error instanceof Oid4vciError) {
          throw new StepError(error.step, 502, error.message, {
            ...(error.code !== undefined ? { code: error.code } : {}),
            cause: error,
          });
        }
        throw error;
      }

      // Stage 3 — persist the credential and retain the issuance holder key.
      sessionStore.store(result.credential);
      holderKeysBySession.set(sessionId, result.holderKey);

      res.status(200).json({
        sessionId,
        vct: result.credential.vct,
        format: result.credential.format,
        stored: true,
      });
    }),
  );

  // ---------------------------------------------------------------------------
  // GET /wallet/credential — redacted stored-credential summary (Req 2.3).
  // ---------------------------------------------------------------------------
  app.get(
    '/wallet/credential',
    asyncHandler((req, res) => {
      const sessionId = readSession(req);
      const credential =
        sessionId !== undefined ? sessionStore.retrieve(sessionId) : undefined;

      if (credential === undefined) {
        res.status(404).json({ stored: false });
        return;
      }

      // Redacted: expose only type/format/presence. The raw `sdJwtVc` and the
      // holder key are never returned (Req 2.3).
      res.status(200).json(redactCredential(credential));
    }),
  );

  // ---------------------------------------------------------------------------
  // POST /wallet/present — selective disclosure + submit vp_token + relay result.
  // ---------------------------------------------------------------------------
  app.post(
    '/wallet/present',
    asyncHandler(async (req, res) => {
      const sessionId = readSession(req);
      if (sessionId === undefined) {
        throw new StepError('session', 400, 'No wallet session; accept an offer first.');
      }

      const credential = sessionStore.retrieve(sessionId);
      const holderKey = holderKeysBySession.get(sessionId);
      if (credential === undefined || holderKey === undefined) {
        throw new StepError(
          'session',
          404,
          'No stored credential for this session; accept an offer first.',
        );
      }

      const requestInput = readStringField(req.body, 'request');
      if (requestInput === undefined) {
        throw new StepError(
          'request-intake',
          400,
          'Request body must include a non-empty "request" string.',
        );
      }

      // Stage 1 — normalize the presentation request.
      let request: PresentationRequest;
      try {
        request = normalizePresentationRequest(requestInput, verifierBaseUrl);
      } catch (error) {
        throw new StepError('request-intake', 400, messageOf(error), { cause: error });
      }

      // Stage 2 — present. oid4vpClient already returns verifier failures as a
      // `{ success:false, error:{ step:'verify', message } }` result instead of
      // throwing, so we relay the VerificationResult directly.
      const result: VerificationResult = await present(credential, request, {
        holderKey,
        // Bridge disclosureSelector -> oid4vpClient (see header note).
        selectDisclosures: disclosureSelectionAdapter(select),
        ...(verifierBaseUrl !== undefined ? { verifierBaseUrl } : {}),
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      });

      // A verify-step failure is a legitimate (expected) outcome, not a 5xx:
      // relay it as 200 with the result so the UI/test can read the attribution.
      res.status(200).json(result);
    }),
  );

  // ---------------------------------------------------------------------------
  // GET /healthz — liveness.
  // ---------------------------------------------------------------------------
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Centralized error renderer — turns a thrown StepError (or anything else)
  // into a JSON error naming the failing step (Req 6.3).
  app.use(errorHandler);

  return app;
}

// -----------------------------------------------------------------------------
// disclosureSelector -> oid4vpClient adapter
// -----------------------------------------------------------------------------

/**
 * Adapt the real `disclosureSelector.selectDisclosures` to the shape
 * `oid4vpClient` expects.
 *
 * `disclosureSelector` returns `{ issuerJwt, disclosures: Disclosure[],
 * selectedDisclosureStrings, disclosedClaims }`; `oid4vpClient` wants
 * `{ issuerSignedJwt, disclosures: string[], disclosedClaims }`. This maps:
 *   issuerSignedJwt <- issuerJwt
 *   disclosures     <- selectedDisclosureStrings
 *   disclosedClaims <- disclosedClaims
 */
function disclosureSelectionAdapter(
  select: typeof selectDisclosures,
): (
  credential: StoredCredential,
  request: PresentationRequest,
) => Oid4vpDisclosureSelection {
  return (credential, request) => {
    const selection = select(credential, request);
    return {
      issuerSignedJwt: selection.issuerJwt,
      disclosures: selection.selectedDisclosureStrings,
      disclosedClaims: selection.disclosedClaims,
    };
  };
}

// -----------------------------------------------------------------------------
// Presentation-request normalization
// -----------------------------------------------------------------------------

/**
 * Normalize a pasted/scanned presentation-request string into a
 * `PresentationRequest`.
 *
 * Accepts either:
 *   - an `openid4vp://` (or `openid-vc://` / `https`) authorization request URI
 *     carrying query params (`nonce`, `client_id`/`response_uri`,
 *     `presentation_definition`), or
 *   - a raw JSON object (e.g. the verifier2 verification-session request or an
 *     authorization request object).
 *
 * `requestedClaims` is extracted from a flat `requestedClaims` array when
 * present, else from a `presentation_definition` / `dcql_query` claim path list;
 * if the format carries only a definition we cannot flatten, it defaults to
 * `['degree', 'institution']` (the demo request).
 */
export function normalizePresentationRequest(
  input: string,
  verifierBaseUrlFallback: string | undefined,
): PresentationRequest {
  const raw = input.trim();
  if (raw.length === 0) {
    throw new Error('Presentation request is empty.');
  }

  const { params, body } = parseRequestSource(raw);

  const nonce = firstString(
    params?.get('nonce'),
    readPath(body, 'nonce'),
    readPath(body, 'core_flow', 'nonce'),
  );
  if (nonce === undefined) {
    throw new Error('Presentation request is missing a nonce.');
  }

  const verifier =
    firstString(
      params?.get('client_id'),
      params?.get('response_uri'),
      readPath(body, 'verifier'),
      readPath(body, 'client_id'),
      readPath(body, 'response_uri'),
    ) ??
    verifierBaseUrlFallback ??
    process.env.VERIFIER_BASE_URL ??
    '';

  const requestedClaims = extractRequestedClaims(params, body);

  return { verifier, nonce, requestedClaims, raw };
}

interface RequestSource {
  // Query params when the input is a URI; undefined for a raw JSON body.
  params?: URLSearchParams;
  // Parsed JSON object when the input (or a URI param) carries one.
  body?: Record<string, unknown>;
}

/**
 * Resolve the raw request string into query params and/or a JSON object. A URI
 * contributes its query params; a `request`/`presentation_definition` param or a
 * raw JSON input contributes the JSON body.
 */
function parseRequestSource(raw: string): RequestSource {
  if (looksLikeJson(raw)) {
    const body = tryParseJsonObject(raw);
    if (body === undefined) {
      throw new Error('Presentation request JSON is not an object.');
    }
    return { body };
  }

  // Treat as a URI with a query string.
  const queryIndex = raw.indexOf('?');
  if (queryIndex === -1) {
    throw new Error(
      'Presentation request is neither JSON nor a URI with query parameters.',
    );
  }
  const params = new URLSearchParams(raw.slice(queryIndex + 1));

  // A by-value `request`/`presentation_definition` param may carry JSON.
  const embedded =
    params.get('presentation_definition') ?? params.get('claims') ?? undefined;
  const body = embedded !== undefined ? tryParseJsonObject(embedded) : undefined;

  return body !== undefined ? { params, body } : { params };
}

/**
 * Extract the flat list of requested claim names from a request's params/body.
 * Tries an explicit `requestedClaims` array, then a `presentation_definition`
 * `input_descriptors[].constraints.fields[].path`, then a verifier2
 * `dcql_query.credentials[].claims[].path`. Falls back to the demo defaults.
 */
function extractRequestedClaims(
  params: URLSearchParams | undefined,
  body: Record<string, unknown> | undefined,
): string[] {
  // Explicit flat list on the URI (comma-separated) wins.
  const paramClaims = params?.get('requestedClaims') ?? params?.get('claims');
  if (paramClaims !== undefined && paramClaims.trim().length > 0 && !looksLikeJson(paramClaims)) {
    const names = paramClaims
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    if (names.length > 0) {
      return names;
    }
  }

  const fromBody = body !== undefined ? requestedClaimsFromBody(body) : [];
  return fromBody.length > 0 ? fromBody : [...DEFAULT_REQUESTED_CLAIMS];
}

// Pull claim names out of a JSON request body, trying the common shapes.
function requestedClaimsFromBody(body: Record<string, unknown>): string[] {
  // 1. Explicit flat array.
  const explicit = body.requestedClaims;
  if (Array.isArray(explicit)) {
    const names = explicit.filter(
      (name): name is string => typeof name === 'string' && name.length > 0,
    );
    if (names.length > 0) {
      return names;
    }
  }

  // 2. verifier2 dcql_query.credentials[].claims[].path[last]
  const dcqlCredentials = readPath(body, 'core_flow', 'dcql_query', 'credentials');
  const fromDcql = claimNamesFromDcql(dcqlCredentials);
  if (fromDcql.length > 0) {
    return fromDcql;
  }

  // 3. presentation_definition.input_descriptors[].constraints.fields[].path
  const descriptors = readPath(body, 'presentation_definition', 'input_descriptors');
  const fromPd = claimNamesFromPresentationDefinition(descriptors);
  if (fromPd.length > 0) {
    return fromPd;
  }

  return [];
}

// Extract claim names from a dcql_query credentials array.
function claimNamesFromDcql(credentials: unknown): string[] {
  if (!Array.isArray(credentials)) {
    return [];
  }
  const names: string[] = [];
  for (const credential of credentials) {
    const claims = isObject(credential) ? credential.claims : undefined;
    if (!Array.isArray(claims)) {
      continue;
    }
    for (const claim of claims) {
      const path = isObject(claim) ? claim.path : undefined;
      const name = lastStringOfPath(path);
      if (name !== undefined) {
        names.push(name);
      }
    }
  }
  return dedupe(names);
}

// Extract claim names from presentation_definition input descriptors.
function claimNamesFromPresentationDefinition(descriptors: unknown): string[] {
  if (!Array.isArray(descriptors)) {
    return [];
  }
  const names: string[] = [];
  for (const descriptor of descriptors) {
    const fields = isObject(descriptor)
      ? readPath(descriptor, 'constraints', 'fields')
      : undefined;
    if (!Array.isArray(fields)) {
      continue;
    }
    for (const field of fields) {
      const paths = isObject(field) ? field.path : undefined;
      if (!Array.isArray(paths)) {
        continue;
      }
      // JSONPath entries like `$.degree` / `$.credentialSubject.institution`.
      for (const p of paths) {
        if (typeof p === 'string') {
          const name = p.split('.').filter((s) => s.length > 0).pop();
          if (name !== undefined && name !== '$') {
            names.push(name);
            break;
          }
        }
      }
    }
  }
  return dedupe(names);
}

// Return the last string element of a dcql `path` array (e.g. ["degree"]).
function lastStringOfPath(path: unknown): string | undefined {
  if (!Array.isArray(path)) {
    return undefined;
  }
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const segment = path[i];
    if (typeof segment === 'string' && segment.length > 0) {
      return segment;
    }
  }
  return undefined;
}

// -----------------------------------------------------------------------------
// Redaction
// -----------------------------------------------------------------------------

/**
 * Build a redacted summary of a stored credential for the UI confirmation panel.
 * Returns only non-secret metadata — never the raw `sdJwtVc` or holder key
 * (Req 2.3).
 */
function redactCredential(credential: StoredCredential): {
  stored: true;
  vct: string;
  format: StoredCredential['format'];
} {
  return { stored: true, vct: credential.vct, format: credential.format };
}

// -----------------------------------------------------------------------------
// Session helpers (cookie-based, in-memory)
// -----------------------------------------------------------------------------

/**
 * Read the session id from the `sid` cookie, or `undefined` if absent.
 */
function readSession(req: Request): string | undefined {
  const cookies = (req as RequestWithCookies).cookies;
  const sid = cookies?.[SESSION_COOKIE];
  return typeof sid === 'string' && sid.length > 0 ? sid : undefined;
}

/**
 * Read the session id, minting and setting a new `sid` cookie when none exists.
 */
function ensureSession(req: Request, res: Response): string {
  const existing = readSession(req);
  if (existing !== undefined) {
    return existing;
  }
  const sessionId = randomUUID();
  res.cookie?.(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  });
  // Also reflect it on the request so a subsequent read in the same handler
  // sees the freshly-minted id.
  (req as RequestWithCookies).cookies = {
    ...(req as RequestWithCookies).cookies,
    [SESSION_COOKIE]: sessionId,
  };
  return sessionId;
}

// Express's `Request` with the cookie map populated by `cookieReader`.
interface RequestWithCookies extends Request {
  cookies?: Record<string, string>;
}

/**
 * Minimal cookie-parsing middleware (avoids an extra `cookie-parser` dependency,
 * which is not in package.json). Populates `req.cookies` from the `Cookie`
 * header.
 */
function cookieReader(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.cookie;
  const cookies: Record<string, string> = {};
  if (typeof header === 'string') {
    for (const pair of header.split(';')) {
      const index = pair.indexOf('=');
      if (index === -1) {
        continue;
      }
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (name.length > 0) {
        cookies[name] = decodeURIComponentSafe(value);
      }
    }
  }
  (req as RequestWithCookies).cookies = cookies;
  next();
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// -----------------------------------------------------------------------------
// Error plumbing
// -----------------------------------------------------------------------------

type AsyncRouteHandler = (
  req: Request,
  res: Response,
) => void | Promise<void>;

/**
 * Wrap an async route handler so a rejected promise / thrown error is forwarded
 * to the Express error handler (which renders the step attribution).
 */
function asyncHandler(handler: AsyncRouteHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void Promise.resolve()
      .then(() => handler(req, res))
      .catch(next);
  };
}

/**
 * Express error-handling middleware: render a thrown error as a JSON body naming
 * the failing step (Req 6.3). A `StepError` carries its own step + status; any
 * other error is reported as an internal failure.
 */
function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) {
    return;
  }
  if (error instanceof StepError) {
    res.status(error.status).json({
      success: false,
      error: {
        step: error.step,
        message: error.message,
        ...(error.code !== undefined ? { code: error.code } : {}),
      },
    });
    return;
  }
  res.status(500).json({
    success: false,
    error: { step: 'internal', message: messageOf(error) },
  });
}

// -----------------------------------------------------------------------------
// Small utilities
// -----------------------------------------------------------------------------

// Read a required non-empty string field from a parsed JSON body.
function readStringField(body: unknown, field: string): string | undefined {
  if (isObject(body)) {
    const value = body[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

// Return the first defined, non-empty string among the arguments. Accepts
// `unknown` so callers can pass values read from untyped JSON bodies directly.
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

// Read a nested string value by key path; returns undefined if any hop is absent.
function readPath(source: unknown, ...keys: string[]): unknown {
  let current: unknown = source;
  for (const key of keys) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function tryParseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
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
