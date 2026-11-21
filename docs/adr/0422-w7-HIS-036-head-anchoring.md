# ADR 0422: Anchoring chain heads, as built (HIS-036)

Status: proposed (lane w7, 2026-11-21). Owner decision 56 of `docs/owner-decisions-2026-11-15.md`
settles the unit and the period: one signed batch root per tenant, every hour. ADR 0409 derives the
leaf, the record and the proof from it. Owner decisions 221 to 223 allow a development signing
library, a software key emulator and a local time-stamp authority; the production key service,
certificate and authority are not chosen. The points below are what HIS-036 built on top of those,
and where it departs from the layout ADR 0409 proposed. They are not decided by the owner.

## Context

`services/signing-service` (FRW-052 to FRW-057) already signs through a key service port and adds
RFC 3161 time-stamps, and it anchors the chain head of one completed workflow (FRW-054). The
document service could write to a bucket with Object Lock (HIS-036 criterion 4). Nothing ran on a
schedule, covered every document of a tenant, or let a relying party check a head.

## Decisions (proposed)

1. **What "changed" means.** A document goes into the hour's tree when its head (incarnation, `seq`,
   chain head) differs from the head its newest record covers. The service keeps that head for each
   document (`anchored_heads`, migration 0098). It does not compare times, so a commit that became
   visible while a run was reading is in the next record, never in none. A document with no commit
   has no head and no leaf. A soft-deleted document is covered until it is purged.
2. **The record and its file.** The signed text is `docedit-anchor/1` with the members `tenant`,
   `from`, `to`, `root`, `leaves` and `previous`, in alphabetical order with no white space, so that
   one record has one text (`headAnchorRecordText` of `@docedit/history`; the signing service builds
   the same text, and the document service refuses an answer that differs). `from` and `previous`
   are null in a tenant's first record. ADR 0409 point 4 proposed `signature` and `timestamp`
   members in the record. As built, the stored file (`docedit-anchor-file/1`) holds the record, its
   SHA-256, a detached CAdES-B-T over that hash (the signature with the RFC 3161 token over the
   signature value inside), the time of the token and the key's identifier. That is the format of
   the FRW-054 anchor, so one verifier and one OpenSSL command line check both.
3. **One line of records per tenant.** A record is stored with the heads it covers in one
   transaction, under a lock for the tenant, and only when it follows the tenant's newest record
   (`previous` is that record's hash). The row is written as `signed` before the file goes to
   write-once storage and becomes `stored` after. A run finishes a `signed` record before it signs
   a new one. The service role can insert a record and set `state` and `stored_at`; it cannot
   change what a record says or delete one.
4. **The leaf list.** The sorted leaves (document, incarnation, `seq`, chain head, leaf) are written
   to write-once storage next to the record, before the signature is asked for. An inclusion path
   is computed from it on request. It names documents by identifier and stays until its retention
   ends, also after a document is purged. It holds no content.
5. **The signing service sees a root.** `POST /v1/anchor-batch` takes the members of the record, not
   the heads. The rules are those of every other signature there: the document service's credential
   only, the rate limit, the audit entry before any key is used, the key of the tenant or the
   operator, and no answer without a time-stamp token.
6. **The schedule.** `heads.anchor` is a task of the scheduler with a period of one hour; its slots
   start at the full hour (UTC). It runs when the service is given a signing client, a retention and
   a write-once store. A tenant with no change gets no record and no signature is asked for.
7. **A run that fails.** Nothing that says "anchored" changes, so the next run that works covers
   every head the failed ones missed, and its record follows the last one that worked. Each failed
   run is told to the operator: an error line `heads.anchor.failed`, the counter
   `docedit_head_anchor_failures_total{stage,code,retryable}` and the audit entry
   `heads.anchor_failed`. ADR 0409 proposed an alert after two periods without an anchor for a
   tenant with changes; that is a rule an operator writes over this counter, and is not a separate
   signal here. Rooms do not wait for a run and do not read its tables.
8. **Retention.** `DOCEDIT_ANCHOR_RETENTION_DAYS`, with no default: the specification gives no
   retention for anchors. The bucket with Object Lock is created by the operator.
9. **The verification tool.** `services/signing-service/scripts/verify-anchor.ts`, next to the
   verifier of sealed PDFs, because that package has the CMS and RFC 3161 code. Given the anchor
   file and the roots the relying party trusts, it validates the signature and the time-stamp; given
   a head and its path (or the leaf list and a document), it folds the path to the record's root;
   given an exported log, it verifies the chain (`verifyBundle`) and compares the head with it. Exit
   0 verified, 1 failed, 2 not compared, 3 unreadable.

## Not built, and why

- **Where the key is kept (criterion 2).** In development the signing service signs through its
  key service port with SoftHSM2 in Podman (decision 222), and the document service has no key at
  all. A software emulator is not a key service or a hardware module, and the owner has not chosen
  one, so the criterion stays open, as FRW-052 criterion 2 does.
- **The production time-stamp authority and certificate** (decision 223). The token is an RFC 3161
  token from whatever authority the signing service is configured with; the tests use a local
  OpenSSL authority and a self-signed chain.
- **The public transparency log** of decision 143 (SEC-063). The signed root is what it would
  publish; the choice of log is a separate ADR.
- **A wired write-once store.** `ObjectHeadAnchorFiles` writes to a bucket with Object Lock, and
  the composed service takes it as a part (`headAnchorFiles`). No setting names the bucket yet, so a
  deployment passes the part, as it does for the sealed PDFs.
- **Size.** The heads that changed are read in one statement and held in memory with their tree.
  No tenant size was measured.

## Consequences

- 08 section 12 and 06 sections 4.1 and 4.2 describe the tables, the object keys and the file.
- If the owner prefers the record layout of ADR 0409 point 4, the file writer and
  `verifyBatchAnchorFile` change; the signed text and the tree do not.
- The retention of anchors is a decision for the owner or the operator before the task is turned on
  in a deployment.
