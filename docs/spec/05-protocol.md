# 05 Protocol (DEP/1)

**Status:** draft 0.2, 2026-09-18, revised after the first review ([review](../review/2026-09-18-pitfall-review.md)). Normative.

The Document Editing Protocol is the only contract between the editor component and a backend. It has five parts:

| Part | Carried by | Purpose |
|---|---|---|
| Discovery | One HTTPS document | Tells a client where things are and what the server supports |
| Real-time plane | One multiplexed WebSocket | Sync, presence, live permission and workflow changes, thin notifications |
| Control plane | Stateless REST | Documents, content, grants, history, comments, assets, exports, fields and workflow |
| Events plane | Signed webhooks | Tells the host backend what happened |
| Embedding API | DOM attributes, properties, methods and events | The contract between the host page and `<doc-editor>` |

The reasons for this shape are in [ADR 0008](../adr/0008-protocol-planes-and-encoding.md). Fields, rules and workflow add messages and resources that are defined in [12](12-fields-rules-workflow.md), section 10.

## 1. Versioning rules

1. A protocol version is `MAJOR.MINOR`. This document defines `1.0`. The major version is also in the WebSocket subprotocol name and in the REST base path.
2. A minor version only adds: new optional fields, new message types, new resources, new event types, new feature names.
3. Receivers MUST ignore fields they do not know. A receiver that gets an unknown message type MUST ignore it, and if the message carries an `id` it MUST reply with `error` code `unknown_type`, `fatal: false`.
4. Optional behaviour is announced by feature names in discovery and in `welcome`. A client MUST NOT use a feature the server did not announce. Protocol features and CDM features (03, section 11) share one namespace.
5. Experimental features and message types use names that start with `x-`.
6. A feature or field is deprecated for at least twelve months before a major version removes it. REST responses for deprecated resources carry `Deprecation` and `Sunset` headers.
7. No message type, field or resource becomes final without a scenario in the conformance kit.

## 2. Discovery

`GET {endpoint}/.well-known/dep` returns:

```json
{
  "versions": ["1.0"],
  "ws": "wss://docs.example.com/dep",
  "rest": "https://docs.example.com/v1",
  "engines": ["pm-steps/1"],
  "cdm": { "min": 1, "max": 1 },
  "features": ["presence", "regions", "suggest-enforced", "history", "comments", "assets", "exports", "leases", "fields", "read-restrictions"],
  "mode": "authority",
  "jwks_uri": "https://docs.example.com/.well-known/jwks.json"
}
```

`rest` is the complete base URL. Resource paths in this document and in notifications are relative to it. `mode` is `authority` or `relay` (04, section 14); a relay never announces `regions`, `suggest-enforced` or `fields`.

`read-restrictions` says that the server hides content from readers by projection (ADR 0019, proposed): the view token of section 5.2, the empty `steps` of section 5.3 and the `access_changed` cause of `ch.closed` apply only to a server that announces it. The name is a proposal of the conformance kit (ADR 0042, item 4), not yet a decision of the owner. The CDM schema for projections, `spec/cdm/cdm-1.projection.json`, adds the `hidden_region` placeholder node, which stands where a reader may not see a region.

`test-hooks` says that the server exposes fault-injection hooks for the conformance kit (section 11). A server announces it only while its test-mode switch is on, and never in production. The hooks are not part of the protocol: their routes are the server's own, and the kit's profile states the ones it uses (ADR 0398).

## 3. Authentication

### 3.1 User tokens

A client presents a JSON Web Token. Two issuers are supported:

- **Host-signed (recommended).** The host backend signs tokens with its own key. The document service verifies them against the key set registered for the tenant.
- **Service-minted.** The host backend calls `POST /tokens` with its service credential and passes the returned token to the page. A conforming server MUST offer this, because the conformance kit depends on it.

| Claim | Meaning |
|---|---|
| `iss`, `aud`, `iat`, `exp`, `jti` | Standard. `aud` MUST equal the document service's identifier exactly. `exp` MUST be at most 15 minutes after `iat`. Verifiers allow 60 seconds of clock skew |
| `tid` | Tenant identifier |
| `sub` | Opaque, stable user identifier. Hosts SHOULD NOT use e-mail addresses. The service stores a per-tenant surrogate for it (08, section 13) |
| `name` | Optional display name. The component prefers the host's `resolveUsers` callback |
| `grp` | Optional array of group identifiers the user belongs to |
| `docs` | Object mapping document identifiers (at most 20) to the user's role in each: `viewer`, `commenter`, `suggester`, `editor`, `owner`, `filler` |
| `wfp`, `amr`, `auth_time` | For workflow participants (12, section 7) |
| `wfr` | Optional array of role placeholder identifiers (12, section 3.1) that the user may fill outside a workflow, in the documents named by `docs` (12, section 13, "Form mode without a workflow"). The claim name is configurable per tenant; `wfr` is the default (owner decision 5a of 2026-11-15) |
| `access_since` | Optional. The time the host first gave this user access, for the history visibility setting `since_access` |
| `restrict` | Optional array of `no-export`, `no-copy`, `no-print` |

Verification rules:

- The key set is selected by `tid` from the tenant's registration, never from a URL inside the token. Only asymmetric algorithms on an allow-list (ES256, EdDSA, RS256) are accepted.
- Tokens are sent in the `hello` message and in the `Authorization: Bearer` header. They MUST NOT be placed in URLs.
- A token supplied in `ch.open` or `auth.refresh` MUST carry the same `tid` and `sub` as the session. If the roles in a refreshed token differ, the server recomputes access and sends `perm.changed`.

