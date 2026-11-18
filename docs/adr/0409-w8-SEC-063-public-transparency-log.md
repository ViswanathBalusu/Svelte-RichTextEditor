# ADR 0409: Chain heads are anchored in a public transparency log (SEC-063)

Status: the decision to anchor is accepted (owner decision 143, `docs/owner-decisions-2026-11-15.md`: "Yes: chain heads are anchored in a public log"). The form of the anchor and the choice of log below are proposed, as decision 143 asks for an ADR. Lane w8, 2026-11-18.

## Context

ADR 0156 (section SEC-063) compared the host's anchors (the `dep.document.changed` webhook and the export manifests) and the operator's write-once store with a public log, and proposed no public log in version 1. The owner reversed that default. 10 §6 and 08 §12 are changed to match, and the stories to build it are SEC-065 to SEC-068.

A relying party who must not trust the operator or the host needs a head that neither of them can rewrite. A public log is the third party. The same ADR 0156 warned that publishing a stable hash per document leaks that a document exists and when it changes.

## Decisions

1. **What is published.** A salted periodic root, as option C of ADR 0156: one entry per tenant per period, the root of a Merkle tree over salted leaves. A leaf is the hash of a document's chain head, its sequence number and a per-tenant salt. The public entry holds the root, the period and, if the relying party needs it, the number of leaves. It holds no content, no document, tenant or user identifier and no sequence number. Option B (a hash per document) is not used.
2. **Who holds the salt.** The tenant. It is held by the document service in the tenant's key custody (SEC-062) and is handed to a relying party with the inclusion proof. Destroying the salt makes the public entry unlinkable to the tenant's documents; the chain itself is not changed.
3. **Period.** The period is a tenant setting. No default figure is fixed here: the first implementation reads it from configuration, and a measurement of the log's rate limits and of the wanted detection delay sets the default (SEC-066).
4. **The log sits behind a port.** The document service calls a `TransparencyLog` port with `submit(root)` and `getReceipt(id)`. The service keeps the receipt (log identifier, entry index, signed checkpoint) next to its own signed heads in write-once storage. A self-hosted operator may point the port at a log of their choice or turn it off. A hosted tenant that turns it off keeps the write-once store as its only anchor, and the setting is visible in the verification report.
5. **The proposed log.** A tile-based, checkpoint-signing transparency log that follows the C2SP `tlog-tiles` and signed-note formats, so that any witness-cosigned log can be used. The first target is the Sigstore public-good Rekor log, because it is public, run by a body that is neither the operator nor a host, and has published inclusion proofs. This choice is a proposal. It depends on the log's terms of use, its rate limits and its continued operation, none of which has been checked from this repository, so the adapter is built against the port and tested against a local log of the same format. Alternatives named for the owner: a timestamping authority (RFC 3161), which proves time but is not a log a third party can audit; OpenTimestamps over a blockchain, which has a long delay and no inclusion proof of the whole log; and an operator-independent log run by a consortium of tenants, which the owner may prefer for a regulated tenant.
6. **Failure.** If the log is not reachable, the submission is retried and the root stays in the write-once store. The editor and the commit path never wait for the log. A missing receipt is shown as "not yet anchored" by the verification tool, not as a failure of the chain.
7. **What the anchor proves and does not prove.** A receipt for a root that includes a head proves the head existed, unchanged, by the log's checkpoint time. It does not prove the content is true, and a head committed after the last root is not covered until the next period. The documentation states this window.

## Consequences

- 10 §6 loses its fourth open issue; 10 §3.3 and 08 §12 name the public log.
- Four stories are added to the SEC epic: SEC-065 (batcher and salted root), SEC-066 (port, adapter and receipts), SEC-067 (inclusion proof and verification command), SEC-068 (privacy proof). All are phase 4 and `could`, as SEC-063 was.
- SEC-062 gains a use: the tenant salt is a secret held under its key rules.
- Timing of changes is visible at the period's resolution. The owner accepted a public log knowing this (ADR 0156, option C).

## Not decided here

- The log operator. Decision 143 asks that the choice go in an ADR; item 5 is the proposal, and the owner accepts it or names another.
- The period default and the retry schedule (SEC-066 measures).
- Whether a tenant may publish roots to more than one log.
