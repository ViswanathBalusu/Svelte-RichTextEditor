# ADR 0155: Security lane 2, backlog batch of 2026-11-13

Status: proposed. Date: 2026-11-13. Owner decision: not taken. Records the choices made while
building SEC-043 and SEC-039 in `tests/security`, where the spec left the detail open.

## Context

Lane security-2 works the end of SEC-security.md (SEC-028 to SEC-044), from SEC-044 backwards. Most
of that range needs parts not yet built (the evidence store, the signing service, the CPU budget of
the data plane, the sandbox under Podman). Two stories have criteria that can be tested in
`tests/security` against code that exists.

## Decisions taken by the lane (proposed, for the owner to confirm)

1. **Language check (SEC-043, criterion 1).** The spec (12 section 8.3) forbids the wording but
   does not say how a check tells a claim from a prohibition. The lane's default:
   - a match passes when its line negates it (`never`, `not`, `without`, `does not` and similar);
   - a match passes in a reviewed record: `docs/spec`, `docs/adr`, `docs/stories`, `docs/review` and
     `docs/research/2026-11-06-legal-note.md`, which state the rule or quote the word list;
   - "qualified" counts only before `signature`, `seal` or `time-stamp`, so `schema-qualified` passes;
   - test sources (`*.test.ts`, `*.spec.ts`) are not scanned.
   Owner to confirm the reviewed-record list, or name a reviewer for any new exemption.

2. **Known gap kept visible (SEC-039, criterion 6).** The zip reader does not refuse an entry whose
   name climbs out of the package. The importer reads only known part names, so the entry is
   ignored, not rejected. The test is `it.fails`: it passes today and flips when the importer
   refuses the name. The fix belongs to `packages/export-docx` (another lane).

3. **Cross-package import in tests.** `tests/security` imports `packages/export-docx/src/index.ts`
   by relative path, because it has no dependency on `@docedit/export-docx`. The clean fix is a
   `devDependency` in `tests/security/package.json`, which only the main session may change.

4. **Criterion 4 of SEC-039 is not tested.** Under A2 embedded objects are preserved, not dropped
   (10 section 3.5 as edited). The criterion needs rewording by the owner.

## Round 2 (lane security-2, 2026-11-13)

5. **Scope of the math-gate proofs (SEC-034).** The gate's decisions are tested in `tests/security`
   through the real functions of `packages/export-latex`. Criterion 1 stays open, because the
   commit-time run through the room is not in this directory. The fuzz oracle of criterion 6 needs
   the compile, so only the gate's accept and refuse decisions are checked here.

6. **Token-level oracle for the emitters (SEC-033).** Until the sandbox runs under Podman, the
   emitter proofs check the source of each emitter's output (its escapes, its hexadecimal forms),
   not the PDF. Owner to confirm that the source check is an acceptable stand-in only for the
   token-level part of criterion 1.

7. **Static check of criterion 4 (SEC-033).** The check searches for a cast to `Tex` or a call of
   `asTex` outside `emit.ts`. It does not search for every string concatenation; the type checker
   carries that part. Owner to confirm this is the intended meaning.

8. **Tex bundle notice (SEC-036, criterion 6).** The notice is the README of the `tex` archive. The
   test reads it back from the tar, so a change to the notice fails the proof.

## Needed from others (main session)

- Add `@docedit/export-latex` as a devDependency of `tests/security` (via the locked install script).
  Until then the tests import `packages/export-latex/src` by relative path, as SEC-039 does.

- Wire `tests/security/test/language-check.test.ts` into the CI workflow (`.github` is not edited
  by this lane). It runs under `pnpm test` today.
- Add `@docedit/export-docx` as a devDependency of `tests/security` (via the locked install script).
- `packages/export-docx`: refuse zip entry names with a parent-directory segment (SEC-039, criterion 6),
  then flip the `it.fails` case in `tests/security/test/docx-import-abuse.test.ts`.

## Round 3 (lane security-2, 2026-11-13)

9. **Since-access gate (SEC-032, criterion 2).** The test reads the gate through the data plane's
   `gateOf` and the authority's `minVisibleSeq`. Without an `access_since` claim the gate fails
   closed at the head (the rule of 07 section 8 as written in `packages/authority/src/room/gate.ts`).
   The commenter is the document role `commenter` of `packages/authority/src/permissions/model.ts`. Owner to confirm
   that a commenter has no `edit` anywhere, which makes the `editors` gate the head for them.

10. **Decision-level purge proof (SEC-044, criterion 5).** The criterion is ticked on `planPurge`, the
    decision the purge job must follow. The job that deletes rows is not built. Owner to confirm that
    a decision-level proof is enough for this criterion until the job exists; if not, untick it when
    the job is built. The retention period and the retention clock (FRW-084) are not decided: the
    test passes both values.

11. **Sealed PDF write-once (SEC-042, criterion 3).** The test uses the object store's write-once
    write of `AssetStore.putSealed`, which is the write the sealing path names as its store. Whether
    the export job calls `putSealed` for its final PDF is not checked here; the call site is not
    built in the test scope.

12. **Salt and chain payload (SEC-044, criterion 4 not ticked).** The payload `controlCommitEvidence`
    returns holds the origin and the hash only, and the test shows it. The criterion talks about the
    stored chain, which is not built, so it stays unticked. Owner to confirm the wording of
    criterion 4 covers the commit payload.
