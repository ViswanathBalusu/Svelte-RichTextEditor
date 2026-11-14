/**
 * Decisions taken by spike S6 (SPK-019) where the prose is silent or contradicts itself. They are
 * proposals for the spec, not settled design: each names the gap it answers, and the spike report
 * lists them for the owner and the second review (SPK-027).
 */

export interface Decision {
  id: string;
  gaps: readonly string[];
  text: string;
  /**
   * `proposed` until the spec says otherwise; `confirmed` when a revision of the spec says the same;
   * `withdrawn` when a revision decided differently (the artifacts then follow the spec).
   */
  status?: 'confirmed' | 'withdrawn';
  /** What the revision said, for a confirmed or withdrawn decision. */
  note?: string;
}

export const DECISIONS: readonly Decision[] = [
  {
    id: 'D01',
    gaps: ['G02'],
    text: 'Enumerations are closed within major version 1; event types, feature names and message types are open vocabularies (strings with documented values), because 05 §1 rule 2 lets a minor version add those and nothing else.',
  },
  {
    id: 'D02',
    gaps: ['G12'],
    text: 'The envelope member `d` may be omitted when a message has no payload members.',
  },
  {
    id: 'D03',
    gaps: ['G16'],
    text: 'Codec classification: a frame that is not JSON, not an object, lacks `t` or has mistyped envelope members is fatal (close 4400, PRO-017); a known type whose payload does not match, or that travels in the wrong direction, is answered with a non-fatal `error` `bad_message` (with `re` when the frame had an `id`); an unknown type is ignored and, when it had an `id`, answered with `unknown_type`.',
  },
  {
    id: 'D04',
    gaps: ['G14'],
    text: 'Chunking: `i` counts from 0, `n` is at least 2, `of` is a UUID version 7, `chunk` is session-level (no `ch`), and parts are cut so that every chunk frame, envelope included, is at most `maxMessageBytes` bytes.',
  },
  {
    id: 'D05',
    gaps: ['G19'],
    text: '`auth.ok` is a server-to-client reply to `auth.refresh` with the member `tokenExp`.',
    status: 'confirmed',
    note: 'The revision of 05 §5.1 on 2026-11-06 adds the same row.',
  },
  {
    id: 'D06',
    gaps: ['G20', 'G23'],
    text: "`error` has `code`, `message`, `retryable` and `fatal` as required members, `retryAfterMs` optional (as in `sync.reject`), and an optional `versions` member that carries the server's versions before close 4406.",
  },
  {
    id: 'D07',
    gaps: ['G21'],
    text: 'The "optional `ch`" of `auth.refresh` is the envelope `ch`: a token for one channel is refreshed on that channel.',
  },
  {
    id: 'D08',
    gaps: ['G27'],
    text: '`resume.inflight` is a commit identifier and is omitted when nothing is in flight. `ch.opened.inflight` is `{ "state": "accepted", "seq": n }` or `{ "state": "unknown" }`, and is present exactly when `resume.inflight` was sent, whatever the catch-up mode.',
  },
  {
    id: 'D09',
    gaps: ['G37'],
    text: 'A commit whose base is older than a snapshot commit is rejected with code `stale_base` and action `reload`: both 04 §3.2 (action) and 04 §5 step 3 (code) are honoured; only the default action of the 04 §8 table yields.',
    status: 'withdrawn',
    note: 'The revision of 04 §3.2 on 2026-11-06 chose `stale_base` with action `rebase`; the artifacts, the mock and the contract suite follow it.',
  },
  {
    id: 'D10',
    gaps: ['G32'],
    text: 'Every `sync.commit` element carries every member: `steps` is `[]` on control commits, `control` is null on step commits, `author.session` is null for server-authored commits and `author.agent` is null unless an assistant acted. A control commit that records a grants revision carries `control: { "type": "grants", "rev": n }`, as in the example of 05 §5.9.',
  },
  {
    id: 'D11',
    gaps: ['G43'],
    text: '`access.scopes` lists `doc`, `body`, `defs`, every `story:<id>` and every `region:<id>` of the document.',
  },
  {
    id: 'D12',
    gaps: ['G44', 'G46'],
    text: "`perm.changed` follows the control commit that records the change, and its `asOfSeq` is that commit's `seq` (05 §5.9, PRO-033). A commit that adds or removes a region is followed by `perm.changed` (07 §4). `rev` counts the access objects sent on one channel.",
  },
  {
    id: 'D13',
    gaps: ['G50', 'G54'],
    text: 'The OpenAPI document declares problem responses as `4XX` and `5XX` ranges and success as `2XX`, except the `202` stated for exports, rather than inventing statuses.',
    status: 'withdrawn',
    note: 'Overtaken on 2026-11-06 by D61, which names a success status for every route of 05 §6.2 and an HTTP status for every REST code, so that the reference service could be built (packet A2). Problem responses stay declared as ranges.',
  },
  {
    id: 'D14',
    gaps: ['G55'],
    text: '`nextCursor` is null on the last page.',
  },
  {
    id: 'D15',
    gaps: ['G57'],
    text: '`If-Match` is required on every PUT and PATCH and optional on DELETE.',
  },
  {
    id: 'D16',
    gaps: ['G79'],
    text: '`POST /documents/{id}/imports` takes a service credential only, following 07 §12; the `imports` port is typed for backends whose host proxies imports.',
  },
  {
    id: 'D17',
    gaps: ['G85'],
    text: 'Workflow webhooks are named `dep.workflow.<name>.v1` (for example `dep.workflow.participant_activated.v1`).',
  },
  {
    id: 'D18',
    gaps: ['G08'],
    text: 'Both credentials are presented as `Authorization: Bearer`; the OpenAPI document names two bearer schemes.',
  },
  {
    id: 'D19',
    gaps: ['G86'],
    text: '`loadContent` resolves the same members as `GET /documents/{id}/content`, `requires` included.',
  },
  {
    id: 'D20',
    gaps: ['G87', 'G88'],
    text: '`SyncChannel` gains `opened` (the `ch.opened` payload), `onCheck` (`sync.check`) and reports `sync.caughtUp` through `onState`; `goaway` stays inside the backend, which reconnects; `wf.changed` is reported by the `workflow` port.',
  },
  {
    id: 'D21',
    gaps: ['G89'],
    text: 'Delivery on a channel: callbacks are never called synchronously from `open()`, `submit()` or an `on…` call; messages are delivered in arrival order; a message that arrives before any callback of its kind is registered is kept and delivered, in order, to the first such callback; after settling a `submit()` promise the channel yields one microtask before delivering the next message, so code that awaits `submit()` directly runs before later messages.',
  },
  {
    id: 'D22',
    gaps: ['G89'],
    text: '`submit()` rejects with a `SyncRejectError`: an `Error` whose own members are those of the `sync.reject` payload (`id`, `code`, `message`, `action`, `head` and the optional members).',
  },
  {
    id: 'D23',
    gaps: ['G93'],
    text: 'When a channel closes, every unanswered `submit()` rejects with a `PortError` of code `unavailable`; the client learns the fate of the commit from `inflight` on resume. `features` is empty until `connect()` resolves.',
  },
  {
    id: 'D24',
    gaps: ['G90'],
    text: '`AuthPort` exposes the session from `welcome`, `refresh()`, and the events `onExpiring`, `onRevoked` and `onAuthRequired`. `PermissionsPort` exposes the latest `access` per document and its changes, and, where the backend announces `regions`, the region list, grants and region states.',
  },
  {
    id: 'D25',
    gaps: ['G24'],
    text: 'The registry records the close code implied for each fatal code (`bad_message` 4400; `unauthenticated`, `token_expired`, `revoked` 4401; `forbidden` 4403; `unsupported_version` 4406; `too_large` 4413; `rate_limited` 4429; `internal` 4500; `unavailable` 4503), marked as inferred.',
  },
  {
    id: 'D26',
    gaps: [
      'G60',
      'G61',
      'G62',
      'G63',
      'G64',
      'G65',
      'G66',
      'G67',
      'G68',
      'G69',
      'G70',
      'G71',
      'G72',
      'G73',
      'G74',
      'G75',
      'G76',
      'G77',
      'G94',
      'G95',
      'G96',
      'G07',
      'G09',
    ],
    text: 'Where a body is not defined, the definition holds only the members the prose names, with the names it uses, inside an open object. Where the prose describes a member without naming it (the hash-chain head, the token in the `POST /tokens` response), the member gets a placeholder name. Such shapes are marked with their gap and are placeholders, not contracts.',
  },
  {
    id: 'D27',
    gaps: ['G89'],
    text: '`SyncChannel.onAccess` delivers the access of `ch.opened` first and `onState` the initial state first (`catching_up` for a stream, `live` otherwise); a channel closed by its caller reports `{ "status": "closed", "code": null }` once and nothing after it.',
  },
  {
    id: 'D28',
    gaps: ['G101'],
    text: 'Pending the acceptance of ADR 0019: `ch.opened` and `resume` carry an optional, opaque `view` string, and a client resumes with the `view` of the `ch.opened` its confirmed document came from. A server without read restrictions may omit it and ignores it. What a missing token means for a client that joined from REST stays open (G101).',
  },
  // Decisions taken while building the data plane of the reference service (PLAN-1a packet A1,
  // 2026-11-06). Proposals, like the ones above.
  {
    id: 'D40',
    gaps: ['G102'],
    text: 'For a read-restricted reader (ADR 0019), a `steps` commit in `sync.commit` and the `steps` of `sync.ack` may be empty: the commit changed only content the reader cannot see, and the client still advances its `seq`. `sync.commit` names no scopes, and a message that names scopes (`sync.reject.scopes`) names only scopes the reader can see, so that a hidden region or field value is never named.',
  },
  {
    id: 'D41',
    gaps: ['G103'],
    text: '`ch.closed` carries an optional `cause`, an open vocabulary. `access_changed` means that what the reader may see changed (ADR 0019): the client reopens the channel at once without `resume`, and its unconfirmed work goes to recovered edits. `fenced`, `lost` and `stopped` say why a room stopped serving; the client backs off and resumes as for `unavailable`. `code` stays `unavailable` in every case, so a client that ignores `cause` still recovers: its resume carries the old view token and is answered with a reload.',
  },
  {
    id: 'D42',
    gaps: ['G11'],
    text: "On the wire a user is the host's `sub`: `welcome.user.id`, `author.user` of a commit, the users of `presence.state`, lease holders and `fill.participant` when the token has no `wfp`. At rest the service stores the per-tenant surrogate (08 §13): commit records, grants and leases. The service maps the surrogate when it sends, so `resolveUsers` receives the identifiers the host issued; a user whose mapping was erased appears as their surrogate, and server-authored commits as `system`.",
  },
  // Decisions taken while building the control plane of the reference service (PLAN-1a packet A2,
  // 2026-11-06). Proposals, like the ones above.
  {
    id: 'D60',
    gaps: ['G07', 'G04'],
    text: "`POST /tokens` takes the claims a host asks for under their claim names (`sub`, `docs`, and optionally `name`, `grp`, `wfp`, `amr`, `auth_time`, `access_since`, `restrict`) and an optional `expiresIn` of at most 900 seconds. The service sets `iss` and `aud` to its own identifier, `tid` to the caller's tenant, `iat`, `exp` and `jti`, signs with a key of its own, and answers 200 with `{ token, expiresAt }`. `jwks_uri` publishes the public keys of the tokens it mints, so that a host can check them; a host-signed token is verified only against the keys registered for its tenant (05 §3.1).",
  },
  {
    id: 'D61',
    gaps: ['G50', 'G54'],
    text: 'Success statuses: 200 with a body, 201 for a request that creates a resource, 202 for one that starts a job (exports, imports, asset completion), 204 without a body. Each REST code of the registry has one HTTP status: 401 for `unauthenticated`, `token_expired` and `revoked`; 403 `forbidden`; 404 `not_found`; 409 `already_open`, `channel_limit`, `conflict`, `pending_suggestions` and `workflow_active`; 422 `field_invalid` and `idempotency_mismatch`; 413 `too_large`; 429 `rate_limited` and `quota_exceeded`; 400 `validation_failed`; 412 `precondition_failed`, or 428 when `If-Match` is missing; 500 `internal`; 503 `unavailable`.',
  },
  {
    id: 'D62',
    gaps: ['G60', 'G61'],
    text: '`POST /documents` takes `content` (a CDM envelope), `template` and `import` (identifiers, refused with `validation_failed` until FRW and EXP define them; at most one of the three), `externalId` (1 to 255 characters, unique in the tenant: a second one is `conflict`), `title`, `properties` (any JSON object) and `classification`, and answers 201. The document resource is `{ id, externalId, title, properties, classification, state, cdm, requires, createdAt }`. `PATCH` is a JSON merge patch of `title`, `properties`, `classification` and `state`; the ETag is a metadata revision that every `PATCH` and `DELETE` raises.',
  },
  {
    id: 'D63',
    gaps: ['G65'],
    text: "The grants resource is `{ rev, grants }`, where `rev` is the grants revision of 07 §9, from which the ETag is derived. `PATCH` is a JSON merge patch: `grants` replaces the whole list. Each grant names a region of the content at the head that is not retired, a principal of the four forms, a region role and an optional expiry; two grants for the same region and principal are refused. A refusal is `validation_failed` and stores nothing. Storage and the room hold a `user:` principal with the per-tenant surrogate; the resource shows the host's `sub`.",
  },
  {
    id: 'D64',
    gaps: ['G64'],
    text: 'An item of `GET /documents/{id}/regions` holds `id`, `title`, `policy`, `order` (the position among the regions of the body, from 0), `state` (`draft` when none is stored) and `editors`: the document roles that may edit the region by role alone (`editor` and `owner` under `inherit`, `owner` under `restricted`), the principals with an `editor` grant that has not expired, both empty while the region is approved, and the holder of a lease. It is computed from the content at the head and the permission data in storage.',
  },
  {
    id: 'D65',
    gaps: ['G80'],
    text: "For routes the matrix of 07 §12 does not list: reading the region list needs `view`; reading the grants needs `manage` or a service credential; changing a document's metadata or state (`PATCH /documents/{id}`) needs `manage` or a service credential, as deleting it does.",
  },
  {
    id: 'D66',
    gaps: ['G03', 'G05'],
    text: "Discovery is the same for every tenant of an endpoint and needs no token; every member of the discovery document is required. A CORS preflight, which carries no token either, is allowed when some tenant of the endpoint allows its origin. A response is readable by the browser only when the tenant of the request's credential allows the origin, or, for a request without a valid credential, when some tenant does.",
  },
  {
    id: 'D67',
    gaps: ['G97'],
    text: 'The content a document is created with is the content at `seq` 0, stored as the checkpoint at 0; the head starts at 0 and the first commit is 1. The grants revision a document is created with is recorded in the history of permission states, not by a control commit.',
  },
  {
    id: 'D68',
    gaps: ['G73'],
    text: 'An export job is `{ id, doc, target, seq, state, progress, result, diagnostics, error, createdAt, updatedAt }`. `seq` defaults to the head when the request is accepted, and a `seq` above the head is `validation_failed`. `progress` is a percentage, or null. `result` holds signed URLs (`url`, `layout`, and `log` for a requester with `edit`) issued at each read after the permission check, their `expiresAt`, the page count and whether page references converged. A target the server does not support is `validation_failed`; a caller restricted with `no-export` is `forbidden`. `DELETE` cancels a queued or running job; on a finished job it changes nothing; both answer 204.',
  },
  {
    id: 'D69',
    gaps: ['G80'],
    text: "Following review SR-C4, an export job, its result and its logs belong to the user who requested it. `GET` and `DELETE /exports/{jid}` are `forbidden` to any other user, even one whose token covers the document, and to the requester once their token carries `no-export`; a service credential may read and cancel any job of its tenant. Whether holders of `manage` may read other users' jobs is for the owner; until then they may not.",
  },
  {
    id: 'D70',
    gaps: ['G101'],
    text: "`GET /documents/{id}/content` carries the view token of the reader's visibility class (`view`), computed from the permission data in storage at the time of the read (S12 change 3); the full view has one too. Pinned reads are `Cache-Control: private` and immutable for a year, reads at the head `private, no-cache`; none may be stored by a shared cache (review SR-C4). The ETag combines the incarnation, the `seq` and the view token, and every cache in the service is keyed by all three.",
  },
  {
    id: 'D71',
    gaps: ['G56'],
    text: 'Every response carries the header `DEP-Request-Id`, which is added to the headers browsers may read, and a problem document repeats it as `requestId`. A `validation_failed` problem lists `violations`: JSON Pointers into the body with the rule broken, never the offending value.',
  },
  {
    id: 'D72',
    gaps: ['G55'],
    text: 'Lists take a `limit` from 1 to 200, and 50 when it is absent; another `limit`, or a cursor the server did not issue, is `validation_failed`.',
  },
  {
    id: 'D73',
    gaps: ['G09'],
    text: '`POST /sessions/revoke` takes `{ sub, doc }`, `doc` optional, and answers 204. Without `doc` the watermark covers every document of the user: tokens issued before it are refused on both planes with `revoked`. With `doc` it covers that document: such a token no longer covers it, and is refused only when it covers nothing else.',
  },
  {
    id: 'D74',
    gaps: ['G10'],
    text: 'A user token whose `docs` claim is empty, has more than 20 entries or names a role outside the six of 05 §3.1, or that breaks another claim rule, is refused with `unauthenticated`; one whose `exp` has passed by more than the 60 seconds of skew, with `token_expired`. `aud` must be a string equal to the service identifier.',
  },
  {
    id: 'D80',
    gaps: ['G87', 'G89', 'G93'],
    text: 'A client channel (the `ClientChannel` machine of `@docedit/protocol/client`, which `backend-dep` uses) delivers commits and acknowledgements in ascending `seq`, each once, without gaps: a commit at or below the confirmed `seq` is dropped, an acknowledgement rebuilt for a duplicate settles without moving the `seq`, and a commit or acknowledgement beyond the next `seq` is a gap. A gap, a request not answered within `ackTimeoutMs` (a submit, `ch.open`, or a catch-up stream that falls silent before `sync.caughtUp`), a lost connection, and `ch.closed` with `unavailable` or `slow_consumer` make the channel resume by itself with `resume: { seq, incarnation, inflight, view }`, after `retryInMs` when given: unanswered submits fail with `unavailable` (D23), the state goes `resuming`, then `catching_up` and `live`, and a stored in-flight commit reaches the caller in the stream. Submits made while the channel is not live wait until it is (04 §9 step 5). A resume answered with `reload` closes the channel with code `unavailable`, `retryInMs: 0`, because only the caller can replace its confirmed document (04 §9 step 3; ADR 0019); it reopens the channel. With `catchUp: "page"` the channel reports `catching_up`, reads the commits over REST and holds live messages until it reaches the head (this amends "live otherwise" in D27 for paging). The client\'s own commit in a stream answers its pending submit.',
  },
  {
    id: 'D81',
    gaps: ['G101'],
    text: 'A client keeps the view token of every `ch.opened` and every content read (D28, D70). A channel resumes with the view of its latest `ch.opened`. A resume the caller passes without `view` gets the view of the content read or channel that covered the same incarnation and a `seq` it saw under that view; otherwise it is sent as given, and a server with read restrictions answers it with a reload. A view gone stale is harmless: the server answers it with a reload too.',
  },
  {
    id: 'D82',
    gaps: ['G20'],
    text: 'A client offers its versions in `hello` and accepts any of them in `welcome`; it expects the highest version common to both lists, and a `welcome` with a version it did not offer, or a socket opened without the subprotocol `dep.v1`, ends the session with `unsupported_version`. Before opening the socket it checks discovery: no common version is `unsupported_version`, no common engine `unsupported_engine`, no overlapping CDM range `unsupported_cdm`.',
  },
  {
    id: 'D83',
    gaps: ['G24'],
    text: "Reconnection, by the close code and the fatal `error` before it (D25): 4401 is retried once with a new token from the token source (05 §5.8), then ends the session with `onAuthRequired`; 4403, 4406, `auth.revoked` and a second refused token end the session; every other close, and two heartbeat intervals without a message, reconnect after the backoff of 05 §4, the `retryAfterMs` of the error, or the `reconnectInMs` of `goaway`. `connect()` itself makes one attempt and rejects with the code. The handshake waits `ackTimeoutMs` for `welcome` (the last session's, by default 15,000).",
  },
  {
    id: 'D84',
    gaps: ['G14', 'G16'],
    text: "A client that receives a known message with an invalid payload or the wrong direction answers with a non-fatal `error` `bad_message` (with `re` when the frame had an `id`) and ignores it; a frame that is not a JSON object with a type closes the connection with 4400, and the client reconnects. A chunked message whose reassembly fails or times out is dropped; the channel's gap detection recovers what it carried.",
  },
  {
    id: 'D85',
    gaps: ['G90'],
    text: 'The connection status of `de-status` (05 §8.1) is `online` while a session is open, `reconnecting` from a lost connection until the next `welcome`, and `offline` when there is no session and none is being opened: before `connect()`, after `close()`, and after a session ended for good (D83). `backend-dep` reports it through a `connection` member outside the port typings, proposed for the `Backend` interface in ADR 0040; the channel states report `resuming` meanwhile.',
  },
  // Decisions of the data plane's phase 1b (packet A, 2026-11-06; ADR 0053).
  {
    id: 'D120',
    gaps: ['G120'],
    text: "`SyncPort.open`'s options take an optional `features`: the features the caller's editor reads for this document (03 §11.1). A backend sends them in `ch.open.features`, limited to the features the server announced; without the member it sends the features it was constructed with. The server keeps each channel's list for as long as the channel is open, for the commits that add a feature to `requires`.",
  },
  {
    id: 'D122',
    gaps: ['G72'],
    text: '`POST /documents/{id}/assets/resolve` answers `{ assets: [{ asset, url, expiresAt, contentType }] }`, one entry for each requested identifier that the caller may read and that is ready. An identifier the caller may not read, or that is not ready, is left out rather than refused, so the answer does not reveal whether an asset exists elsewhere in the tenant. `url` is a signed URL valid until `expiresAt`. The order of the entries is not defined. The upload descriptor, the responses of `complete` and the URL lifetime remain open under G72. Proposed by the stabiliser of packages/protocol to match the reference service (services/document-service); the owner confirms or changes it.',
  },
  {
    id: 'D121',
    gaps: ['G121'],
    text: '`welcome.features` and discovery list the protocol features the server implements and the CDM features its document model reads (03 §11.1), in one list. A `ch.open` whose `features` names a feature the server did not announce is rejected with `unsupported_feature` (05 §1 rule 4), and so is one that lacks a feature the document requires (03 §11.1).',
  },
];

export const DECISION_IDS: ReadonlySet<string> = new Set(DECISIONS.map((d) => d.id));
