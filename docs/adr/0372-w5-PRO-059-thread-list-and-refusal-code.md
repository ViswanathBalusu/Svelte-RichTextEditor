# 0372 Thread list at a seq, and the REST code of a refused thread (PRO-059)

Status: proposed (lane w5, 2026-11-17). For the owner to confirm.

## Context

PRO-059 criterion 3 says a range that lies, after mapping, in a scope where the caller has no
`comment` is refused "with `permission_denied`". The error registry lists `permission_denied` for the
`sync` surface only (05 §5.8; `ERRORS` in `packages/protocol/src/definition/errors.ts`), and a REST
refusal of a permission is `forbidden` (403). `checkProblem` flags `permission_denied` on REST. The
thread routes already map the authority's `permission_denied` to `forbidden`.

Criterion 4 says `GET /documents/{id}/threads?seq` reports ranges "for that `seq`". 05 §6.2 says only
"`?seq` maps ranges to that seq" and gives the `Thread` the shape `RangeTarget` with `baseSeq`.

## Decisions proposed

1. **REST answers `forbidden`.** The criterion is read as "refused with the registry's code for a
   refused permission on that surface". Nothing in the code or the registry changes. If the owner
   wants the literal `permission_denied` on REST, the registry entry and the OpenAPI document must
   change first. Criterion 3 stays unticked until the owner decides.
2. **A range target is returned with the seq it refers to.** `RangeTarget.baseSeq` in a `Thread` is
   the seq of the range: the seq the thread was made at for `GET /threads/{tid}` and the thread
   routes that answer with a thread, and `seq` for the list.
3. **The list maps forward only.** A range is mapped from the seq it was made at to `seq` through the
   stored commits (`mapRangesThrough`). A thread made after `seq` did not exist at it and is left
   out. The authority has no inverse mapping, so a range is never moved backwards.
4. **A range whose text was deleted by `seq` is returned empty** (`from` equals `to`); the client
   shows it as detached (ADR 0015). The list does not drop it.
5. **Paging.** The list is paged like the commit list: `limit` (1 to 200, default 50), `cursor`
   from `nextCursor`, in thread-identifier order (UUID version 7: creation order). A page is cut
   before threads in hidden regions are removed, so a page can hold fewer than `limit` items while
   `nextCursor` is set. G71 (the paging of threads) is not closed by this.
6. **The rebase window is in sequence numbers.** `baseSeq` must be at most `maxRebaseSteps`
   below the head, counted as a difference of seq, not of steps. The window is a service setting
   (`DOCEDIT_MAX_REBASE_STEPS`, default the protocol limit) that the REST check and the data plane
   share.
