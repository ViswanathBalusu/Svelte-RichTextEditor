# Spike S12: read restrictions by projection

**Status:** spike result, 2026-11-06, SPK-029; not reviewed by the project owner.

## Question

Can per-reader projections of one log (ADR 0019) hide confidential regions and sensitive field values from readers without access, while sync, rebase, permissions and recovery keep working? What do they cost?

## Answer

Yes, with five changes to ADR 0019, listed under "Changes ADR 0019 needs". The evidence is the in-process simulation of S3 with a projection gateway between the room and the clients. Two of the changes are needed for correctness:

- **A view token in the resume (a protocol change).** The server cannot know which projection a client holds, so the client must say.
- **Content reads must check the grants revision.** Otherwise a reader whose access was just revoked can still be served hidden content.

The others concern cost and precision. Running the same checks against the real service is not part of this spike.

## What was built (kept, not throwaway)

| Part | Where |
|---|---|
| Projection (placeholder for hidden regions, redaction marker for hidden values), position maps, the diff step, mapping of a reader's steps to full positions with the refusals | `packages/authority/src/projection/projection.ts` |
| The gateway: an observer channel on the room, projections and diff steps per visibility class, rewriting of every outgoing message, mapping of incoming commits, the view token, visibility derived again when the grants revision moves | `packages/authority/src/projection/gateway.ts` |
| `view` in `Resume` and in `ch.opened` | `packages/authority/src/room/types.ts` |
| The S12 simulation with its leak oracle; the reference client echoes the view token | `packages/authority/test/harness/projection-sim.ts`, `client.ts` |
| The cost script | `packages/authority/scripts/projection-cost.ts` |

The fixture document has one confidential region, whose title and a paragraph carry unique `TOPSECRET` markers, and one sensitive field value carrying another. The region is readable by the owner and by anyone with a grant on it. The value is readable by the owner and by participants holding the field's assignee role.

## Evidence

All commands run from the repository root. fast-check picks a new seed for every run, so the totals below are those of one run.

| Test | What it shows | Result |
|---|---|---|
| `projection.property.test.ts` (`S12_RUNS=1000`) | Random schedules over 2 to 7 users of every role, one malicious, with the faults of S3: failed and unknown writes, grant changes with the notification lost, dropped connections, crashes with failover. Readers with access type secret markers into the region and fill the value. After quiescing: every client holds the projection of the head for its current view; the S3 permission oracle holds on the full log; the leak oracle found nothing | 1,000 schedules pass in 13 s. 38,214 outgoing messages checked; 4,197 carried a marker to a reader allowed to read it, none to anyone else. 4,317 stored commits, 4,449 reloads, 2,183 rejections, 5,376 unconfirmed edits sent to recovered edits |
| `projection.differential.test.ts` (300 runs) | Two rooms with the same document and permissions, one behind the gateway. Each edit (typing, deleting, bold, split, fill, deleting the placeholder or across it) is made once on the reader's projection and once at the matching full positions. Verdicts and resulting documents are compared | 846 commits got the same verdict in both rooms (331 accepted, 321 `permission_denied`, 194 `invalid_op`), and the rooms held equal documents throughout. 282 edits touching hidden content were refused by the gateway. In 90 of them the full room would have accepted the edit: an editor filling a value they cannot read |
| `projection.test.ts` | Redaction leaves the full document untouched; positions map in both directions; for 500 random edit sequences the diff step turns one projection into the next, and the incremental projection equals one built from scratch; a reader cannot delete the placeholder or set a hidden value | 4 pass |

## Cost

Measured with `node packages/authority/scripts/projection-cost.ts 300 1` on the development machine: Intel Core i9-10900KF (20 logical cores), 128 GiB, Windows 11 (10.0.26300), Node.js 22.18.0. Corpus `docedit-corpus 1 (528ab574)`. This is not the reference machine, which FND-007 has not named yet.

Each of 300 commits types one character at a random text position of the full document, hidden regions included. "Outgoing" is the projection after the commit plus its diff step, for one class. "Incoming" maps one character typed by a reader of that class to full positions. Times are in milliseconds: median / p95 / max.

