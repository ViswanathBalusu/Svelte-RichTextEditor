# 0431. UX-078: usage figures and the quota kind of a refusal

Status: proposed (lane w3, 2026-11-26). Owner decisions 69 and 110 are applied. The points below that those decisions do not settle are proposals.

## Applied from the owner's decisions

- Decision 69: usage is read for the calendar month in UTC. `GET /usage?month=YYYY-MM` (defined with UX-076) answers one non-negative whole number for each quota dimension and no identifier of a document or a user.
- Decision 110: every quota refusal names the kind. `quota` (`connections`, `openDocuments`, `commitRate`, `roomCpuBudget`, `storage`, `exportConcurrency`, `exportMinutes`) is a new optional member of the socket `error`, of `sync.reject` and of the REST problem (`QuotaKind` in `packages/protocol/src/definition/common.ts`, 05 §5.3, §5.8). The service sets it in every place it answers `quota_exceeded` or a spent room CPU budget. The element passes it from the port error (`details.quota`, or `quota` of a `SyncRejectError`) to the failure view, which names the quota in the message.

## Proposed

1. The peaks are recorded in the memory of the node that decides (`UsagePeaks`, fed by `LiveQuotas` and by the storage and export routes). They cover that node only and start again at a restart. A durable, cluster-wide usage record needs a table and a write path (a migration and a decision on how often nodes flush) that are not built here. The compile minutes are read from the job queue, so they hold for every node.
2. Storage for the current month is the bytes stored now; for an earlier month it is the last level the node recorded in that month, or 0.
3. A month with no recorded figure reads as 0. A month in the future is accepted and reads as 0.
4. Compile minutes are rounded up to a whole number.
5. The editor names the quota when a load is refused (a connection or an open-documents refusal, and any refusal that arrives as the failure of a load). A commit refused for the commit rate or the CPU budget is retried by the engine after `retryAfterMs`, and no message is shown for it yet: that needs a status in the engine and a surface in the editor, which is not built.
