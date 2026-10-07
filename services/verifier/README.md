# Verifier Service

The Verifier is a **pre-built, version-pinned `waltid/verifier-api2` container** consumed over
REST only — there is **no application source** here, just configuration. It acts as the relying
party in the demo: it issues an OpenID4VP 1.0 presentation request, receives the `vp_token` from
the wallet, resolves the issuer `did:key`, validates the presentation against the configured
policies, and returns a structured verification result.

> Verifier2 implements the finalized **OpenID4VP 1.0** specification and listens on port **7004**.
> On the Compose network it is reachable at `http://verifier:7004`; on the host at
> `http://localhost:7004` (`/swagger` for the API explorer).

Config files in this directory are mounted read-only into the container at
`/waltid-verifier-api2/config` (see the root `docker-compose.yml`).

## Files

| File | Purpose |
| :--- | :--- |
| `verifier-service.conf` | Service-wide defaults: verifier identity (`clientId`), the request/response base URL on the Compose network, and the default validation policies. |
| `presentation-request.json` | The OpenID4VP presentation request body (`POST /verification-session/create`) that asks for an Education Certificate and discloses only `degree` and `institution`. |

## The presentation request

Verifier2 expresses *what to request* using the **Digital Credential Query Language (DCQL)**
inside `core_flow.dcql_query`. `presentation-request.json` requests a single credential:

- **`format`: `dc+sd-jwt`** — an SD-JWT VC (IETF SD-JWT VC), matching how the issuer encodes the
  Education Certificate.
- **`meta.vct_values`: `["EducationCertificate"]`** — the credential type (`vct`) issued by the
  Issuer service.
- **`require_cryptographic_holder_binding`: `true`** — the holder must prove possession of the key
  bound into the credential (KB-JWT).
- **`claims`** — requests only the `degree` and `institution` paths. Because SD-JWT VC supports
  selective disclosure, the wallet discloses **only these two claims**; `name` and `grades` are not
  requested and stay hidden. This satisfies **Requirement 4.1** (the request names `degree` and
  `institution`).

### Using it

```bash
# Start a verification session (returns a sessionId + an openid4vp:// authorization request URL)
curl -X POST http://localhost:7004/verification-session/create \
  -H 'Content-Type: application/json' \
  -d @services/verifier/config/presentation-request.json

# Present the returned authorization request URL / QR to the wallet, then read the result:
curl http://localhost:7004/verification-session/{sessionId}/info
```

The response of `create` contains `bootstrapAuthorizationRequestUrl` (compact, for QR codes) and
`fullAuthorizationRequestUrl`, plus a `nonce` the presentation must bind to. The wallet consumes
this request string, applies selective disclosure, and posts the `vp_token` back to the verifier.

## Validation policies

Policies live in two buckets. `vc_policies` run against each received credential; `vp_policies`
run against the presentation envelope. They are set as service-wide defaults in
`verifier-service.conf` and are also stated explicitly in `presentation-request.json`.

| Policy | Bucket | What it enforces | Requirement |
| :--- | :--- | :--- | :--- |
| `signature` | `vc_policies` | **Issuer signature.** The issuer `did:key` is resolved to its public key and the credential signature is verified against it. | 4.2 |
| `dc+sd-jwt/kb-jwt_signature` | `vp_policies` | **Holder binding.** Verifies the key-binding JWT with the holder's key, proving the presenter holds the credential. | 4.2 |
| `dc+sd-jwt/sd_hash-check` | `vp_policies` | **SD-JWT disclosure integrity.** Recomputes the selective-disclosure hashes and matches them against the SD-JWT, so disclosed claims cannot be tampered with. | 4.3 |
| `dc+sd-jwt/nonce-check` | `vp_policies` | **Challenge binding.** The presentation `nonce` matches the one issued for this session. | 4.2 |
| `dc+sd-jwt/audience-check` | `vp_policies` | **Audience binding.** The presentation audience matches this verifier (`clientId`). | 4.2 |

On success the session reaches status `SUCCESSFUL` with `policy_results.overallSuccess: true`, and
the disclosed `degree` and `institution` appear under `presented_credentials` (**Requirement 4.3**).
If signature or binding validation fails, the session reports `FAILED` and the failing policy is
named in `policy_results` (surfaced to the wallet as a failed verification result).

## did:key resolution

Issuer and holder identifiers in this demo are `did:key`. Verifier2 resolves these DIDs to their
public keys as part of the `signature` and `kb-jwt_signature` policies — the same `did:key`
primitives the wallet uses via the `waltid-identity-sdk`, so issuer-signature verification and
holder-binding verification share one resolution path (**Requirement 4.2**).

## Notes

- This service is **config only**. The container image is pulled and version-pinned in
  `docker-compose.yml`; nothing here is built.
- The exact walt.id image tag is pinned in the Compose file (no `latest`/floating tags).
- `urlPrefix` defaults to the in-network `http://verifier:7004/...`. When testing with an external
  mobile wallet, override it with a public URL (e.g. ngrok) via `VERIFIER_URL_PREFIX` or the
  per-session `url_config.url_prefix`.
