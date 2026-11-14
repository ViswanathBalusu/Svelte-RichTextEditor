# ADR 0148: authority-4 backlog batch (FRW-041, FRW-046, FRW-047 and the authority side of the FRW tail)

**Status:** proposed. **Date:** 2026-11-13. **Lane:** authority-4, round 1.

## Context

The lane was asked to take three to five unclaimed stories from the end of the FRW enforcement slice (FRW-080 to FRW-089 and FRW-041 to FRW-059) whose criteria can be met inside `packages/authority`. Stories were read from the end backwards. FRW-088 was skipped because it already has ticked criteria.

## Finding

- FRW-089, FRW-080, FRW-083 to FRW-087: FRW-089 needs the rules evaluation of mirrors and computed labels, and FRW-080 is layout (`packages/layout`). FRW-083 to FRW-087 are owner decisions; no criterion can be ticked by code. Nothing was claimed.
- FRW-049 to FRW-057, FRW-059: the sealing, time-stamp, long-term validation, the evidence bundle, the appearances and the signature provider live in the export, signing and workflow services. None can be met from `packages/authority`.
- FRW-058: the wording check is a repository-wide CI check, outside this package.
- FRW-044, FRW-045, FRW-048: the consent and adoption steps are the participant's client and the service endpoints. The one authority condition (no consent, no sign) depends on the consent record, which is not built, so it was left for the workflow service.
- Taken: FRW-047, FRW-046 and FRW-041, for their pure authority-side cores. Each stays mostly unticked where the endpoint or the store is what the criterion names.

## Decisions taken (proposed, spec default unless noted)

Each code choice is in the files named. None of these was decided by the owner.

1. `checkSign` refuses when `fieldEnabled` is not supplied. The spec requires the visibility check at the sign endpoint, so an unknown visibility fails closed. (Default: fail closed; 12 §8.1 step 3.)
2. `dateSigned` values are the calendar date in the workflow's IANA time zone, formatted `YYYY-MM-DD` with the platform's `Intl.DateTimeFormat`. An unknown zone is a `RangeError`, never a fallback to UTC. (12 §8.1 step 3 and §3.3 state the zone; the format is the ISO 8601 date of `validate`.)
3. `completionCheck` evaluates the rules with no clock (`now: null`) unless the caller passes one. A rule that reads `{ "now": "date" }` therefore yields `no_clock`, and the field counts as not enabled under the evaluator's own rules. The workflow service must pass the server clock and the workflow zone. (Open in 12 §5.1; the evaluator's contract is the rules package's.)
4. `completionCheck` refuses the completion, with the code `rules_unavailable`, when the evaluation fails (for example an invalid rule set or a spent budget). It does not complete with unchecked fields. (Fail closed; 12 §5.3 does not say.)
5. The completion check covers the fields assigned to the participant's roles, as FRW-047's Notes read it. The room-wide reading is not chosen here.
6. Evidence commitment: SHA-256 over a 16-byte random salt followed by the UTF-8 bytes of the canonical evidence text (`packages/authority/src/workflow/evidence.ts`). The canonical text is the caller's; it is not defined here. (ADR 0013 requires salted hashes and names no construction; this is a proposed construction.)
7. A control commit's evidence part is the origin (`sign` or `rules`) and the hash only (FRW-041 criterion 2). The salt is never written into a commit; the workflow tables must hold it, and that storage is not built.

## Open questions left to the owner or the main session

- The canonical encoding of evidence (JCS or a fixed field order) and where the salt is kept. These decide whether a verifier can recompute the hash from the bundle alone (FRW-055).
- Whether the completion check of a participant with `approver` kind has no fields to check, or whether the approver's own confirmation needs a rule (FRW-047 criterion 7 reads it as no fields).
- The rule for a `dateSigned` field that several signatures of one role set (12 §8.1 step 3; FRW-046 Notes): this batch sets it at each signing, as the story reads, and does not decide whether a later signing overwrites it.

## Round 2 (2026-11-13)

