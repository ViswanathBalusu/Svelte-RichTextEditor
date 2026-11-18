# ADR 0376: How a worker knows the control plane queued a job (lane w2, EXP-067)

Status: proposed. The owner has not decided this. The spec leaves it open (EXP-067 Notes; ADR 0045; ADR 0116, decision 5).

## Context

09 §9.3 item 1 says workers compile only bundles produced by the converter. EXP-067 criterion 4 asks that a worker refuse a job whose bundle was not queued by the service. In this design the worker builds the bundle itself, from the job's payload and the document's content. The only input a person can influence is the row in the job queue. The worker already refuses a payload that carries TeX or a bundle. It did not check who wrote the row.

## Decision proposed

1. The control plane adds a proof to every export and preview job it queues: the member `queueProof` of the payload, the hex HMAC-SHA-256 of the canonical JSON of `[tenant, kind, doc, cacheKey, payload without the proof]` (`services/document-service/src/control-plane/job-proof.ts`).
2. A worker with the same key checks the proof before it reads the payload (`services/export-worker/src/job.ts`, `readPayload`) and fails the job with `validation_failed` and the diagnostic `bundle_refused` when it is missing or wrong. Nothing converts or compiles.
3. The key is one deployment setting, `DOCEDIT_EXPORT_PROOF_KEY`, read by the service (`exportProofKey` in `config.ts`) and by the worker (`main.ts`). It is a shared secret between two processes of the same operator; it is not a signing key of documents and it never reaches the sandbox.
4. Without the key nothing is written or checked, so existing deployments and tests keep working. The worker's `main.ts` logs `export-worker.queue-proof-off` at start in that case. Spec default: the criterion does not say the check is on by default.

## Open for the owner

- Whether the key is required in production (the worker would refuse to start without it). This record leaves it optional, because the reference host's stack scripts start the worker and would need the key added (`apps/reference-host`, another lane).
- Whether the key should be rotated like the other secrets (SEC-048): the proof is checked at claim time, so a rotation with an overlap needs the worker to accept two keys. Not built.
- A proof protects against a row written by something that does not hold the key. It does not protect against a holder of the key, and the worker needs read access to the same database in any case.

## Consequences

- EXP-067 criterion 4 is ticked on the tested behaviour with a key set. A deployment without a key is not protected by it.
- The cached-result copy (EXP-006) is a job that is completed when queued and never runs on a worker; it carries no proof.
