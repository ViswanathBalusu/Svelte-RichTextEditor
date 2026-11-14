/**
 * Messages of the real-time plane (05 §4, §5.1 to §5.6), as data (PRO-001). Every frame is one JSON
 * object, the envelope `{ t, id?, re?, ch?, d? }`; the definitions below say which envelope members
 * each type needs and what its payload `d` holds.
 */
import { CHANNEL_REJECT_CODES, codesFor } from './errors.ts';
import { ENGINES } from './common.ts';
import {
  type Annotated,
  type Shape,
  arr,
  count,
  enm,
  int,
  lit,
  ms,
  obj,
  opt,
  ref,
  req,
  seq,
  str,
  text,
  timestamp,
  uuid7,
} from './shapes.ts';

export type Direction = 'c2s' | 's2c' | 'both';

export interface MessageDef extends Annotated {
  /** The message type, the envelope member `t`. */
  t: string;
  dir: Direction;
  summary: string;
  spec: string;
  /** Channel-scoped messages carry the channel number `ch` (05 §4). */
  ch: 'required' | 'optional' | 'none';
  /** `id` is set by the sender on a message that expects a reply. */
  id: 'required' | 'optional';
  /** `re` is required on every reply; `none` marks a message that is never a reply. */
  re: 'required' | 'optional' | 'none';
  /** Message types that may answer this one. */
  replies?: readonly string[];
  /** The feature a client must see announced before it may send or expect the message. */
  feature?: string;
  /** The payload: a reference to a named shape, an inline object, or null for none. */
  payload: Shape | null;
  /** Name of the generated payload type for an inline payload. */
  payloadName?: string;
  owner: string;
}

const PRO = 'PRO';

