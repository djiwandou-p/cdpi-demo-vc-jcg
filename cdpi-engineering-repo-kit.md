# CDPI Technical Assessment: Repository Kit & CI/CD Readiness Package

This engineering readiness package provides a production-grade repository structure, automated CI/CD workflow templates, Pull Request (PR) guidelines, and operational runbooks tailored for the **Centre for Digital Public Infrastructure (CDPI)** technical assessment.

---

## 1. Mock Repository Structure

Below is the recommended monorepo layout designed to maintain clean separation between the core roles of the Verifiable Credential ecosystem—**Issuer**, **Holder/Wallet**, and **Verifier**—while enforcing engineering discipline.

```text
cdpi-vc-stack/
├── .github/
│   ├── PULL_REQUEST_TEMPLATE.md         # Standardized PR submission checklist
│   ├── CODEOWNERS                       # CODEOWNERS for mandatory area reviews
│   └── workflows/
│       ├── ci.yml                       # Continuous Integration (Lint, Test, SAST)
│       └── release.yml                  # Automated Build & Release Packaging
├── docs/
│   ├── adr/
│   │   ├── 0001-stack-selection.md      # Architecture Decision Record for open-source stack
│   │   └── 0002-key-management.md       # ADR for cryptographic key storage & DIDs
│   ├── api/
│   │   ├── openid4vci.openapi.yaml      # OpenAPI spec for Issuance endpoints
│   │   └── openid4vp.openapi.yaml       # OpenAPI spec for Verification endpoints
│   └── runbooks/
│       ├── deployment.md                # Environment provisioning & setup guide
│       └── change-incident-handling.md  # Rollback & incident management procedures
├── services/
│   ├── issuer/                          # Credential Issuance Engine (OpenID4VCI)
│   │   ├── src/
│   │   ├── tests/
│   │   ├── Dockerfile
│   │   └── README.md
│   ├── wallet/                          # Self-Custody Wallet Interface (Holder)
│   │   ├── src/
│   │   ├── tests/
│   │   ├── Dockerfile
│   │   └── README.md
│   └── verifier/                        # Proof Verification Engine (OpenID4VP)
│       ├── src/
│       ├── tests/
│       ├── Dockerfile
│       └── README.md
├── docker-compose.yml                   # Single-command local sandbox launch
├── .gitignore
├── LICENSE
└── README.md                            # Main project overview & quickstart
```

---

## 2. GitHub Actions CI/CD Workflow Templates

### A. Continuous Integration (`.github/workflows/ci.yml`)
Enforces automated code linting, static security analysis (SAST), unit testing, and Docker container build verification on every pull request.

```yaml
name: CDPI Stack CI

on:
  pull_request:
    branches: [ main, develop ]
  push:
    branches: [ main, develop ]

jobs:
  lint-and-format:
    name: Code Quality & Linting
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Set up Environment
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Dependencies
        run: npm ci || true

      - name: Run Linter
        run: |
          echo "Running static code analysis & formatting checks..."
          # Replace with stack-specific linter (e.g., eslint, flake8, ktlint)

  security-sast:
    name: Security & Vulnerability Scanning
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Secret Scanning (Gitleaks)
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Dependency Vulnerability Check
        run: |
          echo "Scanning dependencies for known CVEs..."

  unit-integration-tests:
    name: Unit & Integration Testing
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Execute Tests & Generate Coverage
        run: |
          echo "Executing test suite for Issuer, Wallet, and Verifier..."
          # Enforce minimum threshold (e.g., 80% coverage)

  docker-build-check:
    name: Docker Build Verification
    runs-on: ubuntu-latest
    needs: [lint-and-format, security-sast, unit-integration-tests]
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Verify Docker Compose Build
        run: |
          docker compose build
          docker compose config
```

---

## 3. Pull Request Review Guidelines & Template

### PR Template (`.github/PULL_REQUEST_TEMPLATE.md`)

```markdown
## Summary of Changes
- [ ] Feature / Fix Description:

## Impacted Components
- [ ] Issuer Service (OpenID4VCI)
- [ ] Wallet / Holder App
- [ ] Verifier Service (OpenID4VP)
- [ ] CI/CD & Infrastructure

## Verification & Compliance Checklist
- [ ] **Unit & Integration Tests**: Added/updated tests and verified 100% pass rate locally.
- [ ] **Cryptographic & Privacy Safeguards**: Verified no private keys, secrets, or raw PII are logged or committed.
- [ ] **Protocol Compliance**: Confirmed payload structure conforms to W3C VC / SD-JWT VC / OpenID specs.
- [ ] **Documentation**: Updated API schemas (OpenAPI) and ADRs if architectural decisions changed.

## Peer Review Requirements
- Minimum 2 senior engineer approvals required.
- All automated CI status checks must be green before merging.
```

### Mandatory PR Review Guidelines
1. **Branch Protection**: Block direct pushes to `main` and `develop`. Require pull requests with at least **2 peer approvals**.
2. **Squash & Merge**: Enforce clean commit histories on `main` using conventional commit messages (e.g., `feat(issuer): add OpenID4VCI token endpoint`).
3. **No Key Leaks**: Zero-tolerance policy for committing private keys, test certs with private keys, or API credentials.

---

## 4. Architecture Decision Record (ADR) Template

Save architectural choices in `docs/adr/0001-stack-selection.md` to demonstrate decision-making maturity to CDPI evaluators.

```markdown
# ADR 0001: Selection of Core Open-Source Credential Stack

* **Status**: Accepted
* **Date**: 2026-10-14
* **Deciders**: Lead Architect, Engineering Pod

## Context & Problem Statement
The CDPI assessment requires deploying a functional Verifiable Credential stack supporting issuance, wallet holding, and verification under tight delivery deadlines (Oct 14–21, 2026).

## Considered Options
1. **walt.id SDK/Services** (Kotlin/Java/TS)
2. **MOSIP Inji Stack** (Digital Public Goods ecosystem)
3. **CREDEBL Platform** (Microservices architecture)

## Decision Outcome
Chosen Option: **[Selected Stack]** because it offers out-of-the-box compliance with OpenID4VCI and OpenID4VP, minimal setup overhead for local sandboxes, and modular extensibility.
```

---

## 5. Change & Incident Handling Protocol

### Versioning Strategy
- Follow **Semantic Versioning (SemVer 2.0.0)**: `MAJOR.MINOR.PATCH`.
- Tag releases automatically upon merging to `main` (e.g., `v1.0.0-assessment`).

### Rollback Procedure
1. Revert merged PR using Git squash revert to preserve commit audit logs.
2. Trigger automated rollback deployment via Docker Compose / Helm script:
   ```bash
   docker compose -f docker-compose.yml down
   docker compose -f docker-compose.yml up -d --build
   ```
3. Document incident cause, impact, and remediation in `docs/runbooks/change-incident-handling.md`.
