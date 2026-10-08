# Implementation Plan: walt.id VC End-to-End Demo

## Overview

This plan builds the demo bottom-up: first the monorepo skeleton and the version-pinned Docker Compose topology, then the pre-built issuer/verifier configuration, then the custom TypeScript wallet BFF module-by-module (each module paired with its property or unit tests), then the thin web UI, then the happy-path integration driver, and finally CI and quickstart docs.

The issuer and verifier are consumed as opaque `waltid/issuer-api2` / `waltid/verifier-api2` images — their tasks are configuration only. All bespoke application code lives in `services/wallet`. Property tests use in-memory fakes for the SDK and HTTP boundaries so they stay fast and deterministic (design: Testing Strategy); the integration driver exercises the real pinned containers.

Follow the design's data model (`CredentialOffer`, `StoredCredential`, `PresentationRequest`, `VerificationResult`) and BFF module split (`offerIntake`, `oid4vciClient`, `holderKeys`, `sessionStore`, `disclosureSelector`, `oid4vpClient`, `httpApi`).

## Tasks

- [x] 1. Scaffold the monorepo and wallet toolchain
  - [x] 1.1 Create the repository skeleton
    - Create directory layout per design "Repository Layout": `services/issuer/config`, `services/verifier/config`, `services/wallet/src`, `services/wallet/public`, `services/wallet/tests`, `tests/integration`, `docs/adr`, `.github/workflows`.
    - Add top-level `.gitignore` (node_modules, dist, build artifacts, env files) and `LICENSE` placeholder.
    - Move/author `docs/adr/0001-waltid-stack-selection.md` reference stub so the ADR lives under `docs/adr`.
    - _Requirements: 5.1_

  - [x] 1.2 Initialize the wallet TypeScript/Node project
    - Create `services/wallet/package.json` with scripts: `build`, `start`, `lint`, `test`; dependencies on `waltid-identity-sdk`, an HTTP framework (e.g. express), and dev deps for TypeScript, ESLint, the test runner, and `fast-check`.
    - Add `tsconfig.json`, ESLint config, and the test runner config under `services/wallet`.
    - Create `services/wallet/src/types.ts` defining `CredentialOffer`, `StoredCredential`, `PresentationRequest`, `VerificationResult` exactly as in design "Internal Wallet Types".
    - _Requirements: 7.3_

- [x] 2. Configure the pre-built issuer and verifier services
  - [x] 2.1 Author the Issuer Education Certificate profile and did:key
    - Under `services/issuer/config`, define the Education Certificate credential profile: credential type/`vct` (`EducationCertificate`), SD-JWT VC format, the SDK-generated issuer `did:key` signing key, the four-attribute claim template (`name`, `degree`, `institution`, `grades`), and which claims are selectively disclosable.
    - Add `services/issuer/README.md` describing the profile and how the offer is created.
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 2.2 Author the Verifier presentation definition and policies
    - Under `services/verifier/config`, define the OpenID4VP presentation definition requesting `degree` and `institution` from an Education Certificate, plus validation policies (issuer signature, holder binding, SD-JWT disclosure integrity, did:key resolution).
    - Add `services/verifier/README.md` describing the request and policies.
    - _Requirements: 4.1, 4.2, 4.3_

- [x] 3. Author the Docker Compose stack
  - [x] 3.1 Write docker-compose.yml with pinned, mem-limited services
    - Define `issuer`, `verifier`, `wallet` services on the `cdpi-net` network per design "Docker Compose Topology".
    - Pin `waltid/issuer-api2` and `waltid/verifier-api2` to explicit published release tags (no `latest`/floating tags).
    - Set `mem_limit`: `1g` for issuer and verifier (JVM), `512m` for wallet (Node) — within the 512 MB–1 GB band.
    - Map host ports `7005:7005`, `7004:7004`, `3000:3000`; mount issuer/verifier config dirs read-only; add health checks and `depends_on: service_healthy` for the wallet.
    - Inject `ISSUER_BASE_URL=http://issuer:7005` and `VERIFIER_BASE_URL=http://verifier:7004` into the wallet.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 3.2 Write a config lint/smoke test for the Compose file
    - Assert all three services are present, walt.id image tags are pinned (not `latest`), each service has a memory limit in the 512 MB–1 GB band, and the required host port mappings exist.
    - _Requirements: 5.1, 5.2, 5.3, 5.5_

