# ADR 0425: How a font records that a job may load it on the server (EXP-048)

Status: proposed. Lane w2, 2026-11-26. The rule that the administrator sets a flag on upload is owner decision 62; the name and the meaning of an absent flag are this ADR's reading and need the owner's word.

## Context

09 §5 says the licence of a font "must permit server-side use" and does not say how that is recorded. Owner decision 62 (`docs/owner-decisions-2026-11-15.md`): the flag is set by the administrator on upload, and a font without it is used on screen only and substituted in the PDF. The manifest's `licence` is free text, so the converter cannot read a policy from it.

## Proposed

1. **Where the flag is.** `serverUse` on a family of the font manifest (`FontFamily` in `packages/export-latex/src/bundle.ts`), a boolean.
2. **Who sets it.** The service, when it builds a job's manifest: for a tenant's own font, `true` when the administrator set the flag on upload and `false` when not. BE-048 (tenant fonts) builds that; it does not exist yet.
3. **An absent flag means permitted.** The default set carries no flag, because BE-047 admits a font to it only when its licence permits bundling and server use. A tenant font must therefore always carry an explicit `serverUse`; a service that leaves it out for a tenant font would make the font loadable. This is the point to confirm with the owner.
4. **What a job does with `serverUse: false`.** The converter drops the family from the manifest it uses (`serverFonts` in `server-fonts.ts`): no entry in `styles.tex` or in the bundle's font list, paragraphs that name it take the default family and the fallback chain, and one warning, `font_server_use_not_permitted`, names the family when the document uses it. The worker's file check leaves its files out (`manifestFaces`). The editor's own manifest (`GET /fonts`) still lists the family, so it shows on screen.

## Not decided here

- Whether a document that uses a screen-only family should fail a final export instead of warning. The decision says "substituted in the PDF", so this ADR warns.
- The tenant-scoped font store and manifest (BE-048), and the job's check that a font hash belongs to the job's tenant (EXP-048 criteria 1 and 2).