Region grants are not in the token. They are stored by the document service and looked up by `sub` and `grp`, so they can change without a new token. See 07.

### 3.2 Service credentials

Host backends call the control plane with a service credential: an API key, or a JWT with the type header `dep-svc+jwt`, signed with keys that are registered separately from user-token keys. A user token can never become a service credential through a claim. A service call that acts for a user names that user in the `DEP-Actor` header, and history attributes the change to them.

### 3.2.1 Agent tokens

An assistant acts for a user under an agent identity (13 section 6.2; ADR 0234 part A). The server learns that a connection is an agent's only from its verified credential, never from the client's `origin` hint (04 section 2).

- The document service keeps an agent registry per tenant: an agent identifier (`agt`), a display name, the owning host and the documents it may act on. A service credential registers an agent with `POST /agents` (a route that joins the table in 6.2 when it is added to the protocol definition). A user token cannot register an agent or become one.
- An **agent token** is a short-lived JWT with the type header `dep-agent+jwt`, signed with keys registered separately from user-token keys. Its claims are `sub` (the user the assistant acts for), `agt`, `act` (`{ "sub": "<agt>" }`, the actor claim in the manner of RFC 8693), `tid`, `doc`, `aud` and a short `exp`.
- Only the service mints an agent token (`POST /tokens` with a service credential, or a host signing key registered as an agent issuer). A browser never signs one.
- A host backend that calls the control plane for an agent sends `DEP-Agent: <agt>` with its service credential and `DEP-Actor`. The service honours `DEP-Agent` only when that agent is registered to the same credential and the document is in its list. A user token cannot set it.
- `author.agent` on a stored commit is the `agt` of the verified token, and `origin` is `assistant`. A commit on a user connection that claims `origin: "assistant"` is stored as an ordinary commit with the hint recorded as a claim.
- Disabling an agent changes `rev`, so it loses access at once.

### 3.3 Revocation

Grant changes take effect immediately (section 5.5). To end a user's access before the token expires, the host backend calls `POST /sessions/revoke` with the `sub` and optionally a document. The service records a watermark: tokens for that user issued before it are refused on both planes, so a revoked client cannot simply reconnect. The room closes that user's channels.

## 4. Real-time plane: framing

- The client connects to `ws` with the subprotocol `dep.v1`. The `Origin` header is checked against the tenant's allowed origins when `hello` arrives, which is when the tenant is known.
- Each text frame is one JSON object, the **envelope**:

| Field | Type | Meaning |
|---|---|---|
| `t` | string, required | Message type |
| `id` | string | Set by the sender on a message that expects a reply |
| `re` | string | The `id` this message replies to. Required on every reply |
| `ch` | integer | Channel number, on every channel-scoped message including `ch.open` |
| `d` | object | Payload |

- Binary frames are reserved for engines with opaque payloads. Their layout is three unsigned LEB128 integers (`ch`, `kind`, `id`) followed by the payload. `pm-steps/1` does not use them.
- Messages on one channel are delivered in order. There is no ordering guarantee between channels.
- **Chunking** is part of the core protocol. A message whose UTF-8 size exceeds `maxMessageBytes` is sent as `chunk` messages: `of` is a fresh identifier, `i` and `n` are the index and count, and `part` is a substring of the serialised message, split only between Unicode code points. Chunks of one message are sent consecutively on the connection. Reassembly times out after 10 seconds.
- Either side sends `ping` when it has sent nothing for `heartbeatMs` (25,000 until `welcome` says otherwise). The peer answers `pong`. Any received message resets the idle timer. A side that hears nothing for two intervals closes the connection with a close frame, code 1001 (going away), and ends the socket if the peer does not finish the closing handshake (owner decision 194).
- Compression (`permessage-deflate`) is optional and off by default.
- At most one channel per document may be open on a connection.

Reconnection uses exponential backoff from 0.5 seconds, doubling to a maximum of 30 seconds, with full jitter. After `goaway` the client follows the server's hint instead. The client closes the socket on `pagehide` so that the page can use the browser's back/forward cache.

## 5. Real-time plane: messages

Direction: C is client, S is server.

### 5.1 Session

| Type | Dir | Payload | Notes |
|---|---|---|---|
| `hello` | C to S | `versions`, `token`, `client` (`name`, `version`), `engines`, `cdm` (`min`, `max`), `features`, optional `traceparent` | Must be the first message, within 10 seconds |
| `welcome` | S to C | `version`, `session`, `user` (`id`, `name`), `features`, `limits`, `tokenExp` | `limits` lists every limit a client must respect: `maxMessageBytes`, `maxCommitBytes`, `maxStepsPerCommit`, `maxRebaseSteps`, `maxChannels`, `heartbeatMs`, `ackTimeoutMs`, `presenceHz`, `presenceBytes`, `catchUpCommits`, `catchUpBytes` |
| `auth.expiring` | S to C | `inMs` | Sent about 60 seconds before `tokenExp` |
| `auth.refresh` | C to S | `token`, optional `ch` for a channel token | Reply is `auth.ok` with the new `tokenExp`, or `error` |
| `auth.ok` | S to C | `tokenExp` | Reply to `auth.refresh` |
| `auth.revoked` | S to C | `reason` | Followed by close code 4401 |
| `ping`, `pong` | both | none | |
| `goaway` | S to C | `reconnectInMs`, `reason` | The whole connection is draining. It is never used for a single channel |
| `error` | both | `code`, `message`, `retryable`, `retryAfterMs`, `fatal` | With `re` when it answers a message. A fatal error is followed by the matching close code |
| `chunk` | both | `of`, `i`, `n`, `part` | Section 4 |

