# ADR 0370: The first interactive editor is over its size budget with the DEP client

**Status:** proposed, 2026-11-17. Written by the integrator of batch 5. Not reviewed by the project owner. The decision is the owner's; nothing in the code was changed to hide the failure.

## Context

13 §9 sets a target of 300 kB compressed for the first interactive editor, and FE-002 and FND-008 make the library build fail above it (`packages/element/scripts/bundle-report.ts`, `BUDGET_GZIP_BYTES = 300_000`). The gate counts two configurations: a host backend, and the DEP client (the `dep-client` chunk joins the first interactive set when a host sets `endpoint`).

Measured with `pnpm build` on Windows 11, Node.js zlib, gzip level 9, minified library build (`packages/element/dist/lib/bundle-report.json`):

| State | Host backend | With the DEP client |
| --- | --- | --- |
| Lane worktrees w3 and w4, builds of 2026-11-15 (evening) | 239.8 kB | 296.7 kB |
| Integration `ccd52bb` (w5 and unblock worktree builds) | 250.3 kB | 307.5 kB |
| Integration after the batch 5 merges | 276.6 kB | 315.4 kB |
| Integration after the batch 6 merges (same method; `bundle-report.json` of 2026-11-17) | 291.4 kB | 330.5 kB |
| Integration after the batch 1 merges (same method; build log of 2026-11-17) | 291.5 kB | 330.6 kB |
| Integration after the batch 5 merges of the 2026-11-18 run (the later run, not the one above; same method; build log of the element build; the budget is 320 kB since owner decision 32) | 379.7 kB | 400.3 kB |

Update of 2026-11-18: with the batch 5 merges of that day both configurations are over the 320 kB budget (host backend 59.7 kB over, DEP client 80.3 kB over), so `pnpm build` fails at the element package on the size check alone; every other package builds. The row is one measurement; the earlier rows were taken by other integrators. Nobody has measured how much of the growth since 2026-11-17 belongs to which batch. The decision stays with the owner.

So the DEP configuration was already over the budget at `ccd52bb` and is 15.4 kB over now. The host-backend configuration is within it. The growth since `ccd52bb` comes mostly from the engine and the shell: form field views and entries, the field and role editing, fill mode, and the panes' glue (`packages/engine/src/field-entries.ts`, `field-edit.ts`, `role-edit.ts`, `view/form-field-view.ts`).

Batch 6 added 14.8 kB to the host-backend configuration (8.6 kB below the budget now) and 15.1 kB to the DEP one (30.5 kB over). The new code is in the engine and shell: the proofing controller, the extension document API, the image and equation node views and the equation editor glue. Nobody has measured how much each part costs; that would be the first step of option 2.

## Options

1. Raise the budget. The figure is a target, not a requirement, but changing it is the owner's decision.
2. Load the heavy parts on demand: the field and role editing of the engine (used only in the form and roles panes), and the DEP client's schema validation. The engine reaches them through static imports in `core.ts`, so this needs a seam first.
3. Count the DEP client separately, because a host that sets `endpoint` accepts a larger download. This changes what the budget means.

## Decision

None. The gate stays at 300,000 bytes and the build fails until the owner chooses.

Update (2026-11-18, lane w2): the owner chose option 1 in decision 32 (320 kB), and the gate is 320,000 bytes. The size work that followed is in FND-008 Notes.
