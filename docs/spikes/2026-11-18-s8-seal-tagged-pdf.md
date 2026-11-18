# Spike S8: seal a tagged PDF with a managed key and a time-stamp

**Status:** spike result, 2026-11-18, SPK-021; not reviewed. The Acrobat check is open (section 6).

## Question

Can the final PDF from the LaTeX pipeline be sealed with a PAdES signature and an RFC 3161 time-stamp, with a key that is held in a key service and never on a compile worker, without losing the tagging (11 §2, S8; 12 §8.2)? Which long-term validation profile does phase 2 use?

## Answer

Yes, on the evidence below, with a test chain, a key emulator and a local time-stamp authority (owner decisions 221 to 223). Nothing here is a production arrangement.

- **A tagged LuaLaTeX PDF is sealed and verified.** The sample is the export worker's demonstration document, converted with the house class and compiled locally (TeX Live 2025): PDF 2.0, 50,508 bytes. It is sealed at PAdES B-LT and at B-LTA. OpenSSL verifies the CMS signature, its chain to the test root and the signature time-stamp; pyHanko 0.38.1 (optional) reports each signature intact, valid and trusted, and the validation data in the file as an allowed update.
- **The key stays in the key service.** The key is an RSA 3072-bit key made inside a SoftHSM2 container, reported by the token as sensitive and never extractable. The sealing code sends only the 32-byte SHA-256 digest of the signed attributes; no document byte goes to the key service. The compile worker's sources, its image and its package files hold nothing of a key or of the key service (section 5).
- **Tagging survives.** veraPDF 1.30.3 accepts the unsealed sample, the B-LT file and the B-LTA file as PDF/UA-2 and as PDF/A-4f. The invisible signature fields needed no structure tree entry.
- **One changed byte is reported.** A byte changed in the signed part breaks the signature; a byte changed in the validation data breaks the document time-stamp and leaves the signature valid; a byte changed in a time-stamp token breaks that token (section 4).
- **Profile: B-LT for phase 2, B-LTA by appending a document time-stamp later.** This is a recommendation for the owner (section 3).
- **Production library: not decided.** The spike used `pkijs` for the CMS structures and wrote the PDF side itself. It is not fit for production as it stands ([ADR 0411](../adr/0411-unblock-SPK-021-sealing-library-key-emulator-profile.md), proposed).

## What was built

| Part | Where |
|---|---|
| PDF reader (cross-reference tables and streams, Flate object streams) and incremental-update writer | `services/signing-service/src/pdf.ts` |
| Signature field, signature dictionary with fixed-width `/ByteRange`, DSS with VRI, document time-stamp, `sealPdf`, `addDocumentTimestamp` | `services/signing-service/src/pades.ts` |
| CMS (CAdES) with a remote signer, RFC 3161 client | `services/signing-service/src/cms.ts` |
| The key service port: a public key and `signDigest` | `services/signing-service/src/keyservice.ts` |
| Key service emulator: SoftHSM2 in Alpine, `podman exec` client | `services/signing-service/keyservice/`, `test/support/softhsm.ts` |
| Test chain (OpenSSL), local time-stamp authority (`openssl ts -reply` behind loopback HTTP), verifier (OpenSSL), pyHanko check, sample source | `services/signing-service/test/support/` |
| Scripts: build the key service image; make the sample files | `services/signing-service/scripts/` |
| 33 tests in four files; the pyHanko file (3 tests) runs only when `DOCEDIT_PYHANKO_PYTHON` is set | `services/signing-service/test/` |

The package is `@docedit/signing-service` (01 §6). Its sources import nothing from the export worker; the emulator and the tests do, for the Podman command line and the veraPDF runner.

## The arrangement

- **Key.** `localhost/docedit-keyservice-spk021:1`, built from `alpine:3` pinned by digest with `softhsm`, `opensc` (for `pkcs11-tool`) and `openssl`. The token and the key are made when the container starts, with random PINs that stay inside it. The container runs with no network, a read-only root file system, tmpfs for the token, all capabilities dropped. `DOCEDIT_CONTAINER_CLI` overrides `podman`.
- **Chain.** Made for each run with the OpenSSL command line: root CA, "sealing CA", the sealing certificate (issued for the public key the key service reports; the private key is never seen) and a time-stamp authority certificate (`timeStamping`, critical). CRLs for both CAs. The sealing certificate has `nonRepudiation` and `id-kp-documentSigning`. The CA keys are RSA 2048-bit and live in a temporary folder.
- **Time-stamp authority.** A loopback HTTP server that answers `application/timestamp-query` with `openssl ts -reply`. The tokens are therefore made by OpenSSL, and checked by OpenSSL and pyHanko, while the client that asks for them is our code.
- **Signature.** `ETSI.CAdES.detached`. Signed attributes: content type, message digest, signing-certificate-v2. No signing-time attribute (PAdES carries the time in `/M`). The signature time-stamp is an unsigned attribute over the signature value. An invisible widget (zero rectangle, flags 132) holds the field.
- **Updates.** Every step is an incremental update: the signature (B-T), the DSS (B-LT), the document time-stamp (B-LTA). The bytes that came in are the first bytes of the bytes that come out, which the tests check.