| Document | Body children | Class | Hidden regions, values | Cold projection | Apply on full (baseline) | Outgoing | Incoming | Empty diffs |
|---|---|---|---|---|---|---|---|---|
| form-fields | 14 | half hidden | 0, 7 | 1.3 | 0.008 / 0.015 / 0.793 | 0.034 / 0.070 / 0.496 | 0.009 / 0.028 / 0.521 | 0 of 300 |
| form-fields | 14 | all hidden | 0, 13 | 0.7 | 0.008 / 0.015 / 0.793 | 0.031 / 0.061 / 1.426 | 0.007 / 0.015 / 1.955 | 0 of 300 |
| pages-20 | 123 | half hidden | 1, 0 | 6.0 | 0.005 / 0.008 / 0.031 | 0.058 / 0.096 / 1.930 | 0.007 / 0.013 / 0.053 | 0 of 300 |
| pages-20 | 123 | all hidden | 2, 0 | 4.7 | 0.005 / 0.008 / 0.031 | 0.052 / 0.092 / 4.863 | 0.005 / 0.009 / 0.052 | 2 of 300 |
| pages-100 | 515 | half hidden | 7, 0 | 21.2 | 0.008 / 0.018 / 0.135 | 0.111 / 0.197 / 1.461 | 0.009 / 0.020 / 0.120 | 4 of 300 |
| pages-100 | 515 | all hidden | 14, 0 | 15.9 | 0.008 / 0.018 / 0.135 | 0.101 / 0.156 / 1.600 | 0.005 / 0.008 / 0.059 | 8 of 300 |
| pages-300 | 1,579 | half hidden | 22, 0 | 28.8 | 0.008 / 0.013 / 0.046 | 0.226 / 0.303 / 1.253 | 0.011 / 0.017 / 1.054 | 2 of 300 |
| pages-300 | 1,579 | all hidden | 43, 0 | 25.3 | 0.008 / 0.013 / 0.046 | 0.262 / 0.336 / 2.373 | 0.004 / 0.006 / 0.043 | 7 of 300 |
| pages-1000 | 5,285 | half hidden | 72, 0 | 106.6 | 0.026 / 0.061 / 0.947 | 1.019 / 2.421 / 4.142 | 0.040 / 0.098 / 0.241 | 6 of 300 |
| pages-1000 | 5,285 | all hidden | 143, 0 | 91.4 | 0.026 / 0.061 / 0.947 | 1.254 / 3.027 / 4.989 | 0.009 / 0.020 / 0.824 | 12 of 300 |

`pages-1` has neither regions nor fields, so its readers share the full document.

What the figures show:

- A commit reconverts only the nodes on the path to its change, because ProseMirror shares unchanged nodes between versions and the projection caches converted nodes by identity. The cost does not grow with the size of the content.
- It does grow with the number of the body's children. Every commit rebuilds the body's child list, and the diff step scans it from both ends. At 1,000 pages this is about 0.2 µs per child, or 1 to 1.3 ms per class per commit (median). The authority's own target is well under a millisecond (04 §12), so one class already exceeds it at that size. The fix is in change 4 below.
- A cold projection is paid once per class when a room starts or fails over: about 100 ms at 1,000 pages.
- The first version converted each changed top-level child through JSON. It cost 2 to 2.7 ms per commit at 1,000 pages, and 0.9 ms on `pages-20`, where some top-level children are large. Caching per node, and interning class keys, gave the figures above. Class keys list every hidden scope; before interning, comparing those kilobyte strings on every cache hit cost more than the projection itself.

### After change 4 (mapped steps), measured by SYN-051's work

The authority agent then built change 4: a commit is sent to a class as its own steps mapped to projected positions, with one replace step per changed range as the fallback (second review SR-M1). Measured the same way on the same machine (other agents running; the corpus had moved to version 2, so the "same run" column is the fair comparison), median ms of outgoing work per class per commit, half hidden / all hidden:

| Document | Mapped steps | Projection and diff, same run |
|---|---|---|
| form-fields | 0.016 / 0.016 | 0.050 / 0.042 |
| pages-20 | 0.015 / 0.013 | 0.073 / 0.064 |
| pages-100 | 0.021 / 0.023 | 0.160 / 0.158 |
| pages-300 | 0.017 / 0.023 | 0.257 / 0.280 |
| pages-1000 | 0.098 / 0.143 | 2.271 / 2.918 |

The same work found two further leaks, both fixed, with S12's suites at 1,000 schedules each passing afterwards: a step that changed nothing still carried a hidden value in its JSON (now never forwarded), and per-step diffs could send hidden text that one step of a commit moved and a later step deleted (now, from the first step that cannot be mapped, a class gets the commit's net result only). ADR 0034 records the details.