There is no session resumption: a new connection is a new session.

### 5.2 Channels

| Type | Dir | Payload | Notes |
|---|---|---|---|
| `ch.open` | C to S | `kind: "doc"`, `doc`, `engine`, `cdm` (the version the client will use), `features`, optional `resume` (`seq`, `incarnation`, `inflight`, optional `view`), optional `token` | Without `resume` the server answers with `catchUp: "reload"`. `resume.view` is the view token of the `ch.opened` or content read that the confirmed document came from. A channel `token` whose user has been revoked is answered with a non-fatal `error` of code `revoked`, not a `ch.rejected` (ADR 0379, proposed) |
| `ch.opened` | S to C | `head`, `incarnation`, `catchUp` (`stream` or `reload`; `page` stays in the schema and a server does not send it, owner decision 202), `inflight` (`accepted` with `seq`, or `unknown`), `access` (section 5.5), optional `workflow` (12), optional `view` | `view` is the view token (below). `head` is the durable head at the moment the channel is attached. The first live commit the client receives is `head + 1` |
| `ch.rejected` | S to C | `code`, `message` | Codes: `not_found`, `forbidden`, `unsupported_engine`, `unsupported_cdm`, `unsupported_feature`, `channel_limit`, `already_open`, `unavailable` |
| `ch.close` | C to S | none | |
| `ch.closed` | S to C | `code`, `reason`, optional `retryInMs`, optional `cause` | For example `forbidden` after revocation, `unavailable` when the room moves or is fenced, `slow_consumer`. `cause` is an open vocabulary: `access_changed` (what the reader may see changed; the client reopens at once without `resume`, and its unconfirmed work goes to recovered edits), `fenced`, `lost` and `stopped` (a room stopped serving; the client backs off and resumes as for `unavailable`). `code` stays `unavailable` in every case, so a client that ignores `cause` still recovers |

**Joining.** A client fetches content over REST at some `seq`, then opens the channel with `resume.seq` set to it. With `catchUp: "stream"` the server sends every commit from `resume.seq + 1` to `head`, then `sync.caughtUp`, then live commits; attaching and streaming are atomic. A resume beyond 5,000 commits or 5 MiB, below the user's visibility gate (07, section 8), across a snapshot commit, or with another incarnation gets `catchUp: "reload"` (owner decisions 166 and 202). With `catchUp: "reload"` the client MUST fetch `GET /documents/{id}/content?seq={head}` (a pinned read, which can never be stale) and then expects `head + 1`.

**View token.** A server that announces `read-restrictions` gives every `ch.opened` and every content read (`GET /documents/{id}/content`, pinned or not) a `view`: an opaque string, keyed by the server, that names the visibility class of the reader (the projection this reader gets). A client keeps the `view` of its latest `ch.opened` or content read and sends it as `resume.view`. A resume whose `view` is missing or differs from the current one is answered with `catchUp: "reload"`. A server without read restrictions may omit `view` and ignores it in a resume. A client never reads meaning into the string.

### 5.3 Sync (engine `pm-steps/1`)

Semantics are defined in [04 Sync engine](04-sync-engine.md).

| Type | Dir | Payload |
|---|---|---|
| `sync.submit` | C to S | `id`, `base`, `steps`, optional `origin` |
| `sync.ack` | S to C | `id` (the commit), `seq`, `serverTime`, `rebased`, and `steps` when `rebased` is true. `re` is the envelope `id` of the submit. An acknowledgement rebuilt for a duplicate always carries `steps` |
| `sync.reject` | S to C | `id`, `code`, `message`, `action` (`rebase`, `drop`, `reload`, `retry`), `head`, optional `scopes`, optional `rule`, optional `retryAfterMs` |
| `sync.commit` | S to C | `commits`: array in ascending `seq` of `{ seq, kind, id, steps, control, author: { user, session, agent }, serverTime, origin }`. `kind` is `steps` or `control`; `session` is null for server-authored commits |
| `sync.caughtUp` | S to C | `seq` |
| `sync.reset` | S to C | `seq`, `reason` (`import`, `restore`, `migration`, `repair`). A snapshot commit was stored; the client reloads content at `seq` |
| `sync.check` | S to C | `seq`, `hash` |

**Read-restricted readers.** For a reader whose projection hides content, `steps` in `sync.commit` and in `sync.ack` are the steps of the reader's class and may be empty: the commit changed only content the reader cannot see, and the client still advances its `seq`. `sync.ack` to such a reader always has `rebased: true`. `sync.commit` names no scopes, and `scopes` in `sync.reject` name only scopes the reader can see, so a hidden region or field value is never named.

Scope identifiers, used in `scopes` and in `access`: `doc` (the top level of the tree), `body` (the body root), `region:<id>`, `defs`, `story:<id>`, `field:<id>`.

### 5.4 Presence

| Type | Dir | Payload |
|---|---|---|
| `presence.update` | C to S | `seq`, `state`: `{ selection: { anchor, head }, scope, status }` where `status` is `active` or `idle`. Positions refer to the confirmed document at `seq` |
| `presence.state` | S to C | `peers`: array of `{ session, user: { id, name }, seq, state }`, and `left`: array of sessions |

