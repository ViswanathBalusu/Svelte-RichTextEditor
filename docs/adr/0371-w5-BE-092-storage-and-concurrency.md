# 0371 Storage and export-concurrency quotas (BE-092)

Status: proposed (lane w5, 2026-11-17). For the owner to confirm.

## Context

BE-092 asks for a storage quota on uploads and imports, and an export concurrency limit whose
behaviour (queue or `quota_exceeded`) is "the one recorded in the Open questions decision". ADR 0246
decision 1 proposed `quota_exceeded`, following 06 §12. The owner's answers of 2026-11-15 do not
mention it, so it is still a proposal.

## Decisions proposed

1. **Export concurrency is refused, not queued.** A tenant with `exportConcurrency` set, and with
   that many exports (kind `export`, state queued or running) already, gets 429 `quota_exceeded`
   when it asks for another. Previews are not counted. A request answered from an earlier result
   (EXP-006) creates no running job and is not refused. The check and the enqueue are not one
   transaction, so two requests that arrive together can both pass; the quota is a ceiling that
   concurrent requests may exceed by the number of requests in flight.
2. **Storage counts what the tenant's assets hold.** A ready asset counts its stored size, an
   upload still being processed counts its declared size, a failed asset counts nothing. An upload
   is refused when its declared size added to what is held passes `storage`. Renditions, exports,
   checkpoints and log bytes are not counted: BE-085 has no stored-bytes counter of those kinds
   yet. A `storage` of 0 refuses every upload.
3. **`Retry-After` is 1 second** for the storage and concurrency refusals, the same delay as the
   count quotas of the live-use gate. No clock ends these two quotas; the figure only satisfies the
   rule that a `quota_exceeded` answer on REST carries the header (05 §5.8). It is a setting of this
   lane, not a spec figure.
4. **The values come from the node's quota source** (ADR 0370), loaded before the check.

## Not decided here

- Whether an import counts against storage: no import route exists (PRO-066), so that half of
  criterion 1 is not built.
- The usage figures of criterion 5: no usage route exists in the administration API (UX-076).