export const MESSAGES: readonly MessageDef[] = [
  // --- 05 §5.1 Session --------------------------------------------------------------------
  {
    t: 'hello',
    dir: 'c2s',
    summary: 'Opens the session. Must be the first message, within 10 seconds.',
    spec: '05 §5.1',
    ch: 'none',
    id: 'required',
    re: 'none',
    replies: ['welcome', 'error'],
    payloadName: 'Hello',
    payload: obj({
      versions: req(
        arr(str({ format: 'version' }), { minItems: 1 }),
        'Protocol versions the client supports.',
      ),
      token: req(
        text({ minLength: 1 }),
        'The user token (a JWT, 05 §3.1). Tokens are never placed in URLs.',
      ),
      client: req(ref('ClientInfo')),
      engines: req(arr(str({ known: ENGINES }), { minItems: 1 })),
      cdm: req(ref('CdmRange')),
      features: req(arr(ref('FeatureName'), { unique: true })),
      traceparent: opt(text(), 'W3C trace context.'),
    }),
    owner: PRO,
  },
  {
    t: 'welcome',
    dir: 's2c',
    summary: 'Accepts the session.',
    spec: '05 §5.1',
    ch: 'none',
    id: 'optional',
    re: 'required',
    payloadName: 'Welcome',
    payload: obj(
      {
        version: req(str({ format: 'version' }), 'The version chosen.', { gaps: ['G20'] }),
        session: req(
          uuid7(),
          'A new identifier for every connection; there is no session resumption.',
        ),
        user: req(ref('SessionUser')),
        features: req(arr(ref('FeatureName'), { unique: true })),
        limits: req(ref('Limits')),
        tokenExp: req(timestamp(), 'When the token expires.', { gaps: ['G26'] }),
      },
      { gaps: ['G53'] },
    ),
    owner: PRO,
  },
  {
    t: 'auth.expiring',
    dir: 's2c',
    summary: 'Sent about 60 seconds before `tokenExp`.',
    spec: '05 §5.1',
    ch: 'none',
    id: 'optional',
    re: 'none',
    payloadName: 'AuthExpiring',
    payload: obj({ inMs: req(ms()) }),
    owner: PRO,
  },
  {
    t: 'auth.refresh',
    dir: 'c2s',
    summary: 'Presents a new token; with `ch`, a token for that channel.',
    spec: '05 §5.1, §3.1',
    ch: 'optional',
    id: 'required',
    re: 'none',
    replies: ['auth.ok', 'error'],
    payloadName: 'AuthRefresh',
    payload: obj({ token: req(text({ minLength: 1 })) }),
    gaps: ['G21', 'G10'],
    decisions: ['D07'],
    owner: PRO,
  },
  {
    t: 'auth.ok',
    dir: 's2c',
    summary: 'Reply to `auth.refresh`: the refreshed token is accepted.',
    spec: '05 §5.1',
    ch: 'optional',
    id: 'optional',
    re: 'required',
    payloadName: 'AuthOk',
    payload: obj({ tokenExp: req(timestamp(), undefined, { gaps: ['G26'] }) }),
    owner: PRO,
  },
  {
    t: 'auth.revoked',
    dir: 's2c',
    summary: 'The session was revoked; followed by close code 4401.',
    spec: '05 §5.1, §3.3',
    ch: 'none',
    id: 'optional',
    re: 'none',
    payloadName: 'AuthRevoked',
    payload: obj({ reason: req(text(), undefined, { gaps: ['G25'] }) }),
    owner: PRO,
  },
  {
    t: 'ping',
    dir: 'both',
    summary: 'Sent after `heartbeatMs` without sending anything; the peer answers `pong`.',
    spec: '05 §4, §5.1',
    ch: 'none',
    id: 'optional',
    re: 'none',
    replies: ['pong'],
    payload: null,
    gaps: ['G17', 'G12'],
    decisions: ['D02'],
    owner: PRO,
  },
  {
    t: 'pong',
    dir: 'both',
    summary: 'Answers `ping`.',
    spec: '05 §4, §5.1',
    ch: 'none',
    id: 'optional',
    re: 'optional',
    payload: null,
    gaps: ['G17', 'G12'],
    decisions: ['D02'],
    owner: PRO,
  },
  {
    t: 'goaway',
    dir: 's2c',
    summary: 'The whole connection is draining; never used for a single channel.',
    spec: '05 §5.1',
    ch: 'none',
    id: 'optional',
    re: 'none',
    payloadName: 'Goaway',
    payload: obj({ reconnectInMs: req(ms()), reason: req(text(), undefined, { gaps: ['G25'] }) }),
    owner: PRO,
  },
  {
    t: 'error',
    dir: 'both',
    summary:
      'A typed error; with `re` when it answers a message. A fatal error is followed by the matching close code.',
    spec: '05 §5.1, §5.7, §5.8',
    ch: 'optional',
    id: 'optional',
    re: 'optional',
    payload: ref('ErrorPayload'),
    gaps: ['G24'],
    owner: PRO,
  },
  {
    t: 'chunk',
    dir: 'both',
    summary:
      'One part of a message whose UTF-8 size exceeds `maxMessageBytes`; chunks of one message are sent consecutively; reassembly times out after 10 seconds.',
    spec: '05 §4',
    ch: 'none',
    id: 'optional',
    re: 'none',
    payloadName: 'Chunk',
    payload: obj({
      of: req(text({ minLength: 1 }), 'A fresh identifier shared by the chunks of one message.'),
      i: req(count(), 'Index of this chunk, from 0.'),
      n: req(int({ min: 2 }), 'Number of chunks.'),
      part: req(
        text(),
        'A substring of the serialised message, split only between Unicode code points.',
      ),
    }),
    gaps: ['G14'],
    decisions: ['D04'],
    owner: PRO,
  },

  // --- 05 §5.2 Channels -------------------------------------------------------------------
  {
    t: 'ch.open',
    dir: 'c2s',
    summary:
      'Opens a document channel. Without `resume` the server answers with `catchUp: "reload"`.',
    spec: '05 §5.2',
    ch: 'required',
    id: 'required',
    re: 'none',
    replies: ['ch.opened', 'ch.rejected', 'error'],
    payloadName: 'ChannelOpen',
    payload: obj(
      {
        kind: req(lit('doc')),
        doc: req(uuid7(), 'The document identifier.'),
        engine: req(str({ known: ENGINES })),
        cdm: req(int({ min: 1 }), 'The CDM version the client will use.'),
        features: req(arr(ref('FeatureName'), { unique: true })),
        resume: opt(ref('Resume')),
        token: opt(
          text({ minLength: 1 }),
          'A token for this channel; same `tid` and `sub` as the session (05 §3.1).',
          { gaps: ['G10'] },
        ),
      },
      { gaps: ['G53'] },
    ),
    gaps: ['G13'],
    owner: PRO,
  },
  {
    t: 'ch.opened',
    dir: 's2c',
    summary: 'The channel is attached; `head` is the durable head at that moment.',
    spec: '05 §5.2',
    ch: 'required',
    id: 'optional',
    re: 'required',
    payload: ref('ChannelOpened'),
    owner: PRO,
  },
  {
    t: 'ch.rejected',
    dir: 's2c',
    summary: 'The channel could not be opened.',
    spec: '05 §5.2',
    ch: 'required',
    id: 'optional',
    re: 'required',
    payloadName: 'ChannelRejected',
    payload: obj({ code: req(enm(CHANNEL_REJECT_CODES)), message: req(text()) }),
    owner: PRO,
  },
  {
    t: 'ch.close',
    dir: 'c2s',
    summary: 'Closes a channel.',
    spec: '05 §5.2',
    ch: 'required',
    id: 'optional',
    re: 'none',
    payload: null,
    gaps: ['G30', 'G12'],
    decisions: ['D02'],
    owner: PRO,
  },
  {
    t: 'ch.closed',
    dir: 's2c',
    summary:
      'The server closed a channel, for example `forbidden` after revocation, `unavailable` when the room moves or is fenced, `slow_consumer`. Under read restrictions (ADR 0019, proposed) a change of access that hides or reveals content also closes the channel with `unavailable`, and the next open reloads.',
    spec: '05 §5.2; ADR 0019',
    ch: 'required',
    id: 'optional',
    re: 'none',
    payloadName: 'ChannelClosed',
    payload: obj({
      code: req(enm(codesFor('channel-close')), undefined, { gaps: ['G31', 'G103'] }),
      reason: req(text(), undefined, { gaps: ['G25'] }),
      retryInMs: opt(ms()),
      cause: opt(
        str({ known: ['access_changed', 'fenced', 'lost', 'stopped'] }),
        'Why the server closed the channel. `access_changed`: what the reader may see changed (ADR 0019), so the client reopens without `resume`; the others say why a room stopped serving, and the client resumes as for `unavailable`.',
        { gaps: ['G103'], decisions: ['D41'] },
      ),
    }),
    gaps: ['G103'],
    decisions: ['D41'],
    owner: PRO,
  },

  // --- 05 §5.3 Sync (engine pm-steps/1) ---------------------------------------------------
  {
    t: 'sync.submit',
    dir: 'c2s',
    summary:
      'Submits a commit. The envelope `id` correlates the reply; the payload `id` identifies the commit.',
    spec: '05 §5.3; 04 §3.1',
    ch: 'required',
    id: 'required',
    re: 'none',
    replies: ['sync.ack', 'sync.reject', 'error'],
    payload: ref('Commit'),
    owner: PRO,
  },
  {
    t: 'sync.ack',
    dir: 's2c',
    summary:
      'The commit is stored; sent only after every commit with a lower `seq` on the channel.',
    spec: '05 §5.3; 04 §5 step 10, §7',
    ch: 'required',
    id: 'optional',
    re: 'required',
    payload: ref('Ack'),
    owner: PRO,
  },
  {
    t: 'sync.reject',
    dir: 's2c',
    summary:
      'The commit was refused; `action` says what to do next and `head` is the current head.',
    spec: '05 §5.3; 04 §8',
    ch: 'required',
    id: 'optional',
    re: 'required',
    payload: ref('SyncReject'),
    owner: PRO,
  },
  {
    t: 'sync.commit',
    dir: 's2c',
    summary:
      'Stored commits, in ascending `seq`; the next message continues at the last `seq` plus one.',
    spec: '05 §5.3; 04 §5 step 10',
    ch: 'required',
    id: 'optional',
    re: 'none',
    payloadName: 'SyncCommit',
    payload: obj({ commits: req(arr(ref('RemoteCommit'), { minItems: 1 })) }),
    owner: PRO,
  },
  {
    t: 'sync.caughtUp',
    dir: 's2c',
    summary: 'The catch-up stream is complete; live commits follow.',
    spec: '05 §5.2, §5.3',
    ch: 'required',
    id: 'optional',
    re: 'none',
    payloadName: 'SyncCaughtUp',
    payload: obj({ seq: req(seq()) }),
    owner: PRO,
  },
  {
    t: 'sync.reset',
    dir: 's2c',
    summary: 'A snapshot commit was stored; the client reloads content at `seq`.',
    spec: '05 §5.3; 04 §3.2',
    ch: 'required',
    id: 'optional',
    re: 'none',
    payloadName: 'SyncReset',
    payload: obj({
      seq: req(seq({ min: 1 })),
      reason: req(enm(['import', 'restore', 'migration', 'repair'])),
    }),
    owner: PRO,
  },
  {
    t: 'sync.check',
    dir: 's2c',
    summary:
      'The SHA-256 of the canonical form of the document at `seq`, for divergence detection (04 §13).',
    spec: '05 §5.3; 04 §13',
    ch: 'required',
    id: 'optional',
    re: 'none',
    payloadName: 'SyncCheck',
    payload: obj({
      seq: req(seq()),
      hash: req(str({ format: 'sha256' }), undefined, { gaps: ['G36'] }),
    }),
    owner: PRO,
  },

  // --- 05 §5.4 Presence -------------------------------------------------------------------
  {
    t: 'presence.update',
    dir: 'c2s',
    summary:
      "Publishes the client's selection; positions refer to the confirmed document at `seq`.",
    spec: '05 §5.4; 04 §11',
    ch: 'required',
    id: 'optional',
    re: 'none',
    feature: 'presence',
    payloadName: 'PresenceUpdate',
    payload: obj({ seq: req(seq()), state: req(ref('PresenceState')) }),
    owner: PRO,
  },
  {
    t: 'presence.state',
    dir: 's2c',
    summary:
      'Peers and sessions that left. The server adds identity and MAY drop or coalesce presence under load.',
    spec: '05 §5.4',
    ch: 'required',
    id: 'optional',
    re: 'none',
    feature: 'presence',
    payloadName: 'PresencePeers',
    payload: obj({ peers: req(arr(ref('PresencePeer'))), left: req(arr(uuid7())) }),
    gaps: ['G42'],
    owner: PRO,
  },

  // --- 05 §5.5 Permissions ----------------------------------------------------------------
  {
    t: 'perm.changed',
    dir: 's2c',
    summary:
      'A complete new `access` object. The server enforces it from the moment it computes it.',
    spec: '05 §5.5',
    ch: 'required',
    id: 'optional',
    re: 'none',
    payload: ref('Access'),
    gaps: ['G44', 'G46', 'G103'],
    decisions: ['D12'],
    owner: PRO,
  },

  // --- 05 §5.6 Notifications --------------------------------------------------------------
  {
    t: 'event',
    dir: 's2c',
    summary: '"This changed; fetch it over REST if you care."',
    spec: '05 §5.6',
    ch: 'required',
    id: 'optional',
    re: 'none',
    payload: ref('Notification'),
    gaps: ['G47'],
    owner: PRO,
  },
];