The server adds identity; clients cannot claim to be someone else. `state` is validated against its schema and the `presenceBytes` limit. The server MAY drop or coalesce presence under load.

### 5.5 Permissions

`access`, sent in `ch.opened` and in `perm.changed`:

```json
{
  "rev": 31,
  "asOfSeq": 416,
  "docRole": "viewer",
  "caps": ["view"],
  "scopes": {
    "body": ["view"],
    "defs": ["view"],
    "region:rG7mK2pQ9xYt4HcD": ["view", "comment", "suggest", "edit"]
  },
  "leases": { "region:rG7mK2pQ9xYt4HcD": { "holder": "u_481", "expiresAt": "2026-09-18T10:42:00.000Z" } },
  "fill": null,
  "restrictions": []
}
```

- `rev` is the access revision of this connection. It increases whenever anything that feeds effective permissions changes: grants, region states, leases, the region list, the document's state, the workflow, a refreshed token.
- `caps` are the document-level capabilities, including `structure` and `manage`.
- `scopes` lists every region of the document. A region that is not listed, for example one created by a commit the client has just received, is not editable until an `access` with `asOfSeq` at or after that commit arrives.
- `perm.changed` (S to C) carries a complete new `access` object. The server enforces the new permissions from the moment it computes them, regardless of when the client receives the message.

### 5.6 Notifications

`event` (S to C) has `type`, `resource`, optional `rev` and optional small `data`. It means "this changed; fetch it over REST if you care". Thread events carry the thread's current range and the `seq` it refers to.

Types: `thread.created`, `thread.updated`, `thread.resolved`, `thread.reopened`, `thread.deleted`, `comment.created`, `comment.updated`, `comment.deleted`, `version.created`, `version.restored`, `export.progress`, `export.completed`, `export.failed`, `export.cancelled`, `import.completed`, `import.failed`, `asset.ready`, `asset.failed`, `document.updated`.

The same stems are used for webhooks (`dep.` prefix, section 7) and for DOM events (`de-` prefix, section 8).

### 5.7 Close codes

| Code | Meaning |
|---|---|
| 4400 | Malformed message |
| 4401 | Unauthenticated, token expired or revoked |
| 4403 | Forbidden, including a disallowed origin |
| 4406 | No common protocol version. The preceding `error` lists the server's versions |
| 4408 | `hello` not received in time |
| 4413 | Message too large |
| 4429 | Rate limited |
| 4500 | Internal error |
| 4503 | Unavailable or draining |

### 5.8 Error registry

One registry covers every surface. REST problems use the same codes in their `code` member.

| Code | Surfaces | Retryable | Client action |
|---|---|---|---|
| `bad_message`, `unknown_type` | socket | no | Report a bug |
| `unauthenticated`, `token_expired`, `revoked` | socket, REST | after a new token | Call `getToken`; raise `de-auth-required` if it fails |
| `forbidden` | all | no | Show as no access |
| `unsupported_version`, `unsupported_engine`, `unsupported_cdm`, `unsupported_feature` | socket | no | Tell the user the component must be updated |
| `not_found`, `already_open`, `channel_limit` | socket, REST | no | |
| `stale_base`, `rebase_failed` | sync | yes, after catching up | 04, section 8 |
| `permission_denied`, `read_only` | sync | no | Drop and explain |
| `invalid_op` | sync | no | Drop, or reload when told to |
| `conflict`, `field_invalid` | sync, REST | no | 12 |
| `busy` | sync | yes | Resubmit after the pending answer |
| `too_large` | all | no | Split or report |
| `rate_limited`, `quota_exceeded` | all | yes, after `retryAfterMs` or `Retry-After` | Back off; tell the user for quotas |
| `slow_consumer` | channel close | yes | Resume |
| `precondition_failed`, `validation_failed`, `pending_suggestions`, `workflow_active`, `idempotency_mismatch` | REST | no | Fix the request |
| `unavailable`, `internal` | all | yes | Back off |

### 5.9 Example

```
C  {"t":"hello","id":"1","d":{"versions":["1.0"],"token":"…","engines":["pm-steps/1"],"cdm":{"min":1,"max":1},"features":["presence","fields"]}}
S  {"t":"welcome","re":"1","d":{"version":"1.0","session":"0192f4b0-…","limits":{"maxMessageBytes":131072,"heartbeatMs":25000,"ackTimeoutMs":15000},"tokenExp":"…"}}
C  {"t":"ch.open","id":"2","ch":1,"d":{"kind":"doc","doc":"0192f0…","engine":"pm-steps/1","cdm":1,"resume":{"seq":412,"incarnation":"0192aa…"}}}
S  {"t":"ch.opened","re":"2","ch":1,"d":{"head":415,"incarnation":"0192aa…","catchUp":"stream","access":{"rev":30,"asOfSeq":415,"docRole":"viewer","caps":["view"],"scopes":{"body":["view"],"region:rG7…":["view","comment","suggest","edit"]}}}}
S  {"t":"sync.commit","ch":1,"d":{"commits":[{"seq":413,…},{"seq":414,…},{"seq":415,…}]}}
S  {"t":"sync.caughtUp","ch":1,"d":{"seq":415}}
C  {"t":"sync.submit","id":"3","ch":1,"d":{"id":"0192f0c4-…","base":415,"steps":[…],"origin":"input"}}
S  {"t":"sync.ack","re":"3","ch":1,"d":{"id":"0192f0c4-…","seq":416,"serverTime":"…","rebased":false}}
S  {"t":"sync.commit","ch":1,"d":{"commits":[{"seq":417,"kind":"control","control":{"type":"grants","rev":9},…}]}}
S  {"t":"perm.changed","ch":1,"d":{"rev":31,"asOfSeq":417,"docRole":"viewer","caps":["view"],"scopes":{"body":["view"],"region:rG7…":["view"]}}}
C  {"t":"sync.submit","id":"4","ch":1,"d":{"id":"0192f0c5-…","base":416,"steps":[…]}}
S  {"t":"sync.reject","re":"4","ch":1,"d":{"id":"0192f0c5-…","code":"permission_denied","action":"drop","head":417,"scopes":["region:rG7…"],"message":"No edit permission"}}
S  {"t":"event","ch":1,"d":{"type":"export.completed","resource":"/exports/0192f1…"}}
```