- [x] 4. Implement wallet offer intake and session storage
  - [x] 4.1 Implement the offerIntake module
    - Create `services/wallet/src/offerIntake.ts`: normalize pasted/scanned input into a canonical `CredentialOffer` (issuer, preAuthorizedCode, credentialConfigurationIds, raw); reject malformed input with an invalid-offer error before any network call (fail fast).
    - Treat paste and scan inputs through one normalization path so they produce identical results.
    - _Requirements: 2.4, 2.5_

  - [ ]* 4.2 Write property test for paste/scan equivalence
    - **Property 4: Paste and scan intake are equivalent**
    - **Validates: Requirements 2.4**

  - [ ]* 4.3 Write property test for rejecting unparseable offers
    - **Property 5: Unparseable offers are rejected** (reject, surface invalid-offer error, leave stored state unchanged)
    - **Validates: Requirements 2.5**

  - [x] 4.4 Implement the sessionStore module
    - Create `services/wallet/src/sessionStore.ts`: in-memory, session-scoped storage of the raw SD-JWT VC keyed by session id (`StoredCredential`); no persistence beyond the session; provide store and retrieve operations.
    - _Requirements: 2.2_

  - [ ]* 4.5 Write property test for credential storage round-trip
    - **Property 2: Credential storage round-trip** (retrieve returns an SD-JWT VC equal to the one stored)
    - **Validates: Requirements 2.2**

- [x] 5. Implement holder key handling and the OpenID4VCI client
  - [x] 5.1 Implement the holderKeys module
    - Create `services/wallet/src/holderKeys.ts`: use `waltid-identity-sdk` to generate the holder JWK and `did:key`, and produce the key-binding proof used in the credential request and later in presentation.
    - _Requirements: 1.4, 2.1_

  - [x] 5.2 Implement the oid4vciClient module
    - Create `services/wallet/src/oid4vciClient.ts`: drive the OpenID4VCI pre-authorized code flow against the issuer (token request → credential request with holder proof), parse the returned SD-JWT VC into a `StoredCredential`.
    - Build the issuance claim set so it carries all four Education Certificate attributes.
    - Map issuer OpenID4VCI error responses (e.g. unsupported credential type) to a failure tagged with the `token`/`credential` step.
    - _Requirements: 2.1, 1.3, 1.5_

  - [ ]* 5.3 Write property test for the four-attribute claim set
    - **Property 1: Education Certificate carries all four attributes** (assembled claim set contains name, degree, institution, grades)
    - **Validates: Requirements 1.3**

  - [ ]* 5.4 Write unit test for unsupported-credential-type error mapping
    - Assert an issuer OpenID4VCI error response surfaces as a failure naming the failing step.
    - _Requirements: 1.5_

- [x] 6. Checkpoint - Ensure intake, storage, keys, and issuance client tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement selective disclosure and the OpenID4VP client
  - [x] 7.1 Implement the disclosureSelector module
    - Create `services/wallet/src/disclosureSelector.ts`: given a stored Education Certificate SD-JWT VC and a `PresentationRequest`, select the disclosures to reveal (`degree`, `institution`) and drop the rest (`grades`).
    - _Requirements: 3.2, 3.3_

  - [ ]* 7.2 Write property test for selective disclosure
    - **Property 3: Selective disclosure reveals degree and institution and withholds grades**
    - **Validates: Requirements 3.2, 3.3**

  - [x] 7.3 Implement the oid4vpClient module
    - Create `services/wallet/src/oid4vpClient.ts`: build the SD-JWT VP + key-binding JWT bound to the request `nonce`, and post the authorization response (`vp_token`) to the verifier; return a normalized `VerificationResult`.
    - Relay verifier failure results as `{ success: false, error: { step: 'verify', message } }`.
    - _Requirements: 3.1, 3.4, 4.5_

  - [ ]* 7.4 Write property test for challenge binding
    - **Property 6: Presentation binds to the request challenge** (presentation bound to the exact supplied nonce)
    - **Validates: Requirements 3.4**

  - [ ]* 7.5 Write unit test for failed-signature result relay
    - Assert a verifier signature-validation failure surfaces as a failed result naming the validation error/step.
    - _Requirements: 4.5_

