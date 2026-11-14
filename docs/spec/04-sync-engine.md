# 04 Sync engine (`pm-steps/1`)

**Status:** draft 0.2, 2026-09-18, revised after the first review ([review](../review/2026-09-18-pitfall-review.md)). Normative.

This document defines how concurrent edits are ordered, validated and distributed. The transport messages that carry it are defined in [05 Protocol](05-protocol.md). The permission rules the authority applies are defined in [07 Permissions](07-permissions.md) and [12 Fields](12-fields-rules-workflow.md). The reasons for choosing a server-authoritative design are in [ADR 0001](../adr/0001-server-authoritative-sync.md).

## 1. Model

- A document has one ordered log of **commits**. Each accepted commit gets the next **sequence number** (`seq`), starting at 1. The `seq` of the latest stored commit is the document's **head** and its version.
- A log has an **incarnation** identifier. It changes only if the log is ever rewound, for example after a disaster recovery that lost commits. A `seq` means something only together with its incarnation.
- Exactly one **authority** exists for an open document. It lives in the document's room.
- Clients apply their own edits immediately, submit them as commits against the version they were made on (the **base**), and treat them as unconfirmed until the authority acknowledges them.

## 2. Guarantees

| ID | Guarantee |
|---|---|
| G1 | Total order: all clients apply the same commits in the same order |
| G2 | Durability before visibility: a commit is acknowledged and broadcast only after it is durably stored |
| G3 | Convergence: two clients that have applied the log up to the same `seq` of the same incarnation, and have no unconfirmed steps, hold identical documents |
| G4 | Idempotent submission: resubmitting a commit with the same `id` never applies it twice, whether the first copy is stored or still waiting to be stored |
| G5 | Gap-free delivery: on an open channel a client receives every commit after its resume point, in order, and can detect a gap |
| G6 | Server attribution: the user, session and time recorded for a commit come from the authenticated connection and the server clock |
| G7 | No stale authorisation: no commit is stored that was checked against permissions older than those in force when it is stored |

## 3. Commits

### 3.1 Step commits

```json
{
  "id": "0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10",
  "base": 412,
  "steps": [ { "stepType": "replace", "from": 1204, "to": 1204, "slice": { "content": [ { "type": "text", "text": "x" } ] } } ],
  "origin": "input"
}
```

| Field | Rule |
|---|---|
| `id` | UUID chosen by the client. Unique per document. Reused unchanged when the same commit is resubmitted |
| `base` | The `seq` the client had applied when it created the steps |
| `steps` | 1 to `maxStepsPerCommit` steps (default 500). The serialised commit MUST NOT exceed `maxCommitBytes` (default 1 MiB) |
| `origin` | A hint from the client: `input`, `paste`, `format`, `undo`, `redo`, `suggestion.accept`, `suggestion.reject`, `fill`, `assistant`. It is recorded and shown as the client's claim; nothing is authorised on its strength |

Origins reserved for commits the server authors: `restore`, `import`, `migration`, `repair`, `sign`, `rules`, `prefill`, `control`.

### 3.2 Control and snapshot commits

Two further kinds of commit exist so that everything that matters is in one totally ordered, hash-chained log.

- A **control commit** has no steps. It records a change of state that affects what is allowed: a new grants revision, a region state, a lease break, a workflow transition, a participant's completion. Clients receive it like any commit and advance their `seq`.
- A **snapshot commit** replaces the document with the content of a checkpoint instead of listing steps. It is used for imports, whole-document restores, schema migrations, and any server-authored change too large to send as steps. Clients receive `sync.reset` for it and reload. A commit whose `base` is older than a snapshot commit is rejected with `stale_base` and action `rebase` (section 5, step 3). Nothing is sent out of `seq` order (section 5, step 10), so the client has already received `sync.reset` for the snapshot: it has re-applied its local steps to the new content, moving those that fail to recovered edits (section 8), and it resubmits the rest as a new commit.

## 4. Steps

A step is the JSON produced by `Step.toJSON()` in prosemirror-transform. The authority MUST accept only these step types: `replace`, `replaceAround`, `addMark`, `removeMark`, `addNodeMark`, `removeNodeMark`, `attr`. It MUST reject any other type, including `docAttr`.

The semantics of applying, mapping and inverting steps are those of one exact release of prosemirror-transform, named in the engine definition file that ships with the conformance kit together with golden fixtures for apply, map and rebase. The generated ProseMirror schema for the CDM is published as a normative artifact, because applying a step depends on it. A release that changes any fixture is a new engine identifier, not a silent upgrade.

