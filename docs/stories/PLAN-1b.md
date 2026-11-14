# Phase 1b work plan

**Status:** working plan, 2026-11-06. It splits the 367 stories of phase 1b (`BACKLOG.md`) into packets along the same ownership lines as phase 1a (`PLAN-1a.md`), so that a packet can start as soon as the 1a packet that owns the same directories has finished. 11 §4 gives the goal: the first usable release. A packet lists its stories by epic; a story's own **Depends on** line still decides its order inside the packet.

## Packets

| Packet | Stories | Owns | Waits for |
|---|---|---|---|
| **M Model** | CDM-010, CDM-011, CDM-014, CDM-015, CDM-017 to CDM-023, CDM-025 to CDM-048 of phase 1b (including CDM-040, CDM-045, CDM-046), CDM-052; FRW-001 to FRW-006, FRW-011 (the CDM side of fields) | `packages/model` | the model and authority completion of 1a |
| **R Authority** | SYN-005, SYN-012, SYN-026, SYN-029, SYN-030, SYN-037, SYN-046, SYN-049; PRM-003, PRM-005, PRM-007, PRM-011, PRM-012, PRM-016, PRM-030, PRM-034, PRM-041, PRM-056, PRM-059, PRM-063, PRM-064, PRM-065; FRW-007 to FRW-010; HIS-005, HIS-023; the read-restriction stories that S12 adds to SYN and PRM | `packages/authority` | the 1a completion; M for the field nodes |
| **A Data plane** | SYN-027, SYN-031, SYN-038, SYN-039, SYN-040, SYN-043; PRM-021, PRM-051; PRO-018, PRO-019, PRO-024, PRO-025, PRO-026, PRO-030, PRO-035, PRO-044; BE-014, BE-018, BE-020 to BE-023, BE-027, BE-030, BE-038, BE-039, BE-076 to BE-081, BE-084, BE-086, BE-087; HIS-024 | `services/document-service/src/data-plane/` | 1a packet A1 |
| **C Control plane** | PRO-013, PRO-014, PRO-039, PRO-043, PRO-047, PRO-050, PRO-061, PRO-062, PRO-067; BE-006, BE-016, BE-034, BE-037, BE-047, BE-050 to BE-052, BE-058, BE-079, BE-085; FRW-060, FRW-061; EXP-004 to EXP-008 (jobs and queues) | `services/document-service/src/control-plane/`, `infra/` | 1a packet A2 |
| **S Assets** | BE-042 to BE-045; SEC-037, SEC-038, SEC-040, SEC-046 | `services/asset-worker` (new) | C for the upload resources |
| **K Conformance kit** | PRO-098, PRO-099, PRO-108 to PRO-117; FRW-065 to FRW-067 | `packages/tck` (new) | A and C for a server to run against |
| **B Client** | FE-005, FE-006, FE-008 to FE-012, FE-015, FE-017, FE-019, FE-020, FE-027 to FE-029, FE-034, FE-035, FE-037, FE-040, FE-049 to FE-053, FE-056 to FE-062, FE-065 to FE-067, FE-069, FE-070, FE-073, FE-103 to FE-108, FE-113, FE-116, FE-118, FE-119, FE-123 to FE-126, FE-128 to FE-138, FE-140; SYN-021 to SYN-023, SYN-028, SYN-036; PRO-077, PRO-079, PRO-081, PRO-083 to PRO-086, PRO-089, PRO-090, PRO-095, PRO-096; FRW-069, FRW-070, FRW-080; SEC-007, SEC-009, SEC-054 | `packages/engine`, `packages/element`, `packages/backend-dep` | 1a packet B. Too large for one agent: split into B1 editing (engine), B2 element API and journal (element), B3 backend-dep |
| **U Shell** | UX-002, UX-005, UX-007 to UX-009, UX-013, UX-015, UX-017 to UX-020, UX-022, UX-023, UX-027, UX-039, UX-061, UX-062, UX-068 to UX-070, UX-072, UX-090, UX-095 to UX-097, UX-101, UX-103; PRM-026, PRM-027, PRM-028, PRM-032, PRM-033, PRM-035, PRM-036; FRW-072 to FRW-079 | `packages/ui`, `apps/reference-host` | 1a packets C and E |
| **X Export** | EXP-002, EXP-003, EXP-011 to EXP-033, EXP-038 to EXP-047, EXP-049 to EXP-053, EXP-055, EXP-056, EXP-060 to EXP-062, EXP-064 to EXP-073, EXP-075, EXP-076, EXP-085, EXP-086, EXP-111 to EXP-115, EXP-121; SEC-033 to SEC-036, SEC-053 | `packages/export-latex`, `services/export-worker` | 1a packet D. Split into X1 converter and emitters, X2 house class and typesetting, X3 compile service and sandbox |
| **F Security proofs** | SEC-005, SEC-006, SEC-015, SEC-016, SEC-018, SEC-022, SEC-024, SEC-028, SEC-029, SEC-051, SEC-052, SEC-060; PRM-057 | `tests/security/` | A, C, B |
| **H History tools** | HIS-033 | `packages/history-cli` or a `bin` in `services/document-service` (decide in the story) | A |
| **G Foundations** | FND-009, FND-012, FND-013 | root scripts, CI, `docs/site` (main session) | A for FND-009 |

Shared files stay the main session's: root configuration, CI, `services/document-service/package.json` and `src/server.ts`.

## Read restrictions

ADR 0019 (proposed) and the S12 result apply to every packet: content reads, catch-up, presence, history, search and export go through the requester's projection (rule 8 of `README.md`). The stories S12 changes are listed in its report (`docs/spikes/2026-11-06-s12-read-restrictions.md`) and belong to the packet that owns the directory. The 17 stories S12 added go to these packets (some were handed to the agents already running on 2026-11-06):

| Packet | New stories |
|---|---|
| M Model | CDM-053; FRW-088 (model side) |
| R Authority | PRM-066, PRM-067, SYN-050 to SYN-053; FRW-088 (enforcement) |
| A Data plane | PRO-130 |
| C Control plane | BE-098 |
| K Conformance kit | PRO-131 |
| B Client | FE-141 |
| U Shell | UX-104 |
| X Export | EXP-123 |
| F Security proofs | SEC-064 |
| Phase 2 | HIS-046, FRW-089 |

## Exit check (11 §4)

The 1b exit criteria of 11 §4 hold, with the S3 and S12 property suites passing against the real service.
