# On-call process for the hosted service

Status: proposed (BE-097, lane w5, 2026-11-18). The owner has not accepted it. It applies to hosted
mode only. The owner chose both hosted and self-hosted mode from the start (answer 28 of
`docs/owner-decisions-2026-11-15.md`), so it is needed before the hosted launch.

Every figure in this document is either a target of the specification, quoted with its source, or a
rule with no figure ("any value above zero"). Where the specification has no target, the row says so
and names the story whose measurement sets the threshold. Nothing here is a measurement.

## 1. Roles

These are roles, not people. Decision 276 of `docs/owner-decisions-2026-11-26.md` sets the cover: a named
rota covers business hours. The rota is a list of named people kept by the owner, one primary and one
secondary for each week. This process does not promise cover outside business hours; an alert that fires
outside them waits for the start of the next business day unless the rota names someone for it. The owner
fills the names and defines business hours for the hosted service (time zone and days).

| Role | What it does |
|---|---|
| Primary on-call | Receives every page. Acknowledges it, decides the severity, starts the incident. |
| Secondary on-call | Receives the page if the primary has not acknowledged it. Helps the primary. |
| Incident commander | Runs a severity 1 or 2 incident: assigns work, keeps the timeline, decides when it is over. The primary is the commander until another person takes the role. |
| Communications lead | Writes the messages to tenants (section 5). On a severity 3 incident the commander does this. |
| Abuse function | Owns abuse reports (section 7). It is not paged by the alerts of section 3. |
| Owner | Told of every severity 1 incident and of any incident that touches data (section 4). |

## 2. Severities

| Severity | Meaning | Examples |
|---|---|---|
| 1 | Editing is down or data is at risk for many tenants. | Commits cannot be acknowledged; a checkpoint hash differs from a replay of the log; the log lost commits. |
| 2 | A tenant, a region or one function is badly degraded. | One tenant cannot open documents; exports are stuck; one node has lost its rooms. |
| 3 | Degraded but working, or a risk that has not yet hurt anyone. | Slow previews; a rising queue; a failed checkpoint that was retried. |

## 3. Alerts, thresholds and who is paged

The names are the metrics of BE-086 as the service emits them (`services/document-service/src/data-plane/metrics.ts`
and `src/control-plane/`). All metrics carry the node, and the per-tenant ones carry the tenant. None holds
document text, field values or tokens.

Thresholds taken from the quality targets of 00 §9 and the recovery objective of 06 §9 are targets, not
measured values. A row marked "to be set" has no target in the specification: set it from the baseline of
the story named in the row before launch, and record it here.

| Alert | Metric | Threshold | Severity | Paged |
|---|---|---|---|---|
| Checkpoint disagrees with replay | `dep_checkpoint_mismatches_total` | Any increase. The metric's own help text calls it an alert. | 1 | Primary, then secondary, and the owner is told |
| Log writes failing | `dep_write_failures_total` | Any sustained increase by an outcome other than a duplicate; rooms answer `unavailable` while it lasts (06 §8) | 1 | Primary, then secondary |
| Commit acknowledgement slow | `dep_ack_latency_ms` | 99th percentile above 300 ms within a region, over the window the owner sets (target of 00 §9; median target 50 ms) | 2 | Primary |
| Cold open slow | `dep_cold_open_ms` | 95th percentile above 500 ms for documents under 1 MB (target of 00 §9) | 2 | Primary |
| Availability budget | Rate of `dep_rejections_total` with code `unavailable`, with `dep_commits_total` | Monthly editing availability below 99.9 percent (target of 00 §9). The burn rate that pages is to be set (BE-080 gives the fault baseline). | 1 or 2 by burn | Primary |
| Persist latency | `dep_persist_latency_ms`, `dep_persist_batch_commits` | To be set (BE-080) | 2 | Primary |
| Checkpoint writes failing | `dep_checkpoint_failures_total` | Failures that continue after the retry of 06 §8. The room keeps serving and the log is enough for durability. | 3 | Ticket, no page; primary if it persists beyond the time the owner sets |
| Room memory | `dep_room_memory_bytes` against `dep_room_memory_max_bytes` | A room at its budget; or total room memory near the node's budget. The budget comes from BE-084. | 2 | Primary |
| Open rooms | `dep_open_rooms` | To be set (BE-084 measures memory per document; load stage 1 of BE-080) | 3 | Ticket |
| Slow consumers | `dep_slow_consumers_total` | A rise concentrated on one node or one tenant. A rise everywhere is a network or deploy problem. | 3 | Ticket |
| Rate limits | `dep_rate_limited_total`, `docedit_tenant_quota_refusals_total` | A tenant held at its limit; read before raising a quota | 3 | Ticket to the tenant's account owner |
| Export backlog | `docedit_job_depth` | To be set (06 §8 names autoscaling on queue depth, BE-065); previews wait behind finals when it grows | 2 | Primary |
| Replica lag | `docedit_replica_lag_seq` | Any sustained lag on a node that serves reads (BE-064) | 3 | Ticket |
| Node health | `docedit_event_loop_delay_seconds`, `docedit_process_cpu_seconds`, `docedit_process_memory_bytes` | To be set from the load runs of BE-080 | 2 | Primary |
| Rooms closing abnormally | `dep_rooms_closed_total` by reason | A rise of reasons other than idle close | 2 | Primary |
| Database or standby loss | The database's own monitoring, not the service's | Loss of the primary or the synchronous standby. Recovery within 15 minutes is the target (06 §9). | 1 | Primary, secondary and the owner |
| Backup or restore rehearsal failing | The rehearsal record (BE-082) and the backup audit (BE-096) | Any failure | 3 | Ticket |

