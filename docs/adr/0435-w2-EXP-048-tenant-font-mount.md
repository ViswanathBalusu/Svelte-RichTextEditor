# ADR 0435: How a tenant's font reaches its export jobs (EXP-048)

Status: proposed. Lane w2, 2026-11-26. Builds on ADR 0424 (BE-048, what a tenant adds) and ADR 0425 (the server-use flag). Owner decisions 62, 94 and 95 answer the flag, the formats and the list; the rest below is this lane's reading and needs the owner's word.

## Context

BE-048 stores a tenant's font under `tenants/{tenant}/fonts/{sha256}` with a row in `tenant_fonts`. The export worker's image holds the shared fonts, read-only, under `DOCEDIT_FONT_PATH`. EXP-048 asks that a tenant's font is mounted and used in that tenant's jobs and in no other tenant's.

## Proposed

1. **The worker asks for its own tenant.** `createExportHandler` takes an optional `tenantFonts` source (`services/export-worker/src/tenant-fonts.ts`). The job calls it with `job.tenant`, never with a tenant from the payload. In `main.ts` the source reads the tenant's rows through `PgTenantFontStore` (row-level security) and the file from the tenant's own object prefix, so a hash held by another tenant is not found.
2. **The files travel with the job.** The worker puts the files of the faces it uses into the job's tar as `tenant-fonts/<sha256>.<ttf|otf>`. Nothing is mounted from the host and the image is not changed. The sandbox already starts from a tar of the job's files.
3. **The class reads them there.** `docedit.fontpath_of(file)` (`class/docedit.lua`) gives `tenant-fonts/` when that file exists in the job directory and the image's font directory otherwise. The font directory still comes from the worker's environment. A file is named by its hash, so a bundle that names a hash the worker did not supply fails to load the font, as before.
4. **What is left out, each with a `tenant_font_unavailable` warning that names the family:** a family with a face whose declaration does not permit server use (decision 62), a WOFF2 face (decision 94: not loaded on the server; the family's other faces are used), a family whose file is missing or whose bytes do not match the hash of its row, a family with no readable regular face, and a family whose name a shared family already has (no shadowing, ADR 0424).
5. **Styles a tenant did not add.** A missing bold, italic or bold italic face takes the nearest face the tenant has (regular for bold and italic; bold, then italic, then regular for bold italic), as a screen does. Proposed; the owner may prefer a warning.
6. **Line height.** The family's `lineHeight` is read from the regular face (`(usWinAscent + usWinDescent) / unitsPerEm`, as `image/fonts.lua` does for the shared set). A face whose tables cannot be read leaves the family out. No default is invented.
7. **Coverage.** The worker records each face's `fontCoverage`, so the converter's glyph check (EXP-026) applies to a tenant family as it does to a shared one.
8. **Server-use flag and manifest.** The worker leaves a screen-only family out of the manifest (item 4) instead of listing it with `serverUse: false` as ADR 0425 item 4 describes, because listing it needs a line height and the face data of a font that is not to be read on the server. A document that uses it then gets the converter's `font_family_missing` warning as well.

## Not decided here

- Whether the shared set's warm font caches matter for a tenant font: luaotfload builds the cache of a tenant font in the job's writable directory on every job, which costs time on the first use in each job. Not measured.
- Whether WOFF2 should be converted by the worker (decision 94 says not loaded).
- Whether the sandbox should refuse a `tenant-fonts/` file that is not a font; the file was validated when the tenant added it (BE-048), and the worker checks its hash against the row.
