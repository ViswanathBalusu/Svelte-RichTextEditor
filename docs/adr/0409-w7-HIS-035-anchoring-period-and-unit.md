# ADR 0409: How often heads are anchored, and what is signed (HIS-035)

Status: the period and the unit are accepted (owner decision 56, 2026-11-15). The record format, the proof and the alert threshold below follow from them and are proposed, for the owner to confirm. Written by lane w7 on 2026-11-18.

## Context

08 §12 says the service "periodically writes signed, time-stamped heads to write-once storage". It gave no period, no unit and no maximum delay. ADR 0145 section 6 set out the choices and the cost formulas and proposed a unit. The owner has since decided (decision 56, "Signing of log heads"): one signed batch root per tenant, every hour.

## Decision

1. **Period.** One hour. A run starts at each full hour of server time (UTC).
2. **Unit.** One batch per tenant and period. The batch is a Merkle tree over the heads of the tenant's documents that changed since the previous run. One signature and one RFC 3161 time-stamp cover the root. A tenant with no change in the period gets no anchor for it.
3. **Leaf.** `SHA-256(0x00 || document id (16 bytes) || incarnation (16 bytes) || seq (8 bytes, big endian) || chain head (32 bytes))`. Leaves are sorted by document id. An inner node is `SHA-256(0x01 || left || right)`, and an odd node at a level is carried up unchanged. (The prefixes keep a leaf from being read as a node. The layout is proposed; HIS-036 builds to it unless the owner changes it.)
4. **Anchor record.** `{ format: "docedit-anchor/1", tenant, from, to, root, leaves, previous, signature: { kid, alg, value }, timestamp: <RFC 3161 token> }`. `previous` is the hash of the tenant's previous anchor record, so that a dropped anchor shows. The record is written once to write-once storage (HIS-036 criterion 4, built) next to a file of the sorted leaf list, which the operator keeps so that it can answer a request for a path.
5. **Maximum delay.** A change is covered by the first run that starts after it commits, so the delay is at most one period plus the time one run takes (building the tree, the signature, the time-stamp and the write). The run time is not measured here; it is bounded by the time-stamp authority's answer. A run that fails is covered by the next one, which takes every change since the last success (HIS-036 criterion 5). Proposed: an alert is raised when a tenant with changes has had no anchor for two periods.

## What a relying party gets, and how it proves coverage

To prove that a document's head was anchored, the operator gives the relying party four things: the head (document id, incarnation, `seq`, chain head), the inclusion path (at most one hash per level of the tree), the anchor record with its signature, and the time-stamp token. The relying party:

1. recomputes the leaf from the head and folds the path to a root;
2. checks that the root is the one in the anchor record;
3. checks the signature with the published key of that `kid`, and the time-stamp token against the authority's certificate and the hash of the record's signed part;
4. compares the head with the chain it has verified (`verifyBundle` of `@docedit/history`, and `verify-log` for a segment, HIS-037).

The proof says the head existed no later than the time-stamp. It says nothing about a later `seq`; a head changed after the run has no leaf yet, and the answer to such a request is "not yet anchored; due within one period plus a run". The segment of HIS-037 carries the anchors that cover its range, and with this unit it also carries the paths.

## Cost at the stage 3 target of 1,000,000 stored documents

This is arithmetic from the unit, not a measurement.

- Signatures and time-stamps per day: at most 24 per tenant (one per period with a change). It does not depend on the number of documents. At 1,000,000 documents in one tenant the figure is 24 signatures and 24 time-stamps a day. In total it is at most 24 times the number of tenants with a change in the period; the number of tenants is not in the specification, so no total is stated.
- The tree of one run has at most 1,000,000 leaves, so a path has at most 20 hashes of 32 bytes (640 bytes), because 2^20 is 1,048,576.
- For comparison, the per-document unit of ADR 0145 section 6 at the same size gives 1,000,000 signatures and time-stamps a day with one anchor a day, and 24,000,000 with one an hour (about 278 a second on average), both assuming that every document changes in every period.

## Consequences

- HIS-036 builds the run, the signing (key service or HSM, never in a room or worker), the RFC 3161 time-stamp and the alert to this record. Its criteria 1 and 5 now have a period, a unit and a record to build to; its criteria 2 and 3 still need the key service and the authority of SPK-021 and decision 205, and criterion 6 needs the checking code.
- The public transparency log of decision 143 (SEC-063) can publish the same signed root. Its choice of log is a separate ADR.
- 08 §12 is amended to state the period, the unit and the delay.

## Alternatives considered

- One signed head per document (ADR 0145 unit (a)): simple proofs, but the signature count grows with documents, which is the cost the story set out to bound.
- A longer period: fewer signatures and a longer window in which a rewrite goes unseen. The owner chose one hour.

## Revisit when

A tenant is large enough that one tree per hour is slow to build, or the time-stamp authority limits the rate (then a longer period for small tenants, or one tree for several tenants, is the next step), or a relying party needs a proof of the state at a time that falls between two runs.
