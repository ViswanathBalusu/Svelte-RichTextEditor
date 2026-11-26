# Export bundle formats (UX-087, UX-088)

Status: proposed where the owner has not answered (ADR 0433); the layout of ADR 0373 is accepted
(owner decision 175). Names of the formats are working placeholders like every name in this
repository.

A discovery export (a legal request: a document, some documents or the whole tenant, with their
evidence) and a tenant export (everything the tenant owns) share one container. This page is the
documentation that the verifier (`packages/history/src/export-bundle.ts`, `docedit-verify-bundle`)
checks a bundle against. A test fails when a format the verifier knows is missing here.

## Container

- `docedit-bundle/1`: the manifest, `manifest.json`, the first file of every part.
- `docedit-bundle-parts/1`: `parts.json`, beside the parts. It lists each part with its name,
  SHA-256, size, the SHA-256 of its manifest and the number of documents in it.
- A part is a tar archive (POSIX ustar, no compression, paths of at most 100 bytes) named
  `part-0001.tar`, `part-0002.tar` and so on. A tenant export or a large discovery export has
  several; each holds whole documents. The tenant files are in part 1.

The manifest holds `format`, `kind` (`discovery` or `tenant`), `tenant`, `createdAt`, `requestedBy`
(an identifier, not a name), `part` (`index`, `count`), `files` (path, `sha256`, `size`, and
`records` for a line-based file), `counts` of this part (`documents`, `commits`, `threads`,
`comments`, `versions`, `grants`) and `chainHeads` (for each document of the part, the `seq` and
chain head of the exported log).

## Files

| Format | Path | Kind | Holds |
|---|---|---|---|
| `docedit-document-record/1` | `documents/<doc>/document.json` | both | The document's metadata: identifier, external identifier, title, state, classification label, model version, history visibility, properties, creator, creation time, head and fork source. Required members: `id`, `title`, `state`, `classification`, `cdm`, `requires`, `historyVisibility`, `properties`, `createdBy`, `createdAt`, `head`. |
| `docedit-document-content/1` | `documents/<doc>/content.json` | both | The content at the head: `cdm`, `requires` and `doc`. Required members: `cdm`, `requires`, `doc`. |
| `docedit-log-bundle/1` | `documents/<doc>/history.json` | both | The log with its hash chain, in the format `verify-log` reads (HIS-033). Each record has its metadata, payload hash, previous hash and hash. The payloads are not part of this version of the bundle. Required members: `format`, `doc`, `head`, `commits`. |
| `docedit-comments/1` | `documents/<doc>/comments.ndjson` | both | One comment thread a line, with its target (the range or block), state, assignee and comments. Required members: `id`, `scope`, `state`, `target`, `createdBy`, `createdAt`, `comments`. |
| `docedit-versions/1` | `documents/<doc>/versions.ndjson` | both | One stored version a line: `seq`, kind, name, note, creator and time. Required members: `seq`, `kind`, `createdBy`, `createdAt`. |
| `docedit-inclusion/1` | `documents/<doc>/inclusion.json` | both | What the bundle holds and what it does not: the retention policy in force, the legal holds, the thinning that was recorded, whether the history carries payloads, and whether workflow evidence is included. Required members: `format`, `document`, `content`, `history`, `retention`, `holds`, `thinned`, `evidence`. |
| `docedit-evidence/1` | `documents/<doc>/evidence.json` | discovery | The workflow evidence bundle of a finished workflow (FRW-055). Evidence is personal data. Required members: `format`. |
| `docedit-grants/1` | `documents/<doc>/grants.json` | tenant | `revisions`: every permission state of the document, oldest first. Required members: `revisions`. |
| `docedit-assets/1` | `documents/<doc>/assets.ndjson` | tenant | One ready asset a line: identifier, file name, type, SHA-256 and size. Required members: `id`, `mime`, `sha256`, `bytes`. |
| `docedit-asset/1` | `assets/<sha256>` | tenant | The bytes of an asset, named by their SHA-256. |
| `docedit-tenant-settings/1` | `tenant/settings.json` | tenant | The tenant's settings, quotas and retention policy. Required members: `format`, `settings`, `quotas`, `retention`. |
| `docedit-tenant-keys/1` | `tenant/keys.json` | tenant | The tenant's public keys: identifier, use, algorithm, thumbprint, issuer and the public members of the key. Required members: `keys`. |
| `docedit-tenant-origins/1` | `tenant/origins.json` | tenant | The origins the tenant allows. Required members: `origins`. |
| `docedit-tenant-webhooks/1` | `tenant/webhooks.json` | tenant | The webhook subscriptions: identifier, URL, events, number of active secrets and times. Required members: `webhooks`. |

`<doc>` is a document identifier. The verifier checks that each record of a file has the required members (every line of a newline-delimited file) A file with one JSON value is `.json`; a list is
newline-delimited JSON (`.ndjson`).

## What a bundle never holds

Private keys, webhook secrets, API key secrets, tokens, passwords and signed URLs. Each file is
written from a list of the fields it may hold, so a new secret field stays out until someone adds it.
The verifier checks the result: it reports a member named `secret`, `secrets`, `secretHash`,
`privateKey`, `private`, `d`, `p`, `q`, `dp`, `dq`, `qi`, `password`, `token`, `apiKey`, `signedUrl`
or `signedUrls` in a file that holds settings, and a value that starts like a webhook secret
(`whsec_`) or a private key block in any file. Document content, history and comments are checked
for such values only, because their member names are the model's and the writers'.

## Versions

A format name ends in a version. A change that a reader of version 1 could not read gets version 2
and a new row here; the old row stays while a reader of it is supported.

## Checking a bundle offline

    node packages/history/scripts/verify-bundle.ts <directory with parts.json and the parts>

The exit codes are those of `verify-log`: 0 intact, 1 altered, 2 incomplete, 3 unreadable. The
report holds names, hashes and counts, and no document text.