## 6. Control plane

### 6.1 Conventions

- JSON bodies. Errors use RFC 9457 problem details with a `code` from section 5.8.
- **Browsers.** The service answers CORS preflights for the tenant's allowed origins, allows the headers `Authorization`, `Content-Type`, `If-Match`, `Idempotency-Key`, `DEP-Actor` and `traceparent`, and exposes `ETag`, `Retry-After`, `Deprecation` and `Sunset`. The conformance kit asserts these headers.
- **Concurrency.** Every mutable resource has an `ETag`, and updates require `If-Match`.
- **Idempotency.** `POST` requests that create something, and `PUT /documents/{id}/content`, accept an `Idempotency-Key`. A key is scoped to the tenant, the caller, the route and a hash of the body, and is remembered for 24 hours. The same key with a different body is `idempotency_mismatch`.
- **Lists** are `{ items, nextCursor }` with an opaque `cursor` and a `limit` of at most 200.
- **Tracing.** Requests may carry `traceparent`; responses carry a request identifier.
- **Identifiers in paths.** A resource addressed by a bare identifier (`/threads/{tid}`, `/exports/{jid}`, `/assets/{aid}`) is always resolved to its document, and the caller's token must cover that document. A caller whose token does not cover that document, and a user who may not see the resource (another user's export or import job), gets `not_found`, the answer for an identifier that names nothing, with the same body apart from the identifier (owner decision 57 of 2026-11-15; SEC-016). A caller who sees the resource but lacks the capability gets `forbidden`.