Stories taken from the end of the slice: FRW-044, FRW-043 and FRW-042. Each is a pure decision core in `packages/authority/src/workflow/`, tested in `packages/authority/test/`. No criterion is ticked, because each names an endpoint, a store or an administration API that is not built. Scoped checks: the three test files pass (19 tests) and `tsc` reports no error in the new files. The Node.js and fast-check runs cover them; no browser, Podman or PostgreSQL run was needed.

### Decisions taken (proposed, spec default unless noted)

1. Consent (FRW-044, `consent.ts`): a sign is refused when the text the server holds now has a different hash from the one recorded at acceptance. The spec does not say whether an earlier acceptance survives a changed text; refusing is the fail-closed reading. (Default: refuse; 12 §8.1 step 1.)
2. Consent: the hash is SHA-256 over the UTF-8 bytes of the server's text, computed by `recordConsent`. `recordConsent` takes no hash argument, so a client cannot supply one. The spec leaves the hash construction open; this is a proposed construction.
3. Retention (FRW-043, `retention.ts`): `planPurge` takes `retentionMs` and has no default, because FRW-084 is an owner decision. A row is expired when `nowMs - collectedAtMs >= retentionMs`. The instant the retention clock starts from is open: the function uses collection time, the reading the caller passes in. (Open, not decided.)
4. Retention: a legal hold removes nothing, and the audit entry holds counts and the instant only. No row identifier is written to the audit entry. (FRW-043 criterion 4 and 12 §7 data minimisation; the reading is ours.)
5. Capture (FRW-042, `capture.ts`): the setting defaults to on (`DEFAULT_CAPTURE_SETTINGS`), as FRW-042 Notes read the spec. With the setting off, keys named `ipAddress` or `userAgent` in the other items are dropped too. (Default: on, as FRW-042 records.)
6. Capture: a change applies to events at or after its instant. The latest change at or before the instant wins; at equal instants the later entry in the list wins. (Proposed reading of "applies to events after the change".)

### Open questions added

- The retention clock's start point (collection, completion or the end of the workflow); FRW-043 and FRW-084.
- Whether an acceptance survives a changed consent text (decision 1 above); FRW-044.
- The administration credential that may change the capture setting; FRW-042 criterion 4 names only "the tenant-administration credential".

## Round 3 (2026-11-13, lane authority-4)

Stories taken from the end of the slice: FRW-057 (criterion 6 ticked), FRW-049 (criterion 4 ticked), and FRW-053 and FRW-054 (notes only). Pure decision cores in `packages/authority/src/workflow/appearance.ts` and `finalisation.ts`, tested by `packages/authority/test/workflow.appearance.test.ts` and `workflow.finalisation.test.ts` (18 tests pass; `tsc` reports no error in the new files). No browser, Podman or PostgreSQL run was needed or done.

### Decisions taken (proposed, spec default unless noted)

1. Finalisation order (FRW-049, FRW-053, FRW-054): compile, then seal, then store, each failure stops the run at `completed`. `finalised` is raised only when every step succeeds and the stored hash equals the sealed hash. (The spec gives the order in 12 §8.2; the stored-hash equality is our reading of "the sealed bytes are stored".)
2. A seal without an RFC 3161 time-stamp token is refused (FRW-053 criterion 5). The spec says no seal without a time-stamp is produced; the check is ours.
3. Retry: the gate returns no retry and does not loop. The spec does not state a retry policy for a failed compile, seal or store (Open questions 26). The service decides whether to retry; the gate returns the stage and code.
4. Layout validation (FRW-057 criterion 3): `validateLayout` checks only the `fields` part of `layout.json` (page as a positive integer, rectangle as four finite numbers with `x0 < x1` and `y0 < y1`). A bad entry is dropped and reported; a file with no `fields` object is refused whole. The full schema of the file is not in the spec text and is the export's (09 §9.3); this is a proposed partial check, not the schema.
5. Appearances are planned only for `signature` and `initials` fields (FRW-057 criterion 2). A rectangle outside its page is not used. A missing rectangle or an unknown page gives a diagnostic and never stops the seal (FRW-057 criterion 6).

