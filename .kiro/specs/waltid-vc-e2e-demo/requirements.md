# Requirements Document

## Introduction

This feature delivers a lean, end-to-end Verifiable Credential (VC) demonstration built on the walt.id Open-Source Identity Stack. The demo exercises the full lifecycle of a credential across three roles: an Issuer issues an Education Certificate as an SD-JWT VC via OpenID4VCI, a minimal web wallet accepts the offer and stores the credential, the wallet produces an OpenID4VP presentation with selective disclosure (revealing degree and institution while hiding grades), and a Verifier validates that presentation.

The system is orchestrated with Docker Compose and composed of three services (`issuer`, `wallet`, `verifier`) following the CDPI monorepo repository kit layout. Glue code, scripts, and the wallet UI are written in TypeScript/Node.js. The walt.id microservices (`waltid-issuer-api`, `waltid-verifier-api`) and the `waltid-identity-sdk` provide standards-compliant issuance, verification, key management, and DID resolution.

The scope is intentionally demo-focused: a working happy-path flow is prioritized over exhaustive error handling, broad credential catalogs, or strict coverage enforcement. Compliance targets are the W3C VC Data Model, SD-JWT VC, OpenID4VCI, and OpenID4VP, with `did:key`/JWK keys provided through the `waltid-identity-sdk`.

## Glossary

- **Demo_System**: The complete end-to-end demonstration composed of the Issuer_Service, Wallet_Service, and Verifier_Service orchestrated through Docker Compose.
- **Issuer_Service**: The service built on `waltid-issuer-api` that issues Education Certificate credentials over OpenID4VCI.
- **Wallet_Service**: The minimal web wallet UI (TypeScript/Node.js) that acts as the Holder, accepting credential offers and producing presentations.
- **Verifier_Service**: The service built on `waltid-verifier-api` that requests and validates presentations over OpenID4VP.
- **Credential_Offer**: An OpenID4VCI credential offer produced by the Issuer_Service and consumed by the Wallet_Service.
- **Education_Certificate**: The demonstration credential type carrying attributes including holder name, degree, institution, and grades.
- **SD_JWT_VC**: A Selective Disclosure JWT Verifiable Credential as defined by the SD-JWT VC specification.
- **Selective_Disclosure**: The mechanism by which the Wallet_Service reveals a chosen subset of credential attributes and withholds the remainder in a presentation.
- **Presentation_Request**: An OpenID4VP request produced by the Verifier_Service specifying which attributes a presentation must disclose.
- **Presentation**: An OpenID4VP verifiable presentation produced by the Wallet_Service from a stored Education_Certificate.
- **Identity_SDK**: The `waltid-identity-sdk` providing key generation (JWK) and DID resolution (`did:key`).
- **Compose_Stack**: The Docker Compose configuration that defines, builds, and runs the Issuer_Service, Wallet_Service, and Verifier_Service.
- **Integration_Test**: The automated happy-path test that drives the full issue-store-present-verify flow.
- **CI_Pipeline**: The GitHub Actions workflow defined in `.github/workflows/ci.yml`.

## Requirements

### Requirement 1: Credential Issuance via OpenID4VCI

**User Story:** As a credential issuer, I want to issue an Education Certificate as an SD-JWT VC over OpenID4VCI, so that a holder can obtain a standards-compliant verifiable credential.

#### Acceptance Criteria

1. WHEN an issuance is initiated for an Education_Certificate, THE Issuer_Service SHALL produce a Credential_Offer that conforms to the OpenID4VCI specification.
2. WHEN the Issuer_Service issues an Education_Certificate, THE Issuer_Service SHALL encode the credential in the SD_JWT_VC format.
3. THE Issuer_Service SHALL include the attributes holder name, degree, institution, and grades in the issued Education_Certificate.
4. WHEN the Issuer_Service issues an Education_Certificate, THE Issuer_Service SHALL sign the credential using a key provided by the Identity_SDK with a `did:key` identifier.
5. IF a credential issuance request specifies an unsupported credential type, THEN THE Issuer_Service SHALL return an OpenID4VCI error response.

### Requirement 2: Wallet Credential Acceptance and Storage

**User Story:** As a credential holder, I want a web wallet to accept a credential offer and store the issued credential, so that I can hold my Education Certificate for later presentation.

#### Acceptance Criteria

