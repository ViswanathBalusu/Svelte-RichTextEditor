# Anchoring chain heads

For the operator. Spec: 08 §12; story HIS-036; owner decision 56 (one signed batch root per tenant, every hour); ADR 0409 and ADR 0422 (proposed).

## What the service does

Once an hour, at the full hour (UTC), the task `heads.anchor` runs for every tenant.

1. It reads the heads that changed: every document whose head (incarnation, `seq`, chain head) differs from the head its newest record covers. A tenant with no change gets no record.
2. It builds a Merkle tree over those heads and writes the leaf list to write-once storage.
3. It asks the signing service to sign and time-stamp one record: the tenant, the time the heads were read, the root, the number of leaves and the hash of the tenant's previous record. The signing service is sent the root, never a head. The document service holds no key.
4. It stores the record and the heads it covers, and writes the record to write-once storage.

The objects are `tenants/{tenant}/anchors/heads/{to}.json` (the record with its signature and RFC 3161 token) and `tenants/{tenant}/anchors/heads/{to}.leaves.json` (the leaf list). Neither holds content: identifiers, sequence numbers, times and hashes.

## What it needs

- The signing service of the sealing step (`DOCEDIT_SEAL_URL`, `DOCEDIT_SEAL_CREDENTIAL`, `DOCEDIT_SEAL_TIMEOUT_MS`), with a key service and a time-stamp authority. The production key service, certificate and authority are not chosen (owner decisions 221 to 223). A software key emulator is for development only.
- `DOCEDIT_ANCHOR_RETENTION_DAYS`: how long a record and its leaf list are retained. There is no default, because the specification gives none. Without it no head is anchored.
- A bucket with Object Lock, given to the service as the part `headAnchorFiles` (`ObjectHeadAnchorFiles`). The operator creates the bucket with Object Lock enabled; an object written there cannot be changed or deleted before its retention ends, also not with the operator's own credentials. No setting names the bucket yet.
- Migration `0098_his_036_head_anchors.sql`.

## When a run fails

A run that cannot get a signature or a time-stamp, or cannot store its record, changes nothing that says "anchored". The next run that works covers every head the failed runs missed, and its record follows the last record that worked. Editing does not wait for a run.

Each failed run is told to the operator in three places:

| Signal | Where |
|---|---|
| An error line, event `heads.anchor.failed`, with the tenant, the stage and the code | the service log |
| The counter `docedit_head_anchor_failures_total{stage,code,retryable}` | `/metrics` |
| The audit entry `heads.anchor_failed` | the tenant's audit trail |

Alert on the counter. ADR 0409 proposes to page when a tenant with changes has had no record for two periods; that is a rule over this counter and the audit entries `heads.anchored`.

A record that was signed and could not be written to write-once storage stays in the database as `signed`. The next run writes it before it signs anything new.

## Giving a proof, and checking one

To prove that a document's head was anchored, give the relying party: the record file, the head (document, incarnation, `seq`, chain head) with its inclusion path, and the exported log of the document. The path comes from the leaf list:

```
node services/signing-service/scripts/verify-anchor.ts <record file> --root <root certificate> \
     --leaves <leaf list file> --doc <document id> [--bundle <exported log>] [--previous <record file before>]
```

The tool prints the proof (the head and the path) in its report. A relying party runs the same tool with `--proof <file>` in place of the leaf list. It validates the signature and the time-stamp against the roots it is given, folds the path to the root the record names, verifies the hash chain of the log and compares the head with it. Exit code 0: verified. 1: something does not verify. 2: the signature holds but the head was not compared with a log. 3: a file or an argument cannot be read.

The proof says that the head existed no later than the time of the time-stamp. A head that changed after the run has no leaf yet; it is in the next hour's record.

## What stays after a document is purged

The purge of a deleted document (HIS-039) removes the row that says which head of the document was covered. The records stay: they name the tenant and no document. A leaf list names the document by identifier, with a sequence number and a hash, until its retention ends.