## 3. The profile

| | B-LT | B-LTA |
|---|---|---|
| What is in the file | Signature, signature time-stamp, certificates and CRLs in the DSS | The same, and a document time-stamp over the whole file including the DSS |
| Size of the sample (50,508 bytes in) | 90,341 bytes | 124,283 bytes |
| Extra time-stamp requests at sealing | none | one |
| What keeps it valid after the certificates or algorithms expire | nothing yet | the document time-stamp, renewed by a job |

Both sizes include 32,768 bytes of zero padding per signature or time-stamp (`/Contents` has 16,384 bytes of room; the signature needed 6,575 bytes with the test authority's chain in the token). The room is a setting.

**Recommendation: B-LT at completion in phase 2, as the second review proposes (SR-K8), and B-LTA when the renewal job exists (FRW-056).** Reasons:

1. B-LT already makes the file checkable offline while the certificates are valid: the validation data is in the file.
2. A document time-stamp matters when something in the chain expires or weakens. Nothing renews it yet, so it adds a request and bytes without a job to use it.
3. Nothing is lost by waiting: `addDocumentTimestamp` turns a B-LT file into a B-LTA file by appending, and renews one the same way. `test/spk-021-seal.test.ts` upgrades a B-LT file, renews the time-stamp once more, checks that each result starts with the previous bytes and that all three signature objects verify.
4. `finalisation.seal` (12 §6.1) can name either, so the owner can take B-LTA from the start with no change to the design.

The owner decides.

## 4. Results by criterion

| Criterion | Result | Evidence |
|---|---|---|
| 1. Sealed with a key in a key service and an RFC 3161 time-stamp; validates in Acrobat | Sealed and verified by OpenSSL and pyHanko. **Acrobat not checked**: it needs a person | `test/spk-021-key-service.podman.test.ts`; sample files below |
| 2. Profile chosen, reason recorded | Recommended B-LT (section 3) | This section; ADR 0411 |
| 3. The key never leaves the key service and is never on a compile worker | Met | Section 5 |
| 4. Tagging survives sealing; veraPDF validates | Met | veraPDF 1.30.3 in Podman (the export worker's pinned image): the unsealed sample, the B-LT file and the B-LTA file each pass `ua2` and `4f` |

**Changed bytes** (`spk-021-seal.test.ts` on a classic-table file, `spk-021-key-service.podman.test.ts` on the tagged sample): a byte flipped in the page content makes OpenSSL reject the signature and the document time-stamp; in the validation data, the document time-stamp fails and the signature stays valid; in the signature value, the signature fails; in a time-stamp token's signature value, the token fails. A byte appended after a B-LT signature does not break it (that is how later updates work).

## 5. The key and the compile worker

By construction:

- The sealing code reaches a key only through `KeyService`, which has `keyLabel`, `publicKey()` and `signDigest(algorithm, digest)`. `test/spk-021-no-key-on-worker.test.ts` reads the interface and fails if a method is added.
- `pkijs`'s signing call, which needs a key object, is not used.
- The export worker, the converter and the class contain no private key block, name no key service, import nothing from the signing service and do not list it as a dependency. The signing service's sources import nothing from the worker.

By test:

- Every call to the key service in the tests had a 32-byte SHA-256 digest (`Recording` in the Podman test; `InProcessKeyService.calls` in the other).
- The token says `Access: sensitive, always sensitive, never extractable` for the private key, and a read of the key's value returns nothing.
- The key service image holds no token (`/var/lib/softhsm/tokens` is empty); the running container has network mode `none`.
- The compile worker image (`localhost/docedit-export-worker:s4`) has no `softhsm2-util` or `pkcs11-tool`, no file named like a key store (`*softhsm*`, `.p12`, `.pfx`, `.key`) and no private key block under `/etc`, `/opt`, `/root`, `/home`, `/srv`, `/usr/local`, `/var/lib`.
- The sealed files contain no `PRIVATE KEY`.

Limits: the emulator's PINs and token are in a container on the same Podman machine as the compile sandbox. A production key service is a different trust boundary (FRW-052); this spike does not model that boundary, only that no code or file on the compile side reaches a key.

## 6. The Acrobat check (open)

Open this file in Acrobat (25.1 is on the development machine):

`E:\CodeBase\Svelte-RichText-Editor\.worktrees\unblock\docs\spikes\2026-11-18-s8-sealing\sample-sealed-b-lt.pdf`

(`sample-sealed-b-lta.pdf` is the same file with the document time-stamp; `sample-unsealed.pdf` is the input.)

What to expect with a self-signed certificate, from how Acrobat treats untrusted roots (not seen by me):

1. Before trusting the test root: the signature panel should say the validity is unknown or the signer's identity is unknown, because the root is not in Acrobat's trusted list. The time-stamp may be reported as untrusted for the same reason. The document should not be reported as changed after signing.
2. After importing `test-root-ca.cer` (Edit, Preferences, Signatures, Identities and Trusted Certificates, More, Trusted Certificates, Import; then edit its trust to use it as a trusted root): Validate Signature should report the signature as valid, signed by "DocEdit Test Seal (SPK-021)", with an embedded time-stamp, no changes since signing, and long-term validation enabled. The seal does not use an Adobe-approved trust list, so no green check from that list is expected.

The test root's SHA-256 fingerprint is `CC:1B:A3:C1:BA:62:7A:5C:F6:6B:7F:CD:40:2C:FA:14:8F:66:23:7F:53:EC:FE:2D:6B:78:DD:02:3A:87:90:A9`. The files are regenerated by `node services/signing-service/scripts/make-sample.ts`, which makes a new root each time, so this fingerprint belongs to the committed files only. The certificates have fake CRL addresses (`crl.test.invalid`); Acrobat should use the CRLs in the DSS.

If Acrobat reports a problem the verifiers did not, record it in SPK-021's Notes before anything is built on this.

## 7. Measurements

Taken on the development machine (Windows 11, a Podman machine under WSL shared with other agents' jobs, so timings are noisy), 2026-11-18:

- `sealPdf` at B-LT on the sample, key service by `podman exec`, local time-stamp authority: 857 ms and 1,895 ms in two runs of `scripts/make-sample.ts`. A document time-stamp added to it: 78 ms and 275 ms.
- The signature's CMS: 6,575 bytes (with the time-stamp token and two certificates).
- Test run times, one file at a time: the Podman test file 100 s (it includes the sample compile, the chain, the seals, the checks and the veraPDF runs); the OpenSSL-only file 26 s; the pyHanko file 35 s. All four files together, run at once while other jobs shared the machine: 33 tests passed in 565 s.

No claim is made about throughput or about a hardware module or cloud key service; their call latency will differ from `podman exec`.

## 8. What FRW-052, FRW-053 and FRW-056 should know

- LuaTeX's tagged PDF 2.0 has a cross-reference stream and object streams. The update must then be a cross-reference stream too. `pdf.ts` does both kinds; the classic-table path is tested on a hand-made file.
- `/Contents` room is fixed before the signature exists. The signature plus a token with the authority's chain was 6,575 bytes here; a real authority's token can be larger. A signature that does not fit raises `PdfError` and nothing is half-written. Size the room from the real authority.
- The VRI key is the SHA-1 of the signature's DER bytes without the zero padding, as read from ETSI TS 102 778-4. pyHanko accepted the file; Acrobat has not seen it.
- The DSS holds CRLs only, because the test authority has no OCSP responder. OCSP responses go in the same way (`ocsps`).
- Time-stamp requests can meet a connection the authority closed while idle; the client retries once.
- `openssl ts -reply` keeps a serial file, so the test authority answers one request at a time.
- The PDF has no form fields, so the existing-form branch of `appendField` (merging into an existing `/AcroForm` and `/Fields`) has no test. FRW-057's visible appearances will use that path.
- The signing time in `/M` comes from the caller. 12 §8.2 should say whose clock it is.
- `ValidationData` is a callback taking the token's certificates, so a real validation-data collector (fetching OCSP and CRLs at sealing) fits in without a change to `sealPdf`.
- On the Windows Podman machine used here, containers need `--cgroups=disabled`; `test/support/softhsm.ts` sets `DOCEDIT_CONTAINER_CGROUPS` for a remote client unless it is already set.

## 9. Not covered

- Acrobat (above), and any other PDF viewer.
- ETSI conformance tests and EU DSS's validator. They are the next checks for a production library.
- Visible appearances, an existing form in the PDF, encrypted PDFs, hybrid-reference files, signing a PDF that already has signatures.
- OCSP, revocation of the seal certificate, a certificate that expires between sealing and checking.
- A real hardware module, cloud key service, certificate or time-stamp authority (owner decisions 222 and 223 leave them open).
- Concurrency: one seal at a time was run.

## How to run

```
node services/signing-service/scripts/build-keyservice-image.ts        # once; fetches Alpine packages
pnpm exec vitest run --project node services/signing-service           # OpenSSL, Podman, lualatex needed; skips what is missing
node services/signing-service/scripts/make-sample.ts                   # rewrites docs/spikes/2026-11-18-s8-sealing/
DOCEDIT_PYHANKO_PYTHON=<python with pyhanko and pyhanko-certvalidator>  # adds the pyHanko check
```