1. WHEN a user submits a Credential_Offer to the Wallet_Service through the web UI, THE Wallet_Service SHALL complete the OpenID4VCI exchange with the Issuer_Service and receive the Education_Certificate.
2. WHEN the Wallet_Service receives an Education_Certificate, THE Wallet_Service SHALL store the credential in the SD_JWT_VC format for the duration of the session.
3. WHEN the Wallet_Service has stored an Education_Certificate, THE Wallet_Service SHALL display a confirmation of the stored credential in the web UI.
4. THE Wallet_Service SHALL accept a Credential_Offer entered by paste or by scanning in the web UI.
5. IF a submitted Credential_Offer cannot be parsed, THEN THE Wallet_Service SHALL display an error message identifying the offer as invalid.

### Requirement 3: Selective Disclosure Presentation via OpenID4VP

**User Story:** As a credential holder, I want the wallet to present my credential while revealing only selected attributes, so that I can prove my degree and institution without exposing my grades.

#### Acceptance Criteria

1. WHEN the Wallet_Service produces a Presentation from a stored Education_Certificate, THE Wallet_Service SHALL create an OpenID4VP Presentation that conforms to the OpenID4VP specification.
2. WHEN the Wallet_Service applies Selective_Disclosure to an Education_Certificate, THE Wallet_Service SHALL reveal the degree attribute and the institution attribute.
3. WHEN the Wallet_Service applies Selective_Disclosure to an Education_Certificate, THE Wallet_Service SHALL withhold the grades attribute from the Presentation.
4. WHEN the Wallet_Service responds to a Presentation_Request, THE Wallet_Service SHALL bind the Presentation to the challenge provided in the Presentation_Request.

### Requirement 4: Presentation Verification via OpenID4VP

**User Story:** As a credential verifier, I want to request and validate a presentation over OpenID4VP, so that I can confirm the authenticity of the disclosed attributes.

#### Acceptance Criteria

1. WHEN a verification is initiated, THE Verifier_Service SHALL produce a Presentation_Request that conforms to the OpenID4VP specification and names the degree and institution attributes.
2. WHEN the Verifier_Service receives a Presentation, THE Verifier_Service SHALL validate the issuer signature by resolving the issuer `did:key` through the Identity_SDK.
3. WHEN the Verifier_Service validates a Presentation, THE Verifier_Service SHALL confirm that the disclosed degree and institution attributes are present and verifiable.
4. WHEN the Verifier_Service completes validation of a conforming Presentation, THE Verifier_Service SHALL return a successful verification result.
5. IF a received Presentation fails signature validation, THEN THE Verifier_Service SHALL return a failed verification result identifying the validation error.

### Requirement 5: Container Orchestration

**User Story:** As a developer, I want to launch the entire stack with a single Docker Compose command, so that I can run the demo locally without manual service configuration.

#### Acceptance Criteria

1. THE Compose_Stack SHALL define the Issuer_Service, the Wallet_Service, and the Verifier_Service as separate services.
2. THE Compose_Stack SHALL pin each walt.id component to an explicit version tag.
3. THE Compose_Stack SHALL configure a memory limit between 512 megabytes and 1 gigabyte for each service.
4. WHEN a developer runs the Compose_Stack startup command, THE Compose_Stack SHALL start the Issuer_Service, the Wallet_Service, and the Verifier_Service.
5. WHERE a service exposes an HTTP interface, THE Compose_Stack SHALL map that interface to a host port.

### Requirement 6: Automated Integration Test

**User Story:** As a developer, I want an automated happy-path integration test, so that I can confirm the full issue-store-present-verify flow works end to end.

#### Acceptance Criteria

1. WHEN the Integration_Test runs against a running Compose_Stack, THE Integration_Test SHALL drive the flow from credential issuance through to presentation verification.
2. WHEN the full flow completes with a successful verification result, THE Integration_Test SHALL report a passing outcome.
3. IF any step in the flow returns an error, THEN THE Integration_Test SHALL report a failing outcome identifying the failed step.

### Requirement 7: Continuous Integration Pipeline

**User Story:** As a developer, I want a minimal CI pipeline, so that code quality and the Docker build are checked automatically on changes.

#### Acceptance Criteria

1. WHEN a pull request targets the main branch, THE CI_Pipeline SHALL run automatically.
2. THE CI_Pipeline SHALL configure the Node.js environment using the setup-node action.
3. THE CI_Pipeline SHALL run the project linter.
4. THE CI_Pipeline SHALL verify that the Compose_Stack builds.

### Requirement 8: Quickstart Documentation

**User Story:** As a new user, I want quickstart documentation, so that I can set up and run the demo without prior knowledge of the stack.

#### Acceptance Criteria

1. THE Demo_System SHALL provide a README that documents the steps to start the Compose_Stack.
2. THE Demo_System SHALL document in the README the steps to execute the issue-store-present-verify flow through the Wallet_Service web UI.
3. THE Demo_System SHALL document in the README the command to run the Integration_Test.
