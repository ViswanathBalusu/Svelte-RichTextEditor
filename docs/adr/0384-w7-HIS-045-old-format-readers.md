# ADR 0384: Readers of old formats stay as long as history is kept (HIS-045)

Status: accepted by the owner (decision 58 in `docs/owner-decisions-2026-11-15.md`). The reading of two points the decision does not spell out (section 3 and the "Not decided" list) is proposed. Lane w7, 2026-11-17.

## Context

Spec 03 §11.3 records a migration as a snapshot commit with origin `migration`, with a checkpoint on each side, and says reading history older than a migration uses the checkpoint written before it and the matching older model package. Spec 08 §15 left open how long those packages stay runnable. ADR 0145 §1 gave the facts and three options:

- (a) keep old packages runnable for a fixed window;
- (b) convert old payloads at migration time;
- (c) limit comparison and restore to versions after the last migration.

## Decision (owner, decision 58)

Readers of old formats stay in the product for as long as history is kept. History is never rewritten.

This is option (a) with the window set to the retention of the history itself, not to a number of releases or months. It rules out (b), because a rewrite of the log would change recorded hashes (08 §2) and break the append-only rule. It rules out (c), because comparison and restore stay available for every version still kept.

## Consequences

1. How far back a replay needs old packages. A replay needs the reader for the engine and CDM version of every commit it applies, back to the checkpoint it starts from. A version after the last migration starts at the checkpoint written after it (03 §11.3 requires one on each side, and thinning never removes a checkpoint next to a snapshot commit, HIS-030) and needs only the current reader. A version before a migration starts at a checkpoint before it and needs the matching older reader. A replay may not always start at the checkpoint after the last migration: only versions at or after that checkpoint can.
2. Cost, as the spec and the code show it. Every reader of a past engine or CDM version stays built, tested and published for as long as any document keeps a commit made under it. The set only grows, so it is a standing cost of each migration. A reader is a pure replayer (`pm-steps/1` for CDM 1 at present), so its cost is size and test time, not a running service. No figure has been measured, and none is given here.
3. The history window and the support window differ. The support window of 03 §11.3 (versions n and n-1 side by side) governs what a service node or an embedded component may write or enable. The history window governs what may be read. A node need not accept new writes in version n-2 and still must read n-2 history. This reading follows from the decision and is proposed.
4. A commit with no matching reader is refused, as today (`contentAt`, and the `/content` route since round 5 of HIS-005). It is never replayed with the wrong schema.
5. When history is purged (HIS-039), the readers that only that history needed may be dropped. The decision does not say who checks that; see "Not decided".

## Spec changes

- 03 §11.3 third bullet and 08 §15 second bullet state this policy.
- HIS-005, HIS-011 and HIS-012 name it in their Notes. Their criteria already refer to "the matching package" and need no new behaviour.

## Not decided

- The commit metadata type (`CommitMeta`, `packages/history/src/types.ts`) has no schema version or engine version, although 03 §11.3 says every commit records both. The field belongs in the commit record of 06 §4.1, which the service writes. This is a gap to close in the service's commit record, not part of this decision.
- The worker that rebuilds content holds one replayer (`pm-steps/1`, CDM 1). A second replayer is added by the first migration that creates one; there is none to add now.
- How a deployment learns that no history is left under an old engine, so that its reader can be retired, is not designed.