## Defects found and fixed

1. **Redaction changed the full document.** `Node.toJSON()` shares each node's attribute object with the node itself. Redacting in place therefore wrote the marker into the full document. Attribute objects are now replaced, never mutated.
2. **A crafted step threw.** A reader's step mapped outside the document made ProseMirror throw rather than fail. Mapping now treats an exception as `invalid_op`.
3. **No history after a failover.** A new gateway could not project the catch-up of clients resuming from an older sequence number. It now starts from the content at sequence number 0 and the log. A production gateway would load projections from checkpoints.
4. **A reader resumed under an old view.** With seed 46, a reader lost access while disconnected. The gateway forced a reload, but the reload never arrived. On the next resume the gateway saw no reason to force one again, and the reader kept the hidden region. The server cannot know which projection a client holds, so the client must say: `ch.opened` now carries a view token, the client echoes it in its resume, and a missing or different token forces a reload. This is a protocol change (change 1).
5. **A redacted value could be copied.** A reader who copied and pasted a field whose value they cannot read would have written the redaction marker into the full document. Slices that carry a placeholder or a redacted value are now refused.

## Changes ADR 0019 needs

1. **View token (PRO).** `ch.opened` carries an opaque token naming the visibility class of the content and stream it starts. The resume echoes it. The server forces a reload when the token is missing or names another class. The spike's token is an unkeyed hash of the class key; a production token should be keyed, so that it reveals nothing about which scopes are hidden.
2. **Changes of access are a close and a forced reload, not a `sync.reset` message.** When the room's grants revision moves, the gateway derives every channel's visibility again. A channel whose class changed is closed (`ch.closed`), and its next open is a forced reload carrying the new projection. Unconfirmed work then goes to recovered edits, all of it, as for any reload: 5,376 edits in the run above. A later refinement could send one step from the old projection to the new one, so that the client can rebase its work instead.
3. **Content reads check the grants revision in storage.** When the notification of a grant change is lost, the room keeps its old permissions until a write is refused because the revision moved. In that window, a reader whose access was revoked can open the document and receive the hidden region. This happened 4 times in the 1,000 runs, always in the content of `ch.opened`, never in a commit. Commits are sent only after a write conditional on the grants revision has succeeded, so they always follow the revision in force. Content reads must check the revision too, or the control plane's notifications must be delivered reliably. The leak oracle accepts what the room's permissions allow; this window is counted separately (`staleReads`).
4. **Map steps instead of diffing, where possible.** A commit that does not touch hidden content can be sent to a class as its own steps, mapped to projected positions. That costs time in proportion to the change, with no scan of the body. It also keeps each step's type: a diff step turns "bold this range" into "replace this range", so selections, comments and presence inside the range map to its edge. Diff steps stay as the fallback for commits that touch hidden content, and remain the correctness reference.
5. **What a reader may not send.** The gateway refuses, before the room sees them:
   - steps that touch a placeholder;
   - slices that carry a placeholder or a redacted value;
   - changes to the value or default of a field whose value is hidden.

   The last rule is stricter than the permissions. An editor may change any value in their scope, but not one they cannot read. The differential test counts these cases. Changing a field's `sensitive` attribute, or a region's policy to or from `confidential`, should need `manage`, as other policy changes do (PRM).

## Open questions of ADR 0019

| Question | Where the spike leaves it |
|---|---|
| Region titles hidden or shown | The design supports both (`titles` in the hidden set). The spike hides them. The choice is a policy setting for PRM, not something evidence settles |
| Timing leaks from empty commits | Measured, not removed, as SPK-029 asks. 0 to 12 of 300 random commits changed only hidden content and reached the other class as empty commits. Batching or delaying them stays possible |
| Who may read a hidden value by default | The spike used the owner and participants with the field's assignee role. Users with `manage`, and principals named by a grant, are the ADR's proposal; owner to confirm |
| Owners always see everything | Assumed in the spike. Separation of duties is not tested |
| Suggestions and comments in hidden regions | Not covered: neither exists in the authority yet |
| Whether a reader may delete a field whose value they cannot read | Allowed today: the full room's rules apply, and deleting reveals nothing. Owner to confirm |

## Not covered, and why

