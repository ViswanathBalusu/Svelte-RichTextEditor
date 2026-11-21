# ADR 0421: Keeping the preview window where a compile starts, and showing an earlier preview for an unchanged bundle

**Status:** proposed, 2026-11-20 (lane w2; EXP-008 criteria 2 and 3). The owner has not reviewed it. No owner decision covers these points: `docs/owner-decisions-2026-11-15.md` was searched for EXP-008, the preview window and the bundle hash.

## Context

06 §10 bounds the cost of preview compiles with three rules: only while somebody looks, at most one per document per ten seconds, and skipped when the bundle hash is unchanged. EXP-008 turns them into criteria.

Before this record the second and third rule were kept only in part (evidence audit of 2026-11-13, in the story's Notes).

- **The window counted from a request.** The route held a new preview until the latest preview's request time plus the window (BE-051). A preview that waited for a worker could start just before the next one, and the previews of several viewers queued up a second apart and started a second apart.
- **The cache keyed on the request.** The first-result cache (EXP-006) answers an identical request: same `seq`, view, target, options and class version. A document can change without its bundle changing: an edit somebody undid, an edit in a part hidden from this reader, or a change that does not print, such as a region's title. Such a request has a new `seq`, so it compiled again.
- The bundle is known only when the converter has run, and the converter runs in the worker.
- `manifest.bundleHash` cannot be compared between jobs as it is. Every option joins it (EXP-005), and one option is the instant of the job, which differs for every job.

## Decision

### 1. The queue keeps the window, from the start of the compile (criterion 2)

1. A job may carry a **start gap** (`startGapMs`) and a **start stage** (`startGapStage`). Every preview job carries the preview window and the stage `compiling`. Other jobs carry neither and are claimed as before.
2. A job's **start** is its claim. For a job with a start stage the start moves to the time the job reports that stage. The export worker reports `compiling` immediately before it starts the sandbox, so this time is what "a preview compile starts" means in this record. It is taken in the queue's own clock (for PostgreSQL the database's, 06 §2.1).
3. A claim passes a job with a start gap by
   - while another job of the same tenant, document and kind runs under a live lock and has not yet reported its start stage, because that stage may begin at any moment; and
   - within the gap after the latest start of a job of the same tenant, document and kind, itself included when it is tried again.
4. A new attempt of a job with a start stage has reported nothing yet: the claim clears the stage and progress of the earlier attempt.
5. So the starts of the compiles of one document's previews are at least a window apart, whoever asked, however long a job waited for a worker, however many wait, and however long each takes to reach its compile.
6. The hold at the request stays (BE-051). It is early and cheap, and it answers the same requester's same request with the pending job. It is no longer what the rule rests on.

In PostgreSQL this is `docedit_claim_job_v3` (migration `0096_exp_008_preview_start_gap`), which replaces `docedit_claim_job_v2` for every claim of the service. The check and the claim for one tenant, document and kind are serialised by a transaction-level advisory lock. The lock is tried, never waited for: when another claim holds it, the job is passed by and a later claim looks at it again. A claim therefore never waits for one document's lock while it holds another's. The gap is measured with `clock_timestamp()`, not with the time the transaction began. The heartbeat that reports the start stage moves the start.

### 2. A preview of an unchanged bundle shows the earlier files (criterion 3)

1. After conversion and before the compile, the worker computes the **preview key** of the bundle: SHA-256 over the hash of every file of the bundle, the options without the job's instant, the class version, the image digest, the fonts with their hashes, and the diagnostics the job has so far. The instant reaches the files only through `date` fields, whose printed text is in `main.tex` and so in the key.
2. The worker looks in the queue for the newest completed job of the same tenant, document and kind whose result holds this key. A job that itself showed earlier files names the job that compiled them (`from`); that job is the one used. A compile older than seven days is not used. Seven days is the default age of the control plane's own cache, and a setting, not a measurement.
3. When there is one, the job ends `completed` without a compile. Its result names the earlier job in `from`, as a cached result of EXP-006 does, and the control plane signs the URLs of that job's files. The result carries this job's own chain head. The raw log goes on only to the requester of the compile (EXP-123 criterion 4).
4. Equal keys mean equal files, options, class, image, fonts and diagnostics before the compile. By 09 §9.4 the same bundle and image give the same PDF. So the result is the one this job's own compile would have had, except for where the files are and who may read the raw log. A test compares the two.
5. Previews and final exports stay apart (09 §8): the lookup is by job kind, and only preview jobs make it.
6. The worker reads the queue only. It never reads an earlier job's files, because workers hold no credential but a write-only upload location (09 §9.3 item 6).
7. A lookup that fails is a miss, and the preview compiles.

## Consequences

- **Stricter than the rule in three cases, never looser.** A job that is claimed and then compiles nothing still counts as a start from its claim: a preview that showed earlier files, one that failed in conversion, a preview of a target without a compile. A handler that never reports the stage holds the document's other previews until it ends. A retried attempt waits a window after the attempt before it.
- **A lock that ran out.** A job whose lock ran out before it reported its stage no longer holds the document. If its worker is still alive and reports the stage later, two compiles can start inside one window. A worker renews its lock three times in each lease, so this needs a worker that stalls for a whole lease.
- **`layout.json` of a shown preview** names the `seq` of the compile, which is lower than the job's. The blocks and offsets are the same, because `map.json` is part of the key. A reader that adopts breaks only for paragraphs not edited since the layout's `seq` (FE-100) adopts fewer than it could.
- **The PDF's metadata** keeps the date of the job that compiled it.
- **Rollout.** A worker of the previous release claims with `docedit_claim_job_v2` and keeps neither rule. The window holds once every worker claims with v3.
- **Cost of the lookup.** It reads the jobs of one document through the existing index `jobs_by_doc` and filters on the result. No index on the key was added.
- **Queue depth** counts held previews as queued, as it already counted delayed jobs.
- The result member `previewKey` is internal. The job resource does not show it.

## Alternatives considered

- **Count from the claim only.** Simpler, and it needs no stage. The sandboxes of two previews could then start less than a window apart whenever the first takes longer than the second to reach its compile. `services/export-worker/test/exp-008-preview-window.test.ts` fails under that rule.
- **One preview of a document at a time.** It gives the same bound, and it makes a newer preview wait for the whole of a long compile.
- **Key the control plane's cache on the content.** The control plane would have to convert before it queues, or hash the content at `seq`. A content hash misses the changes that do not print and the reader's projection.
- **Compare `manifest.bundleHash` itself.** It holds the instant of the job.
- **Copy the earlier files to the new job.** A worker cannot read them.

## Open, for the owner

1. Whether a claim that compiles nothing should count for the window. It does here, because the queue cannot know at the claim what the job will do.
2. Whether the instant should leave the bundle hash itself (EXP-005), so that the key of this record is the bundle hash of 09 §2 and not a second hash.
3. The age limit of seven days, and whether it becomes a setting of the worker.
4. Whether the worker should write a manifest of its own for a preview that shows earlier files. It writes none today; the job's result records `from` and the key.

EXP-008 criterion 5 (no compile for page-break reconciliation where a tenant has not switched it on) is not part of this record. No tenant switch and no compile for reconciliation exist yet.

## Tests

- Queue, in memory and on PostgreSQL: `services/document-service/test/control-plane/exp-008-start-gap.test.ts`.
- Route, in memory and on PostgreSQL: `services/document-service/src/control-plane/export-jobs.test.ts` ("starts one preview compile of a document per window, however many viewers wait").
- Worker: `services/export-worker/src/exp-008-preview-reuse.job.test.ts`.
- Route and worker together: `services/export-worker/test/exp-008-preview-window.test.ts` and `services/export-worker/test/exp-008-unchanged-bundle.test.ts`.