Pages go to the primary named on the rota (decision 276), during business hours. A page that is not
acknowledged within the time the owner sets goes to the secondary, and after that to the owner. The
times are the owner's to set and are not fixed here.

## 4. Responding to an incident

1. Acknowledge the page and set the severity. Open the incident record: time, alert, severity, commander.
2. Check the first things first: is the log still acknowledging commits, and is any acknowledged commit
   at risk? The log is the source of truth. If the log is sound, nothing acknowledged is lost, and
   editors keep working locally (06 §8).
3. Use the failure table of 06 §8 for the likely cause and its handling. Typical actions: let the lease of
   a lost node expire and let clients reconnect; drain a node on deploy; give a document a new
   incarnation after a database recovery that rewound the log (04 §9, BE-078).
4. Debug without reading customer text. The default is the structural dump of BE-089, which replaces text
   runs with filler and writes an audit event with the operator's identity. Check a document with the
   recovery tools of BE-081 (`verify`, `rebuild`). Repair a broken document only by
   `services/document-service/docs/repair-procedure.md` (BE-090): a server-authored commit with origin
   `repair`, never an edit of the log.
5. Roll back a bad deploy before debugging it, if the deploy is the likely cause. Migrations follow
   expand and contract (06 §13), so two versions can run side by side.
6. Escalate. Severity 2 becomes 1 if more than one tenant is hit, if the cause is unknown after the
   commander's first review, or if the recovery objective of 15 minutes is at risk. Bring in the secondary,
   then the owner. An incident that touches data is raised to the owner at once, whatever its severity: a
   checkpoint mismatch, a log that was rewound, a restore, or an operator read of content.
7. Close the incident when the alert has cleared, the service has met its objective again, and the
   commander has said so in the record. Closing starts the review (section 6).

Reading document content beyond the structural dump is not part of incident response. It follows the abuse
policy (section 7).

## 5. Communication to tenants

- Who: the communications lead (the commander on severity 3).
- Where: one status page for the hosted service, and a message to each affected tenant's administrator
  contact, kept in the control plane with the tenant.
- When: after a severity 1 or 2 incident is confirmed, after any change of its impact, and when it is
  over. The first message is not held back for the cause. The times for the first message are the owner's
  to set.
- What: what is affected, since when, what tenants can do (editors keep working locally and the indicator
  shows "unsaved", 06 §8), and when the next message comes. Messages carry no document text, no names of
  documents and no names of other tenants. A tenant is told about its own documents only.
- Data incidents (a log that was rewound, a loss of acknowledged work, an access to content that should
  not have happened) are decided with the owner and counsel before the message goes out, because there may
  be a legal duty to notify. This document does not state those duties.
- After a rewound log, each affected tenant is told that clients reload and that unconfirmed work goes to
  recovered edits (06 §8).

## 6. Written review afterwards

A written review follows every severity 1 incident, every incident that touched data, and any other the
commander chooses. It is written without blame and held by the owner.

It records: the timeline from the first alert to the close; the impact (tenants, documents, duration; counts
only, no content); the cause; what worked and what did not; whether the alert fired when it should have; the
actions, each with an owner and a date; and the changes to this process. Actions that change code or
configuration become stories in the backlog. The review is shared with affected tenants in a form that holds
nothing of other tenants.

## 7. Abuse reports

Abuse reports are not incidents and do not page the on-call. They go to the abuse function and follow the
policy of SEC-061 (proposed in `docs/adr/0156-security-3-backlog-batch.md`, section SEC-061): how reports
arrive, who decides, the five actions in increasing severity (quarantine an asset, lock, archive or delete a
document, suspend a tenant), the rule that a second person approves a suspension, and the rule that a legal
hold wins over deletion and purge. What the operator may read in an abuse case is also set by that policy:
the structural dump of BE-089 by default, and anything more only with the second approver's agreement and an
audit event. This document does not repeat the policy and does not widen it.

An on-call engineer who meets what looks like abuse while handling an incident passes it to the abuse
function and does not act on the content.

## 8. What is not decided here

- Decided (276, 2026-11-26): a named rota covers business hours. Not decided: the names on the rota, the
  hours themselves, the paging tool, and the times for acknowledging and for first messages: the owner.
- The thresholds marked "to be set" in section 3: they need the measurements of BE-080, BE-084 and BE-085.
- The legal duties on a data incident: counsel.
- The self-hosted mode has no on-call of this kind. Its operators run their own (BE-083, BE-095).
