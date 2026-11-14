# ADR 0133: Element-2 backlog batch (FE-103 to FE-126, FE-141)

Status: proposed (2026-11-13, element-2 round 2). Decisions here are the spec's defaults where
the spec is silent, and are open for the owner or the accessibility specialist to confirm.

## Context

The element-2 lane works the frontend epic from the end of its slice (FE-126 backwards). Most
stories in FE-103 to FE-126 need a browser, a device, a demo host or a CI gate; the part that can
be built inside `packages/element` in Node.js is small.

## Decisions

1. Screen-reader announcements are produced by a DOM-free announcer (`packages/element/src/announcer.ts`).
   The live region, its root and the wiring to `de-status` and `de-recovered-edits` are left to
   the element's shell code. The announcer takes an injected sink and scheduler.
2. Politeness is `polite` for every announcement. The spec does not state a level (FE-107 Open
   questions); the default is used and is open.
3. Save-state changes are announced once per change of state, not per keystroke. Whether a
   `saved` sentence after every keystroke is a flood is an accessibility decision (FE-107
   criterion 7). Until it is made, the announcer does not suppress it.
4. Sentences come from a table per locale (`ANNOUNCE_EN`). UX-064 will feed the table; until then
   English is the only locale.

## Stories left open in this round, and why

- FE-103, FE-104, FE-106, FE-108, FE-113, FE-114: the criteria need a browser, a touch device, a
  viewport or an ARIA resolution in a shadow DOM. `packages/element` has no DOM test library, and
  the `view` attribute's behaviour arrives with PRO-079.
- FE-111, FE-112, FE-115, FE-117: need the engine's right-to-left work, a spike, a device or
  installed browser extensions.
- FE-118, FE-119, FE-120: measurements (keystroke to paint, time to interactive, memory). No
  figure is invented here; each needs a harness run in CI.
- FE-121 to FE-126: need the browser suites, host demos, a strict-policy page, or a release
  checklist. The unfinished criteria are recorded in their Notes.

## Consequences

- `packages/element` gains `src/announcer.ts` and `test/announcer.test.ts`.
- FE-107 criterion 5 is ticked on the announcer's queue. Criteria 1 to 4, 6 and 7 stay open.

## Round 3 (element-2, 2026-11-13)

Status: proposed. Open for the accessibility specialist and the ui lane.

5. Which live region announces recovered edits and refusals is left open. The shell's own live
   region (`packages/ui/src/App.svelte`, `NoticeTracker`) already announces them. The element feeds
   only `de-status` into its announcer (`packages/element/src/doc-editor.ts`, `#emit`). A review
   asked for `de-recovered-edits` to be fed too; that would make a screen reader hear each
   recovered-edits notice twice. The element does not decide it. Needed: a decision on one owner
   for each of refusals and recovered edits (FE-107 criteria 2 and 4).
6. FE-119 criterion 2 is checked at the level of static value imports from the package entry
   (`packages/element/test/critical-path.test.ts`). The browser network listing is not run.
7. FE-125 criterion 4 is checked by comparing the published policy names (S2 report, section 8)
   with `POLICY_NAMES` and with the `trusted-types` and `style-src-attr` values of
   `packages/element/e2e/s2-features.spec.ts` (`packages/element/test/published-policies.test.ts`).
   The `font-src` origins and the worker's response policy are not compared.

Round 3 stories ticked: FE-125 criterion 4. Not ticked: FE-119 criterion 2 (browser network
listing open). Stories in this slice whose criteria need a browser, a device or a host demo were
not run (FE-124, FE-126, FE-103, FE-104, FE-106, FE-113, FE-114, FE-118, FE-120, FE-122).