- **Presence, comments, history, comparison, search, export, checkpoints.** None of them exists yet. Each must go through the projection (ADR 0019, decision item 5). The stories that build them carry that requirement, listed below.
- **The real service.** This spike uses the in-memory storage of the harness, like S3.
- **Many classes at once.** The simulation has one confidential region and one sensitive value, so at most four classes. The cost script measures two classes with up to 143 hidden regions.
- **The reference machine.** The cost was measured on the development machine; FND-007 names the reference machine.

## Stories to add or change

A read-only search of the nine epics found about 150 stories that assume every reader sees the whole document, and 17 stories missing. The missing ones are now in the backlog, each in a "Read restrictions (ADR 0019)" section of its epic:

| Epic | New stories |
|---|---|
| CDM | CDM-053 the confidential policy, the placeholder and the redaction marker |
| PRM | PRM-066 make a region confidential; PRM-067 each connection's hidden set and visibility class |
| SYN | SYN-050 projections per class; SYN-051 commits per class; SYN-052 map and vet a reader's commit; SYN-053 close and reload on a change of class |
| PRO | PRO-130 the view token and read restrictions in DEP (S6 gaps G101 to G103); PRO-131 the `perm-read` conformance profile |
| BE | BE-098 projections for reads outside a room |
| HIS | HIS-046 history surfaces as the requester's projection (phase 2) |
| EXP | EXP-123 export as the requester |
| FRW | FRW-088 mark a value sensitive; FRW-089 hide values derived from hidden content (phase 2) |
| FE | FE-141 render placeholders and redacted values |
| UX | UX-104 explain hidden content to the reader |
| SEC | SEC-064 prove hidden content never reaches a reader without access |

The existing stories are not rewritten one by one now. Instead, rule 8 of `docs/stories/README.md` makes the change binding: whoever builds one of the stories below applies the change shown and updates the story's text. "-007" means the same prefix as the row.

