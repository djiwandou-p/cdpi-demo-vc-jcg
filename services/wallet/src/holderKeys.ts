// Holder key handling for the walt.id VC end-to-end demo.
//
// Responsibilities (design: Components -> Wallet Service -> `holderKeys`):
//   - Generate the holder's Ed25519 key as a JWK plus a `did:key` identifier.
//   - Produce the key-binding proof (a KB-JWT) bound to a given nonce + audience,
//     used both in the OpenID4VCI credential request (holder proof) and later in
//     the OpenID4VP presentation (SD-JWT key binding).
//
// Stack note: the Kotlin `waltid-identity-sdk` is not published to npm (only
// `waltid-sd-jwt` is). To avoid adding unlisted dependencies, holder key
// generation and KB-JWT signing use Node's built-in `node:crypto`, which
// supports Ed25519 key generation, JWK export, and EdDSA sign/verify natively.
// The resulting `did:key` uses the same Ed25519 `z6Mk` multibase scheme as the
// issuer signing key configured in `services/issuer/config` so the holder and
// issuer identifiers are resolvable with identical primitives.

import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  sign as cryptoSign,
  randomUUID,
  type KeyObject,
} from 'node:crypto';

// -----------------------------------------------------------------------------
// Public shapes
// -----------------------------------------------------------------------------

// Ed25519 public JWK (OKP). This is the shape embedded in the credential's
// `cnf.jwk` holder-binding claim and in the KB-JWT protected header.
export interface Ed25519PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string; // base64url raw public key (32 bytes)
}

// Ed25519 private JWK (OKP) — adds the `d` member. Held only in server-side
// session state; never surfaced to the browser.
export interface Ed25519PrivateJwk extends Ed25519PublicJwk {
  d: string; // base64url raw private key seed (32 bytes)
}

// The holder key material produced by `generateHolderKey`.
export interface HolderKey {
  // Private JWK — the full key, used for signing the key-binding proof.
  jwk: Ed25519PrivateJwk;
  // Public-only JWK — safe to embed in `cnf.jwk` / request proofs.
  publicJwk: Ed25519PublicJwk;
  // The holder `did:key` (Ed25519 `z6Mk...` multibase form).
  did: string;
  // The verification method / `kid` for this key: `${did}#${multibase}`.
  kid: string;
}

// Inputs for building a key-binding JWT (KB-JWT).
export interface KeyBindingInput {
  // The holder key to sign with (from `generateHolderKey`).
  holderKey: HolderKey;
  // The challenge the proof must bind to:
  //   - OpenID4VCI credential request: the `c_nonce` from the issuer.
  //   - OpenID4VP presentation: the `nonce` from the presentation request.
  nonce: string;
  // The intended recipient of the proof:
  //   - OpenID4VCI: the credential issuer identifier (`aud`).
  //   - OpenID4VP: the verifier `client_id` / response URI.
  audience: string;
  // JOSE header `typ`. Defaults to `kb+jwt` (SD-JWT key binding). For an
  // OpenID4VCI JWT proof pass `openid4vci-proof+jwt`.
  typ?: string;
  // Optional override for the issued-at time (seconds since epoch); defaults to now.
  issuedAt?: number;
  // Optional SD-JWT digest (`sd_hash`) to bind the presentation to the exact
  // disclosed payload. Included as the `sd_hash` claim when provided.
  sdHash?: string;
}

// -----------------------------------------------------------------------------
// base64url + base58btc helpers (self-contained, no external deps)
// -----------------------------------------------------------------------------

function toBase64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Encode bytes as base58btc (Bitcoin alphabet), used for `did:key` multibase.
function encodeBase58btc(bytes: Buffer): string {
  if (bytes.length === 0) {
    return '';
  }

  // Count and preserve leading zero bytes as leading '1's.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros += 1;
  }

  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j += 1) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += BASE58_ALPHABET[digits[i] as number];
  }
  return out;
}

// Multicodec prefix for an Ed25519 public key: 0xed 0x01 (varint).
const ED25519_MULTICODEC_PREFIX = Buffer.from([0xed, 0x01]);

// Derive the `did:key` (and its multibase fragment) from a 32-byte raw Ed25519
// public key, per the did:key method for Ed25519 (`z6Mk...`).
function didKeyFromRawEd25519(rawPublicKey: Buffer): { did: string; multibase: string } {
  const prefixed = Buffer.concat([ED25519_MULTICODEC_PREFIX, rawPublicKey]);
  const multibase = `z${encodeBase58btc(prefixed)}`;
  return { did: `did:key:${multibase}`, multibase };
}

