# ADR 0373: the format of the discovery and tenant export bundles (UX-087, UX-088)

Status: proposed (2026-11-17, lane w3). Nothing here is built. The owner decides whether it stands.

## 1. Why this record exists

UX-087 (discovery export) and UX-088 (tenant export) both produce a bundle, and neither the spec
(13 section 10, 08 section 12) nor the stories say what is in it or how it is laid out. Both stories
say their format is open. Writing code before the format is agreed would fix the format by accident,
so this record proposes one shape for both. It reuses what exists: the log bundle of HIS-033
(`BUNDLE_FORMAT`, `docedit-log-bundle/1` in `packages/history/src/chain.ts`) and the command-line
verifier that reads it.

## 2. One container for both

A bundle is a set of files and one `manifest.json`. The manifest has:

- `format`: `docedit-bundle/1`, and `kind`: `discovery` or `tenant`.
- `tenant`, `createdAt`, and the identity that asked (an identifier, not a name).
- `part`: `{ index, count }`. A bundle that is produced in parts (UX-087 criterion 5) carries one
  manifest per part and a `parts.json` index with the SHA-256 and size of each part's manifest.
- `files`: one entry per file with `path`, `sha256`, `size`, and `records` for a line-based file.
- `counts`: how many documents, commits, comments, versions and grants the bundle holds, so that a
  reader can compare them with the stored data (UX-088 criterion 3).
- `chainHeads`: for each document, `{ seq, chainHead }` of the exported state (HIS-034 criterion 4).
- `inclusion`: what is included and what is not (section 3).

Files are JSON, or newline-delimited JSON for lists. How the files are packed for download (a zip,
a tar, or a folder in object storage) is an owner choice (section 6). The manifest does not depend on it.

## 3. Discovery bundle (UX-087)

Per document: `documents/<id>/content.json` (the CDM at the head), `documents/<id>/history.json` (a
`docedit-log-bundle/1`, so the existing verifier checks the chain and the stored payload hashes),
`documents/<id>/comments.ndjson` (threads with their ranges and the commits that made them), and
`documents/<id>/evidence/` (workflow evidence from `src/workflow/evidence-store.ts`).

`inclusion.json` states, per document: the retention policy and the legal holds in force when the
bundle was built, the commits whose payloads were thinned or moved and are therefore carried by
hash only, and anything left out with the reason (for example a document that is purged). A hold
keeps content in the bundle that retention would otherwise have thinned; the statement says which.

A tenant-wide discovery export is the same layout over every document the request covers, in parts.

## 4. Tenant bundle (UX-088)

The discovery layout (without the evidence rule of section 5) plus `grants.ndjson`, `versions.ndjson`,
`settings.json`, `keys.json` (public keys only), `origins.json` and `webhooks.json`.

Secrets are excluded by construction: the writer takes an allow-list of fields per file, so a new
secret field is left out until it is added. Excluded: private keys, webhook secrets, API key values
and signed URLs. A test lists the stored secret fields and fails if one appears in a bundle.
Every file has a documented schema, versioned with `format`, in `docs/` and generated into `spec/`.

## 5. Who may ask, and the audit

Both exports need a tenant administrator (a service credential with that role, or a user the host
maps to it). Evidence is personal data, so the discovery export of evidence needs the administrator
role and is audited. The kinds are proposed as `export.discovery.requested` and
`export.tenant.requested`, each with the document or tenant, the requester and the bundle's manifest
hash. The job runs on the existing job queue with progress, and each part is stored in object storage
under the tenant's prefix, so another tenant's data cannot be written into it.

## 6. Open points for the owner

1. The archive container for download (zip, tar or folder).
2. The routes. DEP 1 has no operation for either export, so each is a protocol addition (05 section 6).
3. Whether evidence that is personal data is included for every administrator or needs a second approval.
4. The size at which a bundle is split into parts. No figure is proposed here; it needs a measurement.
5. Whether the verifier ships as the same command as `scripts/verify-log.ts` or as a second command.

## 7. What this record does not do

It builds nothing and ticks nothing. UX-087 and UX-088 stay open until the owner accepts or changes
the shape and the work is done, with tests that run a real job and the offline verifier.
