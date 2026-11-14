# ADR 0136: decisions taken by the ui-2 lane while building the phase 2 shell stories

**Status:** proposed (2026-11-13). Each item is an open question of the spec that the lane could not settle from the spec. The owner or the main session accepts or changes each one.

**Context.** Round 1 of lane ui-2 built the extension hook queue (UX-054), the import and export filter registry (UX-055) and the logic checks of extension commands (UX-051), all in `packages/ui`. The spec leaves the points below open, and the stories ask for them.

## Decisions

1. **Hook queue bounds (UX-054).** 13 §7.2 and §9 require hooks to be asynchronous and off the typing path, but give no number for a queue. `HookQueue` takes `capacity` (pending events, the oldest is dropped and counted) and `maxInFlight` (handler calls awaiting a promise) as required options with no default. The host chooses the values. Proposed: the owner sets them with the keystroke measurement (UX-054 criterion 1) before the first extension ships.

2. **Hook timing (UX-054).** A hook runs from a `later` callback. The default `afterPaint` waits for a frame and then a macrotask. Proposed: keep this; the browser run that checks "after the paint" is still to be done.

3. **Extension labels (UX-055, UX-051).** 13 §8 says every interface string is external. The host's string tables do not hold an extension's strings. Proposed: an extension's filter label is its own text in the filter entry, and a command's label is a string key that the extension's own table must contain. The table for extensions is not yet specified (owner or PRO decision).

4. **Output restriction code (UX-055).** The filter registry reports `no-export` as a reason code. The matching string key (for example `reason.access.noExport`) is not in the English table, and the table is not this lane's file. Proposed: the i18n owner adds the key.

5. **Export file name and type (UX-055).** The file name is the caller's base name plus the filter's extension. The MIME type is the filter's. The spec names neither.

6. **Import insertion (UX-055).** An import filter returns a fragment and the caller inserts it through its guards. The spec says "through the same guards as typing" but names no function. Proposed: the core supplies the insertion; the registry stays free of the core.

## Consequences

- The three modules are `packages/ui/src/extensions/hooks.ts` and `filters.ts`. Their tests are `packages/ui/test/extension-hooks.test.ts`, `extension-filters.test.ts` and `extension-commands.test.ts`.
- UX-050 (the manifest path) is not built. The extension tests register entries directly, as an extension will.
- UX-049 (the spike and the ADR it needs before UX-050) is not written by this lane.

## Round 2 decisions (custom nodes, UX-056 to UX-058)

Module: `packages/ui/src/extensions/custom-nodes.ts`; tests: `packages/ui/test/extension-custom-nodes.test.ts`.

7. **Block payload size (UX-056).** 03 section 4 sets 16 KiB and I12 enforces it. The editor measures the UTF-8 length of `JSON.stringify(payload)`. The canonical form of 03 section 11 would give the authoritative size; this package does not depend on `@docedit/model`. Proposed: the core re-measures with the canonical form before it sends, so the two cannot disagree at the boundary.

8. **Inline payload size (UX-057).** 13 section 7.3 says "a size limit" without a number, and 03 section 5 gives none. No limit is applied in the editor. Proposed: the owner sets one, and then the same check as the block applies.

9. **Empty fallback (UX-056, UX-057).** A fallback text or asset that is empty or only whitespace counts as absent. 03 names only `null`. Proposed: keep this, since a blank fallback leaves a reader with nothing to read.

10. **Availability of an extension (UX-058).** A node has no version attribute in 03, so a reader decides availability by the extension identifier alone. 13 section 7.3 says "at this version". Proposed: add the version to the node or to the registry when UX-050 is built; until then the identifier is the test.

11. **Extension identifier (UX-056, UX-057).** 03 gives no grammar for the `extension` attribute. The check accepts any non-empty text. Proposed: the owner defines the grammar in 03 (a dotted name, as the filter identifiers use) and the check follows it.

Status of the round-2 stories: no criterion of UX-056, UX-057 or UX-058 is ticked. Each one needs the core (node creation, the authority, the writers, the rendered shell) or the accessibility checker, none of which is in `packages/ui`.

## Round 3 decisions (host extensions, assistant context and output, UX-047, UX-048, UX-050)

12. **Supported extension API versions (UX-050).** 13 section 7.1 requires a version check but names no version list, and UX-049 (the API spike) is not decided. `ExtensionHost` takes `apiVersions` as a required option with no default, and an extension whose `apiVersion` is not in it is not activated. Proposed: the host lists the versions it supports, and UX-049 sets the first list. The manifest fields are `id`, `name` and `apiVersion` only, the minimum the editor reads; UX-049 owns any further field.

13. **Output links and images (UX-048).** 13 section 6.2 names the allowed schemes but not the form of a link in model output. `guardOutput` reads two forms, `[label](target)` and a bare `http(s)://` or `mailto:` address; a markdown target stops at a parenthesis or whitespace. A link passes only if its target also appears in the source text and its scheme is `http`, `https` or `mailto` (or it is an in-document `#` reference that appears in the source). A blocked link is shown as "label (target)" with a notice. An image is inserted only if its source is an attached asset identifier; a dropped image leaves no text and a notice. Proposed: the owner or the security review confirms these rules before the assistant ships.