// Extract the raw 32-byte Ed25519 public key from a KeyObject.
// Ed25519 SPKI DER is a fixed 44 bytes; the raw key is the trailing 32 bytes.
function rawEd25519PublicKey(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(der.length - 32));
}

// -----------------------------------------------------------------------------
// Key generation
// -----------------------------------------------------------------------------

/**
 * Generate a fresh Ed25519 holder key and its `did:key`.
 *
 * Returns the private JWK (for signing proofs), the public-only JWK (for the
 * `cnf.jwk` holder binding), the `did:key`, and the key id (`kid`).
 */
export function generateHolderKey(): HolderKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  const publicJwkRaw = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const privateJwkRaw = privateKey.export({ format: 'jwk' }) as Record<string, unknown>;

  const x = String(publicJwkRaw.x);
  const d = String(privateJwkRaw.d);

  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x };
  const jwk: Ed25519PrivateJwk = { kty: 'OKP', crv: 'Ed25519', x, d };

  const rawPublic = rawEd25519PublicKey(publicKey);
  const { did, multibase } = didKeyFromRawEd25519(rawPublic);

  return { jwk, publicJwk, did, kid: `${did}#${multibase}` };
}

// Reconstruct a Node private KeyObject from an Ed25519 private JWK so it can sign.
function privateKeyObjectFromJwk(jwk: Ed25519PrivateJwk): KeyObject {
  return createPrivateKey({ key: jwk, format: 'jwk' });
}

/**
 * Re-derive the public JWK + `did:key` for an existing Ed25519 public JWK.
 * Useful when a key is restored from session state rather than freshly generated.
 */
export function didKeyFromPublicJwk(publicJwk: Ed25519PublicJwk): { did: string; kid: string } {
  const key = createPublicKey({ key: publicJwk, format: 'jwk' });
  const rawPublic = rawEd25519PublicKey(key);
  const { did, multibase } = didKeyFromRawEd25519(rawPublic);
  return { did, kid: `${did}#${multibase}` };
}

// -----------------------------------------------------------------------------
// Key-binding proof (KB-JWT)
// -----------------------------------------------------------------------------

/**
 * Build and sign a key-binding JWT (KB-JWT) with the holder key.
 *
 * The proof is bound to the supplied `nonce` (the challenge) and `audience`.
 * The same primitive serves two call sites:
 *   - OpenID4VCI credential request — proof of holder key possession
 *     (`typ: 'openid4vci-proof+jwt'`, `audience` = credential issuer).
 *   - OpenID4VP presentation — SD-JWT key binding
 *     (`typ: 'kb+jwt'`, `audience` = verifier), optionally carrying `sd_hash`.
 *
 * The protected header embeds the holder public JWK (`jwk`) and a `kid` so a
 * verifier can resolve the holder key without an out-of-band lookup.
 *
 * @returns the compact JWS (`header.payload.signature`).
 */
export function buildKeyBindingJwt(input: KeyBindingInput): string {
  const { holderKey, nonce, audience } = input;
  const typ = input.typ ?? 'kb+jwt';
  const iat = input.issuedAt ?? Math.floor(Date.now() / 1000);

  const header = {
    alg: 'EdDSA',
    typ,
    jwk: holderKey.publicJwk,
    kid: holderKey.kid,
  };

  const payload: Record<string, unknown> = {
    iat,
    nonce,
    aud: audience,
    jti: randomUUID(),
  };
  if (input.sdHash !== undefined) {
    payload.sd_hash = input.sdHash;
  }

  const encodedHeader = toBase64Url(Buffer.from(JSON.stringify(header), 'utf8'));
  const encodedPayload = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const privateKey = privateKeyObjectFromJwk(holderKey.jwk);
  // EdDSA signs the message directly (no pre-hash) — pass `null` as the algorithm.
  const signature = cryptoSign(null, Buffer.from(signingInput, 'utf8'), privateKey);

  return `${signingInput}.${toBase64Url(signature)}`;
}

/**
 * Decode a compact JWS into its header and payload objects without verifying
 * the signature. Intended for tests and for inspecting a proof's bound claims.
 */
export function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('invalid compact JWT: expected three dot-separated segments');
  }
  const [encodedHeader, encodedPayload] = parts as [string, string, string];
  const header = JSON.parse(fromBase64Url(encodedHeader).toString('utf8')) as Record<string, unknown>;
  const payload = JSON.parse(fromBase64Url(encodedPayload).toString('utf8')) as Record<string, unknown>;
  return { header, payload };
}
