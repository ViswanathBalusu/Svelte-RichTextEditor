/**
 * Gaps between the prose of 03 to 05 (with 07, 08 and 12 where 05 points at them) and what a
 * machine-readable definition needs (SPK-019). Each gap is referenced from the definition elements
 * that depend on it, so it appears in the generated artifacts (`$comment` in schemas, `x-dep-gaps`
 * elsewhere) and in spec/dep/dep-1.gaps.json. The spike report lists them for the spec authors.
 *
 * `kind`: `missing` (the prose does not say), `contradiction` (two passages disagree),
 * `example` (the example disagrees with the normative text), `ports` (05 §8.3 is incomplete).
 */

export interface Gap {
  id: string;
  /** Where the gap is, for example "05 §5.2". */
  section: string;
  kind: 'missing' | 'contradiction' | 'example' | 'ports';
  text: string;
  /** Open question in docs/stories/PRO-protocol.md or a review finding, when one exists. */
  seeAlso?: string;
  /**
   * How the spec settled it, or the decision that settled it to build the reference service;
   * identifiers stay stable so references remain valid.
   */
  resolved?: string;
}

export const GAPS: readonly Gap[] = [
  // 05 §1 Versioning
  {
    id: 'G01',
    section: '05 §1',
    kind: 'missing',
    text: 'The grammar of feature names and message type names is not stated; only the `x-` prefix for experimental names is. The artifacts use `^[a-z][a-z0-9-]*$` for features and `^(x-)?[a-z][a-zA-Z0-9]*(\\.[a-z][a-zA-Z0-9]*)*$` for message types, which `sync.caughtUp` needs.',
  },
  {
    id: 'G02',
    section: '05 §1',
    kind: 'missing',
    text: 'Rule 2 lists what a minor version may add (fields, message types, resources, event types, feature names) but not new values of an enumeration (`action`, `catchUp`, `code`). Whether receivers must accept unknown enumeration values is not stated.',
  },
  // 05 §2 Discovery
  {
    id: 'G03',
    section: '05 §2',
    kind: 'missing',
    text: 'Discovery is given only as an example: which members are required, and their types, are not stated.',
    resolved:
      'Decision D66 (packet A2, 2026-11-06, proposed): every member of the discovery document is required.',
  },
  {
    id: 'G04',
    section: '05 §2, §3.1',
    kind: 'missing',
    text: 'The purpose of `jwks_uri` is not stated; 05 §3.1 says user-token keys come from the tenant registration and never from a URL.',
    seeAlso: 'PRO open question 8',
    resolved:
      'Decision D60 (packet A2, 2026-11-06, proposed): `jwks_uri` publishes the public keys of the tokens the service mints; host-signed tokens are verified against the tenant registration only.',
  },
  {
    id: 'G05',
    section: '05 §2, §6.1',
    kind: 'missing',
    text: 'How the tenant is identified for discovery and for CORS preflights, which carry no token.',
    seeAlso: 'PRO open question 8',
    resolved:
      'Decision D66 (packet A2, 2026-11-06, proposed): discovery is the same for every tenant; a preflight is allowed when some tenant allows its origin, and a response is readable only when the tenant of the credential allows it.',
  },
  {
    id: 'G06',
    section: '05 §2, §8.3',
    kind: 'missing',
    text: 'No feature names exist for the `imports`, `fonts`, `proofing` and `assistant` ports, although "the user interface shows a feature only when its port is present" and a client may use only announced features (05 §1 rule 4).',
  },
  // 05 §3 Authentication
  {
    id: 'G07',
    section: '05 §3.1, §6.2',
    kind: 'missing',
    text: 'The request and response bodies of `POST /tokens` are not defined.',
    seeAlso: 'PRO open question 7',
    resolved:
      'Decision D60 (packet A2, 2026-11-06, proposed): the request takes the claims under their names and `expiresIn`; the response is `{ token, expiresAt }`.',
  },
  {
    id: 'G08',
    section: '05 §3.2',
    kind: 'missing',
    text: 'How a service credential (an API key, or a `dep-svc+jwt`) is presented on a request is not stated. The artifacts assume `Authorization: Bearer`.',
    seeAlso: 'PRO open question 7',
  },
  {
    id: 'G09',
    section: '05 §3.3',
    kind: 'missing',
    text: 'The body of `POST /sessions/revoke` (member names for the user and the document) and whether naming a document limits the watermark to that document.',
    seeAlso: 'PRO open question 10',
    resolved:
      'Decision D73 (packet A2, 2026-11-06, proposed): the body is `{ sub, doc }`; with `doc`, the watermark covers that document only.',
  },
  {
    id: 'G10',
    section: '05 §3.1',
    kind: 'missing',
    text: 'Behaviour for a `docs` claim with more than 20 entries or an unknown role, and precedence between a channel token and the connection token.',
    seeAlso: 'PRO open question 9',
  },
  {
    id: 'G11',
    section: '05 §5.1, §5.3; 08 §13',
    kind: 'missing',
    text: 'Whether `user.id`, `author.user`, `presence.state` user identifiers and lease holders are the token `sub` or the per-tenant surrogate; this decides what `resolveUsers` receives.',
    seeAlso: 'PRO open question 18',
    resolved:
      "Decision D42 (packet A1, 2026-11-06, proposed): the wire shows the host's `sub`; storage keeps the per-tenant surrogate, and the service maps it when it sends.",
  },
  // 05 §4 Framing
  {
    id: 'G12',
    section: '05 §4',
    kind: 'missing',
    text: 'Whether `d` may be omitted when a message has no payload (`ping`, `pong`, `ch.close`), or must be `{}`.',
  },
  {
    id: 'G13',
    section: '05 §4, §5.2',
    kind: 'missing',
    text: 'The range of channel numbers (whether 0 is allowed) and whether a number may be reused after `ch.closed` or `ch.rejected`.',
  },
  {
    id: 'G14',
    section: '05 §4',
    kind: 'missing',
    text: 'Chunking: whether `maxMessageBytes` bounds each `chunk` frame including its envelope; whether `chunk` carries `ch`; whether `i` starts at 0; the format of `of`; what happens when reassembly times out; whether `ping` and `pong` may be sent between the chunks of one message.',
    seeAlso: 'PRO open question 13',
  },
  {
    id: 'G15',
    section: '05 §4',
    kind: 'missing',
    text: 'Binary frames: the meaning of `kind`, how the integer `id` relates to the string `id` of text frames, and what a receiver does with a binary frame on a channel whose engine does not use them.',
    seeAlso: 'PRO open question 14',
  },
  {
    id: 'G16',
    section: '05 §4, §5.7',
    kind: 'missing',
    text: 'What a receiver does with a known message type sent in the wrong direction, and with a well-formed envelope whose payload does not match its schema (a non-fatal `bad_message` error, or close 4400).',
  },
  {
    id: 'G17',
    section: '05 §4, §5.1',
    kind: 'missing',
    text: 'Whether `ping` carries an `id` and `pong` a `re`; the envelope rule says a reply always carries `re`.',
  },
  {
    id: 'G18',
    section: '05 §5.1',
    kind: 'missing',
    text: 'Defaults for `maxMessageBytes` and `maxChannels` (the example shows 131,072 for `maxMessageBytes`).',
    seeAlso: 'PRO open question 15',
  },
  // 05 §5.1 Session
  {
    id: 'G19',
    section: '05 §5.1',
    kind: 'missing',
    text: '`auth.ok` is named in the notes of `auth.refresh` but is missing from the message table; only its `tokenExp` member is implied.',
    seeAlso: 'PRO open question 11',
    resolved:
      'The revision of 05 §5.1 on 2026-11-06 lists `auth.ok` (S to C) with `tokenExp` as the reply to `auth.refresh`.',
  },
  {
    id: 'G20',
    section: '05 §5.1, §5.7',
    kind: 'missing',
    text: 'The `error` sent before close 4406 "lists the server\'s versions", but `error` has no member for them; how a version is chosen when several are common is not stated.',
    seeAlso: 'PRO open question 12',
  },
  {
    id: 'G21',
    section: '05 §5.1',
    kind: 'missing',
    text: '`auth.refresh` takes "optional `ch` for a channel token": it is not stated whether this is the envelope `ch` or a payload member.',
  },
  {
    id: 'G22',
    section: '05 §5.1, §3.1',
    kind: 'missing',
    text: '`welcome.user.name` is listed without saying it may be absent, while the `name` claim is optional.',
  },
  {
    id: 'G23',
    section: '05 §5.1',
    kind: 'missing',
    text: '`error` lists `retryAfterMs` without marking it optional, though it applies only to retryable errors.',
  },
  {
    id: 'G24',
    section: '05 §5.7, §5.8',
    kind: 'missing',
    text: 'The mapping from fatal error codes to close codes is implied by the meaning column only, and no error code is named for 4408 (`hello` not received in time).',
    seeAlso: 'PRO open question 16',
  },
  {
    id: 'G25',
    section: '05 §5.1, §5.2',
    kind: 'missing',
    text: 'Whether `reason` in `auth.revoked`, `goaway`, `ch.closed` is free text or a code.',
  },
  {
    id: 'G26',
    section: '05 §5.1',
    kind: 'missing',
    text: 'The format of `tokenExp` (an RFC 3339 timestamp per 01 §8, or the JWT NumericDate of `exp`).',
  },
  // 05 §5.2 Channels
  {
    id: 'G27',
    section: '05 §5.2; 04 §9',
    kind: 'missing',
    text: 'The shape of `ch.opened.inflight` ("`accepted` with `seq`, or `unknown`"), whether it is present when `resume.inflight` was not sent or when the answer is `reload`, and whether `resume.inflight` is omitted or null when nothing is in flight.',
  },
  {
    id: 'G28',
    section: '05 §5.2; 12 §10',
    kind: 'missing',
    text: 'The shape of the optional `workflow` member of `ch.opened`.',
  },
  {
    id: 'G29',
    section: '05 §5.2; 04 §1; 01 §8',
    kind: 'missing',
    text: 'The format of `incarnation` (the example suggests a UUID version 7; 01 §8 does not list it).',
  },
  {
    id: 'G30',
    section: '05 §5.2',
    kind: 'missing',
    text: 'Whether `ch.close` is answered (for example by `ch.closed`), and whether messages already in flight for the channel are still delivered.',
  },
  {
    id: 'G31',
    section: '05 §5.2',
    kind: 'missing',
    text: 'The codes `ch.closed` may carry are given as examples only (`forbidden`, `unavailable`, `slow_consumer`).',
  },
  // 05 §5.3 Sync
  {
    id: 'G32',
    section: '05 §5.3; 04 §3.2',
    kind: 'missing',
    text: 'Which members of a `sync.commit` element are present for each `kind` (`steps` on a control commit, `control` on a step commit), the shape of `control` (only the example `{ "type": "grants", "rev": 9 }` exists), and what `author.agent` holds.',
    seeAlso: 'PRO-029 notes',
  },
  {
    id: 'G33',
    section: '05 §5.3; 04 §5',
    kind: 'missing',
    text: 'The value of `rebased` in an acknowledgement rebuilt for a duplicate.',
  },
  {
    id: 'G34',
    section: '05 §5.3, §5.8; 04 §8',
    kind: 'missing',
    text: 'The registry gives `forbidden`, `too_large`, `quota_exceeded`, `unavailable` and `internal` the surface "all", so they can appear in `sync.reject`, but 04 §8 gives no action for `forbidden`, `quota_exceeded` and `internal`.',
  },
  {
    id: 'G35',
    section: '05 §5.3; 12 §5.3',
    kind: 'missing',
    text: 'The format of `rule` in `sync.reject` (a rule identifier, a field key, or a constraint name).',
  },
  {
    id: 'G36',
    section: '05 §5.3; 04 §13; 12 §6.1',
    kind: 'missing',
    text: 'The encoding of `sync.check.hash` (lower-case hexadecimal, or the `sha256:` prefix used by `sentHash` in 12 §6.1).',
  },
  {
    id: 'G37',
    section: '04 §3.2, §5 step 3, §8',
    kind: 'contradiction',
    text: 'A commit whose base is older than a snapshot commit is rejected "with action `reload`" (04 §3.2) and "with `stale_base`" (04 §5 step 3), whose action is `rebase` (04 §8).',
    seeAlso: 'Review 2026-11-06 §2 item 1',
    resolved:
      'The revision of 04 §3.2 on 2026-11-06 rejects it with `stale_base` and action `rebase`: the client has already received `sync.reset`, re-applied its steps to the new content and resubmits what still applies.',
  },
  {
    id: 'G38',
    section: '04 §5, §8',
    kind: 'missing',
    text: 'No code is named for a commit with no steps, a disallowed step type, or a client-sent reserved origin (the authority uses `invalid_op`).',
    seeAlso: 'Review 2026-11-06 §3 (04)',
  },
  {
    id: 'G39',
    section: '04 §12; 06 §12',
    kind: 'contradiction',
    text: 'A spent tenant CPU budget gives `rate_limited` in 04 §12 and `quota_exceeded` in 06 §12.',
    seeAlso: 'Review 2026-11-06 §2 item 2',
    resolved:
      'The revision of 06 §12 on 2026-11-06 rejects such a commit with `rate_limited` and action `retry`, as 04 §12 does; other quotas give `quota_exceeded`.',
  },
  {
    id: 'G40',
    section: '04 §5 step 1; 07 §4, §5.2',
    kind: 'contradiction',
    text: 'A commit to a locked or archived document is `read_only` (04 §5 step 1), while P6 rejects commits from connections limited to `view` or `comment` with `permission_denied`; a locked document limits everyone to `view` and `comment`.',
    seeAlso: 'Review 2026-11-06 §2 item 3',
    resolved:
      'The revision of 04 §5 step 1 and 07 §5.2 (P6) on 2026-11-06 checks the document state first, so such a commit gets `read_only`.',
  },
  {
    id: 'G41',
    section: '05 §5.3; 07 §5.1',
    kind: 'missing',
    text: 'Scope identifiers in 05 have one `defs` scope, while the outcome check partitions definitions per node (07 §5.1). Whether a rejection may name one definition is not stated.',
  },
  // 05 §5.4 Presence
  {
    id: 'G42',
    section: '05 §5.4; 04 §11',
    kind: 'missing',
    text: "Presence: whether `peers` includes the receiver's own session, whether `presence.state` is a full set or a change, the types of `selection.anchor` and `head` (positions in the confirmed document), and the format of `scope`.",
  },
  // 05 §5.5 Permissions
  {
    id: 'G43',
    section: '05 §5.5; 07 §4',
    kind: 'missing',
    text: 'Whether `access.scopes` lists `doc` and each `story:<id>` (07 §4 gives them capabilities; the example lists `body`, `defs` and regions).',
  },
  {
    id: 'G44',
    section: '05 §5.5; 07 §9',
    kind: 'missing',
    text: 'How `access.rev` (per connection) relates to the grants revision, and the order of `perm.changed` and the control commit that records a grants change (only the example of 05 §5.9 shows the control commit first).',
  },
  {
    id: 'G45',
    section: '05 §5.5; 12 §4.1',
    kind: 'missing',
    text: 'The types inside `access.fill` (`participant`, `roles`, `active`) and inside `access.leases` (keys are scope identifiers; whether `holder` is `sub` or the surrogate).',
  },
  {
    id: 'G46',
    section: '05 §5.5; 07 §4',
    kind: 'missing',
    text: '07 §4 recomputes access when the region list changes, but 05 does not say that a commit which adds or removes a region is followed by `perm.changed`.',
  },
  // 05 §5.6 Notifications
  {
    id: 'G47',
    section: '05 §5.6',
    kind: 'missing',
    text: 'Which connections receive which `event`, and whether `event` is always channel-scoped (the example carries `ch`).',
    seeAlso: 'PRO open question 17',
  },
  {
    id: 'G48',
    section: '05 §5.6',
    kind: 'missing',
    text: 'The members of `data` per event type (thread events carry "the thread\'s current range and the `seq`" without member names), and what `rev` counts.',
  },
  {
    id: 'G49',
    section: '05 §5.6, §7, §8.1',
    kind: 'contradiction',
    text: 'The three event vocabularies are said to share stems, but differ: `document.updated` against `dep.document.changed`; notifications have no `grants.changed`; webhooks have no `thread.updated`, `export.progress` or `asset.ready`; DOM events cover exports only.',
    seeAlso: 'PRO open question 17',
  },
  // 05 §5.7, §5.8
  {
    id: 'G50',
    section: '05 §5.8, §6.1',
    kind: 'missing',
    text: 'No HTTP status is given for any registry code, nor the code and status for a missing `If-Match`. The OpenAPI document declares problem responses as `4XX` and `5XX` ranges.',
    seeAlso: 'PRO open question 6',
    resolved:
      'Decision D61 (packet A2, 2026-11-06, proposed): every REST code has an HTTP status in the registry; a missing `If-Match` is 428 with `precondition_failed`.',
  },
  {
    id: 'G51',
    section: '05 §5.8',
    kind: 'missing',
    text: '`already_open` and `channel_limit` are listed with the surface "socket, REST", though neither can occur on REST as described.',
    seeAlso: 'PRO open question 19',
  },
  {
    id: 'G52',
    section: '05 §6.2',
    kind: 'missing',
    text: 'Which problem codes each route can return is not stated, except `pending_suggestions` for exports and `idempotency_mismatch` for creating requests.',
  },
  // 05 §5.9 Example
  {
    id: 'G53',
    section: '05 §5.9',
    kind: 'example',
    text: 'The example frames omit members the tables require: `welcome` has no `user` or `features` and three of eleven limits; `ch.open` has no `features`; `ch.opened` has no `inflight`; both `access` objects lack `leases`, `fill` and `restrictions`; the commits are elided.',
  },
  // 05 §6.1 Conventions
  {
    id: 'G54',
    section: '05 §6.1, §6.2',
    kind: 'missing',
    text: 'No success status is given for any route except `202` for exports (`200`, `201` and `204` are left open). The OpenAPI document uses `2XX`.',
    resolved:
      'Decision D61 (packet A2, 2026-11-06, proposed): 200, 201, 202 or 204 for every route of 05 §6.2.',
  },
  {
    id: 'G55',
    section: '05 §6.1',
    kind: 'missing',
    text: 'Lists: whether `nextCursor` is null or absent at the end, the default `limit`, what happens above 200; `/commits` pages with `after` instead of `cursor`.',
    seeAlso: 'PRO open question 21',
  },
  {
    id: 'G56',
    section: '05 §6.1',
    kind: 'missing',
    text: 'The name of the request-identifier response header.',
    seeAlso: 'PRO open question 21',
    resolved:
      'Decision D71 (packet A2, 2026-11-06, proposed): `DEP-Request-Id`, repeated as `requestId` in problem documents.',
  },
  {
    id: 'G57',
    section: '05 §6.1',
    kind: 'missing',
    text: '"Updates require `If-Match`": whether DELETE is an update, and whether forward-only writes (`PUT read-marker`) and lease heartbeats need `If-Match`.',
  },
  {
    id: 'G58',
    section: '05 §6.1',
    kind: 'missing',
    text: 'Which POST requests "create something" and so take `Idempotency-Key`: tokens, forks, restores, lease acquisition and workflow actions are unclear.',
  },
  {
    id: 'G59',
    section: '01 §8; 05 §6.2; 12 §6.1',
    kind: 'missing',
    text: 'Identifier formats for comments, versions, webhooks, participants (the example uses `p1`), templates and bulk sends; 01 §8 lists UUID version 7 only for documents, commits, sessions, assets, jobs and threads.',
  },
  // 05 §6.2 Resources
  {
    id: 'G60',
    section: '05 §6.2',
    kind: 'missing',
    text: '`POST /documents`: member names for the CDM content, the template and the import, and the shape of `properties`.',
    resolved:
      'Decision D62 (packet A2, 2026-11-06, proposed): `content`, `template`, `import`, `externalId`, `title`, `properties` (any JSON object) and `classification`.',
  },
  {
    id: 'G61',
    section: '05 §6.2',
    kind: 'missing',
    text: 'The document resource: member names for metadata, `properties` and the classification label, and what PATCH may change.',
    resolved:
      'Decision D62 (packet A2, 2026-11-06, proposed): `{ id, externalId, title, properties, classification, state, cdm, requires, createdAt }`; PATCH may change `title`, `properties`, `classification` and `state`.',
  },
  {
    id: 'G62',
    section: '05 §6.2',
    kind: 'missing',
    text: "`PUT /documents/{id}/content`: the response (the snapshot commit's `seq`?), and the request body (the CDM envelope is assumed).",
  },
  {
    id: 'G63',
    section: '05 §6.2',
    kind: 'missing',
    text: 'The item shape of `GET /documents/{id}/commits` (assumed equal to a `sync.commit` element).',
  },
  {
    id: 'G64',
    section: '05 §6.2',
    kind: 'missing',
    text: '`GET /documents/{id}/regions`: the shape of "who can edit" and of `order`.',
    resolved:
      'Decision D64 (packet A2, 2026-11-06, proposed): `order` is the position among the regions of the body; `editors` lists document roles, principals and a lease holder.',
  },
  {
    id: 'G65',
    section: '05 §6.2; 07 §1',
    kind: 'missing',
    text: 'The grants resource, the PATCH body format and the member that carries the new grants revision.',
    resolved:
      'Decision D63 (packet A2, 2026-11-06, proposed): `{ rev, grants }`; PATCH replaces the list as a JSON merge patch; `rev` is the new grants revision.',
  },
  {
    id: 'G66',
    section: '05 §6.2; 07 §10',
    kind: 'missing',
    text: "Leases: the resource shape, what POST, PUT and DELETE each do (PUT as the heartbeat is assumed), and how a user with `manage` breaks another user's lease.",
  },
  {
    id: 'G67',
    section: '05 §6.2; 08 §4; 06 §4.1',
    kind: 'missing',
    text: 'The shapes of history groups and versions; 06 omits the version kinds `sent` and `completed` of 08 §4.',
  },
  {
    id: 'G68',
    section: '05 §6.2; 08 §6, §7',
    kind: 'missing',
    text: 'Attribution parameters ("a region or a block range") and result; the diff result exists only as the example of 08 §6.',
  },
  {
    id: 'G69',
    section: '05 §6.2; 08 §8',
    kind: 'missing',
    text: 'Restore and fork: the responses, and the member name for "whether grants are copied".',
  },
  {
    id: 'G70',
    section: '05 §6.2; 08 §10',
    kind: 'missing',
    text: 'The shape of `GET /documents/{id}/activity` and of the read marker.',
  },
  {
    id: 'G71',
    section: '05 §6.2; 07 §6; 13 §5',
    kind: 'missing',
    text: 'Threads and comments: the thread and comment resources, how mentions are represented, the type of `assignee`, and what `GET threads?seq=N` returns.',
    resolved:
      'ADR 0417 (proposed, 2026-11-18): a comment is `{ id, author, createdAt, editedAt, body }` with a body of text and mention parts; a thread carries its comments, its creator and its time; `assignee` is a principal; the list at `seq` maps each range to that seq. Pending the owner.',
  },
  {
    id: 'G72',
    section: '05 §6.2; 06 §4.4',
    kind: 'missing',
    text: 'Assets: the upload descriptor (URL, method, headers, expiry), the responses of `complete` and `resolve`, and the URL lifetime.',
  },
  {
    id: 'G73',
    section: '05 §6.2; 09 §9.1',
    kind: 'missing',
    text: 'Exports: the job resource (progress format; result members are listed in 09 §9.1 without names), the default for an omitted `seq`, the code for an unsupported target and for a `no-export` refusal, and what DELETE does to a finished job.',
    seeAlso: 'PRO open question 20',
    resolved:
      'Decision D68 (packet A2, 2026-11-06, proposed): the job resource and its result are defined; `seq` defaults to the head; an unsupported target is `validation_failed`, a `no-export` refusal `forbidden`; DELETE of a finished job changes nothing.',
  },
  {
    id: 'G74',
    section: '05 §6.2; 09 §12',
    kind: 'missing',
    text: 'The import job resource and the shape of its warnings.',
  },
  {
    id: 'G75',
    section: '05 §6.2',
    kind: 'missing',
    text: 'The font manifest shape.',
  },
  {
    id: 'G76',
    section: '05 §6.2',
    kind: 'missing',
    text: 'Webhook subscriptions: no routes or bodies for event filters, secret rotation, the test ping or the replay of deliveries.',
  },
  {
    id: 'G77',
    section: '05 §6.2; 13 §10',
    kind: 'missing',
    text: '`GET /audit` and `GET /search`: parameters and results.',
  },
  {
    id: 'G78',
    section: '05 §6.2; 06 §2.1',
    kind: 'missing',
    text: '`GET /documents/{id}/connect` (06 §2.1) is absent from 05 §6.2.',
    seeAlso: 'Review 2026-11-06 §3 (06)',
    resolved:
      'Owner decision 200 (2026-11-15; docs/owner-decisions-2026-11-15.md): the hint is an address on the node lease row, falling back to rendezvous routing (ADR 0243). 05 §6.2 lists the route; its reply is `{ url, node, source }`, a shape the lane w5 proposes (BE-061).',
  },
  {
    id: 'G79',
    section: '05 §6.2; 07 §12; 05 §8.3',
    kind: 'contradiction',
    text: '07 §12 makes import a service-credential operation; 05 §6.2 does not mark `POST /documents/{id}/imports`, and 05 §8.3 lists an `imports` port for the component, which holds only a user token.',
    seeAlso: 'PRO open question 7',
  },
  {
    id: 'G80',
    section: '07 §12',
    kind: 'missing',
    text: "The authorisation matrix has no rows for reading grants or regions, read markers, activity, resolving asset URLs, deleting an export, editing a comment, changing a document's state, or any resource of 12.",
    seeAlso: 'PRM-056 notes',
  },
  {
    id: 'G81',
    section: '05 §6.2; 13 §5',
    kind: 'missing',
    text: 'No resource or event exists for comment reactions, which 13 §5 lists.',
    seeAlso: 'Review 2026-11-06 §1',
    resolved:
      'Owner decision 33 (2026-11-15) says to build them. ADR 0424 (proposed, 2026-11-25): feature `reactions`; `POST` and `DELETE /comments/{cid}/reactions/{reaction}` for one of six named reactions; `Comment.reactions`; the notification `comment.reacted`; no commit. The set of reactions is a proposal.',
  },
  // 05 §7 Events plane
  {
    id: 'G82',
    section: '05 §7',
    kind: 'missing',
    text: 'CloudEvents attributes: the value of `source`, whether `id` equals `webhook-id`, and whether `time` is set.',
  },
  {
    id: 'G83',
    section: '05 §7',
    kind: 'missing',
    text: 'The members of `data` per webhook beyond `seq`, including the member name for "the hash-chain head" of content changes.',
  },
  {
    id: 'G84',
    section: '05 §7',
    kind: 'missing',
    text: 'The throttle rate of `dep.commit.rejected`.',
    seeAlso: 'PRO open question 22',
  },
  {
    id: 'G85',
    section: '12 §10',
    kind: 'missing',
    text: 'Workflow webhooks are listed as `dep.workflow.sent` followed by bare names (`participant_activated`, …): their full names are not given.',
  },
  // 05 §8.3 Backend ports
  {
    id: 'G86',
    section: '05 §8.3; 03 §2',
    kind: 'ports',
    text: '`loadContent` resolves `{ seq, incarnation, cdm, doc }` without `requires`, which a reader MUST check before parsing (03 §2, §11.1).',
  },
  {
    id: 'G87',
    section: '05 §8.3',
    kind: 'ports',
    text: '`SyncChannel` exposes nothing of `ch.opened` (`head`, `incarnation`, `catchUp`, `inflight`), which the client needs to reload or resubmit.',
  },
  {
    id: 'G88',
    section: '05 §8.3',
    kind: 'ports',
    text: 'No port member carries `sync.caughtUp`, `sync.check`, `wf.changed` or `goaway`.',
  },
  {
    id: 'G89',
    section: '05 §8.3',
    kind: 'ports',
    text: '`ChannelState`, `Notification`, `Resume`, `Ack`, `SyncReject` and `Unsubscribe` are named but not defined; the order between the settlement of `submit()` and the `on…` callbacks is not stated, nor whether messages that arrive before a callback is registered are kept.',
  },
  {
    id: 'G90',
    section: '05 §8.3',
    kind: 'ports',
    text: '`AuthPort` and `PermissionsPort` have no members, and there is no port for grants, region states or the region list, although the grants dialog is in the editor (13 §5).',
    seeAlso: 'PRO open question 23',
  },
  {
    id: 'G91',
    section: '05 §8.3; 12 §10; 13 §6',
    kind: 'ports',
    text: 'The optional ports have no members; `fields` and `workflow` have resources only, `proofing` and `assistant` have prose only.',
  },
  {
    id: 'G92',
    section: '05 §8.1; 13 §5',
    kind: 'ports',
    text: 'The signatures of `resolveUsers` and `searchPrincipals`.',
    seeAlso: 'PRO open question 23',
  },
  {
    id: 'G93',
    section: '05 §8.3',
    kind: 'ports',
    text: 'What happens to an unanswered `submit()` when its channel closes, and whether `features` is known before `connect()`.',
  },
  // 12 §10
  {
    id: 'G94',
    section: '12 §10',
    kind: 'missing',
    text: 'The payload of `wf.changed` ("the workflow state and the participant\'s status").',
  },
  {
    id: 'G95',
    section: '12 §10',
    kind: 'missing',
    text: 'Workflow routes: how the actions `send`, `correct`, `resume`, `void` and `remind` are invoked, the methods of the participant routes (and that `/workflow/participants/{pid}` is relative to a document), the body of `sign`, and the responses of `evidence` and `final`.',
  },
  {
    id: 'G96',
    section: '12 §9, §10',
    kind: 'missing',
    text: 'Field resources: the list item and the field-values format, who may prefill, and the methods and bodies of `/templates` and `/bulk-sends`.',
  },
  // 03 and 01
  {
    id: 'G97',
    section: '03 §2; 04 §1; 05 §6.2',
    kind: 'missing',
    text: 'Whether the content a document is created with is the content at `seq` 0 or a snapshot commit at `seq` 1.',
    resolved: 'Decision D67 (packet A2, 2026-11-06, proposed): the content at `seq` 0.',
  },
  {
    id: 'G98',
    section: '01 §8; 12 §6.1',
    kind: 'example',
    text: 'The workflow example writes `deadline` without milliseconds and `sentHash` with a `sha256:` prefix, against the conventions of 01 §8.',
  },
  {
    id: 'G99',
    section: '05 §6.1, §6.2',
    kind: 'missing',
    text: '`PUT /documents/{id}/regions/{rid}/state` and `PUT /documents/{id}/read-marker` update resources that no route reads, so a client never receives the `ETag` their `If-Match` needs (the contract suite sends `If-Match: *`).',
  },
  {
    id: 'G100',
    section: '05 §6.2',
    kind: 'missing',
    text: 'The row for `/webhooks` and `/webhooks/{id}` lists GET, POST, PATCH and DELETE for both paths together. The definition reads GET and POST on the collection, and GET, PATCH and DELETE on one subscription.',
  },
  // Read restrictions (ADR 0019, proposed; spike S12), folded in on 2026-11-06.
  {
    id: 'G101',
    section: '05 §5.2, §6.2; ADR 0019',
    kind: 'contradiction',
    text: 'ADR 0019 adds a view token to `ch.opened` and `resume`, and a missing or different token forces a reload. The content resource carries no token, so a client that joins as 05 §5.2 says (content over REST, then a resume at its `seq`) is always reloaded once projections exist, and `catchUp: "stream"` is reachable only after a channel. Either `GET /documents/{id}/content` returns the `view`, or the full view is exempt from the rule. No feature announces read restrictions.',
    seeAlso: 'docs/spikes/2026-11-06-s12-read-restrictions.md',
  },
  {
    id: 'G102',
    section: '05 §5.3; ADR 0019',
    kind: 'missing',
    text: "For a read-restricted reader, `sync.commit` carries the steps of the reader's class, which are empty when a commit changed only hidden content, and `sync.ack` is always `rebased: true`. 05 §5.3 does not say that a `steps` commit may have no steps, and the scopes a reader may learn from a commit (filtered to the visible ones) appear in no DEP message yet.",
    seeAlso: 'ADR 0019, changes from spike S12',
  },
  {
    id: 'G103',
    section: '05 §5.2, §5.5, §5.8; ADR 0019',
    kind: 'contradiction',
    text: 'Under ADR 0019 a change of access that hides or reveals content closes the channel with `unavailable` and forces a reload on the next open, while 05 §5.5 says permission changes arrive as `perm.changed`, and 05 §5.8 tells a client to back off on `unavailable`. A client cannot tell this close from a room that moved, and no `reason` or code marks it.',
    seeAlso: 'ADR 0019, changes from spike S12',
  },
  // Found while building the data plane of phase 1b (packet A, 2026-11-06).
  {
    id: 'G120',
    section: '05 §5.2, §8.3; 03 §11.1',
    kind: 'ports',
    text: "`SyncPort.open(docId, { resume })` has no member for the features a client announces in `ch.open`, so a host can announce the CDM features its editor reads for one document only through its backend's construction options (`backend-dep` sends the same list in `hello` and in every `ch.open`). The room needs the list of every attached client to accept a commit that adds a feature (03 §11.1).",
  },
  {
    id: 'G121',
    section: '05 §1 rule 4, §2, §5.1; 03 §11.1',
    kind: 'missing',
    text: 'Protocol and CDM features share one namespace, but 05 does not say whether `welcome.features` and discovery list the CDM features the server can host. A client may use only announced features, so a server that lists none cannot open a document whose `requires` names one.',
  },
];

export const GAP_IDS: ReadonlySet<string> = new Set(GAPS.map((g) => g.id));