## 5. Authority algorithm

The room processes submissions for a document one at a time, in arrival order. It keeps two states: the **durable** state (document, indexes, attribution map, comment ranges, chain head) as of the last stored commit, and the **tentative** state that includes commits waiting to be stored. ProseMirror documents are persistent data structures, so holding both costs little.

1. **Authorise and limit.** If the document's state forbids the change (`locked`, `archived`, or a workflow that does not permit it), reject with `read_only`. This is checked first, so a connection whose capabilities the document's state has reduced (07, section 4) gets `read_only`, not `permission_denied`. Otherwise the connection must hold a channel on this document with `suggest`, `edit` or `fill` in some scope; if it does not, reject with `permission_denied` (07, rule P6). Apply size limits and the admission control of section 12. At most one commit per channel may be in flight: a second `sync.submit` before the first is answered is rejected with `busy`.
2. **Deduplicate.** Look the `id` up first among commits waiting to be stored, then in the log. If it is waiting, attach this request to its pending acknowledgement. If it is stored and was submitted by the same user, reply with an acknowledgement rebuilt from the stored commit (it always carries the stored steps). If it belongs to another user, reject with `invalid_op`.
3. **Check the base.** If `base` is greater than the tentative head, reject with `invalid_op` and action `reload`. If the number of steps accepted since `base` exceeds `maxRebaseSteps` (default 5,000), or a snapshot commit lies after `base`, reject with `stale_base`.
4. **Rebase.** If `base` is less than the tentative head, map the steps over every step accepted after `base` using the procedure in section 6. If any step cannot be mapped or fails to apply, reject with `rebase_failed`.
5. **Apply.** Apply the (mapped) steps to the tentative document. A failure rejects with `invalid_op`.
6. **Check invariants.** Validate the result against the invariants in 03, section 8, and 12, section 3.6. A violation rejects with `invalid_op`.
7. **Check permissions.** Compare the document before and after the commit as defined in 07, section 5, using the permissions in force at this moment, and note their access revision. A violation rejects with `permission_denied` and lists the scopes involved.
8. **Order.** Assign the next tentative `seq`. Stamp user, session, server time, the scopes touched, the access revision, the schema version and the engine version.
9. **Persist.** Append the commit to the log (group commit; 06, section 2.3). The write is conditional on the room's ownership epoch and on the grants revision it was checked against still being current; the log's primary key is (document, `seq`).
10. **Acknowledge and broadcast.** After the write succeeds, advance the durable state, send `sync.ack` to the author and `sync.commit` to every other subscriber. On every channel, messages are sent in `seq` order: an acknowledgement or a rejection is never sent before all commits with a lower `seq` have been sent on that channel.

**When a write fails.** The room discards the tentative state and continues from the durable state. If the outcome of the write is unknown (for example the connection to the database broke during the transaction), the room re-reads the log tail before deciding. Commits that were not stored are rejected with `unavailable`. If the grants revision had moved, they are rejected with `unavailable` and clients resubmit; they are then checked against the new permissions. If the ownership epoch or the primary key shows another writer, the room stops serving the document and closes its channels with `ch.closed` and code `unavailable`. A conflict on the commit identifier alone is a duplicate (step 2), never a sign of another writer.

Checkpoints are written only from the durable state.

Server-authored commits (section 10) go through the same steps. They are never exempt from step 7; where the control plane has already authorised an operation, it passes the preconditions it relied on, and the room re-checks them when it applies the commit.

## 6. Rebase procedure

The authority keeps the position maps of recent steps, derived from the stored steps, at least `maxRebaseSteps` back. It does not need old document versions.

```
function rebase(commit, room):
    n        = commit.steps.length
    mapping  = new Mapping()
    for i from n-1 down to 0:
        mapping.appendMap(commit.steps[i].getMap().invert())
    for each step map r accepted after commit.base, in order:
        mapping.appendMap(r)

    doc      = room.tentativeDocument
    mapFrom  = n
    mapped   = []
    for i from 0 to n-1:
        m = commit.steps[i].map(mapping.slice(mapFrom))
        mapFrom = mapFrom - 1
        if m is null:                 reject rebase_failed
        result = m.apply(doc)
        if result.failed:             reject rebase_failed
        doc = result.doc
        mapping.appendMap(m.getMap(), mapFrom)     // mirror of the inverted map of step i
        mapped.push(m)
    return mapped, doc
```

