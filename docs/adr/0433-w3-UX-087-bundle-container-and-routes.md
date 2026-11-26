# ADR 0433: container, routes and limits of the export bundles (UX-087, UX-088)

Status: proposed (2026-11-26, lane w3). It answers the open points of ADR 0373 section 6. ADR 0373
itself is accepted (owner decision 175: "ADR 0373 accepted, with its new DEP operation"). The owner
did not answer the six points below one by one; each takes the choice that needs no new
dependency and no figure that was not measured. The owner can change any of them.

## 1. The archive container (0373 point 1)

A part is a tar archive (POSIX ustar, no compression), named `part-0001.tar` and so on, with
`parts.json` beside the parts. The writer and the reader are 100 lines in
`packages/history/src/export-bundle.ts`, so no zip or tar library is added. Any tool opens a tar
file. Paths are at most 100 bytes, which the layout keeps (the longest is 71 bytes for an asset and
about 70 for a document file). Compression is left to the object store or the download; a part
that is compressed is a different file and `parts.json` would hash that one.

## 2. The routes (0373 point 2)

DEP 1 gains two operations, both for a service credential, in `05 §6.2` and in the service row of
the matrix of 07 §12:

- `POST /bundle-exports` (`createBundleExport`): body `{ kind: "discovery" | "tenant", documents?,
  maxDocumentsPerPart? }`. It answers 202 with the job, takes `Idempotency-Key`, and audits the
  request before the job is queued: `export.discovery.requested` or `export.tenant.requested`, with
  the number of documents (or `all`) and the part size. A discovery export names one or more
  documents, or none for the whole tenant. A tenant export names none. A named document that is not
  the tenant's own is `not_found`, so another tenant's identifier is not confirmed.
- `GET /bundle-exports/{bid}` (`getBundleExport`): state, progress, and when finished the parts and
  `parts.json` with hash, size and a short-lived signed URL (the same signing as export results).

The names `/bundle-exports` and `bid` are proposals. `/exports` is the document export job of
PRO-086, which is a different resource.

## 3. What the history file carries

`history.json` is the log bundle of HIS-033 as `chainRange` of the log store returns it: each record
with its metadata, payload hash, previous hash and hash, and no payloads. The content at the head
is in `content.json`. So the verifier checks the chain and the head, but cannot check a payload
against its hash, because none is carried. This is a limit of this version, stated in each
`inclusion.json` (`history.payloads: "hash-only"`). Carrying the payloads that were not thinned is a
later version of the history format (`docedit-log-bundle/2` or an addition to this one), and needs
the decision of what a payload of a hidden region may show. It is not decided here.

## 4. Who may ask, and personal data (0373 point 3)

Both operations need the service credential, as the other administration routes do: the
administrator is the host's backend acting for a tenant administrator. Evidence is only in the
discovery export, and only for a workflow that is `completed` or `finalised` (the same rule as
`GET /documents/{id}/workflow/evidence`). No second approval is added. A host that wants one asks
its administrator before it calls. The request is audited; the retrieval of the bundle files is not
audited separately.

## 5. Part size (0373 point 4)

One part holds at most `maxDocumentsPerPart` whole documents: 25 when the request names none, at
most 500. Both figures are settings of this build for the memory one part needs, not figures of the
spec, and nothing was measured. A document is never split, so a part is as large as its documents.
A measurement on a reference machine would set the default.

## 6. The verifier (0373 point 5)

A second command, `docedit-verify-bundle` (`packages/history/scripts/verify-bundle.ts`), beside
`docedit-verify-log`, with the same exit codes. It reads a directory with `parts.json` and the
parts, and each `history.json` is verified by the same `verifyBundle` that `verify-log` uses. A
bundle is one directory of several files, which `verify-log` (one JSON file in, one report out) does
not take.

## 7. Other choices

- Which documents a tenant export covers: those that are not deleted. A purged or deleted document
  is not in the bundle, and `inclusion.json` does not list it.
- Grants and assets are in the tenant export only. The discovery export carries the evidence.
- Secrets: each file is written from a list of fields (`documentRecord`, `publicJwk`,
  `WebhookSubscriptions.viewsOf`), and `verifyExportBundle` rejects a secret member or value. The
  list of names is in `SECRET_MEMBERS`.
- The bulk send is not asked for a bundle and a bundle is not asked of the policy hook of UX-086:
  an export bundle is not an export of one document to a target. Whether it should be is open.
- No size limit of a whole bundle, no retention of the parts beyond the object store's, and no
  cancel route. The job can be cancelled through the queue by an operator; the route is not
  defined.
- Formats are documented in `docs/export-bundle-formats.md`, one row for each format with its
  version. A machine-readable schema for each file, generated into `spec/`, is not built: the
  verifier checks the shape that matters (the members it reads), not every member.
