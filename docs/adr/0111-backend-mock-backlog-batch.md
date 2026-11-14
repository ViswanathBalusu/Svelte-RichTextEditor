# ADR 0111: backend-mock backlog batch (PRO-099 and the mock side of PRO-098)

**Status:** proposed. **Date:** 2026-11-13. **Lane:** backend-mock, round 1.

## Context

The lane was asked to take three to five stories whose remaining criteria can be met in `packages/backend-mock`. Findings after reading the stories, the package and its tests:

- PRO-099 (in-memory mock backend): criteria 2 and 4 are ticked. Criteria 1 and 3 need the element and the shell. Their backend half is already tested in `packages/backend-mock/test/offline.test.ts` (no `fetch`, `WebSocket`, `XMLHttpRequest` or `EventSource` call on connect, load, open and submit; no `presence` port and no `presence` feature when the service does not offer them). Nothing is left to tick in this package.
- PRO-098 (one contract suite for every backend): criterion 2 needs `backend-dep` and `backend-local` as well as the mock. The mock's part runs in `packages/backend-mock/test/contract.test.ts` and in `packages/tck`. Stays open.
- PRO-090 and PRO-092: the open criteria are the element's (`destroy()`, feature-driven controls) and the contract member coverage of PRO-098. Not in this package.
- PRO-100 (local IndexedDB backend, phase 4) needs a new package (`backend-local`) with browser storage, outside this directory. Not taken.
- PRO-025, PRO-026, PRO-028, PRO-031, PRO-032, PRO-049 and PRO-050: the open criteria are data-plane, server or client behaviour (`services/document-service`, `packages/protocol` client, the element). Testing them through the mock would test the authority's `Room`, not the server the story names. Not taken, to avoid hollow ticks.

## Verification (2026-11-13)

- `pnpm vitest run packages/backend-mock`: 3 files, 52 tests passed, 12 skipped (the presence cases of the contract suite run against a mock without `presence`, and are skipped with the reason).
- `tsc --noEmit` for `packages/backend-mock/tsconfig.json` and `tsconfig.test.json`: no errors.
- No Podman, PostgreSQL or browser run was needed or performed.

## Decisions

No code or story criterion changed in this round. No decision was taken on a spec question.

## Open questions left to the owner or the main session

1. The mock backend does not announce `fields` (its `service.ts` comment and `offline.test.ts` cite FRW-065), but the FRW-065 story asks that "the mock backend implements the `fields` port and announces `fields` from phase 1b". The two readings conflict. The owner decides, or the FRW lane follows the phase decision recorded in FRW-065's own open question. Until then the mock stays as it is.
2. The mock backend's phase (05 §8.3 says "from the first phase", 11 says 1b) is already open in PRO-protocol.md, open question 26. Not decided here.
3. Whether `backend-local` (PRO-100) should share the authority code path with this package or go through its own `Room` instance: a question for the phase 4 lane.
