# ADR 0001: Adoption of walt.id Open-Source Stack for CDPI Verifiable Credential Implementation

* **Status**: Accepted
* **Date**: 2026-10-14
* **Deciders**: Lead Architect, Core Engineering Pod
* **Technical Context**: CDPI Verifiable Credential Assessment (Indonesia)

---

## 1. Context and Problem Statement

The Centre for Digital Public Infrastructure (CDPI) requires technology service providers to deploy an end-to-end Verifiable Credential (VC) ecosystem covering three core roles: **Issuer**, **Holder/Wallet**, and **Verifier**. The ecosystem must support government use cases such as disability cards, education certificates, driving licenses, and government employee IDs.

To meet the evaluation criteria set by CDPI, the system must comply with international open specifications—specifically **W3C Verifiable Credentials Data Model**, **SD-JWT VC**, **ISO/IEC 18013-5 (mDL/mDoc)**, **OpenID4VCI** (Issuance), and **OpenID4VP** (Presentation)—while demonstrating production-grade software engineering and release discipline within a strict delivery window.

Our team requires a flexible, standards-compliant, and modular open-source credential stack that allows rapid onboarding, seamless API integration, and automated CI/CD packaging.

---

## 2. Decision Drivers

1. **Protocol Standards Compliance**: Out-of-the-box support for OpenID4VCI, OpenID4VP, W3C VCs, and SD-JWT VC with selective disclosure.
2. **Developer Velocity & Modularity**: Lightweight microservice APIs and SDKs that can be deployed quickly via Docker containers.
3. **Privacy & Security Controls**: Support for cryptographic key management, selective disclosure, and status verification.
4. **Engineering Evaluation Readiness**: Compatibility with automated testing pipelines, health monitoring, and containerized release workflows.

---

## 3. Considered Options

* **Option 1**: **walt.id Open-Source Identity Stack** (`waltid-identity-sdk`, `waltid-issuer-api`, `waltid-verifier-api`)
* **Option 2**: **Inji Stack** (`inji-certify` & `inji-wallet`)
* **Option 3**: **Custom In-House Microservices** (Building crypto and OpenID engines from scratch)

---

## 4. Decision Outcome

**Chosen Option**: **Option 1 – walt.id Open-Source Identity Stack**

### **Rationale**:
* **Native Protocol Alignment**: walt.id provides dedicated microservices for `waltid-issuer-api` and `waltid-verifier-api` that natively implement OpenID4VCI and OpenID4VP specs, drastically reducing custom protocol development time.
* **Format Flexibility**: Offers multi-format support including W3C VCs, SD-JWT VC, and JWT/JSON-LD signatures, matching the scope required by CDPI.
* **Modular Deployment**: Written in Kotlin/Java with clean REST APIs and pre-built Docker containers, enabling isolated deployment in our monorepo architecture.
* **Developer Ecosystem**: Mature open-source codebase with comprehensive OpenAPI/Swagger documentation, making API contract generation and testing straightforward for CI/CD.

---

## 5. Pros and Cons of the Chosen Option

### **Positive Consequences**:
* Enables complete end-to-end issuance, holding, and verification flows within 48–72 hours of environment setup.
* Reduces cryptographic implementation risk by leveraging vetted walt.id core libraries for DID resolution, key generation, and signature validation.
* Out-of-the-box REST API contracts allow our frontend and integration developers to build wallet and mock issuer/verifier UIs in parallel.

### **Negative Consequences & Mitigations**:
* **JVM Resource Footprint**: Java/Kotlin runtime requires slightly higher memory allocations per container.
  * *Mitigation*: Configure explicit container memory limits (`512MB`–`1GB` per service) in `docker-compose.yml` and staging manifests.
* **Rapid Spec Evolution**: OpenID4VCI and OpenID4VP specs are actively evolving.
  * *Mitigation*: Pin walt.id library versions in project dependency configurations to prevent unexpected breaking changes during assessment.

---

## 6. Technical Mapping against CDPI Baseline Scope

| CDPI Requirement Domain | walt.id Component / Mechanism | Verification Strategy |
| :--- | :--- | :--- |
| **Credential Issuance** | `waltid-issuer-api` (OpenID4VCI) | Automated issuance tests via authorization code & pre-authorized code flows |
| **Credential Presentation** | `waltid-verifier-api` (OpenID4VP) | Verifier challenge validation and response proof parsing |
| **Data Formats** | W3C VC, SD-JWT VC, JWT | Schema validation against target government credential templates |
| **Privacy / Selective Disclosure** | SD-JWT VC Selective Disclosure Engine | Verification of masked payload attributes during presentation |
| **Key & DID Resolution** | `waltid-identity-sdk` (JWK, `did:key`, `did:web`) | Public key resolution checks without backend API dependencies |

---

## 7. Approval & Next Steps

1. **Repository Integration**: Merge walt.id service definitions into `/services/issuer`, `/services/verifier`, and `/services/wallet`.
2. **Configuration Pinning**: Store configuration parameters, cryptographic key specs, and JSON schemas in `/config/schemas/`.
3. **Pipeline Verification**: Execute `.github/workflows/ci.yml` to confirm build, linting, and integration test passes.
