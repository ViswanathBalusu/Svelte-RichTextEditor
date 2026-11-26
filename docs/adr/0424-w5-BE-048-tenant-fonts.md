# ADR 0424: Fonts a tenant adds, as built (BE-048)

Status: proposed (lane w5, 2026-11-25). Owner decisions of `docs/owner-decisions-2026-11-15.md` settle
three points: 94 (TrueType, OpenType and WOFF2, each checked in the sandbox; collections and other
formats are refused), 95 (`GET /fonts` is tenant-wide for every user of the tenant) and 62 (the
administrator sets a server-use flag on upload; a font without it is used on screen only and
substituted in the PDF). The points below are what BE-048 built on top of them and are not decided by
the owner.

## Context

`GET /fonts` served one shared catalogue read from a directory at start (BE-047). The asset worker
accepted images and Word files only. The administration contract (UX-076) listed fonts without a
route to add one. The notes of BE-048 named four missing things: a font type in the sandbox, a path for
an upload that belongs to a tenant and not to a document, an administration route, and a per-tenant
manifest.

## Decisions (proposed)

1. **A font is checked by the asset worker's sandbox with the purpose `font`.** The request frame
   carries `purpose: "font"`. The sandbox reads the table directory, the tables a usable font has,
   `head`, `maxp`, `name` and `OS/2`, and answers with the family, style, weight, glyph count, units
   per em and `fsType`. The stored file is the upload, not a re-encoded copy. The supervisor reads the
   answer as hostile input (`checkFontFile`). The code is `services/asset-worker/src/sandbox/font.ts`;
   it uses `node:zlib` (Brotli, for WOFF2) and nothing else.
2. **Limits (settings with defaults, none measured).** `fontMaxBytes` 8 MiB, `fontMaxTables` 64,
   `fontMaxExpandedBytes` 32 MiB (the size of a WOFF2 file after expansion; the Brotli stream is
   expanded with `maxOutputLength` set to the size the table directory states). They follow the shape
   of the limits of ADR 0043 and are listed in the package README.
3. **Embedding flag.** A font whose `OS/2` `fsType` has bit 1 set (restricted licence embedding) is
   refused, because the PDF embeds the font. The other flags (preview and print, editable, bitmap
   only, no subsetting) are accepted; the licence declaration of the administrator is what states
   whether the licence allows server use (decision 62). `OpenType` files with TrueType outlines may be
   declared `font/otf`; a CFF font declared `font/ttf` is a type mismatch.
4. **Upload path.** `POST /tenant-fonts` takes the file as base64 in a JSON body (the contract has no
   binary bodies), with `mime`, `licence` (1 to 200 characters, free text) and `serverUse`. It is for
   the service credential. The body limit is the one of the content routes. The sandbox runs inside the
   request, not as a queued job: the check is bounded by the limits above, and an administrator gets
   the answer at once. A server without a sandbox refuses to add (`unavailable`).
5. **Storage.** The bytes go to `tenants/{tenant}/fonts/{sha256}` (written once; the same bytes again
   are the same object). The row is in `tenant_fonts` (migration 0099): hash, family, style, weight,
   format, size, licence, server-use flag, who and when. A tenant has a hash once and a family and
   style once (a second file for a face is `conflict`; the administrator removes the first). A family
   that the shared catalogue serves cannot be added by a tenant, so no tenant shadows a shared font.
6. **Manifest.** `GET /fonts` returns the shared families, then the tenant's own families (role
   `text`, `tenant: true`, `serverUse`), each face with its `licence` and `serverUse`. The version is
   computed as before and includes the tenant fields, so adding, removing or changing the flag changes
   the ETag. The answer is `private, no-cache` when the service keeps tenant fonts. A tenant without
   fonts gets the shared manifest unchanged.
7. **Reading a file.** `GET /tenant-fonts/{sha256}` answers `{ sha256, mime, content }` (base64) to any
   user or service of the tenant; another tenant gets `not_found` for the same hash. The files are not
   served from the public `/fonts/` route, because a licensed font must not be readable by anyone who
   learns its hash. The editor fetches it with its token and loads it from memory (`FontFace` with an
   `ArrayBuffer`). This costs the browser's own cache for the file; the answer is `immutable` and
   private, so the HTTP cache keeps it per user.
8. **Export jobs.** `TenantFontService.jobFonts(tenant, shared)` gives the manifest and a reader that
   answer for that tenant's faces only, and only for those whose declaration allows server use.
   Mounting the files in the job's container and using them in the converter is EXP-048.
9. **Removal.** `DELETE /tenant-fonts/{sha256}` removes the row and the object, audited (`font.removed`).
   An export of a document that uses the family afterwards falls back to the fallback chain with a
   warning (EXP-048 criterion 4).
10. **Audit.** `font.added` and `font.removed` carry the hash, family, style, licence declaration and
    flag, never the bytes.
11. **WOFF2 in exports.** The converter's engines read TrueType and OpenType. A WOFF2 face is for the
    screen; whether the worker converts it for the PDF is EXP-048's to decide. The manifest states the
    format of each face so that the loader can tell.

## Not decided here

- Who may administer fonts beyond the service credential (a tenant administrator role in the console,
  UX-089).
- A quota on the number or total size of a tenant's fonts (06 §12 gives no dimension for it).
- Whether a family may mix faces with different licence declarations. The manifest records the licence
  of each face; the family shows the first one and `serverUse` is true only when every face allows it.