14. **Assistant context shape (UX-047).** The request holds only the selection, the surrounding blocks, the outline, the host's attachments and a count of items left out for lack of `view`. The count carries no text. The requester's view is a predicate the caller supplies, so the core's projection (ADR 0019) stays the authority. Proposed: the core applies the same projection on the server before the port receives anything.

15. **Status-bar position of extension items (UX-052).** 13 section 3 lists the status bar's content but no place for an extension's item. `StatusItemRegistry` (packages/ui/src/extensions/contributions.ts) puts `start` items before `end` items, after the editor's own items, each in registration order. Each item has a visible `text` and a `label` as its text alternative, and both must be non-blank. Proposed: the owner or the design review confirms the two positions and the rule that the text alternative is always required.

16. **Extension panel identifiers (UX-052).** `contributePanel` refuses an identifier that a built-in pane already has, so an extension cannot replace an editor pane through the pane registry (which would otherwise merge the two descriptors, as it does for the host's comments loader). A panel's loader runs on the first open only, and a failed load is forgotten so the next open tries again. Proposed: confirm this rule before the first extension ships.

17. **Decision on sandboxed extensions (UX-059), evidence only.** The decision is the owner's, and this lane takes none. The spec default in 11 section 7 is phase 4, so UX-060 stays `cond`. Evidence the decision needs and that does not exist in the repository: named partners or authors, tier 1 usage figures, and a cost for the security review. Nothing here measures any of them.

## Round 5 decisions (output restrictions, finding actions, assistant lifecycle, UX-040, UX-042, UX-045)

Modules: packages/ui/src/commands/output-restrictions.ts, packages/ui/src/proofing/finding-actions.ts, packages/ui/src/assistant/request-lifecycle.ts. Tests: packages/ui/test/output-restrictions.test.ts, packages/ui/test/finding-actions.test.ts, packages/ui/test/assistant-lifecycle.test.ts.

18. **Which registry commands are output actions (UX-040).** The spec names the restrictions but not the command ids. The module maps document.export to export and document.print to print, and nothing else. The print command id does not yet exist in the registry. Proposed: the registry owner names the print command document.print, or changes the table in output-restrictions.ts.

19. **Copy, cut and drag under `no-copy` (UX-040).** The spec says `no-copy` prevents copy, cut and drag but names no DOM event set. Proposed: all three are refused under `no-copy`, and the editing surface's listeners call the same rule.

20. **Suggest-only users and apply (UX-042).** 07 section 12 (P4) makes a change from a user who holds suggest but not `edit` a suggestion. The module applies this to an apply action: a suggest-only user gets a suggestion, and a user with neither capability gets no apply. Proposed: the owner or the PRM owner confirms the P4 reading for block-level scopes (07 section 17 leaves it open).

21. **Assistant insertion gate and the lifecycle (UX-045).** The insertion gate is `edit` or suggest, and a failure keeps retry offered for all three failure codes. The spec names the codes but not the retry rule. Proposed: keep this until UX-046 defines how a suggestion from the assistant is recorded.

Status: no criterion of UX-040, UX-042 or UX-045 is ticked in round 5. Each rule is built and tested, but the call sites (print, export, copy and the commands, the menu and keyboard command, the assistant pane and its port) are not in packages/ui, so the criteria that describe the shell stay open.

## Round 7 decisions (comment thread rules, UX-029, UX-030, UX-032, UX-034)

Module: packages/ui/src/shell/comment-threads.ts. Tests: packages/ui/test/comment-threads.test.ts (Node.js, passed with comment-rules.test.ts, 34 tests).

22. **No event when an assignee is cleared (UX-032).** 05 section 7 names `dep.task.assigned` for an assignment and no event for clearing. Spec default, as the module does: no event on clear, and no event when the assignee is unchanged. Open for the owner or PRO: whether clearing needs its own event.

23. **The conflict code for thread writes (UX-029 criterion 6).** The module uses `precondition_failed`, the code core-api.ts names for a failed `If-Match` on grants. Open: whether the comment endpoints return the same code. A failure without the latest state is rethrown, not shown.

24. **Detached threads (UX-029 criterion 4).** A removal that empties a non-empty range detaches it, and detached is final: undo restores the text but not the anchor. This follows ADR 0015 as the story states it. Open: the spec does not say whether a later insertion may re-attach by a user action.

25. **The link to a comment (UX-034).** The request carries the document and comment identifiers only; the host returns the address and the editor copies it. The spec defines no method, event or address form, so the request shape is the editor's working choice, not a contract. A deleted or hidden comment gives one bare `unavailable` outcome, so nothing is revealed.

Status: no criterion of UX-029, UX-030, UX-032 or UX-034 is ticked in round 7. Each rule is built and tested. The rows, the controls, the live refresh, the scroll and highlight, the clipboard write and the messages are not built, and nothing was run in a browser.
