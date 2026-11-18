# 0383. The DOCX importer stays on its own reader (EXP-097)

Status: proposed. The owner has not decided it.

## Context

EXP-097 asked for a time-boxed comparison of existing DOCX parsers before the importer is built on one. The importer of `packages/export-docx` already exists (EXP-098 to EXP-110), so the comparison also tests whether it should be replaced. The report is `docs/spikes/2026-11-17-exp-097-docx-parser.md`, with its method, raw results and scripts in `docs/spikes/exp-097/`.

## Decision (proposed)

1. **Build.** Keep the importer and its own XML reader (`src/xml.ts`). Neither adopt nor fork a parser.
2. mammoth is not used. It writes lossy HTML, has no form for tracked changes, and its 1.10.0 read a local file named by a linked picture (CVE-2025-11849, reproduced in the report; 1.13.0 does not).
3. The Open XML SDK is not a dependency of the product. It is the best reader on structure, but it is a second runtime, it has no source positions (A2 needs them), and a 20,000-level nest ended its process with an uncatchable stack overflow.
4. A run of docx4j and Apache POI is not done. If the owner wants the comparison complete, it needs Maven (or an agreed way to fetch their jars) on the machine that runs it.

## Open for the owner

- Whether the Open XML SDK is added as a test-only second reader (as `@rgrove/parse-xml` is for the XML layer in `packages/export-docx/test/parser-eval.test.ts`).
- Whether the missing run of docx4j and POI is worth the cost.

## Consequences

- No change to the code or the dependencies.
- The importer keeps the threat model of EXP-099 and EXP-110: bounded depth, ratio limits, no network. The report's hostile table is a record of how four readers behave on the same eight files, not a test the importer must keep passing; the importer's own tests are EXP-110's.
