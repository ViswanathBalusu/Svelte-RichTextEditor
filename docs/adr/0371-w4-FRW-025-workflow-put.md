# 0371. The workflow resource routes: creation, ownership of members, defaults

**Status:** proposed, 2026-11-17. Written while building FRW-025 (lane w4). The specification (12 §6.1, §10) names `GET` and `PUT /documents/{id}/workflow` and says nothing on the points below. Each item takes the smallest reading that lets the routes work; the owner may change any of them.

## Decisions

1. **Creation is a `PUT`.** No route creates a workflow, and the operation `putWorkflow` requires `If-Match`. A document without a workflow has the ETag `"0"`. A `PUT` that carries `If-Match: "0"` creates the workflow (state `draft`, revision 1, answered `201`). After that the stored ETag is `"1"` or higher, so a second creation carries a stale tag and is refused as `precondition_failed` (412). That is the "one workflow per document" rule of version 1, enforced by the primary key `(tenant_id, doc_id)` in PostgreSQL. A `PUT` without `If-Match` is 428; `GET` of a document without a workflow is `not_found`.
2. **The server owns `id`, `doc`, `state`, `rev`, `sentSeq`, `sentHash`, and a participant's `state` and `completedSeq`.** The published schema `Workflow` (`spec/dep/dep-1.schema.json`) requires `id`, `doc`, `state`, `rev` and `participants` in the body of a `PUT`. A client may therefore echo what it read; these members are ignored. The server mints `id`. `doc`, when it differs from the path, is refused. State changes belong to the actions (`send` and the rest, FRW-027), not to the `PUT`.
3. **The writable members** are `timeZone`, `participants`, `routing`, `deadline`, `reminders`, `consent` and `finalisation`. Unknown members are refused, with a JSON Pointer and a rule, never the value. `participants` pass `checkParticipants`, which now also accepts `auth: { require: [method, ...] }` (12 §6.1 shows it).
4. **Defaults and lower bounds.** `timeZone` defaults to `UTC` when absent and must be a time zone the runtime knows. `reminders.firstAfterDays`, `reminders.everyDays` and `consent.version` are integers of at least 1: a reminder every 0 days would be a flood. `deadline` is a UTC instant in RFC 3339 form. `routing` holds at most 500 routes (the limit of rules in a document, I15), each `{ when, then: [...] }`; the conditions are checked against the document's fields and roles when the workflow is sent (FRW-037), not by the `PUT`.
5. **Who may read.** 07 §12 has no row for the workflow. `GET` uses the row of the head content (`read.head`), as the field routes do (D145); `PUT` uses `manage`. What a participant sees of other participants is still open.
6. **Feature announcement.** The service announces `workflow` (discovery and `welcome`, 05 §1 rule 4) when it has a workflow store. A server built without one offers neither route and does not announce the feature; a relay-mode server has no authority and never does.
7. **Storage.** Migration `0071_frw_025_workflow_members.sql` adds `members` (one JSON object for the writable members other than the participants), `sent_seq` and `sent_hash` to `workflow_resource`. `sent_seq` and `sent_hash` stay null until `send` is built.

## Consequences

- A client that wants to create a workflow reads nothing first: it sends `If-Match: "0"` and a body that satisfies the schema.
- The seal level (`finalisation.seal`) is stored as text. Owner decision 15 (PAdES B-LT in phase 2, B-LTA in phase 4) is not enforced by the `PUT`; the sealing stories check it.
- The route checks `workflow_active` before the `If-Match`, so a client with a stale tag on a sent workflow learns that the workflow is no longer a draft.
