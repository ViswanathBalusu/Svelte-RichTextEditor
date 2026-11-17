# PRO Protocol DEP/1, embedding API, backend ports, authority service and conformance kit

**Scope.** The Document Editing Protocol (DEP) is the only contract between `<doc-editor>` and a backend ([ADR 0008](../adr/0008-protocol-planes-and-encoding.md), [05](../spec/05-protocol.md)). This epic covers versioning, discovery, authentication (user tokens, service credentials, revocation), real-time framing and every message family of 05 §5 (session, channels, sync, presence, permissions, notifications, close codes, error registry), the control-plane conventions and resources, the events plane (webhook contract and signatures), the embedding API of 05 §8 (attributes, properties, methods, events), the backend ports and the three backends that ship with the component (`backend-dep`, `backend-mock`, `backend-local`), the backend tiers of §9, the authority service interface of §10, the conformance kit `tck` of §11, and the machine-readable artifacts (AsyncAPI, OpenAPI, JSON Schema) that are generated, published and checked against the prose.

**Sources.** docs/spec/05-protocol.md (all); [ADR 0008](../adr/0008-protocol-planes-and-encoding.md) and [ADR 0001](../adr/0001-server-authoritative-sync.md); pitfall review section 3.4 (findings PR-1 to PR-16) and section 6; phases from [11 Roadmap](../spec/11-roadmap.md), [12](../spec/12-fields-rules-workflow.md) §13 and [13](../spec/13-experience-extensibility.md) §12.

**How to read the criteria.** Criteria about server behaviour are written at the wire. A story about a server message or resource is done for the reference service when the matching `tck` scenario passes against it, and for any other server in the same way; the implementation itself (gateway, rooms, control API, storage, webhook dispatcher) is BE's. Numbers are targets: the limits and timers named in 04 and 05 are repeated where a message carries them.

**Phases.** The machine-readable artifacts and the port typings are phase 0 deliverables (05 §8.3, §11). 11 places the schemas, port contract tests, mock backend and the `core` and `perm-region` scenarios in 1b; history, review, webhooks, session revocation, leases and region states in phase 2; and the authority service, local backend and published kit in phase 4. It lists no protocol deliverable for 1a, but the 1a demo (two tabs with different grants, a live grant change, the commit log, a PDF panel, token minting, presence) cannot run without a working subset, so that subset is placed in 1a. Where 11, 12 §13 and 13 §12 do not place a story, its Notes say "phase inferred".

**Left to other epics (README §2.3).** The algorithms behind sync messages (rebase, acknowledgement, resume, journal, range mapping) are SYN's. The permission outcome check, roles, grants, leases and region states are PRM's. Fields, rules and workflow messages, resources, webhooks and embedding members (12 §10) are FRW's. The element's internal lifecycle, shadow root, recovery journal and views are FE's. The shell, command registry, host integration guide, reference host and governance and administration interfaces (including `GET /audit` and `GET /search`) are UX's. The webhook dispatcher and the deployment of the authority service are BE's. Spike S6 is SPK's: the phase 0 stories below are the production work that generates, publishes and checks what S6 proves can be done.

## Machine-readable artifacts and the shared package

### PRO-001 Publish an AsyncAPI definition of the real-time plane

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 0 | M | must | Maintainer |

**Spec:** 05 §4, §5, §11; ADR 0008 · **Requirements:** R6 · **Depends on:** SPK-019

As a maintainer, I want the real-time plane described in an AsyncAPI document in `spec/`, so that an implementer in any language can generate types and tests without relying on the prose alone.

**Acceptance criteria**

- [x] Given the repository, when the AsyncAPI document is built, then it declares the subprotocol `dep.v1`, the envelope fields `t`, `id`, `re`, `ch` and `d`, and one message definition for every message type in 05 §5.1 to §5.6 (including `chunk`, `error`, `perm.changed` and `event`), each with its direction.
- [x] Given any message definition, when its payload schema is read, then every field the prose names is present with its type and whether it is required, and the schema allows unknown fields (05 §1 rule 3).
- [x] Given the same sources, when the document is built twice, then the output is byte-identical and carries the protocol version `1.0`.
- [x] Given a message that another epic adds (for example `wf.changed` from 12 §10), when it is registered, then it appears in the same document without a change to the envelope.
- [x] Given the document, when PRO-117 runs, then every message type, close code and error code in the prose tables is present in the document and vice versa.

**Evidence:** `spec/dep/dep-1.asyncapi.json`, generated from `packages/protocol/src/definition/messages.ts` and `common.ts` by `packages/protocol/src/generate/asyncapi.ts`. `packages/protocol/test/schemas.test.ts` (structure, subprotocol, one message per type with direction and envelope members, references resolve, draft-07 compile; minimal and maximal examples of every payload pass Ajv and the codec, unknown members pass, each missing required member fails); `artifacts.test.ts` (byte-equal to a fresh generation, twice, version `1.0`); `definition.test.ts` (an extension registers a message and the `Envelope` schema is unchanged; `wf.changed` comes from `packages/protocol/src/definition/frw.ts`); `prose.test.ts` (reads the tables of 05 §5.1 to §5.8 and 12 §10 and compares both ways: the artifact half of PRO-117, first version).

**Notes:** Production counterpart of one S6 deliverable (11 §2). Phase 0 because 05 §11 says the definitions are generated in phase 0. Requiredness the prose leaves open follows the decisions of the [S6 report](../spikes/2026-11-06-s6-protocol.md) §5 (for example D06 for `error.retryAfterMs`, D08 for `inflight`), each marked in the artifact with its gap. The scenario half of PRO-117 (every message exercised by the kit) remains.

### PRO-002 Publish an OpenAPI definition of the control plane

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 0 | M | must | Maintainer |

**Spec:** 05 §6, §11; ADR 0008 · **Requirements:** R6 · **Depends on:** SPK-019

As a maintainer, I want the control plane described in an OpenAPI document in `spec/`, so that host backends and independent servers share one machine-readable contract.

**Acceptance criteria**

- [ ] Given the repository, when the OpenAPI document is built, then every resource and method in the table of 05 §6.2 has a path, parameters, request body, success response and problem responses, and the resources of 12 §10 are added by FRW-025, FRW-060, FRW-065 in the same document.
- [x] Given a mutable resource, when its definition is read, then it declares an `ETag` response header and requires `If-Match` on updates (05 §6.1); given a POST that creates something, then it declares `Idempotency-Key`.
- [x] Given each route, when its security is read, then it names user token, service credential or both, matching the "service credential only" marks in 05 §6.2 and the matrix in PRM-056.
- [x] Given error responses, when they are read, then they use RFC 9457 problem details whose `code` is an enumeration generated from the registry of PRO-038, and lists use `{ items, nextCursor }` with `cursor` and a `limit` of at most 200.
- [x] Given the document, when PRO-117 runs, then every resource and method in the prose is in the document and vice versa.

**Evidence:** `spec/dep/dep-1.openapi.json`, generated from `packages/protocol/src/definition/resources.ts` (and `frw.ts`) by `packages/protocol/src/generate/openapi.ts`. `packages/protocol/test/schemas.test.ts` (unique operation identifiers, path parameters, `2XX` or `202` success and `4XX`/`5XX` problem responses on every operation, `If-Match` on every PUT and PATCH, `Idempotency-Key` on creating POSTs, `ETag` on mutable resources, problem `code` drawn from the registry in `packages/protocol/src/definition/errors.ts`, cursor lists with `limit` at most 200, references resolve, 2020-12 compile); `definition.test.ts` (service-credential routes as 05 §6.2 and 07 §12 mark them); `prose.test.ts` (routes and methods of 05 §6.2 read from the table and compared both ways, with the one reading recorded as G100). Criteria 2 and 3 (lane w5, 2026-11-15): `packages/protocol/test/pro-002-openapi.test.ts` (7 tests, Node.js) reads `spec/dep/dep-1.openapi.json` itself, not the definition's flags: every POST that answers `201` declares `Idempotency-Key` (`placeHold` now does); every PUT and PATCH requires `If-Match`; the GET of every resource that can be updated answers with an `ETag`, or the update's own answer does where the resource has no GET; every route but discovery names the user token, the service credential or both; the routes that take the service credential only are exactly the routes of the `service` row of `spec/permissions/permissions-1.json` (PRM-056), and every route of the other rows and classifications accepts the user token, with no route left out of the comparison.

**Notes:** The prose names no HTTP status for any registry code; the document cannot be complete until that mapping is written into 05 (see Open questions). Until then problem responses are `4XX` and `5XX` ranges and success is `2XX` (S6 decision D13; gaps G50, G54). Criterion 1 is met for 05 §6.2, with placeholder bodies where the prose defines none (D26, gaps G60 to G77); the 12 §10 routes are in the same document as a first version registered from `frw.ts`, but FRW-025, FRW-060 and FRW-065 own them, and the workflow actions, `/templates` and `/bulk-sends` have no route yet (G95, G96). Criterion 3 is checked against 05 §6.2 and the rows of 07 §12; it stays open until the machine-readable matrix of PRM-056 exists to compare with. The registry in `errors.ts` is a first version of PRO-038's. Criterion 2 unticked by the evidence audit (2026-11-13): `POST /documents/{id}/holds` (`placeHold`, UX-080) creates a hold with `201` but has no `idempotencyKey` and declares no `Idempotency-Key` in `spec/dep/dep-1.openapi.json`, and `schemas.test.ts` only checks the routes the definition already flags, so it cannot catch a creating POST that lacks the flag; set the flag on `placeHold` (or record why a hold is exempt) and add a test that every `201` POST declares the header. Lane w5 (2026-11-15): the flag is set on `placeHold`, the artifacts are regenerated, and the test of the Evidence line reads the published document, so criterion 2 is ticked again; the reference service takes the flag from the definition, so it now remembers the key for a hold as for the other creating routes. Read of "creates something": a POST that answers `201`; the POSTs that answer `202` and start a job already declare the header, and the test does not require it of them. Criterion 3 is ticked: the matrix of PRM-056 now exists in `spec/permissions/permissions-1.json` and the test compares the document with it. Criterion 1 stays open for the reasons above: 05 names no HTTP status for the registry codes, so responses are ranges (D13); bodies are placeholders where the prose defines none (D26, G60 to G77); and the workflow actions, `/templates` and `/bulk-sends` of 12 §10 have no route (G95, G96; FRW-025, FRW-060, FRW-065). The first two need the prose of 05 to change, which is not a lane's to decide.

### PRO-003 Publish JSON Schemas for webhook bodies and the CDM

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 0 | S | must | Maintainer |

**Spec:** 05 §7, §11 · **Requirements:** R6 · **Depends on:** CDM-007, CDM-008

As a maintainer, I want JSON Schema for every webhook body and the published CDM schema in `spec/`, so that hosts can validate what they receive and what they store.

**Acceptance criteria**

- [x] Given the events in 05 §7, when the schemas are built, then each event type has a schema for its CloudEvents attributes and its `data`, and the event names carry the version suffix (for example `dep.export.completed.v1`).
- [x] Given a CDM schema from the CDM epic, when the artifacts are built, then it is included in `spec/` unchanged and its versions equal the `cdm` range announced in discovery.
- [x] Given example payloads for every event, when they are validated against the schemas, then all pass, and a payload with a missing required field fails.
- [x] Given the artifacts, when PRO-117 runs, then every event name in 05 §7 and in 12 §10 has a schema.

**Evidence:** `spec/dep/webhooks/*.schema.json` (35 files, one per event of 05 §7 and 12 §10, named with `.v1`), generated from `packages/protocol/src/definition/events.ts` and `frw.ts`; `spec/dep/dep-1.manifest.json` records `spec/cdm/cdm-1.schema.json` by path, `$id` and hash. `packages/protocol/test/schemas.test.ts` (each webhook schema compiles in Ajv, its example passes, an unknown `data` member passes, a missing `data`, `data.seq` or a wrong `type` fails); `artifacts.test.ts` (the CDM schema's hash equals the CDM manifest's, its version equals the definition's `cdm` range); `prose.test.ts` (event names read from 05 §7 and 12 §10).

**Notes:** `data` holds only `seq` and, for `dep.document.changed`, a placeholder member for the hash-chain head (G83); the workflow event names complete the bare names of 12 §10 as `dep.workflow.<name>.v1` (S6 decision D17, gap G85). The CDM schema is referenced, never copied.

### PRO-004 Share DEP types, codecs and client state machines in the `protocol` package

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 05 §4, §5; 01 §6 · **Requirements:** R6 · **Depends on:** PRO-001, PRO-002

As a maintainer, I want one `protocol` package with the DEP types and codecs, so that `backend-dep`, the conformance kit and the reference service cannot disagree about a message.

**Acceptance criteria**

- [x] Given the artifacts of PRO-001 and PRO-002, when the package is built, then every message and resource type is exported, and CI fails if a type differs from its schema.
- [x] Given a JSON text frame, when the codec decodes it, then it returns a typed envelope or a `bad_message` error, never throws on unknown fields, and never executes any payload content.
- [x] Given a typed envelope, when the codec encodes it, then the result is one JSON object suitable for one text frame, and decode(encode(x)) equals x for every golden fixture of PRO-110.
- [x] Given Node.js without a browser and a browser without Node.js, when the package is imported, then it works unchanged in both, so the kit, the service and the component share it.

**Evidence:** `packages/protocol/src/client/` (`ClientSession`, `ClientChannel`, negotiation, reconnection), exported as `@docedit/protocol/client`; every message and resource type is exported from `@docedit/protocol`, and `packages/protocol/test/artifacts.test.ts` fails when `src/generated/types.ts` differs from a fresh generation. `src/client/session.universal.test.ts` (decode never throws and nothing invalid is sent, fast-check), `negotiate.universal.test.ts` (decode(encode(x)) equals x for the minimal and maximal example of every message type; a hostile frame with `__proto__` and `constructor` members reaches no prototype), `channel.universal.test.ts` and `channel.property.universal.test.ts` pass in Node.js, Chromium, Firefox and WebKit, as do `packages/backend-dep/src/*.universal.test.ts`. Criterion 3: `packages/protocol/test/golden.test.ts` (Node.js; every valid frame of `packages/tck/fixtures/messages/messages.json` round-trips through `depCodec()`, every invalid one is refused).

**Notes:** `backend-dep` (PRO-093) needs it. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Criterion 3 is met by `packages/protocol/test/golden.test.ts` (packet P1, 2026-11-13), which round-trips every valid frame of the PRO-110 message fixtures (`packages/tck/fixtures/messages/messages.json`, 28 types) and refuses every invalid one; `conversation.json` holds `$` placeholders, so it is a scenario and not a set of golden frames, and it is not round-tripped here. Before that test, the round trip held for the conversation of 05 §5.9 (`src/codec/codec.universal.test.ts`) and for the minimal and maximal example of every message type (`src/client/negotiate.universal.test.ts`), and every encoded frame is one JSON object starting with `t`. The client state machines and their choices are ADR 0040 (proposed) and decisions D80 to D85.

## Versioning rules (05 §1)

### PRO-005 Ignore what is not known

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Integrating developer |

**Spec:** 05 §1 rules 3 and 5; ADR 0008 · **Requirements:** R6 · **Depends on:** PRO-004

As an integrating developer, I want every receiver to ignore unknown fields and message types, so that a newer minor version never breaks an older client or server.

**Acceptance criteria**

- [x] Given a message with a field the receiver does not know, when it is processed, then the known fields are used and the unknown field is ignored, on the socket, in REST bodies and in webhook bodies.
- [x] Given a message of an unknown type without an `id`, when it arrives, then it is ignored and the connection stays open.
- [x] Given a message of an unknown type with an `id`, when it arrives, then the receiver replies `error` with code `unknown_type`, `fatal: false` and `re` set to that `id`.
- [x] Given a message type or feature name that starts with `x-`, when the peer did not negotiate it, then it is treated like any unknown type or feature; and no stable message type, field or feature is ever named with the `x-` prefix.

**Evidence:** Socket: `packages/protocol/src/client/session.universal.test.ts` (unknown members passed on unchanged; an unknown type without `id` ignored, with `id` answered with `unknown_type`, `fatal: false`, `re` set; an `x-` type not negotiated treated alike) and `packages/backend-dep/src/backend.universal.test.ts` (the same on the wire, and the connection stays open); the server side against the document service in `packages/backend-dep/test/service.test.ts` ("the service on the wire"). REST: `backend.universal.test.ts` (a content response with unknown members). Webhook bodies: `packages/protocol/test/schemas.test.ts` (an unknown `data` member passes). Names: `featureNamespaceProblems` in `src/client/negotiate.ts` finds no stable message type, field or feature with the `x-` prefix (`negotiate.universal.test.ts`, `backend.universal.test.ts`).

**Notes:** Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a.

### PRO-006 Negotiate the protocol version and features

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Integrating developer |

**Spec:** 05 §1 rules 1, 2 and 4, §2, §5.1; 03 §11 · **Requirements:** R6, R9 · **Depends on:** PRO-005

As an integrating developer, I want the version and the optional features to be negotiated explicitly, so that a client uses only what the server announced.

**Acceptance criteria**

- [x] Given a client whose `hello.versions` contains `1.0` and a server that supports it, when the session opens, then `welcome.version` is `1.0`; the major version also appears in the subprotocol `dep.v1` and in the REST base path (`/v1`), and the minor version only in `hello` and `welcome`.
- [ ] Given two published artifact sets of the same major version, when they are compared in CI, then the later one only adds optional fields, message types, resources, event types and feature names (05 §1 rule 2).
- [x] Given `welcome.features`, when the client chooses what to use, then it uses no feature that is absent from the list (for example no `presence.update` without `presence`), verified by a test that records every message `backend-dep` sends.
- [x] Given a protocol feature name and a CDM feature name (03 §11), when features are registered, then the two share one namespace and a name cannot be registered twice.
- [x] Given a `ch.open` that asks for a feature the server did not announce, when it is processed, then the channel is rejected with `unsupported_feature`.

**Evidence:** `packages/backend-dep/src/backend.universal.test.ts` (`hello.versions` is `['1.0']`, `welcome.version` 1.0, the socket offers `dep.v1`, every REST request is under `/v1`, and no other frame carries a version; a server without `presence` gets no `presence.update`, no presence port, and `ch.open.features` stays within `welcome.features`, with every frame recorded) and `packages/backend-dep/test/service.test.ts` (the same version, subprotocol and base path against the document service). `featureNamespaceProblems` (`packages/protocol/src/client/negotiate.ts`) reports a feature registered twice and a CDM feature missing from the namespace; `negotiate.universal.test.ts` runs it on DEP1 with the CDM's features and on a definition with a duplicate.

**Notes:** How the server picks a version when several are common is not stated (Open questions). Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. The client accepts any version it offered and expects the highest common one (D82). Criterion 2 stays open: only one artifact set has been published, and the CI job that compares a set with the last published one is the main session's (`.github/`). Round 1, 2026-11-13: the check exists as `compatibilityProblems` in `packages/protocol/src/generate/compat.ts` (registry contract fields, AsyncAPI and OpenAPI schemas, operations, responses, parameters and the major version), tested in `packages/protocol/test/compat.test.ts` on the real artifacts and on edits of them; nothing calls it on two published sets yet. Round 2, lane V-PRO-001-017 (2026-11-13): `compat.test.ts` re-run in Node.js, 11 passed; criterion 2 is still open because a second published set needs an owner decision (what the baseline is) and the CI job needs root config (`.github/`), listed for the main session. Criterion 5 is the server's: the document service refuses such a `ch.open` with `unsupported_feature` (`services/document-service/src/data-plane/session.ts`), and the case "refuses a ch.open that asks for a feature the server did not announce" in `packages/backend-dep/test/service.test.ts` now runs unskipped and passes in Node.js (2026-11-13). It was pending until then. Lane w5 (2026-11-15): criterion 2 is still blocked, and nothing was built for it. No release has been published, so there is no earlier artifact set of major version 1 to compare with (`spec/dep` holds one set and the repository has no release tag); which set is the baseline is the owner's decision; and the job that runs `compatibilityProblems` on the two sets belongs in `.github/`, which this lane may not edit. The check itself is ready to be called by that job.

### PRO-007 Signal deprecations

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | S | could | Maintainer |

**Spec:** 05 §1 rule 6, §6.1 · **Requirements:** R6 · **Depends on:** PRO-002, PRO-041

As a maintainer, I want deprecations to be announced for at least twelve months and signalled on the wire, so that hosts have time to move before a major version removes anything.

**Acceptance criteria**

- [ ] Given a resource marked deprecated in the OpenAPI document, when a client calls it, then the response carries `Deprecation` and `Sunset` headers.
- [x] Given a CORS request from an allowed origin, when the response is read by a browser, then `Deprecation` and `Sunset` are readable (they are exposed headers, PRO-041).

**Evidence:** criterion 2 (lane V-PRO-001-017, 2026-11-13): `services/document-service/test/control-plane/routes.documents.test.ts` (the test "answers CORS for allowed origins only"): a `GET` from an allowed origin gets `Access-Control-Expose-Headers` listing `Deprecation` and `Sunset`, in memory and on PostgreSQL. This checks the exposed header list the browser applies; no browser was run for it.
- [ ] Given a feature or field marked deprecated, when a major version that removes it is prepared, then CI fails unless the deprecation date in the artifacts is at least twelve months earlier.

**Notes:** Condition: only when the first feature, field or resource is deprecated; nothing is deprecated in 1.0.

## Discovery (05 §2)

### PRO-008 Publish a discovery document

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | S | must | Integrating developer |

**Spec:** 05 §2, §9; ADR 0008 · **Requirements:** R6 · **Depends on:** PRO-004

As an integrating developer, I want one HTTPS document that tells a client where the socket and the REST API are and what the server supports, so that I configure only an endpoint.

**Acceptance criteria**

- [x] Given a conforming server, when a client requests `GET {endpoint}/.well-known/dep`, then it receives JSON with `versions`, `ws`, `rest`, `engines`, `cdm` (`min`, `max`), `features`, `mode` and `jwks_uri`.
- [x] Given the `rest` member, when a client builds a request, then it treats `rest` as the complete base URL and resolves every resource path (and every notification `resource`) relative to it.
- [x] Given `mode`, when it is read, then it is `authority` or `relay`; and given `relay`, then `features` contains none of `regions`, `suggest-enforced` and `fields`.
- [x] Given `engines`, when a client reads it, then `pm-steps/1` is present on a server that implements 04; and given an unknown feature name, then the client ignores it.
- [x] Given a page on an allowed origin, when it fetches the document with a browser, then the response is readable under the CORS rules of PRO-041.

**Evidence:** `services/document-service/src/control-plane/handlers.ts` (`getDiscovery`); the shape is `Discovery` (`packages/protocol/src/definition/common.ts`, every member required, D66). `services/document-service/test/control-plane/routes.documents.test.ts`: discovery without a token has exactly the eight members, `mode` `authority`, `engines` with `pm-steps/1`; `rest` plus a resource path is served; `jwks_uri` serves the minting key; an allowed origin can read responses and a disallowed one gets no CORS grant. Criterion 4 (round 1, 2026-11-13): the server half is the same test's `engines` with `pm-steps/1`; the client half is "ignores an unknown feature name in discovery and offers pm-steps/1 (PRO-008 criterion 4)" in `packages/protocol/src/client/negotiate.universal.test.ts` (`checkDiscovery` accepts an unknown announced name, `negotiateFeatures` drops it). Criterion 2 (lane w5, 2026-11-15): `packages/backend-dep/src/pro-008-rest-base.universal.test.ts`. The server publishes a `rest` on another host and under another path than the endpoint, and a gateway answers only under it. Every REST request of `backend-dep` (content, regions, grants, exports, assets, fonts) goes to `rest` plus the resource path and none goes elsewhere; a `rest` that ends in a slash gives the same addresses; the `resource` of `asset.ready` and of `export.completed` is the path the client uses under `rest` (`RestClient`, `packages/backend-dep/src/rest.ts`). Criterion 5 (lane w5, 2026-11-15): `services/document-service/test/control-plane/pro-008-discovery-cors.test.ts`. Over HTTP, `GET /.well-known/dep` with an allowed `Origin` gets `Access-Control-Allow-Origin` and the preflight is answered; another origin gets no grant. In a browser (the Chromium of Playwright 1.65.0 on Windows 11, run from Node.js; the test skips when Chromium is not installed), a page on an allowed origin fetches the document from the service on another origin and reads its eight members, also after a preflight, and a page on an origin that is not allowed gets a `TypeError`.

**Notes:** Whether discovery needs authentication is not stated; the criteria assume it does not, because the client reads it before it holds a token. How the tenant is known for an unauthenticated request is open (Open questions). The purpose of `jwks_uri` is not explained in 05. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Packet A2 (2026-11-06): criterion 4 stays open for its client half (an unknown feature is ignored: packet B). Round 1, 2026-11-13: the client half is now tested (see Evidence), so criterion 4 is ticked. Discovery needs no token and is the same for every tenant; a preflight is allowed when some tenant allows the origin (D66, which resolves G03 and G05). `jwks_uri` publishes the keys of minted tokens (D60, G04). Evidence audit, 2026-11-13: criterion 2 is unticked because the only test builds `${rest}/documents` by hand, so the client half and the notification `resource` are untested (the mock server's `rest` is `origin + /v1`, which a client that hard-codes `/v1` would also satisfy); criterion 5 is unticked because no test fetches `/.well-known/dep` with an `Origin` header (a probe showed the server answers it correctly, but the CORS tests only read `/v1/documents/{id}`). Lane w5 (2026-11-15): both are now tested and ticked (see Evidence). The client has no general call that fetches a notification's `resource`; it hands the notification on unchanged (PRO-035) and its ports build the same path under `rest`, which is what the test of criterion 2 checks. The browser run of criterion 5 used Chromium only; Firefox and WebKit were not run for it.

## Authentication (05 §3)

### PRO-009 Accept user tokens with the defined claims

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Integrating developer |

**Spec:** 05 §3.1; ADR 0008 · **Requirements:** R3, R10 · **Depends on:** PRO-004

As an integrating developer, I want the document service to accept my short-lived JSON Web Token with a role per document, so that my host decides who may open what without sharing a directory.

**Acceptance criteria**

- [x] Given a token with `iss`, `aud`, `iat`, `exp`, `jti`, `tid`, `sub` and a `docs` object, when its signature is valid, then the service accepts it and treats `docs[docId]` as the user's document role (`viewer`, `commenter`, `suggester`, `editor`, `owner` or `filler`); optional `name` and `grp` are read when present.
- [x] Given a token whose `aud` differs from the service identifier in any way (prefix, case, trailing slash), when it is presented, then it is refused; given an exact match, then it is accepted.
- [x] Given `exp` minus `iat` of 15 minutes, when presented, then it is accepted; given one second more, then it is refused.
- [x] Given a token whose `exp` passed 59 seconds ago, when presented, then it is accepted (60 seconds of skew); given 61 seconds, then it is refused; the same tolerance applies to `iat`.
- [x] Given a `docs` claim with 20 entries, when presented, then it is accepted; given more than 20, then it is refused.
- [x] Given a stored region grant for `sub` or one of `grp`, when the grant changes, then the user's effective permissions change without a new token, because region grants are never read from the token (PRM owns the grants).
- [x] Given the integration guide, when it describes `sub`, then it says the identifier is opaque and stable and that hosts should not use e-mail addresses, because the service stores a per-tenant surrogate (08 §13).

**Evidence:** `services/document-service/src/control-plane/tokens.ts`. `services/document-service/test/control-plane/tokens.test.ts`: the claims and the six roles; `aud` refused for a trailing slash, another case, a prefix or an array; 900 s accepted and 901 refused; `exp` 59 s past accepted and 61 s refused (`token_expired`), the same for `iat`; 20 documents accepted and 21 refused (D74). Grants are never read from the token: in `services/document-service/test/control-plane/routes.content.test.ts` a grant change gives the same token another class of content at the next read. Criterion 7 (lane w5, 2026-11-15): the integration guide now exists (`apps/reference-host/docs/integration-guide.md`) and its section "The user identifier: `sub`" says the identifier is opaque and stable, that hosts should not use e-mail addresses, and that the service stores a per-tenant surrogate (08 §13); `apps/reference-host/test/pro-009-sub-guide.test.ts` checks each statement and that 05 §3.1 and 08 §13 still say the same.

**Notes:** The code returned for an over-limit `docs` claim, and the handling of a role outside the six names, are not stated (Open questions). Claims for history visibility, output restrictions and workflow participants are PRO-015. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Packet A2 (2026-11-06): criterion 7 stays open: no integration guide exists yet. An over-limit `docs` claim, an empty one and an unknown role are `unauthenticated` (D74). Lane w5 (2026-11-15): criterion 7 is ticked; the guide repeats the specification and adds nothing to it. The test checks that the statements are present, not the quality of the prose.

### PRO-010 Verify tokens against the tenant's keys

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Integrating developer |

**Spec:** 05 §3.1; 10 §3.2 · **Requirements:** R10 · **Depends on:** PRO-009

As an integrating developer, I want tokens verified only against keys I registered for my tenant, with an allow-list of algorithms, so that no token can name its own key or downgrade the check.

**Acceptance criteria**

- [x] Given a token, when it is verified, then the key set is selected by `tid` from the tenant's registration, and a URL, `jku`, `x5u` or embedded key inside the token is never fetched or trusted.
- [x] Given tokens signed with ES256, EdDSA and RS256 by a registered key, when presented, then all are accepted; given `none`, an HMAC algorithm or any other algorithm, then the token is refused.
- [x] Given a `tid` with no registration, or a token signed by another tenant's key, when presented, then it is refused.
- [x] Given `backend-dep`, when it connects or calls REST, then it sends the token only in the `hello` message and in the `Authorization: Bearer` header, and a test that records every URL it requests finds no token in any URL.
- [x] Given a token signed with a user-token key and carrying the type `dep-svc+jwt`, when presented as a service credential, then it is refused (see PRO-013).

**Evidence:** `services/document-service/src/control-plane/jwt.ts` (allow-list, one algorithm per key, `jku`, `x5u`, `jwk` and `x5c` never read, `crit` refused) and `tokens.ts`. `services/document-service/test/control-plane/tokens.test.ts`: an embedded key and key URLs are ignored; another tenant's key and an unregistered `tid` are refused; ES256, EdDSA and RS256 are accepted and `none`, HS256 with the public key as secret and a mismatched algorithm refused. `services/document-service/test/control-plane/routes.documents.test.ts`: a `dep-svc+jwt` signed with a user-token key is refused. Criterion 4 (2026-11-13, lane PRO-001-014): `packages/backend-dep/test/token-placement.test.ts` (connect, open a channel, commit, and read the two permission resources; the token is in `hello` and in `Authorization: Bearer` headers only, in no URL and in no other frame). `auth.refresh` also carries the token, by PRO-014, and is outside this criterion.

**Notes:** Registering keys and allowed origins belongs to the administration interfaces (UX-076). Security testing of the verifier is SEC's. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Packet A2 (2026-11-06): criterion 4 stayed open until packet B; it is met now (see Evidence). Round 1, 2026-11-13: the criterion lists only `hello` and the `Authorization` header for connecting and REST, so the test checks those calls; the token also travels in `auth.refresh`, which PRO-014 requires. The owner may want the criterion to name `auth.refresh` too.

### PRO-011 Mint a user token through the service

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Integrating developer |

**Spec:** 05 §3.1, §6.2 · **Requirements:** R6 · **Depends on:** PRO-009, PRO-012

As an integrating developer, I want to call `POST /tokens` with my service credential and pass the result to the page, so that I can start without running my own signing infrastructure and so that the conformance kit can run.

**Acceptance criteria**

- [x] Given a conforming server, when the kit or a host calls `POST /tokens` with a service credential, then it returns a user token that satisfies every claim rule of PRO-009 and whose lifetime is at most 15 minutes.
- [x] Given a user token or no credential, when `POST /tokens` is called, then the request is refused.
- [x] Given a tenant that also verifies host-signed tokens, when `POST /tokens` is used, then both issuers work side by side.
- [x] Given a token minted for `docs: { A: "editor" }`, when the user opens document A and then document B, then A opens with `editor` and B is refused.
- [x] Given a server that does not offer `POST /tokens`, when the kit bootstraps (PRO-108), then the server is reported non-conforming.

**Evidence:** `POST /tokens` (`services/document-service/src/control-plane/handlers.ts`, `tokens.ts`; bodies D60). `services/document-service/test/control-plane/routes.documents.test.ts`: the minted token satisfies the claim rules, lives at most 15 minutes (`expiresIn` shortens it), verifies with the JWKS, opens document A and is refused on B; host-signed tokens keep working beside it; a user token or none cannot mint. `services/document-service/test/server/server.test.ts`: with the real data plane the minted token opens A and gets `ch.rejected` `forbidden` on another document. Criterion 5 (2026-11-13, lane PRO-001-014): `packages/tck/test/bootstrap-tokens.test.ts` runs `runKit` against a server that answers discovery and `POST /v1/documents` and refuses `POST /tokens`; the bootstrap fails naming `POST /tokens`, the report is not ok and no profile runs.

**Notes:** The request and response bodies are not defined in 05 (Open questions); PRO-002 defines them. Packet A2 (2026-11-06): criterion 5 stayed open until packet F; it is met now (see Evidence). Bodies: D60.

### PRO-012 Call the control plane with an API-key service credential

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | S | must | Integrating developer |

**Spec:** 05 §3.2, §6.1, §6.2; 10 §3.7 · **Requirements:** R6, R10 · **Depends on:** PRO-002

As an integrating developer, I want my backend to call the control plane with an API key, so that it can create documents, mint tokens and list documents on behalf of my application.

**Acceptance criteria**

- [x] Given a valid API key of a tenant, when it calls a resource marked "service credential only" (`/tokens`, `POST` and `GET /documents`, `PUT` content, `/sessions/revoke`, `/fork`, `/webhooks`), then the call is accepted.
- [x] Given a user token, when it calls any of those resources, then the call is refused.
- [x] Given an API key of tenant X, when it names a document of tenant Y, then the call is refused.
- [x] Given a key rotation with an overlap period, when both the old and the new key are active, then both are accepted; after the overlap, then the old key is refused (10 §3.7).

**Evidence:** `services/document-service/test/control-plane/routes.documents.test.ts`: user tokens are refused on every service-credential route; an API key of another tenant finds none of this tenant's documents; two overlapping API keys both work and the older is refused once it expires. Criterion 1 (lane V-PRO-001-017, 2026-11-13): `services/document-service/test/control-plane/pro-012-api-key-routes.test.ts`, run in memory and on PostgreSQL in Podman (`docedit-test-postgres`, own database): a tenant API key gets a 2xx on `POST /v1/tokens`, `GET` and `POST /v1/documents`, `PUT /v1/documents/{id}/content`, `POST /v1/sessions/revoke`, `POST /v1/documents/{id}/fork` and `POST` and `GET /v1/webhooks`. The data plane is a stand-in for the content replacement and the webhook subscriptions use the memory store in both runs.

**Notes:** How the key is carried (header name) is not stated in 05. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Packet A2 (2026-11-06): criterion 1 was open, because `PUT` content, fork and webhooks were not built. Lane V-PRO-001-017 (2026-11-13): those routes exist now, and criterion 1 is met (see Evidence). Keys are bearer credentials (D18); their format is in ADR 0036.

### PRO-013 Call the control plane with a signed service credential and act for a user

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | should | Integrating developer |

**Spec:** 05 §3.2, §6.1; 13 §11.3 · **Requirements:** R4, R10 · **Depends on:** PRO-010, PRO-012

As an integrating developer, I want a signed service credential and a way to name the user my backend acts for, so that history attributes server-side integrations to the right person.

**Acceptance criteria**

- [x] Given a JWT with the type header `dep-svc+jwt` signed by a key registered for service credentials, when it calls a service-credential resource, then the call is accepted.
- [x] Given a JWT signed by a key registered for user tokens, when it carries the header `dep-svc+jwt`, then it is refused; given a user token whose claims say anything about being a service, then it is never accepted as a service credential.
- [ ] Given a service call with `DEP-Actor` naming a user, when it changes a document, then history attributes the change to that user (HIS-014, HIS-015).
- [x] Given a browser origin, when a preflight asks for `DEP-Actor`, then the header is in the allowed list (PRO-041).

**Evidence:** `services/document-service/test/control-plane/routes.documents.test.ts`, "accepts API keys and dep-svc+jwt on service routes and refuses user tokens there" (criterion 1: a service JWT signed with the tenant's service key gets 200 on `GET /documents`; criterion 2: a `dep-svc+jwt` signed with the user-token key is `unauthenticated`, and a user token whose claims say it is a service is `forbidden` on every service route), and "answers CORS for allowed origins only" (criterion 4: the preflight allows `DEP-Actor`). Both run in memory and with PostgreSQL (skipped here: no database).

**Notes:** Phase inferred: 1a needs only the API key (PRO-012). Whether `DEP-Actor` is honoured on user-token calls is not stated. Packet C (2026-11-13): criterion 3 stays open. The control plane hands the `DEP-Actor` surrogate to the data plane (`routes.content.test.ts`, "replaces content through the data plane"), but the history record that names the user is HIS-014 and HIS-015, which are not built here.

### PRO-014 Refresh tokens during a session

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 05 §3.1, §5.1, §5.2 · **Requirements:** R10 · **Depends on:** PRO-021, PRO-033

As an author, I want my session to continue past the 15-minute token lifetime without interruption, so that a long writing session never ends in a forced reload.

**Acceptance criteria**

- [x] Given `welcome.tokenExp`, when about 60 seconds remain, then the server sends `auth.expiring` with `inMs`.
- [x] Given `auth.expiring`, when the client calls `getToken` and sends `auth.refresh` with the new token, then the server replies `auth.ok` with the new `tokenExp` and `re` set to the request `id`, or replies `error`.
- [x] Given a refreshed token (or a token in `ch.open`, or `auth.refresh` with `ch`) whose `tid` or `sub` differs from the session's, when it is presented, then it is refused and the old token stays in force.
- [x] Given a refreshed token whose roles differ, when it is accepted, then the server recomputes access and sends `perm.changed`.
- [x] Given no refresh, when `tokenExp` passes, then the server closes the connection with 4401.
- [x] Given a session of 45 minutes with a 15-minute token, when the host's `getToken` works, then no message is lost and no reconnect happens because of tokens.

**Evidence:** `packages/backend-dep/test/lifecycle.test.ts` ("asks getToken for a new token when auth.expiring arrives, and the server acknowledges it": the `auth.refresh` carries an identifier, `auth.ok` answers it with `re` set, and the session's `tokenExp` moves; "keeps a 45-minute session on 15-minute tokens with no reconnect and no lost message": three refreshes, one `hello`, no reconnect diagnostic, and a commit after 45 minutes is acknowledged), on the virtual clock of `test/support/virtual-time.ts`. Round 1, 2026-11-13 (lane PRO-001-014): criteria 1, 3, 4 and 5 are met by the document service. Criteria 1 and 5: `services/document-service/test/data-plane/session.test.ts`, "sends auth.expiring about 60 seconds before tokenExp and closes with 4401 at expiry" (`inMs` between 55 and 60.4 seconds; a 400 ms token gets `token_expired` and close 4401). Criterion 3: `services/document-service/test/data-plane/refresh-identity.test.ts` (a `ch.open` token and an `auth.refresh` with `ch` of another user or another tenant are refused and the channel stays open on the token in force; a session refresh of another user is refused, and the next valid token is accepted). Criterion 4: `services/document-service/test/data-plane/session-1b.test.ts`, "sends perm.changed for a lower role, keeps the channel open, and applies the new role". All four files pass in Node.js on the memory store (2026-11-13).

**Notes:** `auth.ok` is used in the text but is not in the message table of 05 §5.1, and its payload is not defined (Open questions). The precedence between a channel token and the connection token is not stated. Phase inferred: the 1a demo can finish inside one token lifetime.

### PRO-015 Carry optional claims for history visibility, output restrictions and participants

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | S | should | Integrating developer |

**Spec:** 05 §3.1, §5.5; 12 §7 · **Requirements:** R4, R13 · **Depends on:** PRO-009, PRO-032

As an integrating developer, I want to pass `access_since`, `restrict` and the participant claims in the token, so that history visibility, output restrictions and workflow participants follow my host's decisions.

**Acceptance criteria**

- [x] Given a token with `access_since`, when the history setting is `since_access`, then the visibility gate uses that time (PRM-041, PRM-042).
- [x] Given `restrict` with `no-export`, `no-copy` or `no-print`, when the channel opens, then `access.restrictions` lists exactly those values; given an unknown value, then it is ignored.
- [x] Given `wfp`, `amr` and `auth_time`, when the token is accepted, then the service records them as given and does not vouch for identity (FRW-038, FRW-040).
- [x] Given a refreshed token that adds or removes a `restrict` value, when it is accepted, then `perm.changed` carries the new `restrictions`.

**Evidence:** criterion 3 (fixer round 2, 2026-11-13): `services/document-service/test/control-plane/pro-015-asserted-recorded.test.ts`, real token service, real data plane and WebSocket clients, memory and PostgreSQL (Podman test environment, own database created and dropped by the harness), 6 tests passed: after `ch.opened`, `Session.assertedClaims(ch)` reads back `wfp`, `amr` and `auth_time` as given with the token's `jti` and the server time, frozen; no frame sent to the client carries them; access equals that of a token without them; a channel's own token is recorded for that channel; a refresh replaces the record, and one without them clears it. Code: `services/document-service/src/data-plane/asserted-claims.ts` (`recordAsserted`), `src/data-plane/session.ts` (record set on `ch.open` and in `#rebind`). Lane U-PRO-001-017 (criteria 2 and 4 ticked): `services/document-service/test/control-plane/pro-015-claims.test.ts` (signed tokens: unknown `restrict` values ignored, known ones kept once in token order, a non-array `restrict` refused; `wfp`, `amr` and `auth_time` recorded as `VerifiedIdentity.asserted`, with the same connection as a token without them; ill-typed ones omitted); `services/document-service/test/data-plane/pro-015-restrictions.test.ts` (WebSocket clients over MemoryStore: `access.restrictions` on `ch.opened`; a refresh that adds `no-copy` and one that removes it each send `perm.changed` with the new list; an unchanged refresh sends none). Run in Node.js. `packages/authority/src/room/room.ts` (`refresh` also compares restrictions) and `packages/protocol/src/bridge/translate.ts` (`restrictionsOf`). Decision record: [ADR 0309](../adr/0309-lane-U-PRO-001-017.md).

**Previous evidence (lane PRO-015-028):** `services/document-service/test/control-plane/claims-optional.test.ts` (lane PRO-015-028), criterion 1: a signed token with `access_since` (RFC 3339) verifies to an identity with `accessSince` 2,500 ms; `connectionOf` (`src/data-plane/room-host.ts`) gives the room connection that time, and `gateOf` under `since_access` returns seq 2 for commits at 1,000 to 5,000 ms (the last commit at or before the access time), and the head when the token has no claim. The gate arithmetic itself is in `src/data-plane/gate.test.ts` ("under since_access, shows the state current at the access time").

**Notes:** Lane PRO-015-028, not ticked: criterion 2 conflicts with the code. `services/document-service/src/control-plane/tokens.ts` (`restrict` check, around line 189) refuses a token whose `restrict` holds an unknown value, where the criterion says it is ignored; no `access.restrictions` is returned on `ch.opened` (no `restrictions` in the data plane). Changing the refusal is a behaviour decision for the owner (the unknown-claim rule of PRO-005 may point the other way); recorded for ADR 0212-lane-PRO-015-028. Criterion 3: `verifyUser` keeps only the identity fields, so `wfp`, `amr` and `auth_time` are not recorded anywhere; they are minted but not stored. Criterion 4: no `perm.changed` carries `restrictions`. Second review (2026-11-06, SPK-027): no claim yet carries an assistant's agent identity (SR-M23, decided in UX-044) or the role placeholders of a fill-only participant outside a workflow (SR-M27, decided in FRW-083); either decision adds a claim here ([review](../review/2026-11-06-second-review.md)). Reviewer (U1 group 1, round 2): criterion 3 is unticked. `wfp`, `amr` and `auth_time` are parsed into `VerifiedIdentity.asserted` (`tokens.ts`), but nothing reads that field: `room-host.ts` builds the connection without it and the identity is dropped after the channel opens, so the service records them nowhere. It can be ticked when a record (connection, session or evidence store of FRW-040) keeps them and a test reads them back. Lane U-PRO-001-017 (2026-11-13): criteria 2 and 4 are ticked. Criterion 2 follows the criterion and PRO-005: an unknown `restrict` value is ignored, while a `restrict` that is not an array is still refused as malformed; the owner may prefer the refusal, see [ADR 0309](../adr/0309-lane-U-PRO-001-017.md). Criterion 3 records the claims on the verified identity only: nothing persists them, and `wfp` does not feed `connection.participant`, which belongs to the fill rules of FRW. Criterion 4 needed `restrictions` on the authority connection and a comparison in `Room.refresh`. Fixer, round 2 (2026-11-13): criterion 3 is ticked again. The data-plane session now records the claims for each open channel when its token is accepted (`asserted-claims.ts`), and a test reads them back after the channel opens. The record holds the claims of the token in force and lasts as long as the channel. Keeping it beyond the channel, with the IP address, user agent and times, is the per-participant evidence of FRW-040, which is not built; FRW-038 and FRW-040 should take their `amr` from this record. Claims of the wrong type (an empty `wfp`, an `amr` that is not an array of strings, an `auth_time` that is not a number) are still left out rather than recorded raw.

### PRO-016 End a user's access before the token expires

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | should | Integrating developer |

**Spec:** 05 §3.3, §5.1; 07 §9 · **Requirements:** R10 · **Depends on:** PRO-012, PRO-021, PRO-024

As an integrating developer, I want to revoke a user's sessions, so that a person who lost access stops being able to read or write immediately, even with a valid token.

**Acceptance criteria**

- [x] Given a service credential, when `POST /sessions/revoke` is called with a `sub` and optionally a document, then the service records a watermark for that user.
- [x] Given a user token, when it calls `/sessions/revoke`, then the call is refused.
- [x] Given a token issued before the watermark, when it is presented on the socket or on REST, then it is refused on both planes, with close code 4401 on the real-time plane and the error code `revoked` on the control plane, so a revoked client cannot simply reconnect.
- [x] Given open channels of the revoked user, when the revocation is recorded, then a connection-wide revocation sends `auth.revoked` with `reason` and then close code 4401, and a per-document revocation sends `ch.closed` with `forbidden`.
- [x] Given a revoked client, when the error arrives, then `backend-dep` calls `getToken` and raises `de-auth-required` if that fails (PRO-039).

**Evidence:** PostgreSQL in Podman (`docedit-test-postgres`, run by `pnpm exec vitest run`): `services/document-service/test/control-plane/pro-016-revocation-postgres.test.ts` (watermark kept in `tenant_users` and `document_revocations` and honoured by a restarted service; per-document refusal); `services/document-service/test/control-plane/routes.content.test.ts` (postgres: `/v1/sessions/revoke` with the API key returns 204, the old token gets `revoked` or `forbidden` on REST); `services/document-service/test/control-plane/routes.documents.test.ts` (postgres: a user token is refused on `/v1/sessions/revoke`). Memory-only data-plane tests: `services/document-service/test/data-plane/session.test.ts` (`auth.revoked`, then close 4401; a refused hello closes 4401 with `revoked`), `services/document-service/src/data-plane/close-reasons.test.ts` (a revoked channel closes with `forbidden`). Criterion 5 (lane V-PRO-001-017, 2026-11-13, Node.js): `packages/backend-dep/test/pro-016-revoked-socket.test.ts` (after `auth.revoked` and close 4401 the backend calls `getToken` again; when that call fails `onAuthRequired` fires with `unauthenticated`); `packages/backend-dep/test/act-on-error-codes.test.ts` (REST `revoked` renews once with `getToken`). `backend.ts` `lost()` now calls `obtainToken()` after a revoked close.

**Notes:** This story owns the contract: the route, the messages and the codes. What a revocation means for a person's access is PRM-022, and the stored watermark with its checks is BE-031. Whether a revocation naming a document limits the watermark to that document is not stated (Open questions). Phase 2 per the roadmap ("session revocation", Governance). Lane U-PRO-001-017: criteria 1 to 4 are ticked on PostgreSQL in Podman. Criterion 5 (lane V-PRO-001-017, 2026-11-13): met with the `getToken` call after a socket revocation (`backend.ts`). The element names the port event `de-auth-required`; the package raises `onAuthRequired` with code `unauthenticated`, as PRO-039 criterion 1 does, so the name mapping is the element's (PRO-039).

## Real-time plane: framing (05 §4)

### PRO-017 Exchange framed JSON messages on one multiplexed socket

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 05 §4; ADR 0008 · **Requirements:** R6, R7 · **Depends on:** PRO-004

As a maintainer, I want every message to be one JSON object in one text frame with a small envelope, so that traffic is readable in browser tools and any language can implement it.

**Acceptance criteria**

- [x] Given a client that offers the subprotocol `dep.v1`, when it connects to the `ws` address from discovery, then the server selects `dep.v1`.
- [x] Given a text frame, when it is parsed, then it is one JSON object whose `t` (type) is a string; a frame that is not valid JSON, not an object or lacks `t` closes the connection with 4400.
- [x] Given a sender that expects a reply, when it sends a message, then it sets `id`; given a reply, then it always carries `re` equal to that `id`; given a channel-scoped message (including `ch.open`), then it carries `ch` as an integer.
- [x] Given two messages on the same channel, when they are delivered, then they arrive in the order sent; given messages on two channels, then the test asserts no ordering between them.
- [x] Given default settings, when the connection is negotiated, then `permessage-deflate` is not enabled; given both sides enable it, then messages are unchanged.

**Evidence:** Server side, against real WebSocket clients (`services/document-service/src/data-plane/`; `test/data-plane/session.test.ts`, `sync.test.ts`): the server selects `dep.v1` and refuses an upgrade without it; every frame is one JSON object with `t`, and anything else closes with 4400; replies carry `re` and channel messages `ch`; messages of one channel arrive in order (`sync.test.ts` "sends every message of a channel in seq order", and the order checks of the SYN-047 run through the data plane); `permessage-deflate` is off by default and, when both sides enable it, messages are unchanged ("keeps messages unchanged when both sides enable compression").

**Notes:** Pitfall PR-15 (one vocabulary for envelope fields). Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a.

### PRO-018 Chunk messages that exceed the message limit

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Author |

**Spec:** 05 §4, §5.1; 04 §3.1 · **Requirements:** R7 · **Depends on:** PRO-017, PRO-022

As an author, I want a large paste or a large change to be saved even though one message has a size limit, so that big edits do not fail.

**Acceptance criteria**

- [x] Given a message whose UTF-8 size exceeds `maxMessageBytes`, when a peer sends it, then it is sent as `chunk` messages carrying `of` (a fresh identifier), `i` (index), `n` (count) and `part` (a substring of the serialised message).
- [x] Given text that contains characters outside the Basic Multilingual Plane, when it is chunked, then every split falls between Unicode code points (property test over random strings, no surrogate pair is divided).
- [x] Given the chunks of one message, when they are sent, then they are sent consecutively on the connection; and given all chunks, when the receiver reassembles them, then the result is byte-identical to the original and is processed as one message.
- [x] Given an incomplete message, when 10 seconds pass without the rest, then the receiver abandons the reassembly and discards the received chunks.
- [x] Given a commit of the size limit `maxCommitBytes` (1 MiB target) and a `maxMessageBytes` of 131,072 (the value in the example of 05 §5.9), when it is submitted, then it is delivered through chunks and acknowledged.
- [x] Given a message above `maxMessageBytes` that is not chunked, when it arrives, then the server closes with 4413.

**Evidence:** `services/document-service/test/data-plane/session-1b.test.ts`, "chunked messages (PRO-018)": a 800,000-byte submit sent as chunks (`chunkMessage` from `@docedit/protocol`) is reassembled, acknowledged with `seq` 1, and broadcast as consecutive chunks, each frame within `maxMessageBytes`, and the committed text equals the original; an incomplete message is abandoned after `chunkTimeoutMs` (200 ms in the test; the 10-second default is in `src/data-plane/settings.ts`), and the next message is still acknowledged. `services/document-service/test/data-plane/session.test.ts`: a frame above `maxMessageBytes` is answered with `too_large` and closed with 4413. Round 3 (backend-dep, 2026-11-13): `packages/backend-dep/test/chunks.property.test.ts`, "a submit above maxMessageBytes is chunked on the wire (PRO-018)" (fast-check, 50 runs over 800 to 1,500 random code points of one to four UTF-8 bytes and escaped characters, with no fixed prefix): the chunks carry one UUID version 7 `of`, `i` from 0 and the count `n`, the parts concatenate to the serialised `sync.submit`, every frame fits the limit, and no part holds a lone surrogate. The reviewer found in round 3 that the first version could not reach a chunk edge (a 1,200-character prefix before about six random characters); the fixed test also asserts that some edge falls before a four-byte code point and that a naive UTF-16 chunker divides a pair on the same submits (about half of the 50 runs, measured over six runs on 2026-11-13), and with the client's chunker replaced by that naive one the lone-surrogate assertion failed on the first run. Criterion 2 rests first on `packages/protocol/src/codec/codec.universal.test.ts`, "cuts only between code points, keeps every frame within the limit, and reassembles exactly" (fast-check, 200 runs, strings up to 3,000 characters, limits from 120 to 2,000 bytes), which asserts that no part ends with a high surrogate that the next part completes. `packages/backend-dep/test/service.test.ts`, "a large commit over the service is chunked and acknowledged (PRO-018)": a 1,000,000-character insertion (below the 1 MiB `maxCommitBytes`) is sent as chunks, the document service reassembles it, acknowledges it with `seq` + 1, and the stored document holds the text.

**Notes:** Round 3 (2026-11-13, backend-dep): criteria 1, 2 and 5 are ticked with the Evidence above. The reasons given earlier for them are superseded. Criterion 2 is checked on the wire by the property test, which splits in the client's own chunker; the codec's own tests in `packages/protocol` still cover the codec in isolation. What happens when reassembly times out (error or close), and whether `ping` and `pong` may be sent between the chunks of one message, are not stated (Open questions). Chunking is part of the core, not optional (review PR-7). Phase inferred: it belongs to the end-to-end sync and fault-injection scope of 11 §4.

### PRO-019 Keep the connection alive and reconnect with backoff

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 05 §4, §5.1; ADR 0008 · **Requirements:** R7 · **Depends on:** PRO-021, PRO-022, PRO-024

As an author, I want a dropped connection to heal itself, so that I keep working without reloading the page.

**Acceptance criteria**

- [x] Given a side that has sent nothing for `heartbeatMs` (25,000 target until `welcome` says otherwise), when the interval ends, then it sends `ping` and the peer answers `pong`.
- [x] Given any message received, when it arrives, then the idle timer resets; given nothing received for two intervals, then the side closes the connection.
- [x] Given a lost connection, when the client reconnects, then the delay starts at 0.5 seconds, doubles up to a maximum of 30 seconds and uses full jitter (a seeded test checks that each delay is uniform between zero and the current ceiling).
- [x] Given `goaway` with `reconnectInMs`, when the client reconnects, then it uses the server's hint instead of its own backoff.
- [x] Given a page that fires `pagehide`, when it fires, then the client closes the socket so that the page can enter the back/forward cache (verified in a browser test).
- [x] Given a gateway that drops connections idle for 100 seconds, when a document is open and untouched for 10 minutes, then the connection survives because of the heartbeat.

**Evidence:** `packages/backend-dep/test/lifecycle.test.ts` on the virtual clock of `test/support/virtual-time.ts`. Criteria 1 and 2 ("heartbeat: sends ping after heartbeatMs (25,000 ms) without sending" at exactly 25,000 ms; "closes a connection that has heard nothing for two heartbeat intervals" at exactly 50,000 ms with every pong dropped). Criterion 3: the property test "draws each delay uniformly below a ceiling that doubles from 0.5 s to 30 s (full jitter)" (fast-check, 25 seeds; each delay is the draw times the ceiling 500, 1000, ... 30,000 ms, and the schedule is read from the clock's log). Criterion 4: "reconnects after the hint of goaway instead of its own backoff" (4,000 ms, and no jitter draw). Criterion 6: "keeps an open, untouched document alive for ten minutes past a gateway that drops 100 s idle connections" (the gateway is simulated in the test: it cuts a socket after 100 s without a frame in either direction; no cut in 600 s, and 20 or more pings). Criterion 5 (`pagehide`), lane U-PRO-018-034: `packages/backend-dep/src/pagehide.universal.test.ts`, "closes on pagehide, reports a lost connection and reconnects" and "stops listening for pagehide once the backend is closed". The window's `pagehide` is dispatched in Chromium, Firefox and WebKit (`pnpm vitest run --project browser <file>`, 2 tests per browser, passing) and the file is skipped under Node.js. The client's listener is `platform.ts` (`onPageHide`, default from the global `pagehide` event) and `backend.ts` (`pageHidden`, subscribed in `connect()`, removed in `close()`). The socket closes with 1001 and the close is reported as a lost connection with backoff, so the page reconnects if it stays alive; the check reads `connection.status`, not the close frame itself.

**Notes:** What the client does when a page returns from the back/forward cache is not stated; reopening is assumed. Reconnection state shown to the user (`de-status`) is PRO-087. Packet A (2026-11-13): the server half of criteria 1 and 2 is shown by `services/document-service/test/data-plane/session-1b.test.ts` "keep-alive (PRO-019)", which passes. The criteria say "a side", so they stay open until the client's heartbeat (`packages/backend-dep/src/connection.ts`, around lines 215 to 230) has its own test; none names it yet. Criterion 3 is packet B's; criterion 5 is ticked by lane U-PRO-018-034 (see Evidence). Phase inferred: it belongs to the end-to-end sync and fault-injection scope of 11 §4.

### PRO-020 Reserve a binary frame layout for engines with opaque payloads

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | S | could | Maintainer |

**Spec:** 05 §4; 04 §15 · **Requirements:** R6 · **Depends on:** PRO-017

As a maintainer, I want the binary frame layout defined and tested, so that a later engine with opaque payloads can use it without a protocol change.

**Acceptance criteria**

- [x] Given a binary frame, when it is decoded, then it is three unsigned LEB128 integers (`ch`, `kind`, `id`) followed by the payload, verified with vectors that include values 127, 128 and 16,384.
- [x] Given a channel on `pm-steps/1`, when messages are exchanged, then no binary frame is sent (asserted by the kit).
- [x] Given the codec, when it encodes and decodes a binary frame, then the round trip is lossless for payloads of zero bytes and of `maxMessageBytes`.

**Evidence:** `packages/protocol/src/codec/binary.universal.test.ts` (lane PRO-015-028): criterion 1 "decodes ch, kind and id as unsigned LEB128 followed by the payload, at 127, 128 and 16,384" (wire bytes `7f 80 01 80 80 01 09` decode to 127, 128, 16384 and payload `09`), with the single-byte boundaries and a fast-check property over random safe integers (200 runs). Criterion 3: zero-byte and exactly 131,072-byte payloads round-trip, and a fast-check property over random payloads of up to 4,096 bytes (100 runs). The encoding vectors are also in `packages/protocol/src/codec/codec.universal.test.ts`, "encodes ch, kind and id as unsigned LEB128 before the payload". Lane V-PRO-018-034 (2026-11-13), criterion 2: `packages/backend-dep/test/pro-020-no-binary-frames.test.ts`, "sends and receives text frames only while commits are exchanged" (Node.js, memory network, three commits on a `pm-steps/1` channel; every frame the client sends or receives is a string, and the `pm-steps/1` engine appears on the wire; passing with `pnpm vitest run` on that file). The assertion sits in backend-dep's test, not in the conformance kit (`packages/tck`), which the criterion names; moving it into the kit is open.

**Notes:** Criterion 2 (no binary frame on `pm-steps/1`, asserted by the kit) was open until lane V-PRO-018-034 (round 2) ticked it with the backend-dep test named in Evidence; the kit itself does not assert it yet (the criterion's parenthetical), so the owner may want it moved into `packages/tck`. Lane U-PRO-018-034 (round 6) added a wire-level check on the real data plane: `services/document-service/src/data-plane/pro-020-no-binary-frames.test.ts` reads the binary flag of every frame both clients receive over commits and presence on `pm-steps/1` (in-memory stores, Node.js, passing; the presence relay itself is not asserted there). Condition: only if a second engine with opaque payloads is added. What a receiver does with a binary frame on a channel whose engine does not use them is not stated.

## Real-time plane: session (05 §5.1)

### PRO-021 Open a session with hello and welcome

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Integrating developer |

**Spec:** 05 §4, §5.1, §5.7; 10 §3.2 · **Requirements:** R6, R10 · **Depends on:** PRO-006, PRO-010, PRO-017

As an integrating developer, I want a clear handshake that checks my token, my origin and the protocol version once, so that every later message belongs to an authenticated session.

**Acceptance criteria**

- [x] Given an accepted upgrade, when the client sends `hello` as its first message with `versions`, `token`, `client` (`name`, `version`), `engines`, `cdm` (`min`, `max`), `features` and an optional `traceparent`, then the server replies `welcome` with `re` set to the `hello` id and with `version`, `session`, `user` (`id`, `name`), `features`, `limits` and `tokenExp`.
- [x] Given a connection on which no `hello` arrives within 10 seconds, when the time passes, then the server closes with 4408; given a first message that is not `hello`, then the connection is closed with 4400.
- [x] Given an `Origin` header that is not in the tenant's allowed origins, when `hello` arrives (the point at which the tenant becomes known), then the server closes with 4403; the origin is not checked before `hello`.
- [x] Given a `hello` with no version in common, when it is processed, then the server first sends an `error` that lists the server's versions and then closes with 4406.
- [x] Given an invalid, expired or revoked token in `hello`, when it is processed, then the server sends a fatal `error` and closes with 4401.
- [x] Given a client that reconnects, when the new `welcome` arrives, then its `session` is a new identifier and nothing of the earlier session is resumed.

**Evidence:** `services/document-service/test/data-plane/session.test.ts`: welcome with `re`, version, a new UUID version 7 session, the user, features, limits and tokenExp; 4408 without hello and 4400 when the first message is not hello; the origin is checked only when hello arrives (4403); no common version gives an error with the versions, then 4406; an unknown, expired, revoked or forbidden token gives a fatal error and 4401 or 4403; a reconnect gets a new session.

**Notes:** Pitfall PR-5, PR-8. A first message other than `hello` is closed with 4400 by inference ("malformed message"). How the `error` before 4406 carries the versions list is not stated (Open questions). Whether `user.id` is the token `sub` or the per-tenant surrogate is not stated. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a.

### PRO-022 Advertise every limit a client must respect

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Integrating developer |

**Spec:** 05 §5.1; 04 §3.1, §8, §9, §11 · **Requirements:** R6, R9 · **Depends on:** PRO-021

As an integrating developer, I want every limit in `welcome`, so that a client written from the prose alone behaves within what the server will accept.

**Acceptance criteria**

- [x] Given a `welcome`, when `limits` is read, then it contains `maxMessageBytes`, `maxCommitBytes`, `maxStepsPerCommit`, `maxRebaseSteps`, `maxChannels`, `heartbeatMs`, `ackTimeoutMs`, `presenceHz`, `presenceBytes`, `catchUpCommits` and `catchUpBytes`.
- [x] Given a server with default settings, when `limits` is read, then the values equal the defaults named in 04: `maxStepsPerCommit` 500, `maxCommitBytes` 1 MiB, `maxRebaseSteps` 5,000, `ackTimeoutMs` 15,000, `heartbeatMs` 25,000, `presenceHz` 10, `presenceBytes` 1 KiB, `catchUpCommits` 5,000 and `catchUpBytes` 5 MiB (all targets).
- [x] Given advertised values that differ from the defaults, when `backend-dep` runs, then it uses the advertised values for its heartbeat, its acknowledgement timeout, its chunk threshold and its presence rate (verified by changing each value in a mock server).
- [x] Given a commit above `maxCommitBytes` or `maxStepsPerCommit`, when it reaches the server, then the answer is `sync.reject` with `too_large`; a client never builds such a commit in the first place.

**Evidence:** `services/document-service/test/data-plane/session.test.ts` "answers hello with welcome" checks all eleven limits at the defaults of 04 (targets; `maxMessageBytes` and `maxChannels` as in the mock, G18), and "advertises the configured limits". Packet B3 (2026-11-13): `packages/backend-dep/test/lifecycle.test.ts`, "advertised limits (PRO-022 criterion 3)": `heartbeatMs` 5,000 moves the ping to 5,000 ms; `ackTimeoutMs` 3,000 resumes an unanswered commit at 3,000 ms; `maxMessageBytes` 4,096 chunks a 10 kB commit (no frame above 4,096 bytes), and 131,072 does not; `presenceHz` 2 spaces presence updates 500 ms apart; `presenceBytes` 1,024 drops a larger state. Criterion 4, client half: the commits above an advertised `maxStepsPerCommit` and `maxCommitBytes` are refused locally with `too_large` and no frame is sent. The wiring is in `packages/backend-dep/src/backend.ts` (`setLimits` on `welcome`, `limits` when a channel opens).

**Notes:** The defaults of `maxMessageBytes` and `maxChannels` are not named in the spec (the example shows 131,072 for `maxMessageBytes`); the operator sets them (Open questions). Admission control behind `rate_limited` is SYN-037. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Open after the data plane (2026-11-06): criterion 3 is backend-dep's (packet B); criterion 4 holds on the server (`sync.test.ts`), and its client half is backend-dep's. Packet P1 (2026-11-13): `ClientChannel` (`packages/protocol/src/client/channel.ts`, `setLimits`, `CommitLimits`) refuses a commit above `maxCommitBytes` or `maxStepsPerCommit` with a local `too_large` before it is sent (`channel.universal.test.ts`, "refuses locally to build a commit above maxStepsPerCommit or maxCommitBytes"); until backend-dep calls `setLimits` from the advertised `welcome` limits, the 04 defaults apply. Packet B3 (2026-11-13): the wiring is done in `backend-dep` and criterion 3 and criterion 4 are ticked; criterion 4's server half is the `sync.test.ts` case named above.

## Real-time plane: channels (05 §5.2)

### PRO-023 Open a document channel

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Editor |

**Spec:** 05 §5.2; 03 §11; ADR 0001 · **Requirements:** R6, R7 · **Depends on:** PRO-021

As an editor, I want to open a document on the connection and learn where it stands and what I may do, so that I can start editing at the right place.

**Acceptance criteria**

- [x] Given a session, when the client sends `ch.open` with `ch`, `kind: "doc"`, `doc`, `engine`, `cdm` and `features`, then the server answers `ch.opened` with `head`, `incarnation`, `catchUp`, `inflight`, `access` and, if a workflow applies, `workflow`.
- [x] Given a `ch.open` without `resume`, when it is answered, then `catchUp` is `reload`; and given the channel is attached, then the first live commit the client receives is `head + 1`, where `head` is the durable head at the moment of attachment.
- [x] Given a refusal, when the server answers, then it sends `ch.rejected` with one of `not_found`, `forbidden`, `unsupported_engine`, `unsupported_cdm`, `unsupported_feature`, `channel_limit`, `already_open` or `unavailable`; the kit triggers each code (unknown document, no `view`, unknown engine, a `cdm` version outside the server's range, an unannounced feature, `maxChannels` reached, a second channel for one document, a room that cannot be reached).
- [x] Given a document whose `requires` lists a feature the client did not announce in `ch.open`, when the channel is opened, then it is rejected with `unsupported_feature` (03 §11).
- [x] Given a connection that already has a channel for a document, when the client opens a second one for the same document, then it is rejected with `already_open`.
- [x] Given the engine `pm-steps/1` negotiated in `ch.open`, when sync messages are exchanged, then they are the messages of PRO-027 to PRO-030.

**Evidence:** `services/document-service/test/data-plane/sync.test.ts`: ch.opened with head, incarnation, `reload` without resume, access and a view token; a stream from resume.seq + 1 to head, then `sync.caughtUp`, then live commits from head + 1; every refusal code triggered (unknown document, no role in the token, unknown engine, CDM version outside the range, a required feature not announced, a second channel for one document, maxChannels, a room that cannot be opened); the engine `pm-steps/1` carries the sync messages of PRO-027 to PRO-030.

**Notes:** Pitfall PR-3. Which room-side event produces `unavailable` is BE's (BE-001, BE-029). Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a.

### PRO-024 Close channels and drain connections

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Operator |

**Spec:** 05 §5.1, §5.2, §5.7 · **Requirements:** R9 · **Depends on:** PRO-023

As an operator, I want to drain a gateway node and move rooms without errors for users, so that deployments and failovers are invisible.

**Acceptance criteria**

- [x] Given `ch.close` from the client, when it is processed, then the server stops sending messages for that channel and a later `ch.open` for the same document is accepted.
- [x] Given a server-side closure, when the server sends `ch.closed`, then it carries `code`, `reason` and optionally `retryInMs`, with `forbidden` after revocation or loss of access, `unavailable` when the room moves or is fenced, and `slow_consumer` when the client cannot keep up.
- [x] Given `slow_consumer`, when the client receives it, then it reopens the channel with a resume (PRO-095); given `unavailable`, then it backs off for `retryInMs` when present.
- [x] Given a node that is draining, when it notifies clients, then it sends `goaway` with `reconnectInMs` and `reason` for the whole connection and then closes with 4503.
- [x] Given a room that moves or is fenced, when channels close, then each channel gets `ch.closed` and `goaway` is not sent (it is never used for a single channel).
- [ ] Given a rolling restart in the fault-injection profile (PRO-126), when clients follow the hint, then none loses an acknowledged commit.

**Evidence:** `services/document-service/test/data-plane/session-1b.test.ts`, "closing channels and draining (PRO-024; BE-022)": after the client's `ch.close` nothing is sent for that channel and a later `ch.open` is accepted; a drain sends `goaway` with a jittered `reconnectInMs` between 1,000 and 5,000 and a string `reason`, then closes with 4503 and refuses new connections with 503; a room that stops sends each channel `ch.closed` with `unavailable` and no `goaway`. The `slow_consumer` close is in the same file ("bounded send queues (BE-027)"), and `forbidden` after revocation is in `permissions.test.ts`. Round 3 (backend-dep, 2026-11-13), criterion 3, client half: `packages/backend-dep/src/channel-resume.universal.test.ts`, "resumes after retryInMs when ch.closed says %s" (`unavailable` and `slow_consumer`): the channel waits for `retryInMs` and then sends a `ch.open` with a resume. Round 6 (data plane, 2026-11-13), criterion 2: `services/document-service/src/data-plane/close-reasons.test.ts` (forbidden after revocation, unavailable after a room stops and after another node fences the room, slow_consumer; each with a reason). Criterion 6 is unticked (reviewer, group 3 round 2, 2026-11-13): the criterion names the fault-injection profile of PRO-126, which is not built, and whether the data-plane test stands in for it is an owner question. The test passes (re-run by the reviewer, 1 test, PostgreSQL in Podman) and shows the behaviour (lane U-PRO-018-034): `services/document-service/test/data-plane/be-022-rolling-restart.pg.test.ts`, "ends every client with the stored commit sequence after a restart, losing no acknowledged commit" (two planes on one PostgreSQL database in `docedit-test-postgres`; clients receive `goaway` from the draining node, reconnect with resume to the other node, and every acknowledged commit is in the log once; 1 test passing, `pnpm vitest run` on that file).

**Notes:** Criterion 6 stays unticked until the kit profile of PRO-126 runs the rolling restart, or the owner accepts the data-plane test above in its place (the lane had ticked it on that test; unticked by the reviewer). The criterion names the profile; the behaviour it asks for is tested here. Round 6 (data plane, 2026-11-13): criterion 2 is ticked with `services/document-service/src/data-plane/close-reasons.test.ts`, which asserts a non-empty `reason` on `forbidden` (revocation), `unavailable` (room stopped and fenced by another node) and `slow_consumer`, and checks that `retryInMs`, when present, is positive. The fenced close carries no `retryInMs`, which 05 §5.2 allows. Review PR-8 (`goaway` overloaded). Rooms and fencing are BE's. Phase inferred: it belongs to the end-to-end sync and fault-injection scope of 11 §4.

### PRO-025 Join with catch-up by stream

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | L | must | Author |

**Spec:** 05 §5.2, §5.3; 04 §9; 07 §8 · **Requirements:** R7 · **Depends on:** PRO-023, PRO-029, PRO-049

As an author, I want to rejoin a document after a short gap and receive exactly the commits I missed, so that I continue without reloading the content.

**Acceptance criteria**

- [x] Given a client that fetched content at some `seq` over REST, when it opens the channel with `resume.seq` set to it and the incarnation matches and the gap is within `catchUpCommits` and `catchUpBytes`, then `catchUp` is `stream`.
- [x] Given `catchUp: "stream"`, when the channel opens, then the server sends every commit from `resume.seq + 1` to `head`, then `sync.caughtUp` with `seq`, then live commits.
- [x] Given writers that keep committing while a client attaches (stress test), when the client streams, then no commit is missed and none is sent twice, because attaching and streaming are atomic.
- [x] Given `resume.inflight` that names a commit that was stored, when the channel opens, then `inflight` is `accepted` with its `seq` and the commit appears in the stream; given one that was not stored, then `inflight` is `unknown`.
- [x] Given an `inflight` of `unknown`, when `sync.caughtUp` has been received, then the client may resubmit the commit with the same `id`, and not before.
- [x] Given an incarnation that differs, or a `resume.seq` greater than the head, or a `resume.seq` below the visibility gate of the user (PRM-041, PRM-042), when the channel opens, then `catchUp` is `reload`.

**Evidence:** `services/document-service/src/data-plane/resume-catch-up.test.ts` (round data-plane-3, 2026-11-13). Criteria 1 and 2: "streams the commits after resume.seq, then sync.caughtUp, then a live commit": with `resume.seq` at the first of two commits, the stream carries exactly the second, `sync.caughtUp` follows it, and the live commit after it arrives later. Criterion 4: `inflight` is `accepted` with `seq` 2 for a stored commit, which is then in the stream, and `unknown` for an identifier that was never stored (the author's own session only, as the room compares users). Criterion 3 (lane V-PRO-018-034): `services/document-service/src/data-plane/resume-attach-multi-writer.test.ts`, "a client that attaches under two concurrent writers receives each commit once, in order, with none missed" (Node.js, in-memory stores, two writers of 25 commits each while a third client attaches with `resume.seq`; bob receives exactly `resumeSeq + 1` to the last acknowledged seq, once each; passing on four runs, `pnpm vitest run` on that file). It measures no rate, so it is a concurrency check and not a load test. Reviewer (V-PRO-018-034, round 1): criterion 3 unticked. Instrumented, the attach was answered at `head` = `resume.seq` (5) on three runs, with an empty gap, before either writer committed, so every commit arrived as a live commit and the atomic attach-and-stream path was not exercised. Fixer (V-PRO-018-034, round 1, 2026-11-13): criterion 3 ticked again on the rewritten test "a client whose attach is in flight while two writers commit receives each commit once, in order, with none missed". The test now holds bob's `ch.open` on the server, inside the open at its read of the stored permission state (`session.ts`, before `room.open`), until both writers have stored 16 commits, then releases it while they keep committing. It asserts `head >= resume.seq + 16` (a non-empty gap), that `sync.caughtUp` carries `head`, that the commits before it are exactly `resume.seq + 1` to `head` and those after it exactly `head + 1` to the last (with `last > head`), and that every `seq` arrives once. Instrumented on three runs (`pnpm vitest run --silent=false` on that file, this machine): `resume.seq` 5, `head` 23, last 55, 18 commits streamed and 32 live each time. It measures no rate, so it is a concurrency check and not a load test.

**Evidence (criterion 5, lane U-PRO-018-034, round 7):** `packages/backend-dep/test/resume-catch-up.test.ts`, "resubmits the lost commit only after the server has caught the channel up" (Node.js, over the mock DEP server and its catch-up server, not the data plane): the first submit is swallowed, the resume names its id with `inflight` `unknown`, the caller resubmits with the same id, and the wire order is the resumed `ch.opened`, then `sync.caughtUp`, then the second `sync.submit`. Passing with `pnpm vitest run packages/backend-dep/test/resume-catch-up.test.ts` (round 7, 27 tests passing across three files with the PRO-026 and service suites).

**Evidence (criterion 6, lane U-PRO-018-034, round 6):** `services/document-service/src/data-plane/pro-025-visibility-gate-resume.test.ts`, "resume below the visibility gate reloads": a viewer under `editors` who resumes below the head gets `catchUp: reload`; an editor resuming at the same seq gets `stream` (control); a viewer resuming at the head gets `stream` with no commit at or below that seq. Real data plane over in-memory stores, Node.js, `pnpm vitest run` on that file, passing.

**Notes:** The resume algorithm is SYN-026, SYN-028; this story is the wire contract. Phase 1b per the roadmap ("resume with incarnation"). Criterion 3 (stress test with writers): lane U-PRO-018-034 (2026-11-13) added `services/document-service/src/data-plane/resume-attach-under-writes.test.ts`, which attaches a client with `resume.seq` while one writer commits 40 times (in-memory stores, Node.js, passing). It checks that every commit after the resume point arrives once and in order. It is not the stress test the criterion names: there is one writer, not writers in the plural, and no run measures a rate. Lane V-PRO-018-034 added `resume-attach-multi-writer.test.ts` with two concurrent writers, which ticks criterion 3 as a concurrency check (after the round 1 review it holds the attach so that the race is real; see Evidence); a rate-based stress run remains unmeasured. Criterion 5 is the client's wait and is in packages/backend-dep; round 7 (lane U-PRO-018-034) ticks it on the existing test named in its Evidence, which passes and which runs against the mock server, not the document service. Criterion 6 is tested for a different incarnation and for `resume.seq` above the head (`reload`); the visibility-gate case (PRM-041, PRM-042) is tested in `services/document-service/src/data-plane/pro-025-visibility-gate-resume.test.ts` (lane U-PRO-018-034, round 6), so criterion 6 is ticked; see the Evidence line below. The resume in these tests carries the `view` token of the first open, as the protocol requires (`test/data-plane/sync.test.ts`).

### PRO-026 Join with catch-up by page or by reload

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 05 §5.2, §6.2; 04 §9; 07 §8 · **Requirements:** R7 · **Depends on:** PRO-023, PRO-049

As an author, I want a long absence to be handled by paging or by reloading, so that coming back after a day does not stall the server or show stale text.

**Acceptance criteria**

- [x] Given `catchUp: "page"`, when the client has the answer, then it reads the missing commits from `GET /documents/{id}/commits` with `after` and `limit` (at most 200 per page, PRO-040), applies them in ascending order and then expects `head + 1` as the next live commit.
- [x] Given a caller whose visibility gate hides older commits, when it pages through `/commits`, then commits below the gate are not returned (PRM-041, PRM-042).
- [x] Given `catchUp: "reload"`, when the client has the answer, then it MUST fetch `GET /documents/{id}/content?seq={head}` (a pinned read, which can never be stale) and then expects `head + 1`; an unpinned read is never used for this purpose.
- [x] Given a first join without `resume`, when the client follows 05 §5.2 "Joining", then it reads content over REST at some `seq`, opens the channel with `resume.seq` set to it, and ends with the same document as a client that streamed from the start.
- [x] Given a log whose incarnation changed after a database recovery, when a client with unconfirmed work reloads, then the client moves that work to recovered edits (SYN-026, SYN-028).

**Evidence (criteria 4 and 5, lane U-PRO-018-034, round 7):** criterion 4: `packages/backend-dep/test/u-pro-018-034-pro-026-join.test.ts`, "ends with the same commits as a client that streamed from the start" (Node.js, the mock DEP server over the real `Room` and in-memory stores, not PostgreSQL): a client reads the content at head over REST, opens with `resume.seq` set to it, and receives exactly the two later commits; the client that streamed from seq 0 holds the same commits for seqs 4 and 5, byte for byte. Criterion 5: `packages/engine/test/u-pro-018-034-pro-026-incarnation.test.ts`, "reload under the new incarnation replaces the document and keeps the typed letter as recovered" (Node.js, a scripted channel): the in-flight letter goes to recovered edits, the document is the reloaded head, and the next resume names the new incarnation `inc-2`. The recovery is scripted by the test, not a real database recovery. Both passing with `pnpm vitest run` on each file.

**Evidence:** `services/document-service/src/data-plane/read-commits.test.ts` (round data-plane-3, 2026-11-13), criterion 2: "under `editors`, refuses a viewer any page below the head and names no seq" and "under `since_access`, returns only commits after the access time and refuses `after` below it", each read from the room and from storage alone. The paging by cursor with a limit of at most 200 is in the first case of the same file. Criterion 1 (lane U-PRO-018-034, Node.js): `packages/backend-dep/test/pro-026-page-catch-up.test.ts`, "reads three pages of at most 200 in ascending order, then receives head + 1 live" (the client sends `after` and `limit=200` on each page; the test server serves pages of two, so one catch-up takes three reads; then a live commit at head + 1 is delivered; passing with `pnpm vitest run` on that file, with `resume-catch-up.test.ts` passing too). The client change is `PAGE_LIMIT` in `packages/backend-dep/src/backend.ts`. Not run against PostgreSQL.

**Notes:** The `/commits` resource is covered here because paging is its only use in 05. Round data-plane-3 (2026-11-13): criterion 2 is ticked with the Evidence above. Lane U-PRO-018-034 (2026-11-13) ticked criterion 1: backend-dep sent only `after` on each page before, and now sends `limit=200` too; the test named in Evidence covers the pages and `head + 1`. Criterion 3 is ticked by lane V-PRO-018-034 (2026-11-13): a reload asks for the content at the head seq (`packages/engine/test/session.test.ts`, "catch-up reload loads the content at the head and replaces the confirmed document", loads `[7]`, passing) and the backend sends that as `content?seq=N` (`packages/backend-dep/src/backend.universal.test.ts`, "reads content over REST, pinned with ?seq=N", passing in Node.js, Chromium, Firefox and WebKit). Criteria 4 and 5 are client behaviour. Round 7 (lane U-PRO-018-034): both ticked, see the Evidence above; criterion 5's recovery is scripted by the engine test, and criterion 4 runs on the mock server, not the document service.

## Real-time plane: sync messages (05 §5.3)

### PRO-027 Submit a commit and receive the acknowledgement

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Editor |

**Spec:** 05 §5.3; 04 §3.1, §5, §7 · **Requirements:** R7 · **Depends on:** PRO-023, PRO-022

As an editor, I want my changes acknowledged by the server only after they are stored, so that I know when my work is safe.

**Acceptance criteria**

- [x] Given a channel, when the client sends `sync.submit` with `id` (the commit identifier), `base`, `steps` and optionally `origin`, then the envelope `id` correlates the request and the payload `id` identifies the commit.
- [x] Given a stored commit, when the server answers, then `sync.ack` carries `id`, `seq`, `serverTime` and `rebased`, with `re` set to the envelope `id` of the submit.
- [x] Given `rebased: true`, when the acknowledgement is sent, then it also carries `steps`, the mapped steps; given a duplicate of a stored commit by the same user, then the acknowledgement is rebuilt from the stored commit and always carries `steps`.
- [x] Given a commit in flight, when a second `sync.submit` arrives on the same channel before the first is answered, then it is rejected with `busy`.
- [x] Given an acknowledgement, when it is sent, then every commit with a lower `seq` has already been sent on that channel.
- [x] Given a commit with more than `maxStepsPerCommit` steps or more than `maxCommitBytes` bytes, when it is submitted, then it is rejected with `too_large` (PRO-022).

**Evidence:** `services/document-service/test/data-plane/sync.test.ts`: the envelope id correlates, the payload id names the commit; sync.ack with id, seq, serverTime and rebased, `re` the submit, only after storage; rebased acknowledgements and rebuilt duplicates carry steps; busy for a second commit in flight; acknowledgements never ahead of lower commits; too_large above maxStepsPerCommit or maxCommitBytes.

**Notes:** The ordering and deduplication rules are SYN-006, SYN-010; the client's use of `steps` is SYN-017, FE-008. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a.

### PRO-028 Receive a typed rejection with the next action

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Editor |

**Spec:** 05 §5.3, §5.8; 04 §8; review PR-4 · **Requirements:** R3, R7 · **Depends on:** PRO-027, PRO-038

As an editor, I want a rejected change to arrive with a code, a reason and what to do next, so that the editor can explain it and recover without guessing.

**Acceptance criteria**

- [x] Given a rejection, when the server sends `sync.reject`, then it carries `id`, `code`, `message`, `action` (one of `rebase`, `drop`, `reload`, `retry`) and the current `head`, and `re` set to the envelope `id`; optional `scopes`, `rule` and `retryAfterMs` appear only when they apply.
- [x] Given each code, when it is produced, then its action matches 04 §8: `stale_base` and `rebase_failed` give `rebase`; `permission_denied`, `read_only`, `conflict`, `field_invalid` and `too_large` give `drop`; `invalid_op` gives `drop` or `reload`; `busy`, `rate_limited` and `unavailable` give `retry`.
- [x] Given `permission_denied`, when the rejection is sent, then `scopes` lists the scopes involved, each written as `doc`, `body`, `region:<id>`, `defs`, `story:<id>` or `field:<id>`; a value outside that grammar fails the codec check of PRO-004.
- [x] Given `field_invalid`, when the rejection is sent, then `rule` names the rule or constraint that failed (FRW-025, FRW-060, FRW-065).
- [x] Given a rejection with action `retry`, when `retryAfterMs` is present, then the client waits at least that long before resubmitting the same commit with the same `id`.
- [x] Given a `sync.reject` for an unknown `re`, when the client receives it, then it ignores it.

**Evidence:** `services/document-service/test/data-plane/sync.test.ts` "rejections": id, code, message, action, head and `re`, optional members only when they apply, permission_denied naming `region:<id>` scopes in the grammar (the codec validates every outgoing message); the actions are the room table of 04 §8, passed through unchanged by the bridge (`packages/protocol/src/bridge/translate.ts`), seen on the wire for permission_denied, read_only, invalid_op (drop and reload), busy, too_large and unavailable. Client (criterion 6): `packages/protocol/src/client/channel.universal.test.ts` "ignores a sync.reject whose re it does not own". Lane V-PRO-018-034 (2026-11-13), criterion 4: `packages/authority/test/pro-028-field-invalid-rule.test.ts` ("names the rule I15 with field_invalid for a user who may only fill", and "gives invalid_op with no rule for a user who may edit"), Node.js, passing with `pnpm vitest run` on that file; the room sends `rule` from the invariant result (`packages/authority/src/room/room.ts`, `process`; `packages/authority/src/invariants.ts`). The rule named is the invariant `I15` (the constraint on field values, 12 §4.2), not an FRW rule id; see the Notes. Criterion 4 was unticked by the reviewer (group 3, round 2, 2026-11-13): the test reads the room's effect only. The wire message is built by `toReject` in `packages/protocol/src/bridge/translate.ts`, whose input type has no `rule` and which copies only `scopes` and `retryAfterMs`, so a `sync.reject` with `field_invalid` leaves the server without `rule` (`SyncReject.rule` exists in the generated types). It needs `toReject` to forward `rule` and a data-plane test that reads the `rule` on the wire (for example in `services/document-service/test/data-plane/sync.test.ts`). Fixed (V-HIS-001-016, 2026-11-13) and re-ticked: `toReject` now takes `rule` and copies it into `SyncReject` (`packages/protocol/src/bridge/translate.ts`; `room-bridge.ts` passes the room's message unchanged). `services/document-service/test/data-plane/pro-028-field-invalid-rule.test.ts` reads the wire through real WebSocket clients: a fill-only user (Erin, `filler`) who sets a number into the text field receives `sync.reject` with `field_invalid`, `drop` and `rule: 'I15'`; an owner receives `invalid_op` with no `rule`. It passes on the memory stores and on the PostgreSQL test container (`docedit-test-postgres`, own database, dropped afterwards), Node.js, `pnpm vitest run` on that file and the authority file, 4 tests passing. The value `I15` still waits on the owner (Notes; ADR 0310). Lane w5 (2026-11-15), criterion 5: the client that resubmits is the editor's sync session (`packages/engine/src/sync/session.ts`, the `resend` action and `#resendAt`; `packages/engine/src/sync/state.ts`, `receiveReject`), which gets the rejection from `submit()` as a `SyncRejectError` that carries `retryAfterMs` (`packages/protocol/src/ports/errors.ts`; `packages/backend-dep/src/channel.ts`). `packages/engine/test/session.test.ts`, on a manual clock: "waits at least retryAfterMs before it sends the same commit again" (for `busy`, `rate_limited` and `unavailable` with `retryAfterMs` 250: nothing is sent at 249 ms, although more text was typed meanwhile; at 250 ms the same commit goes out with the same `id` and the same steps, and the queued work follows as a new commit after the acknowledgement) and "waits the longer of retryAfterMs and its own backoff when retries repeat" (hints of 30, 5, 5 and 300 ms give waits of 30, 5, 10 and 300 ms: never less than the hint). Node.js, `pnpm exec vitest run --project node packages/engine/test/session.test.ts`, 17 tests passing.

**Notes:** Review PR-4 (rejection without a head). Which code the authority picks is SYN's and PRM's. The scope identifier grammar is defined once here for `sync.reject` and `access` (PRO-032). Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Second review (2026-11-06, SPK-027): SR-K1 keeps `stale_base` with `rebase` for a base older than a snapshot (04 §3.2 as edited; S6's D09 does not stand); SR-K3 puts `read_only` before P6; SR-N25: `quota_exceeded`, `forbidden` and `internal` need an action in 04 §8; SR-M30 proposes recovered edits for every `drop`. Under ADR 0019, `scopes` must never name a hidden scope (SR-M4) ([review](../review/2026-11-06-second-review.md)). Open after the data plane: criterion 4 needs FRW rules, which produce `rule`. Criterion 5 is the caller's wait: `ClientChannel` returns the reject and does not resubmit, so it stays open (packet P1, 2026-11-13). Criterion 6 is met by `packages/protocol/src/client/channel.universal.test.ts` "ignores a sync.reject whose re it does not own" (Node.js). Packet D (2026-11-13): criterion 4 has its conformance check, `checkProblem` in `packages/protocol/src/codec/problem.ts` (a `field_invalid` on `sync.reject` needs a `rule`; `problem.universal.test.ts`), but no FRW rule produces `rule` yet and the server does not call the check, so it stays open. Criterion 5 stays open by decision: `ClientChannel` sends each submit with a new envelope identifier and never resubmits a rejected commit, so a retry with the same `id` and a `retryAfterMs` wait would be a new retry policy that the spec does not give (see ADR 0112, open decisions). Lane V-PRO-018-034 (2026-11-13): criterion 4 ticked. Open question, decided on the spec default and not by the owner: `rule` carries the invariant identifier `I15` (the field-value constraint of 12 §4.2), because no FRW rule fails on a wrongly typed value; if the owner wants an FRW rule id, the room names that rule instead. Recorded as proposed in `docs/adr/0310-lane-V-PRO-018-034.md`. Criterion 5 is unchanged in round 2. Lane w5 (2026-11-15): criterion 5 ticked. The earlier notes looked only at `ClientChannel` (the protocol package's message client), which does not resubmit. The caller that 04 §8 means is the sync session of the engine, and it already waited and resent with the same `id`; only the test of the wait was missing. This follows the spec's text (04 §8, "Resubmit the same commit with the same `id` after the indicated delay") and decides nothing new. Still open for the owner (ADR 0112, open decision): the spec gives no bound on how many times a `retry` is repeated, and the session has none: it retries, never sooner than the hint and its own backoff, until the commit is acknowledged, refused with another action, or the channel closes.

### PRO-029 Receive other people's commits in order

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Editor |

**Spec:** 05 §5.3; 04 §3.2, §10 · **Requirements:** R4, R7 · **Depends on:** PRO-023

As an editor, I want to receive other people's changes in order with the author stamped by the server, so that my document converges and history is attributable.

**Acceptance criteria**

- [x] Given commits to broadcast, when the server sends `sync.commit`, then `commits` is an array in ascending `seq` without gaps, each element holding `seq`, `kind`, `id`, `steps`, `control`, `author` (`user`, `session`, `agent`), `serverTime` and `origin`.
- [x] Given `kind: "steps"`, when the element is read, then `steps` is present; given `kind: "control"` (for example a grants revision), then there are no steps and `control` describes the change, and the client advances its `seq` for both.
- [x] Given a commit authored by the server (restore, import, prefill, migration), when it is sent, then `author.session` is null.
- [x] Given a client that put identity fields or an `origin` into a submitted commit, when the commit is broadcast, then the author fields are those the server stamped and `origin` is recorded as the client's claim only.
- [x] Given several commits coalesced into one message, when the client reads it, then the sequence rule still holds across messages: the next message starts at the previous last `seq` plus one.

**Evidence:** `services/document-service/test/data-plane/sync.test.ts` "broadcasts and attribution": commits in ascending arrays with every member of D10, author stamped from the connection whatever the client claims, origin recorded as a claim, consecutive commits coalesced with the next array continuing at the last seq plus one; control commits with no steps, `control: { type: "grants", rev }` and a null session (`permissions.test.ts`).

**Notes:** `agent` is not defined in 05 (08 §2 names the assistant). Coalescing is SYN-037. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a.

### PRO-030 Reload after a snapshot and detect divergence

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | should | Author |

**Spec:** 05 §5.3; 04 §3.2, §13 · **Requirements:** R7 · **Depends on:** PRO-029, PRO-049

As an author, I want the editor to reload cleanly when the server replaces the document and to notice if my copy ever drifts, so that I never keep editing a wrong document.

**Acceptance criteria**

- [x] Given a snapshot commit (import, restore, migration or repair), when it is stored, then every client on the channel receives `sync.reset` with `seq` and `reason` set to `import`, `restore`, `migration` or `repair`.
- [x] Given `sync.reset`, when the client handles it, then it fetches the content at `seq` (a pinned read) and continues from `seq + 1`.
- [ ] Given a commit whose `base` is older than a snapshot commit, when it is submitted, then it is rejected with action `reload` (SYN-006, SYN-010).
- [x] Given `sync.check` with `seq` and `hash` (SHA-256 of the canonical form), when the client's confirmed document is at that `seq`, then it compares hashes; on a mismatch it reloads the document and reports the event.
- [x] Given a `sync.check` for a `seq` the client is not at, when it arrives, then the client ignores it.

**Notes:** Review PR-7 (`sync.reset`). The server MAY omit `sync.check`; it is not a security control. Restore and import resets arrive in phase 2; the message is defined in 1b. Phase inferred: it belongs to the end-to-end sync and fault-injection scope of 11 §4. Second review (2026-11-06, SPK-027), SR-K1: the third criterion changes: such a commit is rejected with `stale_base` and action `rebase` (04 §3.2 as edited), because the client has already handled `sync.reset`. SR-M6 and SR-M9: under ADR 0019 an access change is a close and a forced reload carrying a view token, not a `sync.reset` reason ([review](../review/2026-11-06-second-review.md)).

**Evidence:** `services/document-service/src/data-plane/snapshot-reset.test.ts` (round data-plane-3, 2026-11-13). Criterion 1 is ticked (lane U-PRO-018-034): `packages/authority/test/pro-030-snapshot-reasons.test.ts` runs the room for each of the four reasons and checks that each of three open channels gets one `sync.reset` with that `seq` and `reason` (Node.js, in-memory, 4 tests passing; `pnpm vitest run` on that file). The import case over the whole data plane is the test above. A snapshot stored through `replaceContent` sends `sync.reset` with its `seq` and `reason: "import"` to each open channel (alice and bob). The reason is passed through from the snapshot commit (`packages/authority/src/room/room.ts`, the `sync.reset` message); `restore`, `migration` and `repair` take the same path and are not tested. Lane V-PRO-018-034 (2026-11-13), criteria 2, 4 and 5 (client, engine): `packages/engine/test/session.test.ts`, run with `pnpm vitest run` on that file (15 tests passing). Criterion 2: "a reset loads the content pinned at its seq, then the next commit is seq + 1" (the load is asked for `seq` 9, the confirmed seq becomes 9 and then 10). The pinned query is `packages/backend-dep/src/backend.universal.test.ts`, "reads content over REST, pinned with ?seq=N" (not re-run here). Criterion 4: "a divergence check that does not match reloads the document" and "a divergence reloads the document and reports it with the code divergence"; "a divergence check that matches takes no action". Criterion 5: "a divergence check at another seq is ignored".

**Notes:** Criterion 2 is the client's pinned read and continuation, in packages/backend-dep; the server's continuation at `seq + 1` is shown by the second test of `snapshot-reset.test.ts`. Criterion 3 stays open on a conflict between the story and the review. The text says `reload`; the second review (SR-K1, 04 §3.2 as edited) says `stale_base` with `rebase`. The room does reject such a commit (`snapshot-reset.test.ts`, "refuses a commit whose base is older than the snapshot"), with `stale_base` and `rebase`, so the server follows the review and not the criterion as written. This is an open question for the owner (proposed record in `docs/adr/0150-data-plane-3-backlog-batch.md`); it is not decided here. Lane V-PRO-018-034 ticked criteria 2, 4 and 5 on the engine's client session (Evidence above). The server sends `sync.check` in `room-host.ts` (SYN-043); no test in this round checks that server send. Criterion 3 stays open: the room refuses such a commit with `stale_base` and action `rebase` (see the snapshot-reset test), which differs from the `reload` in the criterion as written; the owner decides the wording.

## Real-time plane: presence (05 §5.4)

### PRO-031 Share selections between sessions

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Editor |

**Spec:** 05 §5.4; 04 §11 · **Requirements:** R7 · **Depends on:** PRO-023

As an editor, I want to see where others are working and to publish where I am, so that we avoid editing the same sentence.

**Acceptance criteria**

- [x] Given the feature `presence`, when a client sends `presence.update` with `seq` and `state` (`selection` with `anchor` and `head`, `scope`, and `status` of `active` or `idle`), then positions refer to the confirmed document at that `seq`.
- [x] Given updates, when the server sends `presence.state`, then `peers` is an array of `session`, `user` (`id`, `name`), `seq` and `state`, and `left` lists the sessions that went away.
- [x] Given a client that puts another user's identity into its state, when the server relays it, then the identity is the one the server derived from the session.
- [x] Given a `state` that does not match its schema or exceeds `presenceBytes` (1 KiB target), when it arrives, then it is not relayed.
- [x] Given more than `presenceHz` updates per second (10 target) from one client or a loaded server, when updates arrive, then the server drops or coalesces them without an error that closes the connection.
- [x] Given a server restart, when clients reconnect, then no presence from before the restart is shown, because presence is never stored.
- [x] Given a server without the feature `presence`, when a client connects, then it sends no `presence.update`.

**Evidence:** `services/document-service/test/data-plane/presence.test.ts`: presence.state with session, user, seq and state, and left; identity from the session, only the members of 05 §5.4 relayed; a state above presenceBytes or outside the schema is not relayed; more than presenceHz updates a second are coalesced without closing; nothing is stored, and a new room shows nobody (`src/data-plane/presence.ts`).

**Notes:** The mapping of positions through later steps is SYN-036; showing carets is UX's. Phase 1a: the minimum demo shows presence in the header. Criterion 7 is client behaviour; a server configured without `presence` does not announce it and relays nothing (`presence.test.ts`). Criterion 7 (client): `packages/backend-dep/src/backend.universal.test.ts` "uses no feature the server did not announce: no presence port, no presence.update, ch.open within welcome.features" (lane PRO-029-042; not re-run this round, it is a universal test that runs under Node.js too).

## Real-time plane: permissions (05 §5.5)

### PRO-032 Receive effective access when a channel opens

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Editor |

**Spec:** 05 §5.5; 07 §4 · **Requirements:** R3 · **Depends on:** PRO-023

As an editor, I want to know before I try what I may change in each part of the document, so that the editor only offers what will be accepted.

**Acceptance criteria**

- [x] Given `ch.opened`, when `access` is read, then it holds `rev`, `asOfSeq`, `docRole`, `caps`, `scopes`, `leases`, `fill` and `restrictions`, with `fill` null and `restrictions` empty when they do not apply.
- [x] Given `caps`, when it is read, then it lists the document-level capabilities, including `structure` and `manage` when the user holds them.
- [x] Given a document with regions, when `scopes` is read, then it lists every region as `region:<id>` with its capabilities and also `body` and `defs`, each key following the scope grammar of PRO-028.
- [x] Given a commit that creates region R, when the client has received it and has no `access` with `asOfSeq` at or after that commit, then the client treats R as not editable until such an `access` arrives (a browser test checks that typing into R is refused locally).
- [x] Given an `access` object with an unknown field, when the client reads it, then the field is ignored (PRO-005).

**Evidence:** `services/document-service/test/data-plane/sync.test.ts` "answers ch.open with ch.opened": access with rev, asOfSeq, docRole, caps including structure and manage for the owner, scopes for doc, body, defs and every region, leases, `fill` null and `restrictions` empty. Criterion 4 (lane V-PRO-018-034): `packages/engine/src/pro-032-region-access.universal.test.ts`, "refuses typing into the region when the access has no entry for it" and "accepts typing into the same region once an access lists it with edit". Run with `pnpm vitest run --project browser` on that file: Chromium, Firefox and WebKit, 6 tests passing. The test types through the core's text input path, which runs the same transaction filter as the editor's keys; it does not dispatch DOM key events, and the `asOfSeq` condition is modelled by the access listing the region. Reviewer (V-PRO-018-034, round 1): criterion 4 unticked. That test drives the headless `DocumentCore` (no view, no DOM key events) and repeats `packages/engine/test/guard.test.ts` "a region the access does not list is not editable until an access lists it" in a browser worker, so it is not the browser test that types into the editor; no commit that creates R and no `asOfSeq` comparison is exercised either. It needs a Playwright test on the element. Fixer (V-PRO-018-034, round 1, 2026-11-13): criterion 4 ticked again on `packages/element/e2e/pro-032-region-access.spec.ts`, "PRO-032: typing into a region created by a commit is refused until an access with asOfSeq at or after it arrives". The element is mounted on the embed page's regions document with the in-memory backend; a second user (owner) stores a commit that creates region R, and the mock sends `perm.changed` after it. The test holds the delivery of `access` on the element's channel (standing for `perm.changed` arriving later than the commit), checks that the held access has `asOfSeq` at or after the commit and lists R while the core's access has an older `asOfSeq` and does not, then clicks into R and types with real key events: the text is unchanged and the guard raises a `scope` refusal naming `region:<R>`. After the access is released the core lists R with `edit`, the same typing goes through, and the other user's channel receives the commit. Passing in Chromium, Edge, Firefox and WebKit, twice each with no retries (`pnpm exec playwright test -c packages/element/playwright.config.ts pro-032-region-access --repeat-each 2 --retries 0`, demo server on port 57574). The duplicate headless test `packages/engine/src/pro-032-region-access.universal.test.ts` was removed; the Node.js case stays in `packages/engine/test/guard.test.ts`. Criterion 5 (lane U-PRO-018-034, round 4): `packages/protocol/src/client/access-unknown-field.universal.test.ts`, "opens and goes live without rejecting the unknown field", now asserts that the host does not receive `futureRule`; `knownAccess` in `packages/protocol/src/client/channel.ts` keeps only the eight members of `access` (05 §5.5) for `ch.opened` and `perm.changed`. Run with `pnpm vitest run` on the client test files named there (Node.js): 104 tests in 12 files passing.

**Notes:** The contents of `access` are computed by PRM-004, PRM-006. Review PR-9 (`access` semantics). Whether `access` should be a delta for documents with hundreds of regions is open (05 §12). Second review (2026-11-06, SPK-027), SR-M6: under ADR 0019 `access` must say which scopes are hidden, and `ch.opened` carries the view token of S12; the protocol has no place for either yet ([review](../review/2026-11-06-second-review.md)). Criteria 4 and 5 are client behaviour. Lane PRO-029-042 (2026-11-13): criterion 5 stays open. The channel does not reject an `access` with an unknown member and reads the known ones (`packages/protocol/src/client/access-unknown-field.universal.test.ts`, Node.js, passing), but it hands the object on with the unknown member still present, so "ignored" is not met as written. Whether the client should strip unknown members is an open question, recorded in `docs/adr/0213-lane-PRO-029-042.md`. Lane V-PRO-018-034 (2026-11-13) ticked criterion 4 with the browser test named in Evidence (after the round 1 review, the Playwright test on the element). Criterion 5 was then open: the client handed the unknown member on, and whether it must strip it was left to the owner (proposed record `docs/adr/0310-lane-V-PRO-018-034.md`). Lane U-PRO-018-034 (round 4) ticked criterion 5 on the spec default (PRO-005, ignore what is not known): `knownAccess` in `packages/protocol/src/client/channel.ts` strips unknown top-level members before the host sees them; the owner may choose otherwise (`docs/adr/0310-lane-U-PRO-018-034.md`, proposed). Criterion 4 stays open in round 4: `packages/backend-mock/src/document.ts` sends `perm.changed` straight after the commit that creates a region, so the window the criterion tests cannot be reached through the mock; a hold on access delivery in backend-mock and a Playwright spec under `packages/element/e2e` are the planned route.

### PRO-033 Receive live permission changes

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Editor |

**Spec:** 05 §5.5, §6.2; 07 §4, §9 · **Requirements:** R3 · **Depends on:** PRO-032, PRO-052

As an editor, I want a change to my rights to reach me without a reload, and to take effect on the server at once, so that I cannot keep editing where I lost the right.

**Acceptance criteria**

- [x] Given a grant change, when the owner's `PATCH` returns, then every affected connection receives `perm.changed` whose payload is a complete new `access` object (not a delta), with a higher `rev` than the one before.
- [x] Given changes to grants or to the region list, when `perm.changed` is sent, then `rev` increases on each change and never repeats or decreases on one connection.
- [x] Given the expiry time of a grant, when it passes, then `perm.changed` is sent at the expiry without any other triggering event.
- [x] Given a client that has not yet received `perm.changed`, when it submits a commit that the new permissions forbid, then the server rejects it with `permission_denied` because enforcement starts when the server computes the permissions, not when the client receives them.
- [x] Given a grants change, when the stream is read, then a `control` commit with the new grants revision precedes `perm.changed`, and `asOfSeq` is that commit's `seq`.

**Evidence:** `services/document-service/test/data-plane/permissions.test.ts`: after a grant change every channel gets the control commit and then perm.changed, a complete access object whose rev rises on each change and whose asOfSeq is the control commit; a commit sent before the client read perm.changed is refused under the new grants; a grant that expires sends perm.changed with no other event (`Room.expire()` at `Room.nextExpiry`).

**Notes:** Token-driven changes are PRO-014; document state changes are PRO-047; region states, leases and workflow are PRO-034. The race and the grants-revision condition are PRM-019, PRM-020, PRM-022 and 04 G7.

### PRO-034 Receive permission changes caused by region states, leases and workflow

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | S | should | Editor |

**Spec:** 05 §5.5; 07 §10, §11; 12 §10 · **Requirements:** R3, R13 · **Depends on:** PRO-033, PRO-053

As an editor, I want an approval, a lease or a workflow step to show up in my rights immediately, so that I see why a region became read-only.

**Acceptance criteria**

- [x] Given a region set to `approved`, when the state changes, then every connection receives `perm.changed` in which that region's scope is limited to `view` and `comment`.
- [x] Given a lease acquired on a region, when it starts, then `access.leases` has an entry for that region with `holder` and `expiresAt`, and other users' capabilities in the region are limited; given the lease ends (release, expiry or break), then a new `perm.changed` follows, at the expiry time when it expires.
- [ ] Given a workflow transition that changes what is allowed, when it happens, then `perm.changed` is sent with a higher `rev`, in addition to the `wf.changed` of 12 §10.
- [x] Given a region deleted by a commit, when the client receives `perm.changed`, then the region is absent from `scopes`.

**Evidence:** `services/document-service/src/data-plane/region-state-changes.test.ts` (round data-plane-3, 2026-11-13). Criterion 1: "approving a region sends perm.changed to every connection, limited to view and comment" (owner, editor and viewer each receive it; the scope is `['view','comment']` for the owner and the editor), and "a commit into an approved region is refused for an editor under the new access" (`permission_denied`, action `drop`). Criterion 2 is partly shown there: the holder appears in `access.leases`, edit is removed from the other connection, and the release and the expiry each send a new `perm.changed` (the expiry with no other event). Criterion 4: "after a commit that deletes region R, perm.changed does not list region:R in scopes". Lane U-PRO-018-034 (2026-11-13), criterion 2, the break case: `services/document-service/src/data-plane/lease-break.test.ts`, "breaking a lease held by another user sends a new perm.changed that gives edit back" (Node.js, in-memory stores, passing; run with `pnpm vitest run` on that file and `region-state-changes.test.ts`, 7 tests passing). The data plane has no separate break path; the test covers the observable result of the same `removeLeases` change.

**Notes:** `wf.changed` itself is FRW-025, FRW-060, FRW-065. Round data-plane-3 (2026-11-13): criterion 2 stayed open because a `break` of a lease had no test; lane U-PRO-018-034 added that test and ticked the criterion. The break through the control-plane `DELETE` route (PRM-053) is not checked here. Criterion 3 stays open: the data plane has no workflow transition path and no `wf.changed` (`perms.workflowActive` only gates snapshot writes and restore in `room.ts`), so FRW-025 and FRW-060 come first. The same region cases also appear in `test/data-plane/permissions.test.ts` ("each trigger of a new access"). Lane V-PRO-018-034 (2026-11-13, round 2), criterion 3 stays unticked: `services/document-service/src/data-plane/pro-034-workflow-perm-changed.test.ts`, "starting a workflow sends every connection a perm.changed whose rev is above its opening rev" (Node.js, in-memory stores, passing) shows the permission half through the `workflowActive` change of `changeGrants`: each of owner, editor and viewer gets one `perm.changed` with a higher `rev` than at `ch.open`. The `wf.changed` event of 12 §10 is still not sent, and no workflow transition path exists in the data plane, so the criterion as written is not met (FRW-025 and FRW-060 first).

**Notes (lane w5, 2026-11-17):** Blocked; nothing new ticked. Criterion 3 needs wf.changed (12 §10), which no non-test code raises (the only reference is services/document-service/src/data-plane/pro-034-workflow-perm-changed.test.ts), and a workflow transition path in the data plane. Both need FRW-025 and FRW-060, which are not built on stories/integration.

## Real-time plane: notifications (05 §5.6)

### PRO-035 Be told that a job, an asset or the document changed

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 05 §5.6; ADR 0008 · **Requirements:** R5, R6 · **Depends on:** PRO-023, PRO-040

As an author, I want to be told when my export, my image upload or the document metadata changed, so that the editor updates without polling.

**Acceptance criteria**

- [x] Given an `event` message, when the client reads it, then it has `type`, `resource` (relative to the `rest` base), optional `rev` and optional small `data`, and it means "fetch the resource over REST if you care".
- [x] Given an export job, when it progresses, completes, fails or is cancelled, then `export.progress`, `export.completed`, `export.failed` and `export.cancelled` events are sent with the job as `resource`.
- [x] Given an asset, when the asset worker finishes, then `asset.ready` or `asset.failed` is sent with the asset as `resource`.
- [x] Given a change to document metadata or state, when it is stored, then `document.updated` is sent.
- [ ] Given an event type the client does not know, when it arrives, then the client ignores it (PRO-005).
- [x] Given the types in this story, when their stems are compared with the webhook names (`dep.` prefix, PRO-072, PRO-073) and the DOM events (`de-` prefix, PRO-086), then the export stems agree (`dep.export.completed.v1`, `de-export-completed`).

**Evidence:** criterion 3: `services/document-service/test/control-plane/routes.assets.test.ts` ("completes an upload through the asset worker, which raises asset.ready to the uploader" and "fails an upload whose content differs from its declared type, with asset.failed"), with `resource` `/assets/<id>`; memory storage run on 2026-11-13. Criterion 4 (partly): `services/document-service/test/control-plane/notify-document-updated.test.ts` shows `document` reaches the data plane after a stored state change (after the permissions) and after a deletion, and nothing for a state that does not change. Lane U-PRO-035-051 (2026-11-13), criteria 2 and 4 ticked: `services/document-service/test/control-plane/pro-035-notifications.test.ts` (memory and PostgreSQL, 4 tests passing) shows that `DELETE /exports/{jid}` of a queued job raises `export.cancelled` with the job as resource, addressed to the requester, and that a stored metadata `PATCH` raises one `document.updated` while a refused one (stale `If-Match`) raises none; `services/document-service/src/data-plane/notifications.test.ts` (9 tests passing) covers the channel side of `export.progress`, `.completed`, `.failed` and `.cancelled` and of `document.updated`. Fixer U2 group 2 round 1 (2026-11-13): `pro-035-notifications.test.ts` also shows that a `PATCH` leaving title, properties and state as they were raises nothing and a changed property alone raises one (memory and PostgreSQL, 6 tests passing); `notify-document-updated.test.ts` (3) and `routes.documents.test.ts` pass with it, 43 tests in all, run on 2026-11-13. Lane V-PRO-035-051 (2026-11-13), criterion 1 ticked: `packages/backend-dep/test/pro-035-events.test.ts` (Node, `pnpm vitest run --project node <file>`, 3 tests passing; in-memory network, so the frames are the wire's): an `event` with `rev` and `data` reaches `onEvent` equal to what was sent (`toStrictEqual`), and a bare one keeps `rev` and `data` absent. Lane w5 (2026-11-17), criterion 6: `packages/element/test/pro-035-export-stems.test.ts` (Node.js, 5 of 5 pass): the notification types and webhook names are read from `DEP1`, the DOM name from `exportEvent` (`src/export.ts`). `completed` and `failed` agree in all three (`export.completed`, `dep.export.completed.v1`, `de-export-completed`; the same for `failed`); `progress` has a notice and a DOM event and no webhook; `cancelled` has a notice only (the DOM reports it as `de-export-failed`, as `src/export.ts` documents). The set of stems is checked in both directions, so a new export type or webhook without a counterpart fails the test.

**Notes:** Which connections receive a given event is not stated (Open questions). The three vocabularies are not identical (for example `document.updated` and `dep.document.changed`); see Open questions. Review PR-15. Phase inferred: it belongs to the end-to-end sync and fault-injection scope of 11 §4. Round data-plane-3 (2026-11-13), no criterion ticked: `services/document-service/src/data-plane/notifications.test.ts` (9 tests) shows the server half. Criterion 1: type, resource, `rev` and `data` reach the channel unchanged, and absent fields stay absent. Criterion 2: `export.progress`, `.completed`, `.failed` and `.cancelled` with the job as resource reach the requester's channels only, and not another open channel of the document. The emitters are in `control-plane/exports.ts` and `control-plane/export-routes.ts`; `export.cancelled` has no test, and the requester is matched by `createdBy` against the channel's `sub`, which the control plane does not test. Criterion 4: `document.updated` reaches every open channel of the document on `documentChanged`, not those of another document; the call from `control-plane/handlers.ts` after a write is not tested. Criterion 3 is raised in `control-plane/assets.ts` and its test is in `test/control-plane/routes.assets.test.ts`, which was not run in this round, so it is not cited. Criteria 1 and 5 need the client's reading and ignoring (`packages/backend-dep`, `packages/protocol`). Criterion 6 is open: the DOM names `de-export-*` are PRO-086, which `packages/element/src/export.ts` leaves out, and only the webhook half is tested. Lane PRO-029-042 (2026-11-13): criterion 4 stays open. `handlers.ts` calls `documentChanged` only for a state change that alters the permissions and for a deletion; a PATCH that changes only the title, properties or classification stores the change (`storage/memory.ts` `update`) and sends no `document.updated`, so the criterion's "document metadata" is not met. Criterion 2 stays open: `export.cancelled` is raised in `control-plane/export-routes.ts`, and the requester match is still untested. Lane U-PRO-035-051 (2026-11-13): criteria 2 and 4 are ticked (see Evidence). The control plane's notice is addressed to the job's `createdBy`, which the test checks only as a string; the match of that principal to a channel's `sub` is not tested. Criteria 1, 5 and 6 stay open: the client's reading and ignoring of events (`packages/backend-dep`, `packages/protocol`) and the `de-export-*` DOM names (PRO-086) are not built. Fixer U2 group 2 round 1 (2026-11-13), decision: "a change ... when it is stored" is read as a field that differs from the stored record. The stores raise `metaRevision` on every update, so `handlers.ts` compares title, properties (canonical JSON), classification label and state before raising `document.updated`; a `PATCH` that changes nothing still gets a new ETag but tells no channel. Lane V-PRO-035-051 (2026-11-13): criterion 5 stays open. The new test shows that an event of an unknown type does not close or fail the channel and that a later known event still arrives, but the client passes that event to `onEvent` as received, and no consumer in the editor switches on event types yet, so "ignores it" is not shown as a consumer behaviour. Criterion 6 stays open (PRO-086 `de-export-*` names not built). Lane w5 (2026-11-17): criterion 6 is ticked now that the `de-export-*` names exist (PRO-086; see Evidence). Criterion 5 stays unticked: `packages/backend-dep` hands every `event` to `onEvent` without looking at its type and does not fail on an unknown one (`pro-035-events.test.ts`), but the editor has no consumer of notifications yet (no code in `packages/engine` or `packages/element` reads `onEvent` or switches on `type`), so there is no client behaviour of "ignoring" to test. A consumer, with unknown types dropped, is built with the first story that acts on a notification (PRO-036, PRO-063 progress without polling).

### PRO-036 Be told about threads, comments, versions and imports

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Commenter |

**Spec:** 05 §5.6; ADR 0015 · **Requirements:** R4, R8 · **Depends on:** PRO-035, PRO-059

As a commenter, I want to see new threads, replies and versions as they happen, so that a conversation in the document feels live.

**Acceptance criteria**

- [x] Given thread activity, when it happens, then `thread.created`, `thread.updated`, `thread.resolved`, `thread.reopened` and `thread.deleted` are sent with the thread as `resource`.
- [x] Given a thread event, when it is sent, then its `data` carries the thread's current range and the `seq` that range refers to, so the client can place the decoration without a fetch (SYN-032).
- [x] Given comment activity, when it happens, then `comment.created`, `comment.updated` and `comment.deleted` are sent.
- [x] Given a named version or a restore, when it is stored, then `version.created` or `version.restored` is sent.
- [ ] Given an import job, when it ends, then `import.completed` or `import.failed` is sent with the job as `resource`.
- [x] Given a user without `view` on the document, when these events are produced, then the user receives none of them.

**Evidence (lane w5, 2026-11-17):** criteria 1 to 4 and 6. `services/document-service/test/control-plane/pro-036-thread-events.test.ts` (6 tests, memory and PostgreSQL in Podman, `pnpm exec vitest run --project node <file>`, all passed): each thread route sends its notice with `/threads/{id}` as `resource` (`thread.created`, `thread.updated` on an assignee change, `thread.resolved`, `thread.reopened`, `thread.deleted`); `data` carries `state`, the head `seq` and, for a range thread, `range` mapped from the seq it was made at (a typing commit moves it from `[p, p+5)` to `[p+2, p+7)` and the later events show the new range and the commit's `seq`), or `block` for a block thread; the comment routes send `comment.created`, `comment.updated` and `comment.deleted` with `/comments/{id}` as `resource`. `pro-036-live-events.test.ts` (6 tests, same storage, all passed) runs the real data plane with a channel open on the document: an editor's channel receives `thread.created`, `comment.created`, `thread.resolved`, `version.created` and `version.restored` as `event` messages (`version.restored` is new: `restore-route.ts`); a thread and a comment in the restricted legal region, hidden from editors by the visibility policy, reach an owner's channel and not the editor's (`HostedRoom.notify` takes the notice's `scopes` and skips a channel whose reader cannot see a region among them); a token with no role in the document gets `ch.rejected` `forbidden`, so it has no channel to send to. Decisions: the notice carries `scopes` and the data plane filters on them (`DataPlane.notify` has a new optional `scopes`); the data of `thread.deleted` is the range at the head when it was deleted.

**Notes:** Lane w5 (2026-11-17): criterion 5 stays unticked: no import route or import job exists (`POST /documents/{id}/imports`, PRO-066), so there is nothing that ends and could send `import.completed` or `import.failed`. Second review (2026-11-06, SPK-027), SR-M5: under ADR 0019, events about threads and comments in hidden content must not reach readers without access, and webhooks should carry the scope so that a host does not relay them (for example a mention) to someone who cannot read it ([review](../review/2026-11-06-second-review.md)). Lane PRO-029-042, round 3: no criterion ticked. The producers are missing in `services/document-service/src`: thread, comment and version-restore routes are not built (PRO-054, PRO-056, PRO-059, PRO-060), and no import route exists (PRO-066), so no thread, comment, version or import event is raised. `notify` in the data plane carries any `Notification` but has no caller for these types.

## Real-time plane: close codes and the error registry (05 §5.7, §5.8)

### PRO-037 Close the connection with a defined code and a matching error

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Integrating developer |

**Spec:** 05 §5.1, §5.7 · **Requirements:** R6 · **Depends on:** PRO-017, PRO-038

As an integrating developer, I want every connection-level failure to end in a documented close code preceded by a machine-readable error, so that my client knows whether to retry.

**Acceptance criteria**

- [x] Given an `error` message, when it is sent by either side, then it carries `code`, `message`, `retryable`, `retryAfterMs` and `fatal`, with `re` when it answers a message.
- [x] Given a fatal `error`, when it is sent, then it is followed by the matching close code.
- [x] Given each trigger, when it happens, then the close code is: 4400 malformed message, 4401 unauthenticated or token expired or revoked, 4403 forbidden including a disallowed origin, 4406 no common protocol version (preceded by an `error` that lists the server's versions), 4408 `hello` not received in time, 4413 message too large, 4429 rate limited, 4500 internal error, 4503 unavailable or draining (the kit triggers each one).
- [ ] Given any server behaviour exercised by the kit, when a connection is closed by the server, then the close code is one of the nine above and never another.

**Evidence:** `services/document-service/src/data-plane/session.ts` and `wire.ts`: every error carries code, message, retryable and fatal (retryAfterMs when it applies) and `re` when it answers; a fatal error is followed by the close code D25 implies (`test/data-plane/session.test.ts`, which also checks that every close it saw is one of the nine).

**Evidence (criterion 3, lane V-PRO-035-051, 2026-11-13):** each of the nine codes is triggered on a real WebSocket against the data plane by the service's tests, run with `pnpm vitest run --project node <file>`: 4400 `session.test.ts` (first message not hello); 4401 `session.test.ts` (unknown token); 4403 `session.test.ts` (disallowed origin); 4406 `session.test.ts` (no common version, with the `error` that lists the server's versions); 4408 `session.test.ts` (no hello in time); 4413 `session.test.ts` (frame above `maxMessageBytes`); 4429 `session-1b.test.ts` (frames over the limit before hello); 4503 `session.test.ts` (drain); 4500 `test/data-plane/pro-037-internal-close.test.ts` (1 test passing: a quota check that throws in the hello handler gives a fatal `internal` error with no `re`, the thrown error reaches the error sink, the client never sees its text, and the close is 4500). A throw inside a room is answered as `unavailable` on the channel by the room, so that is not the 4500 path. The kit (PRO-108) is not built; these tests trigger the codes, and PRO-108 is to run the same triggers.

**Notes:** The mapping from fatal error codes to close codes is implied by the meaning column and not tabulated (Open questions). Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Open after the data plane: criterion 3, 4429 is now sent for an address over its frame limit before `hello` (BE-030, `test/data-plane/session-1b.test.ts`), but the other triggers are not all tested, and 4500 only when the server builds an invalid message, which no test triggers; criterion 4, a frame above eight times `maxMessageBytes` is cut by the WebSocket layer with 1009 before it is read (ADR 0035). Data-plane round 3 (2026-11-13): 4500 is sent only when a handler throws after `hello` (the fallback in `#enqueue`, `src/data-plane/session.ts`); no test triggers it, and this packet owns no seam that makes a handler throw (the test hooks are in `src/seams.ts`). Criterion 4 also needs a decision: the 1009 close is not one of the nine codes, so ADR 0035 must map it or the criterion must change. Lane w5 (2026-11-15): criterion 4 stays unticked; the kit's half is built, the server's is not met. The kit now holds every connection of every scenario against 05 §5.7: `Wire.endedByServer` (`packages/tck/src/wire.ts`) tells a close by the server from the echo of a close the kit asked for, `ScenarioContext.closeProblems` (`packages/tck/src/context.ts`) lists each close by the server whose code is not one of the nine, a drop without a close frame (seen as 1006) included, and `runScenario` (`packages/tck/src/runner.ts`) fails the scenario with them. `packages/tck/test/pro-037-close-codes.test.ts` (6 tests, Node.js, real sockets against the mock target, which closes on request through its new `closeOnUnknown` option): 1001, 1011, 4999 and a drop each fail their scenario and the run; 4500 and 4503 pass; a close with 1000 or 4999 and a drop made by the kit are not counted. With the check on, `packages/tck/test/mock.test.ts` and `reference.test.ts` pass (every profile, the reference service on the memory stores, no test mode), and `services/document-service/test/postgres/u-pro-103-119-core.pg.test.ts` passes (core profile, test mode, PostgreSQL in Podman, `docedit-test-postgres`) with its one known failure. That failure is why the criterion is open: the reference service ends a silent peer with `terminate()`, so the kit sees 1006 and no code of 05 §5.7 (`core.session.silence`). 05 §4 says only that the side "closes the connection", and which code a silent peer gets is the owner's to decide (`docs/adr/0315-lane-U-PRO-103-119.md`, decision 3; nothing decided here). Until then the silence scenario accepts 1000 and 1001 besides the nine, as it did before (`Wire.toleratedCloses`), and refuses 1006. The 1009 of ADR 0035 (a frame above eight times `maxMessageBytes`) is not exercised by the kit: `fuzz.boundary` and `core.close.4413` send frames the server reads; it still needs the mapping or a change of the criterion.

### PRO-038 Publish one error registry for every surface

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 05 §5.8; review PR-8 · **Requirements:** R6 · **Depends on:** PRO-004

As a maintainer, I want one registry of error codes used by the socket, REST and webhooks, so that a code means the same thing everywhere.

**Acceptance criteria**

- [x] Given the registry, when it is read, then it contains `bad_message`, `unknown_type`, `unauthenticated`, `token_expired`, `revoked`, `forbidden`, `unsupported_version`, `unsupported_engine`, `unsupported_cdm`, `unsupported_feature`, `not_found`, `already_open`, `channel_limit`, `stale_base`, `rebase_failed`, `permission_denied`, `read_only`, `invalid_op`, `conflict`, `field_invalid`, `busy`, `too_large`, `rate_limited`, `quota_exceeded`, `slow_consumer`, `precondition_failed`, `validation_failed`, `pending_suggestions`, `workflow_active`, `idempotency_mismatch`, `unavailable` and `internal`, each with its surfaces, whether it is retryable and the client action.
- [x] Given a REST problem, a `sync.reject`, a `ch.rejected`, a `ch.closed` or an `error` message, when its code is read, then it is one of the registry's codes; the kit fails any response with a code outside the registry.
- [x] Given `rate_limited` and `quota_exceeded`, when they are returned, then they carry `retryAfterMs` on the socket or `Retry-After` on REST.
- [x] Given the registry, when the artifacts are built, then the code enumerations in AsyncAPI, OpenAPI and the `protocol` package are generated from it.

**Evidence:** `packages/protocol/src/definition/errors.ts` holds the 32 codes with surfaces, retry rule and client action, and now the HTTP status of each REST code (D61; `spec/dep/dep-1.registry.json`); the code enumerations of the artifacts are generated from it (`packages/protocol/test/definition.test.ts`, `schemas.test.ts`, `prose.test.ts`). Criterion 2 (lane w5, 2026-11-15): the kit now checks every problem it receives with `checkProblem` (`packages/tck/src/registry-oracle.ts`, called from `wire.ts` for `error`, `sync.reject`, `ch.rejected` and `ch.closed`, and from `context.ts` for every REST problem under `rest`), and the runner fails the scenario that saw a violation. `packages/tck/test/pro-038-registry-oracle.test.ts` runs the kit's runner against a small defective server: a code outside the registry fails on each of the five carriers, a registry code on a surface it does not belong to fails, a problem document without a code fails, and correct problems pass. With the oracle on, the kit's runs against the document service and the mock backend still pass (`packages/tck/test/reference.test.ts`, `mock.test.ts`), so every problem those runs provoke carries a registry code. Criterion 3 (lane w5, 2026-11-15): `Retry-After` on REST for `rate_limited` (`services/document-service/test/control-plane/be-030-rest-limit.test.ts`) and `quota_exceeded` (`be-092-compile-budget.test.ts`); `retryAfterMs` on the socket for `rate_limited` in `sync.reject`, in a non-fatal `error` and in the fatal `error` before 4429 (`services/document-service/test/data-plane/session-1b.test.ts`), and for `quota_exceeded` in `error` and `sync.reject` (`services/document-service/test/control-plane/be-091-node-quota.test.ts`). Each of these now also passes the response through `checkProblem`, and the kit's oracle fails either code without its hint (`pro-038-registry-oracle.test.ts`).

**Notes:** `quota_exceeded` comes from the tenant quotas of BE-091, BE-092; `workflow_active` is produced by the workflow routes of FRW-025, FRW-060, FRW-065. The registry lists `already_open` and `channel_limit` with the surface "socket, REST", though neither can occur on REST as described; see Open questions. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Second review (2026-11-06, SPK-027): SR-M32, the HTTP status per code is still missing; SR-N25, `quota_exceeded`, `forbidden` and `internal` reach `sync.reject` with no client action in 04 §8; SR-N64, S6's D01 makes `code` closed within version 1, which would stop a minor version adding a code ([review](../review/2026-11-06-second-review.md)). Packet A2 (2026-11-06): criterion 2 stays open: every REST problem of the service uses a registry code (typed, and checked in `services/document-service/test/control-plane/routes.documents.test.ts`), but the socket side is packet A1 and the kit packet F. Criterion 3 stays open: no route returns `rate_limited` or `quota_exceeded` yet; problems carry `Retry-After` when they do. The HTTP status of each code is D61. Packet D (2026-11-13): `packages/protocol/src/codec/problem.ts` (`checkProblem`) refuses a code outside the registry or on a surface it does not name, and asks for `retryAfterMs` (socket, `sync.reject`) or `Retry-After` (REST) on `rate_limited` and `quota_exceeded`; `problem.universal.test.ts` tests it, and the codec and `ShapeValidator` refuse out-of-registry codes in `error`, `sync.reject`, `ch.rejected`, `ch.closed` and `ProblemDetails`. Criteria 2 and 3 stay unticked: the kit that must fail such responses is not built, and no server route is checked by `checkProblem` yet. Lane w5 (2026-11-15): both are now ticked (see Evidence). `checkProblem` is exported from `@docedit/protocol`. A defect was found and fixed on the way: the two fatal `rate_limited` errors of the document service (too many frames from an address before `hello`, and too many refused messages in a row) carried no `retryAfterMs`; they now carry the wait of the bucket that refused (`services/document-service/src/data-plane/session.ts`). Limits of the evidence: the kit reads as a REST problem only an error response under `rest` that has the problem media type or a `code`; an error with another body is left to the scenarios that ask for a problem document (`problemOf`). The kit can only check the problems a run provokes; the codes it cannot provoke from outside are listed as skipped by the `registry` profile (PRO-115).

### PRO-039 Act on each error code

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 05 §5.8 · **Requirements:** R6, R10 · **Depends on:** PRO-038, PRO-019, PRO-075

As an author, I want the editor to react sensibly to every kind of failure, so that I am told what I can do instead of seeing a silent stall.

**Acceptance criteria**

- [x] Given `unauthenticated`, `token_expired` or `revoked`, when it arrives, then `backend-dep` calls `getToken` and retries once with the new token, and raises `de-auth-required` if `getToken` fails.
- [ ] Given `forbidden`, when it arrives, then the document is shown as no access and nothing is retried.
- [ ] Given `unsupported_version`, `unsupported_engine`, `unsupported_cdm` or `unsupported_feature`, when it arrives, then the user is told that the component must be updated and nothing is retried.
- [ ] Given `rate_limited` or `quota_exceeded`, when it arrives, then the client waits for `retryAfterMs` or `Retry-After`, and for a quota the user is told.
- [x] Given `slow_consumer`, when the channel closes, then the client resumes; given `unavailable` or `internal`, then it backs off.
- [ ] Given `bad_message` or `unknown_type`, when it arrives, then the client reports a bug through `de-error` and does not retry.
- [x] Given `precondition_failed`, `validation_failed`, `pending_suggestions`, `workflow_active` or `idempotency_mismatch` on REST, when it arrives, then the failed call is returned to the caller with the code, without automatic retry.

**Evidence:** criterion 1: `packages/backend-dep/src/backend.universal.test.ts` "renews a refused token once with getToken" and "rejects with unauthenticated and raises onAuthRequired when the token source fails" (the port event is `onAuthRequired`; the element names it `de-auth-required`). Both were not re-run in lane PRO-029-042. Criterion 7 and the REST part of criterion 1: `packages/backend-dep/test/act-on-error-codes.test.ts` (Node.js, passing): the five codes come back once each with their code and no retry; `token_expired` is renewed once with `getToken` and then surfaces; `rate_limited` and `quota_exceeded` carry `Retry-After` as `retryAfterMs` and are not resubmitted.

**Evidence (criterion 5, lane V-PRO-035-051, 2026-11-13):** `packages/backend-dep/test/pro-039-backoff.test.ts` (Node, `pnpm vitest run --project node <file>`, 3 tests passing, in-memory network): `slow_consumer` makes a resume on the wire at once; `unavailable` and `internal` send no resume for half of `retryInMs` and then one after it. The `internal` case needed a change in `packages/protocol/src/client/channel.ts` (`onClosed`): `ch.closed` with `internal` used to end the channel, and the registry's client action for `internal` is "Back off" (PRO-038), so it now suspends like `unavailable`. `packages/backend-dep/src/channel-resume.universal.test.ts` and the `packages/protocol/src/client/channel*` tests pass with it (31 tests in all with the new file). Criteria 2, 3 and 4 need the element's UI (`packages/element`: "no access", "update the component", the quota message), and criterion 6 needs the `bad_message` retry rule decided (docs/adr/0311-lane-V-PRO-035-051.md, open question B) and `de-error` built in the element; they stay open.

**Notes:** Lane w5 (2026-11-17), no criterion ticked; criteria 2, 3, 4 and 6 stay open. Checked this round: (a) the element reports a failed load as one fatal `de-error` with the registry code (`forbidden`, `unsupported_*`, `rate_limited`, `quota_exceeded` alike; `packages/element/src/session.ts` `#fail`), and the engine stops reopening for `forbidden`, `not_found` and `revoked` (`packages/engine/src/sync/session.ts`), so nothing is retried for criteria 2 and 3; (b) the wait of criterion 4 is in the engine, which sends a refused commit again no sooner than `retryAfterMs` (`packages/engine/test/session.test.ts`, PRO-028), but the rest of the criterion is not there: no message tells the user that the quota is spent, and none shows "no access" or "update the component". `packages/ui/src/i18n/en-GB.ts` and the shell's notices (`packages/ui/src/shell/notices.ts`) have no string for these, and the element renders no failure surface of its own (a failed load is an event for the host page). That surface is a UX design (where it appears, what it says, what the host can replace) which 05 §5.8 and 13 do not give, so it is not built here. (c) Criterion 6: a `bad_message` or `unknown_type` that arrives over REST or for a request is returned to the caller as a `PortError` and is not retried, but nothing turns it into a `de-error`, and ADR 0311 question B (whether a malformed frame the client itself finds should retry) is still open. Sync codes (`stale_base`, `permission_denied` and so on) are handled by SYN-017, FE-008. User-facing strings are external (README §3). Phase inferred: it belongs to the end-to-end sync and fault-injection scope of 11 §4. Lane PRO-029-042 (2026-11-13): criteria 2, 3 and 4 stay open. Criterion 2 and 3: the client does not retry `forbidden` and the `unsupported_*` codes (`FINAL_CODES` in `backend.ts`), but "no access" and "update the component" are shown by the element, which this package does not test. Criterion 4: `rest.ts` returns `retryAfterMs` and does not wait on REST; the socket waits in `connection.ts` and `backend.ts`, and the quota message is the element's. Criterion 5 and 6 were not checked in this lane: `bad_message` and `unknown_type` reporting through `de-error` is not built in `backend-dep`, and `slow_consumer` resume is covered by `channel-resume.universal.test.ts` but not re-checked.

## Control plane: conventions (05 §6.1)

### PRO-040 Use JSON, problem details and cursor lists on every REST route

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Integrating developer |

**Spec:** 05 §6.1, §5.8 · **Requirements:** R6 · **Depends on:** PRO-038

As an integrating developer, I want every REST route to answer in JSON, report errors in one standard shape and page lists the same way, so that one client library covers the whole API.

**Acceptance criteria**

- [x] Given any route, when it returns a body, then the body is JSON; given an error, then it is an RFC 9457 problem document whose `code` member is a code of the registry (PRO-038).
- [x] Given a list route, when it is called, then the response is `{ items, nextCursor }`, where `cursor` is opaque to the caller and `limit` selects the page size.
- [x] Given 250 items and `limit=200`, when the first page is read, then at most 200 items return with a `nextCursor`; and given the last page, then no further cursor is offered.
- [x] Given a request body that does not match the OpenAPI schema, when it is processed, then the response is a problem with the code `validation_failed` and nothing changes.
- [x] Given the kit, when it follows `nextCursor` until the end on every list route, then it sees every item once.

**Evidence:** `services/document-service/src/control-plane/http.ts`, `pipeline.ts`, `problems.ts`. `services/document-service/test/control-plane/routes.documents.test.ts`: bodies are JSON and problems RFC 9457 with registry codes; lists are `{ items, nextCursor }` with an opaque, signed cursor; pages of at most `limit` items until `nextCursor` is null, each item once; a body that breaks the published schema is `validation_failed` with its violations and creates nothing. Criterion 5 (lane w5, 2026-11-15): the kit's scenario `core.rest.cursors` (`packages/tck/src/profiles/core-rest.ts`) takes every `GET` of the protocol definition that answers with a list (`listRoutes`, `packages/tck/src/lists.ts`: eleven routes today), reads each to its end twice with the service credential, in pages of 200 and in small pages (one item, or about thirty pages for a long list), and fails when an item is seen twice, when the small pages miss an item the large pages show, when a page holds more than `limit`, when a cursor is offered twice or when the list does not end (`readList`, `everyItemOnce`). It makes three documents and three commits first and checks that each is listed once. A route that answers 404, 405 or 501 on its first page is noted as not offered. `packages/tck/test/pro-040-cursor-lists.test.ts` (11 tests, Node.js) runs the reader against lists served from memory: correct lists pass at every page size, and a repeated item, a lost item, an overfull page, a body that is not `{ items, nextCursor }`, a repeated cursor, an endless list and an unserved later page each fail. Against real servers the scenario passes: the reference service on the memory stores (`packages/tck/test/reference.test.ts`; the kept report notes `GET /documents` 81 items in pages of 3, the commit list 3, regions 2, audit 6, and versions, holds and fields empty, each once), the reference service on PostgreSQL in Podman in test mode (`services/document-service/test/postgres/u-pro-103-119-core.pg.test.ts`, container `docedit-test-postgres`), and the mock target (`packages/tck/test/mock.test.ts`: documents and regions).

**Notes:** The behaviour for a `limit` above 200, and the HTTP status for each code, are not stated (Open questions). Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Packet A2 (2026-11-06): criterion 5 stays open: the kit is packet F. A `limit` outside 1 to 200 is `validation_failed`, the default 50 (D72); statuses D61. Lane U-PRO-035-051 (2026-11-13): criterion 5 stays unticked: the clause names the kit, which is not built (PRO-108). The service-side check is in `services/document-service/test/control-plane/pro-040-list-cursors.test.ts` (PostgreSQL in Podman, `docedit-test-postgres`, real `startService`; 1 test passing, not skipped): it walks each GET list operation of `spec/dep/dep-1.openapi.json` whose response carries `nextCursor` at `limit=1` to the end, and the paged items equal the unpaged list. The document list pages over three documents. The commit list is walked but holds no items from seq 0, because each snapshot ends its page with a reset; paging over edit commits needs the data plane. The real service does not mount `/search`, `/webhooks`, `/documents/{id}/history` or `/documents/{id}/threads` (404), so those are not walked there. Lane w5 (2026-11-15): criterion 5 ticked; the kit exists now and walks every list route of the definition (Evidence). Limits, stated plainly: the reference service does not offer `/documents/{id}/history`, `/documents/{id}/threads`, `/webhooks` or `/search` (404), so the kit notes them as not offered and walks them when a server serves them; and the lists of versions, holds and fields were empty in these runs, so only their single empty page was read. The mock target's region list ignored `limit`; it now pages like its document list (`packages/tck/test/targets/mock-server.ts`, `page`).

### PRO-041 Allow browsers to call the control plane

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Integrating developer |

**Spec:** 05 §6.1; 10 §3.2 · **Requirements:** R6, R10 · **Depends on:** PRO-010

As an integrating developer, I want the document service to answer CORS preflights for my origins with the right headers, so that the component can call REST from my page.

**Acceptance criteria**

- [x] Given an origin in the tenant's allowed origins, when a preflight arrives, then the response allows the headers `Authorization`, `Content-Type`, `If-Match`, `Idempotency-Key`, `DEP-Actor` and `traceparent`.
- [x] Given a response to an allowed origin, when a browser reads it, then `ETag`, `Retry-After`, `Deprecation` and `Sunset` are exposed.
- [x] Given an origin that is not allowed, when a preflight arrives, then the response does not allow it.
- [x] Given a request that carries only a cookie, when it arrives, then it is unauthenticated: authentication is by bearer token only.
- [x] Given the kit, when it runs the `core` profile, then it asserts each allowed header, each exposed header and the refusal of a disallowed origin.

**Evidence:** `services/document-service/src/control-plane/pipeline.ts` (preflight and response headers; tenant for preflights by D66). `services/document-service/test/control-plane/routes.documents.test.ts`: an allowed origin's preflight allows the six headers; responses expose ETag, Retry-After, Deprecation, Sunset and DEP-Request-Id; a disallowed origin is granted nothing, and an origin of another tenant cannot read this tenant's responses; a cookie alone is `unauthenticated`. Criterion 5 (lane w5, 2026-11-15): the `core` profile has `core.cors.preflight` (a preflight from the registered origin must allow each of `Authorization`, `Content-Type`, `If-Match`, `Idempotency-Key`, `DEP-Actor` and `traceparent`), `core.cors.expose` (a response to that origin must expose each of `ETag`, `Retry-After`, `Deprecation` and `Sunset`) and `core.cors.refused` (an origin no tenant allows gets no `Access-Control-Allow-Origin`, neither its own value nor `*`), in `packages/tck/src/profiles/core-session.ts`. `packages/tck/test/pro-041-cors.test.ts` (13 tests, Node.js, the mock target over real HTTP with its new `cors` option): a correct server passes all three; leaving out any one of the six allowed headers fails the preflight scenario, naming the header; leaving out any one of the four exposed headers fails the expose scenario, naming it; a server that echoes any origin or answers `*` fails the refusal scenario. The three scenarios run and pass (not skipped) against the reference service in `packages/tck/test/reference.test.ts` (memory stores) and in `services/document-service/test/postgres/u-pro-103-119-core.pg.test.ts` (PostgreSQL in Podman, `docedit-test-postgres`).

**Notes:** A preflight carries no token, so how the tenant is identified for it (and for discovery) is not stated (Open questions). Review PR-11. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Packet A2 (2026-11-06): criterion 5 stays open: the kit is packet F. The tenant of a preflight: D66. Lane w5 (2026-11-15): criterion 5 ticked. The scenarios were already in the kit; what was missing was the proof that each header and the refusal are really asserted, which the new test gives by removing them one at a time. The preflight and expose scenarios need an origin registered for the kit's tenant (the kit's `--origin`); without one they are reported as skipped, so a run that certifies CORS must give it.

### PRO-042 Update safely with ETag and If-Match

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Integrating developer |

**Spec:** 05 §6.1 · **Requirements:** R6 · **Depends on:** PRO-040

As an integrating developer, I want concurrent updates to be detected, so that two administrators or two backends never overwrite each other silently.

**Acceptance criteria**

- [x] Given a mutable resource (document, grants, region state, thread, comment, webhook), when it is read, then the response carries an `ETag`.
- [x] Given an update with a current `If-Match`, when it succeeds, then the response carries the new `ETag`.
- [x] Given an update with a stale `If-Match`, when it is processed, then it fails with `precondition_failed` and the resource is unchanged.
- [x] Given an update with no `If-Match`, when it is processed, then it is refused and the resource is unchanged.
- [x] Given two updates sent concurrently with the same `ETag`, when both are processed, then exactly one succeeds.

**Evidence:** Documents (metadata revision) and grants (grants revision) in `services/document-service/src/control-plane/handlers.ts`. `services/document-service/test/control-plane/routes.documents.test.ts` and `services/document-service/test/control-plane/routes.content.test.ts`: a current If-Match returns the new ETag; a stale one is 412 and a missing one 428, both `precondition_failed`, with nothing changed; of two concurrent updates with the same ETag exactly one succeeds.

**Evidence (lane w5, 2026-11-15, criterion 1):** `services/document-service/test/control-plane/pro-042-w5-etag-on-read.test.ts` (Node.js, over HTTP with in-memory storage; 4 of 4 pass). For each kind the criterion names, the response that returns the resource carries a strong `ETag`, an update with that tag succeeds and answers with a different tag, and the next read shows the tag of that answer: `GET /documents/{id}`, `GET /documents/{id}/grants`, `GET /documents/{id}/regions` (the region states), `GET /threads/{tid}`, `POST /threads/{tid}/comments` and `PATCH /comments/{cid}` (a comment), `GET /webhooks/{id}`. A stale tag is refused with 412 for a region state and for a comment.

**Notes:** The code and status for a missing `If-Match` are not stated (Open questions). Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Packet A2 (2026-11-06): criterion 1 stays open: documents and grants carry ETags; region states, threads, comments and webhooks are not built. A missing If-Match is 428 with `precondition_failed` (D61). Lane w5 (2026-11-15): criterion 1 is ticked, since threads, comments and webhooks now exist and answer with ETags (see Evidence). Two points are left to the owner and are not decided here. (1) No route reads a comment: 05 §6.2 gives `/comments/{cid}` only PATCH and DELETE, and `GET /threads/{tid}` returns no comments, so a comment's ETag is known only from the response that wrote it; a caller with `manage` who did not write the comment has no read that yields the tag. (2) A region state is read in the region list, whose ETag (`"<incarnation>.<seq>.<view>.g<revision>"`) is not the one its update takes: `PUT .../state` takes the grants' ETag (`"g<revision>"`, G99), so a client reads the grants to update a state.

### PRO-043 Retry creating requests safely with idempotency keys

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Integrating developer |

**Spec:** 05 §6.1; 10 §3.2 · **Requirements:** R6, R10 · **Depends on:** PRO-040

As an integrating developer, I want to repeat a create request with the same key after a network failure, so that I never create a document, export or webhook twice.

**Acceptance criteria**

- [ ] Given a `POST` that creates something (documents, versions, threads, comments, assets, exports, imports, webhooks), when it carries an `Idempotency-Key`, then a second identical request returns the first result and creates nothing.
- [x] Given a key, when it is used, then it is scoped to the tenant, the caller, the route and a hash of the body: the same key from another caller, on another route or for another tenant is independent.
- [x] Given the same key with a different body, when it is used within the retention time, then the response is `idempotency_mismatch`.
- [ ] Given a key used 24 hours earlier (the retention target), when it is used again after that time, then it is treated as new; the kit uses the test-mode timers of PRO-109.
- [x] Given two identical requests that arrive at the same moment, when both are processed, then one thing is created.
- [x] Given a caller that guesses another caller's key, when it sends a different body, then it cannot read or take over the other caller's job.

**Evidence:** `services/document-service/src/control-plane/idempotency.ts` (the scope, the fingerprint, `claim`, `complete`, `release`, the retention; memory and PostgreSQL stores) and `pipeline.ts` (a second request waits for the first). `services/document-service/test/control-plane/idempotency.test.ts`, in memory and with PostgreSQL: "scopes a key to the tenant, the caller and the route" (criteria 2, 6: another tenant, and two users of one tenant with one key and different bodies on one export route, each with their own job, and one user cannot read the other's job, `403`); "answers idempotency_mismatch for the same key with another body" (criterion 3); "treats a key as new after the retention time" (the harness shortens the retention to 60 s with `idempotencyTtlMs`; this shows the mechanism only); "creates one document when two identical requests arrive at once" (criterion 5: three simultaneous requests create one document). `services/document-service/src/control-plane/idempotency-retention.test.ts` (criterion 4), in memory (PostgreSQL variant skipped in this run, no PostgreSQL running): "is 24 hours, and the environment can change it" (`configFromEnv({})`); "replays a key used just under 24 hours earlier and treats one used 24 hours earlier as new" (the service runs with the default configuration, no `idempotencyTtlMs` override: a replay one minute before 24 hours, a new document at 24 hours); "reports the shortened retention at /_test/timers and keeps a key for that long only" (test mode, BE-079: the retention the kit reads from `GET /_test/timers` is the one the service applies). Lane U-PRO-035-051 (2026-11-13), PostgreSQL in Podman (`docedit-test-postgres`): the PostgreSQL variants of `services/document-service/test/control-plane/idempotency.test.ts` (12 tests in total) and of `services/document-service/src/control-plane/idempotency-retention.test.ts` (5 tests in total) ran and passed, none skipped. `services/document-service/test/control-plane/pro-043-replay-routes.test.ts` (8 tests, memory and PostgreSQL) replays a webhook create and an asset create with the same key: the second answer equals the first, carries `DEP-Idempotent-Replayed: true`, and creates no second subscription.

**Notes:** Lane w5 (2026-11-17), no criterion ticked: criterion 1 needs routes that do not exist (versions PRO-054, threads and comments PRO-059, imports PRO-066); criterion 4 needs a kit scenario that reads `GET /_test/timers`, and the kit has no test-mode client yet (`packages/tck/src/profiles/fault-injection.ts` has no scenarios, ADR 0219 proposed, PRO-109 and PRO-126). Building a one-off timer reader here would fix a hook interface that PRO-126 has not specified. The owner question stands: whether the clause "the kit uses the test-mode timers" is mandatory. Threat "taking over another caller's job through a reused idempotency key" (10 §3.2). Phase inferred: it belongs to the end-to-end sync and fault-injection scope of 11 §4. Packet C (2026-11-13): criterion 1 stays open. The test covers a document and an export. The other kinds in its list (versions, threads, comments, assets, imports, webhooks) are not built or are not tested for replay. Criterion 4 was unticked in review (2026-11-13): it names 24 hours and the kit's test-mode timers (PRO-109, packet K); the test uses a 60 s retention and no test asserts the 24-hour default (`config.ts`). Ticked again (fixer, round 3) on `idempotency-retention.test.ts`, which asserts the 24-hour default end to end and the test-mode retention the service publishes at `/_test/timers`. The kit side of PRO-109 (packet K) is not built, so no kit test reads those timers yet; that belongs to PRO-109. Round 5 (2026-11-13, control-plane packet): criterion 4 is unticked again. Its clause that the kit uses the PRO-109 timers is literal, and no scenario in `packages/tck` reads `/_test/timers` for the idempotency retention; the service side stays tested in `idempotency-retention.test.ts`. A kit scenario that reads the retention would tick it. Owner to confirm whether the clause is mandatory. Lane U-PRO-035-051 (2026-11-13): criterion 1 stays unticked. Its list names versions, threads, comments and imports, which have no route yet (PRO-054, PRO-059, PRO-066); webhooks and assets are now tested (see Evidence). The webhook store is memory-only (`webhook-subscriptions.ts` has no PostgreSQL store), so that replay is not run on PostgreSQL. Criterion 4 stays unticked as before (the kit's use of the PRO-109 timers is not built).

### PRO-044 Trace a request across the planes

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | S | should | Operator |

**Spec:** 05 §5.1, §6.1 · **Requirements:** R9 · **Depends on:** PRO-040, PRO-021

As an operator, I want a trace to follow a user's action from the page to the server, so that I can find a slow or failed request.

**Acceptance criteria**

- [x] Given a REST request with a `traceparent`, when the server handles it, then its work is recorded as part of that trace.
- [x] Given every REST response, including errors, when it is returned, then it carries a request identifier.
- [x] Given a `hello` with a `traceparent`, when the session opens, then the session's work is recorded as part of that trace.
- [x] Given logs and traces, when they are inspected, then they contain no document content and no token.

**Evidence:** `services/document-service/test/data-plane/session-1b.test.ts`, "traces (PRO-044; BE-087)": a `hello` with a `traceparent` puts the session, channel and commit spans under its trace id, with the session span parented on the caller's span id; no span holds the committed text or the session token. Round 6 (data plane, 2026-11-13): `services/document-service/src/data-plane/telemetry-hygiene.test.ts` searches every span and every error the data plane reports (`onError`) for the typed text, the session token and a bogus token that a second connection presents; the search is checked not to be vacuous (a `dep.commit` span exists). Round 7 (control plane, 2026-11-13): `services/document-service/test/control-plane/request-trace.test.ts` (memory storage; PostgreSQL not run): every REST response, errors, preflights and the discovery route included, carries `DEP-Request-Id`, equal to the problem's `requestId` on errors (criterion 2); a REST request with a `traceparent` makes an `http.request` span of that trace, errors included, and its log line names the trace, while a request without one starts a trace of its own (criterion 1); no REST log line or span holds the typed text, the API key or a bogus token (criterion 4, REST part).

**Evidence (criterion 4, lane V-PRO-035-051, 2026-11-13):** `services/document-service/test/server/pro-044-logs-both-planes.test.ts`, memory and PostgreSQL in Podman (`docedit-test-postgres`), `pnpm vitest run --project node <file>`, 2 passed: one process from the real `startService`, with a logger sink and an `onSpan` sink. It sends REST requests with a secret title and token, a traced WebSocket session that commits a secret passage, and a connection with a bogus token; every log line and span is searched for the text, the title, the valid token, the bogus token, the API key and the database password, and the search first checks that REST lines and session spans exist. The data plane has no logger seam, so its telemetry is its spans and `onError`, and both are searched. The data plane's spans did not reach `onSpan` through `startService`; `services/document-service/src/server.ts` now forwards it (one line in the data-plane settings).

**Notes:** Lane U-PRO-035-051 (2026-11-13): `services/document-service/test/control-plane/pro-044-request-trace.pg.test.ts` (PostgreSQL in Podman, `docedit-test-postgres`; 3 tests passing, none skipped) runs criteria 1, 2 and the REST part of 4 on PostgreSQL storage. Criterion 4 stays open: no test searches the data plane's log lines, and the kit does not exist yet. Round 7: criteria 1 and 2 are ticked on `request-trace.test.ts`. Criterion 4 stays open, now only for the data plane's logs (the REST part is tested there; round 6 searched spans and errors, not log lines), and PostgreSQL was not run. Earlier: criteria 1 and 2 were not ticked. Criterion 4 stays open: round 6 covers the data plane's spans and errors only; the control plane's REST logs and traces are not searched, and that is packet C's to add. Earlier note: only trace spans were checked before round 6, not logs. The header that carries the request identifier is not named in 05 (Open questions). Phase inferred: it belongs to the end-to-end sync and fault-injection scope of 11 §4.

### PRO-045 Resolve resources addressed by a bare identifier to their document

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Integrating developer |

**Spec:** 05 §6.1; 10 §3.2 · **Requirements:** R3, R10 · **Depends on:** PRO-009

As an integrating developer, I want a job, asset, thread or comment identifier to give no access beyond its document, so that guessing an identifier never leaks another document.

**Acceptance criteria**

- [x] Given a route addressed by a bare identifier (`/exports/{jid}` in this phase, `/assets/{aid}` and `/imports/{jid}` in 1b and 2, `/threads/{tid}` and `/comments/{cid}` in phase 2), when it is called, then the server resolves the identifier to its document and checks the caller's token against that document and the capability the route needs.
- [x] Given a token that covers document A, when it asks for a job, asset or thread of document B, then the request is refused.
- [x] Given a service credential, when it asks for a resource of another tenant, then the request is refused.
- [x] Given the kit, when it runs, then for every route addressed by a bare identifier that the server announces, a cross-document test exists and passes.

**Evidence:** `GET` and `DELETE /exports/{jid}` resolve the job to its document and its requester (`services/document-service/src/control-plane/handlers.ts`, `ownJob`). `services/document-service/test/control-plane/routes.exports.test.ts`: a token for another document is `forbidden`; `services/document-service/test/control-plane/queue.test.ts` and `services/document-service/test/control-plane/routes.documents.test.ts`: another tenant's job and documents are invisible to its credentials. Criterion 4 (lane w5, 2026-11-15): the kit's table `packages/tck/src/identifiers.ts` (`bareRoutes`) takes from the protocol definition every operation that a user token may call and whose path starts at an identifier other than the document's (ten today), and gives each the feature that offers it and the scenario that calls it with a token of another document: `GET` and `DELETE /exports/{jid}` by `exports.identifiers`, `POST /assets/{aid}/complete` by `assets.other-document`, and the four thread and two comment routes by the new `comments.identifiers` (`packages/tck/src/profiles/comments.ts`, the first scenario of the `comments` profile: an owner of another document is refused on all six with `forbidden` or `not_found`, and the thread is unchanged afterwards). The new `core.identifiers.table` (`packages/tck/src/profiles/core-rest.ts`) runs on every server and fails the run when the server announces a feature whose bare-identifier routes have no scenario (`untestedBareRoutes`). `packages/tck/test/pro-045-bare-identifiers.test.ts` (8 tests, Node.js): the table holds every such route of the definition, only the webhook routes (service credential alone) are left out, each scenario named exists, declares the route and is gated on the feature, an announced route without a scenario is reported, and against the reference service started with `comments` announced `core.identifiers.table` and `comments.identifiers` pass with all six thread and comment routes called. `services/document-service/test/postgres/pro-045-bare-identifiers.pg.test.ts` (1 test; PostgreSQL and the S3-compatible store in Podman, `docedit-test-postgres` and `docedit-test-s3`, own database, dropped afterwards): the reference service announces `exports` and `assets`, and `core.identifiers.table`, `exports.identifiers` and `assets.other-document` pass.

**Notes:** Review PR-11. Routes are added to the kit's table as their features land. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Packet A2 (2026-11-06): criterion 4 stays open: the kit is packet F. Lane U-PRO-035-051 (2026-11-13): still open. The kit's run over every announced bare-identifier route is not built; `services/document-service/test/control-plane/be-032-bare-identifiers.test.ts` covers the two routes the control plane offers today (memory and PostgreSQL), and the kit needs PRO-108 and later, which this lane did not build. Lane w5 (2026-11-15): criterion 4 ticked; the kit exists now (Evidence). Two limits, stated plainly. `GET /imports/{jid}` is in the table without a scenario: DEP names no feature for imports and no server mounts the route, so no server can announce it; when imports land they need a feature name (or another way to announce them) and a scenario, and the kit's own test fails if a route is given a feature without one. Open question, not decided here: the thread scenario accepts `forbidden` (403) or `not_found` (404) as the refusal, because 05 §6.1 says only that the request is refused, while `exports.identifiers` asks for `forbidden` (D69); if the owner wants one code for every such route, the scenario narrows to it. The reference service does not announce `comments` by default; the thread scenario ran against it started with `DOCEDIT_FEATURES` naming `comments`.

## Control plane: documents, content, regions and grants (05 §6.2)

### PRO-046 Create and list documents with a service credential

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Integrating developer |

**Spec:** 05 §6.2; 13 §11.1 · **Requirements:** R6, R15 · **Depends on:** PRO-012, PRO-040, PRO-042

As an integrating developer, I want to create documents and find them by my own identifier from my backend, so that my application owns the catalogue while the editor never lists documents.

**Acceptance criteria**

- [x] Given a service credential, when `POST /documents` is called with optional CDM content, `externalId` and `properties`, then a document is created and its identifier is returned.
- [x] Given CDM content that is not valid against the published schema, when `POST /documents` is called, then it fails with `validation_failed` and no document exists.
- [x] Given a service credential, when `GET /documents` is called with `externalId`, then only documents with that `externalId` are returned, as a cursor list.
- [x] Given a user token, when `POST /documents` or `GET /documents` is called, then the call is refused.
- [x] Given the `backend-dep` source, when it is searched and its requests recorded in tests, then no code path calls `GET /documents`.

**Evidence:** `services/document-service/test/control-plane/routes.documents.test.ts`, in memory and PostgreSQL: creation with content, `externalId` and properties returns the identifier (201, Location); content that is not valid CDM is `validation_failed` with JSON Pointers and no document exists; `GET /documents?externalId=` returns only those, as a cursor list; user tokens are refused on both routes. Criterion 5 (lane U-PRO-035-051, 2026-11-13): `packages/backend-dep/test/pro-046-no-list.test.ts` (Node, `pnpm vitest run --project node <file>`, 2 tests passing): no non-test source file of `backend-dep` names the bare `/documents` collection, and the requests of a session against the in-memory reference service hold no GET of it.

**Notes:** Repeating a create with the same `Idempotency-Key` is PRO-043. Creation from a template (12 §9) and from an import is added by FRW-025, FRW-060, FRW-065 and EXP-098. Whether `externalId` must be unique is not stated. Packet A2 (2026-11-06): criterion 5 stays open: it is about `backend-dep` (packet B). `externalId` is unique in the tenant (D62).

### PRO-047 Read, update, lock, archive and delete a document

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Owner |

**Spec:** 05 §6.2, §5.5; 04 §5; 07 §4, §12 · **Requirements:** R3, R4 · **Depends on:** PRO-042, PRO-033

As an owner, I want to lock, archive or delete a document, so that I can freeze work or retire a document without touching the data.

**Acceptance criteria**

- [x] Given a document, when `GET /documents/{id}` is called, then it returns metadata, `properties` and `state` (`active`, `locked` or `archived`) with an `ETag`.
- [x] Given a caller with `manage` and a current `If-Match`, when `PATCH` changes `properties` or `state`, then the change is stored; given a caller without `manage`, then it is refused.
- [x] Given a document set to `locked` or `archived`, when a commit is submitted, then it is rejected with `read_only`, and every connection receives `perm.changed` with a higher `rev` and `document.updated`.
- [ ] Given `DELETE`, when it succeeds, then the document is soft deleted: it can no longer be opened (`ch.open` gives `not_found`) and purging follows the retention policy (HIS-029, HIS-030).
- [x] Given a state change or a deletion, when it is stored, then the webhooks `dep.document.state_changed` and `dep.document.deleted` are raised (PRO-072).

**Evidence:** `services/document-service/test/control-plane/routes.documents.test.ts` (memory; run in packet C, 2026-11-13, passes): "updates metadata and state under If-Match; a state change raises the grants revision and tells the room" (criterion 2: the owner's PATCH is stored and an editor's is `forbidden`; the permissions and document notices follow); "soft-deletes with manage or a service credential; the data stays" (the 204, `not_found` on GET, `deletedAt` set and the checkpoint kept); the same two tests assert `dep.document.state_changed.v1` with its data and `dep.document.deleted.v1` (criterion 5). Criterion 1: `services/document-service/src/control-plane/document-state.test.ts` (memory; PostgreSQL skips without a database; 2026-11-13, passes): the GET returns `properties` and `state`, the state moves through `locked`, `archived` and `active` with the `ETag` changing each time, and a stale `If-Match` gets `precondition_failed`. Round 7 (data plane, 2026-11-13): `services/document-service/src/data-plane/document-state-readonly.test.ts` (memory; passes): for `locked` and for `archived`, after the grants change with the state and the room's notices, every open connection gets `perm.changed` with a higher `rev` and `document.updated` for the document (criterion 3), and the editor's commit is refused with `read_only` and action `drop`, with no trace of its text in the log. Lane w5 (2026-11-17), criterion 4, the opening half only (not ticked): `services/document-service/test/server/server.test.ts` 'a lock makes commits read_only; a delete closes the channels...' (Node.js, in-memory storage, a real WebSocket; 10 of 10 pass) now reopens the document after `DELETE` and gets `ch.rejected` with `not_found`.

**Notes:** Lane w5 (2026-11-17): criterion 4 stays unticked. Opening is tested (see Evidence). Purging is not built, and what it should follow is not settled: 05 §6.2 says "purge follows the retention policy", but no spec section gives a retention time for a deleted document, and HIS-029 (cold segments for old payloads) and HIS-030 (thinning of checkpoints) are about old data of live documents, not about a deleted one. The scheduler (`control-plane/scheduler.ts`) has no purge job for documents. Needs the owner: the retention time for a deleted document and who may shorten it (legal hold, 08 §11 suspends purge). Packet C (2026-11-13, round 9): criterion 1 is ticked on `document-state.test.ts`. Round 7: criterion 3 is ticked on `document-state-readonly.test.ts`. The test makes the state change with the data plane's own grants change and `documentChanged`, the calls the control plane's `PATCH` makes; it does not go through HTTP. Criterion 4 stays open: purging under the retention policy (HIS-029, HIS-030) is not built. Criterion 4 stays open: the `ch.open` `not_found` is the data plane's, and purging under the retention policy (HIS-029, HIS-030) is not built.

### PRO-048 Mark a document with a classification label

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | S | could | Tenant administrator |

**Spec:** 05 §6.2; 13 §10 · **Requirements:** R15 · **Depends on:** PRO-047

As a tenant administrator, I want a classification label on the document resource, so that the editor can show it and exports can carry it.

**Acceptance criteria**

- [x] Given a document, when `PATCH` sets a classification label with a current `If-Match`, then `GET` returns it; given `PATCH` clears it, then `GET` returns none.
- [ ] Given a label, when the status bar and exports are produced, then they show and apply it (UX-076, EXP-004, EXP-005).
- [ ] Given a client that does not know the field, when it reads the resource, then it ignores it (PRO-005).

**Evidence:** `services/document-service/src/control-plane/handlers.ts` (`updateDocument` and `documentResource`: the `classification` field maps to the stored `label`) and `services/document-service/src/storage/memory.ts` and `document-store.ts` (the label is stored and cleared). `services/document-service/test/control-plane/pro-048-classification.test.ts`, memory and PostgreSQL in Podman (`docedit-test-postgres`; lane U-PRO-035-051, 2026-11-13, both variants pass, none skipped): a new document has no label; `PATCH` with a current `If-Match` sets it and `GET` returns it; a stale `If-Match` is refused and the label does not change; `PATCH` with `null` clears it and `GET` returns none (criterion 1).

**Notes:** Phase 4 per 13 §12 ("classification labels"). Lane PRO-043-056, round 2: criterion 1 is ticked. Criterion 2 stays open: the status bar (UX-076) and the exports (EXP-004, EXP-005) that show and apply the label are not built. Criterion 3 is the client's (PRO-005) and is not tested in this lane. Lane V-PRO-035-051 (2026-11-13): criterion 3 stays open: no client code in the repository reads `GET /documents/{id}` metadata (`packages/backend-dep` reads content, regions, grants, commits and assets only), so there is no client read that could ignore the field; see docs/adr/0311-lane-V-PRO-035-051.md, open question C.

### PRO-049 Read document content at the head or at a pinned sequence number

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Viewer |

**Spec:** 05 §6.2, §5.2; 03 §11; 06 §3; 07 §8 · **Requirements:** R6, R7 · **Depends on:** PRO-042, PRO-009

As a viewer, I want the document content with the sequence number it corresponds to, so that the live stream continues exactly where the content ends.

**Acceptance criteria**

- [x] Given a caller with `view`, when `GET /documents/{id}/content` is called, then the response holds `seq`, `incarnation`, `cdm`, `requires` and `doc`, and the document is valid against the published schema for that `cdm` and `requires`.
- [x] Given `?seq=N`, when it is called twice, then both responses are byte-identical and cacheable, and the `ETag` combines the incarnation and `seq`.
- [x] Given a log that was rewound by a database recovery, when content at the same `seq` is read, then the `ETag` differs because the incarnation differs.
- [x] Given a `seq` below the caller's visibility gate, when it is requested, then it is refused (PRM-041, PRM-042).
- [x] Given a document whose `requires` lists a feature the reader lacks, when the client reads it, then the client refuses to open it with a clear message and does not drop what it does not understand (CDM-047).
- [x] Given a read at the head, when it returns, then it is complete: all commits up to `seq` are included, and a channel opened with `resume.seq` = `seq` receives `seq + 1` next.

**Evidence:** `services/document-service/src/control-plane/content.ts`. `services/document-service/test/control-plane/pro-049-content-gate.test.ts`, memory (PostgreSQL skipped, no database running; 2026-11-13, passes): a viewer's pinned read below the default `editors` gate is `403 forbidden` with no text, the head is served, and an owner's read at seq 0 is served (criterion 4). `services/document-service/test/control-plane/routes.content.test.ts`: the content holds `seq`, `incarnation`, `cdm`, `requires`, `doc` and `view` and reads as valid CDM; `?seq=N` twice gives identical bytes, `Cache-Control: private, max-age=31536000, immutable` and an ETag of incarnation, seq and view token (304 on If-None-Match); a new incarnation changes the ETag (PostgreSQL); the head includes every stored commit. `services/document-service/test/server/server.test.ts`: a client that read the head over REST resumes with its seq, incarnation and view token and receives seq + 1 next. Criterion 5 (lane V-PRO-035-051, 2026-11-13): `packages/engine/test/schema.test.ts` ("refuses a document whose requires lists a feature this build lacks, or another CDM version": `UnsupportedDocumentError` with `unsupported_feature` and `missing: ['x-future']`, and construction throws, so no content is opened or dropped) and `packages/element/test/unsupported-document.test.ts` (2 tests: one fatal `de-error` names the feature and no editor is mounted), run with `pnpm vitest run --project node <file>`, 11 tests passing across the two files (Node, mock backend).

**Notes:** Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Second review (2026-11-06, SPK-027), SR-C4 and SR-M6: under ADR 0019 a pinned read differs by visibility class and is valid only under the grants revision it was served under, so it must be `Cache-Control: private`, vary by class, never be cached at shared edges for documents with hidden scopes, and check the grants revision in storage (S12 change 3); the second criterion changes ([review](../review/2026-11-06-second-review.md)). Packet A2 (2026-11-06): criteria 4 and 5 stay open: the gate is PRM-041 (phase 1b) and refusing unknown features is the client (packet B, CDM-047). Criterion 2 is met in the form the second review asks for: private and immutable, with the view token in the ETag (D70). Lane PRO-043-056, round 2: criterion 4 is ticked on `pro-049-content-gate.test.ts`; criterion 5 stays open (the client's refusal of an unknown `requires` feature, CDM-047).

### PRO-050 Replace document content as an import snapshot

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | should | Integrating developer |

**Spec:** 05 §6.2; 04 §3.2; 07 §11 · **Requirements:** R6 · **Depends on:** PRO-049, PRO-030, PRO-012

As an integrating developer, I want to replace a document's content from my backend, so that I can seed or re-import a document.

**Acceptance criteria**

- [x] Given a service credential and a current `If-Match`, when `PUT /documents/{id}/content` is called with valid CDM content, then a snapshot commit with origin `import` is stored.
- [x] Given connected clients, when the snapshot commit is stored, then they receive `sync.reset` with reason `import` (PRO-030).
- [x] Given a user token, when `PUT` is called, then it is refused.
- [x] Given content that is invalid, or that would change an approved region, when `PUT` is called, then it is refused and the content is unchanged (PRM-043, PRM-046).

**Evidence:** `services/document-service/test/control-plane/routes.documents.test.ts`, "accepts API keys and dep-svc+jwt on service routes and refuses user tokens there" (criterion 3: a user token with service claims gets `403 forbidden` on `PUT /documents/{id}/content`). Criterion 4: `services/document-service/src/control-plane/content-replace.test.ts` (memory and PostgreSQL; the stand-in data plane records each store): invalid content gets `validation_failed` and the stand-in is not called; the control with valid content is stored. A change to an approved region gets `conflict` and nothing is stored; a replacement while a workflow is active gets `workflow_active`. Round 7 (data plane, 2026-11-13): criterion 2 is ticked on `services/document-service/src/data-plane/snapshot-reset.test.ts` (memory; passes): a snapshot stored through the data plane's `replaceContent` sends `sync.reset` with the snapshot's `seq` and reason `import` to every open channel. Criterion 1 (lane U-PRO-035-051, 2026-11-13): `services/document-service/test/control-plane/pro-050-import-route.pg.test.ts` (PostgreSQL in Podman, `docedit-test-postgres`; a database this file creates and drops; 1 test passing, `pnpm vitest run --project node <file>`): the real `startService` on PostgreSQL, `POST /v1/documents`, `GET` for the `ETag`, then `PUT /v1/documents/{id}/content` with `If-Match` gets 204, and the stored `doc_commits` row has `kind` `snapshot` and `origin` `import`.

**Notes:** Phase inferred: used by the reference host to seed documents (1b). Round 7: criterion 2 is ticked on the data plane's test, which calls the same `replaceContent` the import path stores through; the control plane's `PUT` reaches the data plane through its own port, which the control-plane harness replaces with a stand-in, so the route-to-room link is not tested end to end. Criterion 1 was open until lane U-PRO-035-051 (2026-11-13) ticked it on the PostgreSQL route test named in Evidence. Packet C (2026-11-13): criterion 1 stays open: the control plane checks `If-Match` and the content (`routes.content.test.ts`, "replaces content through the data plane"), but the snapshot commit and its origin `import` are the data plane's (packet A1, BE-037). Criterion 2 is the data plane's (PRO-030). Round 9 (2026-11-13): criterion 4 is ticked on `content-replace.test.ts`, which shows that a refused replacement never reaches the store (the content is unchanged) and that an approved-region change is refused with `conflict`. The stand-in data plane is used, so the check is on the control plane's refusal, not on the room.

### PRO-051 List the regions of a document

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | S | must | Owner |

**Spec:** 05 §6.2; 07 §3 · **Requirements:** R3 · **Depends on:** PRO-049

As an owner, I want a derived list of the regions of a document, so that I can see them and grant roles on them.

**Acceptance criteria**

- [x] Given a document with regions, when `GET /documents/{id}/regions` is called, then each item holds the region's identifier, `title`, `policy`, `order`, `state` and who can edit it.
- [x] Given a commit that adds, removes or reorders a region, when the list is read afterwards, then it reflects the document at the head; the list is derived, not stored separately.
- [x] Given a caller without `view`, when the list is requested, then it is refused.

**Evidence:** `services/document-service/src/control-plane/handlers.ts` (`listRegions`, D64). `services/document-service/test/control-plane/routes.content.test.ts`: each item has the identifier, title, policy, order, state and `editors` (roles, principals with an editor grant, the lease holder, none while approved); a commit that removes a region removes it from the list; a token without the document is refused.

**Notes:** Who may see "who can edit" is not stated. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a.

### PRO-052 Read and change region grants

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Owner |

**Spec:** 05 §6.2, §5.5; 07 §3, §9; 04 G7 · **Requirements:** R3 · **Depends on:** PRO-042

As an owner, I want to grant roles on regions to people and groups and have the change take effect at once, so that a collaborator can edit only their part.

**Acceptance criteria**

- [x] Given a caller with `manage`, when `GET /documents/{id}/grants` is called, then it returns the current grants and an `ETag`.
- [x] Given a caller with `manage` and a current `If-Match`, when `PATCH` changes grants, then the response carries the new grants revision.
- [x] Given the response to `PATCH` has returned, when a commit that was checked against the old revision reaches the log, then it is not stored (the race test of S3, using the kit's timing tests).
- [x] Given connected users who are affected, when `PATCH` returns, then they receive a `control` commit and `perm.changed` without reloading (PRO-033).
- [x] Given a caller without `manage`, when `PATCH` is called, then it is refused.
- [x] Given the webhook list, when grants change, then `dep.grants.changed` is raised (PRO-072).

**Evidence:** `services/document-service/src/control-plane/handlers.ts` (`getGrants`, `updateGrants`; D63). `services/document-service/test/control-plane/routes.content.test.ts`: GET with `manage` returns the grants and `ETag` `"g1"`; PATCH with the current If-Match returns revision 2; a commit checked against the old revision then gets `revision_moved`; an editor is refused; `dep.grants.changed.v1` is raised and the room is told. `services/document-service/test/server/server.test.ts`: a connected user receives the control commit and `perm.changed` after the PATCH.

**Notes:** The grant model and who may be granted what are PRM-004, PRM-006.

### PRO-053 Set region states and acquire leases

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | should | Owner |

**Spec:** 05 §6.2; 07 §10, §11 · **Requirements:** R3 · **Depends on:** PRO-052

As an owner, I want to mark a region draft, in review or approved and to let one person check a region out for a while, so that a team can work in a controlled order.

**Acceptance criteria**

- [x] Given a caller with `manage`, when `PUT /documents/{id}/regions/{rid}/state` sets `draft`, `in_review` or `approved`, then the state is stored as a control commit and `dep.region.state_changed` is raised; given another value, then the request fails with `validation_failed`.
- [x] Given a caller without `manage`, when it changes a region state, then it is refused.
- [x] Given a server that announces `leases`, when a caller with `edit` in the region calls `POST .../lease`, then a lease is created; the holder extends it with `PUT` (heartbeat) and ends it with `DELETE`; a caller with `manage` can break it with `DELETE`.
- [x] Given a lease with the default expiry of five minutes (target) and a maximum total of eight hours (target), when the holder stops sending heartbeats, then the lease expires and `perm.changed` is sent.
- [x] Given a server that does not announce `leases`, when a client reads discovery, then it calls no lease route.
- [x] Given an approved region, when any commit of any origin would change it, then the commit is refused until the state changes (PRM-043, PRM-046).

**Evidence:** Criterion 3 (lane U-PRO-052-068, 2026-11-13): `services/document-service/test/control-plane/pro-053-leases.test.ts`, run with `pnpm vitest run --project node <file>` against memory and PostgreSQL in Podman (`docedit-test-postgres`): 6 passed. The routes are in `services/document-service/src/control-plane/lease-routes.ts`; the PostgreSQL grant store now keeps the lease identifier and acquisition time (`services/document-service/src/storage/grant-store.ts`). The first test covers acquisition, a refusal to a viewer, a conflict with a second holder, a heartbeat with 428, 412 and 200, a non-holder refused, a break by `manage`, and a release. Criterion 2: `services/document-service/test/control-plane/routes.content.test.ts`, "sets a region state with manage; an approval names the seq and the hash of the region" (an editor's `PUT .../state` is `forbidden`). Criterion 1 (lane V-PRO-052-068, 2026-11-13): `services/document-service/src/data-plane/pro-053-region-state-control-commit.test.ts` (real data plane, memory stores, `pnpm vitest run --project node <file>`: 2 passed): each state change writes one `control` commit at the grants revision it made, and a change the room is not told about writes none. The `validation_failed` answer and `dep.region.state_changed` are in the route test above. Criterion 4 (lane U-PRO-035-051, 2026-11-13): `services/document-service/src/data-plane/pro-053-lease-expiry.test.ts` (memory stores, in-process data plane with its expiry timers on; 1 test passing, `pnpm vitest run --project node <file>`): a lease put with an expiry 800 ms ahead and never renewed lapses, and every open connection gets `perm.changed` with a higher `rev`, no lease and `edit` back on the region. The room sends it, not the control plane. The five-minute default and the eight-hour maximum are checked on the control plane in `pro-053-leases.test.ts`. Criterion 6: `services/document-service/src/data-plane/pro-053-approved-refusal.test.ts` (memory stores; passes, 2026-11-13): the owner's commit into an approved region is `permission_denied` with action `drop`, and the owner's commit is accepted once the region is `in_review` again. The editor case is `services/document-service/src/data-plane/region-state-changes.test.ts`; an import (origin `import`) into an approved region is refused with `conflict` in `services/document-service/src/control-plane/content-replace.test.ts`. Criterion 5 (lane V-PRO-035-051, 2026-11-13): `packages/backend-dep/test/pro-053-no-leases.test.ts` (Node, `pnpm vitest run --project node <file>`, 2 tests passing; in-memory network): the client asks for `leases`, the server's welcome leaves it out, and the connect makes no request or frame naming a lease route and `backend.leases` is `undefined`; the second test announces `leases` and shows the port is then present, so the check is not vacuous.

**Evidence (lane V-PRO-052-068, 2026-11-13, criterion 1 end to end):** `services/document-service/test/control-plane/pro-053-state-route-control-commit.test.ts`: over HTTP on the real data plane with a connected owner's room, two `PUT .../state` calls store two control commits whose revisions equal the grants ETag each change returned; a value other than the three states gets 400 `validation_failed` and no revision moves. Run with `pnpm vitest run --project node <file>` from the repository root, memory and PostgreSQL in Podman (`docedit-test-postgres`): 4 passed. The refusal was added to `setRegionState` in `services/document-service/src/control-plane/handlers.ts`; `prm-046-region-state-route.test.ts` and `routes.content.test.ts` still pass.

**Notes:** Behaviour is PRM's; this story is the resource contract. Lane V-PRO-052-068 (2026-11-13): criterion 1 is ticked on the two tests above (the route test's stub room writes no control commit, so the commit is shown on the real data plane; the production composition sends the notice from the route to the room). Lane PRO-043-056, round 3: criteria 2 and 6 are ticked. Criterion 1 stays open: the test checks the stored state, the grants revision, the permissions notice and `dep.region.state_changed`, but not that a control commit is recorded for the change (the room records it, 07 §9; not asserted here). Criteria 3 and 4 (leases) and 5 (discovery announces `leases`) stay open: no lease route exists in `handlers.ts` and no discovery test covers the `leases` feature. Lane U-PRO-052-068, 2026-11-13: criterion 3 is ticked (routes and test in Evidence; the lease rules are in `packages/authority/src/permissions/leases.ts`). Criterion 4 is partly tested: the lease lapses five minutes after its last heartbeat and renewal stops at eight hours (`pro-053-leases.test.ts`), but no test shows the `perm.changed` that the room sends on expiry, since the stub data plane runs no expiry timer; it stays open for that. Lane U-PRO-035-051 (2026-11-13): the expiry notice is tested on the data plane (`pro-053-lease-expiry.test.ts`, see Evidence), so criterion 4 is ticked; criteria 1 and 5 stay open (the control commit is not asserted; discovery is the client's). Criterion 5 is the client's discovery behaviour and stays open. Decision (spec default; lane record in docs/adr/0312-lane-U-PRO-052-068.md): the lease ETag is the lease identifier in quotes, because the published heartbeat and release name no identifier; a service credential holds no lease and can only break one. Lane V-PRO-035-051 (2026-11-13): criterion 5 is ticked (see Evidence). Criterion 1 stays open: the control commit that a region state change stores is not asserted on the control plane's test, which uses the stub data plane; the real room records it (`services/document-service/src/data-plane/region-state-changes.test.ts`), so this needs the control plane wired to the real data plane in one test. Evidence audit (2026-11-13): criterion 1 is unticked again, because the `PUT .../state` route is tested only against the stub room and the control commit only through the test helper `changeGrants`, so no test shows the route producing the control commit, as the paragraph above already says.

## Control plane: history, comparison, restore and fork (05 §6.2)

### PRO-054 List grouped history and manage named versions

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Author |

**Spec:** 05 §6.2; 08 §4, §9 · **Requirements:** R4 · **Depends on:** PRO-040, PRO-049

As an author, I want to list grouped changes and to name a version, so that I can find a moment in the document's life and keep it.

**Acceptance criteria**

- [ ] Given a caller with `view`, when `GET /documents/{id}/history` is called with the filters `region`, `field`, `user`, `fromSeq`, `toSeq` and `namedOnly`, then it returns grouped commits that match, as a cursor list, and only those the caller's visibility gate allows.
- [x] Given a caller with `edit` somewhere in the document, when `POST /documents/{id}/versions` is called with `name`, `note` and optionally `seq`, then a named version is created at that `seq` (the head when omitted) and `version.created` is sent.
- [x] Given `GET /documents/{id}/versions`, when it is called, then it lists named versions as a cursor list.
- [x] Given a repeated `POST` with the same `Idempotency-Key`, when it is processed, then one version exists.
- [ ] Given a `seq` above the head or below the gate, when a version is requested, then the request is refused.

**Evidence:** Lane U-PRO-052-068, 2026-11-13: `services/document-service/test/control-plane/pro-054-versions.test.ts` (HTTP over the harness, memory and PostgreSQL in Podman, `docedit-test-postgres`; `pnpm vitest run --project node <file>`: 6 passed, 0 skipped). Criterion 2: a `POST` with `name` and `note` gives 201 with the head's `seq`, one with `seq` 1 gives that `seq`, each sends `dep.version.created.v1` and a `version.created` notice; a viewer gets 403; a `seq` above the head gives `validation_failed`. Criterion 3: the owner lists `seq` 1 and 2 in order, `limit` and `cursor` page one at a time, and a viewer lists only `seq` 2. Criterion 4: a repeated `POST` with one `Idempotency-Key` gives the same version with `dep-idempotent-replayed: true`, and a second key for the same `seq` and kind returns the stored version. The routes are `src/control-plane/versions-routes.ts`; the memory store is `src/storage/versions-memory.ts`; the PostgreSQL store is `src/storage/versions-store.ts` (HIS-006 test in `test/postgres/his-006-versions.pg.test.ts` still passes).

**Notes:** What is grouped and how is HIS-006, HIS-008, HIS-011. The `field` filter needs the feature `fields`. Lane PRO-043-056, round 3: not started; no criterion ticked. Named versions need a version store that does not exist (no `versions` table or store in `services/document-service/src/storage`); the grouping and `createVersion` are in `packages/history` (`groups.ts`, `versions.ts`), which `services/document-service` cannot import until `@docedit/history` is added to its package.json (main session). Lane U-PRO-052-068, 2026-11-13: the version store and the named-version routes are built without that package (`versions-routes.ts` checks the same rules and calls `authorise` for row `version.create`; the decision is in docs/adr/0312-lane-U-PRO-052-068.md). Criterion 1 stays open: the history filters and grouping need `@docedit/history`. Criterion 5 stays open: its above-head branch is tested, but a refusal below the gate by a caller with `edit` cannot be reached over HTTP under the default `editors` setting, and the store-level refusal is in `test/postgres/his-006-versions.pg.test.ts`. Needed from the main session: add `"@docedit/history": "workspace:*"` to `services/document-service/package.json` (run through `scripts/pnpm-locked.ps1`) so that PRO-054 criterion 1, PRO-055 and PRO-056 can use `groups.ts`, `compare.ts` and `restore.ts`.

### PRO-055 Compare versions and read attribution

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Author |

**Spec:** 05 §6.2; 08 §6, §7 · **Requirements:** R4 · **Depends on:** PRO-054

As an author, I want to compare two versions and see who wrote which passage, so that I can review what changed and who changed it.

**Acceptance criteria**

- [x] Given a caller with `view`, when `GET /documents/{id}/diff` is called with `fromSeq` and `toSeq`, optionally `region` and `granularity` of `word` or `char`, then it returns the comparison between those versions.
- [x] Given a caller with `view`, when `GET /documents/{id}/attribution` is called for a region or a block range, then it returns who wrote which spans (HIS-014, HIS-015).
- [x] Given a `fromSeq` or `toSeq` below the caller's visibility gate, when either route is called, then it is refused.
- [x] Given a `granularity` other than `word` or `char`, when `diff` is called, then it fails with `validation_failed`.

**Evidence (lane w5, 2026-11-17):** `services/document-service/test/control-plane/pro-055-diff-attribution.test.ts` (HTTP over the harness, memory and PostgreSQL; `pnpm exec vitest run --project node <file>`: 16 passed, 0 skipped). Criterion 1: after three commits by bob, alice and bob, `diff` from 0 to 3 gives method `steps` and a `modified` change whose insert spans name those users and `seq` values; `granularity=char` and a `region` are accepted and echoed. Criterion 2: `attribution` at the head gives bob 3, alice 2, bob 1 and then the creator's seq 0 for the first block; `seq=2`, `blocks=` and `region=` narrow it; an unknown region, block or a `seq` above the head is 404. Criterion 3: a viewer (history visibility `editors`) gets 403 for `diff` from seq 1 and `attribution` at `seq=1`, and 200 at the head. Criterion 4: `granularity=line` is 400 `validation_failed`. The routes are `src/control-plane/history-reads.ts`; the decisions are in docs/adr/0373-w5-PRO-055-history-reads.md (proposed): `seq` and `blocks` are new query members of `getAttribution` (spec regenerated), the attribution map is replayed from the creator's seq 0 content.

**Notes (earlier lanes, now out of date):** PRO-043-056 round 3 found the routes blocked on `@docedit/history` missing from `services/document-service/package.json`; the dependency is present now. Restricted-reader projection of `diff` and `attribution` (ADR 0019) is done by the algorithms with the reader's hidden set and is covered by HIS-046 in `packages/history`; it is not re-tested over HTTP here. A restore does not keep the original authors in the route (ADR 0373 decision 2).

**Notes (older):** Lane PRO-043-056, round 3: not started; no criterion ticked. The comparison engine exists (`compare()` in `packages/history/src/compare.ts`, with the gate and the hidden set), and the operation is defined as `getDiff` in `packages/protocol/src/definition/resources.ts`. It is blocked: `services/document-service/package.json` does not depend on `@docedit/history`, and adding it is a package.json change for the main session. Attribution (`GET /documents/{id}/attribution`) has no engine wiring either.

### PRO-056 Restore a document or a region

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Owner |

**Spec:** 05 §6.2, §5.3; 07 §12, §13; 08 §8 · **Requirements:** R4 · **Depends on:** PRO-054, PRO-030

As an owner, I want to restore a whole document or one region to an earlier point, with a preview first, so that I can undo a mistake without losing later work elsewhere.

**Acceptance criteria**

- [x] Given `POST /documents/{id}/restore` with `toSeq` and `dryRun`, when it is called, then it returns what would change and stores nothing.
- [x] Given a whole-document restore by a caller with `manage`, when it is applied, then a snapshot commit is stored and clients receive `sync.reset` with reason `restore`; given a caller without `manage`, then it is refused.
- [x] Given a restore of one `region` by a caller with `edit` in that region, when the region is not approved and not leased to someone else, then it is applied; otherwise it is refused.
- [x] Given a restore, when it is applied, then grants are not restored.
- [x] Given a restore that is applied, when it is stored, then `version.restored` is sent and `dep.version.restored` is raised.

**Evidence (lane w5, 2026-11-17):** `services/document-service/test/control-plane/pro-056-restore-region-dryrun.test.ts` (HTTP over the harness with the real data plane, memory and PostgreSQL; `pnpm exec vitest run --project node <file>`: 16 passed, 0 skipped). Criterion 1: a dry run of the whole document (owner) and of one region (editor) answers `{ dryRun: true, kind, unchanged, notes, comparison }` with a non-empty comparison, and afterwards the head, the `pre-restore` and `restore` versions, the events and the grants revision are as they were. Criterion 2: an editor gets 403 for a whole restore and for its dry run (the applied whole restore, its snapshot commit and `pre-restore` and `restore` versions are `test/control-plane/his-019-restore-route.test.ts`); `services/document-service/src/data-plane/pro-056-restore-reset.test.ts` shows a snapshot stored with reason `restore` reaches an open client as `sync.reset` with `reason: 'restore'` and one stored as an import keeps `import` (1 passed). Criterion 3: an editor restores the open region to seq 0 (200), the text of the open region is back to seq 0 and the legal region keeps seq 2; the stored commit is a snapshot with origin and reason `restore`; an approved region and a region leased to someone else are 409 `conflict`; a viewer, and an editor in the restricted region without a grant, are 403; an unknown region is 404; a restore that changes nothing stores nothing. Criterion 4: the grants revision is the same before and after the region restore (for the whole document, the route reads and writes no grant data; HIS-019 ticks the same behaviour). Criterion 5: `dep.version.restored.v1` is raised once with the new `seq`; the live notice `version.restored` for a whole-document restore is `test/control-plane/pro-036-live-events.test.ts`, and the region restore sends the same notice from the same code (`commitRestore` in `src/control-plane/restore-route.ts`). Decisions in docs/adr/0374-w5-PRO-056-region-restore.md (proposed).

**Notes:** Behaviour is HIS-018, HIS-019, HIS-022 and PRM's. Lane w5, 2026-11-17: a region restore is applied as a snapshot commit of the whole document with only that region restored, not as a steps commit, because the control plane cannot hand steps to the room (ADR 0374 decisions 2 and 3; review SR-M29 is not settled by this). A commit that lands between the route's head check and the room's apply would be overwritten; closing that needs a data-plane change. The `RestoreResult` and dry-run shapes are this lane's (G69 is still open). Earlier lane note (out of date): PRO-043-056 round 3 found the route blocked on `@docedit/history` missing from package.json. `planRestore` and `markRestored` exist in `packages/history/src/restore.ts`, but the route needs `@docedit/history` in `services/document-service/package.json` (not present) and the named-version and log-replay inputs that PRO-054 and PRO-055 also need.

### PRO-057 Fork a document from the host

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | S | should | Integrating developer |

**Spec:** 05 §6.2, §8.1; 08 §8; review section 4 · **Requirements:** R4, R15 · **Depends on:** PRO-012, PRO-054

As an integrating developer, I want forks to go through my backend, so that my application knows about every document.

**Acceptance criteria**

- [x] Given a service credential, when `POST /documents/{id}/fork` is called with `atSeq` and whether grants are copied, then a new document is created and returned.
- [x] Given a user token, when the route is called, then it is refused.
- [ ] Given a user who asks for a copy in the editor, when they activate it, then the component raises `de-fork-request` (bubbling, composed, identifiers only) and never calls the fork route itself.
- [ ] Given `atSeq` below the caller's visibility gate, when the request is made, then it is refused (PRM-041, PRM-042).

**Evidence:** `services/document-service/src/control-plane/history-routes.test.ts` (memory storage, 5 passed in the run of 2026-11-13). Criterion 1: a service credential forks at `atSeq` 0 and gets 201 with the new document and its Location; with `copyGrants` true the grants are copied, and without it the copy has none. Criterion 2: a user token gets 403.

**Notes:** Pitfall decision of the review (section 4): service credential only. Lane PRO-057-070 (2026-11-13): criterion 3 stays open, because `de-fork-request` is raised by the component (the UI lane), which is not built here. Lane V-PRO-052-068, 2026-11-13: `packages/element/src/events.ts` has no `de-fork-request` entry yet, and no editor action raises one (docs/adr/0312-lane-V-PRO-052-068.md, section 10). Criterion 4 stays open: only a service credential may call the route, and a service credential passes every visibility gate, so there is no caller below the gate to refuse.

**Notes (lane w5, 2026-11-17):** Blocked; nothing new ticked. de-fork-request is defined in packages/protocol and named in packages/element/src/events.ts, but no editor action raises it, and the editor has no copy action to activate. Criterion 3 needs that action (the editor UI lane). Criterion 4 is unchanged: a service credential passes every visibility gate, so there is no caller below the gate to refuse.

### PRO-058 Track what changed since the last visit

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | S | should | Author |

**Spec:** 05 §6.2; 08 §10 · **Requirements:** R4 · **Depends on:** PRO-054

As an author, I want to see what other people changed since I last looked, so that I can catch up quickly.

**Acceptance criteria**

- [x] Given a caller, when `PUT /documents/{id}/read-marker` records a `seq`, then the marker is stored for that caller and document.
- [x] Given a marker at `seq` 100, when `PUT` records 90, then the marker stays at 100; the marker only moves forward.
- [ ] Given a marker, when `GET /documents/{id}/activity` is called, then it returns changes and comment activity by other people since the marker, not the caller's own.
- [x] Given a marker below the visibility gate, when activity is read, then nothing below the gate is shown (HIS-027, HIS-028).

**Evidence:** Lane V-PRO-052-068, 2026-11-13: `services/document-service/test/control-plane/pro-058-read-marker-activity.test.ts` (HTTP over the harness, memory and PostgreSQL in Podman, `docedit-test-postgres`; `pnpm vitest run --project node <file>`: 10 passed, 0 skipped). Criteria 1 and 2: `PUT .../read-marker` with 2 then 1 answers 2; the marker is per caller (another caller reads 0). Criterion 4: a viewer on an `editors` document sees only seq 3, not seq 1. The route is `src/control-plane/activity-route.ts` (`getActivity`), wired in `handlers.ts`; the marker store is `src/storage/read-markers.ts` (PostgreSQL migration 0050). Fixer V-SYN-037-053, 2026-11-13: a reader whose view hides a region no longer gets `unavailable` (503); the list is projected for their class, and a change whose scopes touch a hidden region is left out. Tested by the describe "activity for a reader restricted from one region" in the same file (an editor sees seq 1 only, and the reply never names the hidden region; an owner sees seqs 1 to 3), and `services/document-service/test/control-plane/be-098-read-sweep.test.ts` passes again (memory and PostgreSQL in Podman; both files together: 24 tests pass, 0 skipped). The decision line in docs/adr/0312-lane-V-PRO-052-068.md still says `unavailable`; the route's header comment records the change.

**Notes:** Lane V-PRO-052-068 (2026-11-13): criterion 3 stays open. The activity lists changes by others (not the caller's own; control commits are left out), but comment activity has no source until threads (PRO-059) exist. The reply shape is a proposal (`Activity` is a placeholder in `spec/dep`; docs/adr/0312-lane-V-PRO-052-068.md). Lane U-PRO-052-068, 2026-11-13: criterion 3 is blocked by a design question, not by code: a comment has no `seq`, and the activity is keyed by `seq` (docs/adr/0312-lane-U-PRO-052-068.md, section 7). Lane PRO-057-070, 2026-11-13: no read-marker store and no `activity` route exist in `services/document-service/src/control-plane` (`history-routes.ts` states that both are outside that module). No criterion is ticked.

**Notes (lane w5, 2026-11-17):** Blocked; nothing new ticked. Criterion 3 needs comment activity in GET /documents/{id}/activity. services/document-service/src/control-plane/activity-route.ts lists only changes by others and leaves comments out, because a comment has no seq yet (docs/adr/0312-lane-U-PRO-052-068.md, section 7). That design question has to be decided before the criterion can be met.

## Control plane: comments (05 §6.2)

### PRO-059 Start a comment thread on a range or a block

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Commenter |

**Spec:** 05 §6.2; ADR 0015; 07 §6, §12 · **Requirements:** R8 · **Depends on:** PRO-040, PRO-045, PRO-043

As a commenter, I want to start a thread on a passage or a block, so that a conversation stays attached to the text.

**Acceptance criteria**

- [x] Given a caller with `comment` in the target's scope, when `POST /documents/{id}/threads` is called with `target` as `{ range: { from, to, baseSeq } }` or `{ block: id }` and a first comment, then a thread is created and `thread.created` is sent.
- [x] Given a range target, when `baseSeq` is within the rebase window (`maxRebaseSteps`), then the room maps the range to the head and checks `comment` there; given a `baseSeq` outside the window, then the request is refused.
- [ ] Given a range that, after mapping, lies in a scope where the caller has no `comment`, when the thread is created, then it is refused with `permission_denied`.
- [x] Given `GET /documents/{id}/threads`, when it is called with `?seq`, then ranges are reported for that `seq`.
- [x] Given a repeated `POST` with the same `Idempotency-Key`, when it is processed, then one thread exists.

**Evidence:** Criterion 5 (lane U-PRO-052-068, 2026-11-13): `services/document-service/test/control-plane/pro-059-threads.test.ts`, "creates one thread for a repeated POST with the same Idempotency-Key", run with `pnpm vitest run --project node <file>` in memory and against PostgreSQL in Podman (`docedit-test-postgres`): both variants passed (8 tests in the file). The second POST returns the first thread's identifier. Criterion 1 for a block target is in the same file ("starts a thread on a block ..."), with `dep.thread.created.v1` and the `thread.created` notice; the range branch is not built.

**Evidence (lane V-PRO-052-068, 2026-11-13):** criterion 1, the range branch: `services/document-service/test/control-plane/pro-059-range-threads.test.ts` (HTTP over the harness, memory and PostgreSQL in Podman, `docedit-test-postgres`; `pnpm vitest run --project node <file>`: 6 passed): a range at the head is stored and read back with its `range`, and `thread.created` is sent; the block branch is in `pro-059-threads.test.ts` (8 passed with it). Criterion 2, the mapping: a range with a `baseSeq` before a typing commit is stored moved by the typed length (`pro-059-range-threads.test.ts`, "maps a range from its baseSeq"); a `baseSeq` above the head and a range with `from` above `to` are 4xx, and a viewer is 403 (the refusal of criterion 3, for a scope the viewer cannot comment in). The rebase-window refusal of criterion 2 is built (`thread-routes.ts`, `placeTarget`, `DEFAULT_LIMITS.maxRebaseSteps`) but not tested: the window is too large to reach in a test.

**Evidence (lane w5, 2026-11-17):** criteria 2 and 4, over HTTP in memory and PostgreSQL in Podman: `services/document-service/test/control-plane/pro-059-window-scope-seq.test.ts` (8 tests, `pnpm exec vitest run --project node <file>`, all passed) and `pro-059-range-threads.test.ts` (updated for `baseSeq`, passed). Criterion 2: with the window set to 2 (`maxRebaseSteps` of `ServiceConfig`, shared by the REST check and the data plane) and the head at 3, `baseSeq` 0 is 400 `validation_failed` naming the rebase window, and `baseSeq` 1 is accepted and mapped through the two typings. Criterion 4: `GET /documents/{id}/threads` (new, `thread-routes.ts` `listThreads`, `ThreadStore.list`) reports a range made at seq 0 as `{from, to, baseSeq: 0}` at `?seq=0`, moved right by the typed text at `?seq=1`, and at the head with no `?seq`; a thread made at seq 2 is absent at `?seq=0` and `?seq=1`; `?seq=99` is 400; the list pages with `limit` and `cursor`, in creation order, for one document only, and a token that does not cover the document is refused. Criterion 3, the scenario: a commenter with a `viewer` grant on the restricted legal region is refused (403 `forbidden`) a range that after mapping from `baseSeq` 0 covers the legal text, an owner is admitted on the same range, and the commenter is admitted on a range in the body. Decisions: `docs/adr/0372-w5-PRO-059-thread-list-and-refusal-code.md` (proposed).

**Notes:** Range mapping is SYN-032. Lane w5 (2026-11-17): criterion 3 stays unticked because of its wording. It asks for `permission_denied`, which the error registry lists for the socket only (05 §5.8); on REST the refusal is `forbidden` (403), as the thread routes have always answered, and `checkProblem` flags `permission_denied` on REST. The behaviour (refusal in a scope without `comment` after mapping) is now tested; the owner must say whether the criterion is read as the registry's REST code or the registry changes (ADR 0372, decision 1). The window of criterion 2 is counted in seq distance, not steps (ADR 0372, decision 6). Lane V-PRO-052-068, 2026-11-13: the range target is built: `placeTarget` in `services/document-service/src/control-plane/thread-routes.ts` maps the range with `mapRangesThrough` over the commits after `baseSeq` (`d.logs.read`), and checks `comment` in every scope the mapped range covers (`rangeScopes`); the scopes are stored joined by a newline in `scope`, and the head seq in `range_seq`. Criterion 2 stays open for the window refusal (not tested). Criterion 3 stays open: the refusal the viewer gets is `forbidden` on the wire (403, as the other thread routes send it), not the literal `permission_denied`, and no test puts the caller in a scope it lacks comment in after mapping. Criterion 4 (`?seq`) is not built. Comments stay available during a workflow (review section 3, fields). Lane U-PRO-052-068, 2026-11-13: the thread store (`services/document-service/src/storage/thread-store.ts`, PostgreSQL on the `threads` and `comments` tables of 0050) and the routes (`services/document-service/src/control-plane/thread-routes.ts`) store block targets only. A range target is refused with `validation_failed` until the room maps ranges for the control plane (criterion 2 stays open: the mapping of `baseSeq` and the rebase window are not wired). Criterion 1 stays unticked for that branch. Criterion 3 (a range in a scope without `comment`) is not tested for a range; the block form is refused for a viewer in the same test file. Criterion 4 (`?seq`) is not built.

### PRO-060 Resolve, reassign, reply to and delete threads and comments

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Commenter |

**Spec:** 05 §6.2; 07 §12; 13 §5 · **Requirements:** R8 · **Depends on:** PRO-059, PRO-042

As a commenter, I want to reply, resolve, assign and delete within the rules, so that threads stay tidy and only the right people can remove them.

**Acceptance criteria**

- [x] Given `GET /threads/{tid}`, when it is called with a bare identifier, then the server resolves it to its document and checks `view` (PRO-045).
- [x] Given a caller with `comment` in the thread's scope, when `PATCH /threads/{tid}` changes `state` to `open` or `resolved` or sets `assignee` with a current `If-Match`, then the change is stored and `thread.resolved`, `thread.reopened` or `thread.updated` is sent.
- [x] Given `DELETE /threads/{tid}`, when the caller is the author or has `manage`, then the thread is deleted and `thread.deleted` is sent; otherwise it is refused.
- [ ] Given `POST /threads/{tid}/comments` with a body that contains mentions, when it is stored, then `comment.created` is sent and the mentions are available to the webhook `dep.comment.mentioned` (PRO-073).
- [x] Given `PATCH` or `DELETE /comments/{cid}`, when the caller is the comment's author or has `manage`, then the change is stored; otherwise it is refused.


**Evidence:** Criterion 3 (lane U-PRO-052-068, 2026-11-13; unticked by the reviewer of U3 group 1 round 3 because the `thread.deleted` notice was not checked, re-ticked by the round 3 fixer once the test checked it): `services/document-service/test/control-plane/pro-059-threads.test.ts`, "starts a thread on a block ..." (an editor who is not the author is refused with 403, the thread stays, and neither the event nor the notice is sent; the author gets 204, `dep.thread.deleted.v1` rises by exactly one with the document as subject and the thread identifier in its data, and the stub data plane records exactly one `notify` of type `thread.deleted` for `/threads/{tid}` on the thread's document; the thread is then 404) and "lets an owner (manage) delete a thread it did not start". Run with `pnpm vitest run --project node <file>` in memory and against PostgreSQL in Podman (`docedit-test-postgres`): both variants passed. The PostgreSQL delete needs `grant delete on threads, comments` (migration `services/document-service/migrations/0063_pro_059_thread_delete_grant.sql`, added by this lane).

**Evidence (lane V-PRO-052-068, 2026-11-13):** `services/document-service/test/control-plane/pro-060-thread-changes.test.ts` (HTTP over the harness, memory and PostgreSQL in Podman, `docedit-test-postgres`; `pnpm vitest run --project node <file>`: 10 passed; run together with `pro-059-threads.test.ts`, 18 passed, and four later runs of both passed). Criterion 1: a viewer reads a thread by its bare identifier; an editor who cannot see a restricted region gets `not_found` to read, change and reply, and the owner reads it (`thread-routes.ts`, `readerView`; ADR 0019). Round 2 fix (V3 group 1): the write routes ran `checkIfMatch` before the hidden-region check, so a hidden thread or comment answered 428 or 412 instead of 404; `mustSee` in `thread-routes.ts` now runs first in `updateThread`, `updateComment` and `deleteComment`. `services/document-service/test/control-plane/pro-060-hidden-thread-writes.test.ts` sends `PATCH /threads/{tid}`, `PATCH /comments/{cid}` and `DELETE /comments/{cid}` as an editor who cannot see the region with no, a bogus and the right `If-Match`, and `DELETE /threads/{tid}`: each is 404, as for a missing identifier, and nothing changes (memory and PostgreSQL in `docedit-test-postgres`; run with `pro-060-thread-changes.test.ts`, 16 passed, 0 skipped). Criterion 2: `PATCH` without `If-Match` is 428 and a stale tag 412, a viewer is 403, an editor's resolve, reopen and assignee change is stored and announced (`dep.thread.resolved.v1`, `dep.thread.reopened.v1`, notices `thread.resolved`, `thread.reopened`, `thread.updated`), and a wrong state is refused. Criterion 5: the author's edit with `If-Match` is stored and gets a new tag, another editor is 403, the author's delete is 204 and then 404, and an owner deletes another's comment. The store operations are `update`, `addComment`, `findComment`, `editComment` and `deleteComment` in `services/document-service/src/storage/thread-store.ts` (PostgreSQL soft delete on `comments.deleted_at`; no migration). Criterion 4 is not ticked: the comment route stores a reply and sends `comment.created` and `dep.comment.created` (201 for a user with `comment`, 403 for a viewer and a service credential), but no mention is read, so `dep.comment.mentioned` is not sent.

**Notes:** Mentions and tasks are UX-028, UX-031. Lane V-PRO-052-068, 2026-11-13: the ETag of a thread is `"<id>:<state>:<assignee>"` and that of a comment `"<id>:<edit time>"`, so each change the criteria name moves the tag (decision recorded in docs/adr/0312-lane-V-PRO-052-068.md, section 8). The routes for changes and comments that the earlier note called not built are now in `thread-routes.ts`. A range target is still refused (PRO-059 criterion 2), so the range scope check of criterion 3 stays open. Lane U-PRO-052-068, 2026-11-13: `GET /threads/{tid}` and `DELETE /threads/{tid}` are built in `services/document-service/src/control-plane/thread-routes.ts` on the thread store of PRO-059 (block targets only). Criterion 1 stays unticked: the bare-identifier lookup, the `view` check and the `not_found` for a token that does not cover the document are tested (a viewer reads, a foreign token gets 404), but no test shows the `view` refusal in a hidden region (ADR 0019). The `comment` check for a range (criterion 3's scope rule) is not wired. PATCH (criterion 2) and the comment routes (`POST /threads/{tid}/comments`, `PATCH` and `DELETE /comments/{cid}`) are not built.

## Control plane: assets (05 §6.2)

### PRO-061 Upload an asset through quarantine

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 05 §6.2; 07 §12; 10 §3.5 · **Requirements:** R10 · **Depends on:** PRO-045, PRO-043

As an author, I want to add an image to the document, so that the document can carry figures without trusting what I uploaded.

**Acceptance criteria**

- [x] Given a caller with `edit`, `suggest` or `fill` somewhere in the document, when `POST /documents/{id}/assets` is called with `filename`, `mime` and `size`, then it returns an asset identifier and a pre-signed upload into a quarantine area that is bound to that size.
- [x] Given an upload larger than the declared `size`, when it reaches the store, then it is refused.
- [x] Given a completed upload, when `POST /assets/{aid}/complete` is called, then the asset worker validates, re-encodes, hashes and stores the asset and raises `asset.ready`, or `asset.failed` when validation fails (including a declared type that differs from the detected type).
- [x] Given an asset that is not ready, when its URL is requested (PRO-062), then no URL is returned.
- [x] Given a caller with only `view`, when it requests an upload, then the request is refused.

**Evidence:** `services/document-service/test/control-plane/routes.assets.test.ts` (memory storage; the PostgreSQL run skips without a database). Criterion 1: "gives an editor an identifier and a size-bound upload into quarantine, and refuses viewers" (201 with `quarantined`, `content-length` set to the declared size). Criterion 3: "completes an upload through the asset worker, which raises asset.ready to the uploader" and "fails an upload whose content differs from its declared type, with asset.failed". Criterion 4: "fails an upload whose content differs from its declared type" (a failed asset resolves to no URL) and "resolves ready, attached assets the caller can see ..." (a quarantined upload resolves to no URL; passes 2026-11-13). Criterion 5: the same first test (a `view`-only caller gets 403). Criterion 2 (lane U-PRO-052-068, 2026-11-13): `services/asset-worker/test/s3.test.ts`, "accepts exactly the declared size and refuses more, less, or an unsized stream", run against the S3-compatible store of the test environment (Versity S3 Gateway in Podman, `docedit-test-s3`, port 57070): 7 passed, 0 skipped, with `pnpm vitest run --project node services/asset-worker/test/s3.test.ts`. The PostgreSQL variant of `routes.assets.test.ts` also ran (PostgreSQL in Podman, `docedit-test-postgres`, port 55432): 8 passed.

**Notes:** Validation and re-encoding are BE-043; the security tests are SEC's. Packet C (2026-11-13): criterion 2 (the store refuses an upload over its declared size) stays open: the presigned upload is bound to the size, but no test shows the store refusing a larger body. Criterion 4 is met since the PRO-062 resolve test passes (it now sends a version 7 identifier). Lane PRO-057-070, 2026-11-13: criterion 2 is tested by `services/asset-worker/test/s3.test.ts`, "accepts exactly the declared size and refuses more, less, or an unsized stream". That test needs the S3-compatible store (`infra/test-env.ps1 up -NoExport`). Lane U-PRO-052-068, 2026-11-13: it ran against the store in Podman and passed, so criterion 2 is ticked.

### PRO-062 Resolve asset identifiers to short-lived URLs

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Viewer |

**Spec:** 05 §6.2; 07 §12; 10 §3.5 · **Requirements:** R10 · **Depends on:** PRO-061

As a viewer, I want images in the document to load, so that figures appear even though an image element cannot send a bearer token.

**Acceptance criteria**

- [x] Given a caller with `view`, when `POST /documents/{id}/assets/resolve` is called with asset identifiers used by the document, then it returns a signed URL for each ready asset.
- [x] Given a signed URL, when it is used after its short expiry, then it fails.
- [x] Given an asset that is not attached to the document, when it is included in the request, then no URL is returned for it.
- [x] Given a signed URL, when it is fetched, then the asset is served with a fixed content type from a separate origin.

**Evidence:** `services/document-service/test/control-plane/routes.assets.test.ts` "resolves ready, attached assets the caller can see to short-lived URLs of the separate origin" (memory storage; the PostgreSQL run skips without a database; passes 2026-11-13). Criterion 1: a viewer gets a signed URL for the ready image in the region it can see, and not for the one in the hidden region or for a quarantined upload. Criterion 2: the expiry is within ten minutes, and the asset origin's verifier (`verifyAssetUrl` in `@docedit/asset-worker`) refuses the URL as `expired` one second after it. Criterion 3: a ready upload not referenced by the document gets no URL for the viewer, and an asset of another document gets none there. Criterion 4: the URL's origin differs from the service's, and the asset origin serves it with `image/png` and `X-Content-Type-Options: nosniff`.

**Notes:** Second review (2026-11-06, SPK-027): SR-C4, under ADR 0019 an asset is resolved only if it is referenced from a scope the caller can see; SR-C1, the original Word file, the source map and preserved fragments (ADR 0017) are never resolved for clients that do not see the whole document ([review](../review/2026-11-06-second-review.md)). Packet C (2026-11-13): the resolve test sent `randomUUID()` (a version 4 identifier), and `ResolveAssetsRequest` in `spec/dep/dep-1.openapi.json` requires a version 7 UUID, so the request was refused with 400. It now sends `uuid7()` and passes. Criterion 2 is shown through the origin's verifier at a time after the expiry, not by a fetch that waits out the expiry.

## Control plane: exports and imports (05 §6.2)

### PRO-063 Request an export

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Author |

**Spec:** 05 §6.2; 09 §9.1; 07 §12 · **Requirements:** R5 · **Depends on:** PRO-045

As an author, I want to ask for a PDF or another format and get a job, so that long typesetting never blocks me.

**Acceptance criteria**

- [x] Given a caller with `view`, when `POST /documents/{id}/exports` is called with `target` (one of `pdf`, `tex`, `docx`, `cdm`, `html`, `md`), optional `seq` and `options`, then the response is `202` with a job.
- [x] Given a `seq` below the caller's visibility gate, when it is requested, then it is refused (PRM-041, PRM-042).
- [x] Given a target that the server does not support, when it is requested, then the request fails with `validation_failed`; given a server that does not announce `exports`, then the route is not used.
- [x] Given the options of EXP-004, EXP-005, when they are supplied, then they are passed to the job unchanged.

**Evidence (lane V-PRO-052-068, 2026-11-13):** criterion 3: `packages/backend-dep/test/pro-063-no-exports.test.ts` (in-memory network, Node.js; `pnpm vitest run --project node <file>`: 2 passed): a welcome that leaves out `exports` gives no request naming `/exports` and no `exports` port, and announcing it gives the port. The `validation_failed` answer for an unsupported target (`svg`) is in `services/document-service/test/control-plane/routes.exports.test.ts`, memory variant.

**Evidence:** `services/document-service/src/control-plane/handlers.ts` (`createExport`; D68). `services/document-service/test/control-plane/routes.exports.test.ts`: a caller with `view` gets 202 with a job and a Location; the options reach the job unchanged, with the requester's role and class (EXP-123).

**Evidence:** `services/document-service/test/control-plane/routes.exports-gate.test.ts`, memory variant, "refuses a seq below the history gate for a viewer and allows the head and full history" (run of 2026-11-13, passed): a viewer asking for `seq` 0 with the head at 2 gets 403 `forbidden`; `seq` 2 (the head) gets 202; an owner gets 202 for `seq` 0. The commits are appended to the log as in `routes.commits.test.ts`. Lane U-PRO-052-068, 2026-11-13: `routes.exports.test.ts` and `routes.exports-gate.test.ts` ran with the PostgreSQL variants against PostgreSQL in Podman (`docedit-test-postgres`, port 55432): 12 passed, 0 skipped, with `pnpm vitest run --project node` on both files.

**Notes:** Phase 1a covers target `pdf`; `tex` arrives with the 1b export scope, `html` and `md` in phase 2 and `docx` in the DOCX work. The default for an omitted `seq` is not stated. Packet A2 (2026-11-06): criterion 3 stays open (the client side of "no exports" is packet B), and the gate is PRM-041 (phase 1b); an unsupported target is `validation_failed` (tested), while not using the route without `exports` is the client (packet B). An omitted `seq` is the head when the request is accepted; a `no-export` caller is `forbidden` (D68).

### PRO-064 Follow and cancel an export job

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Author |

**Spec:** 05 §6.2, §5.6; 09 §9.1, §9.2 · **Requirements:** R5 · **Depends on:** PRO-063, PRO-045

As an author, I want to see the state and progress of my export and to cancel it, so that I know when the file is ready or why it failed.

**Acceptance criteria**

- [x] Given a job, when `GET /exports/{jid}` is called, then it returns the state (`queued`, `converting`, `compiling`, `completed`, `failed` or `cancelled`), progress, the result and diagnostics.
- [x] Given a completed job, when the result is read, then it holds what EXP-004, EXP-005 defines (a signed URL with expiry, page count, the URL of `layout.json`, warnings and diagnostics).
- [x] Given a running job, when `DELETE /exports/{jid}` is called by a caller who may read it, then the job ends in `cancelled`.
- [x] Given a job, when it progresses, completes, fails or is cancelled, then the matching events are sent (PRO-035).
- [x] Given a caller of another document, when it asks for the job, then it is refused (PRO-045).

**Evidence:** `services/document-service/src/control-plane/handlers.ts` (`getExport`, `cancelExport`; D68, D69) and the job runner. `services/document-service/test/control-plane/routes.exports.test.ts`: the job reports queued, converting and completed with progress; a completed result holds a signed URL with its expiry, the page count, the signed URL of `layout.json`, convergence and diagnostics, and the raw log only for a requester with `edit`; DELETE ends a running job in `cancelled` and leaves a finished one; a caller of another document is refused, and so is any user but the requester (SR-C4). Criterion 4 (lane U-PRO-052-068, 2026-11-13): `services/document-service/src/control-plane/export-jobs.test.ts`, run with `pnpm vitest run --project node <file>` in memory and against PostgreSQL in Podman (`docedit-test-postgres`): "sends each stage as export.progress and raises export.completed and its webhook", "raises export.failed and its webhook when a compile fails for good" and "raises export.cancelled when a running job is cancelled" pass in both variants. `services/document-service/test/control-plane/pro-035-notifications.test.ts` (one file, passes) covers `export.cancelled` as well.

**Notes:** What `DELETE` does to a job that is already completed (cancel, or remove the result) is not stated. Events are phase 1b; the 1a panel can poll. Second review (2026-11-06, SPK-027), SR-C4: a bare job identifier needs only a token for its document (05 §6.1), so any reader can fetch another user's export and its raw log, and a user restricted with `no-export` can download someone else's; the review proposes that a job belongs to its requester (and, under ADR 0019, their visibility class), with its events sent to that requester only ([review](../review/2026-11-06-second-review.md)). Packet A2 (2026-11-06): criterion 4 stays open: events are phase 1b, and go to the requester only (D69). `DELETE` of a finished job changes nothing and answers 204 (D68). A job, its result and its log belong to the requester; service credentials may read them; whether holders of `manage` may is for the owner (D69). Lane U-PRO-052-068, 2026-11-13: criterion 4 is ticked (Evidence above; the tests do not check that the events reach only the requester, D69). In the same file one PostgreSQL test of BE-051 ("starts no second preview compile while the window runs") failed in this run on a compile count. It is not this story's criterion; it was left alone and is reported to the lane's owner.

### PRO-065 Refuse exports that need a decision

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | S | should | Author |

**Spec:** 05 §6.2, §3.1; 09 §10 · **Requirements:** R5, R8 · **Depends on:** PRO-063, PRO-015

As an author, I want the editor to tell me when a document has unresolved suggestions and to let me choose what the export does with them, so that a final PDF never contains a surprise.

**Acceptance criteria**

- [x] Given a document with unresolved suggestions, when an export is requested without `options.suggestions`, then it fails with `pending_suggestions`.
- [x] Given `options.suggestions` of `accept`, `reject` or `markup`, when the same request is sent, then a job is created (EXP-081, EXP-082).
- [x] Given a caller whose token carries `restrict` with `no-export`, when an export is requested, then it is refused.

**Evidence:** `services/document-service/test/control-plane/routes.exports.test.ts`, memory variant, "refuses unsupported targets, seqs above the head, no-export callers and pending suggestions (PRO-063 criteria 2, 3; D68)": a document with a suggestion answers 409 `pending_suggestions` without `options.suggestions` (criterion 1), a caller restricted with `no-export` gets `forbidden` (criterion 3), and `options.suggestions: accept` gives 202 (part of criterion 2). Run of 2026-11-13: `pnpm vitest run` on that file, 4 passed and 4 skipped (the PostgreSQL variant, no database); the memory variant of this test passed. Lane U-PRO-052-068, 2026-11-13: with PostgreSQL in Podman (`docedit-test-postgres`, port 55432) the same file ran with its PostgreSQL variant and passed (see PRO-063).

**Evidence:** `services/document-service/test/control-plane/routes.exports-gate.test.ts`, memory variant, "creates an export job for suggestion decisions reject and markup, as for accept" (run of 2026-11-13, passed): with `options.suggestions` of `accept`, `reject` and `markup` each gives 202 with a queued job that is then readable; without a decision the request fails with `pending_suggestions`.

**Notes:** Criterion 2 is met by the test named in Evidence (lane PRO-057-070, 2026-11-13); it was open because the existing test sent only `accept`. The evidence is an existing test in another lane's directory; control-plane-2 wrote no test for this story in round 2.

### PRO-066 Import a Word file

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Author |

**Spec:** 05 §6.2; 07 §12 · **Requirements:** R5 · **Depends on:** PRO-061, PRO-045

As an author, I want to start from a Word file, so that I can bring existing work into the editor.

**Acceptance criteria**

- [ ] Given an uploaded and ready asset, when `POST /documents/{id}/imports` is called with `asset` and `format` `docx`, then a job is returned.
- [ ] Given a job, when `GET /imports/{jid}` is called, then it returns the state and, when completed, the warnings.
- [ ] Given a job that ends, when it completes or fails, then `import.completed` or `import.failed` is sent and the matching webhook is raised.
- [ ] Given a document that is imported into, when the import is applied, then a snapshot commit with origin `import` is stored and clients receive `sync.reset` with reason `import`.

**Notes:** The authorisation matrix (07 §12) lists "Import" under the service credential, but 05 §6.2 does not mark this route that way (Open questions). Conversion is EXP-098. Lane PRO-057-070, 2026-11-13: `handlers.ts` answers imports with `validation_failed` (D62); no import route, job or conversion exists, so no criterion is ticked.

## Control plane: fonts and webhook management (05 §6.2)

### PRO-067 Read the font manifest

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Integrating developer |

**Spec:** 05 §6.2; 02 §3 · **Requirements:** R2, R5 · **Depends on:** PRO-040

As an integrating developer, I want a manifest of the fonts the service provides, so that the editor and the typesetter load identical files.

**Acceptance criteria**

- [x] Given a caller, when `GET /fonts` is called, then it returns families, styles, file URLs, hashes, licences and a manifest version.
- [x] Given each file URL, when the file is fetched, then its content matches the hash in the manifest.
- [x] Given a change to the set of fonts, when the manifest is read again, then the manifest version has changed.
- [x] Given the licences listed, when the manifest is checked, then every font allows bundling and server use.

**Evidence:** `services/document-service/src/control-plane/fonts.route.test.ts` (in-memory harness, `GET /v1/fonts` with a service token): criterion 1, the families, four faces with URLs, hashes and byte counts, the licence and the version; criterion 2, each face's file fetched from the service's `/fonts/` route has the SHA-256 of the manifest; criterion 3, the same set gives the same version, an added family changes it; criterion 4, a family with a licence outside the bundling list is not listed, and every listed licence is in `FONT_LICENCES`. Unit cases in `src/control-plane/fonts.test.ts` (BE-047) back the same rules. PostgreSQL is not used by this route test.

**Notes:** Registry and aliases are FE-061; the assets and manifest storage are BE's; the LaTeX side is EXP's. Phase inferred: the 1b component needs it and 11 does not list it. Packet C (2026-11-13): criterion 4 checks the licence list the service uses (`FONT_LICENCES`, from `licences/policy.json`); that the list itself matches the policy file is FND-011's check.

### PRO-068 Manage webhook subscriptions

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Integrating developer |

**Spec:** 05 §6.2, §7 · **Requirements:** R6, R10 · **Depends on:** PRO-012, PRO-042, PRO-043

As an integrating developer, I want to subscribe my backend to events, rotate its secret and replay missed deliveries, so that I can run an integration without losing events.

**Acceptance criteria**

- [x] Given a service credential, when `POST /webhooks` is called with a URL and event filters, then a subscription is created; given `GET`, `PATCH` and `DELETE` on `/webhooks/{id}`, then they list, change and remove it with `If-Match`.
- [x] Given a user token, when any `/webhooks` route is called, then it is refused.
- [x] Given a secret rotation, when it is requested, then two secrets are active until the old one is retired (PRO-070).
- [ ] Given a test ping, when it is requested, then a signed test delivery reaches the target.
- [ ] Given recent deliveries, when a replay is requested, then they are sent again with the original `webhook-id`.
- [x] Given a subscription whose URL resolves to a private or link-local address, when a delivery is attempted, then it is refused (PRO-071).

**Evidence:** Criteria 1 to 3 (lane U-PRO-052-068, 2026-11-13): `services/document-service/test/control-plane/ux-079-webhook-admin.test.ts` (run with `pnpm vitest run --project node <file>`: 7 passed, and 18 with `webhook-subscriptions.test.ts`; in memory only, since no PostgreSQL store exists for subscriptions) sends the `/v1/webhooks` routes over HTTP through the request pipeline and the router, which `services/document-service/src/control-plane/webhook-routes.ts` maps and `handlers.ts` wires: `POST` creates a subscription with one secret shown once; `GET` reads it with its ETag and refuses a stale `If-Match`; `PATCH` rotates to two secrets, refuses a second rotation and retires the old secret; `DELETE` with `If-Match` gives 204 and then not found; a user token gets `forbidden` on every route; another tenant's subscription is not found. The operations under them are in `services/document-service/src/control-plane/webhook-subscriptions.test.ts` (run of 2026-11-13, 11 passed) tests the five operations of `WebhookSubscriptions` over `MemorySubscriptionStore`: create with one secret shown once; read and list without secrets; PATCH and DELETE refused without `If-Match` (428) or with a stale tag (412), accepted with the current tag or `*`; tenant isolation; a user caller refused with `forbidden` on every operation; rotation to two secrets, both verifying a delivery signed by `signDelivery`, a second rotation refused with `conflict`, retirement leaving the new secret only. Lane U-PRO-052-068, 2026-11-13: the mapping this sentence called missing is now in place, and criteria 1 to 3 are ticked on the HTTP test named in Evidence.

**Evidence (lane w5, 2026-11-17, criterion 6):** `services/document-service/test/control-plane/pro-068-w5-private-target.test.ts` (Node.js, `pnpm exec vitest run --project node` on that file, 5 of 5 pass on this machine). The service is the composed one (`startService` with `config.webhooks`, through `startHarness`, whose new `webhooks` option passes the dispatcher's overrides): a subscription is created over HTTP with `POST /v1/webhooks`, the event is raised by a real route (`POST /v1/documents`, `dep.document.created.v1`), and the transport is the real `EgressProxy`; only the resolver and the connector are fakes. A public target is sent once, signed, with the `webhook-id` of its row (the control). Targets that resolve to `10.0.0.5`, the metadata address `169.254.169.254`, the IPv6 link-local `fe80::1`, and a name with one private address among public ones each end with a `failed` row that carries a reason and no status, and the connector is never called for them.

**Notes:** Lane w5 (2026-11-17): criterion 6 is ticked on the test above; criteria 4 and 5 stay open, because no route exists for a test ping or a replay (see the end of this Notes). Criteria 4 and 5 are not built: the test ping and the replay send requests, so they wait for the dispatcher (BE-055) and the egress proxy (BE-056, PRO-071). The body of a subscription is a placeholder in `spec/dep` (gap G76); the body used here (`url`, `events`, `rotate`, `retire`) is a proposal in docs/adr/0151-control-plane-2-backlog-batch.md, not a published contract. Criterion 6 depends on PRO-071. Lane PRO-057-070, 2026-11-13: the dispatcher (`webhook-dispatcher.ts`) has a test ping and a replay that keeps the `webhook-id` (`webhook-dispatcher.test.ts`, criteria 3 and 4 there). They run over a fake transport, not the egress proxy (PRO-071 is not met), and no `/webhooks/{id}` route calls them, so criteria 4 and 5 stay unticked. Lane V-PRO-052-068 (2026-11-13): the protocol definition has no route for a test ping or a replay, so no route can be built against it yet; a proposed pair of paths is in docs/adr/0312-lane-V-PRO-052-068.md (section 5), for the owner to decide.

## Events plane: webhooks (05 §7)

### PRO-069 Wrap every webhook in a CloudEvents envelope

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Integrating developer |

**Spec:** 05 §7; ADR 0008 · **Requirements:** R6 · **Depends on:** PRO-003, PRO-068

As an integrating developer, I want webhook bodies in a standard envelope with a small, versioned payload, so that my receiver can use ordinary tooling and anchor changes independently.

**Acceptance criteria**

- [x] Given a delivery, when its body is read, then it is a CloudEvents 1.0 document in structured JSON mode with `specversion`, `id`, `source`, `type`, `subject` and `data`.
- [x] Given an event, when `type` is read, then it is the event name with a version suffix (for example `dep.export.completed.v1`), and `subject` is the document identifier.
- [x] Given `data`, when it is read, then it is small and includes `seq`; given an event about a content change, then it also includes the hash-chain head, so a host can anchor it independently.
- [x] Given every event type, when a delivery is validated against the schema of PRO-003, then it passes.
- [x] Given a later minor version that adds a field to `data`, when an old receiver reads it, then the unknown field is ignored (PRO-005); a change that removes or retypes a field is a new version suffix.

**Evidence:** Review of 2026-11-13: criteria 1 and 2 unticked, because `toCloudEvent` is imported only by its own test and no delivery exists (BE-055 is not built); tick them when the dispatcher builds its bodies with it. The builder itself is tested in services/document-service/src/control-plane/webhook-envelope.test.ts (criteria 1 and 2 at the level of the body the builder returns: `toCloudEvent` gives the seven CloudEvents attributes with `specversion` 1.0, `datacontenttype` application/json, `type` with its version suffix and `subject` as a UUID version 7; a body survives a JSON round trip). Run of 2026-11-13 with `pnpm vitest run` on the three control-plane-2 test files: 39 passed, 0 failed. No delivery exists yet, so no request is sent with these bodies (the dispatcher is BE-055).

**Evidence (lane PRO-057-070, 2026-11-13): criteria 1 and 2.** The delivery's body is now the output of `toCloudEvent`: `services/document-service/src/control-plane/webhook-dispatcher.ts` builds each body with it (line 185). `services/document-service/src/control-plane/webhook-envelope.test.ts`, "carries specversion, id, source, type, subject, time, datacontenttype and data" (the exact seven attributes and their values; `type` `dep.export.completed.v1`; `subject` the document), and "survives a JSON round trip unchanged, so it can be sent as the request body". `services/document-service/src/control-plane/webhook-dispatcher.test.ts`, "creates one row per matching subscription and sends the envelope with the three headers": the request body read back has `specversion` `1.0`, the `type`, the `subject` and `data.seq`. Run of 2026-11-13: the four control-plane webhook test files, 61 passed. Criteria 3 to 5 stay unticked (see Notes).

**Evidence (lane V-PRO-069-085, 2026-11-14): criterion 3 in part, criterion 4 in part.** `services/document-service/test/control-plane/pro-069-072-v-pro-069-085.test.ts` (memory and PostgreSQL storage, `pnpm vitest run` on that one file: 4 passed): the running handlers now give every document event `seq` (`dep.document.state_changed`, `dep.document.deleted`, as well as `dep.document.changed`), and `dep.document.changed` carries the hash-chain head (`chainHead`, 64 lowercase hex digits from the log store's state). Criterion 4 is checked for the four event types of a document's lifecycle (created, changed, state_changed, deleted) against their schemas in spec/dep/webhooks, with ajv from packages/protocol; the other event types are not yet checked this way. Criterion 3 stays open: `data` is not measured for size (no figure in the spec).

**Evidence (lane w5, 2026-11-17, criteria 4 and 5):** `services/document-service/test/control-plane/pro-069-w5-delivery-schemas.test.ts` (Node.js, `pnpm exec vitest run --project node` on that file, 4 of 4 pass on this machine). Criterion 4: the file lists every `spec/dep/webhooks/*.schema.json` (35 types on this tree, so a new schema is covered without a change), subscribes one subscription to all of them, raises one event of each type through the composed `WebhookDispatcher` over the real `EgressProxy` (fake resolver and connector), and validates the body that left the connector against the schema of its type with ajv (from `packages/protocol`, as in the V-PRO-069-085 test): 35 of 35 pass. The sample `data` is what the schemas require (`seq`, and `chainHead` for `dep.document.changed.v1`); every schema requires nothing else. Criterion 5: a `dep.document.changed.v1` whose `data` has an added field is delivered, the schema of the earlier version accepts the body (also with an added top-level attribute), and the reference host's `WebhookReceiver` (`apps/reference-host/src/lib/server/webhook-receiver.ts`, which reads `type` and `subject` and the signature) verifies the signature over the whole body, queues the event and passes `seq` and `chainHead` on, with the added field left alone. The same file shows the schema refusing a body that drops `chainHead` or retypes `seq`, which is the case that needs a new version suffix; no tool compares two published versions of a webhook schema, so that rule is shown on the schema and not enforced across releases.

**Evidence (lane w5, 2026-11-17, criterion 3):** a content change now carries the head on both ways it is raised: the REST route (`handlers.ts`, V-PRO-069-085 evidence) and a commit stored by a room (`RoomHost.#raiseChanged`; `services/document-service/test/data-plane/be-055-w5-change-event.test.ts` and `test/control-plane/be-055-w5-service-change.test.ts`, 3 of 3 pass: `seq` and a 64-digit `chainHead`, delivered). `data` is small in the sense that the code can state: it is `Record<string, string | number | boolean | null>` (`DepEvent`), flat, built from identifiers and numbers, and the 35 published schemas ask for `seq` (and `chainHead` for this type) and nothing else.

**Notes:** Lane w5 (2026-11-17): criterion 3 is ticked with BE-055. The spec gives no size limit for `data` ("small"), so none is tested; if the owner wants a byte limit it needs a figure. Criteria 4 and 5 are ticked on the test above. Criterion 4 covers the types for which the service has no producer yet (workflow, session, import, task and mention events) at the level of the delivery the dispatcher builds from a sample event, not of an event the service raised; the producers belong to their own stories. Criterion 3 stays open. The builder refuses an event without `data.seq`, or a `dep.document.changed.v1` without `data.chainHead`, but the running handlers do not meet it: `handlers.ts` emits `dep.document.changed` with `{ seq }` only, and `dep.grants.changed` with `{ rev }` and no `seq`, which `spec/dep/webhooks` does not allow. Both need a change in `handlers.ts` and `kit.ts`, which this lane does not own. Criterion 4 stays open: no JSON Schema validator is a dependency of `services/document-service`, and `ajv` is only in `packages/protocol`; the test checks the required fields and patterns by hand, not the full schema. Criterion 5 (a later minor version is read by an old receiver) needs a receiver; it is not built. The chain head field name `chainHead` is the schema's placeholder (gaps G83).

### PRO-070 Sign every webhook request

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Integrating developer |

**Spec:** 05 §7; 10 §3.2, §3.7 · **Requirements:** R6, R10 · **Depends on:** PRO-068, PRO-069

As an integrating developer, I want each delivery signed and timestamped, so that my receiver can reject forgeries and replays and I can rotate secrets without downtime.

**Acceptance criteria**

- [x] Given a delivery, when its headers are read, then it carries `webhook-id`, `webhook-timestamp` and `webhook-signature`, and the signature is HMAC-SHA256 as described by the Standard Webhooks specification (verified with that specification's published test vectors).
- [x] Given a delivery whose timestamp differs from the receiver's clock by more than five minutes, when the reference verifier checks it, then it is rejected; given one within five minutes, then it is accepted.
- [x] Given a secret rotation, when it is in progress, then two secrets are active and the signature header holds a signature for each, so a receiver that knows either secret verifies the delivery.
- [x] Given a body that is changed by one byte, when it is verified, then verification fails.
- [x] Given the integration guide, when it describes receivers, then it says to verify signatures and deduplicate on `webhook-id` (UX-090, UX-091).

**Evidence:** Review of 2026-11-13: criterion 3 unticked, because no rotation exists (the secret store is PRO-068) and `signDelivery` is called by nothing but its test; criteria 2 and 4 stand, as they are met by the reference verifier `verifyDelivery`. services/document-service/src/control-plane/webhook-signing.test.ts (criterion 2: a timestamp 300 s either side of the receiver clock is accepted, 301 s or an hour out is refused with `timestamp_out_of_tolerance`; criterion 3: `signDelivery` with two secrets writes two space-separated `v1,` entries, and a receiver knowing either secret verifies, a stranger does not; criterion 4: every single-byte flip of a body fails verification; also the header signature is HMAC-SHA256 over `<id>.<timestamp>.<body>`, checked against an independent HMAC in the same test). Run of 2026-11-13: the three control-plane-2 test files, 39 passed, 0 failed. The signing and verifying functions are in webhook-signing.ts; no request is sent yet (BE-055).

**Evidence (lane V-PRO-069-085, 2026-11-14): criterion 5.** `services/document-service/test/control-plane/pro-070-v-pro-069-085-guide.test.ts` (Node.js, 2 passed): the receiver section of `apps/reference-host/docs/integration-guide.md` says to check the signature of each delivery with the three Standard Webhooks headers, and to drop a delivery whose `webhook-id` was already handled. The test reads the guide text, so an edit that removes either statement fails it.

**Evidence (lane PRO-057-070, 2026-11-13):** criterion 3 is met at the level of the operations and the signature. `services/document-service/src/control-plane/webhook-subscriptions.test.ts`, "keeps two secrets active until the old one is retired, and both verify a delivery" (a rotation gives two active secrets; the signature header splits into two entries; a receiver knowing either secret verifies; after retirement the old secret fails with `bad_signature`), and `webhook-signing.test.ts`, "holds one v1 entry per active secret, separated by a space" and "verifies with the old secret alone and with the new secret alone". `services/document-service/src/control-plane/webhook-dispatcher.test.ts`, "during a rotation a receiver holding either secret verifies the delivery (criterion 1)", checks the same on a sent request. The HTTP route for rotation is not mapped (PRO-068). Run of 2026-11-13: these four files, 61 passed.

**Evidence (lane V-PRO-069-085, 2026-11-13): criterion 1.** `services/document-service/src/control-plane/webhook-signing-vectors.test.ts` (Node.js, 3 passed): the published Standard Webhooks vector (secret `whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw`, id `msg_p5jXN8AQM9LWM0D4loKWxJek`, timestamp 1614265330, payload `{"test": 2432232314}`, expected `v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=`) is signed by `signDelivery` to that signature, and `verifyDelivery` accepts it. The vector is copied from the Standard Webhooks Python library's test file (`libraries/python/tests/test_webhooks.py`, read from the public repository on 2026-11-13), not recomputed here. The dispatcher (`webhook-dispatcher.ts`) signs each delivery with `signDelivery`.

**Notes:** Criterion 1 is met by the vector test above (lane V-PRO-069-085). Earlier, the Standard Webhooks published test vectors were not in this repository and not in the spec text. Lane U-PRO-069-085 (2026-11-13) fetched the specification text from its public repository: it has no test vector (no secret with a webhook-id, timestamp, payload and expected signature), only an illustrative example whose secret is not given, so the signature was not checked against vectors in that round (resolved by lane V-PRO-069-085, see Evidence above). Criterion 5 (the integration guide says to verify signatures and deduplicate on `webhook-id`) belongs to UX-090 and UX-091; lane V-PRO-069-085 (2026-11-14) ticked it on the guide's current text, with a test that reads the guide (see Evidence). Secrets are of the `whsec_` form with a base64 key; the store that keeps them and retires the old one is PRO-068: its operations exist over `MemorySubscriptionStore` (lane PRO-057-070, 2026-11-13), but no PostgreSQL store is built.

### PRO-071 Deliver at least once and only to public addresses

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Operator |

**Spec:** 05 §7; 06 §1; 10 §3.2 · **Requirements:** R9, R10 · **Depends on:** PRO-070

As an operator, I want deliveries retried with backoff and sent only through an egress proxy, so that a slow receiver loses nothing and a webhook target can never reach my internal network.

**Acceptance criteria**

- [x] Given a receiver that answers with an error or does not answer, when a delivery fails, then it is retried with exponential delay for up to 24 hours (a target; the kit uses test-mode timers, PRO-109) and then abandoned.
- [x] Given a retry, when the delivery is repeated, then it carries the same `webhook-id`; the contract says receivers deduplicate on it, and that order of delivery is not guaranteed.
- [x] Given a target that resolves to a loopback, private or link-local address (including the cloud metadata address and IPv6 link-local), when a delivery is attempted, then the egress proxy refuses it and no request leaves.
- [x] Given a hostname that resolves to a public address at registration and to a private address at delivery time, when the delivery is attempted, then it is refused.
- [x] Given a replay request (PRO-068), when recent deliveries are sent again, then they go through the same egress rules.

**Evidence:** services/document-service/src/control-plane/webhook-retry.test.ts 'PRO-071 criterion 2' (every send of one row, retries included, carries the same `webhook-id` while `webhook-timestamp` moves on); run of 2026-11-13 in Node.js, with webhook-dispatcher.test.ts and webhook-egress.test.ts, 41 passed in the three files.
**Evidence (lane V-PRO-069-085, 2026-11-13): criteria 3, 4 and 5.** `services/document-service/src/control-plane/webhook-pro-071-egress.test.ts` (Node.js, 13 passed): the real `EgressProxy` refuses loopback, private, metadata, link-local and IPv6 link-local targets with no connection; a name that resolves to a public address and then to a private one is delivered once and refused the second time; a name with one private address among public ones is refused; a replay of a row whose name has moved to a private address sends nothing. The dispatcher is the real `WebhookDispatcher` with the proxy as its transport; resolver and connector are fakes. Criterion 1 stays open (see Notes).
**Evidence (lane w5, 2026-11-17, criterion 1):** `services/document-service/test/control-plane/pro-071-w5-composed-retry.test.ts` (Node.js, 6 passed, with webhook-retry.test.ts and prm-053-composed-webhooks.test.ts 27 passed). `configFromEnv` reads `DOCEDIT_WEBHOOK_RETRY_BASE_MS` and `DOCEDIT_WEBHOOK_RETRY_FACTOR` (both or neither); `composeWebhooks` passes them with the 24-hour window as the dispatcher's `RetryPolicy`. Through the real `EgressProxy` (fake resolver, connector, clock and timers): a receiver that times out is sent again after base, base x factor, base x factor squared and stops when it answers; one that never answers is retried until the next send would fall after 24 hours, then the row is `failed` with no timer left; a 500 answer is retried; a target that resolves to a private address is not retried and sends nothing; every send carries one `webhook-id`. The real `nodeConnector` fails with `timeout` on a local server that never answers.

**Notes:** The dispatcher and the proxy are BE-055, BE-056; this story is the observable contract. Lane V-PRO-069-085 (2026-11-13), criterion 1 stays open: the retry schedule is tested with fake timers (webhook-retry.test.ts), but no composition passes a `RetryPolicy` to the dispatcher, so the running service does not retry, and no test covers a receiver that does not answer (timeout) through the real proxy. Security tests are SEC's. Lane PRO-071-084, round 1 (2026-11-13): `services/document-service/src/control-plane/egress-address.ts` classifies IP literals (`classifyAddress`) and host names (`classifyHost`). Fix round 1 (2026-11-13): it is now the one classifier. The egress proxy `webhook-egress.ts` (BE-056: `EgressProxy`, `refusedAddressReason`) maps its classes to refusal reasons and has no address parser of its own, and the dispatcher `webhook-dispatcher.ts` (BE-055) sends only through it. egress-address.test.ts (70 passed in Node.js, with webhook-egress.test.ts and webhook-dispatcher.test.ts, 104 in all) runs the property tests on the proxy's path: every address in an independent list of refused IPv4 blocks is refused and the rest pass; a name that resolves to any of them makes no connection; fe80::/10, fc00::/7, ff00::/8 and 2002::/16 are refused, and nothing outside 2000::/3 passes; `localhost` is refused without being resolved; a name that resolved to a public address and then to a private one is refused on the second delivery (the proxy resolves at each delivery). What these show for the criteria: criterion 3 (refused, connector never called) and criterion 4 (checked at delivery time) hold for `EgressProxy` with a fake resolver and connector; criterion 5 holds in that replays use the dispatcher's one transport (webhook-dispatcher.test.ts). They stay unticked in this round for review: the proxy is not wired into the server (`src/server.ts`), the network policy that makes it the only route out is not built (BE-056 criterion 4), and criteria 1 and 2 (retry schedule) are not built. The ranges refused beyond 10 §3.2 (CGNAT, documentation, benchmarking, multicast and reserved space, 6to4, Teredo, NAT64) are a fail-closed reading, not a stated rule; the owner may narrow them. One consequence for the owner: a NAT64 address (64:ff9b::/96) is refused even when it carries a public IPv4 address, so a deployment on IPv6-only egress with DNS64 cannot reach IPv4-only receivers until that rule is narrowed. Lane PRO-071-084, round 2 (2026-11-13): the retry schedule is built in `webhook-dispatcher.ts` as an opt-in `RetryPolicy` (`baseMs`, `factor`, `maxAgeMs`; a timeout, a transport error, an unresolved name or a non-2xx answer is sent again under the same `webhook-id`; a refusal is not). webhook-retry.test.ts shows the delays base, base x factor, base x factor squared, the stop when the 24-hour window would close (property test), and no retry for a refusal. Lane w5 (2026-11-17), criterion 1 ticked: the retry is now wired. The settings take the base delay and the factor from the environment with no default (still ADR 0216 open point 1): without them the service does not retry, as before. Criterion 1 as written was unticked in the earlier round, because the spec gives the 24-hour window but no base delay or factor, so no default was chosen (proposed in docs/adr/0216-lane-PRO-071-084.md), and no composition passes a policy, so the running service does not retry yet.

### PRO-072 Raise events for documents, versions, access and rejected commits

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Integrating developer |

**Spec:** 05 §7; 10 §3.3 · **Requirements:** R3, R4, R10 · **Depends on:** PRO-069, PRO-047, PRO-052, PRO-053

As an integrating developer, I want to hear about document lifecycle, versions, rights changes and rejected commits, so that my application and my security monitoring stay in step with the editor.

**Acceptance criteria**

- [x] Given a document that is created, deleted or changes state, when it happens, then `dep.document.created`, `dep.document.deleted` or `dep.document.state_changed` is raised.
- [x] Given continuous editing, when 100 commits arrive in 10 seconds, then at most one `dep.document.changed` is raised per document per 10 seconds, and its `data` carries `seq` and the hash-chain head.
- [x] Given a named version or a restore, a change of grants or a change of region state, when it is stored, then `dep.version.created`, `dep.version.restored`, `dep.grants.changed` or `dep.region.state_changed` is raised.
- [ ] Given a channel that opens or closes, when it does, then `dep.session.joined` or `dep.session.left` is raised.
- [ ] Given a commit rejected with `permission_denied` or `invalid_op`, when it is rejected, then `dep.commit.rejected` is raised, throttled so that a flood of rejections raises far fewer events; a rejection with another code raises none.
- [x] Given a subscription with a filter, when events are raised, then only matching types are delivered.

**Evidence (lane V-PRO-069-085, 2026-11-14): criterion 1 in memory and PostgreSQL storage.** `services/document-service/test/control-plane/pro-069-072-v-pro-069-085.test.ts`: a created, content-changed, locked and deleted document raises `dep.document.created`, `dep.document.changed`, `dep.document.state_changed` and `dep.document.deleted` through the real handlers (`realDataPlane: true`), each body passes `toCloudEvent`. The emitters now carry `seq` (handlers.ts). Run: `pnpm vitest run` on that one file, 4 passed. Criterion 2 (debounce) stays open: DocumentChangeDebounce is not wired into kit.ts.

**Evidence (lane V-PRO-069-085, 2026-11-14): criterion 2 in memory and PostgreSQL storage.** `services/document-service/test/control-plane/pro-072-v-pro-069-085-debounce.test.ts` (2 passed, `pnpm exec vitest run` on that file, real ten-second window): six content replacements in a burst raise one `dep.document.changed.v1` at once; the last of the burst is raised after the window with a higher `seq` and a chain head. `createKit` (kit.ts) now routes `dep.document.changed` through `DocumentChangeDebounce` with an unreferenced trailing timer. Regression, same run style: the 13 control-plane files that read `dep.document.changed` (routes.documents, pro-012, pro-043, ux-079 admin and audit, restore, retry, PRO-071 egress, dispatcher, event-throttle, V-PRO-069-085 files), 112 passed.

**Evidence (lane V-PRO-069-085, 2026-11-14): criterion 3 in memory and PostgreSQL storage.** `services/document-service/test/control-plane/pro-072-v-pro-069-085-version-events.test.ts` (2 passed, `pnpm vitest run` on that file): a named version (`dep.version.created`), a restore (`dep.version.restored`, added to restore-route.ts together with the chain head on `dep.document.changed`), a region state change (`dep.region.state_changed`) and a grants patch (`dep.grants.changed`) each raise their event through the running routes, and each body passes `toCloudEvent` and its schema. Criterion 4 (`dep.session.joined` and `dep.session.left`) and criterion 5 (`dep.commit.rejected`) stay open: no session emitter in the control plane, and the throttle rate is not stated in the spec.

**Evidence (criterion 6, lane PRO-071-084, 2026-11-13):** services/document-service/src/control-plane/webhook-dispatcher.test.ts 'a subscription that is not listed for an event gets no delivery for it (criterion 5)' (two subscriptions, one listing `dep.export.completed.v1` and `dep.document.changed.v1`, one listing only `dep.export.failed.v1`; a `dep.document.changed.v1` event is sent to the first only); Node.js run of 2026-11-13, 34 passed in webhook-dispatcher.test.ts and webhook-egress.test.ts.

**Evidence:** services/document-service/test/control-plane/routes.documents.test.ts, memory variant, 'creates documents with content, externalId and properties' (asserts `dep.document.created.v1` for the new document), 'updates metadata and state under If-Match; a state change raises the grants revision and tells the room' (asserts `dep.document.state_changed.v1` with its data) and 'soft-deletes with manage or a service credential' (asserts `dep.document.deleted.v1`); run of 2026-11-13, 25 passed in the two route files together. The PostgreSQL variant of these tests was skipped (no database in this run). Criterion 1 is met for create, delete and state change only.

**Notes:** Criterion 2 ticked by lane V-PRO-069-085 (2026-11-14): `DocumentChangeDebounce` is wired into `createKit` (kit.ts), with a trailing flush ten seconds after the window opens; the earlier note that it was not wired is out of date. The throttle rate for `dep.commit.rejected` is not stated (Open questions). Workflow events (`dep.workflow.*`) are FRW-025, FRW-060, FRW-065. Evidence audit (2026-11-13): criterion 1 unticked, because `handlers.ts` raises `dep.document.deleted` with `data: {}` and `dep.document.state_changed` with `{ state, previous, rev }` and no `seq`, which 05 §7 and `spec/dep/webhooks` require, so `toCloudEvent` refuses both (`envelope_refused`) and no webhook is ever delivered for them; `routes.documents.test.ts` only reads the in-memory sink and asserts the data without `seq`. Only `dep.document.created` (with `seq: 0`) reaches a receiver.

Round 1 of control-plane-2 (2026-11-13), open criteria: criterion 2 has its debounce in `services/document-service/src/control-plane/event-throttle.ts` (`DocumentChangeDebounce`, tested in event-throttle.test.ts: 100 commits in 10 seconds raise one event at once and one at the window end). It is not wired: `handlers.ts` emits every change, and `kit.ts` does not pass the chain head, so the running service does not meet it. Criterion 3: `dep.grants.changed` and `dep.region.state_changed` are raised, but `dep.grants.changed` carries `rev`, not `seq` (the schema requires `seq`), and `dep.version.created` and `dep.version.restored` have no emitter in the control plane. Criterion 4 (`dep.session.joined` and `dep.session.left`): no emitter in the control plane. Criterion 5 (`dep.commit.rejected`, throttled): not built; the rate is not stated in the spec, so no default was chosen (ADR 0151, open question). Criterion 6 needs the subscription filter of PRO-068.

### PRO-073 Raise events for review activity and for jobs

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | S | must | Integrating developer |

**Spec:** 05 §7; 12 §6 · **Requirements:** R5, R8 · **Depends on:** PRO-069, PRO-060, PRO-064, PRO-066

As an integrating developer, I want mentions, assigned tasks and finished jobs as webhooks, so that my application can send the notifications, because the document service sends no e-mail.

**Acceptance criteria**

- [x] Given thread and comment activity, when it happens, then `dep.thread.created`, `dep.thread.resolved`, `dep.thread.reopened`, `dep.thread.deleted` and `dep.comment.created` are raised.
- [ ] Given a comment that mentions people, when it is stored, then `dep.comment.mentioned` is raised for the mentions; given a thread assigned to someone, then `dep.task.assigned` is raised.
- [ ] Given an export or import job, when it ends, then `dep.export.completed`, `dep.export.failed`, `dep.import.completed` or `dep.import.failed` is raised.
- [x] Given any of these events, when it is delivered, then no e-mail or text message is sent by the document service.

**Evidence:** services/document-service/src/control-plane/pro-073-no-messages.test.ts (criterion 4, a guard: the package declares no mail or SMS client, no source file under src imports one, and no source names an SMTP or sendmail endpoint; the check is shown not to be vacuous; Node.js, 2026-11-13, 5 passed). This is a static check of what the service links and contains, not a run of a delivery.

**Evidence (lane V-PRO-069-085, 2026-11-14): criterion 1 in memory and PostgreSQL storage.** `services/document-service/test/control-plane/pro-073-v-pro-069-085-thread-events.test.ts` (2 passed, `pnpm vitest run` on that file): a thread created, resolved, reopened and deleted, and a comment created, through the running thread routes, each raise their `dep.*.v1` event with `seq` (thread-routes.ts now adds the head `seq` to these four emitters), and each body passes `toCloudEvent` and the schema of its type. Criterion 2 (mentions and assignment) stays open: no mention or assignment code exists.

**Notes:** Lane PRO-071-084, 2026-11-13. Criterion 3: the export half is built and tested (`dep.export.completed.v1` and `dep.export.failed.v1` in src/control-plane/exports.ts, export-jobs.test.ts); the import half is not, because imports are refused until EXP defines them (handlers.ts, `templates and imports are not offered yet`), so no `dep.import.*` event is raised. Criteria 1 and 2 are not built: there is no thread, comment or mention code in services/document-service/src (PRO-059 and PRO-060 are unbuilt), so `dep.thread.*`, `dep.comment.*`, `dep.comment.mentioned` and `dep.task.assigned` have no raise site. Criterion 3 stays unticked as a whole for the import half.

**Notes (lane w5, 2026-11-17):** Blocked; nothing new ticked. Criterion 2 is not built: services/document-service/src/control-plane/thread-routes.ts says mentions are not read yet, and no code raises dep.comment.mentioned or dep.task.assigned (only the protocol definitions name them). Criterion 3 stays unticked as a whole: the import half is still not raised, because imports are refused until EXP defines them.

## Embedding API: attributes and properties (05 §8.1)

### PRO-074 Load a document from attributes

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Integrating developer |

**Spec:** 05 §8.1, §2 · **Requirements:** R2, R6 · **Depends on:** PRO-008

As an integrating developer, I want to write `<doc-editor doc-id="…" endpoint="…">` and get a working editor, so that embedding needs one tag and one token callback.

**Acceptance criteria**

- [x] Given `doc-id`, `endpoint` and a `getToken` property, when the element is connected, then it reads discovery from `endpoint`, connects, loads the content and raises `de-ready` with `{ docId, seq }`.
- [x] Given a loaded element, when the host changes `doc-id`, then the previous document is closed and the new one loads, ending in a new `de-ready`.
- [x] Given a `backend` property, when the element loads, then `endpoint` is ignored and no discovery request is made (PRO-090).
- [x] Given a `doc-id` that the user may not open, when the element loads, then `de-error` is raised with the registry code (`forbidden` or `not_found`).
- [x] Given a discovery document that cannot be fetched, when the element loads, then `de-error` is raised with code `unavailable`.

**Evidence:** packages/element/test/dep.test.ts (the real DEP client, packages/backend-dep, against backend-dep's in-memory DEP server: discovery from the endpoint, connect, content over REST, the channel, de-ready { docId, seq }; a discovery that cannot be fetched ends in de-error unavailable); e2e/element.spec.ts 'PRO-074' tests in Chromium, Edge, Firefox and WebKit (a doc-id change loads the other document with a new de-ready; with a backend the endpoint is ignored and no DEP client is made; forbidden and not_found end in a fatal de-error; the DEP client pointed at a port where nothing listens ends in unavailable); test/session.test.ts. Run of 2026-11-06, 17:39 UTC, the whole element suite in four browsers: 780 passed, 0 failed, 1 flaky (passed on retry), 455 skipped by design.

**Evidence (lane V-PRO-069-085, 2026-11-13): criterion 2 in four browsers.** `packages/element/e2e/pro-074-076-lifecycle.spec.ts` 'PRO-074 criterion 2 (V-PRO-069-085)': the session of the previous document reports `closed` before the new `de-ready { docId, seq }` is raised, the element holds a new session, and no `de-error` is raised. Run with `pnpm exec playwright test -c packages/element/playwright.config.ts --project=chromium --project=msedge --project=firefox --project=webkit e2e/pro-074-076-lifecycle.spec.ts`, `DOCEDIT_DEMO_PORT=57130`: 8 tests passed (both the PRO-074 and the PRO-076 test in each browser), 0 failed.

**Notes:** Element internals (shadow root, Svelte mount, property capture before upgrade) are FE-003, FE-004. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Evidence audit (2026-11-13): criterion 2 is unticked because the only test of a `doc-id` change (element.spec.ts, FE-003 'doc-id loads the other document') asserts the new `de-ready` and never that the previous session and backend were closed (`doc-editor.ts` calls `current.close()`, but no test observes it).

### PRO-075 Supply tokens with `getToken`

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Integrating developer |

**Spec:** 05 §8.1, §3.1, §5.1; 02 §2.1; 10 §3.1 · **Requirements:** R6, R10 · **Depends on:** PRO-074, PRO-021

As an integrating developer, I want one callback that returns a token for a document, so that my page controls authentication and the order in which I set things does not matter.

**Acceptance criteria**

- [x] Given `getToken(ctx: { docId })`, when loading starts, then it is called with the document identifier; and when `auth.expiring` arrives, then it is called again (PRO-014).
- [x] Given a document identifier and a token source (`getToken` or `backend`), when they are set in every possible order (attribute first, property first, after connection), then loading starts exactly once and only when both are present.
- [x] Given `getToken` that rejects or returns a token the server refuses, when loading or refreshing, then `de-auth-required` is raised and no token value appears in the event.
- [x] Given tokens, when the component runs, then they are held in memory only: not in storage, not in the journal, not in URLs, not in logs.

**Evidence:** packages/element/test/dep.test.ts (getToken is called with { docId } at start and again when the server sends auth.expiring, through the DEP client); e2e/element.spec.ts in Chromium, Edge, Firefox and WebKit ('FE-003' orders with getToken: one load in every order; 'PRO-075': getToken receives { docId }, a failing token source raises de-auth-required { docId, code } without the token, and the token is in no storage, cookie, address or console message); test/session.test.ts (one de-auth-required per failure; a revoked session). Run of 2026-11-06, 17:39 UTC, the whole element suite in four browsers: 780 passed, 0 failed, 1 flaky (passed on retry), 455 skipped by design.

**Notes:** Pitfall PR-16 (order of setting). The loading microtask is FE's. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a.

### PRO-076 Control the element with `load`, `focus` and `destroy`, and read the embedding version

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | S | must | Integrating developer |

**Spec:** 05 §8.1 · **Requirements:** R2 · **Depends on:** PRO-074

As an integrating developer, I want methods to load another document, move focus and tear the element down, and a version number for the embedding API, so that my application can manage the editor's life and check compatibility.

**Acceptance criteria**

- [x] Given `load(docId)`, when it is called, then the element loads that document as if `doc-id` had changed; given `load()` without an argument, then it reloads the current document.
- [x] Given `focus()`, when it is called, then keyboard focus moves into the editing surface.
- [x] Given `destroy()`, when it is called, then the channel and socket are closed, no timers, observers or listeners on the host page remain, and no further events are dispatched.
- [x] Given `DocEditorElement.version`, when it is read before any element exists, then it returns the version of the embedding API, which is separate from the protocol version.

**Evidence:** packages/element/e2e/element.spec.ts 'PRO-076' in Chromium, Edge, Firefox and WebKit (load(docId) and load() each end in de-ready; focus() puts focus on the editing surface; destroy() stops the grace timer, leaves no session and raises nothing more, also when a load was already scheduled; DocEditorElement.version read from the library before any element exists); test/session.test.ts (close({ closeBackend }) closes the channel and the backend once). Run of 2026-11-06, 17:39 UTC, the whole element suite in four browsers: 780 passed, 0 failed, 1 flaky (passed on retry), 455 skipped by design.

**Evidence (lane V-PRO-069-085, 2026-11-13): criterion 3 in four browsers.** `packages/element/e2e/pro-074-076-lifecycle.spec.ts` 'PRO-076 criterion 3 (V-PRO-069-085)': the page is instrumented before it loads (every add and remove of a document or window listener, every MutationObserver, ResizeObserver and IntersectionObserver, and every pending timer). After a baseline taken before the element is created, the element is mounted, typed in, and `destroy()` is called while it is connected; after 400 ms no listener, observer or timer created after the baseline remains. The first run failed on `document:pointerdown` (a listener the element adds on connect and removed only on disconnect); `destroy()` in `packages/element/src/doc-editor.ts` now removes it. Run as in PRO-074 above: 8 tests passed in Chromium, Edge, Firefox and WebKit. Existing `e2e/fe-lifecycle.spec.ts` and `e2e/pro-090-backend-destroy.spec.ts` (Chromium): 6 passed.

**Notes:** What `destroy()` releases is FE-003, FE-004. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. Evidence audit (2026-11-13): criterion 3 is unticked because the PRO-076 test checks only the grace timer, the empty session and that no event follows; it does not observe that the `visibilitychange` listener the session adds on `document` (session.ts) or any other host-page listener, observer or timer is removed, and fe-006-release.test.ts says timers and observers are not covered.

### PRO-077 Choose the mode with an attribute

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Integrating developer |

**Spec:** 05 §8.1; 12 §10 · **Requirements:** R3, R13 · **Depends on:** PRO-074, PRO-032

As an integrating developer, I want to set `mode` to `edit`, `view` or `fill`, so that the same document opens as an editor, a reader or a form.

**Acceptance criteria**

- [x] Given `mode="edit"` and a user whose access allows editing, when the element loads, then editing is available.
- [x] Given `mode="edit"` and a user whose access is `view` only, when the element loads, then the editor is read-only, because the server's permissions still apply.
- [x] Given `mode="view"`, when the element loads, then the document is read-only even for a user who could edit.
- [ ] Given `mode="fill"`, when the element loads, then the fill-mode behaviour of 12 §11 applies (FRW-007).
- [x] Given the host changes `mode` while the element is loaded, when the attribute changes, then the editor switches without a reload.

**Evidence:** packages/element/e2e/attributes.spec.ts 'PRO-077 the mode attribute for an editor' 'mode="edit" for a user whose access allows editing: editing is available' (criterion 1; Chromium, 2026-11-13, with `mode="edit"` set before connecting: contenteditable true and the core's mode `edit` / `edit`); packages/element/e2e/mode.spec.ts 'mode="edit" for a viewer: the effective mode is view and the surface does not take input' (criterion 2; Chromium, 2026-11-13, the `vic` viewer grant); 'mode="view" set before loading: the surface does not take input' (criterion 3; Chromium, 2026-11-13, a user with an editor grant); 'a mode change while open updates the surface without a reload and keeps unconfirmed work' (criterion 5; Chromium, 2026-11-13). All four in Chromium only; Edge, Firefox and WebKit were not run in this round.

**Evidence (lane U-PRO-069-085, 2026-11-13): criteria 1, 2, 3 and 5 in four browsers.** `packages/element/e2e/attributes.spec.ts` with `-g "PRO-07[789]"`, projects chromium, msedge, firefox and webkit: 29 passed, 0 failed, 3 flaky (each passed on retry: `mode="edit"` in WebKit and the `mode="review"` viewer test in WebKit, and `theme="auto"` in Edge). The run is `pnpm exec playwright test -c packages/element/playwright.config.ts --project=... e2e/attributes.spec.ts`, with `DOCEDIT_DEMO_PORT=56130`.

**Notes:** The default when `mode` is absent is not stated (Open questions). `review` is PRO-078. Element packet round 5 (2026-11-13): criterion 4 stays open. `mode="fill"` is tested only as a lock of the body (mode.spec 'fill and an unknown value'); the fill behaviour of 12 §11 is FRW-007, which is not built.

### PRO-078 Start in suggestion mode

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | S | should | Suggester |

**Spec:** 05 §8.1; 07 §7 · **Requirements:** R8 · **Depends on:** PRO-077

As a suggester, I want the editor to open in suggestion mode when the host asks for `mode="review"`, so that my edits are proposals and not direct changes.

**Acceptance criteria**

- [x] Given `mode="review"` and a user with `edit`, when the element loads, then suggestion mode is on and typing produces suggestions (FE-041, FE-042).
- [x] Given `mode="review"` and a user with only `view`, when the element loads, then the editor is read-only; the server's permissions still apply.
- [x] Given a user who has `suggest` but not `edit` in a scope, when the element is in any editing mode, then suggestion mode cannot be left in that scope.

**Evidence:** packages/element/e2e/attributes.spec.ts 'PRO-078 the review mode for a viewer' 'mode="review" for a user with view only: the editor is read-only, the server still decides' in Chromium, 2026-11-13 (the `vic` viewer grant: contenteditable false, and the core's mode `review` requested, `view` effective). Criteria 1 and 3 were unticked in that round; see lane V-PRO-069-085 below.

**Evidence (lane U-PRO-069-085, 2026-11-13): criterion 2 in four browsers.** The same run of `attributes.spec.ts` (`-g "PRO-07[789]"`, chromium, msedge, firefox, webkit) passed 'PRO-078 the review mode for a viewer' in each browser; in WebKit it passed on retry.

**Evidence (lane V-PRO-069-085, 2026-11-14): criteria 1 and 3 in four browsers.** `packages/element/e2e/pro-078-suggestion-mode.spec.ts`: criterion 1 (`mode="review"` for `ada`, an editor: suggestion mode is on and not locked, and text typed from the keyboard is recorded as `ins` runs naming `ada`); criterion 3 (`bob`, a suggester, with `mode="edit"`: suggestion mode is on, locked with reason `rights`, the mode control lists `edit` disabled, and `mode="edit"` then `mode="review"` set in turn leave it on). Chromium, Edge, Firefox and WebKit, 8 of 8 passed, 2026-11-14. `fill` is not part of criterion 3 here (FRW-007, PRO-077 criterion 4).

### PRO-079 Choose view, locale, theme, toolbar and keep-alive

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Integrating developer |

**Spec:** 05 §8.1; 02 §2.1, §3 · **Requirements:** R2, R11 · **Depends on:** PRO-074

As an integrating developer, I want attributes for the view, language, theme and toolbar, so that the editor fits my page and my own controls.

**Acceptance criteria**

- [x] Given `view="web"`, when the element loads, then the continuous web layout is used; the other documented values are `read` and `print`, whose views arrive in phases 2 and 3.
- [x] Given `locale` with a BCP 47 tag, when it is set or changed, then interface strings come from that locale and no reload is needed.
- [x] Given `theme` of `light`, `dark` or `auto`, when it is set, then the editor uses that theme, and `auto` follows the operating system's colour scheme.
- [x] Given `toolbar` of `full`, `compact` or `none`, when it is set, then the toolbar layout changes accordingly; with `none`, no toolbar is shown and the host builds its own with `queryCommand` and `exec` (PRO-085).
- [x] Given the boolean `keep-alive`, when the element is disconnected, then it is kept alive and not destroyed after the grace period; without it, it destroys itself after the grace period (FE-003, FE-004).

**Evidence:** packages/element/e2e/attributes.spec.ts, Chromium, 2026-11-13: 'PRO-079 the locale attribute' 'a locale change while open: the toolbar label comes from the new locale, with no remount' (criterion 2: `locale` set to `ar-XB`, the only non-English table the shell ships, changes the toolbar's accessible name on the same toolbar element); 'PRO-079 the theme attribute' three tests (criterion 3: `theme="dark"` at mount and changed while open; `theme="auto"` follows `emulateMedia` colour scheme dark, then light, while open; `theme="light"` stays light under a dark scheme); 'PRO-079 the toolbar attribute' two tests and the `toolbar="none"` mount test (criterion 4: `full` shows `.de-toolbar-full`, `none` shows no `.de-toolbar`, `compact` shows the panel, changes while open). packages/element/src/editor.ts (`settingsFrom` reads `theme`), src/doc-editor.ts (`theme` is reflected while mounted). Criterion 5: packages/element/e2e/fe-lifecycle.spec.ts 'FE-006 destroy after the grace period' tests 'keep-alive keeps a removed editor suspended and mounted past the grace period' and 'a removed editor is destroyed after the default 30 seconds, not before' in Chromium, 2026-11-13. Criterion 1 is not ticked in that round; see lane V-PRO-069-085 below. Only Chromium ran for this round.

**Evidence (lane U-PRO-069-085, 2026-11-13): criteria 2, 3, 4 and 5 in four browsers.** The same run of `attributes.spec.ts` (`-g "PRO-07[789]"`, chromium, msedge, firefox, webkit) passed the four PRO-079 tests 'the locale attribute', 'the theme attribute' (three tests) and 'the toolbar attribute' (two tests and the `toolbar="none"` mount test) in every browser. In Edge, 'theme="auto" follows the operating system colour scheme' failed once and passed on retry. Criterion 5 is `mode.spec` and `fe-lifecycle.spec.ts` in Chromium only, not repeated here.

**Evidence (lane V-PRO-069-085, 2026-11-14): criterion 1 in four browsers.** `packages/element/e2e/fe-065-web-label.spec.ts` 'the web view is labelled "Web layout" and draws no page edge (FE-065, criterion 1)', with `view="web"` set before loading: the web view's label reads "Web layout" with `data-view="web"`, one editing surface, and no page edge or print page view in the shadow root. The continuous layout is the web view; no other layout is drawn. Chromium, Edge, Firefox and WebKit, 2026-11-14, 4 of 4 passed (the same file's default-view and web/print tests also passed in the four browsers).

**Notes:** Phase of the `read` and `print` values follows their views (FE-065); `print` is gated at the end of phase 2. Element packet round 5 (2026-11-13): criterion 1 stays open. `view` is kept on the attribute only (src/doc-editor.ts); no continuous web layout is selected from it, and no test sets it. Criterion 2 is tested with `ar-XB`, a pseudo-locale, because no real-language table ships with the shell yet; a real language table should repeat it. Removing the `theme` or `locale` attribute keeps the last value (the same as `toolbar` and `locale` before this round); the spec states no reset rule, so this is left as it was (not decided here). Lane PRO-071-084, 2026-11-13: criterion 1 has nothing to call. `CoreApi` in packages/ui/src/core-api.ts declares `views` and an optional `setView`, but no editing core in packages/*/src implements `setView`, so the element cannot select `web` yet. (Lane V-PRO-069-085, 2026-11-14: the web view is the one `view="web"` shows and the default; it is tested by fe-065-web-label.spec.ts, so `setView` is not needed for criterion 1.)

### PRO-080 Look up people through the host's directory

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Integrating developer |

**Spec:** 05 §8.1; 07 §7 · **Requirements:** R3, R15 · **Depends on:** PRO-074

As an integrating developer, I want the editor to ask my application for names and for people to grant roles to, so that the document service never needs my user directory.

**Acceptance criteria**

- [x] Given `resolveUsers`, when presence, comments or history show a person, then the component asks the host for the display data and prefers the answer over the `name` in the token.
- [x] Given `searchPrincipals`, when an owner with `manage` opens the grants dialog or a user types a mention, then the component asks the host for matching users and groups.
- [x] Given a callback that is absent, slow or rejects, when it is needed, then editing continues and the component falls back to the name the server supplied.
- [x] Given a callback, when it is called, then it receives only identifiers or a search string and never document content.

**Evidence:** packages/element/e2e/element.spec.ts 'PRO-080 people through the host directory' in Chromium, Edge, Firefox and WebKit (the presence header shows the host's name for a peer from resolveUsers, which receives identifiers only; without a callback the service's name shows); packages/ui/test/people.test.ts (the shell's directory never waits for a slow host and keeps the service's name when the host rejects or throws); src/editor.ts (resolveUsers forwarded to the shell's PeopleDirectory). Lane V-PRO-069-085 (2026-11-14): `searchPrincipals` has a caller now, the shell's mention picker (packages/ui/src/shell/mention-picker.ts, used by components/CommentBox.svelte). Criterion 1 stays unticked: the comment box opens from the Review group's Comment command, which needs the `comments` feature, and the in-memory service offers no such feature (packages/backend-mock/src/service.ts, line 68), so no element test reaches the mention path; a typed-mention test needs that feature in the demo service (another package). Run of 2026-11-06, 17:39 UTC, the whole element suite in four browsers: 780 passed, 0 failed, 1 flaky (passed on retry), 455 skipped by design.

**Evidence (lane w5, 2026-11-15, criterion 2):** `packages/element/src/permissions-shell.ts` gives the shell the backend's region list (`permissions.regions`) and a grants service (`permissions.grants`, `updateGrants` with `If-Match`), and `src/editor.ts` passes them with the access in force, so the production element offers the permissions pane; `src/permissions-shell.test.ts` (3 tests, Node.js). `packages/element/e2e/pro-080-grants-search.spec.ts`, no longer a fixme, run on 2026-11-15 on this machine in Chromium, Edge, Firefox and WebKit (4 passed, `DOCEDIT_DEMO_PORT=56135 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-080-grants-search.spec.ts`): an owner opens the pane, chooses the region and types "Bo"; the element's `searchPrincipals` is called once with `{ text, docId, purpose: 'grant', kinds, limit }` and nothing else, and the pane lists the host's user and group. Scope of the tick: the mention trigger is proven in the shell only (`packages/ui/e2e/comments.spec.ts` '@ and a fragment call searchPrincipals', `packages/ui/test/ux-031-mention-picker.test.ts`, `purpose: 'mention'`); the element hands the shell the same callback for both, but it has no comment threads service yet, so a mention cannot be typed in the production element.

**Notes:** The signatures of both callbacks are not given in 05 and are fixed by PRO-092. Whether the identifier the editor sees is the token `sub` or the per-tenant surrogate is not stated (Open questions). Phase inferred: the 1b component needs it and 11 does not list it. Cross-check: moved from phase 1b to 1a, because the presence header of the minimum demo (UX-025, UX-026) needs people's names. Packet B2 (2026-11-06): the element captures both callbacks (also before upgrade), hands `resolveUsers` to the shell's people directory (`packages/ui/src/people/directory.ts`) and the backend's presence port to the core, so the presence header shows the host's names. Criterion 2 stays open: the grants dialog and mentions, which would call `searchPrincipals`, are later stories. Lane PRO-071-084, 2026-11-13: the grants pane now calls `shell.searchPrincipals` on input (packages/ui/src/panes/PermissionsPane.svelte) and the shell reads it from App's props, but packages/element does not forward the property to the shell: `MountOptions` and the `mount(App, { props })` call in packages/element/src/editor.ts carry `resolveUsers` only, and `DocEditorElement.searchPrincipals` (src/doc-editor.ts) is stored and never read. `docId` for the query is not forwarded either. No Chromium test of the grants path exists, so criterion 2 stays unticked; the forwarding is the gap to close first. Lane PRO-071-084, 2026-11-13 (round 4): the gap is closed in code. packages/element/src/editor.ts passes `searchPrincipals` (a wrapper that reads the element's current property when the shell asks, and answers no matches when none is set) and `docId` in the mount props; src/doc-editor.ts supplies them from the element. `tsc --noEmit` passes for packages/element. Criterion 2 stays unticked: no Chromium run of the grants path or of a mention was made in this round, and no test yet proves that the callback is called with `{ text, docId, purpose, kinds, limit }` (ADR 0216). Lane U-PRO-069-085, 2026-11-13: the production element cannot open the grants pane yet. Its shell core has no `regions` view (PRM-032 derived region list; `packages/engine/src/core.ts` has none) and no `grants` service (PRM-035), so `PermissionsPane` is not offered (`packages/ui/src/shell/panes.ts`, `available: core.regions !== undefined`). A hook `MountedEditor.openPane` was added in `packages/element/src/editor.ts` for tests. `packages/element/e2e/pro-080-grants-search.spec.ts` is written and marked `test.fixme` for this gap; it fails at `openPane` returning false, and must run and pass before criterion 2 is ticked. The mention path (comment dialog) was not reached either. Needs engine work (a region view) and element work (a grants service over the backend): see needsFromOthers of lane U-PRO-069-085. Lane w5, 2026-11-15: the element now reads the region list and the grants from the backend's permissions port, with no engine change. The list is read when the pane first asks and after each access change (`perm.changed`); a region this user marks appears at the next of these, which is PRM-032's to refine. Typing a mention in the production element still needs a comment threads service in the element (the comments stories of UX); the reviewer may untick criterion 2 if the shell-level proof of the mention trigger is not enough. A visible effect of the change: with a backend that reads regions, the toolbar has one more command (Permissions), so at the width of the demo pages the Navigation (outline) command moves into the "More" menu. Two element tests clicked that command directly (`e2e/element.spec.ts` 'FE-002 lazy chunks', `e2e/s2-features.spec.ts` 'pane'); they now use `clickToolbarCommand` of `e2e/embed-helpers.ts`, which opens the menu when the command is not shown. Chromium run of the whole element suite on 2026-11-15 after the change: 411 passed, 1 flaky (FE-007 save state, passed on retry), 83 skipped; the two changed tests also pass in Firefox, WebKit and Edge.

### PRO-081 Pass configuration to the element

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | should | Integrating developer |

**Spec:** 05 §8.1; 02 §3 · **Requirements:** R2 · **Depends on:** PRO-074

As an integrating developer, I want a `config` property for feature switches, fonts, shortcuts, limits and a style nonce, so that I tune the editor without forking it.

**Acceptance criteria**

- [x] Given the type of `config`, when it is read, then it is published as TypeScript and as JSON Schema with every key documented.
- [x] Given a `config` with a key the component does not know, when it is set, then the key is ignored (PRO-005).
- [x] Given a style nonce in `config`, when the component must create a `<style>` element as the fallback for constructable stylesheets, then the element carries that nonce.
- [ ] Given a feature switch that turns a feature off, when the editor loads, then the feature's controls are absent.

**Evidence:** packages/element/test/config.test.ts (criterion 2: 300 seeded configs with unknown keys, including inherited and reserved names, give the same settings as the same configs without them; a non-object or a known key of the wrong type gives the defaults; criterion 3: any non-empty nonce string is kept, an empty one is dropped, and a test reads src/editor.ts to confirm it passes `config.styleNonce` to the style path); packages/element/test/styles.test.ts 'FE-015' (the fallback element carries the nonce from the options). Run of 2026-11-13 in Node.js: config.test.ts 10 passed. Criterion 1 (unticked at the round 7 review, 2026-11-13): packages/element/src/config.schema.json (JSON Schema 2020-12, one documented property for each key of `DocEditorConfig` in src/config.ts, and `DocEditorConfig` exported from src/index.ts); packages/element/test/config.test.ts 'PRO-081 criterion 1' (the schema's property names equal the keys declared in src/config.ts, each has a description, each default and each enum value match what normaliseConfig does). Re-ticked in the round 7 fix (2026-11-13): `packages/element/package.json` now exports `./config.schema.json` (ADR 0109 item 28, proposed), and config.test.ts 'PRO-081 criterion 1' resolves `@docedit/element/config.schema.json` and `@docedit/element` through Node.js's resolver and the exports map, checks that a path outside the map is refused, that the entry point exports `DocEditorConfig`, and runs the key, description, default and enum checks on the schema reached that way. Run of 2026-11-13 in Node.js: config.test.ts 12 passed, packages/element 117 passed. Criterion 4 stays open: config.ts has no feature switch yet.

**Notes:** 05 names only the categories (feature switches, fonts, shortcuts, limits, a style nonce); the keys are not specified (Open questions). Phase inferred: the 1b component needs it and 11 does not list it. "Published" is read as reachable by a consumer through the package's `exports` (`@docedit/element` for the type, `@docedit/element/config.schema.json` for the schema). This is a proposed reading (ADR 0109 item 28); the spec does not say how, and the owner may choose a generator or a file under `spec/` instead.

### PRO-082 Register host extensions through the `extensions` property

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | S | should | Integrating developer |

**Spec:** 05 §8.1; 13 §7 · **Requirements:** R14, R15 · **Depends on:** PRO-074, UX-050, UX-053

As an integrating developer, I want to hand the element an array of extensions, so that my own commands, panels and custom blocks run inside the editor with the editor's permissions and accessibility rules.

**Acceptance criteria**

- [x] Given an array assigned to `extensions`, when the element loads, then each host-registered (tier 1) extension is registered and contributes what its manifest declares (UX-050, UX-053).
- [x] Given `extensions` that is assigned before the element is upgraded, before `doc-id` or after loading started, when loading starts, then the extensions are still registered, as for `getToken` (PRO-075).
- [x] Given a manifest key that the component does not know, when the array is read, then the key is ignored (PRO-005).
- [ ] Given the published typings, when the property is read, then its type is documented in the typings of PRO-091.

**Evidence (lane V-PRO-069-085, 2026-11-14): criteria 1, 2 and 3 in four browsers.** Criterion 1: packages/element/e2e/ux-050-extensions.spec.ts (the valid entry's command is offered in the shell; a bad entry is reported by name and the others load), Chromium, Edge, Firefox and WebKit, 2026-11-14. Criterion 2: packages/element/e2e/pro-082-extensions-order.spec.ts (the list set on an element not yet upgraded, after connection and before `doc-id`, and after loading has started before de-ready: the command is offered and `de-ready` is raised once), the same four browsers, 2026-11-14, 20 of 20 passed with ux-050. Criterion 3: packages/ui/test/pro-082-extensions.test.ts (checkManifest keeps only id, name and apiVersion; an extension with unknown keys activates with no report; an unknown key does not rescue an invalid known field), Node.js, 3 passed.

**Notes:** The trust tiers, the document API offered to extensions and how it is versioned are UX's; the exact API is an open issue of 13 §13. Sandboxed extensions are phase 4 and not part of this property. Lane PRO-071-084, 2026-11-13 (now out of date): the array was not forwarded. Lane V-PRO-069-085, 2026-11-14: src/editor.ts forwards it to the shell (`app.setExtensions`), and ExtensionHost runs through UX-050. Criterion 4 stays unticked: the typings are PRO-091's, and that story is not in this lane's round.

## Embedding API: methods (05 §8.1)

### PRO-083 Leave a page without losing work

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Author |

**Spec:** 05 §8.1; 04 §8; 13 §9 · **Requirements:** R15 · **Depends on:** PRO-074

As an author, I want my host application to wait until my work is saved before it navigates away, and to learn when something had to be set aside, so that nothing I typed is lost.

**Acceptance criteria**

- [x] Given unconfirmed commits, when the host calls `flush({ timeoutMs })`, then the promise resolves when nothing is in flight or queued.
- [x] Given unconfirmed commits that are not confirmed within `timeoutMs`, when the timeout passes, then the promise rejects, reporting the number of unconfirmed commits, and the work stays in the journal (FE-008, FE-009).
- [x] Given content that was rejected or never sent and was set aside, when it is recorded, then `de-recovered-edits` is raised with `{ count }` and no content.
- [x] Given the host that calls `flush()` before navigation, when the connection is healthy, then after it resolves a fresh load shows every change.

**Evidence (lane V-PRO-069-085, criterion 2 in a browser):** `packages/element/e2e/pro-083-flush-timeout-journal.spec.ts`: the page's channel never confirms a typed commit; `flush({ timeoutMs: 1500 })` rejects with an error whose `count` is at least 1, and the typed text is still in the `docedit-journal` IndexedDB store. Run with `DOCEDIT_DEMO_PORT=57130 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-083-flush-timeout-journal.spec.ts --project=chromium --project=firefox --project=webkit`: 3 passed (Chromium, Firefox, WebKit, 2026-11-13); Edge not run.

**Evidence:** packages/element/test/flush.test.ts 'flush (PRO-083) over a live session' (criterion 1: a local edit on a session over backend-mock, `flush({ timeoutMs })` through the element's methods resolves after the room acknowledges it, the room holds the edit and the core reads saved; criterion 4: two flushed edits, a session closed and a new session on the same document reads both from the server, Node.js, 2026-11-13); packages/element/test/session.test.ts 'raises de-recovered-edits { count } when the core sets work aside' (criterion 3: the count is raised once per change and the detail is `{ count }` only); packages/element/test/host-api.test.ts 'flush (PRO-083)' (criterion 1 for the idle case: `flush()` and `flush({ timeoutMs })` resolve at once when nothing is in flight or queued, through `src/host-api.ts`, which `DocEditorElement.flush` forwards to). Criterion 2 is not tested against a journal (see Notes). Reviewer correction (round 1, group 2): the fresh-load test in flush.test.ts is criterion 4 (the file's numbering), which the element packet ticked as its "criterion 3"; criterion 3 (de-recovered-edits) was already ticked.

**Evidence (lane U-PRO-069-085, 2026-11-13): criterion 4 in a browser.** `packages/element/e2e/pro-083-flush-fresh-load.spec.ts`: two typed edits in the mounted element, `flush({ timeoutMs: 10000 })` resolves, the element is removed and a new `<doc-editor>` on the same page loads the document from the service; its body holds both edits. Run with `DOCEDIT_DEMO_PORT=56130` and `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-083-flush-fresh-load.spec.ts`: passed in Chromium, Edge and Firefox; in WebKit the first attempt failed after 1.0 minute (the test timeout) and the retry passed (flaky; the first failure was not analysed).

**Notes:** Round 8 (element packet, 2026-11-13): criteria 1 and 3 ticked on flush.test.ts. Criterion 2 ticked by lane V-PRO-069-085 (browser run with the journal, see Evidence; the older remark that the journal is not built is out of date). Open point, left as it is: the count is per in-flight commit or queue, not per commit (engine `flush`, ADR 0109 round 8); the spec does not say which, so it is not decided here. Earlier note: criterion 1 was ticked only in its idle case; the case with commits in flight needs a channel and the sync client's own flush test. Round 3 fix (2026-11-13): packages/element/test/host-api.test.ts 'the element methods over the session' now calls `flush({ timeoutMs })` with a commit in flight over the mock backend and checks the confirmed `seq` after it, and the e2e test 'getContent, queryCommand, exec and flush reach the core of the mounted editor' does the same in three browsers; the criterion is left as it was for the reviewer to judge. Criterion 2 needs the journal (FE-008, FE-009), which is not built; the rejection in `src/host-api.ts` comes from the core and carries the count of unconfirmed commits, but it stays in memory. Criterion 4 now has a browser run (Evidence, lane U-PRO-069-085). Round 3 (element packet, 2026-11-13): see docs/adr/0109-element-backlog-batch.md.

### PRO-084 Read and insert content from the host page

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | should | Integrating developer |

**Spec:** 05 §8.1; 03 · **Requirements:** R6, R3 · **Depends on:** PRO-074, PRO-049

As an integrating developer, I want to read the document and the selection and to insert content programmatically, so that my application can build features around the editor.

**Acceptance criteria**

- [x] Given a loaded document, when `getContent()` is called, then it resolves `{ seq, cdm, doc }` for the confirmed document.
- [x] Given a selection, when `getSelectionContent()` is called, then it returns a CDM fragment.
- [x] Given a CDM fragment, when `insertContent(fragment)` is called at a place where the user may edit, then the content is inserted through the same guards as typing.
- [x] Given `insertContent` at a place where the user may not edit, or a fragment that is invalid against the CDM, when it is called, then nothing is inserted and the promise or call reports the reason.
- [x] Given the events of PRO-087, when content is read or inserted, then no event carries document content.

**Evidence (lane V-PRO-069-085, criterion 5, 2026-11-14): Chromium, Firefox and WebKit.** `packages/element/e2e/pro-084-v-events-no-content.spec.ts`: after `getContent()`, `getSelectionContent()` and `insertContent()` on the mounted element, every `de-*` event the embed page recorded is serialised and none carries the text read or inserted (`pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-084-v-events-no-content.spec.ts --project=chromium --project=firefox --project=webkit` with `DOCEDIT_DEMO_PORT=57130`: 3 passed; Edge not run). Review (V3 group 3, round 8): rerun with `--workers=1 --retries=0`, Firefox and WebKit passed; Chromium failed four times out of four at the insertion step (the text appears once, not twice, within 10 s), as does the earlier `pro-084-selection-insert.spec.ts` in Chromium, so the Chromium pass is not reproduced. The criterion stands on Firefox and WebKit; Chromium is open until the insertion flow passes there. Fix (V3 group 3, round 8, 2026-11-14): the cause was in both specs, not the element. ProseMirror takes a DOM selection on `selectionchange`, which Chromium dispatches in a later task, so `insertContent()` ran while the core's selection was still "Last paragraph." and replaced that text with itself (`ok`, one occurrence). Both specs now poll `getSelectionContent()` until the selection holds the text before reading it, and until it is collapsed before inserting. Rerun with `DOCEDIT_DEMO_PORT=57041 ... pro-084-selection-insert.spec.ts pro-084-v-events-no-content.spec.ts --project=chromium --project=firefox --project=webkit --workers=1 --retries=0 --repeat-each=4`: 24 passed, so Chromium passes again; Edge not run.

**Evidence (lane V-PRO-069-085, criteria 2 to 4):** `packages/element/test/pro-084-fragment.test.ts` (Node.js, 5 tests: the element path `elementMethods` and `hostApi` over the headless core returns the selected block as a fragment and `null` with no document; an editable insert adds one copy of the block and leaves the confirmed `seq` at 0; a fragment of another CDM version is refused with `unsupported` and changes nothing; a reader's insert is refused with `refused` and a message; no document gives `NOT_LOADED_INSERT`). `packages/element/e2e/pro-084-selection-insert.spec.ts` (the mounted element on the embed page: the selected block is read with `getSelectionContent()`, `insertContent` at the caret returns `ok` and the text appears twice): `DOCEDIT_DEMO_PORT=57130 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-084-selection-insert.spec.ts --project=chromium --project=firefox --project=webkit`: 3 passed (Chromium, Firefox, WebKit, 2026-11-13); Edge not run. The methods are in `src/host-api.ts` and `src/doc-editor.ts`.

**Evidence:** packages/element/test/host-api.test.ts 'getContent (PRO-084)' (criterion 1 on the core: `{ cdm, requires, doc, seq: 0 }` of the document as loaded, and after a local `pastePlainText` the visible document holds the edit while `getContent().doc` does not). Round 3 fix (2026-11-13), after review: the same file, 'the element methods over the session': `elementMethods(() => session)` (src/host-api.ts), which `DocEditorElement.getContent` now forwards to, over a `Session` against the mock backend with a headless core mounted with `api: hostApi(core)`; `getContent()` resolves the loaded `seq` and `doc`, leaves out an unconfirmed edit, gives `seq` + 1 and the server's document after `flush()`, and the loaded `seq` again in a second session; with no session, a stand-in editor without `api`, or after close, it rejects. `MountedEditor.api` is required in src/editor.ts, so the type-check fails if `mountEditor` drops it. packages/element/e2e/element.spec.ts 'getContent, queryCommand, exec and flush reach the core of the mounted editor' runs the real element in Chromium, Firefox and WebKit (passed 2026-11-13, `--project=chromium --project=firefox --project=webkit`): `getContent()` resolves `seq` 0 and the document, and after typing and `flush()` a higher `seq` with the typed text.

**Notes:** Phase inferred: the 1b component needs it and 11 does not list it. Criterion 1 is ticked on the core layer, the element's path in Node.js and the element in three browsers (Evidence). Criteria 2 to 4 are ticked by lane V-PRO-069-085 (see Evidence): the engine already has `getSelectionContent` and `insertContent` (FE-027, packages/engine/test/content.test.ts), and the element now forwards them. Criterion 5 ticked by lane V-PRO-069-085 (2026-11-14) with a browser test of the events raised around these calls (see Evidence). Criterion 5 rests on the event tests of PRO-087, not re-run here. Round 3 (2026-11-13): see docs/adr/0109-element-backlog-batch.md.

### PRO-085 Drive commands from the host page

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Integrating developer |

**Spec:** 05 §8.1; 13 §4 · **Requirements:** R14, R15 · **Depends on:** PRO-074, PRO-079

As an integrating developer, I want to run commands and ask whether they are enabled and active, so that I can build my own toolbar or buttons.

**Acceptance criteria**

- [x] Given a command from the registry, when `exec(command, args?)` is called, then it runs the command through the same path as the built-in toolbar.
- [x] Given a command, when `queryCommand(command)` is called, then it reports whether the command is enabled and whether it is active, and the answer respects the user's current permissions.
- [ ] Given a command that is disabled by permissions, when `exec` is called, then nothing changes and the call reports why.
- [x] Given a change in the state of commands or of the selection, when it happens, then `de-command-state` lists the commands whose state changed and `de-selection` reports `{ scope, blockId }`, and neither carries content.
- [ ] Given `toolbar="none"`, when the host builds a toolbar from `queryCommand` and `exec`, then every command of the built-in toolbar can be reached.

**Evidence:** packages/element/test/host-api.test.ts 'exec and queryCommand (PRO-085)': criterion 1 (`exec('bold')` on an editor's access applies the mark through the core's `run`, the path the shell's toolbar calls, `src/editor.ts`; `exec` returns true and `activeMarks()` gains bold); criterion 2 (`queryCommand('bold').enabled` is true for an editor and false for a commenter; `active` follows the mark). Both through `src/host-api.ts`. Round 3 fix (2026-11-13), after review: the same file, 'the element methods over the session', runs `exec` and `queryCommand` through `elementMethods(() => session)`, which `DocEditorElement.exec` and `queryCommand` now forward to, with the access the core took from the mock backend's channel (enabled, then active after `exec('bold')`), and checks false and disabled with no session, a stand-in editor without `api`, and after close. packages/element/e2e/element.spec.ts 'getContent, queryCommand, exec and flush reach the core of the mounted editor' (Chromium, Firefox and WebKit, passed 2026-11-13): on the real element, an editor's `queryCommand('bold')` goes from enabled and inactive to active after `exec('bold')` returns true, and a viewer's is disabled and its `exec('bold')` returns false. **Lane U-PRO-069-085, 2026-11-13, criterion 4:** packages/element/test/selection-events.test.ts (12 passed in Node.js: `de-selection` carries exactly `scope` and `blockId`; `de-command-state` carries only the name, `enabled` and `active`, with no content) and packages/element/e2e/fe-028-toolbar-none.spec.ts (Chromium, 1 passed: a host button fed by `de-command-state` follows the caret into and out of bold text). The events are in `src/events.ts` and raised from `src/session.ts`.

**Notes:** The registry is UX-003. Which detail belongs to `de-selection` and which to `de-command-state` is ambiguous in the table (Open questions); the element uses the split of `src/events.ts`, which is the spec default as read. Phase inferred: the 1b component needs it and 11 does not list it. Criterion 3 is open: a refused `exec` leaves the document unchanged (tested in host-api.test.ts), but it returns a boolean only and does not report why; the reason needs an engine change. Criterion 5 is open: the toolbar `none` mode is not checked against every built-in command. Lane PRO-085-098 (2026-11-13) found why it cannot be checked yet: the built-in commands of `packages/ui/src/commands/builtin.ts` have ids such as `edit.undo` and run closures, while `exec` takes the engine's `CommandName` (`packages/engine/src/api.ts`), a narrower set. How the host reaches each command is not stated in 05 §8.1 or 13 §4 (docs/adr/0217-lane-PRO-085-098.md, question 3). Round 3 (2026-11-13): see docs/adr/0109-element-backlog-batch.md. Lane w5 (2026-11-17), no criterion ticked. Criterion 3: the return type of `exec` is `boolean` (`packages/element/src/host-api.ts`, `DocEditorElement.exec`), and 05 §8.1 and 13 §4 give no other. A result that says why (a reason code, or a `{ ok, reason }` object) changes the public API that hosts write against, so it is a decision for the owner and is not made here; `queryCommand(command).enabled` already tells a host that a command is disabled. Criterion 5: unchanged from lane PRO-085-098 (docs/adr/0217-lane-PRO-085-098.md, question 3): the ids of the built-in toolbar (`edit.undo` and so on) and the engine's `CommandName` set differ, and which one a host uses is not stated.

### PRO-086 Export and print from the host page

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | should | Author |

**Spec:** 05 §8.1, §5.6; 02 §8 · **Requirements:** R5 · **Depends on:** PRO-063, PRO-035

As an author, I want my application's buttons to start an export and to print the typeset PDF, so that I print what the final document looks like and not the screen.

**Acceptance criteria**

- [x] Given `requestExport(options)`, when it is called, then it creates an export job (PRO-063) and resolves `{ jobId }`.
- [x] Given a job, when it progresses, completes or fails, then `de-export-progress`, `de-export-completed` or `de-export-failed` is raised with the job state and identifiers only.
- [ ] Given `print()`, when it is called, then the typeset PDF is printed, not the on-screen page.
- [ ] Given a user restricted with `no-export` or `no-print`, when `requestExport` or `print` is called, then it is refused with the reason (PRM-056).

**Evidence:** packages/element/test/export-progress.test.ts 'the export reports (PRO-086, criterion 2)' (criterion 2: `startExport` passes `onProgress` to the exports port, and `exportEvent` maps queued, converting and compiling to `de-export-progress`, completed to `de-export-completed`, failed and cancelled to `de-export-failed`, with `jobId`, `state` and `progress` only; Node.js, lane U-PRO-086-102, 2026-11-13); packages/backend-dep/src/export-progress.universal.test.ts (the polling that feeds the reports: the job at once and at each change until completed, no read after it, none after close() or not_found; Chromium, Firefox and WebKit, 2026-11-13); packages/element/test/export.test.ts 'requestExport (PRO-086)' (criterion 1: the element's `startExport` passes the options to the backend's exports port unchanged and resolves `{ jobId }`, with a stand-in port; the job itself is the server's, PRO-063; refused with `unavailable` without a document, and with `unsupported_feature` when the port or its feature is missing, nothing sent; a server refusal reaches the host with its own code; through a Session on the mock backend, which has no exports port, the element refuses). Node.js, run 2026-11-13. The element method is `DocEditorElement.requestExport` (src/doc-editor.ts). Criterion 2 was unticked by the round 2 review of lane U-PRO-086-102: the two tests above cover the mapping (`exportEvent`) and the port's polling, but no test calls `DocEditorElement.requestExport` and checks that the element raises the event on the host (the `#emit` call and the current-session guard in src/doc-editor.ts are not exercised). Criterion 2 re-ticked by the round 2 fix (lane U-FRW-073-089, 2026-11-13): packages/element/e2e/pro-086-export-events.spec.ts mounts `<doc-editor>` on the embed page's mock backend, given a stand-in `exports` port and the `exports` feature, calls `el.requestExport`, and drives the `onProgress` the element passed. 'a job that progresses and completes raises the three events on the host' (queued, compiling, completed: two `de-export-progress` and one `de-export-completed`, received by a listener on `document`, target `doc-editor`, `bubbles` and `composed` true, detail keys exactly `jobId`, `state`, `progress` though the reported job also carries `docId`, `target` and `result`); 'a job that fails raises de-export-failed on the host'; 'a job started by a replaced session raises nothing' (after `doc-id` changes, reports of the old job raise nothing, and a job of the new session still raises `de-export-completed`). 12 passed in Chromium, Edge, Firefox and WebKit, `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-086-export-events.spec.ts`, DOCEDIT_DEMO_PORT 56431, 2026-11-13.

**Notes:** Printing from a shadow root is FE-003, FE-004 and 02 §8. The restriction values arrive with PRO-015 in phase 2. Phase inferred: the 1b component needs it and 11 does not list it. Round 4 (2026-11-13): criterion 1 ticked; criterion 2 was ticked in round 2, unticked by its review and re-ticked by the round 2 fix with an element-level browser test (see Evidence; lanes U-PRO-086-102 and U-FRW-073-089; the exports port polls with `onProgress`, PRO-096, and the element maps the reports; a cancelled job raises `de-export-failed`, ADR 0314 decisions 5 to 8); criterion 3 stays open (`print()` is not built); criterion 4 stays open (the `no-export` check of PRM-056 and the printing refusal are not built; the server's `forbidden` reaches the host unchanged, as tested).

## Embedding API: events (05 §8.1)

### PRO-087 Raise composed events that carry identifiers and counts only

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Integrating developer |

**Spec:** 05 §8.1; 02 §3 · **Requirements:** R2, R15 · **Depends on:** PRO-074

As an integrating developer, I want events that bubble out of the shadow root and never carry document content, so that my application can react without leaking the document.

**Acceptance criteria**

- [x] Given any event of the embedding API, when it is dispatched, then it is a `CustomEvent` with `bubbles: true` and `composed: true`, so a listener on the host page receives it.
- [x] Given a test that scans the `detail` of every event the component raises in a full session, when it runs, then no `detail` contains document text or a token.
- [x] Given a document that loads, when it is ready, then `de-ready` is raised with `{ docId, seq }`.
- [x] Given a change in connection or save state, when it happens, then `de-status` is raised with `connection` of `online`, `reconnecting` or `offline` and `sync` of `saved`, `saving`, `unsaved` or `readonly`.
- [x] Given typing, when changes are confirmed, then `de-change` is raised with `{ seq }`, debounced rather than once per keystroke.
- [x] Given an error, when it occurs, then `de-error` is raised with `{ code, message, fatal }` where `code` is a registry code (PRO-038).

**Evidence:** packages/element/e2e/element.spec.ts 'FE-022, PRO-087 events' in Chromium, Edge, Firefox and WebKit (every event composed and bubbling; no detail of a full session carries document text or the token; de-ready { docId, seq }; de-status { connection, sync }; de-change { seq } far fewer than keystrokes and in seq order); test/session.test.ts and test/status.test.ts (de-error { code, message, fatal } with registry codes only; de-status values; de-change at most once per interval); src/events.ts, src/session.ts. Run of 2026-11-06, 17:39 UTC, the whole element suite in four browsers: 780 passed, 0 failed, 1 flaky (passed on retry), 455 skipped by design.

**Notes:** The debounce interval of `de-change` is not stated (Open questions). The save-state indicator is UX-014, UX-039 and FE-008, FE-009. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a.

### PRO-088 See permission changes in the host page

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | S | must | Integrating developer |

**Spec:** 05 §8.1, §5.5 · **Requirements:** R3 · **Depends on:** PRO-032, PRO-033, PRO-087

As an integrating developer, I want an event with the user's current access, so that my page can show or hide its own controls to match.

**Acceptance criteria**

- [x] Given a channel that opens, when `access` arrives, then `de-permission-change` is raised with the `access` object.
- [x] Given a `perm.changed` message, when it arrives, then `de-permission-change` is raised with the new complete `access` object, once per message.
- [x] Given an owner who changes a collaborator's grants, when the collaborator's page is open, then the host page sees the event without a reload.

**Evidence:** packages/element/e2e/element.spec.ts 'PRO-088' in Chromium, Edge, Firefox and WebKit (de-permission-change when the channel opens, then once per perm.changed with the new complete access, after the owner's grant changes and without a reload); test/session.test.ts (each access revision raised once, from the channel and from the core's view). Run of 2026-11-06, 17:39 UTC, the whole element suite in four browsers: 780 passed, 0 failed, 1 flaky (passed on retry), 455 skipped by design.

**Notes:** Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a.

### PRO-089 Ask the host to show its own sharing dialog

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Owner |

**Spec:** 05 §8.1; PRODUCT.md operating context · **Requirements:** R15 · **Depends on:** PRO-087

As an owner, I want the share button to open my host application's own dialog, so that sharing uses the people and rules my organisation already has.

**Acceptance criteria**

- [x] Given the share control, when the owner activates it, then `de-share-request` is raised (bubbling, composed) with identifiers only.
- [x] Given the editor, when it handles the request, then it shows no sharing dialog of its own and never lists documents.
- [x] Given a host that has no listener for the event, when the control is activated, then nothing breaks and no error is raised.

**Evidence:** packages/element/e2e/pro-089-share-request.spec.ts 'PRO-089: the share button asks the host' (criteria 1 to 3, on the production-bundle page with the library build: a host listener on the document gets `de-share-request`, bubbling and composed, with the detail `{ docId }` only; the element shows no dialog and no document list; with no listener, the control stays enabled, the surface stays visible, and there is no page error, console error or failed response; Chromium, Edge, Firefox and WebKit, lane U-PRO-086-102, 2026-11-13, run with `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-089-share-request.spec.ts`). The owner's activation of the control is the share-button spec packages/element/e2e/ux-039-share.spec.ts (criteria 1 and 2 of UX-039).

**Notes:** The control itself is UX-014, UX-039. `de-fork-request` is PRO-057. Phase inferred: the 1b component needs it and 11 does not list it. Round 6 (packet B2, 2026-11-13): the element now declares `de-share-request` with the detail `{ docId }` (identifiers only; the detail is the spec default, since 05 §8.1 does not define it; recorded in docs/adr/0109-element-backlog-batch.md), raises it through `emit` in `packages/element/src/doc-editor.ts` when the shell's share command calls `onShareRequest`, and `packages/element/test/events.test.ts` checks the event shape and a dispatch with no listener. Round 2 (lane U-PRO-086-102, 2026-11-13): criteria 1 to 3 are ticked by the browser spec in Evidence. Criterion 2 is checked as the DOM stands (no dialog element, no document-list hook; ADR 0314 decision 9), not as a UX review. Earlier round text: the three criteria needed a browser activation.

### PRO-090 Run the editor on any backend through the `backend` property

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Integrating developer |

**Spec:** 05 §8.1, §8.3; ADR 0008 · **Requirements:** R6 · **Depends on:** PRO-091, PRO-099

As an integrating developer, I want to hand the element my own backend object, so that I can run it against the in-memory backend in tests or against my own implementation in production.

**Acceptance criteria**

- [x] Given a `backend` property, when the element loads, then it uses that object for every port and does not read discovery or open a socket of its own.
- [x] Given a `backend`, when `getToken` is absent, then loading still starts, because a `backend` counts as a token source.
- [ ] Given a backend whose `features` set lacks a feature, when the element renders, then the controls for that feature are not shown (UX-014, UX-039).
- [x] Given `destroy()`, when it is called on the element, then `backend.close()` is called once.

**Evidence:** packages/element/e2e/pro-090-backend-destroy.spec.ts 'PRO-090: destroy() calls the host backend close() once' (criterion 4: the host's backend close is counted; one call after `destroy()` and nothing more after 200 ms), run in Chromium, Edge, Firefox and WebKit on 2026-11-13 (lane U-PRO-086-102; `pnpm exec playwright test -c packages/element/playwright.config.ts`, DOCEDIT_DEMO_PORT 56140). packages/element/e2e/element.spec.ts 'PRO-074: with a backend, endpoint is ignored and no DEP client is made' (criterion 1) and the 'FE-003' order tests with `backend` and no `getToken` set (criterion 2: loading starts once and de-ready is raised), in Chromium, 2026-11-13. Criterion 1 also relies on the same test's check that no DEP client was made.

**Notes:** Criterion 4 is ticked (lane U-PRO-086-102, round 7): the element-level check is the browser test named in Evidence. `destroy()` calls `session.close({ closeBackend: true })` (packages/element/src/doc-editor.ts). Criterion 3 stays open: the `features` set does not yet hide controls (UX-014, UX-039). Phase inferred: the 1b component needs it and 11 does not list it.

## Backend ports and the backends that implement them (05 §8.3)

### PRO-091 Publish complete typings for the core ports

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 0 | M | must | Maintainer |

**Spec:** 05 §8.3; review PR-14 · **Requirements:** R6 · **Depends on:** SPK-019, CDM-007, CDM-008

As a maintainer, I want complete TypeScript typings for `Backend`, `AuthPort`, `SyncPort`, `SyncChannel` and `PermissionsPort`, so that any implementation can be written and tested against one definition.

**Acceptance criteria**

- [x] Given the typings, when `Backend` is read, then it has `features` (a read-only set of strings), `connect()`, `close()`, `auth`, `sync` and `permissions`, and the optional ports are optional members.
- [x] Given `SyncPort`, when it is read, then `loadContent(docId, seq?)` resolves `{ seq, incarnation, cdm, doc }` and `open(docId, { resume? })` resolves a `SyncChannel`.
- [x] Given `SyncChannel`, when it is read, then `submit(commit)` resolves an `Ack` or rejects with a `SyncReject`, `onCommits`, `onReset`, `onAccess`, `onEvent` and `onState` each return an `Unsubscribe`, and `close()` exists.
- [x] Given the shared types (`Commit`, `Ack`, `SyncReject`, `RemoteCommit`, `Access`, `Notification`, `ChannelState`, `Resume`, `CdmNode`), when they are compared with the artifacts of PRO-001 to PRO-003, then CI finds no difference, and the typings compile under TypeScript strict mode.
- [x] Given the typings, when they are searched, then no ProseMirror type appears in any port.
- [x] Given `AuthPort` and `PermissionsPort`, when they are read, then their members are documented from 05 §3 and §5.5 (token supply and refresh events; the current `access`).

**Evidence:** `packages/protocol/src/ports/core.ts`, `types.ts`, `errors.ts` (`SyncRejectError`, `PortError`) and `delivery.ts` (the delivery rules every backend shares). The wire types are aliases of `packages/protocol/src/generated/types.ts`, which is generated with the artifacts and byte-checked (`packages/protocol/test/artifacts.test.ts`); `packages/protocol/test/ports.test.ts` checks the aliases with the compiler, the members, and that no port or contract file imports or names ProseMirror; `pnpm --filter @docedit/protocol run typecheck` compiles them under the strict settings of `tsconfig.base.json`; `packages/backend-mock/test/contract.test.ts` exercises every member of these ports against the mock.

**Notes:** Phase 0 deliverable (05 §8.3, S6). 05 gives the shape of `Backend`, `SyncPort` and `SyncChannel` only; `AuthPort` and `PermissionsPort` are not defined (Open questions). The members S6 added are proposals, listed as decisions D19 to D24 and D27 in the [S6 report](../spikes/2026-11-06-s6-protocol.md): `loadContent` also resolves `requires`; `SyncChannel` gains `docId`, `opened` and `onCheck`; the delivery order between callbacks and `submit()` is defined; `AuthPort` and `PermissionsPort` have members (grants and region states are optional members of `PermissionsPort`).

### PRO-092 Publish complete typings for the optional ports

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 0 | M | must | Maintainer |

**Spec:** 05 §8.3, §8.1; review PR-14 · **Requirements:** R6, R14 · **Depends on:** PRO-091

As a maintainer, I want complete typings for the optional ports, so that the interface shows a feature only when its port exists and every port has a contract to test.

**Acceptance criteria**

- [x] Given the typings, when the optional ports are read, then `presence`, `history`, `comments`, `assets`, `exports`, `imports`, `fonts`, `leases`, `fields`, `workflow`, `proofing` and `assistant` are each typed.
- [x] Given each port, when it is compared with the protocol, then it maps to its messages and resources (`presence` to 05 §5.4; `history`, `comments`, `assets`, `exports`, `imports`, `fonts` and `leases` to the resources in 05 §6.2; `fields` and `workflow` to 12 §10; `proofing` and `assistant` to 13 §6).
- [x] Given the typings for `resolveUsers` and `searchPrincipals` (05 §8.1), when they are read, then their parameters and results are specified.
- [x] Given a backend that lacks a port, when the user interface asks whether a feature is available, then the answer is no and the control is not rendered.
- [ ] Given each port member, when the contract suite of PRO-098 is complete, then the member has at least one contract test.

**Evidence:** `packages/protocol/src/ports/optional.ts` (every member names its message or route; REST members take their request and response types from the generated operation map, so they cannot differ from `spec/dep/dep-1.openapi.json`) and `packages/protocol/src/ports/host.ts` (`ResolveUsers`, `SearchPrincipals`); `packages/protocol/test/ports.test.ts` checks the port list, the port-to-feature map and `hasPort()`. Criterion 4 (lane U-PRO-086-102, round 3): `packages/ui/test/pro-092-feature-controls.test.ts`, 5 tests in Node.js (`pnpm vitest run packages/ui/test/pro-092-feature-controls.test.ts`): with no feature announced, every built-in command carrying an optional port's feature answers `offered: false` with reason `unannounced` and does not run; with only `regions`, `suggest-enforced` and `presence` (the mock's features), `view.comments` and `view.catchUp` are not offered; with every optional feature announced, none is `unannounced` (positive control); a feature announced later brings the control back. The header, mode switcher and status bar render only offered commands (`packages/ui/src/components/Header.svelte`, `ModeSwitcher.svelte`, `StatusBar.svelte`). Checked at the command registry, not in a browser DOM.

**Notes:** The `fields` and `workflow` ports are not described in 12 §10 beyond messages and resources; their member lists are FRW-025, FRW-060, FRW-065. `proofing` and `assistant` are UX-041, UX-045. The member lists are S6 proposals (G91, G92); where a resource is a placeholder (D26), so is the port type. Criterion 4 is ticked (lane U-PRO-086-102, round 3): the registry answers no for a missing feature and the header, mode switcher and status bar render only offered commands; the DOM itself is not checked in a browser, and a browser check of the mock without `comments` would need a mock that announces `comments`, which `backend-mock` does not offer. Criterion 5 waits for PRO-098: the contract suite has behavioural cases for the core ports and `presence`, and only member checks for the other optional ports, which `backend-mock` does not offer, so they are skipped there. Lane w5 (2026-11-15) added the guard that criterion 5 will rest on, and did not tick it: `OPTIONAL_MEMBERS` in `packages/protocol/src/contract/optional.ts` is now checked against the port typings, so the type-check fails when a listed name is not a member of its port or when a port gains a member that is not listed (`UnlistedOptionalMembers` is `never`), and `packages/protocol/test/ports.test.ts` ("list every member of every optional port, each with a contract case") checks that every listed member is named by a case of its own port. For eleven of the twelve ports that case is still only a member check (`typeof` is a function), which runs against no backend today because none offers those ports. A member check is not a contract test of behaviour, and the suite of PRO-098 is not complete (its second criterion is open), so the criterion stays open until those ports have behavioural cases and a backend that offers them (phases 1b and 2).

### PRO-093 `backend-dep`: connect and keep a session

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 05 §2, §3, §4, §5.1, §8.3; 01 §6 · **Requirements:** R6, R7 · **Depends on:** PRO-004, PRO-008, PRO-017, PRO-021, PRO-075, PRO-091

As a maintainer, I want the `backend-dep` package to implement `connect()` and `close()` over DEP, so that the component can talk to any conforming server.

**Acceptance criteria**

- [x] Given an `endpoint`, when `connect()` is called, then `backend-dep` fetches discovery, opens `ws` with the subprotocol `dep.v1`, sends `hello` with the token from `getToken` and resolves when `welcome` arrives.
- [x] Given `welcome`, when `backend.features` is read, then it holds only features that both the client asked for and the server announced.
- [x] Given a test that records every request and frame, when the component runs a session, then the token appears only in `hello` and in `Authorization` headers.
- [x] Given `close()`, when it is called, then the socket is closed with a normal closure and no timer remains.
- [x] Given a lost connection, when state changes, then `backend-dep` reports `online`, `reconnecting` or `offline` for `de-status` (PRO-087).

**Evidence:** `packages/backend-dep/src/backend.ts`, `connection.ts`, `platform.ts`. `src/backend.universal.test.ts`: discovery without a token, the socket with `dep.v1`, `hello` with the token from `getToken`, resolution on `welcome`; negotiated features; every frame and request recorded, the token only in `hello`, `auth.refresh` and `Authorization`; `close()` sends `ch.close`, closes the socket and leaves no timer (`timers.size` 0); `connection.status` online, reconnecting, online after a cut, offline after `close()` and failed connects. `test/network.test.ts`: over real sockets in Node.js the server selects `dep.v1`, receives close code 1000, and no URL carries a token. The port contract and smoke suites pass over the in-memory network (`src/contract.universal.test.ts`, Node.js and three browsers), over real sockets, and against the document service (`test/service.test.ts`; cases pending on the service listed there).

**Notes:** Refresh, chunking, heartbeat and backoff are added by PRO-014, PRO-018 and PRO-019 in 1b. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. `backend-dep` already refreshes on `auth.expiring`, chunks and reassembles, keeps the heartbeat and reconnects with the backoff of 05 §4 (D83), so those stories start from it. The connection status is reported through `backend.connection`, outside the port typings (D85; ADR 0040 open question 2).

### PRO-094 `backend-dep`: open a sync channel and submit commits

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | L | must | Maintainer |

**Spec:** 05 §5.2, §5.3, §8.3 · **Requirements:** R6, R7 · **Depends on:** PRO-093, PRO-023, PRO-027, PRO-028, PRO-029, PRO-032, PRO-049

As a maintainer, I want `backend-dep` to implement `SyncPort` and `SyncChannel` over DEP, so that the editing core sees only ports.

**Acceptance criteria**

- [x] Given `loadContent(docId, seq?)`, when it is called, then it reads `GET /documents/{id}/content` (pinned when `seq` is given) and resolves the content.
- [x] Given `open(docId, { resume? })`, when it is called without `resume`, then it sends `ch.open` on a fresh channel number and resolves a `SyncChannel` after `ch.opened`; a `ch.rejected` rejects the promise with the code.
- [x] Given `submit(commit)`, when the server sends `sync.ack`, then the promise resolves the `Ack` with `steps` when `rebased`; when it sends `sync.reject`, then the promise rejects with a `SyncReject` carrying `code`, `action` and `head`.
- [x] Given incoming messages, when `sync.commit`, `perm.changed`, `sync.reset` and `event` arrive, then `onCommits`, `onAccess`, `onReset` and `onEvent` are called in the order received.
- [x] Given `close()` on a channel, when it is called, then `ch.close` is sent and later messages for that channel are ignored.

**Evidence:** `packages/backend-dep/src/channel.ts` over `ClientChannel` (`@docedit/protocol/client`). `src/backend.universal.test.ts`: content read at `GET /documents/{id}/content` and `?seq=N`; a fresh channel number for every `ch.open`; `sync.commit`, `perm.changed`, `sync.reset` and `event` delivered in the order received; `ch.close` on `close()` and nothing delivered after it; a `SyncRejectError` with `code`, `action` and `head`. The contract cases `sync.open.*`, `channel.submit.*`, `channel.reject.*`, `channel.close*`, `channel.onReset`, `channel.onAccess` and `channel.order` pass in `src/contract.universal.test.ts` and `test/network.test.ts`; `test/reconnect.property.test.ts` keeps two writers gap-free and converging while connections are cut and frames dropped or repeated.

**Notes:** Resume and catch-up are PRO-095. The client algorithm (queue, confirmed document, journal) is SYN-017, FE-008. Phase inferred: the minimum demo of 11 §3 needs it and 11 lists no protocol deliverable for 1a. The channel already resumes by itself after a gap, a missing answer, a lost connection or a retryable `ch.closed`, follows `stream` and `page`, and closes with `unavailable` when a resume is answered with `reload` (D80; ADR 0040); PRO-095 still owns those criteria.

### PRO-095 `backend-dep`: resume a channel and catch up

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 05 §5.2; 04 §9 · **Requirements:** R7 · **Depends on:** PRO-094, PRO-025, PRO-026, PRO-019

As a maintainer, I want `backend-dep` to resume channels after a reconnect and to follow whichever catch-up mode the server chooses, so that a dropped connection costs the user nothing.

**Acceptance criteria**

- [x] Given a lost connection, when it is restored, then the channel is reopened with `resume` (`seq`, `incarnation`, `inflight`) and the new `catchUp` mode is followed: `stream` (commits then `sync.caughtUp`), `page` (REST paging) or `reload` (pinned content read).
- [ ] Given `sync.caughtUp`, when it arrives, then the port reports the channel as caught up before any resubmission of an in-flight commit that the server reported as `unknown`.
- [x] Given a commit with `seq` other than the confirmed `seq` plus one, when it arrives, then the channel is closed and reopened with a resume.
- [x] Given no answer to a submitted commit within `ackTimeoutMs`, when the time passes, then the channel is closed and reopened with a resume.
- [x] Given `ch.closed` with `slow_consumer` or `unavailable`, when it arrives, then the port resumes after `retryInMs` when present.

**Evidence:** `packages/backend-dep/src/channel-resume.universal.test.ts`: a commit beyond the next seq and a submit with no answer within `ackTimeoutMs` each reopen with a resume (criteria 3 and 4); `ch.closed` with `unavailable` and with `slow_consumer` resumes after `retryInMs` (criterion 5). Run in Node.js, Chromium, Firefox and WebKit on 2026-11-13. Criterion 1 (lane U-PRO-086-102, 2026-11-13): `packages/backend-dep/test/resume-catch-up.test.ts` 'PRO-095: a resumed channel follows the catch-up mode the server chooses' (stream: resume with `seq` and `incarnation`, the commits, then `sync.caughtUp`; page: the resume, then one REST page read `after` the confirmed seq, then live; reload: the channel closes with `unavailable` and the caller reads the pinned content), served by `packages/backend-dep/test/support/catch-up-server.ts` over the in-memory network, Node.js, run with `pnpm vitest run packages/backend-dep/test/resume-catch-up.test.ts`.

**Notes:** The algorithm is SYN-026, SYN-028; this story is the transport side. Criterion 1 is ticked (lane U-PRO-086-102): the test server that answers `page` is `test/support/catch-up-server.ts`, a wrapper round MockDepServer. Criterion 2 stays open. The resume's `inflight` answer (`unknown` or `accepted`) is read by `ClientChannel` but not exposed: `onOpened` in `packages/protocol/src/client/channel.ts` ignores `d.inflight`, and `SyncChannel.opened` is the first `ch.opened` only. So the port cannot report the fate of the lost commit before the caller resubmits. The test in `test/resume-catch-up.test.ts` shows the wire order (the server answers `unknown`, then `sync.caughtUp`, then the caller's resubmission) and that the unanswered submit fails with `unavailable` (D23). Exposing the fate needs a decision, recorded in docs/adr/0314-lane-U-PRO-086-102.md.

### PRO-096 `backend-dep`: implement the content, export, asset and font ports

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 05 §6.2, §8.3 · **Requirements:** R5, R6 · **Depends on:** PRO-094, PRO-061, PRO-062, PRO-063, PRO-064, PRO-067

As a maintainer, I want `backend-dep` to implement the `exports`, `assets` and `fonts` ports over REST, so that the user interface can export, insert images and load fonts through ports.

**Acceptance criteria**

- [ ] Given the `assets` port, when the editor uploads an image, then `backend-dep` requests an upload, sends the bytes to the pre-signed address, completes the asset and resolves its URL after `asset.ready`.
- [x] Given the `exports` port, when the editor requests an export, then `backend-dep` creates the job and reports state from events or polling until a terminal state.
- [x] Given the `fonts` port, when the editor starts, then `backend-dep` reads the manifest and exposes it.
- [x] Given REST failures, when a problem document arrives, then `backend-dep` surfaces its `code` as in PRO-039.
- [ ] Given a server that does not announce `assets`, `exports` or `fonts`, when the backend is built, then the matching port is absent.

**Evidence:** `packages/backend-dep/src/export-progress.universal.test.ts` (the exports criterion, lane U-PRO-086-102: `request` with `onProgress` reports the job at once and at each change of state until `completed`, then reads no more; no read after `close()` or after `not_found`; a throwing listener does not fail the request; Chromium, Firefox and WebKit, 2026-11-13; `packages/backend-dep/src/files.ts` `follow`, `EXPORT_POLL_MS`); `packages/backend-dep/src/files.universal.test.ts`: the font manifest is read from `GET /fonts` and exposed (`fonts` criterion); a problem document's registry code reaches the caller as `not_found` (REST criterion); `assets` and `exports` are absent unless the server announces them and the client asked for them (the absence part of the last criterion). Run in Node.js, Chromium, Firefox and WebKit on 2026-11-13.

**Review (group 1, round 1): criterion 1 unticked.** Two reasons. First, "resolves its URL" is the open owner question of docs/adr/0110-backend-dep-backlog-batch.md, item 2, which says the story stays unticked until the owner decides; the lane ticked it on its own reading. Second, the test does not send the bytes to the pre-signed address the server handed out: its fetch wrapper replaces that address with one it signs itself with `S3AssetObjects.presignUpload` and sends the PUT there, so the real store checks `s3.ts` and the bytes, not the address and headers that `backend-dep` was given. The test passes (Node.js, `docedit-test-s3`) and is worth keeping as evidence for the store half. Tick when the owner accepts the reading and the server (or a fixture server) hands out the store's own pre-signed address.

**Evidence (lane V-PRO-086-102, criterion 1; not enough on its own, see Review):** `packages/backend-dep/test/v-pro-096-s3-upload.test.ts` (Node.js, against the S3-compatible store of the test environment in Podman, `docedit-test-s3`; the pre-signed PUT is signed by `services/asset-worker/src/s3.ts`; the bytes are read back from the store under a run-unique key prefix that is deleted afterwards; `asset.ready` arrives before `upload()` resolves; `resolve()` then returns the URL).

**Evidence (criterion 1, fixer V4 group 1 round 1, 2026-11-13; still unticked, the owner question of ADR 0110 item 2 stands):** the address half is now tested. In `packages/backend-dep/test/v-pro-096-s3-upload.test.ts` a fixture server (`StoreUploadServer`, wrapping FileServer) answers `POST /documents/{d}/assets` with the store's own pre-signed PUT address, signed by `services/asset-worker/src/s3.ts` for the declared size. The test's fetch no longer rewrites or signs anything: a request to the store's origin goes out exactly as `backend-dep` made it. The test checks that `backend-dep` sent one PUT, to the very address handed out, with no `authorization` header, and that the store holds the bytes under that asset's key. Run: `pnpm vitest run packages/backend-dep/test/v-pro-096-s3-upload.test.ts`, Node.js against `docedit-test-s3` (Podman), 1 passed. The run-unique key prefix is deleted afterwards. Tick when the owner accepts the reading that `upload()` resolves the identifier and the URL comes from `resolve()`.

**Notes:** Phase inferred: the 1b component needs it and 11 does not list it. Criterion 1 is ticked by lane V-PRO-086-102 on the reading that `upload()` resolves the asset identifier (`{ asset }`, the port contract in `packages/protocol/src/ports/optional.ts`) and the URL comes from `resolve()` after `asset.ready`; the criterion says "its URL" (proposed reading recorded in docs/adr/0110-backend-dep-backlog-batch.md and docs/adr/0314-lane-V-PRO-086-102.md, decision 2). Criterion 2 is ticked (lane U-PRO-086-102, round 2): `exports.request` takes `onProgress` (protocol/src/ports/optional.ts) and polls `GET /exports/{jid}` every `EXPORT_POLL_MS` (1000 ms, a lane choice; ADR 0314 decision 6) until a terminal state; the `export.*` events are not used, which the criterion allows. Criterion 1 stays open (the upload resolves the asset identifier; ADR 0110). Criterion 5 stays open (G06). The last criterion stays open for `fonts`: the fonts port has no feature name (G06), so the spec default keeps it present whenever the backend is; the criterion as written asks for it to be absent, which the owner must settle.

### PRO-097 `backend-dep`: implement the history, comments, lease and import ports

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | must | Maintainer |

**Spec:** 05 §6.2, §8.3 · **Requirements:** R4, R5, R8 · **Depends on:** PRO-096, PRO-054, PRO-055, PRO-056, PRO-058, PRO-059, PRO-060, PRO-053, PRO-066

As a maintainer, I want `backend-dep` to implement the `history`, `comments`, `leases` and `imports` ports over REST, so that the review and history panes run on ports.

**Acceptance criteria**

- [x] Given the `history` port, when the editor lists history, creates a version, compares, reads attribution, restores or updates the read marker, then `backend-dep` calls the matching routes with `If-Match` and `Idempotency-Key` where required.
- [ ] Given the `comments` port, when the editor creates a thread, replies, resolves or deletes, then `backend-dep` calls the matching routes and applies thread events from the channel.
- [x] Given the `leases` port on a server that announces `leases`, when the editor acquires, extends and releases a lease, then heartbeats are sent until release.
- [ ] Given the `imports` port, when the editor imports a file, then it uploads the asset and follows the import job.
- [x] Given a server that lacks a feature, when the backend is built, then the matching port is absent.

**Evidence:** `packages/backend-dep/src/review.ts` (`createReviewPorts`: the history, comments, leases and imports calls over REST); `packages/backend-dep/src/backend.ts` (`setFeatures` offers each port while its feature is negotiated; `imports` only when `proxyImports` is set); `packages/backend-dep/test/review-ports.test.ts`: describe 'history port over REST' (GET routes without conditional headers; `Idempotency-Key` on `createVersion` only when given; `If-Match` and `{ seq }` on the read marker; the routes of diff, attribution and restore; a 412 problem keeps its code), 'comments port over REST' and 'leases and imports over REST' (routes; `If-Match` only where the route is conditional; `Idempotency-Key` on creates; the bearer token never in a URL), and 'the ports exist only when their features are negotiated' (absent when the server does not announce the feature, when the client does not ask, and imports only with `proxyImports`). Run in Node.js on 2026-11-13; the browser projects were not run. Criterion 3 (lane PRO-085-098, 2026-11-13): `packages/backend-dep/test/lease-heartbeat.test.ts` (five tests, virtual time, Node.js): acquire arms a heartbeat at half the remaining time with the latest entity tag, release ends it and leaves no timer; a refused heartbeat, a ports object with no clock, and the eight-hour maximum each end the keeping; a refused release keeps the lease alive. The timer is `armHeartbeat` in `packages/backend-dep/src/review.ts`, given the backend's timers by `packages/backend-dep/src/backend.ts`.

**Notes:** Phase inferred: it wraps the resources of phase 2 and follows them. Criteria 2 and 4 stay open. Criterion 2: the thread and comment routes are called, but the thread events that arrive on the channel are not applied by `backend-dep`. Round 4 (lane U-PRO-086-102): `packages/backend-dep/test/u-pro-097-thread-events.test.ts` shows the channel hands thread and comment events on unchanged and in order (2 of 2 pass, Node.js); whether `backend-dep` should keep a store that applies them is open (ADR 0314 decision 13), so the criterion stays unticked. Criterion 3 is ticked (lane PRO-085-098): the heartbeat cadence (half the remaining time, the same eight-hour maximum as 07 §10) is a choice this lane made, recorded in docs/adr/0217-lane-PRO-085-098.md. Criterion 4: the port has no upload call; the asset upload is the assets port's (PRO-096 criterion 1, still open), so the import flow is not end to end. Criterion 5 reads the imports port as absent unless the host sets `proxyImports`, because it has no feature name (G06; D16); the reading is proposed in docs/adr/0160-backend-dep-2-backlog-batch.md.

### PRO-098 Run one set of port contract tests against every backend

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | L | must | Maintainer |

**Spec:** 05 §8.3, §11; ADR 0008 · **Requirements:** R6 · **Depends on:** PRO-091, PRO-092, PRO-099

As a maintainer, I want one suite that every backend implementation must pass, so that the component can run on any of them without change.

**Acceptance criteria**

- [x] Given the suite, when it is read, then it imports only the port typings and a factory for the backend under test, never an implementation.
- [ ] Given `backend-mock`, when the suite runs, then it passes; given `backend-dep` against the reference service, then it passes with the same suite; given `backend-local` (PRO-100), then it passes with the same suite.
- [x] Given the core ports, when the suite runs, then it covers `loadContent` (head and pinned), `open` with and without `resume`, `submit` resolving and each `SyncReject` action, `onCommits` order, `onReset`, `onAccess` (initial and after a change), `onState` and idempotent `close`.
- [x] Given an optional port, when the backend lacks it, then its tests are skipped and the skip is reported; when it has it, then its tests run.
- [x] Given a failing contract test, when CI runs, then the build fails.

**Evidence:** packages/tck/test/ports.test.ts runs the suite of @docedit/protocol/contract (portContract and coreSmoke; it imports only the port typings and the harness interface, checked by packages/protocol/test/ports.test.ts) through factories: backend-mock in process, and backend-dep built by packages/tck/src/harness.ts (portHarness, the bootstrap contract in port form) over a real network to the mock backend served over DEP and to the reference service; every member of the core ports has a case (uncoveredMembers); a backend without presence skips its case with the reason; the file runs in pnpm test, so a failing case fails CI.

**Notes:** Phase 1b per the roadmap ("port contract tests and mock backend"); S6 produces a first version in phase 0. Packet K, 2026-11-06: criterion 2 stays open: backend-local (PRO-100) does not exist, and backend-dep against the reference service fails the cases listed in packages/tck/test/ports.test.ts (no PUT content, rebased: true on a head commit, and a control commit for initial grants written when the room starts, which three cases do not expect). Lane V-PRO-086-102, round 3 (2026-11-13): `pnpm vitest run packages/tck/test/ports.test.ts` passes in Node.js (112 passed, 46 skipped as not applicable to the mock), the reference-service cases included; one full run failed 46 of them with `fetch failed: bad port` on the discovery request, which did not recur, and the cause is not found (ADR 0314 decision 8). Criterion 2 stays open: it also needs `backend-local` (PRO-100).

### PRO-099 Run the component on an in-memory mock backend

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Integrating developer |

**Spec:** 05 §8.3; 00 R6 · **Requirements:** R6 · **Depends on:** PRO-091, PRO-092

As an integrating developer, I want a backend that lives in memory, so that I can test my integration and run demos without a server.

**Acceptance criteria**

- [x] Given `backend-mock` assigned to the `backend` property, when the element loads, then it opens a document and accepts edits with no network request.
- [x] Given the contract suite of PRO-098, when it runs against `backend-mock`, then it passes.
- [x] Given a mock constructed without an optional port (for example `presence`), when the element renders, then the controls for that feature are absent.
- [x] Given a page reload, when the mock is created again, then its data is gone (it is in memory only).

**Evidence:** packages/tck/test/ports.test.ts: the port contract and the core smoke suite pass against backend-mock in process; a second MockService has none of the first one's documents, as after a page reload. Criterion 1 (lane U-PRO-086-102, 2026-11-13): packages/element/e2e/pro-099-mock-backend.spec.ts 'PRO-099: the mock backend opens a document and takes edits with no network request' (the embed page's mock as `backend`; typed edits land in the editing surface; no fetch, XHR, WebSocket or EventSource request from before the element mounts, so opening the document is covered, to after the edit), run in Chromium with `pnpm exec playwright test -c packages/element/playwright.config.ts`, DOCEDIT_DEMO_PORT 56140. Fixer U4 group 1, 2026-11-13: the listeners now start before `mountEditor`, and the caret is placed by clicking the last paragraph (a click on the surface's centre left WebKit with no caret); the spec passed in Chromium, Edge, Firefox and WebKit (`--retries 0 --repeat-each 2`, DOCEDIT_DEMO_PORT 56430), apart from runs where the page got 404s for demo chunks while another agent rebuilt the shared `dist/demo`; the backend half is packages/backend-mock/test/offline.test.ts. Criterion 3 (fixer V4 group 1, round 2, 2026-11-13; it had been unticked because the absence test had no peer, and `Presence.svelte` renders nothing without one, `{#if shown.length > 0}`): `packages/element/e2e/pro-099-mock-backend.spec.ts` 'a mock built without the presence port shows no presence controls' and its positive control 'a mock with the presence port shows the presence controls once a peer joins' now take the same steps (`twoUsersLive`): ada and bob open one document in two editors, bob types, and ada's editor shows bob's text, so both are live on it. They differ only in the service: the default mock, or `backendWithoutPresence` (`new MockService({ presence: false })`, `demo/embed-page.ts`). The control must show `.de-presence` in ada's editor within `PRESENCE_WINDOW_MS` (10 s); the absence test waits that window and finds no `.de-presence` in either editor. With the absence test pointed at the default mock, it failed in Chromium (`toHaveCount(0)` received 1), so the check discriminates. 12 of 12 pass in Chromium, Edge, Firefox and WebKit (`pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-099-mock-backend.spec.ts --retries 0`, DOCEDIT_DEMO_PORT 57431).

**Notes:** 05 §8.3 says `backend-mock` ships "from the first phase", while 11 lists the mock backend in phase 1b; see Open questions. Packet K, 2026-11-06: criteria 1 and 3 are the element's and the shell's (packets B2 and U) and stay open here. Backlog batch round 1, 2026-11-13: the backend half of criteria 1 and 3 is tested in `packages/backend-mock/test/offline.test.ts` (no `fetch`, `WebSocket`, `XMLHttpRequest` or `EventSource` call on connect, load, open and submit; no `presence` port and no `presence` feature when the service does not offer them). Lane U-PRO-086-102, round 7: criterion 1 is ticked (the element test named in Evidence). Criterion 3 was left open in round 7. Lane V-PRO-086-102 (round 3) ticked it with a positive control that needs a peer, but the absence test still had one user, so the reviewer unticked it. Fixer V4 group 1 (round 2) put a second user, live on the same document, into the absence test as well, and re-ticked it (see Evidence). The presence controls appear only while a peer is present, so a test with one user cannot tell whether the port is there.

### PRO-100 Run the component on a local IndexedDB backend

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | L | should | Integrating developer |

**Spec:** 05 §8.3; 11 §7; 00 R6 · **Requirements:** R6 · **Depends on:** PRO-098, SYN-006, SYN-010, PRM-009

As an integrating developer, I want a backend that needs no server at all, so that I can embed the editor in a page that only has a browser.

**Acceptance criteria**

- [ ] Given `backend-local`, when a document is edited and the page is reloaded, then the document and its history in the local store are still there.
- [ ] Given the same document open in two tabs, when one tab edits, then the other converges through `BroadcastChannel`.
- [ ] Given a collaborator who holds a view-only role in the local store, when they try to edit a region they may not, then the change is rejected by the project's own authority package running in the browser.
- [ ] Given the contract suite, when it runs against `backend-local`, then it passes unchanged.
- [ ] Given the documentation, when it describes the local backend, then it says it proves independence from the transport and the server but not from the document semantics, because it runs the project's authority package.

**Notes:** Not offline-first editing (assumption A1): there is no synchronisation with a server. Phase 4 per 11 §7 ("the local backend"). Lane V-PRO-086-102, round 3 (2026-11-13): not started. There is no `packages/backend-local`; it would persist the segment logs and grants of `MockDocument` in IndexedDB (`MockDocument` has only a creation constructor, so a restore path is needed) and fan commits out over `BroadcastChannel`, with browser tests for reload and two tabs (ADR 0314 decision 9). All five criteria stay open.

## Backend tiers (05 §9)

### PRO-101 Declare what a backend of each tier may announce

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | M | should | Integrating developer |

**Spec:** 05 §9, §2; 04 §14; ADR 0001; review PR-1 · **Requirements:** R6, R9 · **Depends on:** PRO-008

As an integrating developer, I want three honest backend tiers with stated limits, so that I choose how much of the document semantics to build and know what I can announce.

**Acceptance criteria**

- [ ] Given a native backend that passes the step-semantics and rules fixtures, when it announces features, then it may announce every feature.
- [ ] Given a sidecar-backed backend with its own gateway, storage and control plane that delegates document semantics to the authority service, when it announces features, then it announces only what the authority service supports.
- [ ] Given a relay, when it announces itself, then `mode` is `relay`, it announces none of `regions`, `suggest-enforced` or `fields`, and the kit runs `core-relay` instead of `core`.
- [x] Given a relay without an authority service, when the kit selects profiles, then the profiles that need content reads, restore, comparison or export are not run because their features are not announced.
- [x] Given the integration guide, when it describes the tiers, then it states what each may announce and that a relay is for trusted clients only (SYN-044).

**Evidence:** packages/tck/test/relay-selection.test.ts (criterion 4: a relay that announces none of the content, history or export features is given the skip reason by `notApplicable` for `core`, `semantics`, `perm-doc`, `authz`, `registry`, `fuzz` (authority mode), and for `exports`, `history`, `assets`, `perm-read` (their features); a fast-check property over every subset of the relay-safe features; 4 of 4 pass).

**Evidence (lane V-PRO-086-102, criterion 5):** `apps/reference-host/docs/integration-guide.md`, section "Backend tiers (05 section 9; PRO-101)" (the three tiers, what each may announce, and that a relay is for trusted clients only, SYN-044); `apps/reference-host/test/v-pro-101-tiers-guide.test.ts` (Node.js, 3 of 3 pass); the guide's existing checks `integration-guide.test.ts`, `integration-guide.policy.test.ts` and `integration-guide.limits.test.ts` still pass (25 of 25).

**Notes:** Phase inferred: the roadmap places the published kit and the authority service in phase 4; the reference service is an authority. Second review (2026-11-06, SPK-027), SR-M6: a relay cannot project (ADR 0019), so it must never announce read restrictions and must refuse a document with hidden scopes; the tier table of 05 §9 does not say so yet ([review](../review/2026-11-06-second-review.md)). Protocol-2 fix round 1, 2026-11-13: the protocol half of criterion 3 is built. `relayForbiddenAnnounced` and `checkDiscovery` in `packages/protocol/src/client/negotiate.ts` refuse a relay's discovery that announces `regions`, `suggest-enforced` or `fields` with `unsupported_feature` (tested in `negotiate.universal.test.ts`, with a fast-check property over every subset of the registered names); `backend-dep` refuses to connect on that result. Refusing rather than ignoring the names is proposed in ADR 0154. Criterion 3 stays open until the kit runs `core-relay` instead of `core` (PRO-124); criterion 4 is the kit's profile selection (`packages/tck`). The SR-M6 rule on read restrictions has no feature name to check yet. Lane PRO-099-112, round 1: criterion 4 ticked (evidence above). Criteria 1 and 2 stay open: no sidecar or native backend exists in phase 4 (the authority service interface, PRO-102 to PRO-107, is not built). Criterion 3's kit half stays open: the kit runs no `core-relay` scenarios until PRO-124.

## Authority service interface (05 §10)

### PRO-102 Choose a wire binding for the authority service

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 4 | S | should | Maintainer |

**Spec:** 05 §10; 11 §10 decision 9 · **Requirements:** R6 · **Depends on:** none

As a maintainer, I want a written recommendation of how the authority service is called over a network, so that backends in other languages can use it.

**Acceptance criteria**

- [x] Given the calls of 05 §10, when the spike ends, then a written recommendation names a transport and encoding and states how `open` (which carries a checkpoint reference and a sequence of commits) and the other calls map onto it.
- [ ] Given a prototype of `applyCommit` over the recommended binding, when a typical commit is applied, then the measured overhead of the call is reported next to the target of well under a millisecond of CPU for applying a typical commit (04 §12).
- [x] Given the recommendation, when it is reviewed, then it lists what was ruled out and why, and the effect on a non-JavaScript client.

**Evidence (lane V-PRO-086-102, criteria 1 and 3):** `docs/adr/0314-lane-V-PRO-086-102.md`, decision 3 (the recommendation: HTTPS with HTTP/2, canonical JSON, the route for each call of 05 section 10, `open` as NDJSON when large, a rejection as an answer rather than a transport error) and decision 4 (gRPC, MessagePack or CBOR, WebSocket and JSON-RPC over stdio, each ruled out with its reason), decision 5 (the effect on a non-JavaScript client). Written document only; no test applies to it.

**Notes:** Time box: three working days. The spec says "a network interface" but names no transport (Open questions). Output only; the decision is recorded in an ADR by the maintainers. Lane V-PRO-086-102: criteria 1 and 3 are met by the proposed recommendation in the ADR above, which the maintainers have not accepted. Criterion 2 stays open: no `applyCommit` prototype over the binding exists, and the target of 04 section 12 is for the reference machine (ADR 0037), so a measurement here does not meet it. Needed from others: a prototype and a measurement on the reference machine.

### PRO-103 Load and materialise documents in the authority service

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | M | should | Integrating developer |

**Spec:** 05 §10 · **Requirements:** R6 · **Depends on:** PRO-102, CDM-011

As an integrating developer, I want to hand the authority service a checkpoint and commits and get canonical content back, so that my backend never has to implement the document model.

**Acceptance criteria**

- [ ] Given `open(doc, checkpointRef, commits, stateId)`, when it is called, then the service loads the document and `stateId` is the hash-chain head, which identifies the state even after the log was rewound.
- [ ] Given `materialise(stateId)` or `materialise(seq)`, when it is called, then it returns canonical CDM content equal, byte for byte, to the in-process authority package on the same input.
- [ ] Given a log rewind that produces a different state at the same `seq`, when a call names the old `stateId`, then the service does not return the new state's content.
- [ ] Given the service restarted or a document evicted from memory, when `open` is called again with the same inputs, then the same content results: the service holds no state that matters.

### PRO-104 Apply a commit in the authority service

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | L | should | Integrating developer |

**Spec:** 05 §10; 04 §5, §6; 07 §5; 12 §5 · **Requirements:** R3, R6, R7 · **Depends on:** PRO-103, SYN-006, SYN-010, PRM-009, FRW-015, FRW-020

As an integrating developer, I want one call that rebases, applies, checks invariants, runs the permission outcome check and the rules, so that my backend gets the same decisions as the reference service.

**Acceptance criteria**

- [ ] Given `applyCommit(stateId, commit, permissions, preconditions)`, when the commit is acceptable, then the result holds the mapped steps, the scopes touched and the new `stateId`.
- [ ] Given an unacceptable commit, when it is applied, then the result is a rejection whose code is a registry code (`stale_base`, `rebase_failed`, `invalid_op`, `permission_denied`, `field_invalid`, `conflict` or `read_only`) with the scopes where they apply.
- [ ] Given the fixtures and property tests of S3 (SPK-016), when they run against the service, then they give the same results as against the in-process package.
- [ ] Given `preconditions` that the caller relied on (for example the grants revision), when they no longer hold at apply time, then the commit is rejected as the room would reject it.
- [ ] Given a typical commit, when it is applied, then CPU time inside the service is well under a millisecond (target; 04 §12), excluding the network.

**Notes:** Second review (2026-11-06, SPK-027), SR-M6 and SR-M1: under ADR 0019 a sidecar-backed backend also needs projection calls (project a document and a commit for a visibility class; map a reader's commit to full positions), and S12 measured 1 to 1.3 ms per class per commit at 1,000 pages, above this story's target ([review](../review/2026-11-06-second-review.md)).

### PRO-105 Map ranges through commits in the authority service

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | S | should | Integrating developer |

**Spec:** 05 §10; ADR 0015 · **Requirements:** R6, R8 · **Depends on:** PRO-103, SYN-032

As an integrating developer, I want comment ranges and presence mapped by the authority service, so that threads follow the text in my backend as well.

**Acceptance criteria**

- [ ] Given `mapRanges(stateId, ranges)`, when it is called, then it returns the ranges mapped to the head, equal to the in-process mapping on the same fixtures.
- [ ] Given a range whose content was deleted, when it is mapped, then the result follows the behaviour defined for comment ranges in ADR 0015.
- [ ] Given a `stateId` that is not known, when the call is made, then the service says so, so the caller can `open` again.

### PRO-106 Compute restore steps, comparisons and attribution in the authority service

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | M | should | Integrating developer |

**Spec:** 05 §10; 08 §6, §7, §8 · **Requirements:** R4, R6 · **Depends on:** PRO-103, HIS-006, HIS-008, HIS-011, HIS-014, HIS-015, HIS-018, HIS-019, HIS-022

As an integrating developer, I want restore, comparison and attribution computed by the authority service, so that a relay or sidecar backend can offer the same history features.

**Acceptance criteria**

- [ ] Given `restoreSteps`, when it is called for a document or a region and a target `seq`, then it returns the steps or snapshot that restore it, equal to the in-process result on fixtures.
- [ ] Given `diff`, when it is called for two states with `word` or `char` granularity, then it returns the comparison equal to the in-process result.
- [ ] Given `attribution`, when it is called for a region or a block range, then it returns who wrote which spans, equal to the in-process result.
- [ ] Given the three calls, when they are read, then each has a documented request and response in the interface definition.

**Notes:** 05 §10 names the calls "as named" and gives no signatures (Open questions).

### PRO-107 Migrate documents and evaluate rules in the authority service

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | M | should | Integrating developer |

**Spec:** 05 §10; 03 §11; 12 §5 · **Requirements:** R6, R13 · **Depends on:** PRO-103, FRW-015, FRW-020, CDM-047

As an integrating developer, I want CDM migrations and field rules run by the authority service, so that my backend never reimplements them.

**Acceptance criteria**

- [ ] Given `migrate`, when it is called on a document of an older `cdm`, then it returns content valid for the new version, equal to the in-process migration on fixtures.
- [ ] Given a migration that fails, when it is called, then the result is a failure and no new state exists.
- [ ] Given `evaluateRules`, when it is called with a document state and field values, then it returns the same visibility, requirement, enablement and computed values as the shared rules package on the rules fixtures.
- [ ] Given the service, when its profile runs (PRO-125), then migrations and rule evaluations are covered.

**Notes:** Migrations are gated by an operator (03 §11.3), never triggered by opening a document.

## Conformance kit (05 §11)

### PRO-108 Run the kit against any server from a discovery URL

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | L | must | Integrating developer |

**Spec:** 05 §11; ADR 0008 · **Requirements:** R6 · **Depends on:** PRO-004, PRO-011, PRO-109

As an integrating developer, I want a black-box test runner in a container that needs only a discovery URL, a service credential and a test-mode switch, so that I can test my own server the same way the project tests its own.

**Acceptance criteria**

- [x] Given a container image, a discovery URL, a service credential and a test-mode switch, when the kit starts, then it needs nothing else to run.
- [ ] Given the bootstrap, when the kit runs, then it mints user tokens through `POST /tokens`, creates its own documents, and (when `webhooks` is announced) registers a webhook that points at itself.
- [x] Given the features announced in discovery, when profiles are selected, then each profile runs only if its features are announced; an announced feature whose profile fails makes the run fail, and an unannounced profile is reported as skipped.
- [x] Given the kit's sources, when they are searched, then they import no code from the component and have no access to the server's database: it uses only public interfaces.
- [x] Given a run, when it ends, then a report lists each profile and scenario with its identifier and result, in machine-readable and human-readable form.

**Evidence:** packages/tck/src/runner.ts (notApplicable, unmetNeeds, runKit): a profile runs only when its features or mode are announced, an unannounced one is reported as skipped with the reason, a failed scenario of a running profile fails the run (packages/tck/test/kit.test.ts, mock.test.ts); packages/tck/test/kit.test.ts checks that the kit's sources import only the protocol, model and authority packages, ws, fast-check and Node.js built-ins, and never mention a database; packages/tck/src/report.ts writes every profile and scenario with its identifier and result as JSON and as text (kit.test.ts; the CLI's --json and --text). packages/tck/Containerfile builds with podman build -f packages/tck/Containerfile --ignorefile packages/tck/Containerfile.ignore and the image runs (podman run --rm --cgroups=disabled localhost/docedit-tck --help on the WSL machine); its entry point, packages/tck/src/cli.ts, takes only --discovery, the credential from DEP_TCK_CREDENTIAL and --test-mode (the rest optional) and ran the core and presence profiles against a freshly started reference service with exit code 0; packages/tck/test/mock.test.ts and reference.test.ts run the kit with nothing but those inputs and a registered origin.

**Notes:** Phase inferred: the kit grows with the roadmap (05 §11) and this item is placed with the profile it serves. Packet K, 2026-11-06: criterion 2 stays open for its webhook half: the kit mints tokens and creates its documents, but no target announces webhooks (and DEP has no such feature name yet), so the self-pointing webhook is not built; it arrives with the webhooks profile (PRO-121).

### PRO-109 Offer a test-mode switch that shortens the timers

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | S | must | Operator |

**Spec:** 05 §11; 05 §3.1 · **Requirements:** R6, R10 · **Depends on:** PRO-009

As an operator, I want a test mode in which token lifetime, lease expiry and idle timeouts are short, so that the kit can test them in seconds.

**Acceptance criteria**

- [ ] Given the switch off, when the server runs, then every timer has its specified value.
- [ ] Given the switch on, when a token is minted, then its lifetime, lease expiry and idle timeouts are shorter, and a token lifetime is never longer than 15 minutes.
- [ ] Given the switch on, when the kit waits for a token to expire, a lease to lapse or an idle connection to be closed, then each happens within seconds.
- [x] Given the discovery document, when the test mode is on, then the document reveals nothing a client could use to enable test mode on a production server.

**Evidence (PRO-109 criterion 4, lane PRO-099-112):** services/document-service/test/control-plane/pro-109-discovery.test.ts (3 of 3 pass, memory storage): discovery at `/.well-known/dep` names no switch, no `/_test/` path and no hook, and has the same top-level keys with the switch on and off; a query or header that asks for test mode does not change it.

**Notes:** Lane U-PRO-103-119, round 1, 2026-11-13: test mode now also shortens the data-plane heartbeat to 2 s (`testDefaults`, services/document-service/src/data-plane/index.ts), so the kit's `core.session.silence` runs in test mode on PostgreSQL (`u-pro-103-119-core.pg.test.ts`). Criteria 2 and 3 stay open: the test-mode token lifetime is 60 s (`TEST_TIMERS.tokenLifetimeS`), which is not "within seconds"; the value is an open question (docs/adr/0315-lane-U-PRO-103-119.md, decision 4). How the switch is kept off in production is not stated; needs a security review (SEC) (Open questions). Phase inferred: the kit grows with the roadmap (05 §11) and this item is placed with the profile it serves. Packet K, 2026-11-06: the kit's side is built: a scenario that waits for a server timer runs only with --test-mode, and core.discovery.no-test-switch checks that discovery and welcome reveal no switch; ADR 0042 item 9 proposes the contract (no clock skew on expiry, a heartbeat of seconds announced in welcome, leases of seconds, tokens never above 15 minutes). The criteria are about the server and stay open: the reference service has no switch yet (control plane), and only the kit's mock target implements one (packages/tck/test/targets/mock-server.ts). Lane PRO-099-112, round 2: the reference service now has the switch (BE-079; services/document-service/src/config.ts, server.ts, control-plane/test-hooks.ts), so the earlier "no switch yet" is stale. Criterion 4 is ticked (pro-109-discovery.test.ts). Criteria 1 to 3 stay open: criterion 1 needs a check of every timer's specified value, which is not written; criterion 2 is partly covered (lifetime in be-079-token-lifetime.test.ts) but the shorter lease and idle timeouts are not tested; criterion 3 conflicts with the built value: TEST_TIMERS sets the token lifetime to 60 s, which is a minute, not seconds. Open question recorded in docs/adr/0218-lane-PRO-099-112.md. Lane PRO-099-112, round 3: criterion 1 is partly checked by `services/document-service/test/control-plane/pro-109-timers.test.ts` (heartbeat 25 s, hello 10 s, room idle 60 s, idempotency 24 h, preview window 10 s and the 15 minute token maximum, with the switch off). It stays open: the job lease, node lease and outbox poll have no specified value in 05 or 06, and the test does not show what they are. Criterion 2 stays open: the service has no region lease route (`acquireLease` in `packages/authority` has no caller in `services/`), so lease expiry cannot be shortened or tested there; the shorter room idle, hello, idempotency and preview values are checked in the same file.

### PRO-110 Ship golden message, step-semantics and canonical-hash fixtures

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 05 §11, §5.9; 04 §4; 03 §2 · **Requirements:** R6 · **Depends on:** PRO-004, SYN-002, CDM-011

As a maintainer, I want fixtures generated from the pinned library release, so that an independent implementation can prove it applies steps and hashes documents the same way.

**Acceptance criteria**

- [x] Given every message type, when the fixtures are read, then each has a valid fixture and an invalid one, and the example conversation of 05 §5.9 is a fixture replayed in order.
- [x] Given the engine definition file, when the step fixtures are generated, then they hold apply, map and rebase cases produced by the exact pinned release of prosemirror-transform.
- [x] Given the canonical-hash fixtures, when the SHA-256 of the RFC 8785 form is computed by an independent implementation, then it equals the fixture value.
- [x] Given a library release that changes any fixture, when CI regenerates them, then the build fails unless the engine identifier changed.
- [ ] Given the fixtures, when `protocol` and the kit run them, then both pass.

**Evidence:** packages/tck/src/fixtures.ts reads the step-semantics fixtures (apply, map, rebase) of the pinned prosemirror-transform release and the capability fixtures through @docedit/authority, and the CDM-011 canonical-hash fixtures through @docedit/model's fixtures export; packages/tck/src/jcs.ts, an RFC 8785 implementation written from the RFC, reproduces the bytes and SHA-256 of every canonical case and the document hash of every engine case that applies, and packages/tck/test/canonical-python.test.ts runs the model's Python implementation (packages/model/conformance/canonical.py) on the same fixtures (packages/tck/test/kit.test.ts); the kit refuses fixtures whose library release differs from the installed one under the same engine identifier, beside packages/authority/test/engine.test.ts. packages/tck/fixtures/messages/messages.json (valid frames with required and with every member, invalid frames with a member missing, of the wrong type and a mistyped envelope, for all 29 message types, generated by packages/tck/scripts/generate.ts and checked against the codec in packages/tck/test/kit.test.ts) and fixtures/messages/conversation.json, replayed in order by semantics.conversation (packages/tck/src/profiles/semantics.ts), which passes against the mock backend over DEP.

**Notes:** Phase inferred: the kit grows with the roadmap (05 §11) and this item is placed with the profile it serves. Packet K, 2026-11-06: criterion 5 stays open: the protocol's codec runs the message fixtures (packages/tck/test/kit.test.ts), but semantics.steps cannot replay the engine fixtures through a server, because their base document breaks I11 (table rows with identifiers that are not node identifiers) and POST /documents refuses it; reported to the authority (SYN-002). Round 1, 2026-11-13: the base documents are valid now, so semantics.steps runs. apply-002 is an identity-blind case: the kit accepts only the 03 §5 refusal of a suggestion mark that does not name the submitter (ADR 0107 §1). apply-020 (P3) is refused by the room and applied by the pure engine; it is a known failure of the mock and the reference service until SYN-002 decides which layer owns P3 (ADR 0107 §2). Map and rebase fixtures are replayed by packages/authority/test/engine.test.ts, not by the kit, which has no prosemirror-transform dependency; so criterion 5 stays open.

### PRO-111 Provide the `core` profile

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | L | must | Integrating developer |

**Spec:** 05 §11, §1 rule 7, §2 to §6 · **Requirements:** R6, R7 · **Depends on:** PRO-108, PRO-110, PRO-006, PRO-021, PRO-023, PRO-027, PRO-040

As an integrating developer, I want a `core` profile that covers discovery, authentication, framing, channels, sync and the REST conventions, so that a server that passes it can host the editor.

**Acceptance criteria**

- [x] Given discovery, `POST /tokens` and the CORS rules, when the profile runs, then it asserts the discovery shape, the minted token's claims and every allowed and exposed header.
- [x] Given framing and the session, when the profile runs, then it asserts the envelope, `hello` and `welcome`, the close codes 4400, 4401, 4403, 4406, 4408 and 4413, ping and pong, unknown-message handling, and chunk reassembly with its 10-second timeout.
- [ ] Given channels, when the profile runs, then it triggers every `ch.rejected` code, `ch.close`, `ch.closed`, and joining by `stream`, `page` and `reload` with accepted and unknown in-flight commits.
- [ ] Given sync, when the profile runs, then it asserts acknowledgement, rebased acknowledgement with steps, the duplicate acknowledgement with steps, `busy`, each reject action, `sync.reset`, and ordering of acknowledgements after lower commits.
- [ ] Given REST, when the profile runs, then it asserts problem details, cursor lists, `ETag` and `If-Match`, pinned content reads and bare-identifier checks for the routes announced.
- [ ] Given the reference service, when CI runs, then the profile passes against it on every change.

**Evidence:** packages/tck/src/profiles/core-session.ts (discovery.shape, discovery.no-test-switch, tokens.claims with the signature checked against jwks_uri, tokens.lifetime, tokens.docs-limit, cors.preflight, cors.expose, cors.refused, session.welcome, session.hello-first, close.4400, close.4401, close.4403, close.4406, close.4408, close.4413, session.ping, session.heartbeat, session.unknown-type, session.unknown-members, chunk.client, chunk.server, chunk.timeout, auth.refresh, auth.expiring, auth.revoked) and core-rest.ts (rest.problem, rest.document, rest.if-match, rest.list, rest.content, rest.idempotency, rest.validation, rest.commits, rest.regions, rest.delete) with exports.identifiers for the bare identifiers of an announced route; they pass against the mock backend over DEP and, but for the defects listed in packages/tck/test/reference.test.ts, against the reference service.

**Notes:** Evidence audit, 2026-11-13: criterion 5 unticked: the `core` profile (core-rest.ts) has no bare-identifier scenario; the only such checks are `exports.identifiers` and `assets.other-document`, which belong to the `exports` and `assets` profiles, and threads, comments and imports have none (PRO-045 criterion 4 is still open for the same reason); the file header of core-rest.ts claims "identifiers in paths" but no scenario does it. Packet K, 2026-11-06: criteria 3 and 4 stay open where the kit cannot provoke the case from outside: ch.rejected unavailable, sync.reject retry and busy need held writes or faults (PRO-126; BE-079), and page needs catch-up limits a scenario can exceed (skipped above 200 commits). Criterion 6 stays open: the reference service fails the scenarios listed in packages/tck/test/reference.test.ts. Round 1, 2026-11-13: thirteen of those known defects now pass and were removed from the list; the remaining known failures are semantics.steps (apply-020, ADR 0107 §2) and exports.states. perm-region.property failed once on the reference service with a random seed; group 2 fix round, 2026-11-13: reproduced with property seed 3, a kit defect (buildSteps threw on a paragraph an accepted `across` delete had removed), fixed, with regression tests in packages/tck/test/perm-property.test.ts and a fixed-seed run in reference.test.ts; the service was not at fault (ADR 0107 §4). Lane U-PRO-103-119, round 1, 2026-11-13: criterion 6 stays open. `services/document-service/test/postgres/u-pro-103-119-core.pg.test.ts` runs the core profile against the reference service on PostgreSQL in test mode (its own migrated database, dropped afterwards): every core scenario passes except `core.session.silence` (a silent peer is ended without a close frame, code 1006; the kit expects a 05 §5.7 code; open question, docs/adr/0315-lane-U-PRO-103-119.md, decision 3) and `core.channel.page` (skipped: catchUpCommits is 5000). The run found a server defect, fixed: discovery announced `exports` and `assets` on PostgreSQL but `ch.open` refused them (05 §1 rule 4; server.ts), so every channel open failed. One of four runs saw `POST /v1/sessions/revoke` answer 500; not reproduced, cause not found (ADR 0315, decision 6).

### PRO-112 Provide the `presence` profile

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Integrating developer |

**Spec:** 05 §11, §5.4 · **Requirements:** R7 · **Depends on:** PRO-111, PRO-031

As an integrating developer, I want a `presence` profile, so that a server that announces `presence` is tested for it.

**Acceptance criteria**

- [x] Given two sessions, when one sends `presence.update`, then the other receives `presence.state` with the server-derived identity.
- [x] Given a state that is invalid or above `presenceBytes`, when it is sent, then it is not relayed.
- [x] Given a session that disconnects, when it leaves, then peers receive it in `left`.
- [x] Given a server that does not announce `presence`, when the kit runs, then the profile is skipped.

**Evidence:** packages/tck/src/profiles/presence.ts (presence.peers, presence.identity, presence.not-relayed, presence.left); 4 of 4 pass against the mock backend over DEP and the reference service (packages/tck/test/mock.test.ts, reference.test.ts); a target without presence skips the profile with the reason (packages/tck/test/kit.test.ts, profile selection).

**Notes:** Phase inferred: the kit grows with the roadmap (05 §11) and this item is placed with the profile it serves.

### PRO-113 Provide the `perm-doc` and `perm-region` profiles

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | L | must | Integrating developer |

**Spec:** 05 §11, §5.5; 07 §4, §5, §9; review section 3.4 · **Requirements:** R3 · **Depends on:** PRO-111, PRO-033, PRO-052

As an integrating developer, I want profiles for document roles and region grants, so that a server that claims to enforce them is proven to.

**Acceptance criteria**

- [x] Given each document role in the `docs` claim, when the profile submits commits, then the accepted and rejected outcomes match the roles' capabilities.
- [x] Given region grants, when a user submits commits inside and outside the granted region, then commits outside are rejected with `permission_denied` and the scopes involved, and commits inside are accepted.
- [x] Given a grants change while a client is connected, when `PATCH` returns, then `perm.changed` arrives with a higher `rev` and a commit sent under the old rights is rejected.
- [x] Given a property test in the style of S3 (a random sequence of commits from a user), when it runs, then no accepted commit changes a scope outside the user's writable set, using the outcome check as the oracle (PRM-009).
- [x] Given a server that announces `regions`, when the kit runs, then both profiles run.

**Evidence:** packages/tck/src/profiles/perm.ts: perm-doc.access and perm-doc.commits check every document role against the authority's capability fixtures, perm-region.capabilities a stratified sample of those fixtures through grants, region states and document states, perm-region.inside-outside the scopes of a rejection, perm-region.grants-change the control commit, perm.changed and the old rights, perm-region.property random commits judged by the reference outcome check (packages/tck/src/oracle.ts; seed in the report); both profiles run against targets that announce regions and pass on the mock backend and the reference service (packages/tck/test/mock.test.ts, reference.test.ts).

**Notes:** The `perm-fill` profile (12 §10) is FRW-025, FRW-060, FRW-065. The grants-revision condition itself is not observable from outside (PRO-126).

### PRO-114 Provide the `assets` and `exports` profiles

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Integrating developer |

**Spec:** 05 §11, §6.2 · **Requirements:** R5, R10 · **Depends on:** PRO-111, PRO-061, PRO-062, PRO-063, PRO-064

As an integrating developer, I want profiles for assets and exports, so that a server that announces them is tested for the full job flow.

**Acceptance criteria**

- [x] Given an upload, when the profile runs the flow of PRO-061 and PRO-062, then it asserts quarantine, completion, `asset.ready` and `asset.failed` (for a mismatched type) and short-lived URLs.
- [x] Given an export request, when the profile runs, then it asserts `202`, each state in order, progress, a terminal state, cancellation, and the bare-identifier checks.
- [x] Given a caller of another document, when it asks for an asset or a job, then it is refused.
- [x] Given a server without `assets` or `exports`, when the kit runs, then the matching profile is skipped.

**Evidence (lane U-PRO-103-119, round 2, criterion 3; criterion 1 unticked by the reviewer, U4 group 2 round 2: the `assets.ready` scenario only checks that the resolve response contains `http`, so neither a short lifetime (`expiresAt` of each resolved URL, asset-routes.ts) nor the quarantine state (a resolve before `asset.ready` is refused) is asserted; the profile needs those two checks before the criterion can be ticked):** `services/document-service/test/postgres/u-pro-114-assets.pg.test.ts` runs the `assets` profile (packages/tck/src/profiles/jobs.ts) against the reference service started on PostgreSQL in Podman (a database of this run, dropped at the end) and on the S3-compatible store of the test environment, with the in-process asset worker and its Podman sandbox; every assets scenario passes, including the refusal of a caller of another document. Run with `pnpm vitest run services/document-service/test/postgres/u-pro-114-assets.pg.test.ts` (34 s). The WSL Podman machine needs the machine route (`DOCEDIT_PODMAN_MACHINE`, services/asset-worker/src/container.ts), which the test sets.

**Evidence (criterion 1, re-ticked in the U4 group 2 round 2 fix, 2026-11-13):** packages/tck/src/profiles/jobs.ts, `assets.ready`: quarantine (bytes sent into the quarantine area and never completed; resolve refuses or returns no URL for that asset), completion (`202` from `POST /assets/{aid}/complete`), `asset.ready`, then every resolved entry has an http(s) URL and an `expiresAt` in the future and at most 15 minutes ahead (`SHORT_LIVED_MS`; bound proposed in docs/adr/0315-lane-V-PRO-103-119.md decision 1 and docs/adr/0315-lane-U-PRO-103-119.md item 8). `assets.failed`: `asset.failed` for bytes that are not the declared type. Both waits keep the connection's token fresh (`awaitAssetEvent`, ADR 0315 lane U item 10) and fail with the server's `ch.closed` when the channel is ended. services/document-service/test/postgres/u-pro-114-assets.pg.test.ts now also asserts that `assets.ready`, `assets.failed` and `assets.other-document` all ran and passed. Run with `pnpm vitest run services/document-service/test/postgres/u-pro-114-assets.pg.test.ts` against PostgreSQL and S3 in Podman: the final version passed twice (39 s and 60 s). Under heavy load on this machine (the Podman CLI took 21 to 96 s to answer `podman version`) other runs failed: the sandboxed check did not finish within the wait, or the room closed the channel with `unavailable` ("the node lease could not be proved"). These are failures of the loaded environment, not of the checks, and are listed in the fix report.

**Evidence:** packages/tck/src/profiles/jobs.ts: the assets profile is skipped with the reason against both targets, and exports against the mock backend (packages/tck/test/mock.test.ts). packages/tck/src/profiles/jobs.ts: exports.request (202 and the job of D68), exports.states (the states in the order of D68, progress as a percentage that never goes back, a terminal state within 120 s, the result or the error), exports.cancel (204, cancelled, a second DELETE changes nothing), exports.identifiers (another user of the document, a caller of another document, the service credential; D69) and exports.refusals (no-export, an unknown target, pending_suggestions); run against the reference service, they find that its jobs never leave queued (packages/tck/test/reference.test.ts).

**Notes:** Phase inferred: the kit grows with the roadmap (05 §11) and this item is placed with the profile it serves. Packet K, 2026-11-06: criteria 1 and 3 stay open for assets: the assets profile is written (packages/tck/src/profiles/jobs.ts: upload into quarantine, asset.ready, asset.failed for a mismatched type, signed URLs, refusal for another document) but no target announces assets yet, so it has never run. Lane U-PRO-103-119, round 2: the reference service announces `assets` when its in-process asset worker runs (PostgreSQL and S3 in the test environment), so the profile now runs and criteria 1 and 3 are ticked (Evidence above). Lane V-PRO-103-119, round 1, 2026-11-14: criterion 1 stays unticked. The `ready` scenario now checks quarantine (an upload that is never sent gets no URL from resolve) and that each signed URL expires within `SHORT_LIVED_MS` (15 min, the 05 §3 maximum applied to URLs; the spec gives no URL lifetime and the server default is 300 s, `DOCEDIT_SIGNED_URL_SECONDS`, not announced in discovery; owner to confirm the bound, see docs/adr/0315-lane-V-PRO-103-119.md). The scenario also refreshes the wire token (auth.refresh) before waiting for `asset.ready`, because the 60 s test-mode token expired during a slow container check under load. Not yet run green: `services/document-service/test/postgres/u-pro-114-assets.pg.test.ts` fails before any scenario, because migration `0061_fork_provenance.sql` (another lane, V-HIS-017-032) adds `documents.forked_from`, which migration `0002` already creates, so a fresh PostgreSQL database cannot be migrated. U4 group 2 round 2 fix, 2026-11-13: that migration failure was seen once in this fix and had cleared by the next run; the test then ran green twice and criterion 1 is ticked (second Evidence line).

### PRO-115 Test every authorisation row and every rejection code negatively

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 05 §11; 07 §12; 10 §5 · **Requirements:** R3, R10 · **Depends on:** PRO-111, PRO-038, PRM-056

As a maintainer, I want one negative test for every row of the authorisation matrix and for every rejection code, so that a missing check cannot go unnoticed.

**Acceptance criteria**

- [ ] Given each row of the matrix in 07 §12, when the kit runs, then for each row it calls the operation as a caller who lacks the capability and asserts a refusal, and with the capability and asserts success.
- [x] Given the rows that need a service credential (import, fork, create, list, search, audit, webhooks, tokens, revoke), when a user token calls them, then each is refused.
- [ ] Given each code of the registry that a server can send in a rejection, when the kit provokes it, then it asserts the code, the surface and the retry hint.
- [x] Given a new row or code, when it is added to the prose without a test, then PRO-117 fails the build.

**Evidence:** packages/tck/src/profiles/authz.ts (authz.service: every route of row 13 refuses a user token with 403 forbidden) and packages/tck/src/profiles/registry.ts (every code of 05 §5.8 provoked on each surface the kit reaches, checked against the registry data for the code, the surface, retryable, the sync.reject action and the HTTP status of D61; codes that need a fault, load or a feature are skipped with the reason); packages/tck/test/sync.test.ts fails for a matrix row or a registry code without a scenario or a reason. packages/tck/src/profiles/authz.ts: rows 1, 2, 3, 10, 12 and 13 of the published matrix (MATRIX of @docedit/authority, equal to spec/permissions/permissions-1.json) are called without and with the capability, and the unmatrixed routes follow D65; the rows of comments, assets, history and leases are skipped with their feature until those resources exist, as the Notes foresee, and packages/tck/test/sync.test.ts fails for a row with neither. Lane V-PRO-103-119, round 3, criterion 2: packages/tck/test/pro-115-authz.reference.test.ts starts the reference service in memory (startReference, default features) and runs the authz profile against it: `authz.service` passes, so each route of row 13 (retention, holds, quotas, origins, keys and the rest; the kit's guard fails if `serviceRoutes` misses one of the matrix) refuses a user token with 403 `forbidden` and the service credential is allowed (Node.js, `pnpm exec vitest run packages/tck/test/pro-115-authz.reference.test.ts`). The routes of retention, holds and quotas were added to `serviceRoutes` in packages/tck/src/profiles/authz.ts, and their operations to packages/tck/test/pending.ts (covered now). sync.test.ts passes after that change. Fixer V4 group 2, round 3: row 13 gained `GET /origins` and `GET /keys` (UX-077); both were added to `serviceRoutes` and the scenario's `covers`, and removed from packages/tck/test/pending.ts; pro-115-authz.reference.test.ts (7 tests) and sync.test.ts pass again (Node.js, 2026-11-14).

**Notes:** The negative tests of routes belong to features that arrive later (history, comments, webhooks) and are added with them. Phase inferred: the kit grows with the roadmap (05 §11) and this item is placed with the profile it serves. Evidence audit, 2026-11-13: criteria 1 to 3 unticked. Criterion 1: rows 4 to 9 and 11 of the matrix (threads, assets, named version, region restore, lease) are generated scenarios that always skip ("has no scenario yet" in packages/tck/src/profiles/authz.ts), so only 6 of 13 rows are called with and without the capability. Criterion 2: `authz.service` now fails against both the mock backend and the reference service at its guard "the kit calls every route of row 13", because row 13 of spec/permissions/permissions-1.json gained 6 routes (GET and PUT /retention, GET and PUT /documents/{id}/retention, POST /documents/{id}/holds, GET /holds) that `serviceRoutes` does not call, so no refusal is asserted at all; re-tick once those routes are added. Criterion 3: the codes `rate_limited`, `quota_exceeded`, `slow_consumer`, `workflow_active`, `unavailable`, `internal` and `field_invalid` are never provoked (they are `unreachable` in packages/tck/src/profiles/registry.ts and listed in packages/tck/test/pending.ts), so the code, surface and retry hint are not asserted for them. Criterion 4 stays ticked (packages/tck/test/sync.test.ts passes). Lane V-PRO-103-119, round 3, 2026-11-14: criterion 2 is ticked (Evidence above). Criterion 1 stays unticked. Rows 4, 5, 8 and 11 (threads, named version, lease) are now written as scenarios in authz.ts with `needs` on `comments`, `history` and `leases`. The reference service serves those routes but announces none of the three by default (DEFAULT_FEATURES and server.ts), so the kit skips them there. With `DOCEDIT_FEATURES=presence,regions,suggest-enforced,read-restrictions,comments,history,leases` the four rows pass with and without the capability in pro-115-authz.reference.test.ts (second run). Whether the reference announces them is an open question for the owner, recorded in docs/adr/0315-lane-V-PRO-103-119.md; the default is left as the service has it. Row 9 (restore a region): the viewer refusal holds, but the editor gets 403 `needs manage`, because the restore route applies the whole-document guard before it reads `region`, and region restore is not offered (HIS-018; services/document-service/src/control-plane/restore-route.ts). That is a defect of the history lane, not fixed here; the scenario is `authz.restore.region` and the test expects it to fail until then. Rows 6 and 7 (assets) still have no scenario and need the assets feature (PostgreSQL and S3 in Podman, as in the U lane's test). Row 12 (export) is skipped by the reference service, which announces `exports` only with a compile worker (ADR 0054). spec/permissions/permissions-1.json does not list the quota routes that packages/authority/src/permissions/matrix.ts lists (GET and PUT /quotas); the artifact needs regenerating by its owner (needsFromOthers). Criterion 3 unchanged. Lane V-PRO-103-119, round 5, 2026-11-14: `field_invalid` on the sync and REST surfaces is now provoked (packages/tck/src/profiles/registry.ts; the sync fill is made by a `filler` user, which P7 requires, and the REST case is a prefill of a number field with text; packages/tck/test/pro-115-field-invalid.reference.test.ts passes against the reference service, Node.js, `pnpm exec vitest run packages/tck/test/pro-115-field-invalid.reference.test.ts`); the entry is removed from packages/tck/test/pending.ts. Still unprovoked, so criterion 3 stays unticked: `workflow_active` (needs the workflow routes, phase 2), `quota_exceeded` (needs a quota lowered by the operator, 06 §12; PRO-126), `rate_limited`, `unavailable`, `internal` and `slow_consumer` (need load or fault injection; PRO-126). Criterion 1 is unchanged by this round.

### PRO-116 Fuzz the envelope parser and step validation

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 05 §11; 10 §5 · **Requirements:** R10 · **Depends on:** PRO-111, SYN-002

As a maintainer, I want fuzzers that hammer the parser and step validation, so that malformed input cannot crash or stall a server.

**Acceptance criteria**

- [x] Given a corpus of random and mutated frames, when the envelope fuzzer runs against a server, then every frame is answered with an `error`, a close with a defined code (PRO-037) or is ignored as unknown, and the server stays up.
- [x] Given random and mutated steps, when the step-validation fuzzer submits them, then each is rejected with a registry code or applied, and the document stays valid against the schema.
- [x] Given a message just below and just above `maxMessageBytes`, when the fuzzer sends it, then it is delivered or closed with 4413 as specified.
- [x] Given the time budget of one hour (target), when fuzzing finds a crash or a stall, then the run fails and keeps the input that caused it.

**Evidence:** packages/tck/src/profiles/fuzz.ts: fuzz.envelope sends random, JSON and mutated frames and edge cases from a recorded seed, probes each with ping and requires an answer, a close code of 05 §5.7 or nothing, then a fresh session; fuzz.steps submits random and mutated steps of every type and checks every reply's code against the registry and the document against the CDM validation after every batch; fuzz.boundary sends exactly maxMessageBytes (delivered) and one byte more (4413); all three pass against the mock backend and the reference service (packages/tck/test/mock.test.ts, reference.test.ts). Criterion 4 (failure path): packages/tck/test/pro-116-fuzz-stall.test.ts runs the fuzz profile against the mock target started with `stallAfterPings: 0` (packages/tck/test/targets/mock-server.ts, which then ignores every ping) and a 60 s budget; the run fails, the failure names the stall, seed 116, batch 0 and the input, and the report keeps the input (`pnpm exec vitest run packages/tck/test/pro-116-fuzz-stall.test.ts`, Node.js, 3 of 3 pass).

**Notes:** Phase inferred: the kit grows with the roadmap (05 §11) and this item is placed with the profile it serves. Packet K, 2026-11-06: criterion 4 stays open: the budget is --fuzz-ms (20 s per fuzzer by default, 4 s in the kit's own tests) and a failure keeps the seed, batch and input in the report, but the one-hour run has not been made and no crash has been found to show the kept input. Lane V-PRO-103-119, 2026-11-14: the failure path is proven by pro-116-fuzz-stall.test.ts with a 60 s budget, so the criterion is ticked; the one-hour run itself has still not been made and no duration is measured.

### PRO-117 Keep the prose, the artifacts and the scenarios in step

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 05 §1 rule 7, §11 · **Requirements:** R6 · **Depends on:** PRO-001, PRO-002, PRO-003, PRO-111

As a maintainer, I want the kit to check the artifacts against this document and to refuse anything without a scenario, so that the prose, the machine-readable definitions and the tests cannot drift apart.

**Acceptance criteria**

- [x] Given the tables of 05 §5 to §7, when the check runs, then every message type, close code, error code, resource and method, and event type appears in the artifacts, and every artifact entry appears in the prose.
- [x] Given a message type, field or resource in the artifacts, when the check runs, then at least one kit scenario exercises it; one without a scenario makes the build fail.
- [x] Given a difference, when the check fails, then the report names the section of the prose and the artifact entry.
- [x] Given a message type, field or resource marked final, when it has no scenario, then it cannot be marked final.

**Evidence:** packages/tck/test/sync.test.ts reads the tables of 05 §5 to §7 and compares them with spec/dep/dep-1.registry.json, dep-1.asyncapi.json and dep-1.openapi.json both ways, naming the section and the entry of each difference; every message type, optional payload member, route, close code, error code and notification type of the artifacts has a scenario (the declared coverage in packages/tck/src/profiles/*.ts) or a reason in packages/tck/test/pending.ts, a covered pending entry fails, and a definition marked final may have nothing pending; packages/tck/test/targets/judge.ts checks in the runs against both targets that every passing scenario's traffic holds what it declares.

**Notes:** Rule 7 of 05 §1. The check reads the tables of the prose, so their format is kept machine-readable. Phase inferred: the kit grows with the roadmap (05 §11) and this item is placed with the profile it serves.

### PRO-118 Provide the `perm-suggest` profile

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Integrating developer |

**Spec:** 05 §11; 07 §5; 04 §3.1 · **Requirements:** R3, R8 · **Depends on:** PRO-113

As an integrating developer, I want a profile for the `suggest` role, so that a server that announces `suggest-enforced` is proven to confine suggestion-only users.

**Acceptance criteria**

- [x] Given a user with only `suggest`, when they submit a commit that changes content directly, then it is rejected with `permission_denied`.
- [x] Given the same user, when they submit a commit that only adds suggestion marks, then it is accepted.
- [x] Given an editor, when they accept or reject a suggestion, then the commit with origin `suggestion.accept` or `suggestion.reject` is accepted only if the editor may edit the scopes it changes.
- [x] Given a property test of random commits from a suggestion-only user, when it runs, then no accepted commit changes document content outside suggestion marks (PRM-009).

**Evidence:** packages/tck/src/profiles/perm-suggest.ts (perm-suggest.direct-rejected, perm-suggest.suggestion-accepted, perm-suggest.suggestion-accept-reject: the suggester's own accept is refused with permission_denied, the editor's accept and reject with their origins are acknowledged; perm-suggest.property: 8 seeded runs judged by the reference outcome check in packages/tck/src/oracle.ts); the profile is registered in packages/tck/src/profiles/index.ts; packages/tck/test/perm-suggest.test.ts runs it against the mock backend and passes all four scenarios.

**Notes:** Run against the mock backend only in this lane; the reference service (packages/tck/test/reference.test.ts) was not run here. The property runs for 8 seeds in the test; the kit's default run count is larger.

### PRO-119 Provide the `history` profile

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Integrating developer |

**Spec:** 05 §11, §6.2; 07 §8, §13; 08 · **Requirements:** R4 · **Depends on:** PRO-111, PRO-054, PRO-055, PRO-056, PRO-058

As an integrating developer, I want a profile for history, comparison, attribution, restore and read markers, so that a server that announces `history` is tested for the visibility gate and for restore.

**Acceptance criteria**

- [ ] Given a series of commits, when the profile reads `history`, `versions`, `diff` and `attribution`, then the outputs are consistent with the commits.
- [ ] Given a visibility setting such as `since_access`, when a user requests any route that takes a `seq` below their gate, then it is refused at every route that takes one (content, history, diff, attribution, activity, fork, export and commits).
- [ ] Given a restore with `dryRun`, when it runs, then nothing is stored; given a real restore of a region, then comments and attribution in untouched blocks are preserved and grants are not restored.
- [x] Given a read marker, when it is moved backwards, then it stays where it was.

**Evidence:** packages/tck/src/profiles/history.ts (the `history` profile, scenario `history.read-marker.forward-only`: a forward move, a backward move to 0 and an equal move of `PUT /documents/{id}/read-marker` by a user; the marker in force stays at the forward seq); packages/tck/test/pro-119-history.reference.test.ts runs the profile against the reference service started with `history` in DOCEDIT_FEATURES and passes (Node.js, `pnpm exec vitest run packages/tck/test/pro-119-history.reference.test.ts`, lane V-PRO-103-119, round 5, 2026-11-14).

**Notes:** Lane V-PRO-103-119, round 5, 2026-11-14: criterion 4 is ticked (Evidence above). Criteria 1 to 3 stay unticked. Criterion 1 needs `GET /documents/{id}/history`, `GET /documents/{id}/diff` and `GET /documents/{id}/attribution`, which the control plane does not mount (only `POST fork`, `POST restore` for a whole document, `PUT read-marker`, `GET activity` and the versions routes are in services/document-service/src/control-plane; the functions exist in packages/history). Criterion 3 needs the dry-run restore (`dryRun` is refused by restore-route.ts, HIS-021) and the region restore (HIS-018, refused by restore-route.ts). Criterion 2 needs a `since_access` visibility setting that the kit cannot yet set for a document, and the routes of criterion 1 for the gate's history, diff and attribution cases; the scenario for it is not written. The profile is listed in packages/tck/src/profiles/index.ts with its scenario instead of the phase 2 placeholder; `operation PUT /documents/{id}/read-marker` is removed from packages/tck/test/pending.ts. Lane U-PRO-103-119, round 2, 2026-11-14: no criterion can run yet. The reference service serves only the fork route of the history family (`services/document-service/src/control-plane/history-routes.ts`); `history`, `versions`, `diff`, `attribution`, `restore`, `read-marker` and `activity` are not built, so the profile has nothing to call (needs the HIS routes first; listed in needsFromOthers). Not built in lane PRO-113-126. The `history` profile is still a `later` entry with no scenarios (packages/tck/src/profiles/index.ts). The mock backend announces only `presence`, `regions` and `suggest-enforced` (packages/backend-mock/src/service.ts), and pending.ts lists the history resources as phase 2, so no target can run it yet.

### PRO-120 Provide the `comments` profile

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Integrating developer |

**Spec:** 05 §11, §6.2; ADR 0015 · **Requirements:** R8 · **Depends on:** PRO-111, PRO-059, PRO-060, PRO-036

As an integrating developer, I want a profile for threads and comments, so that a server that announces `comments` is tested for range mapping and permissions.

**Acceptance criteria**

- [ ] Given a thread on a range, when other users insert text before it, then the range reported with the thread follows the text.
- [ ] Given a user with `view` only, when they create a thread, then it is refused; given `comment` in the target's scope, then it is accepted.
- [ ] Given a `baseSeq` outside the rebase window, when a thread is created, then it is refused.
- [ ] Given thread and comment changes, when they are made, then the matching events arrive on the channel.

**Notes:** Not built in lane PRO-113-126. The `comments` profile is still a `later` entry with no scenarios (packages/tck/src/profiles/index.ts). The mock backend does not announce `comments`, and pending.ts lists the comment resources and events as phase 2, so no target can run it yet.

### PRO-121 Provide the `webhooks` profile

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Integrating developer |

**Spec:** 05 §11, §7 · **Requirements:** R6, R10 · **Depends on:** PRO-111, PRO-068, PRO-069, PRO-070, PRO-071, PRO-072

As an integrating developer, I want a profile for webhooks, so that a server that announces them is tested for signatures, retries and egress rules.

**Acceptance criteria**

- [ ] Given a webhook that points at the kit, when events occur, then the kit receives CloudEvents bodies whose `type`, `subject` and `data` match the schemas.
- [ ] Given the headers of each delivery, when the kit verifies them, then the signature is valid within five minutes and with either secret during a rotation.
- [ ] Given a kit endpoint that fails the first attempts, when the delivery is retried, then the same `webhook-id` arrives again and the kit deduplicates on it.
- [x] Given a subscription to a private address, when a delivery is attempted, then no request reaches the target.
- [ ] Given 100 commits in 10 seconds, when `dep.document.changed` is counted, then there is at most one per document per 10 seconds.

**Evidence:** Criterion 4 (lane V-PRO-120-131, round 3): `services/document-service/src/control-plane/pro-121-private-target.test.ts` (4 tests, Node.js, no container): a dispatcher with the real `EgressProxy`, the Node.js connector and the system resolver sends to a loopback target, to `localhost`, to a name that resolves to 10.20.30.40, and to the metadata address; each row ends `failed` with reason `loopback`, `private` or `metadata`, no connection is attempted, and the loopback target counts zero requests.

**Notes:** Not built in lane PRO-113-126. The `webhooks` profile is still a `later` entry with no scenarios (packages/tck/src/profiles/index.ts). The mock backend does not announce `webhooks`, and no target serves the webhook dispatcher, which is BE's (see the epic's Left-to-other-epics note), so no target can run it yet. Lane U-PRO-120-131, round 2: no criterion is ticked. `services/document-service/src/control-plane/webhook-deliveries-pg.ts` adds a PostgreSQL delivery store and its DDL, and `services/document-service/test/postgres/u-pro-121-webhook-deliveries.pg.test.ts` (4 tests, PostgreSQL in Podman) shows that a retry keeps its `webhook-id` and ends delivered there. Still open: the kit profile has no scenarios; a kit receiver on the same host cannot be reached, because the egress policy refuses loopback and private addresses (10 §3.2); the table needs a migration, which is the main session's to add; and the composition does not use the store. Proposals in docs/adr/0316-lane-U-PRO-120-131.md. Lane V-PRO-120-131, round 3: criterion 4 is ticked (evidence above). Criterion 2 stays open: the signature and the rotation are proven by `webhook-signing.test.ts` and `webhook-dispatcher.test.ts` on the server's own verifier, but the kit does not verify deliveries (no `webhooks` profile). Criterion 5 is proven for the debounce in front of the dispatcher (`event-throttle.test.ts`), not yet counted at a receiver. Criteria 1 and 3 need the kit receiver, which the egress policy blocks on loopback (10 §3.2); not run.

### PRO-122 Provide the `leases` profile

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | S | should | Integrating developer |

**Spec:** 05 §11, §6.2; 07 §10 · **Requirements:** R3 · **Depends on:** PRO-111, PRO-053, PRO-109

As an integrating developer, I want a profile for leases, so that a server that announces `leases` is tested for exclusivity and expiry.

**Acceptance criteria**

- [ ] Given a lease held by one user, when another user tries to edit the region, then the commit is rejected with `permission_denied` and `perm.changed` lists the lease.
- [ ] Given a holder that stops sending heartbeats, when the test-mode expiry passes, then the lease ends and `perm.changed` is sent.
- [ ] Given a user with `manage`, when they break the lease, then it ends at once.
- [ ] Given a server without `leases`, when the kit runs, then the profile is skipped.

**Notes:** Not built in lane PRO-113-126. The `leases` profile is still a `later` entry with no scenarios (packages/tck/src/profiles/index.ts). The mock backend does not announce `leases`, and pending.ts lists the lease routes as phase 2, so no target can run it yet.

### PRO-123 Ship the rules fixtures in the kit

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | S | must | Maintainer |

**Spec:** 05 §11; 12 §5 · **Requirements:** R13 · **Depends on:** PRO-110, FRW-015, FRW-020

As a maintainer, I want the rules fixtures packaged in the kit, so that a native backend in another language can prove it evaluates field rules the same way.

**Acceptance criteria**

- [x] Given the shared rules package, when its fixtures are exported, then the kit contains them in a documented format.
- [ ] Given a native backend that runs the fixtures, when it evaluates every case, then results match the fixtures exactly.
- [x] Given a change to the rules behaviour, when CI regenerates the fixtures, then the build fails unless the rules version changed.

**Evidence:** Criterion 1: `packages/tck/fixtures/rules/` (the kit's copy of `spec/rules/rules-1.fixtures.json`, `rules-1.manifest.json`, `rules-1.schema.json`, and `README.md` with the format), written by the kit's `generate` script (`packages/tck/scripts/generate.ts`, `packages/tck/scripts/rules-copy.ts`); `packages/tck/src/rules-fixtures.ts` (`rulesFixtures`, `rulesManifest`); `packages/tck/test/rules-fixtures.test.ts` (every file matches the manifest SHA-256; every case is in the documented format; the copy equals a fresh copy by the generate script, byte for byte, when `spec/rules/` is present). Criterion 3 is enforced by the rules package, not the kit: `packages/rules/scripts/generate.ts` refuses to write, and exits with 1, when `changedUnderSameVersion` (`packages/rules/src/artifacts.ts`) reports a changed expected result or a removed case under the same rules version; `packages/rules/test/artifacts.test.ts` ('refuse a changed expectation or a dropped case unless the version changes', and the published set has no such change); CI runs `pnpm generate` and then `git diff --exit-code -- spec ...` (`.github/workflows/ci.yml`). The kit adds only the byte-equality check of its copy against `spec/rules/`.

**Notes:** Criterion 2 stays open: no native backend runs the cases yet, and the kit has no runner for another language (the TypeScript runner is `runFixtures` in `packages/rules/src/conformance.ts`). Open, needing root configuration: the CI diff line does not cover `packages/tck/fixtures`; `pnpm -r generate` does not order the kit after the rules package (the kit has no dependency on it), so the copy can be refreshed from an old `spec/rules/` in the same run, though the kit test then fails; and `.prettierignore` does not list `packages/tck/fixtures/rules/`, whose copied JSON is not in Prettier's format (`prettier --check` reports `rules-1.fixtures.json` and `rules-1.schema.json`).

### PRO-124 Provide the `core-relay` profile

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | M | should | Integrating developer |

**Spec:** 05 §11, §9, §2; 04 §14 · **Requirements:** R6 · **Depends on:** PRO-111, PRO-101

As an integrating developer, I want a profile for relay servers, so that a relay that stores and orders commits is proven to do only that.

**Acceptance criteria**

- [ ] Given a server with `mode` `relay`, when the kit selects profiles, then it runs `core-relay` and not the profiles that need document semantics.
- [ ] Given a commit whose `base` is not the head, when it is submitted to a relay, then it is rejected with `stale_base`.
- [ ] Given commits from a client at the head, when they are submitted, then they are stored and relayed unchanged.
- [ ] Given discovery of a relay, when features are read, then `regions`, `suggest-enforced` and `fields` are absent.

**Notes:** Phase inferred: relay mode has no phase in 11; it is placed with the published kit in phase 4.

### PRO-125 Provide the `authority-service` profile

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | M | should | Integrating developer |

**Spec:** 05 §10, §11 · **Requirements:** R6 · **Depends on:** PRO-103, PRO-104, PRO-105, PRO-106, PRO-107

As an integrating developer, I want a conformance profile for the authority service itself, so that an alternative implementation of the interface can be certified.

**Acceptance criteria**

- [ ] Given the calls of 05 §10, when the profile runs, then it covers `open`, `applyCommit`, `materialise`, `mapRanges`, `restoreSteps`, `diff`, `attribution`, `migrate` and `evaluateRules`.
- [ ] Given the step-semantics, canonical-hash and rules fixtures, when the profile runs them through the service, then every result equals the fixture.
- [ ] Given a service restarted between calls, when the profile repeats a call, then the results are unchanged.
- [ ] Given the reference authority service, when CI runs, then the profile passes.

### PRO-126 Provide the optional fault-injection profile

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | M | could | Operator |

**Spec:** 05 §11; 04 §5; 06 §8 · **Requirements:** R9, R7 · **Depends on:** PRO-111, PRO-108

As an operator, I want a profile that covers what cannot be seen from outside, for servers that expose test hooks, so that durability, fencing and the audit trail are tested too.

**Acceptance criteria**

- [ ] Given a server that exposes test hooks, when the profile runs, then it asserts that no commit is acknowledged before it is stored (a killed process loses no acknowledged commit).
- [ ] Given a hook that fences a room or forces a write conflict, when commits are in flight, then the room stops serving and closes channels with `unavailable`, and no commit is stored twice.
- [ ] Given a hook that rewinds the log, when clients reconnect, then they receive `catchUp: "reload"` for the new incarnation.
- [ ] Given a hook that delays the grants notification, when permissions are revoked, then no commit is stored under the old grants revision.
- [x] Given a server without the hooks, when the kit runs, then the profile is skipped, and the documentation states what is therefore unproven (hash chain, audit trail).

**Evidence:** packages/tck/src/profiles/fault-injection.ts (FAULT_INJECTION, requires the feature `test-hooks`, no scenarios, pending reason) registered in packages/tck/src/profiles/index.ts; packages/tck/test/fault-injection.test.ts ("is skipped, and names the feature, for a server without the hooks", through the same `notApplicable` the runner uses; "states in the README what a server without the hooks leaves unproven", against packages/tck/README.md "What the kit cannot see"); the README row for `fault-injection` is checked by packages/tck/test/readme.test.ts. No live run: no server with hooks exists.

**Notes:** Phase inferred: the kit is published in phase 4; the reference service's own fault tests belong to BE and the phase 1b exit criterion. Lane PRO-113-126, round 3: criteria 1 to 4 stay open. They need a server that exposes the hooks (held writes, fencing, rewind, a delayed grants notification), and none exists; the hook interface and the feature name `test-hooks` are not decided (proposed in docs/adr/0219-lane-PRO-113-126.md).

### PRO-127 Publish the kit

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | M | should | Integrating developer |

**Spec:** 05 §11; 11 §7 · **Requirements:** R6 · **Depends on:** PRO-108, PRO-111, PRO-117, PRO-125

As an integrating developer, I want the conformance kit published with documentation, so that I can certify my own backend without the project's help.

**Acceptance criteria**

- [ ] Given a release, when the kit is published, then it is a signed container image with a documented bootstrap contract and the list of profiles and the features they map to.
- [x] Given the documentation, when a reader follows it for an empty server, then it states the order in which to implement profiles, starting with `core`.
- [ ] Given a protocol or kit change, when a release is cut, then the kit version and the protocol version it tests are both stated in the release notes.
- [ ] Given the published kit, when it runs against the reference service, then every announced profile passes.

**Evidence:** `packages/tck/README.md` (bootstrap inputs, the Containerfile build and run, the profile table with each profile's mode or features, and the implementation order starting with `core`); `packages/tck/test/readme.test.ts` checks the README against the kit's profile list in `packages/tck/src/profiles/index.ts`. The test checks the statement, not a reader following it for an empty server; that walk-through has not been done.

**Notes:** A conformance programme (certification, a registry of certified servers) is not scheduled (11 risk 13). Lane PRO-127-131, round 1: criterion 1 needs a Podman build and a signing key, neither run here. Criterion 3 needs a release process; none exists yet. Criterion 4 needs the reference service running with PostgreSQL and Podman; not run. The order after `core` is a proposal in `docs/adr/0220-lane-PRO-127-131.md`, not an owner decision.

### PRO-128 Decide when to build a second server implementation

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | cond | S | could | Maintainer |

**Spec:** 05 §11; 11 §7; review section 4 · **Requirements:** R6 · **Depends on:** PRO-111

As a maintainer, I want to take the owner's decision on when a second server implementation is built, so that the freeze of protocol 1.0 has a date.

**Acceptance criteria**

- [ ] Given a partner who wants to build a server, when the owner decides, then the decision names the partner, the target tier (05 §9) and the date by which `core` is to pass.
- [ ] Given the decision, when it is recorded, then the roadmap and PRO-129 are updated.
- [ ] Given that no partner has asked by the review at the end of phase 4, when the roadmap is reviewed, then the decision is recorded as "not scheduled" and the freeze of 1.0 stays open.

**Notes:** Condition: a partner wants to build one. Until then the freeze is not scheduled.

### PRO-129 Freeze protocol 1.0 after a second server passes `core`

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | cond | M | should | Maintainer |

**Spec:** 05 §11, §1; ADR 0008 · **Requirements:** R6 · **Depends on:** PRO-128, PRO-111

As a maintainer, I want protocol 1.0 frozen only after an independent server passes `core`, so that the published contract is proven implementable by someone else.

**Acceptance criteria**

- [ ] Given a second implementation not derived from the reference service, when the `core` profile runs against it, then it passes.
- [ ] Given the pass, when 1.0 is frozen, then the artifacts, the registry and the kit are tagged `1.0` and later changes follow the minor-version rules of 05 §1.
- [ ] Given the differences between the two implementations found on the way, when they were ambiguities in the prose, then 05 is amended before the freeze.
- [ ] Given the freeze, when the roadmap is read, then the date and the implementation are recorded.

**Notes:** Condition: PRO-128 yields a date.

## Read restrictions (ADR 0019)

Added on 2026-11-06 from spike S12 (SPK-029; `docs/spikes/2026-11-06-s12-read-restrictions.md`), after the owner decided that version 1 can hide regions and field values from some readers (SPK-005). Every other story that serves content, steps, positions, history, search, exports, comments, presence or field values applies the requester's projection: README §2.2 rule 8.

### PRO-130 Carry the view token and read restrictions in DEP

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Integrating developer |

**Spec:** ADR 0019 (changes 1 to 3); 05 §5.2, §5.4, §6; S6 gaps G101 to G103 · **Requirements:** R3, R6 · **Depends on:** PRO-023, SPK-029

As an integrating developer, I want DEP to say how read restrictions appear on the wire, so that my client or server handles projections without guessing.

**Acceptance criteria**

- [x] Given `ch.opened`, the resume and every content read over REST, then each carries an opaque, keyed view token, and a resume whose token differs from the current one is answered with a reload (G101).
- [x] Given a `steps` commit for a read-restricted reader, then DEP allows empty steps and scopes filtered to the visible ones (G102).
- [x] Given a change of access, when the channel closes, then the close carries a reason distinct from a room move (G103).
- [x] Given a server that supports read restrictions, when a client reads discovery, then a feature name announces it, and the published CDM schema for projections includes the `hidden_region` placeholder.
- [ ] Given the artifacts, when they are generated, then the prose of 05 and the definitions agree on all of the above.

**Evidence:** Server side (`services/document-service/src/data-plane/view.ts`, `room-host.ts`; ADR 0035): ch.opened and content reads carry a keyed token (HMAC-SHA-256 of the class key under the deployment key), a resume whose token is missing or names another class is reloaded (`test/data-plane/sync.test.ts`, `views.test.ts`); a reader of a class that hides a region receives commits with empty steps and no hidden scope (D40); a change of class closes the channel with `cause: "access_changed"` (D41), in `spec/dep` and the generated types. Lane U-PRO-120-131, round 1, criterion 4: discovery announces `read-restrictions` (`services/document-service/src/data-plane/settings.ts`), checked over HTTP on PostgreSQL by `services/document-service/test/postgres/pro-131-perm-read.pg.test.ts` ("announces read restrictions in discovery"); `spec/cdm/cdm-1.schema.json` and `spec/cdm/cdm-1.projection.json` name `hidden_region`.

**Notes:** Taken into packet A1 on 2026-11-06. Criterion 4 is ticked (lane U-PRO-120-131, round 1: the feature name `read-restrictions` is the kit's proposal, ADR 0042 item 4, recorded in docs/adr/0316-lane-U-PRO-120-131.md). Criterion 5 needs the prose of 05 to say what D40 and D41 say. Packet D (2026-11-13): checked again; `docs/spec/05-protocol.md` does not yet mention `access_changed`, the view token of `ch.opened` or empty `steps` for a read-restricted reader (those are in `spec/dep` and the decisions only), so criterion 5 stays open; the spec edit is not in `packages/protocol`.

### PRO-131 Provide the `perm-read` conformance profile

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Integrating developer |

**Spec:** ADR 0019; 05 §11 · **Requirements:** R3, R6 · **Depends on:** PRO-111, PRO-130, SYN-051

As an integrating developer, I want a conformance profile for read restrictions, so that a backend that claims them is tested with the same leak oracle as the reference service.

**Acceptance criteria**

- [ ] Given a backend under test, when the profile runs, then canary strings placed in confidential regions and sensitive values never appear in any message, REST response, asset URL or export delivered to a reader without access.
- [x] Given grant changes during the run, then readers converge to the projection of their current class.
- [ ] Given a reader's commit that touches a placeholder or a hidden value, then the backend refuses it.
- [x] Given a backend that does not announce read restrictions, then the profile is skipped and the report says so.

**Evidence (criterion 1 unticked by the reviewer, V4 group 3 round 2: the export branch is proven below, but the criterion also names asset URLs, and the leak scenario never reads a document asset or its URL; `covers` lists no asset operation and the confidential document has no asset in its region. The export's signed file URL is scanned, which is the export branch, not the asset branch. Reviewer reran the export test: 5 passed, the leak notes read "editor-without-grant: export delivered and scanned" and the same for the viewer):** packages/tck/src/runner.ts with packages/tck/src/profiles/perm-read.ts: against the mock backend the profile is reported as skipped because read-restrictions is not announced (packages/tck/test/mock.test.ts). Lane U-PRO-120-131, round 1: criteria 2 and 3 run against the reference service with read restrictions wired by default (services/document-service/src/server.ts, control-plane/visibility.ts `restrictedViews`) and announced as `read-restrictions` (data-plane/settings.ts). `packages/tck/test/pro-131-perm-read.reference.test.ts` (in memory, Node.js) and `services/document-service/test/postgres/pro-131-perm-read.pg.test.ts` (PostgreSQL in Podman, a database named docedit_u_pro_120_131_<hex> created and dropped by the test) both pass `perm-read.converge` and `perm-read.placeholder`. Lane V-PRO-120-131, round 2, criterion 1 (export branch): `services/document-service/test/postgres/pro-131-perm-read-exports.pg.test.ts` ("PostgreSQL and S3"; PostgreSQL and the shared S3-compatible store, a database named docedit_v_pro_120_131_<hex> dropped by the test, objects removed under the test tenant's prefix) runs `perm-read` with the export worker's real `createExportHandler` (services/export-worker/src/job.ts) in the service process, so `exports` and `read-restrictions` are announced. The leak scenario requests a CDM export as the owner and as both readers without access, follows each job, fetches each delivered signed URL and scans it with the job JSON and the frames; the owner's export carries the region (the canary is real) and the scenario reports `export branch proven`; all four tests pass (`pnpm vitest run`, Node.js with the Podman container CLI, `DOCEDIT_CONTAINER_CGROUPS=disabled` on this machine).

**Notes:** Packet K, 2026-11-06: the profile and its leak oracle are in packages/tck/src/profiles/perm-read.ts; criteria 1 to 3 wait for a server that announces read restrictions (neither the reference service nor the mock does), and the feature name is the kit's proposal read-restrictions until PRO-130 names one (ADR 0042 item 4). Lane U-PRO-120-131, round 1: criterion 1 stays open. The leak scenario passes on the reference service (in memory and on PostgreSQL), but it reads only frames, REST content and regions; the export branch needs the `exports` feature, which the reference service does not announce (the export job handler is not in process, reference.test.ts known defect `exports.states`), and no asset URL is read. Criteria 2 and 3 are ticked (evidence above). The feature name and the default of wiring read restrictions on are proposed in docs/adr/0316-lane-U-PRO-120-131.md, not owner decisions. Lane V-PRO-120-131, round 2: criterion 1 is ticked on the export branch above; the reference process itself (no export handler in process, `exports.states`) still does not deliver exports, so on that process the leak scenario reports `export branch unproven` and passes, and the reader-side export outcome is noted per reader. The kit now sends the owner's export first and waits for it up to 60 s; readers' exports are awaited only when the owner's was delivered, so the scenario does not wait on a queue that is not served. Criterion 5 of PRO-130 is not related to this change. Evidence audit (PRO-127-131, 2026-11-13): criterion 3 is unticked because the `placeholder` scenario only deletes the placeholder atom (it passes on the in-memory and PostgreSQL reference service); no scenario submits a commit that touches a hidden field value, so the "hidden value" half is not exercised.

## Coverage

| Spec section | Stories |
|---|---|
| 05 intro (five parts) | PRO-001, PRO-002, PRO-003 (artifacts for all planes); none: informative otherwise |
| 05 §1 Versioning rules | PRO-005, PRO-006, PRO-007, PRO-117 |
| 05 §2 Discovery | PRO-008, PRO-101 |
| 05 §3.1 User tokens | PRO-009, PRO-010, PRO-011, PRO-014, PRO-015 |
| 05 §3.2 Service credentials | PRO-012, PRO-013 |
| 05 §3.3 Revocation | PRO-016 |
| 05 §4 Real-time plane: framing | PRO-017, PRO-018, PRO-019, PRO-020 |
| 05 §5.1 Session | PRO-021, PRO-022, PRO-014, PRO-016, PRO-018, PRO-019, PRO-024, PRO-037 |
| 05 §5.2 Channels | PRO-023, PRO-024, PRO-025, PRO-026 |
| 05 §5.3 Sync | PRO-027, PRO-028, PRO-029, PRO-030 |
| 05 §5.4 Presence | PRO-031, PRO-112 |
| 05 §5.5 Permissions | PRO-032, PRO-033, PRO-034, PRO-088 |
| 05 §5.6 Notifications | PRO-035, PRO-036 |
| 05 §5.7 Close codes | PRO-037 |
| 05 §5.8 Error registry | PRO-038, PRO-039, PRO-115 |
| 05 §5.9 Example | PRO-110 |
| 05 §6.1 Conventions | PRO-040, PRO-041, PRO-042, PRO-043, PRO-044, PRO-045 |
| 05 §6.2 Resources | PRO-011 (`/tokens`), PRO-046 to PRO-068; `/audit` and `/search`: none: owned by UX (13 §10); resources for fields, workflow, templates and bulk sends: none: owned by FRW |
| 05 §7 Events plane | PRO-069, PRO-070, PRO-071, PRO-072, PRO-073 |
| 05 §8.1 Element (attributes, properties, methods, events) | PRO-074 to PRO-090; fill-mode methods and events: none: owned by FRW |
| 05 §8.2 Host page responsibilities | none: owned by UX (13 §11) |
| 05 §8.3 Backend ports | PRO-091 to PRO-100 |
| 05 §9 Backend tiers | PRO-101, PRO-124 |
| 05 §10 Authority service interface | PRO-102 to PRO-107, PRO-125 |
| 05 §11 Conformance | PRO-108 to PRO-129; the profiles of 12 (`fields`, `perm-fill`, `rules`, `workflow`, `sign`, `seal`): none: owned by FRW |
| 05 §12 Open issues | none: informative; see Open questions |
| ADR 0008 Decision | PRO-001 to PRO-004 (artifacts), PRO-017 to PRO-020 (framing), PRO-040 to PRO-045 (REST), PRO-069 to PRO-071 (webhooks), PRO-090 to PRO-100 (ports), PRO-129 (freeze) |
| ADR 0001 Decision (engine negotiated per channel) | PRO-023, PRO-008 (`engines`), PRO-101 (relay tier) |

Review findings of section 3.4:

| Finding | Stories |
|---|---|
| PR-1 relay and sidecar | PRO-101, PRO-102 to PRO-107 |
| PR-2 engine pinning and canonical form | PRO-110 |
| PR-3 join point | PRO-023, PRO-025, PRO-026 |
| PR-4 acknowledgements and rejections with a head | PRO-027, PRO-028 |
| PR-5 token lifecycle | PRO-009, PRO-010, PRO-013, PRO-014, PRO-016 |
| PR-6 fill and sign in the protocol | none: owned by FRW |
| PR-7 chunking, limits, `sync.reset` | PRO-018, PRO-022, PRO-030 |
| PR-8 to PR-13 error catalogue, `goaway`, `access`, CORS and asset URLs, conformance bootstrap, host lifecycle | PRO-038, PRO-024, PRO-032, PRO-041, PRO-062, PRO-108; host lifecycle: none: owned by UX |
| PR-14 backend ports | PRO-091, PRO-092, PRO-100 |
| PR-15 one vocabulary | PRO-035, PRO-038, PRO-117 |
| PR-16 embedding API | PRO-074 to PRO-090 |
| Section 6 (what remains open) | Open questions below |

## Open questions

The items are the spec's open issues (05 §12), gaps found while writing the criteria, and owner decisions that shape the stories. None is decided inside a criterion.

**Open issues named in 05 §12 (not scheduled)**

1. A fallback transport (server-sent events plus POST) for networks that block WebSockets. The messages are transport-neutral so it can become a binding; revisit when such networks become a common problem (ADR 0008). Affects PRO-017, PRO-019, PRO-093.
2. A REST endpoint for submitting a commit, so the component can use a keep-alive request when a page closes. Affects PRO-027, PRO-083, PRO-094.
3. Whether `access` should be sent as a delta once documents have hundreds of regions. Affects PRO-032, PRO-033, PRO-034.
4. A delegated-authorisation mode in which the document service asks the host backend for region permissions. Affects PRO-052, PRO-101.
5. The `postMessage` variant of the embedding API for iframes. Affects PRO-074 to PRO-090.

**Gaps in the prose that block exact criteria**

6. HTTP status for every code of the registry, and the code and status for a missing `If-Match`. Affects PRO-002, PRO-040, PRO-042, PRO-115.
7. The request and response bodies of `POST /tokens`, the way a service credential is presented, and whether `POST /documents/{id}/imports` needs a service credential (07 §12 lists "Import" under the service credential; 05 §6.2 does not mark the route). Affects PRO-011, PRO-012, PRO-066.
8. How the tenant is identified for discovery and for CORS preflights (neither carries a token), and the purpose of `jwks_uri`. Affects PRO-008, PRO-010, PRO-041.
9. The behaviour for a `docs` claim with more than 20 entries or a role outside the six names, and the precedence between a channel token and the connection token. Affects PRO-009, PRO-014.
10. Whether a revocation naming a document limits the watermark to that document. Affects PRO-016.
11. The payload of `auth.ok`, which is used in the text but absent from the message table of 05 §5.1. Affects PRO-014.
12. How the version is chosen when several are common, and how the `error` before 4406 carries the server's versions. Affects PRO-006, PRO-021, PRO-037.
13. The consequence of a reassembly timeout, and whether `ping` and `pong` may be interleaved with the chunks of one message. Affects PRO-018, PRO-019.
14. What a receiver does with a binary frame on a channel whose engine does not use them. Affects PRO-020.
15. Defaults for `maxMessageBytes` and `maxChannels`. Affects PRO-022.
16. The mapping from fatal error codes to close codes. Affects PRO-037.
17. Which connections receive which `event`, and the mismatch between the three event vocabularies (`document.updated` against `dep.document.changed`; no DOM events for threads, comments or versions although 05 §5.6 says stems are shared). Affects PRO-035, PRO-036, PRO-072, PRO-073, PRO-087.
18. Whether `user.id` and `author.user` are the token `sub` or the per-tenant surrogate, which decides what `resolveUsers` receives. Affects PRO-021, PRO-029, PRO-080.
19. The registry lists `already_open` and `channel_limit` with the surface "socket, REST". Affects PRO-038.
20. Export details: the default for an omitted `seq`, the code for an unsupported target and for a `no-export` refusal, and what `DELETE /exports/{jid}` does to a finished job. Affects PRO-063, PRO-064, PRO-065.
21. The `limit` above 200, the request-identifier header, and the debounce intervals of `de-change`. Affects PRO-040, PRO-044, PRO-087.
22. The throttle rate of `dep.commit.rejected`. Affects PRO-072.
23. The default `mode`, the signatures of `resolveUsers` and `searchPrincipals`, the keys of `config`, and the members of `AuthPort` and `PermissionsPort`. Affects PRO-077, PRO-080, PRO-081, PRO-091, PRO-092.
24. The authority service names calls without signatures (`restoreSteps`, `diff`, `attribution`, `migrate`, `evaluateRules`) and names no transport; the behaviour for an unknown `stateId` is not stated. Affects PRO-102 to PRO-107.
25. How the test-mode switch is kept off in production. Affects PRO-109.
26. Phasing: 05 §8.3 says `backend-dep` and `backend-mock` ship "from the first phase", while 11 lists the mock backend and the port contract tests in 1b and puts no protocol deliverable in the 1a scope; the webhooks of 11 phase 2 against the reference host's "webhooks to e-mail" (13 §11.2). Affects PRO-004, PRO-093, PRO-094, PRO-098, PRO-099, PRO-068.

**Owner decisions (11 §10) that shape these stories**

27. A1 offline-first editing (default no): the local backend (PRO-100) and reconnection (PRO-019) are disconnection tolerance only. If A1 flips, ADR 0001 and every sync story change.
28. Decision 9, the language of the production backend (default Node.js): decides how much of PRO-101 and PRO-102 to PRO-107 is needed early.
29. Decision 10, who invites and authenticates workflow participants (default the host): shapes PRO-015.
30. Decision 5, hiding regions or field values from readers (default no): if yes, `access` (PRO-032), content reads (PRO-049) and presence (PRO-031) change.
31. Decision 13, the page view: sets whether `view="print"` (PRO-079) and the print-view parts of the embedding API are ever built.