This is the procedure a ProseMirror collaboration client uses to rebase its unconfirmed steps over remote steps, run on the server, with one difference: the client procedure drops steps that fail, and the authority rejects the whole commit instead. A reviewer checked it index by index against `rebaseSteps` in prosemirror-collab.

Whatever a client sends, only the mapped steps are applied, and they pass steps 5 to 7 above. A client cannot gain anything by sending steps that are inconsistent with its claimed base.

## 7. Acknowledgement and the client's confirmed document

`sync.ack` carries the commit `id`, the assigned `seq`, the server time, and `rebased`. When `rebased` is true it MUST also carry the mapped steps.

The client MUST keep its **confirmed document**: the document at its confirmed `seq`, without any unconfirmed steps. All corrections are made by rebuilding from it, never by applying stored inverses, because the inverse of a mark step is not exact once another mark step has overlapped it.

- On an acknowledgement, the client applies the authority's steps (its own if `rebased` is false) to the confirmed document, advances its confirmed `seq`, and rebuilds its visible state as the confirmed document plus its remaining local steps rebased over the change. Two step lists are equal when their canonical JSON is equal; when the acknowledged steps equal the client's own rebased version, the rebuild is a no-op.
- On a rejection with action `drop`, the client discards the rejected steps and rebuilds the visible state from the confirmed document plus the later local steps that still apply.
- After a rebuild, the client drops undo history entries that belong to discarded steps and maps the selection through the change.

## 8. Client algorithm

State: the confirmed document and `seq`, the log incarnation, the in-flight commit (at most one), and the queue of local steps not yet sent. The in-flight commit, the queue and recovered edits are also written to a journal in IndexedDB (13, section 9), so they survive a closed tab.

- **Local edit.** Apply steps locally and append them to the queue. If nothing is in flight, send a commit containing the queue with `base` equal to the confirmed `seq`. Clients SHOULD send at once when idle and otherwise batch for at most 100 ms.
- **`sync.commit` received.** Each commit's `seq` MUST equal the confirmed `seq` plus one; anything else is a gap, and the client closes and reopens the channel with a resume. Apply the steps to the confirmed document and rebase the in-flight and queued steps over them; steps that can no longer apply are dropped, as in ProseMirror. If a received commit carries the in-flight commit's `id`, treat it as the acknowledgement.
- **`sync.ack` received.** Confirm as in section 7. Send the next commit if the queue is not empty.
- **`sync.reset` received.** A snapshot commit was stored. Fetch the content at the given `seq`, replace the confirmed document, and try to re-apply local steps; those that fail go to recovered edits.
- **No answer.** If a submitted commit is not answered within `ackTimeoutMs` (default 15,000), the client closes and reopens the channel with a resume.
- **`sync.reject` received.** Act on its `action`. Every rejection carries the current `head`.

| Code | Action | Client behaviour |
|---|---|---|
| `stale_base`, `rebase_failed` | `rebase` | Wait until the confirmed `seq` reaches the `head` given in the rejection, then resubmit the rebased steps as a new commit with a new `id` |
| `permission_denied` | `drop` | Discard the rejected steps as in section 7, keep the discarded content available to the user as recovered edits, and refresh permissions |
| `conflict`, `field_invalid` | `drop` | Discard the fill and show the current value or the validation message (12) |
| `invalid_op` | `drop` or `reload` | Discard the steps. If the server says `reload`, discard local state and reload the document |
| `too_large` | `drop` | Split the change and resubmit, or report it |
| `busy`, `rate_limited`, `unavailable` | `retry` | Resubmit the same commit with the same `id` after the indicated delay |
| `read_only` | `drop` | Switch the editor to read-only |

- **Undo and redo** are local and selective: they invert the user's own changes, rebased over everything since, and are submitted as ordinary commits with origin `undo` or `redo`.
- **Flush.** The component exposes `flush({ timeoutMs })`, which resolves when nothing is in flight or queued, and rejects at the timeout with the number of unconfirmed commits, which remain in the journal.

Rebasing can drop a local step when another user has removed the content it applied to. This is inherent to the approach; the client SHOULD tell the user when typed text was dropped.

## 9. Reconnect and resume