### Open questions added

- The full schema of `layout.json` (09 §9.3) is not written down as a file the authority can read; it is needed before the schema clause of FRW-057 criterion 3 can be ticked.
- Whether the operator alert on a stopped run is raised by the gate or by the service (FRW-053 criterion 5, FRW-049 criterion 3). The gate returns `alert: true`; delivery is the service's.
- The retry policy after a failed compile, seal or store (Open questions 26; FRW-049, FRW-053).
- The package `@docedit/authority` does not depend on `@docedit/history`, so the evidence-bundle verifier (FRW-055) that combines `verifyBundle` with the salted evidence hashes is not built here. It needs a dependency decision in the main session (`package.json`).

## Round 4 (2026-11-13, lane authority-4)

Stories taken from the end of the slice: FRW-059 (criteria 4 and 5 ticked), FRW-058 (no criterion ticked; check and notes), FRW-055 (criterion 5 ticked; the evidence-item part of criterion 3 covered). Also the leftover of the last review: the workflow modules `capture`, `completion`, `consent`, `evidence` and `retention` are exported from `packages/authority/src/index.ts`, and so are the new modules. Tests: `workflow.provider.test.ts`, `workflow.language.test.ts`, `workflow.bundle.test.ts` and the finalisation test pass (35 tests); `tsc --noEmit` reports no error in the package. No browser, Podman or PostgreSQL run was needed or done.

Nothing in the new code calls `finaliseWorkflow`'s `raised` list or `planAppearances`; the workflow and signing services that would do so are not built, so FRW-057 criterion 6 and FRW-049 criterion 3 stay as they were.

### Decisions taken (proposed, spec default unless noted)

1. `SignatureProvider` (FRW-059, `workflow/provider.ts`): the provider receives the document hash alone, and a hash that is not lower-case SHA-256 hexadecimal is refused before any call. (12 §8.3 says only the hash is sent; the refusal is ours.)
2. A provider result without a time-stamp is treated as `tsa_unreachable`, so `finaliseWorkflow` stops at the seal. (The reason name is borrowed from the native seal; the mapping is ours.)
3. A failed embedding (a throw, or a hash that is not SHA-256) is `seal_failed`, and no sealed hash or asserted facts are returned. (Nothing half-signed: FRW-059 criterion 4.)
4. A thrown error from the provider is `signing_unavailable`; `provider_invalid_response` is `seal_failed`. (Our mapping of the failure kinds onto the seal reasons of FRW-053.)
5. `SignatureProvider` is not in the port list of 05 §8.3. This batch adds it as a proposed port in code only; the spec change is a PRO decision for the owner, who should confirm it.
6. The provider's level and signer are returned as facts asserted by that provider, never as verified. (ADR 0013 and FRW-058 criterion 5.)
7. The overclaim phrase list (FRW-058, `workflow/language.ts`) is a maintained floor chosen by us, not counsel's list (FRW-087). The native description is the one 12 §8.3 gives in the FRW-058 story. The check runs over strings it is given; a repository-wide CI run is not wired.
8. The evidence bundle (FRW-055, `workflow/bundle.ts`) carries the evidence items and the instructions only. The instructions state that the bundle does not prove identity or intent, and that authentication is as asserted by the host. (Our wording, to be checked by counsel under FRW-087.)

### Open questions added

- Whether a provider signature is embedded by the export or by the signing service (FRW-059 criterion 1).
- The repository-wide wording check and how it treats existing spec text that uses "qualified" as a term (FRW-058 criterion 1).
- The canonical encoding of evidence items in a bundle, which decides whether a verifier can recompute a hash from the bundle alone (still open from round 1).

## Round 5 (2026-11-13, lane authority-4, second run)