| Stories | Assume today | Change |
|---|---|---|
| PRM-001, -004, -011, -036 | the policy is `inherit` or `restricted` only | add `confidential` (changing it needs `manage`); its grants convey `view` |
| PRM-006, -007, -019, -021, -023 | an access change sends only `perm.changed` | when the hidden set changes, close the channel and force a reload |
| PRM-024, -026, -032 | regions are named by title to anyone with `view` | withhold hidden titles; show a placeholder |
| PRM-037, -039 | thread ranges in full positions | map from projected positions; threads in hidden content are `not_found` |
| PRM-041, -042 | the visibility gate is the only filter | the gate plus the projection on every surface |
| PRM-057, -058, -060 | a `view` holder sees every region | add read rows and threat cases |
| SYN-006, -047 | clients equal the server's document | they equal the projection of the head for their class |
| SYN-008, -015, -030, -041 | acks and broadcasts carry the stored steps to everyone | per class: mapped steps, diff-step fallback, empty commits |
| SYN-010 | rebase over every accepted step | rebase in projected space, then map |
| SYN-004, -005, -019, -023, -026 to -029 | an empty commit is a control commit; reload and catch-up use full content; the ETag is incarnation and `seq` | accept empty commits; projected reload and stream; reload on a different view token; class in the ETag |
| SYN-032, -033, -035, -036 | ranges and presence mapped and relayed in full | map through the projection; drop presence and threads inside hidden content |
| SYN-037, -040, -042 to -044 | one budget per commit; followers send the same commits; one document hash; relay mode | count per-class work; followers per class; hash the projection; relay mode never offers read restrictions |
| PRO-006, -023, -091 | no feature name or reader identity in `ch.opened` and `loadContent` | feature name, view token, `hidden_region` in `CdmNode` |
| PRO-025 to -027, -029, -030 | stored steps; one hash; join by REST then stream | class steps, possibly empty; per-class `sync.check`; content returns `view` |
| PRO-024, -031, -033, -034 | `unavailable` means the room moved; positions refer to the confirmed document | a distinct close reason; projected positions |
| PRO-036, -045, -059, -060 | thread events and reads need only `view` | omit threads in hidden content; projected ranges |
| PRO-049, -051, -062 | content is byte-identical and cacheable; region titles; all the document's assets | projection with the class in the ETag; withhold hidden titles and assets |
| PRO-054, -055, -057, -058 | history filters, diff, attribution, activity and fork over everything | projected; refuse filters on hidden scopes; fork as the acting user unless `manage` |
| PRO-063 to -065, -084 | any `view` holder exports; jobs readable by others; `insertContent` takes any fragment | export as the requester unless `manage`; jobs private; refuse hidden atoms |
| PRO-101, -103 to -106 | the authority service works on the full document | add projection and mapping calls; announce read restrictions only if supported |
| BE-036, -038 | reads straight from storage, cached as immutable | project at the current grants revision; private, class-keyed caching |
| BE-044, -045, -051 | assets used by the document; previews per document | only assets in the projection; previews per class |
| BE-053, -054 | search indexes the checkpoint's text | exclude hidden content, or filter by the acting user's class |
| BE-028, -063, -064, -075, -084 | followers, presence, replicas and edge caches share one copy | per class; read the grants revision from the primary; memory per class |
| HIS-005, -010, -022 | old versions and forks from content at a `seq` | project with current access; class in the cache key; fork as the acting user unless `manage` |
| HIS-008, -009 | groups, counts and filters over all commits | omit commits that touched only hidden content; refuse hidden filters |
| HIS-011 to -013, -015, -016 | diff spans carry text; field values; attribution of any scope | compare projections; redact values; refuse hidden scopes |
| HIS-026 to -028, -037 | tests cover only the gate; activity since the marker | add projection tests; activity per class |
| EXP-001, -004, -011, -086, -087 | the bundle is built from the CDM document | build from the requester's projection; the manifest lists redactions |
| EXP-005, -008, -066 | no scope option; previews per document; raw logs to anyone with `edit` | full export only with `manage`; previews per class; logs to the requester |
| EXP-019, -023, -082, -084, -092, -093 | references, contents, suggestions and comments from the full document | visible items only; a redaction notice for hidden targets |
| EXP-033, -034, -095 | flatten every field's value, mirrors and formulas included | redact sensitive values and values derived from them |
| EXP-094 | Word content controls carry region titles; grants go in a custom XML part | placeholders; the grants part only for `manage`; warn that a full DOCX is unprotected |
| EXP-108, -116 to -119 | the original Word file is downloadable by anyone with `view`; R0 byte-identity | only for readers who see everything; patch the original only in full exports |
| FRW-001, -002, -003, -060 | every participant reads every value; `/fields` lists fields in hidden regions | role membership grants reading; drop hidden fields; class-keyed caching |
| FRW-006, -017, -023 | mirrors, formulas and client-side rules read every value | derived values are hidden with their inputs; the server evaluates them |
| FRW-031, -035 | workflow transitions send only `wf.changed` and `perm.changed` | force a reload when who may read changes |
| FRW-049, -054, -055 | one final PDF with every value; the evidence bundle holds the log segment | redaction per participant, or restricted delivery (owner question) |
| FRW-069, -073, -075, -079 | `sensitive` is not offered; preview as a role; values read and announced | offer `sensitive` with `manage`; preview that role's projection; a redacted value is not an empty one |
| FE-009, -030 | journalled work resubmitted unless the incarnation differs; schema from the CDM | a different view token sends work to recovered edits; add `hidden_region` |
| FE-037, -050, -051 | cut copies the whole selection; pasted fragments are kept | never copy or paste placeholders or redacted values |
| FE-068, -071 to -073 | PDF and page guides come from the export of the current document | use the requester's own export |
| FE-077, -095, -134 | layout makes flow blocks for every node; `cached` holds its last text | a fixed-size placeholder; redact `cached` text whose target is hidden |
| FE-105, -130, EXP-024 | numbering is computed across all regions | decide full or projected numbering (counts leak); FRW-089 |
| UX-026, -027 | every peer is drawn at a mapped position | no caret for peers inside hidden content |
| UX-030 to -032, -034 | the pane lists all threads; anyone can be mentioned | visible threads only; warn when the person cannot read the scope |
| UX-084, -096, -097, -101 | search and actor calls are attribution only; the export dialog has no scope | the acting user's projection; the dialog shows scope and redactions |

Checked and unaffected: webhook bodies (PRO-069, PRM-053), the audit log (UX-081), operational logs (BE-088), find in the editor (FE-059), discovery and tenant exports (UX-087, UX-088).

## Recommendation

Keep ADR 0019's design, with the five changes above, and leave it proposed until the owner confirms the policy questions. Before phase 1b builds on it:

- add the view token to DEP (PRO);
- make content reads check the grants revision (BE);
- implement the mapped-step fast path, with diff steps as the fallback (SYN);
- repeat the cost measurement on the reference machine.

Keep the gateway, the simulation and the differential test: together they are the regression suite for read restrictions.
