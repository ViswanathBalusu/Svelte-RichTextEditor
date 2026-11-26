/**
 * Named shapes shared by the planes of DEP (05 §2 to §7). Each becomes one TypeScript type and one
 * schema component. Shapes owned by another epic are registered from their own module (frw.ts).
 */
import {
  CLOSE_CODES,
  CHANNEL_CLOSE_CODES,
  CHANNEL_REJECT_CODES,
  ERROR_CODES,
  codesFor,
} from './errors.ts';
import { FEATURE_NAMES } from './features.ts';
import {
  type NamedShape,
  anyOf,
  arr,
  bool,
  count,
  enm,
  external,
  int,
  lit,
  map,
  ms,
  nullable,
  obj,
  opt,
  ref,
  req,
  reqIf,
  scope,
  seq,
  str,
  text,
  timestamp,
  uuid7,
} from './shapes.ts';

export const CAPABILITIES = [
  'view',
  'comment',
  'suggest',
  'edit',
  'fill',
  'structure',
  'manage',
] as const;
export const DOC_ROLES = ['viewer', 'commenter', 'suggester', 'editor', 'owner', 'filler'] as const;
export const REGION_ROLES = ['viewer', 'commenter', 'suggester', 'editor'] as const;
export const RESTRICTIONS = ['no-export', 'no-copy', 'no-print'] as const;
export const STEP_TYPES = [
  'replace',
  'replaceAround',
  'addMark',
  'removeMark',
  'addNodeMark',
  'removeNodeMark',
  'attr',
] as const;
export const CLIENT_ORIGINS = [
  'input',
  'paste',
  'format',
  'undo',
  'redo',
  'suggestion.accept',
  'suggestion.reject',
  'fill',
  'assistant',
  // A change made by an extension through the document API (UX-049; owner decision 173).
  'extension',
] as const;
export const SERVER_ORIGINS = [
  'restore',
  'import',
  'migration',
  'repair',
  'sign',
  'rules',
  'prefill',
  'control',
] as const;
export const ENGINES = ['pm-steps/1'] as const;
/** Workflow states (12 §6.2). */
export const WORKFLOW_STATES = [
  'draft',
  'sent',
  'in_progress',
  'correcting',
  'completed',
  'finalised',
  'voided',
  'declined',
  'expired',
] as const;
export const PROTOCOL_VERSION = '1.0';
export const SUBPROTOCOL = 'dep.v1';

const PRO = 'PRO';
const named = (name: string, shape: NamedShape['shape'], owner = PRO): NamedShape => ({
  name,
  shape,
  owner,
});