- [ ] 8. Implement the wallet BFF HTTP API
  - [-] 8.1 Implement the httpApi module and server entrypoint
    - Create `services/wallet/src/httpApi.ts` (and a server entrypoint) exposing: `POST /wallet/offer` (run OpenID4VCI, store, confirm), `GET /wallet/credential` (redacted stored-credential summary), `POST /wallet/present` (apply selective disclosure, submit `vp_token`, return verifier result), `GET /healthz` (liveness).
    - Wire `offerIntake`, `oid4vciClient`, `holderKeys`, `sessionStore`, `disclosureSelector`, `oid4vpClient` together; wrap each handler stage with its step name so failures identify the failing step.
    - Read `ISSUER_BASE_URL` / `VERIFIER_BASE_URL` from the environment.
    - _Requirements: 2.1, 2.3, 3.1_

  - [ ]* 8.2 Write unit tests for the HTTP API handlers
    - Test `/wallet/offer` stored confirmation payload, `/wallet/credential` redacted summary, `/healthz` liveness, and per-step failure surfacing in error responses.
    - _Requirements: 2.3, 6.3_

- [ ] 9. Build the thin wallet web UI
  - [~] 9.1 Implement the web UI under services/wallet/public
    - Offer intake by paste (textarea) and scan (QR via camera/image → decoded string), an "Accept offer" action, and a stored-credential confirmation panel driven by `GET /wallet/credential`.
    - Presentation-request intake (paste/scan), a "Present" action, and a verification-result display.
    - Show the invalid-offer error from `offerIntake` without changing stored state.
    - UI talks only to the wallet BFF.
    - _Requirements: 2.3, 2.4, 2.5_

- [ ] 10. Containerize the wallet
  - [~] 10.1 Write the wallet Dockerfile
    - Create `services/wallet/Dockerfile` (Node base) that installs deps, builds TypeScript, serves the BFF + static UI on port 3000, and exposes `/healthz` for the Compose health check.
    - Add `services/wallet/README.md` noting build/run.
    - _Requirements: 5.4, 5.5_

- [~] 11. Checkpoint - Ensure wallet build and all wallet tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Implement the happy-path integration test driver
  - [~] 12.1 Write the full-flow integration driver
    - Create `tests/integration/full-flow.test.ts` driving against a running Compose stack via REST: (1) create an Education Certificate offer on the issuer; (2) `POST /wallet/offer` and assert a stored SD-JWT VC confirmation; (3) create a verifier presentation request naming `degree`+`institution` and capture the `nonce`; (4) `POST /wallet/present`; (5) assert `success: true`, `degree` and `institution` disclosed, `grades` absent.
    - On any step error, fail the test and name the failing step using the BFF step tag.
    - _Requirements: 6.1, 6.2, 6.3, 3.1, 4.1, 4.2, 4.3, 4.4_

- [ ] 13. Add the minimal CI pipeline
  - [~] 13.1 Write .github/workflows/ci.yml
    - Trigger on pull requests targeting `main`.
    - `lint` job: `actions/checkout`, `actions/setup-node` (Node 20), `npm ci`, `npm run lint` over `services/wallet` and the integration test.
    - `compose-build` job: `actions/checkout`, `docker compose build` and `docker compose config` to confirm the stack builds and the Compose file is valid.
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [ ] 14. Write quickstart documentation
  - [~] 14.1 Author README.md and docs/quickstart.md
    - Top-level `README.md`: steps to start the Compose stack (`docker compose up`), the end-to-end issue-store-present-verify walkthrough through the wallet web UI, and the command to run the integration test.
    - `docs/quickstart.md`: supporting notes (prerequisites, ports, troubleshooting, where config lives).
    - _Requirements: 8.1, 8.2, 8.3_

- [~] 15. Final checkpoint - Ensure the full stack and all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (unit/property/integration-adjacent tests) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirements clauses for traceability; property-test tasks additionally name the exact design property.
- Property tests (Properties 1–6) use in-memory fakes for the SDK and HTTP boundaries and run ≥100 iterations each; the integration driver exercises the real pinned walt.id containers.
- The issuer and verifier are pre-built images — their tasks are configuration only; all bespoke source lives in `services/wallet`.
- Checkpoints provide incremental validation at natural module boundaries.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.2"] },
    { "id": 1, "tasks": ["1.2", "3.1"] },
    { "id": 2, "tasks": ["3.2", "4.1", "4.4", "5.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "4.5", "5.2", "7.1"] },
    { "id": 4, "tasks": ["5.3", "5.4", "7.2", "7.3"] },
    { "id": 5, "tasks": ["7.4", "7.5", "8.1"] },
    { "id": 6, "tasks": ["8.2", "9.1"] },
    { "id": 7, "tasks": ["10.1"] },
    { "id": 8, "tasks": ["12.1", "13.1", "14.1"] }
  ]
}
```