1. The client reopens the channel with `resume: { seq, incarnation, inflight }`, where `inflight` is the `id` of its in-flight commit, if any.
2. The server answers in `ch.opened` with `head`, the log `incarnation`, `catchUp`, and `inflight`: `accepted` with its `seq`, or `unknown`.
3. If the incarnation differs, or the client's `seq` is greater than the head, the answer is `catchUp: "reload"`. The client fetches the content at `head`, replaces its confirmed document, and moves unconfirmed work to recovered edits when it no longer applies.
4. Otherwise, if the gap is within the catch-up limits (default 5,000 commits or 5 MiB) and within what the user may see (07, section 8), the server streams the missing commits, then sends `sync.caughtUp`, then continues live. Subscribing and streaming are atomic: no commit is missed or sent twice. Beyond the limits the client pages through the missing commits over REST, or the server answers `reload`.
5. The client resubmits an in-flight commit reported as `unknown` only after `sync.caughtUp`, with the same `id`. If it was reported `accepted`, the client finds it in the catch-up stream.

Because commits are acknowledged only after they are stored, a room crash never loses an acknowledged commit and never leaves clients ahead of the server. The incarnation covers the one case where that can still happen: a database recovery that rewinds the log.

## 10. Server-authored commits

Some changes are made by the document service on a user's behalf: restoring a version, importing content, migrating the schema, repairing a document, setting signature, date-signed and formula values, prefilling fields. They go through the same log with the requesting user (or `system`) as author and a reserved `origin`. The control plane writes the request to an outbox with a deterministic commit `id`, so a retry cannot apply it twice and a crash between the two systems cannot lose it. For a document that is not open, the service runs a transient authority instead of opening a full room.

## 11. Presence

Presence is not part of the log. A client publishes its selection as positions in its confirmed document (mapping its visible selection back through its unconfirmed steps) together with the confirmed `seq`. Receivers map the positions through any later steps they have applied, or hold the update until they reach that `seq`. Updates older than the receiver's retained mapping history are dropped. Presence is rate-limited to 10 updates per second per client, limited to 1 KiB per update, validated against a schema, and never stored.

## 12. Admission control and performance

- Before doing any work on a commit the room estimates its cost from the number of steps, the rebase distance in steps and the size, and rejects with `rate_limited` when the connection's CPU budget is spent. Budgets are per connection and per tenant, and cover steps 2 to 7, not only step application, because synchronous work cannot be pre-empted.
- Work that does not need the room's event loop runs in worker threads: serialising checkpoints, replaying logs for content reads, comparisons, conversions.
- Validating and applying a typical commit costs well under a millisecond of CPU; storage latency dominates acknowledgement time. Group commit keeps one write in flight per room and batches whatever arrives meanwhile.
- For rooms with many subscribers the room coalesces commits into one `sync.commit` message per 30 to 50 ms, subject to the ordering rule of section 5, step 10.
- Viewers can be attached to follower nodes that receive the ordered stream and fan it out; they never submit.
- Rooms are evicted only when idle.

## 13. Divergence check

When the room writes a checkpoint it MAY send `sync.check` with the `seq` and the SHA-256 of the canonical form (03, section 2) of the document. A client whose confirmed document is at that `seq` compares its own hash, and on a mismatch reloads the document and reports the event. This catches engine bugs; it is not a security control.

## 14. Relay mode

A backend that cannot run the document model MAY implement relay mode: it skips steps 4 to 7, rejects any commit whose `base` is not the head with `stale_base`, and stores and relays the rest. Clients then rebase locally, as in stock ProseMirror collaboration.

Relay mode is for trusted clients only. A relay cannot enforce region permissions, suggestion-only or fill-only roles, or invariants. It cannot materialise content by itself, so it needs the authority service (05, section 10) to serve content, catch-up beyond the log window, restore, comparison and export. Because a relay stores steps it cannot test, every client MUST treat a confirmed step that fails to apply as a no-op and continue; all clients share the same step semantics, so they still converge.

## 15. Other engines

DEP negotiates the engine per channel. Any engine MUST provide: a resume token, server attribution of every change, a way for the server to refuse a change, and either JSON or opaque binary payloads. A CRDT engine would satisfy these only at the granularity of one synchronised document. Moving this design to one CRDT document per region would replace the log, history, restore, comparison, attribution and the suggestion and fill rules; it is a rewrite, not a fallback ([ADR 0001](../adr/0001-server-authoritative-sync.md)).

## 16. Open issues

- Behaviour while an input-method composition is in progress and remote commits arrive must be tested on every supported browser (spike S1).
- Commit granularity affects history size and attribution resolution. The 100 ms batching rule is a starting point.
- `maxRebaseSteps` trades memory and CPU for tolerance of slow clients; the default is a guess.
- Whether pipelining more than one in-flight commit is worth its complexity on high-latency links.
- A rolling hash of the document per commit would give continuous divergence detection and a stable identity for the authority service's state; its cost is unmeasured.