Stories taken from the end of the slice: FRW-045 (criterion 5 ticked, with the existing matrix test as evidence), FRW-050 (no criterion ticked; the facts are built), FRW-052 (no criterion ticked; the pure rules are built). Tests: `workflow.certificate.test.ts` and `workflow.sealing.test.ts` (new, 12 tests, property tests included) and `matrix.test.ts` pass; `tsc --noEmit` on `tsconfig.json` and `tsconfig.test.json` reports no error. No browser, Podman or PostgreSQL run was needed or done. The new modules are not yet exported from `src/index.ts`; the tests import them by path.

### Decisions taken (proposed, spec default unless noted)

1. Sealing key (FRW-052 criterion 4, `workflow/sealing.ts`): a tenant with no entry in the configuration seals with the operator's key. The spec gives the two options and no default; this is our default and the owner decides the sealing party (11 §10 item 11). An empty key id is refused rather than replaced.
2. Seal request (FRW-052 criterion 3): the caller must be the document service, and the document, `seq` and PDF hash must equal the expected values. The first failing check is named. The name `document-service` is the caller passed in, not a fixed constant of the module.
3. Certificate facts (FRW-050, `workflow/certificate.ts`): events are ordered by server time, then by the order viewed, consent, signed, completed, declined. Two events at the same time keep this order. A duplicate participant or an unknown event kind is refused.
4. Certificate network identity (FRW-050 criterion 6; FRW-042): with capture off, the IP address and user agent keys are absent from every event, not null. The module reads the setting it is given and does not read stored evidence.
5. Certificate wording (FRW-050 criterion 7): `CERTIFICATE_STATEMENT` uses the native description of 12 §8.3 and the FRW-058 phrase "as asserted by the host". The sentences are ours and need counsel's review (FRW-087) before any production use.

### Open questions added

- Whether a seal request is authenticated by the document service's credential or by a signed token (FRW-052 criterion 3). Not decided here; the caller is compared by name only.
- The retry and alert path when the signing service is unavailable (FRW-052 criterion 5) and whether a renewal job (FRW-056 criterion 5) shares its retry rules with finalisation (Open questions 26).

## Round 6 (2026-11-13, lane authority-4, third run)

Stories taken from the end of the slice: FRW-056 only. The rest of the slice has no criterion that `packages/authority` can meet, so the lane took one story and recorded why the others were skipped. Nothing ticked.

- FRW-089, FRW-080: no authority criterion. FRW-089 criterion 1 needs the rules closure (`packages/rules/src/hidden.ts`) and the authority's redaction; FRW-080 is layout (`packages/layout`).
- FRW-083 to FRW-087: owner decisions. The spec gives no default for FRW-084 (retention period; 12 §15 question 7), so no number is proposed here. FRW-085 and FRW-086 have an option the spec states as the current behaviour, and no code is written for either. FRW-087 is counsel's review.
- FRW-088: already has ticked criteria, so it was skipped. Its criterion 3 is refused in the authority (`outcome.ts`, tests in `outcome.fields.test.ts`), but the editor's redacted display is not, so it stays unticked.
- FRW-048: keyboard and screen-reader ceremony is the editor's and the participant client's.

### Decisions taken (proposed, spec default unless noted)

1. The lead time before a time-stamp expires is a required parameter of `planRenewal` with no default. 12 §8.2 says "before the current one expires" and gives no interval. No number is invented.
2. A renewal is a compare and set on the expiry it was planned against. A second run that planned on the same expiry is refused as `stale`. (FRW-056 criterion 5, "one time-stamp per expiry"; our reading of it.)
3. A new time-stamp is refused unless its expiry extends the chain and has not already passed. (Our check; the spec does not state it.)
4. A failed renewal always alerts, and asks for a retry only while time remains before the expiry. The retry interval is the scheduler's. (12 §8.2 and FRW-056 criterion 5; the retry policy is still open, Open questions 26.)

### Open questions added

- The lead time before expiry (FRW-056 criterion 2): the owner or the operator should set it. Until then the scheduler cannot run.
- Whether the compare and set on the expiry is enforced by the store (a conditional write) or by the job's lock. Not decided here.