export const COMMON_SHAPES: readonly NamedShape[] = [
  // --- Vocabulary -------------------------------------------------------------------------
  named('Capability', enm(CAPABILITIES, { doc: 'A capability (07 §1; 12 §4.1).', spec: '07 §1' })),
  named(
    'DocRole',
    enm(DOC_ROLES, {
      doc: 'A document-level role, carried in the `docs` claim (05 §3.1; 07 §2).',
      spec: '05 §3.1',
    }),
  ),
  named(
    'RegionRole',
    enm(REGION_ROLES, { doc: 'A role a region grant may give (07 §2).', spec: '07 §2' }),
  ),
  named(
    'Restriction',
    enm(RESTRICTIONS, {
      doc: 'An output restriction from the `restrict` claim (05 §3.1; 13 §5).',
      spec: '05 §3.1',
    }),
  ),
  named(
    'ScopeId',
    scope({
      doc: 'A scope identifier: `doc`, `body`, `defs`, `region:<id>`, `story:<id>` or `field:<id>` (05 §5.3), where `<id>` is a node identifier.',
      spec: '05 §5.3',
      gaps: ['G41'],
    }),
  ),
  named(
    'FeatureName',
    str({
      format: 'name',
      known: FEATURE_NAMES,
      doc: 'A feature name. Protocol and CDM features share one namespace; experimental names start with `x-` (05 §1).',
      spec: '05 §1, §2',
      gaps: ['G01'],
      decisions: ['D01'],
    }),
  ),
  named(
    'ErrorCode',
    enm(ERROR_CODES, { doc: 'A code of the error registry (05 §5.8).', spec: '05 §5.8' }),
  ),
  named(
    'CloseCode',
    anyOf(
      CLOSE_CODES.map((c) => lit(c.code, { doc: c.meaning })),
      { doc: 'A WebSocket close code (05 §5.7).', spec: '05 §5.7', gaps: ['G24'] },
    ),
  ),
  named('Capabilities', arr(ref('Capability'), { unique: true, doc: 'A set of capabilities.' })),

  // --- Permissions (05 §5.5) --------------------------------------------------------------
  named(
    'LeaseInfo',
    obj(
      {
        holder: req(text(), "The user who holds the lease: the host's `sub` (D42).", {
          gaps: ['G45'],
          decisions: ['D42'],
        }),
        expiresAt: req(timestamp(), 'When the lease ends unless it is extended.'),
      },
      { doc: 'A lease in `access.leases` (05 §5.5; 07 §10).', spec: '05 §5.5' },
    ),
  ),
  named(
    'FillAccess',
    obj(
      {
        participant: req(text(), 'The participant identifier (the `wfp` claim).', {
          gaps: ['G45', 'G59'],
        }),
        roles: req(arr(text()), 'Role placeholders the participant holds.'),
        active: req(bool(), 'Whether the participant is active in the workflow.'),
      },
      { doc: 'Fill permission in `access` (12 §4.1).', spec: '12 §4.1', gaps: ['G45'] },
    ),
  ),
  named(
    'Access',
    obj(
      {
        rev: req(
          count(),
          'Access revision of this connection; it increases whenever anything that feeds effective permissions changes.',
          {
            gaps: ['G44'],
            decisions: ['D12'],
          },
        ),
        asOfSeq: req(seq(), 'The sequence number whose region list this access describes.'),
        docRole: req(ref('DocRole'), 'The document-level role.'),
        caps: req(
          ref('Capabilities'),
          'Document-level capabilities, including `structure` and `manage`.',
        ),
        scopes: req(
          map(ref('Capabilities'), { keys: scope() }),
          'Capabilities per scope. Lists every region of the document; a region not listed is not editable until an access with `asOfSeq` at or after the commit that created it arrives.',
          { gaps: ['G43'], decisions: ['D11'] },
        ),
        leases: req(map(ref('LeaseInfo'), { keys: scope() }), 'Leases held, by region scope.', {
          gaps: ['G45'],
        }),
        fill: req(
          nullable(ref('FillAccess')),
          'Fill permission, or null when it does not apply (12 §4.1).',
        ),
        restrictions: req(
          arr(ref('Restriction'), { unique: true }),
          'Output restrictions; empty when none apply.',
        ),
      },
      {
        doc: 'Effective access, sent in `ch.opened` and as the whole payload of `perm.changed` (05 §5.5).',
        spec: '05 §5.5',
        gaps: ['G53'],
      },
    ),
  ),

  // --- Sync (05 §5.3; 04 §3) --------------------------------------------------------------
  named(
    'Step',
    obj(
      {
        stepType: req(
          str({ known: STEP_TYPES, minLength: 1 }),
          'The step type. The authority accepts only the seven known types and rejects any other with `invalid_op` (04 §4), so the wire format accepts any string.',
        ),
      },
      {
        doc: 'A step as produced by `Step.toJSON()` of the pinned prosemirror-transform release (04 §4). Validated by the authority, not by the envelope.',
        spec: '04 §4',
        openMembers: true,
      },
    ),
  ),
  named(
    'Origin',
    str({
      known: [...CLIENT_ORIGINS, ...SERVER_ORIGINS],
      minLength: 1,
      maxLength: 64,
      doc: 'Origin of a commit: a client hint (recorded, never trusted) or a server-reserved origin (04 §3.1).',
      spec: '04 §3.1',
    }),
  ),
  named(
    'Commit',
    obj(
      {
        id: req(
          uuid7(),
          'Commit identifier chosen by the client; reused unchanged when the same commit is resubmitted.',
        ),
        base: req(seq(), 'The `seq` the client had applied when it created the steps.'),
        steps: req(arr(ref('Step'), { minItems: 1 }), 'One to `maxStepsPerCommit` steps.'),
        origin: opt(ref('Origin'), 'A hint from the client.'),
      },
      {
        doc: 'A step commit as submitted: the payload of `sync.submit` (04 §3.1; 05 §5.3).',
        spec: '04 §3.1; 05 §5.3',
      },
    ),
  ),
  named(
    'Ack',
    obj(
      {
        id: req(uuid7(), 'The commit identifier.'),
        seq: req(seq({ min: 1 }), 'The sequence number assigned.'),
        serverTime: req(timestamp(), 'Server time of the commit (04 G6).'),
        rebased: req(
          bool(),
          'Whether the steps were rebased. Always true for a read-restricted reader, whose acknowledgement carries the steps of its class (ADR 0019, proposed).',
          { gaps: ['G33', 'G102'], decisions: ['D40'] },
        ),
        steps: reqIf(
          arr(ref('Step')),
          'rebased',
          true,
          'The mapped steps: required when `rebased` is true; an acknowledgement rebuilt for a duplicate always carries them.',
        ),
      },
      {
        doc: 'The payload of `sync.ack` (05 §5.3; 04 §7). `re` is the envelope `id` of the submit.',
        spec: '05 §5.3',
      },
    ),
  ),
  named(
    'QuotaKind',
    enm(
      [
        'connections',
        'openDocuments',
        'commitRate',
        'roomCpuBudget',
        'storage',
        'exportConcurrency',
        'exportMinutes',
      ],
      {
        doc: 'The kind of quota a refusal names: the dimensions of the tenant quotas (06 §12; owner decision 110).',
        spec: '06 §12; 05 §5.8',
      },
    ),
  ),
  named(
    'RejectAction',
    enm(['rebase', 'drop', 'reload', 'retry'], {
      doc: 'What the client does next (04 §8).',
      spec: '04 §8',
    }),
  ),
  named(
    'SyncReject',
    obj(
      {
        id: req(
          str(),
          'The commit identifier from the submit (it may be malformed, which is why it is not typed as a UUID).',
        ),
        code: req(
          enm(codesFor('sync'), { doc: 'A registry code with the sync surface.' }),
          undefined,
          { gaps: ['G34', 'G38'] },
        ),
        message: req(text(), 'A human-readable explanation.'),
        action: req(ref('RejectAction')),
        head: req(seq(), 'The current durable head.'),
        scopes: opt(
          arr(ref('ScopeId')),
          'Scopes involved, for `permission_denied`; never a scope the reader may not see.',
          { gaps: ['G41', 'G102'], decisions: ['D40'] },
        ),
        rule: opt(text(), 'The rule or constraint that failed (12 §5.3).', { gaps: ['G35'] }),
        retryAfterMs: opt(ms(), 'How long to wait before retrying.'),
        quota: opt(
          ref('QuotaKind'),
          'For `quota_exceeded` and a spent room CPU budget: the kind of quota reached (owner decision 110).',
        ),
      },
      {
        doc: 'The payload of `sync.reject` (05 §5.3; 04 §8). A commit whose base is older than a snapshot commit gets `stale_base` with action `rebase` (04 §3.2).',
        spec: '05 §5.3; 04 §3.2, §8',
      },
    ),
  ),
  named(
    'Author',
    obj(
      {
        user: req(
          text(),
          "The user the commit is attributed to: the host's `sub` (D42), or `system` (04 §10).",
          { decisions: ['D42'] },
        ),
        session: req(nullable(uuid7()), 'The session; null for server-authored commits.'),
        agent: req(nullable(text()), 'The assistant that acted for the user, or null (13 §6.2).', {
          gaps: ['G32'],
        }),
      },
      { doc: 'Server attribution of a commit (04 G6).', spec: '05 §5.3' },
    ),
  ),
  named(
    'ControlChange',
    obj(
      {
        type: req(
          str({ known: ['grants', 'region-state', 'lease', 'workflow', 'participant'] }),
          'What changed (04 §3.2 lists grants revisions, region states, lease breaks, workflow transitions and participant completion).',
        ),
        rev: opt(count(), 'The grants revision, for `type: "grants"` (05 §5.9).'),
      },
      {
        doc: 'The change a control commit records (04 §3.2). Only `{ "type": "grants", "rev": n }` appears in the prose.',
        spec: '04 §3.2; 05 §5.9',
        gaps: ['G32'],
        decisions: ['D10'],
        openMembers: true,
      },
    ),
  ),
  named(
    'RemoteCommit',
    obj(
      {
        seq: req(seq({ min: 1 })),
        kind: req(enm(['steps', 'control'])),
        id: req(uuid7()),
        steps: req(
          arr(ref('Step')),
          'The steps as applied; empty for a control commit. For a read-restricted reader, the steps of its class, which are empty when the commit changed only hidden content (ADR 0019, proposed).',
          { gaps: ['G102'], decisions: ['D40'] },
        ),
        control: req(
          nullable(ref('ControlChange')),
          'The change a control commit records; null for a step commit.',
        ),
        author: req(ref('Author')),
        serverTime: req(timestamp()),
        origin: req(ref('Origin')),
      },
      {
        doc: 'A stored commit as broadcast in `sync.commit` (05 §5.3).',
        spec: '05 §5.3',
        gaps: ['G32'],
        decisions: ['D10'],
      },
    ),
  ),
  named(
    'Resume',
    obj(
      {
        seq: req(seq(), 'The confirmed `seq` of the client.'),
        incarnation: req(text({ minLength: 1 }), 'The log incarnation the `seq` belongs to.', {
          gaps: ['G29'],
        }),
        inflight: opt(uuid7(), 'The in-flight commit, if any (04 §9).', {
          gaps: ['G27'],
          decisions: ['D08'],
        }),
        view: opt(
          text({ minLength: 1 }),
          'The `view` of the `ch.opened` the confirmed document came from (ADR 0019, proposed). Under read restrictions a missing or different token forces `catchUp: "reload"`.',
          { gaps: ['G101'], decisions: ['D28'] },
        ),
      },
      { doc: 'Where a client resumes a channel (05 §5.2; 04 §9).', spec: '05 §5.2; 04 §9' },
    ),
  ),
  named(
    'Inflight',
    obj(
      {
        state: req(enm(['accepted', 'unknown'])),
        seq: reqIf(
          seq({ min: 1 }),
          'state',
          'accepted',
          'The `seq` of the stored commit, when accepted.',
        ),
      },
      {
        doc: 'The fate of the in-flight commit named in `resume` (04 §9).',
        spec: '05 §5.2; 04 §9',
        gaps: ['G27'],
        decisions: ['D08'],
      },
    ),
  ),
  named(
    'CatchUp',
    enm(['stream', 'page', 'reload'], {
      doc: 'How a joining client catches up (05 §5.2).',
      spec: '05 §5.2',
    }),
  ),

  // --- Session (05 §5.1) ------------------------------------------------------------------
  named(
    'Limits',
    obj(
      {
        maxMessageBytes: req(
          count({ min: 1 }),
          'Largest UTF-8 size of one frame; larger messages are chunked.',
          { gaps: ['G18'] },
        ),
        maxCommitBytes: req(
          count({ min: 1 }),
          'Largest serialised commit (default 1 MiB, 04 §3.1).',
        ),
        maxStepsPerCommit: req(
          count({ min: 1 }),
          'Most steps in one commit (default 500, 04 §3.1).',
        ),
        maxRebaseSteps: req(
          count(),
          'Most steps a commit may be rebased over (default 5,000, 04 §5).',
        ),
        maxChannels: req(count({ min: 1 }), 'Most channels on one connection.', { gaps: ['G18'] }),
        heartbeatMs: req(ms(), 'Idle interval after which a side sends `ping` (default 25,000).'),
        ackTimeoutMs: req(
          ms(),
          'How long a client waits for an answer to a submit (default 15,000, 04 §8).',
        ),
        presenceHz: req(
          count(),
          'Most presence updates per second per client (default 10, 04 §11).',
        ),
        presenceBytes: req(count(), 'Largest presence state (default 1 KiB, 04 §11).'),
        catchUpCommits: req(count(), 'Most commits streamed on resume (default 5,000, 04 §9).'),
        catchUpBytes: req(count(), 'Most bytes streamed on resume (default 5 MiB, 04 §9).'),
      },
      { doc: 'Every limit a client must respect (05 §5.1).', spec: '05 §5.1', gaps: ['G53'] },
    ),
  ),
  named(
    'CdmRange',
    obj(
      { min: req(int({ min: 1 })), max: req(int({ min: 1 })) },
      { doc: 'A range of CDM major versions (05 §2).', spec: '05 §2' },
    ),
  ),
  named(
    'ClientInfo',
    obj(
      { name: req(text()), version: req(text()) },
      { doc: 'The client in `hello` (05 §5.1).', spec: '05 §5.1' },
    ),
  ),
  named(
    'SessionUser',
    obj(
      {
        id: req(text(), "The user identifier: the token's `sub` (D42).", { decisions: ['D42'] }),
        name: opt(text(), 'Display name, when the token has a `name` claim.', { gaps: ['G22'] }),
      },
      { doc: 'The user of a session (05 §5.1).', spec: '05 §5.1' },
    ),
  ),
  named(
    'ErrorPayload',
    obj(
      {
        code: req(enm(codesFor('socket'))),
        message: req(text()),
        retryable: req(bool()),
        retryAfterMs: opt(ms(), undefined, { gaps: ['G23'], decisions: ['D06'] }),
        quota: opt(
          ref('QuotaKind'),
          'For `quota_exceeded` and a spent room CPU budget: the kind of quota reached (owner decision 110).',
        ),
        fatal: req(bool(), 'A fatal error is followed by the matching close code (05 §5.7).', {
          gaps: ['G24'],
        }),
        versions: opt(
          arr(str({ format: 'version' })),
          "The server's versions, in the error before close 4406.",
          { gaps: ['G20'], decisions: ['D06'] },
        ),
      },
      { doc: 'The payload of `error` (05 §5.1).', spec: '05 §5.1' },
    ),
  ),

  // --- Channels (05 §5.2) -----------------------------------------------------------------
  named(
    'ChannelOpened',
    obj(
      {
        head: req(
          seq(),
          'The durable head when the channel was attached; the first live commit is `head + 1`.',
        ),
        incarnation: req(text({ minLength: 1 }), undefined, { gaps: ['G29'] }),
        catchUp: req(ref('CatchUp')),
        inflight: opt(ref('Inflight'), 'Present when `resume.inflight` was sent.', {
          gaps: ['G27'],
          decisions: ['D08'],
        }),
        access: req(ref('Access')),
        workflow: opt(ref('WorkflowStatus'), 'The workflow, if one applies (12).', {
          gaps: ['G28'],
        }),
        view: opt(
          text({ minLength: 1 }),
          'An opaque token naming the visibility class (the projection for this reader) that the content and stream of the channel belong to (ADR 0019, proposed). A client echoes it in a later resume.',
          { gaps: ['G101'], decisions: ['D28'] },
        ),
      },
      { doc: 'The payload of `ch.opened` (05 §5.2).', spec: '05 §5.2', gaps: ['G53'] },
    ),
  ),

  // `ch.opened` (05 §5.2) carries it, so the core defines it; FRW owns its contents (12 §10).
  named(
    'WorkflowStatus',
    obj(
      {
        state: req(enm(WORKFLOW_STATES)),
        rev: opt(count(), 'The workflow revision (12 §6.1).'),
        participant: opt(
          obj({
            id: req(text({ minLength: 1 })),
            state: req(
              str({
                known: ['active', 'unverified', 'completed', 'waiting', 'paused', 'copy', 'closed'],
              }),
              "The participant's own status: `active` (may act now), `unverified` (their turn, but the access code is still to be submitted), `waiting` (an earlier order first), `completed`, `paused` (while correcting), `closed` (the workflow ended), or `copy` (a `cc` participant). Never another participant's.",
            ),
          }),
          "The receiving participant's status.",
        ),
      },
      {
        doc: "The workflow state and the participant's status, carried by `wf.changed` and `ch.opened.workflow` (12 §6.2, §10).",
        spec: '12 §10',
        gaps: ['G94', 'G28'],
        decisions: ['D26'],
      },
    ),
    'FRW',
  ),

  // --- Notifications (05 §5.6) ------------------------------------------------------------
  named(
    'Notification',
    obj(
      {
        type: req(ref('NotificationType')),
        resource: req(
          str({ format: 'uri-reference' }),
          'The resource that changed, relative to `rest`.',
        ),
        rev: opt(count(), undefined, { gaps: ['G48'] }),
        data: opt(
          obj({}),
          "Small data; thread events carry the thread's current range and the `seq` it refers to.",
          { gaps: ['G48'] },
        ),
      },
      {
        doc: 'The payload of `event`: "this changed; fetch it over REST if you care" (05 §5.6).',
        spec: '05 §5.6',
        gaps: ['G47', 'G49'],
      },
    ),
  ),

  // --- Presence (05 §5.4) -----------------------------------------------------------------
  named(
    'PresenceState',
    obj(
      {
        selection: req(
          obj({ anchor: req(count()), head: req(count()) }),
          'Positions in the confirmed document at `seq`.',
          { gaps: ['G42'] },
        ),
        scope: req(text(), undefined, { gaps: ['G42'] }),
        status: req(enm(['active', 'idle'])),
      },
      { doc: 'What a client publishes about itself (05 §5.4).', spec: '05 §5.4' },
    ),
  ),
  named(
    'PresencePeer',
    obj(
      {
        session: req(uuid7()),
        user: req(ref('SessionUser')),
        seq: req(seq()),
        state: req(ref('PresenceState')),
      },
      {
        doc: 'A peer in `presence.state`; the server adds identity (05 §5.4).',
        spec: '05 §5.4',
        gaps: ['G42'],
      },
    ),
  ),

  // --- Control plane conventions (05 §6.1) ------------------------------------------------
  named(
    'ProblemDetails',
    obj(
      {
        type: req(str({ format: 'uri-reference' })),
        title: req(text()),
        status: req(int({ min: 400, max: 599 })),
        detail: opt(text()),
        instance: opt(str({ format: 'uri-reference' })),
        code: req(
          enm(codesFor('rest')),
          "A code of the registry (05 §5.8); `status` is the code's HTTP status in the registry (D61).",
        ),
        requestId: opt(
          text({ minLength: 1 }),
          'The request identifier, as in `DEP-Request-Id` (D71).',
          {
            decisions: ['D71'],
          },
        ),
        violations: opt(
          arr(
            obj({
              path: req(text(), 'A JSON Pointer into the request body.'),
              rule: req(text()),
              message: opt(
                text(),
                "For a field that does not pass when a participant completes (12 §5.3): the message the document's author gave for the pattern the value does not match (12 §3.2 `validation.message`). A text of the document's definitions, never a value.",
              ),
            }),
          ),
          'For `validation_failed`: where the body breaks which rule. Never the offending value (BE-088).',
          { decisions: ['D71'] },
        ),
        retryAfterMs: opt(
          ms(),
          'For `rate_limited` of the access code (FRW-039): how long to wait before retrying; `Retry-After` carries the same wait in whole seconds.',
        ),
        quota: opt(
          ref('QuotaKind'),
          'For `quota_exceeded`: the kind of quota reached (owner decision 110).',
        ),
      },
      {
        doc: 'RFC 9457 problem details with the `code` member (05 §6.1).',
        spec: '05 §6.1',
        gaps: ['G52'],
        decisions: ['D61', 'D71'],
      },
    ),
  ),
  named(
    'Discovery',
    obj(
      {
        versions: req(arr(str({ format: 'version' }), { minItems: 1 })),
        ws: req(str({ format: 'uri' }), 'The WebSocket address; the subprotocol is `dep.v1`.'),
        rest: req(
          str({ format: 'uri' }),
          'The complete REST base URL; resource paths are relative to it.',
        ),
        engines: req(arr(str({ known: ENGINES }), { minItems: 1 })),
        cdm: req(ref('CdmRange')),
        features: req(arr(ref('FeatureName'), { unique: true })),
        exportTargets: opt(
          arr(text({ minLength: 1 }), { unique: true }),
          'The export targets the deployment offers (`pdf`, `tex`, and others by name), present when the `exports` feature is announced. A client offers these and no other; a service refuses a target that is not in the list with `validation_failed`. Absent: the deployment does not say, and a client offers the PDF and the LaTeX bundle (UX-101; ADR 0382).',
        ),
        mode: req(
          enm(['authority', 'relay']),
          'A relay never announces `regions`, `suggest-enforced` or `fields` (04 §14).',
        ),
        jwks_uri: req(
          str({ format: 'uri' }),
          'The public keys of the tokens the service mints (`POST /tokens`), so that a host can check them. Never used to verify a host-signed token, whose keys come from the tenant registration (05 §3.1).',
          { decisions: ['D60'] },
        ),
      },
      {
        doc: 'The discovery document at `{endpoint}/.well-known/dep` (05 §2). Every member listed is required; it is the same for every tenant of the endpoint and needs no token (D66).',
        spec: '05 §2',
        decisions: ['D66'],
      },
    ),
  ),
  named(
    'Content',
    obj(
      {
        seq: req(seq()),
        incarnation: req(text({ minLength: 1 }), undefined, { gaps: ['G29'] }),
        cdm: req(int({ min: 1 }), 'CDM major version.'),
        requires: req(
          arr(ref('FeatureName')),
          'Features the document uses; a reader that lacks one MUST refuse it (03 §2).',
        ),
        doc: req(external('cdm-doc'), 'The document root, valid against the CDM schema.'),
        view: opt(
          text({ minLength: 1 }),
          "The view token of the reader's visibility class that this content belongs to (ADR 0019, proposed). A client resumes a channel opened from this content with it.",
          { gaps: ['G101'], decisions: ['D70'] },
        ),
      },
      {
        doc: 'Document content at a `seq` (05 §6.2): the CDM envelope plus `seq` and `incarnation`.',
        spec: '05 §6.2; 03 §2',
      },
    ),
  ),
  named(
    'CdmEnvelope',
    external('cdm-envelope', {
      doc: 'A CDM document as stored and transferred (03 §2).',
      spec: '03 §2',
    }),
  ),
];

/** Code lists by surface, for the codec and the ports. */
export const SYNC_REJECT_CODES = codesFor('sync');
export const SOCKET_ERROR_CODES = codesFor('socket');
export const REST_ERROR_CODES = codesFor('rest');
export { CHANNEL_CLOSE_CODES, CHANNEL_REJECT_CODES };
