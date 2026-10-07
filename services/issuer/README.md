# Issuer Service

The issuer is a **pre-built, version-pinned `waltid/issuer-api2` container** consumed
purely over REST. There is no application source here — only configuration. The
container implements OpenID4VCI 1.0 and signs credentials from a *profile* defined
in this directory.

Everything in `config/` is mounted read-only into the container at
`/waltid-issuer-api2/config` (see the root `docker-compose.yml`). Issuer2 reads
profiles **once at startup**, so restart the container after editing them.

## Education Certificate profile

The demo advertises a single credential: an **Education Certificate** issued as an
IETF **SD-JWT VC** (`format = "dc+sd-jwt"`).

| Aspect | Value |
| :--- | :--- |
| Credential type (`vct`) | `EducationCertificate` |
| Configuration id | `EducationCertificate` |
| Format | SD-JWT VC (`dc+sd-jwt`) |
| Signing key | Ed25519 `did:key` (EdDSA) |
| Issuer DID | `did:key:z6MkghqZKawSkF4xoxjTnP1vsbwx2ivgU3aE1fJp8B5bhhY5` |
| Holder binding | `did:key` / `jwk` proof |

### Attributes (claim template)

All four subject attributes are present at issuance. **Every attribute is
selectively disclosable** (`sd = true`); the holder chooses which to reveal at
presentation time (the demo reveals `degree` and `institution`, withholds `grades`).

| Attribute | Claim | Type | Selectively disclosable |
| :--- | :--- | :--- | :--- |
| Holder name | `name` | string | yes |
| Degree | `degree` | string | yes |
| Institution | `institution` | string | yes |
| Grades | `grades` | string | yes |

### Config files

| File | Purpose |
| :--- | :--- |
| `config/credential-issuer-metadata.conf` | Declares the `EducationCertificate` credential configuration (format, `vct`, supported signing/binding methods, display + claim metadata). |
| `config/issuer2-profiles.conf` | Defines the `educationCertificateSdJwt` profile: the `did:key` signing key, the four-attribute claim template, the claim mapping, and the `selectiveDisclosure` settings (all four claims disclosable). |

> The issuer signing key is a **fixed demo key** committed for reproducibility.
> Do not reuse it outside this demonstration.

## How a credential offer is created

An offer is produced by calling the Issuer2 offer-creation endpoint against the
`EducationCertificate` configuration. The service returns an OpenID4VCI credential
offer URL (surfaced to the user as a link / QR) that the wallet redeems via the
pre-authorized code flow.

Example (pre-authorized code flow, issuer reachable at `http://localhost:7005`):

```bash
curl -X POST http://localhost:7005/openid4vci/offer \
  -H "Content-Type: application/json" \
  -d '{
    "credentialConfigurationId": "EducationCertificate"
  }'
```

- Default subject data comes from the profile's `credentialData`. To issue for a
  specific holder, override the claim values per-offer via `runtimeOverrides`
  instead of editing the profile.
- The response is a `openid-credential-offer://...` URL. Hand it to the wallet
  (`POST /wallet/offer`), which runs the token + credential requests and receives
  the signed SD-JWT VC.
- The exact endpoint path and request body follow the pinned Issuer2 release;
  confirm against the running service's Swagger UI at `http://localhost:7005/swagger`.

## References

- [Issuer2 — Getting started](https://docs.walt.id/community-stack/issuer2/getting-started)
- [Issuer2 — Setup](https://docs.walt.id/community-stack/issuer2/setup)

Content was rephrased for compliance with licensing restrictions.
