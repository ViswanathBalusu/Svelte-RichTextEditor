# ADR 0481: The CJK reference document needs more than 1.5 GiB to compile

**Status:** proposed. Nothing here is decided. The spec default (1.5 GiB per job, 09 §9.3 item 4) stays in force for production until the owner decides.

**Context.** Since the Noto CJK face is in the worker image (owner decision 228, EXP-037), the corpus document `pages-20` compiles instead of failing on a missing glyph. On the integration branch (batch 7, 2026-11-27) it is killed with exit 137 after about 10 seconds in pass 1 under the spec limit of 1.5 GiB (`LIMITS.memoryMiB` = 1536 in `services/export-worker/src/sandbox.ts`). The Podman machine route now enforces the memory limit; earlier lanes ran where it was not applied, which is why lane w2 saw the document compile.

**Measurement.** `pages-20` compiled with `ua-2+a-4f` and tagging on, image `docedit-export-worker:w2`, Podman 6.0.2 machine route, Windows 11, 2026-11-27, one run per limit: 1536 MiB exits 137 (twice); 2048 MiB and 3072 MiB compile in three passes (about 14 s each) and validate. The exact peak was not measured; it lies between 1.5 and 2 GiB.

**Question.** Which of these is right?

- (a) Raise the job limit for documents that use the CJK face (the capacity sheet plans one core and 1.5 GiB per job, so this changes the plan).
- (b) Reduce the memory of the CJK face in LuaTeX (a subset of the face per job, or a lighter fallback chain).
- (c) Keep 1.5 GiB and reject such documents with a clear error.

**Spec default:** (c), the limit as written. No production limit was changed.

**What the integrator did.** `exp-016-v-exp-001-016.corpus.e2e.test.ts` runs `pages-20` with a sandbox limit of 2048 MiB (a constant with a comment pointing here), so that the PDF validation gate tests what it is meant to test. The other corpus documents run at the spec limit. When the owner decides, remove the constant or change the spec.