Callers are end users (every request is checked against that user's permissions) and host backends (service credential). The authorisation matrix in 07, section 12, lists the capability each resource needs.

### 6.2 Resources

| Resource | Methods | Notes |
|---|---|---|
| `/tokens` | POST | Service credential only |
| `/documents` | GET, POST | Service credential only. POST creates a document, optionally from CDM content, a template (12) or an import, with optional `externalId` and `properties`. GET lists and filters by `externalId`; the editor never lists documents |
| `/documents/{id}` | GET, PATCH, DELETE | Metadata, `properties`, classification label, `state` (`active`, `locked`, `archived`). DELETE is a soft delete; purge follows the retention policy |
| `/documents/{id}/content` | GET, PUT | GET returns `{ seq, incarnation, cdm, requires, doc }` and, under read restrictions, `view`, with `?seq=N` for a pinned, immutable, cacheable read; the `ETag` combines incarnation, `seq` and the view token. Pinned reads are `Cache-Control: private` and immutable for a year, reads at the head `private, no-cache`. PUT (service credential) replaces content as a snapshot commit with origin `import` |
| `/documents/{id}/commits` | GET | `after`, `limit`. Paged catch-up. Subject to history visibility (07, section 8) |
| `/documents/{id}/regions` | GET | Derived list: identifier, title, policy, order, state, who can edit |
| `/documents/{id}/regions/{rid}/state` | PUT | `draft`, `in_review`, `approved`. Needs `manage` |
| `/documents/{id}/regions/{rid}/lease` | POST, PUT, DELETE | Optional exclusive-edit lease with heartbeat. Feature `leases` |
| `/documents/{id}/grants` | GET, PATCH | Region grants. The response to PATCH carries the new grants revision, and once it has returned, no commit can be stored under the old revision (04, G7) |
| `/sessions/revoke` | POST | Service credential only. Section 3.3 |
| `/documents/{id}/history` | GET | Grouped commits. Filters: `region`, `field`, `user`, `fromSeq`, `toSeq`, `namedOnly` |
| `/documents/{id}/versions` | GET, POST | Named versions. POST body: `seq` (default head), `name`, `note` |
| `/documents/{id}/diff` | GET | `fromSeq`, `toSeq`, optional `region`, `granularity` (`word`, `char`) |
| `/documents/{id}/attribution` | GET | Who wrote which spans, for a region or a block range |
| `/documents/{id}/restore` | POST | `toSeq`, optional `region`, optional `dryRun` |
| `/documents/{id}/fork` | POST | Service credential only. `atSeq`, whether grants are copied. The component raises `de-fork-request` so the host can call it |
| `/documents/{id}/read-marker` | PUT | Records the caller's last seen `seq`. It can only move forward |
| `/documents/{id}/activity` | GET | Changes and comment activity by other people since the caller's read marker |
| `/documents/{id}/connect` | GET | Stage 2 (06 section 2.1). The WebSocket URL of the node that owns the document, or of the node routing would choose when it has none: `{ url, node, source }`. `source` is `owner`, `routing` or `entry` (the service's own address, when the node announces none). A hint only: it grants nothing, and a channel that lands elsewhere is forwarded. Needs `view` |
| `/documents/{id}/threads` | GET, POST | POST body: `target` (`{ range: { from, to, baseSeq } }` or `{ block: id }`) and the first comment. `baseSeq` must be within the rebase window. The room maps the range to the head and checks `comment` there. GET accepts `?seq` |
| `/threads/{tid}` | GET, PATCH, DELETE | PATCH `state` (`open`, `resolved`), `assignee` |
| `/threads/{tid}/comments` | POST | Body may contain mentions (13, section 5) |
| `/comments/{cid}` | PATCH, DELETE | Author only, or `manage` |
| `/documents/{id}/assets` | POST | Body: `filename`, `mime`, `size`. Returns an asset identifier and a size-bound pre-signed upload into a quarantine area |
| `/assets/{aid}/complete` | POST | The asset worker validates, re-encodes, hashes and stores the asset, then raises `asset.ready` or `asset.failed` |
| `/documents/{id}/assets/resolve` | POST | Body: asset identifiers used by the document, and the caller's own ready uploads for it that no commit references yet (decision 198). Returns short-lived signed URLs, because an `<img>` cannot send a bearer token |
| `/documents/{id}/exports` | POST | Body: `target` (`pdf`, `tex`, `docx`, `cdm`, `html`, `md`), optional `seq`, `options` (09, section 9.1). Returns `202` with a job. `pending_suggestions` when the document has unresolved suggestions and `options.suggestions` is absent. Refused for callers restricted with `no-export` |
| `/exports/{jid}` | GET, DELETE | State (`queued`, `converting`, `compiling`, `completed`, `failed`, `cancelled`), progress, result, diagnostics |
| `/documents/{id}/imports` | POST | Body: `asset`, `format` (`docx`). Returns a job with warnings on completion |
| `/imports/{jid}` | GET | |
| `/fonts` | GET | Font manifest: families, styles, file URLs, hashes, licences, manifest version. Tenant-wide: every user of the tenant may read it, with no document in view (decision 95) |
| `/webhooks`, `/webhooks/{id}` | GET, POST, PATCH, DELETE | Service credential only. Event filters and secret rotation |
| `/webhooks/{id}/ping` | POST | Service credential only. A test delivery to one subscription, marked as a test; answers 202 with its `deliveryId` (UX-079; decision 177) |
| `/webhooks/{id}/deliveries/{deliveryId}/replay` | POST | Service credential only. Sends a recent delivery of that subscription again under its own `webhook-id`; answers 202 (UX-079; decision 177) |
| `/audit`, `/search` | GET | Service credential only. 13, section 10 |
| `/retention` | GET, PUT | Service credential only. The tenant retention policy; `keep_all` when none is set. PUT is audited. 08, section 11; 13, section 10 |
| `/documents/{id}/retention` | GET, PUT | Service credential only. The document's own policy, the effective policy and its source. PUT is audited. 08, section 11; 13, section 10 |
| `/documents/{id}/retention` | GET, PUT | Service credential only. The document's retention policy and the effective policy that applies to it. 08, section 11 |
| `/holds` | GET | Service credential only. The tenant's legal holds, one page at a time. 08, section 11; 13, section 10 |
| `/documents/{id}/holds` | POST | Service credential only. Places a legal hold on a document with a reason; audited. 08, section 11; 13, section 10 |
| `/users/erase` | POST | Service credential only. Erases a person: deletes their mapping row, display name and read markers, and changes nothing in the log; audited. The `sub` is in the body, never in the path. A person in a document under legal hold is erased after the hold is released (owner decision 38). An unknown `sub` is `not_found`. 08, section 13; 13, section 10 |
| `/documents/{id}/commits/{seq}/tombstone` | POST | Service credential only. Replaces the payload of one commit with a tombstone: the metadata row, the payload hash and the hash chain stay. Refused with `conflict` under a legal hold, when the payload is already removed and while no checkpoint covers the commit. Audited with the actor and the reason. The answer lists the checkpoints and cold segments that may still hold the removed text, and the attribution map. A read, comparison or rebuild that needs the payload is `not_found`. 08, section 13; 13, section 10 |
| `/origins` | GET, POST | Service credential only. GET lists the origins the tenant allows. POST allows one origin (`{ origin }`, normalised) and is audited. 05, section 4; 13, section 10 |
| `/origins/{origin}` | DELETE | Service credential only. Removes an allowed origin (percent-encoded in the path); audited. 05, section 4; 13, section 10 |
| `/keys` | GET, POST | Service credential only. GET lists the public keys registered for the tenant, user keys then service keys. POST registers one public key (ES256, EdDSA or RS256 only; a private or symmetric key is refused) and is audited. 05, section 3.2; 13, section 10 |
| `/keys/{kid}` | DELETE | Service credential only. Removes a key; tokens it signed are refused at once; audited. 05, section 3.2; 13, section 10 |
| `/quotas` | GET, PUT | Service credential only. The tenant's quota values, null when unset; PUT names the dimensions to set, takes `If-Match`, and is audited. 06, section 12; 13, section 10 |

Resources for fields, workflow, templates and bulk sends are listed in 12, section 10. Administration resources are outlined in 13, section 10.

## 7. Events plane

- Webhook bodies are CloudEvents 1.0 in structured JSON mode. `type` is the event name with a version suffix, for example `dep.export.completed.v1`. `subject` is the document identifier. `data` is small and includes `seq`, and for content changes the hash-chain head, so a host can anchor it independently.
- Requests are signed as described by the Standard Webhooks specification: headers `webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256, a five-minute tolerance, two active secrets during rotation.
- Delivery is at least once with exponential retry for up to 24 hours. Receivers deduplicate on `webhook-id`. Order is not guaranteed.
- Webhook targets are reached through an egress proxy that refuses private and link-local addresses.

| Event | When |
|---|---|
| `dep.document.created`, `dep.document.deleted`, `dep.document.state_changed` | |
| `dep.document.changed` | Content changed. Debounced to at most once per 10 seconds per document |
| `dep.version.created`, `dep.version.restored` | |
| `dep.grants.changed`, `dep.region.state_changed` | |
| `dep.session.joined`, `dep.session.left` | |
| `dep.thread.created`, `dep.thread.resolved`, `dep.thread.reopened`, `dep.thread.deleted`, `dep.comment.created`, `dep.comment.mentioned`, `dep.task.assigned` | |
| `dep.export.completed`, `dep.export.failed`, `dep.import.completed`, `dep.import.failed` | |
| `dep.commit.rejected` | A commit was rejected with `permission_denied` or `invalid_op`. Throttled. Useful for security monitoring |
| `dep.workflow.sent`, `dep.workflow.participant_activated`, `dep.workflow.participant_viewed`, `dep.workflow.field_completed`, `dep.workflow.participant_completed`, `dep.workflow.participant_declined`, `dep.workflow.auth_failed`, `dep.workflow.reminder_due`, `dep.workflow.corrected`, `dep.workflow.voided`, `dep.workflow.expired`, `dep.workflow.completed`, `dep.workflow.finalised` | Workflow events (12 §6.3, §10). `data` has the workflow and document identifiers, the `seq` of the control commit and the chain head, and for an event about one person that participant's identifier. It holds no contact detail and no evidence: the host sends every message |

## 8. Embedding API

The embedding API has its own version, exposed as the static property `DocEditorElement.version`.

### 8.1 Element

```html
<doc-editor doc-id="0192f0…" endpoint="https://docs.example.com" mode="edit"></doc-editor>
```

| Attribute | Values | Notes |
|---|---|---|
| `doc-id` | document identifier | Changing it loads another document |
| `endpoint` | URL | Base URL for discovery. Ignored when `backend` is set |
| `mode` | `edit`, `review`, `view`, `fill` | `review` starts in suggestion mode. The server's permissions still apply |
| `view` | `print`, `web`, `read` | Page view, continuous web layout, or reading layout |
| `locale` | BCP 47 tag | |
| `theme` | `light`, `dark`, `auto` | |
| `toolbar` | `full`, `compact`, `none` | With `none`, a host builds its own from `queryCommand` and `exec` |
| `keep-alive` | boolean | Keeps a disconnected element alive (02, section 2.1) |

| Property | Type | Notes |
|---|---|---|
| `getToken` | `(ctx: { docId }) => Promise<string>` | Called at start and on `auth.expiring`. Loading starts only when a document identifier and a token source (or a `backend`) are both present, so the order in which a framework sets them does not matter |
| `backend` | `Backend` | Replaces the DEP client with any implementation of the ports in 8.3 |
| `config` | object | Feature switches, fonts, shortcuts, limits, a style nonce |
| `searchPrincipals`, `resolveUsers` | callbacks | The host's directory, for grants, mentions, presence and history |
| `extensions` | array | Host-registered extensions (13, section 7) |
| `icons` | object | Replacement icons by the command's icon name (13, section 8; UX-063). A value is SVG path data, or `{ paths, viewBox?, fill? }`. Never markup. A name the host omits, or gives as anything else, keeps the built-in drawing |

| Method | Notes |
|---|---|
| `load(docId?)` | |
| `flush({ timeoutMs }): Promise<void>` | Resolves when nothing is unconfirmed; rejects at the timeout |
| `getContent(): Promise<{ seq, cdm, doc }>` | |
| `getSelectionContent()`, `insertContent(fragment)` | CDM fragments. Insertions pass through the same guards as typing |
| `exec(command, args?)`, `queryCommand(command)` | Run a command; ask whether it is enabled and active |
| `requestExport(options): Promise<{ jobId }>`, `print()` | `print()` prints the typeset PDF |
| `focus()`, `destroy()` | |

All events are `CustomEvent`s with `bubbles: true` and `composed: true`. They carry identifiers and counts, never document content.

| Event | `detail` |
|---|---|
| `de-ready` | `{ docId, seq }` |
| `de-status` | `{ connection: "online" \| "reconnecting" \| "offline", sync: "saved" \| "saving" \| "unsaved" \| "readonly" }` |
| `de-change` | `{ seq }`, debounced |
| `de-selection`, `de-command-state` | `{ scope, blockId }`; the commands whose state changed |
| `de-permission-change` | The `access` object |
| `de-recovered-edits` | `{ count }` when rejected or unsent content was set aside |
| `de-export-progress`, `de-export-completed`, `de-export-failed` | Job state |
| `de-auth-required` | `getToken` failed or the token was refused |
| `de-share-request`, `de-fork-request` | The user asked for something the host owns. `de-fork-request` carries `{ docId, atSeq }` (HIS-022) |
| `de-error` | `{ code, message, fatal }` |

Fill-mode methods and events are in 12, section 10. Theming uses CSS custom properties with the prefix `--de-` and `::part()` names listed in 02. An iframe variant of this API over `postMessage` is deferred.

### 8.2 Host page responsibilities

Listed in 13, section 11.

### 8.3 Backend ports

The component reaches a backend only through these interfaces: `auth`, `sync`, `permissions`, and optionally `presence`, `history`, `comments`, `assets`, `exports`, `imports`, `fonts`, `leases`, `fields`, `workflow`, `proofing`, `assistant`.

```ts
interface Backend {
  readonly features: ReadonlySet<string>;
  connect(): Promise<void>;
  close(): Promise<void>;
  auth: AuthPort;
  sync: SyncPort;
  permissions: PermissionsPort;
  // optional ports as listed above
}

interface SyncPort {
  loadContent(docId: string, seq?: number): Promise<{ seq: number; incarnation: string; cdm: number; doc: CdmNode }>;
  open(docId: string, opts: { resume?: Resume }): Promise<SyncChannel>;
}

interface SyncChannel {
  submit(commit: Commit): Promise<Ack>;          // rejects with a SyncReject
  onCommits(cb: (commits: RemoteCommit[]) => void): Unsubscribe;
  onReset(cb: (reset: { seq: number; reason: string }) => void): Unsubscribe;
  onAccess(cb: (access: Access) => void): Unsubscribe;
  onEvent(cb: (event: Notification) => void): Unsubscribe;
  onState(cb: (state: ChannelState) => void): Unsubscribe;
  close(): void;
}
```

Complete typings for every port are a phase 0 deliverable. The user interface shows a feature only when its port is present. Implementations that ship with the component: `backend-dep` (this protocol) and `backend-mock` (in memory) from the first phase, and `backend-local` (IndexedDB, with BroadcastChannel between tabs) later. They MUST pass the same port contract tests. Note that the local backend runs the project's own authority package, so it proves independence from the transport and the server, not from the document semantics.

## 9. Backend tiers

| Tier | What it runs | What it may announce |
|---|---|---|
| Native | An authority of its own that passes the step-semantics and rules fixtures | Everything |
| Sidecar-backed | Its own gateway, storage and control plane, with document semantics delegated to the authority service of section 10 | Everything the authority service supports |
| Relay | Ordering and storage only (04, section 14) | `mode: "relay"`; none of `regions`, `suggest-enforced`, `fields`. Content reads, restore, comparison and export still need the authority service |

## 10. Authority service interface

The authority service is the project's authority package behind a network interface, for backends not written in JavaScript. Its interface is normative, because for those backends it is the real contract.

| Call | Purpose |
|---|---|
| `open(doc, checkpointRef, commits, stateId)` | Load a document. `stateId` is the hash-chain head, which identifies the state even after a log rewind |
| `applyCommit(stateId, commit, permissions, preconditions)` | Rebase, apply, check invariants, run the permission outcome check and the rules. Returns the mapped steps, scopes touched, the new `stateId`, or the rejection |
| `materialise(stateId or seq)` | Canonical CDM content |
| `mapRanges(stateId, ranges)` | Map comment ranges and presence through commits |
| `restoreSteps`, `diff`, `attribution`, `migrate`, `evaluateRules` | As named |

The service keeps recently used documents in memory and can rebuild any of them from storage, so it holds no state that matters. It has its own conformance profile.

## 11. Conformance

The conformance kit is a black-box test runner in a container.

- **Bootstrap contract.** The kit is given a discovery URL, a service credential, and a test-mode switch that shortens timers (token lifetime, lease expiry, idle timeouts). It mints user tokens through `POST /tokens`, registers a webhook that points at itself, and creates its own documents.
- **Profiles.** `core`, `core-relay`, `presence`, `perm-doc`, `perm-region`, `perm-suggest`, `history`, `comments`, `assets`, `exports`, `webhooks`, `leases`, `authority-service`, and the profiles of 12. A profile maps to the features a server may announce.
- **What it cannot see.** Durability before acknowledgement, fencing, the hash chain and the audit trail are not observable from outside. An optional fault-injection profile covers them for servers that expose the test hooks. A server announces the feature `test-hooks` while its test-mode switch is on; without it the profile is skipped.
- **Contents.** Golden message fixtures; step-semantics and canonical-hash fixtures generated from the pinned library release; rules fixtures; negative tests for every row of the authorisation matrix; fuzzers for the envelope parser and for step validation.

Machine-readable definitions (AsyncAPI for the real-time plane, OpenAPI for the control plane, JSON Schema for the CDM and for webhook bodies) are generated in phase 0 and are checked against this document by the kit.

The kit grows with the roadmap: schemas, port contract tests and the `core` scenarios first. The protocol version is frozen at 1.0 only after a second server implementation passes `core`; that work is scheduled when a partner wants to build one (11).

## 12. Open issues

- A fallback transport (server-sent events plus POST) for networks that block WebSockets is not defined yet. The message definitions above are transport-neutral so it can be added as a binding.
- A REST endpoint for submitting a commit would let the component use a keep-alive request when a page is closing. The recovery journal makes it less urgent.
- Whether `access` should be sent as a delta once documents have hundreds of regions.
- A delegated-authorisation mode, in which the document service asks the host backend for region permissions instead of storing grants, is left as an extension.
- The `postMessage` variant of the embedding API.
