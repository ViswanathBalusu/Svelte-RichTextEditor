# ADR 0389: The authority service, `open` and `materialise` (proposed)

Status: proposed. Lane w5, story PRO-103. The wire binding is the one of ADR 0314 decision 3, which
the owner accepted as the starting point on 2026-11-15 (decision 193,
[owner decisions](../owner-decisions-2026-11-15.md)). Decision 96 of the same table starts the
production backend now; the Node.js service stays the reference. The choices below are the ones the
spec leaves open. The maintainers have not accepted them.

## Context

05 §10 names `open(doc, checkpointRef, commits, stateId)` and `materialise(stateId or seq)` and says
`stateId` is the hash-chain head. It does not say what `checkpointRef` is, what the service checks,
or what happens to a `stateId` after a rewind. The service lives in `services/authority-service`
(01 §6).

## Choices

1. `checkpointRef` is `{ seq, chainHead, contentHash, content? }`. `seq` is the sequence number the
   checkpoint holds (0 for the document as created), `chainHead` the hash of the commit at `seq`
   (null exactly when `seq` is 0), `contentHash` the `documentHash` of its canonical form. `content`
   carries the CDM envelope. Without it the service asks a `CheckpointResolver` the host gives it,
   and answers `checkpoint_unavailable` when there is none. A carried checkpoint that does not hash
   to `contentHash` is refused (`checkpoint_mismatch`).
2. A commit is the record of `@docedit/history` (`meta`, `payloadHash`, `prevHash`, `hash`) plus its
   `payload`. The service recomputes every link with `chainHash` and every payload digest with
   `payloadDigest`, from the checkpoint's `chainHead` to the last commit. A thinned payload cannot be
   replayed, so every payload must be present. A broken link names the `seq` (`chain_broken`).
3. `stateId` is the hash of the last commit, or the checkpoint's `contentHash` when no commit follows
   the checkpoint. The caller names it and the service checks it (`state_mismatch`), so a caller that
   built the wrong log learns at `open`, not at the first read.
4. A held state is immutable. A log that is rewound and extended has another head, so another state.
   A call that names the old `stateId` gets the old content while the service still holds it, and
   `unknown_state` after that. It never gets the new state's content. This is the reading of "does not
   return the new state's content" that needs no log version number.
5. `materialise` takes a `seq` inside the state: from the checkpoint's `seq` to the head. A `seq`
   below the checkpoint is `not_found`, because the service was given no earlier checkpoint. The
   answer is the canonical envelope (RFC 8785 text), its hash, and the `seq`. Over HTTP the body is
   that text, so a caller compares bytes.
6. A snapshot commit (08 §3) carries `payload.snapshot.checkpoint`, the name of the checkpoint that
   holds the new content. The service resolves it through the `CheckpointResolver` while it opens the
   log, so replays never wait for storage.
7. The service keeps at most 64 states, least recently used first out (a constructor option). This
   is a cache size, not a measured figure.
8. The `cdm` of the document and the features in `requires` are read with the model's reader
   (`readDocument`): a version or a feature the package does not know is `unsupported_cdm` or
   `unsupported_feature`, never an attempt to read. `open` never migrates (03 §11.3).
9. Failures are `application/problem+json` with the service's `code`. A failure is not a rejection of
   a commit; rejections are answers of `applyCommit` (PRO-104, not built).

## Consequences

- A backend in another language needs the canonical JSON of the commit records and nothing else of
  the package. The chain it must reproduce is ADR 0020's.
- The resolver is an interface, not a storage client. BE-007 decides how a deployed service reaches
  storage.
- Nothing is measured. The overhead target of PRO-102 criterion 2 is still open.
