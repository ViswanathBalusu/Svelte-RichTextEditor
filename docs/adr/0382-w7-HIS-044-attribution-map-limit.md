# ADR 0382: One attribution map per document, with a size limit (HIS-044)

Status: accepted by the owner (decision 83 in `docs/owner-decisions-2026-11-15.md`). Lane w7, 2026-11-17.

## Context

Spec 08 §15 left open how large the attribution map grows on very large documents and whether it should be stored per block. The spike (`packages/history/scripts/attribution-size.ts`, figures in ADR 0118 round 6) measured both forms on the corpus documents of 20, 100, 300 and 1,000 pages. The figures are one run each, with the seeds and the machine named there. They are targets to check on real documents, not product limits.

What the spike found, in short:

- At 1,000 pages with 80 restores the per-document map is about 0.6 MiB serialised (about 0.13 MiB compressed).
- The per-block form has more runs, about 24% more serialised bytes raw, about 69% more compressed and about 60% more memory. Its step time is no better at the 95th percentile.
- The per-block form answers "who wrote this" for one region faster, but the per-document map already answers it in under 0.1 ms.

## Decision

1. **One map per document.** The room keeps one attribution map for the document and saves it with every checkpoint, as 08 §7 says. Per-block storage is not built. It is worth reconsidering only if region lookups become the bottleneck, and the traces do not show that.
2. **The limit is the document size limit.** The serialised map may not be larger than the canonical size limit of a document, 16 MiB (03, invariant I7). A budget of this size is far above the measured 0.6 MiB at 1,000 pages, so it is a guard against runaway growth and not a figure that normal documents come near.
3. **Beyond the limit the oldest detail is merged.** When a map would pass the limit, the oldest runs are merged into coarser runs until it fits. A merged run keeps the user of its most recent run and the `seq` of the newest commit it covers, so a lookup still answers with a person and a commit, but not with every earlier hand. The newest runs are never merged first.
4. **What is built.** This record is the recommendation the spike was asked for. The merge rule of item 3 is not built: no code limits the map today (`AttributionMap` in `packages/history/src/attribution.ts` has no cap), and no test exercises a map over the limit. It needs a story of its own, with a property test that a merged map still answers every position and never names a user who did not write in the merged range.

## Consequences

- 08 §7 gains a sentence on the limit and 08 §15 no longer lists the question as open.
- The checkpoint size budget can be written from item 2. A smaller operational budget stays possible and is for operations to set on the real corpus.
- The figures stay the spike's. This record adds none.
