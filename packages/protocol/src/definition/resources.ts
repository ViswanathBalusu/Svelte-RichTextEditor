/**
 * The control plane (05 §6), as data (PRO-002): every resource and method of the table in 05 §6.2,
 * with the conventions of 05 §6.1 (problem details, cursor lists, ETag and If-Match, idempotency
 * keys, credentials). Bodies the prose does not define are open placeholders marked with their gap
 * (decision D26).
 */
import {
  type Annotated,
  type NamedShape,
  type Prop,
  type Shape,
  any,
  anyOf,
  arr,
  bool,
  count,
  enm,
  int,
  map,
  nodeId,
  nullable,
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

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** User token (05 §3.1) or service credential (05 §3.2). */
export type Credential = 'user' | 'service';

export interface SuccessDef {
  /**
   * The success status (decision D61): 200 with a body, 201 for a request that creates a
   * resource, 202 for one that starts a job, 204 without a body. `2XX` remains only where neither
   * the prose nor a decision names one (the resources of 12 §10).
   */
  status: '200' | '201' | '202' | '204' | '2XX';
  body?: Shape;
  /** The body is a cursor list `{ items, nextCursor }` of `body` (05 §6.1). */
  list?: boolean;
  /** The response carries an `ETag` (05 §6.1: every mutable resource has one). */
  etag?: boolean;
}

export interface OperationDef extends Annotated {
  operationId: string;
  method: Method;
  path: string;
  /** Discovery lives at the endpoint, not under `rest`. */
  base?: 'endpoint';
  summary: string;
  spec: string;
  /** Accepted credentials; empty for discovery. */
  security: readonly Credential[];
  feature?: string;
  /** What 07 §12 requires, in its words. */
  requires?: string;
  /** Path parameters that differ from PATH_PARAMS. */
  params?: Record<string, Prop>;
  query?: Record<string, Prop>;
  body?: Shape;
  ifMatch?: 'required' | 'optional';
  /** Accepts `Idempotency-Key` (05 §6.1: POST requests that create something). */
  idempotencyKey?: boolean;
  success: SuccessDef;
  /** Problem codes the prose names for this route (G52). */
  codes?: readonly string[];
  owner: string;
}

/** Path parameters by name (01 §8 identifiers; 03 §9 node identifiers). */
export const PATH_PARAMS: Readonly<Record<string, Prop>> = {
  id: req(uuid7(), 'Document identifier.'),
  rid: req(nodeId(), 'Region identifier.'),
  tid: req(uuid7(), 'Thread identifier.'),
  cid: req(text({ minLength: 1 }), 'Comment identifier.', { gaps: ['G59'] }),
  aid: req(uuid7(), 'Asset identifier.'),
  jid: req(uuid7(), 'Job identifier.'),
  pid: req(text({ minLength: 1 }), 'Participant identifier.', { gaps: ['G59'] }),
  fid: req(nodeId(), 'Field identifier.'),
  bid: req(uuid7(), 'Bulk send identifier.'),
};

const PRO = 'PRO';
const BOTH: readonly Credential[] = ['user', 'service'];
const SERVICE: readonly Credential[] = ['service'];
const placeholder = (doc: string, gaps: string[], props: Record<string, Prop> = {}): Shape =>
  obj(props, { doc: `${doc} Placeholder: not defined by the prose.`, gaps, decisions: ['D26'] });
const named = (name: string, shape: Shape, owner = PRO): NamedShape => ({ name, shape, owner });

const DOCUMENT_STATES = ['active', 'locked', 'archived'];
const REGION_STATES = ['draft', 'in_review', 'approved'];
const PRINCIPAL_PATTERN = '^(user:.+|group:.+|everyone|role:.+)$';

export const REST_SHAPES: readonly NamedShape[] = [
  named(
    'TokenRequest',
    obj(
      {
        sub: req(
          text({ minLength: 1 }),
          'Opaque, stable user identifier; hosts SHOULD NOT use e-mail addresses.',
        ),
        docs: req(
          map(ref('DocRole'), { keys: uuid7(), maxEntries: 20 }),
          'Document identifiers (at most 20) mapped to the role in each.',
          { gaps: ['G10'] },
        ),
        name: opt(text()),
        grp: opt(arr(text()), 'Group identifiers.'),
        wfp: opt(text(), 'Workflow participant (12 §7).'),
        amr: opt(arr(text()), 'Authentication methods (12 §7).'),
        auth_time: opt(count(), 'When the host authenticated the participant (12 §7).'),
        access_since: opt(
          timestamp(),
          'For the history visibility setting `since_access` (08 §9).',
        ),
        restrict: opt(arr(ref('Restriction'), { unique: true })),
        expiresIn: opt(
          int({ min: 1, max: 900 }),
          'Lifetime in seconds; at most and by default 900 (15 minutes, 05 §3.1).',
          { decisions: ['D60'] },
        ),
      },
      {
        doc: 'The claims a host asks the service to mint (05 §3.1); member names are the claim names. The service sets `iss`, `aud`, `iat`, `exp`, `jti` and `tid` itself.',
        spec: '05 §3.1',
        decisions: ['D60'],
      },
    ),
  ),
  named(
    'TokenResponse',
    obj(
      {
        token: req(text({ minLength: 1 }), 'The minted user token (a JWS in compact form).'),
        expiresAt: req(timestamp(), 'Its `exp`.'),
      },
      { spec: '05 §3.1', decisions: ['D60'] },
    ),
  ),
  named(
    'RevokeRequest',
    obj(
      {
        sub: req(text({ minLength: 1 }), 'The user, as the `sub` claim names them.'),
        doc: opt(
          uuid7(),
          "Limits the watermark to this document: the user's tokens issued before it are refused for this document only.",
        ),
      },
      {
        doc: "Ends a user's access before the token expires (05 §3.3).",
        spec: '05 §3.3',
        decisions: ['D73'],
      },
    ),
  ),
  named(
    'CreateDocumentRequest',
    obj(
      {
        content: opt(
          ref('CdmEnvelope'),
          'Initial CDM content: the content at seq 0 (D67). Without it the document starts empty.',
        ),
        template: opt(
          uuid7(),
          'A template (`POST /templates`) to instantiate (12 §9; FRW-062): the new document is a fork of the template document at `templateSeq`.',
        ),
        templateSeq: opt(
          seq(),
          'With `template`: the seq of the template document to fork at, pinned and recorded. Default: the head.',
        ),
        participants: opt(
          arr(
            obj({
              id: req(text({ minLength: 1 })),
              roles: req(
                arr(text()),
                'The `role_def` identifiers of the template that the person holds.',
              ),
              kind: req(enm(['filler', 'signer', 'approver', 'cc'])),
              order: req(count()),
              sub: opt(text()),
              name: opt(text()),
              auth: opt(obj({ require: opt(arr(text())) })),
            }),
          ),
          'With `template`: participants bound to the roles of the template. They are stored as the draft workflow of the new document.',
        ),
        values: opt(
          map(any(), { keys: text() }),
          'With `template`: values to prefill by field key, in the same call. All or none are applied.',
        ),
        import: opt(
          uuid7(),
          'An asset to import. Refused with `validation_failed` until imports exist (EXP).',
        ),
        externalId: opt(
          text({ minLength: 1, maxLength: 255 }),
          "The host's identifier; unique in the tenant (`conflict` otherwise).",
        ),
        title: opt(text({ maxLength: 1000 }), 'The title; metadata, never content (03 §2).'),
        properties: opt(obj({}), 'Host-defined properties: any JSON object.'),
        classification: opt(text({ minLength: 1, maxLength: 200 }), 'The classification label.'),
      },
      {
        doc: 'Creates a document, optionally from CDM content, a template or an import (05 §6.2). At most one of `content`, `template` and `import`.',
        spec: '05 §6.2',
        decisions: ['D62', 'D67'],
      },
    ),
  ),
  named(
    'DocumentResource',
    obj(
      {
        id: req(uuid7()),
        externalId: req(nullable(text())),
        title: req(nullable(text())),
        properties: req(obj({}), 'Host-defined properties.'),
        classification: req(nullable(text()), 'The classification label (13 §10).'),
        state: req(enm(DOCUMENT_STATES)),
        cdm: req(int({ min: 1 }), 'CDM major version.'),
        requires: req(arr(ref('FeatureName')), 'Features the content uses (03 §2).'),
        createdAt: req(timestamp()),
        template: opt(
          obj({ id: req(uuid7()), seq: req(seq()) }),
          'Only in the answer to `POST /documents` with `template`: the template and the pinned seq the document was forked at (FRW-062).',
        ),
      },
      {
        doc: 'Document metadata (05 §6.2). Title, owner and timestamps live here, never in the CDM (03 §2). The ETag is the metadata revision.',
        spec: '05 §6.2',
        decisions: ['D62'],
      },
    ),
  ),
  named(
    'UpdateDocumentRequest',
    obj(
      {
        title: opt(nullable(text({ maxLength: 1000 }))),
        properties: opt(obj({}), 'Replaces the properties.'),
        classification: opt(nullable(text({ minLength: 1, maxLength: 200 }))),
        state: opt(
          enm(DOCUMENT_STATES),
          'A change of state raises the grants revision and is recorded as a control commit (07 §9).',
        ),
      },
      {
        doc: 'A JSON merge patch of the document resource: a member present replaces it, `null` clears it. Needs `manage` or a service credential.',
        spec: '05 §6.2',
        decisions: ['D62', 'D65'],
      },
    ),
  ),
  named(
    'RegionEditors',
    obj(
      {
        roles: req(
          arr(ref('DocRole'), { unique: true }),
          'Document roles that may edit the region by role alone (07 §4): `editor` and `owner` under `inherit`, `owner` under `restricted`; none while the region is approved.',
        ),
        principals: req(
          arr(str({ pattern: PRINCIPAL_PATTERN }), { unique: true }),
          'Principals with an `editor` grant on the region that has not expired; none while the region is approved.',
        ),
        leasedTo: opt(
          text(),
          'The holder of a lease on the region; while it holds, only they may edit (07 §10).',
          { decisions: ['D42'] },
        ),
      },
      {
        doc: '"Who can edit" a region (05 §6.2), from the region policy, its state, its lease and the stored grants; the document roles themselves are in the hosts\' tokens.',
        spec: '05 §6.2; 07 §4',
        decisions: ['D64'],
      },
    ),
  ),
  named(
    'RegionInfo',
    obj(
      {
        id: req(nodeId()),
        title: req(text()),
        policy: req(
          enm(['inherit', 'restricted', 'confidential']),
          'The region policy (07 §4); `confidential` comes from ADR 0019 (proposed).',
        ),
        order: req(count(), 'Position among the regions of the body, from 0, in document order.'),
        state: req(enm(REGION_STATES)),
        editors: opt(ref('RegionEditors'), 'Who can edit the region.'),
      },
      {
        doc: 'An entry of the derived region list, computed from the content at the head (05 §6.2).',
        spec: '05 §6.2',
        decisions: ['D64'],
      },
    ),
  ),
  named(
    'RegionGrant',
    obj(
      {
        region: req(nodeId()),
        principal: req(
          str({ pattern: PRINCIPAL_PATTERN }),
          '`user:<sub>`, `group:<id>`, `everyone` or `role:<id>` (07 §1).',
        ),
        role: req(ref('RegionRole')),
        expiresAt: opt(nullable(timestamp())),
      },
      {
        doc: 'A region grant: document, region, principal, role, optional expiry (07 §1).',
        spec: '07 §1',
      },
    ),
  ),
  named(
    'Grants',
    obj(
      {
        rev: req(
          count(),
          'The grants revision (07 §9): every change of grants, region states, leases or the document state raises it. The ETag is derived from it.',
        ),
        grants: req(arr(ref('RegionGrant'))),
      },
      {
        doc: 'The region grants of a document (05 §6.2). Once a PATCH has returned, no commit can be stored under the old revision (04 G7).',
        spec: '05 §6.2',
        decisions: ['D63'],
      },
    ),
  ),
  named(
    'GrantsPatch',
    obj(
      {
        grants: opt(
          arr(ref('RegionGrant')),
          'A JSON merge patch of the resource: the list replaces the current grants. A grant names an existing, unretired region; one grant per region and principal.',
        ),
      },
      { spec: '05 §6.2', decisions: ['D63'] },
    ),
  ),
  named('RegionStateRequest', obj({ state: req(enm(REGION_STATES)) }, { spec: '05 §6.2; 07 §11' })),
  named(
    'RegionState',
    obj(
      {
        state: req(enm(REGION_STATES)),
        seq: opt(seq(), 'For `approved`: the `seq` at approval (07 §11).'),
        hash: opt(
          str({ format: 'sha256' }),
          "For `approved`: the hash of the region's canonical content (07 §11).",
          { gaps: ['G36'] },
        ),
      },
      { spec: '07 §11' },
    ),
  ),
  named(
    'Lease',
    obj(
      {
        id: req(text({ minLength: 1 })),
        holder: req(text(), undefined, { decisions: ['D42'] }),
        expiresAt: req(timestamp()),
      },
      {
        doc: 'An exclusive-edit lease: an identifier, a holder and an expiry (07 §10).',
        spec: '07 §10',
        gaps: ['G66', 'G59'],
      },
    ),
  ),
  named('HistoryGroup', placeholder('A group of commits (08 §4).', ['G67'])),
  named(
    'Version',
    obj(
      {
        seq: req(seq()),
        kind: req(
          enm(['named', 'export', 'pre-restore', 'restore', 'import', 'sent', 'completed']),
        ),
        name: opt(text()),
        note: opt(text()),
      },
      {
        doc: 'A pointer to a `seq` with a kind (08 §4). No identifier is named.',
        spec: '08 §4',
        gaps: ['G67', 'G59'],
      },
    ),
  ),
  named(
    'CreateVersionRequest',
    obj(
      {
        seq: opt(seq(), 'Defaults to the head.'),
        name: req(text({ minLength: 1 })),
        note: opt(text()),
      },
      { spec: '05 §6.2' },
    ),
  ),
  named(
    'DiffSpan',
    obj(
      {
        op: req(enm(['insert', 'delete'])),
        at: req(count()),
        text: req(text()),
        user: req(text()),
        seq: req(seq()),
      },
      { spec: '08 §6', gaps: ['G68'] },
    ),
  ),
  named(
    'DiffChange',
    obj(
      {
        kind: req(str({ known: ['modified', 'added', 'removed', 'formatted', 'field'] })),
        blockId: opt(nodeId()),
        fieldId: opt(nodeId()),
        spans: opt(arr(ref('DiffSpan'))),
        attrs: opt(arr(text())),
        user: opt(text()),
        seq: opt(seq()),
      },
      {
        doc: 'One change of a comparison, keyed by block identifier (08 §6, from its example).',
        spec: '08 §6',
        gaps: ['G68'],
      },
    ),
  ),
  named(
    'Diff',
    obj(
      { fromSeq: req(seq()), toSeq: req(seq()), changes: req(arr(ref('DiffChange'))) },
      { spec: '08 §6', gaps: ['G68'] },
    ),
  ),
  named(
    'Attribution',
    placeholder('Who wrote which spans, for a region or a block range (08 §7).', ['G68']),
  ),
  named(
    'RestoreRequest',
    obj(
      {
        toSeq: req(seq()),
        region: opt(nodeId()),
        dryRun: opt(bool(), 'Returns the comparison a restore would produce (08 §8).'),
      },
      { spec: '05 §6.2; 08 §8' },
    ),
  ),
  named('RestoreResult', placeholder('The outcome of a restore (08 §8).', ['G69'])),
  named(
    'ForkRequest',
    obj(
      { atSeq: req(seq()) },
      {
        doc: 'Forks a document. The member for "whether grants are copied" is not named.',
        spec: '05 §6.2; 08 §8',
        gaps: ['G69'],
      },
    ),
  ),
  named(
    'ReadMarker',
    obj(
      { seq: req(seq()) },
      {
        doc: "The caller's last seen `seq`; it only moves forward (08 §10).",
        spec: '05 §6.2; 08 §10',
        gaps: ['G70'],
      },
    ),
  ),
  named(
    'ConnectHint',
    obj(
      {
        url: req(str(), 'The WebSocket URL to open the channel on.'),
        node: req(str(), 'The node the URL belongs to; empty when the service names no node.'),
        source: req(
          enm(['owner', 'routing', 'entry']),
          'Where the URL came from: the owner of the document, rendezvous routing over the live nodes, or the address of the service itself.',
        ),
      },
      {
        doc: 'Where a client should open its channel (06 §2.1). A hint only: it grants nothing.',
        spec: '05 §6.2; 06 §2.1',
      },
    ),
  ),
  named(
    'Activity',
    placeholder(
      "Changes and comment activity by other people since the caller's read marker (08 §10).",
      ['G70'],
    ),
  ),
  named('CommentInput', placeholder('A comment body; it may contain mentions (13 §5).', ['G71'])),
  named(
    'RangeTarget',
    obj(
      {
        range: req(
          obj({
            from: req(count()),
            to: req(count()),
            baseSeq: req(seq(), 'Within the rebase window.'),
          }),
        ),
      },
      { spec: '05 §6.2' },
    ),
  ),
  named('BlockTarget', obj({ block: req(nodeId()) }, { spec: '05 §6.2' })),
  named(
    'CreateThreadRequest',
    obj(
      {
        target: req(anyOf([ref('RangeTarget'), ref('BlockTarget')])),
        comment: req(ref('CommentInput'), 'The first comment. Placeholder name.'),
      },
      {
        doc: 'The room maps the range to the head and checks `comment` there (05 §6.2).',
        spec: '05 §6.2',
        gaps: ['G71'],
      },
    ),
  ),
  named(
    'Thread',
    obj(
      {
        id: req(uuid7()),
        state: req(enm(['open', 'resolved'])),
        assignee: opt(nullable(text())),
        target: opt(anyOf([ref('RangeTarget'), ref('BlockTarget')])),
      },
      { spec: '05 §6.2; 07 §6', gaps: ['G71'], decisions: ['D26'] },
    ),
  ),
  named(
    'UpdateThreadRequest',
    obj(
      { state: opt(enm(['open', 'resolved'])), assignee: opt(nullable(text())) },
      { spec: '05 §6.2', gaps: ['G71'] },
    ),
  ),
  named('Comment', placeholder('A comment.', ['G71', 'G59'], { id: req(text({ minLength: 1 })) })),
  named(
    'CreateAssetRequest',
    obj(
      {
        filename: req(text({ minLength: 1 })),
        mime: req(text({ minLength: 1 })),
        size: req(count()),
      },
      { spec: '05 §6.2' },
    ),
  ),
  named(
    'AssetUpload',
    placeholder(
      'An asset identifier and a size-bound pre-signed upload into a quarantine area (05 §6.2).',
      ['G72'],
      {
        asset: req(uuid7(), 'Placeholder name.'),
        upload: req(obj({ url: req(str({ format: 'uri' })) }), 'Placeholder name.'),
      },
    ),
  ),
  named(
    'ResolveAssetsRequest',
    obj(
      { assets: req(arr(uuid7()), 'Placeholder name.') },
      { spec: '05 §6.2', gaps: ['G72'], decisions: ['D26'] },
    ),
  ),
  named(
    'ResolvedAsset',
    obj(
      {
        asset: req(uuid7()),
        url: req(str({ format: 'uri' }), 'A signed URL, valid until `expiresAt`.'),
        expiresAt: req(timestamp()),
        contentType: req(str()),
      },
      { spec: '05 §6.2', gaps: ['G72'], decisions: ['D122'] },
    ),
  ),
  named(
    'ResolvedAssets',
    obj(
      { assets: req(arr(ref('ResolvedAsset'))) },
      { spec: '05 §6.2', gaps: ['G72'], decisions: ['D122'] },
    ),
  ),
  named(
    'ExportOptions',
    obj(
      {
        profile: opt(enm(['preview', 'final'])),
        suggestions: opt(enm(['accept', 'reject', 'markup'])),
        comments: opt(enm(['none', 'margin'])),
        fields: opt(enm(['flatten', 'blank']), 'Default `flatten`.'),
        tagging: opt(enm(['on', 'draft', 'off'])),
        pdfStandard: opt(str({ known: ['ua-2', 'a-4'] })),
        locale: opt(str({ format: 'language' })),
        timeZone: opt(text()),
        certificate: opt(bool(), 'Append the certificate of completion (12).'),
      },
      { doc: 'Export options (09 §9.1).', spec: '09 §9.1' },
    ),
  ),
  named(
    'CreateExportRequest',
    obj(
      {
        target: req(
          enm(['pdf', 'tex', 'docx', 'cdm', 'html', 'md']),
          'A target the server does not support is refused with `validation_failed`.',
        ),
        seq: opt(
          seq(),
          'Defaults to the head when the request is accepted; above the head is `validation_failed`.',
          { decisions: ['D68'] },
        ),
        options: opt(
          ref('ExportOptions'),
          '`options.suggestions` is required when the document has unresolved suggestions (`pending_suggestions`). Passed to the job unchanged.',
        ),
      },
      { spec: '05 §6.2; 09 §9.1' },
    ),
  ),
  named(
    'Diagnostic',
    obj(
      {
        severity: req(text()),
        code: req(text()),
        blockId: req(nullable(nodeId())),
        message: req(text()),
      },
      { doc: 'A compile diagnostic (09 §9.2).', spec: '09 §9.2' },
    ),
  ),
  named(
    'ExportResult',
    obj(
      {
        url: req(
          str({ format: 'uri' }),
          'A short-lived signed URL of the output, issued after the permission check of the request that returned it (10 §3.7).',
        ),
        expiresAt: req(timestamp(), 'When `url` and `layout` stop working.'),
        pages: req(nullable(count()), 'The page count; null for a target without pages.'),
        layout: req(
          nullable(str({ format: 'uri' })),
          'A signed URL of `layout.json` (09 §11); null when there is none.',
        ),
        converged: req(
          nullable(bool()),
          'Whether page references converged; null for a target without pages.',
        ),
        log: opt(
          str({ format: 'uri' }),
          'A signed URL of the raw compile log: only for the requester, and only while they have `edit` (09 §9.2; 07 §12).',
        ),
        chainHead: opt(
          nullable(str({ format: 'sha256' })),
          "The hash-chain head of the exported state, as in the export's manifest, so that a host can anchor it (08 §12); null when the log has no commit at that `seq`.",
        ),
        imagesWithoutAlt: opt(
          count(),
          'The number of images and figures without alternative text in the exported content, one per occurrence (09 §13). Each is also a diagnostic with the code `image_without_alt` and its block. Absent when the worker does not report it (a target that is not typeset).',
        ),
      },
      {
        doc: "The result of a completed export (09 §9.1). Warnings are in the job's `diagnostics`.",
        spec: '09 §9.1, §9.2',
        decisions: ['D68'],
      },
    ),
  ),
  named(
    'ExportJob',
    obj(
      {
        id: req(uuid7()),
        doc: req(uuid7(), 'The document.'),
        target: req(enm(['pdf', 'tex', 'docx', 'cdm', 'html', 'md'])),
        seq: req(
          seq(),
          'The content exported: the `seq` asked for, or the head when the request was accepted.',
        ),
        state: req(enm(['queued', 'converting', 'compiling', 'completed', 'failed', 'cancelled'])),
        progress: req(
          nullable(int({ min: 0, max: 100 })),
          'Per cent done, from the worker; null while unknown.',
        ),
        result: req(nullable(ref('ExportResult')), 'Set when `state` is `completed`.'),
        diagnostics: req(arr(ref('Diagnostic')), 'Warnings and errors (09 §9.2).'),
        error: opt(
          obj({ code: req(ref('ErrorCode')), message: req(text()) }),
          'Why the job failed, when `state` is `failed`.',
        ),
        createdAt: req(timestamp()),
        updatedAt: req(timestamp()),
      },
      {
        doc: 'An export job (05 §6.2; 09 §9.1). It belongs to its requester: only they, and service credentials of the tenant, may read or cancel it (review SR-C4).',
        spec: '05 §6.2; 09 §9.1',
        decisions: ['D68', 'D69'],
      },
    ),
  ),
  named(
    'CreateImportRequest',
    obj({ asset: req(uuid7()), format: req(enm(['docx'])) }, { spec: '05 §6.2' }),
  ),
  named(
    'ImportJob',
    placeholder('An import job; it returns warnings on completion (05 §6.2).', ['G74'], {
      id: req(uuid7()),
      warnings: opt(arr(obj({}))),
    }),
  ),
  named(
    'FontManifest',
    placeholder(
      'Font manifest: families, styles, file URLs, hashes, licences, manifest version (05 §6.2).',
      ['G75'],
    ),
  ),
  named(
    'WebhookSubscription',
    placeholder(
      'A webhook subscription: event filters, secret rotation, test ping, replay (05 §6.2).',
      ['G76', 'G59'],
    ),
  ),
  named('AuditEntry', placeholder('An audit entry (13 §10).', ['G77']), 'UX'),
  named('SearchResult', placeholder('A search result (13 §10).', ['G77']), 'UX'),
  // The retention policy (UX-080; 08 section 11). The prose gives the two behaviours and no field
  // names or periods: this shape is a proposal, recorded in docs/adr/0330-lane-U-UX-076-090.md.
  named(
    'RetentionPolicy',
    obj(
      {
        mode: req(
          enm(['keep_all', 'thin_payloads']),
          'keep_all keeps every commit payload (the default); thin_payloads keeps only checkpoints after afterDays.',
        ),
        afterDays: opt(
          int({ min: 1 }),
          'Days after which commit payloads are thinned. Required with thin_payloads and refused with keep_all.',
        ),
      },
      { doc: 'A retention policy (08 section 11; 13 section 10; UX-080).', spec: '08 §11; 13 §10' },
    ),
    'UX',
  ),
  named(
    'RetentionView',
    obj(
      {
        policy: req(
          nullable(ref('RetentionPolicy')),
          'The policy the document carries, or null when it carries none.',
        ),
        effective: req(
          ref('RetentionPolicy'),
          'The policy that applies: the document policy, else the tenant policy, else keep_all.',
        ),
        source: req(
          enm(['document', 'tenant', 'default']),
          'Where the effective policy comes from.',
        ),
      },
      {
        doc: 'A document retention policy with the effective policy (UX-080).',
        spec: '08 §11; 13 §10',
      },
    ),
    'UX',
  ),
  // The keys and origins a tenant registered (UX-077 criterion 4; 05 sections 3.2 and 4). Read only:
  // changes come from the registration (UX-091) until the administration API writes them (UX-076).
  named(
    'TenantKeyView',
    obj(
      {
        kid: req(text(), 'The key identifier.'),
        use: req(
          enm(['user', 'service']),
          'user keys verify user tokens; service keys verify service credentials.',
        ),
        alg: req(enm(['ES256', 'EdDSA', 'RS256']), 'The algorithm the key verifies.'),
        thumbprint: req(text(), 'The RFC 7638 thumbprint of the public key.'),
        issuer: req(nullable(text()), 'The iss the key verifies, or null.'),
        jwk: req(
          obj({}, { openMembers: true }),
          'The public key. Private material is never registered.',
        ),
      },
      {
        doc: 'A registered public key of a tenant (UX-077; 05 section 3.2).',
        spec: '05 §3.2; 13 §10',
      },
    ),
    'UX',
  ),
  named(
    'KeyList',
    obj(
      {
        keys: req(
          arr(ref('TenantKeyView')),
          'The keys of the tenant: user keys, then service keys.',
        ),
      },
      { doc: 'The public keys registered for a tenant (UX-077).', spec: '05 §3.2; 13 §10' },
    ),
    'UX',
  ),
  named(
    'OriginList',
    obj(
      { origins: req(arr(text()), 'The origins the tenant allows, in order.') },
      { doc: 'The allowed origins of a tenant (UX-077; 05 section 4).', spec: '05 §4; 13 §10' },
    ),
    'UX',
  ),
  // The registration of a key or an origin (UX-077 criterion 5; 05 sections 3.2 and 4). The shapes
  // are proposed in docs/adr/0372-w3-UX-077-key-origin-writes.md: the spec gives no body for them.
  named(
    'KeyRegistration',
    obj(
      {
        kid: req(text({ minLength: 1 }), 'The key identifier, unique within the tenant.'),
        use: req(
          enm(['user', 'service']),
          'user keys verify user tokens; service keys verify service credentials.',
        ),
        alg: req(
          enm(['ES256', 'EdDSA', 'RS256']),
          'The algorithm the key verifies; symmetric and other algorithms are refused.',
        ),
        jwk: req(
          obj({}, { openMembers: true }),
          'The public key as a JWK. A key with private members is refused.',
        ),
        issuer: opt(nullable(text()), 'The iss the key verifies, or null for any.'),
      },
      {
        doc: 'The public key a tenant administrator registers (UX-077; 05 section 3.2).',
        spec: '05 §3.2; 13 §10',
      },
    ),
    'UX',
  ),
  named(
    'OriginRegistration',
    obj(
      { origin: req(text({ minLength: 1 }), 'An origin: scheme, host and optional port.') },
      {
        doc: 'An origin a tenant administrator allows (UX-077; 05 section 4).',
        spec: '05 §4; 13 §10',
      },
    ),
    'UX',
  ),
  // The quota values of a tenant (UX-078 criterion 1; 06 section 12). The store keeps finite
  // numbers; the contract names whole numbers only, as a proposal (docs/adr/0330-lane-V-UX-076-090.md).
  named(
    'QuotaSettings',
    obj(
      {
        connections: opt(nullable(int({ min: 0 })), 'Connections a tenant may hold at once.'),
        openDocuments: opt(nullable(int({ min: 0 })), 'Documents a tenant may have open at once.'),
        commitRate: opt(nullable(int({ min: 0 })), 'Commits a tenant may make in one window.'),
        roomCpuBudget: opt(
          nullable(int({ min: 0 })),
          'Room CPU milliseconds a tenant may spend in one window.',
        ),
        storage: opt(nullable(int({ min: 0 })), 'Storage a tenant may use.'),
        exportConcurrency: opt(nullable(int({ min: 0 })), 'Export jobs a tenant may run at once.'),
        exportMinutes: opt(nullable(int({ min: 0 })), 'Export minutes a tenant may use.'),
      },
      {
        doc: 'The quota values of a tenant; a dimension is null when no value is set (UX-078; 06 section 12).',
        spec: '06 §12; 13 §10',
      },
    ),
    'UX',
  ),
  // A legal hold on a document (UX-080 criteria 2 and 3; 08 section 11). The shape is a proposal,
  // recorded in the story notes of UX-080; what a hold suspends is HIS-031.
  named(
    'HoldRequest',
    obj(
      {
        reason: req(
          text({ minLength: 1, maxLength: 500 }),
          'Why the document is held. Trimmed; at most 500 characters.',
        ),
      },
      {
        doc: 'The body of a legal hold (UX-080; 08 section 11; 13 section 10).',
        spec: '08 §11; 13 §10',
      },
    ),
    'UX',
  ),
  named(
    'Hold',
    obj(
      {
        id: req(uuid7(), 'The hold identifier.'),
        document: req(uuid7(), 'The held document.'),
        reason: req(text({ minLength: 1, maxLength: 500 }), 'The reason the hold was placed with.'),
        placedBy: req(text({ minLength: 1 }), 'The actor who placed the hold.'),
        placedAt: req(timestamp(), 'When the hold was placed, ISO 8601 in UTC.'),
      },
      {
        doc: 'A legal hold on a document (UX-080; 08 section 11; 13 section 10).',
        spec: '08 §11; 13 §10',
      },
    ),
    'UX',
  ),
  // Erasing a person (HIS-038 criterion 6; 08 section 13). The `sub` travels in the body and never
  // in a path, so that it stays out of access logs.
  named(
    'ErasePersonRequest',
    obj(
      {
        sub: req(
          text({ minLength: 1, maxLength: 255 }),
          "The host's `sub` of the person to erase. Hosts SHOULD NOT use an e-mail address as `sub` (05 section 3.1).",
        ),
      },
      {
        doc: 'The body of an erasure of a person (HIS-038; 08 section 13).',
        spec: '08 §13; 13 §10',
      },
    ),
    'HIS',
  ),
  named(
    'ErasePersonResult',
    obj(
      {
        outcome: req(
          enm(['erased', 'deferred']),
          '`erased`: the mapping, the display name and the read markers are deleted. `deferred`: a document the person wrote in is under legal hold, so the erasure waits for the release (owner decision 38).',
        ),
      },
      {
        doc: 'What an erasure of a person did (HIS-038; 08 section 13).',
        spec: '08 §13; 13 §10',
      },
    ),
    'HIS',
  ),
  // Replacing one commit's payload with a tombstone (HIS-040; 08 section 13).
  named(
    'TombstoneRequest',
    obj(
      {
        reason: req(
          text({ minLength: 1, maxLength: 500 }),
          'Why the payload is removed. Trimmed; at most 500 characters. Recorded in the audit trail.',
        ),
      },
      {
        doc: 'The body of a tombstone of one commit payload (HIS-040; 08 section 13).',
        spec: '08 §13; 13 §10',
      },
    ),
    'HIS',
  ),
  named(
    'TombstoneResult',
    obj(
      {
        seq: req(seq(), 'The commit whose payload was removed.'),
        removedAt: req(timestamp(), 'When the payload was removed, ISO 8601 in UTC.'),
        copies: req(
          obj(
            {
              checkpoints: req(
                arr(seq()),
                'Checkpoints at or after the commit, built by replaying it; they may still hold the removed text.',
              ),
              coldSegments: req(
                arr(text()),
                'Object keys of the cold segments whose range covers the commit.',
              ),
              attributionMap: req(
                enm(['may-hold-runs']),
                'The attribution map may still name runs of the commit.',
              ),
              involves: req(text(), 'What removing those copies involves, in fixed words.'),
            },
            { doc: 'The copies that may still hold the removed text; they are not rewritten.' },
          ),
        ),
      },
      {
        doc: 'What a tombstone removed and which copies remain (HIS-040; 08 section 13).',
        spec: '08 §13; 13 §10',
      },
    ),
    'HIS',
  ),
];

// Success statuses (decision D61): 200 with a body, 201 when a resource is created, 202 when a
// job is started, 204 without a body.
const list = (body: Shape, extra: Partial<SuccessDef> = {}): SuccessDef => ({
  status: '200',
  body,
  list: true,
  ...extra,
});
const ok = (body?: Shape, extra: Partial<SuccessDef> = {}): SuccessDef =>
  body ? { status: '200', body, ...extra } : { status: '204', ...extra };
const created = (body: Shape, extra: Partial<SuccessDef> = {}): SuccessDef => ({
  status: '201',
  body,
  ...extra,
});
const accepted = (body?: Shape): SuccessDef => (body ? { status: '202', body } : { status: '202' });

const op = (o: OperationDef): OperationDef => o;

export const OPERATIONS: readonly OperationDef[] = [
  op({
    operationId: 'getDiscovery',
    method: 'GET',
    path: '/.well-known/dep',
    base: 'endpoint',
    summary: 'Tells a client where things are and what the server supports.',
    spec: '05 §2',
    security: [],
    success: ok(ref('Discovery')),
    decisions: ['D66'],
    owner: PRO,
  }),
  op({
    operationId: 'createToken',
    method: 'POST',
    path: '/tokens',
    summary: 'Mints a user token for the host to pass to the page (service-minted tokens).',
    spec: '05 §3.1, §6.2',
    security: SERVICE,
    requires: 'Service credential',
    body: ref('TokenRequest'),
    success: ok(ref('TokenResponse')),
    gaps: ['G58'],
    decisions: ['D60'],
    owner: PRO,
  }),
  op({
    operationId: 'listDocuments',
    method: 'GET',
    path: '/documents',
    summary: 'Lists documents, filtered by `externalId`. The editor never lists documents.',
    spec: '05 §6.2',
    security: SERVICE,
    requires: 'Service credential',
    query: { externalId: opt(text()) },
    success: list(ref('DocumentResource')),
    owner: PRO,
  }),
  op({
    operationId: 'createDocument',
    method: 'POST',
    path: '/documents',
    summary: 'Creates a document, optionally from CDM content, a template or an import.',
    spec: '05 §6.2',
    security: SERVICE,
    requires: 'Service credential',
    body: ref('CreateDocumentRequest'),
    idempotencyKey: true,
    success: created(ref('DocumentResource'), { etag: true }),
    codes: ['idempotency_mismatch'],
    owner: PRO,
  }),
  op({
    operationId: 'getDocument',
    method: 'GET',
    path: '/documents/{id}',
    summary: 'Metadata, properties, classification label and state.',
    spec: '05 §6.2',
    security: BOTH,
    requires: 'view',
    success: ok(ref('DocumentResource'), { etag: true }),
    owner: PRO,
  }),
  op({
    operationId: 'updateDocument',
    method: 'PATCH',
    path: '/documents/{id}',
    summary:
      'Changes properties, the classification label or the state (`active`, `locked`, `archived`).',
    spec: '05 §6.2',
    security: BOTH,
    requires: 'manage, or a service credential',
    body: ref('UpdateDocumentRequest'),
    ifMatch: 'required',
    success: ok(ref('DocumentResource'), { etag: true }),
    gaps: ['G80'],
    decisions: ['D62', 'D65'],
    owner: PRO,
  }),
  op({
    operationId: 'deleteDocument',
    method: 'DELETE',
    path: '/documents/{id}',
    summary: 'Soft delete; purge follows the retention policy.',
    spec: '05 §6.2; 07 §12',
    security: BOTH,
    requires: 'manage',
    ifMatch: 'optional',
    success: ok(),
    gaps: ['G57'],
    decisions: ['D15'],
    owner: PRO,
  }),
  op({
    operationId: 'getContent',
    method: 'GET',
    path: '/documents/{id}/content',
    summary:
      'Content at the head, or with `?seq=N` a pinned, immutable, cacheable read. The ETag combines incarnation and seq.',
    spec: '05 §6.2, §5.2',
    security: BOTH,
    requires: 'view; for an earlier seq also the history-visibility gate (07 §8)',
    query: { seq: opt(seq(), 'A pinned read, which can never be stale.') },
    success: ok(ref('Content'), { etag: true }),
    decisions: ['D70'],
    owner: PRO,
  }),
  op({
    operationId: 'replaceContent',
    method: 'PUT',
    path: '/documents/{id}/content',
    summary:
      'Replaces content as a snapshot commit with origin `import`; clients receive `sync.reset`.',
    spec: '05 §6.2; 04 §3.2',
    security: SERVICE,
    requires: 'Service credential',
    body: ref('CdmEnvelope'),
    ifMatch: 'required',
    success: ok(),
    gaps: ['G62'],
    decisions: ['D15'],
    owner: PRO,
  }),
  op({
    operationId: 'listCommits',
    method: 'GET',
    path: '/documents/{id}/commits',
    summary: 'Paged catch-up after `after`. Subject to history visibility (07 §8).',
    spec: '05 §6.2, §5.2',
    security: BOTH,
    requires: 'view and the history-visibility gate (07 §8)',
    query: { after: req(seq(), 'Return commits with a greater seq.') },
    success: list(ref('RemoteCommit')),
    gaps: ['G55', 'G63'],
    owner: PRO,
  }),
  op({
    operationId: 'listRegions',
    method: 'GET',
    path: '/documents/{id}/regions',
    summary: 'Derived list: identifier, title, policy, order, state, who can edit.',
    spec: '05 §6.2',
    security: BOTH,
    feature: 'regions',
    requires: 'view',
    success: list(ref('RegionInfo')),
    gaps: ['G80'],
    decisions: ['D64', 'D65'],
    owner: PRO,
  }),
  op({
    operationId: 'setRegionState',
    method: 'PUT',
    path: '/documents/{id}/regions/{rid}/state',
    summary: 'Sets `draft`, `in_review` or `approved`.',
    spec: '05 §6.2; 07 §11',
    security: BOTH,
    feature: 'regions',
    requires: 'manage',
    body: ref('RegionStateRequest'),
    ifMatch: 'required',
    success: ok(ref('RegionState'), { etag: true }),
    gaps: ['G99'],
    decisions: ['D15'],
    owner: PRO,
  }),
  op({
    operationId: 'acquireLease',
    method: 'POST',
    path: '/documents/{id}/regions/{rid}/lease',
    summary: 'Acquires an exclusive-edit lease.',
    spec: '05 §6.2; 07 §10',
    security: BOTH,
    feature: 'leases',
    requires: 'edit in that region',
    idempotencyKey: true,
    success: created(ref('Lease'), { etag: true }),
    gaps: ['G66', 'G58'],
    owner: PRO,
  }),
  op({
    operationId: 'heartbeatLease',
    method: 'PUT',
    path: '/documents/{id}/regions/{rid}/lease',
    summary: 'Extends the lease (heartbeat), up to a total of eight hours.',
    spec: '05 §6.2; 07 §10',
    security: BOTH,
    feature: 'leases',
    ifMatch: 'required',
    success: ok(ref('Lease'), { etag: true }),
    gaps: ['G66', 'G57'],
    decisions: ['D15'],
    owner: PRO,
  }),
  op({
    operationId: 'releaseLease',
    method: 'DELETE',
    path: '/documents/{id}/regions/{rid}/lease',
    summary: 'Releases the lease; a user with `manage` breaks it.',
    spec: '05 §6.2; 07 §10',
    security: BOTH,
    feature: 'leases',
    requires: 'the holder, or manage to break a lease',
    ifMatch: 'optional',
    success: ok(),
    gaps: ['G66'],
    decisions: ['D15'],
    owner: PRO,
  }),
  op({
    operationId: 'getGrants',
    method: 'GET',
    path: '/documents/{id}/grants',
    summary: 'Region grants.',
    spec: '05 §6.2; 07 §1',
    security: BOTH,
    feature: 'regions',
    requires: 'manage, or a service credential',
    success: ok(ref('Grants'), { etag: true }),
    gaps: ['G80'],
    decisions: ['D63', 'D65'],
    owner: PRO,
  }),
  op({
    operationId: 'updateGrants',
    method: 'PATCH',
    path: '/documents/{id}/grants',
    summary:
      'Changes region grants. The response carries the new grants revision; once it has returned, no commit can be stored under the old revision (04 G7).',
    spec: '05 §6.2; 07 §9',
    security: BOTH,
    feature: 'regions',
    requires: 'manage',
    body: ref('GrantsPatch'),
    ifMatch: 'required',
    success: ok(ref('Grants'), { etag: true }),
    decisions: ['D63'],
    owner: PRO,
  }),
  op({
    operationId: 'revokeSessions',
    method: 'POST',
    path: '/sessions/revoke',
    summary:
      "Records a revocation watermark for a user; earlier tokens are refused on both planes and the room closes the user's channels.",
    spec: '05 §3.3, §6.2',
    security: SERVICE,
    requires: 'Service credential',
    body: ref('RevokeRequest'),
    success: ok(),
    decisions: ['D73'],
    owner: PRO,
  }),
  op({
    operationId: 'listHistory',
    method: 'GET',
    path: '/documents/{id}/history',
    summary: 'Grouped commits.',
    spec: '05 §6.2; 08 §4',
    security: BOTH,
    feature: 'history',
    requires: 'view and the history-visibility gate (07 §8)',
    query: {
      region: opt(nodeId()),
      field: opt(nodeId()),
      user: opt(text()),
      fromSeq: opt(seq()),
      toSeq: opt(seq()),
      namedOnly: opt(bool()),
    },
    success: list(ref('HistoryGroup')),
    gaps: ['G67'],
    owner: PRO,
  }),
  op({
    operationId: 'listVersions',
    method: 'GET',
    path: '/documents/{id}/versions',
    summary: 'Named versions.',
    spec: '05 §6.2; 08 §4',
    security: BOTH,
    feature: 'history',
    success: list(ref('Version')),
    owner: PRO,
  }),
  op({
    operationId: 'createVersion',
    method: 'POST',
    path: '/documents/{id}/versions',
    summary: 'Creates a named version.',
    spec: '05 §6.2; 08 §4',
    security: BOTH,
    feature: 'history',
    requires: 'edit somewhere in the document',
    body: ref('CreateVersionRequest'),
    idempotencyKey: true,
    success: created(ref('Version')),
    codes: ['idempotency_mismatch'],
    owner: PRO,
  }),
  op({
    operationId: 'getDiff',
    method: 'GET',
    path: '/documents/{id}/diff',
    summary: 'Compares two versions.',
    spec: '05 §6.2; 08 §6',
    security: BOTH,
    feature: 'history',
    requires: 'view and the history-visibility gate (07 §8)',
    query: {
      fromSeq: req(seq()),
      toSeq: req(seq()),
      region: opt(nodeId()),
      granularity: opt(enm(['word', 'char'])),
    },
    success: ok(ref('Diff')),
    gaps: ['G68'],
    owner: PRO,
  }),
  op({
    operationId: 'getAttribution',
    method: 'GET',
    path: '/documents/{id}/attribution',
    summary: 'Who wrote which spans, for a region or a block range.',
    spec: '05 §6.2; 08 §7',
    security: BOTH,
    feature: 'history',
    requires: 'view and the history-visibility gate (07 §8)',
    query: {
      region: opt(nodeId()),
      atSeq: opt(seq(), 'The version asked about; the head when omitted.'),
      blocks: opt(text(), 'Block identifiers, separated by commas (a block range).'),
    },
    success: ok(ref('Attribution')),
    gaps: ['G68'],
    owner: PRO,
  }),
  op({
    operationId: 'restore',
    method: 'POST',
    path: '/documents/{id}/restore',
    summary: 'Restores a document or a region; `dryRun` returns the comparison.',
    spec: '05 §6.2; 08 §8; 07 §13',
    security: BOTH,
    feature: 'history',
    requires:
      'edit in the region (not approved, not leased to someone else); manage for a whole document',
    body: ref('RestoreRequest'),
    success: ok(ref('RestoreResult')),
    gaps: ['G69', 'G58'],
    owner: PRO,
  }),
  op({
    operationId: 'forkDocument',
    method: 'POST',
    path: '/documents/{id}/fork',
    summary:
      'Creates a new document from the content at a seq. The component raises `de-fork-request` so the host can call it.',
    spec: '05 §6.2; 08 §8',
    security: SERVICE,
    requires: 'Service credential',
    body: ref('ForkRequest'),
    idempotencyKey: true,
    success: created(ref('DocumentResource')),
    gaps: ['G69'],
    owner: PRO,
  }),
  op({
    operationId: 'setReadMarker',
    method: 'PUT',
    path: '/documents/{id}/read-marker',
    summary: "Records the caller's last seen seq. It can only move forward.",
    spec: '05 §6.2; 08 §10',
    security: BOTH,
    body: ref('ReadMarker'),
    ifMatch: 'required',
    success: ok(ref('ReadMarker'), { etag: true }),
    gaps: ['G57', 'G70', 'G80', 'G99'],
    decisions: ['D15'],
    owner: PRO,
  }),
  op({
    operationId: 'getActivity',
    method: 'GET',
    path: '/documents/{id}/activity',
    summary: "Changes and comment activity by other people since the caller's read marker.",
    spec: '05 §6.2; 08 §10',
    security: BOTH,
    success: ok(ref('Activity')),
    gaps: ['G70', 'G80'],
    owner: PRO,
  }),
  op({
    operationId: 'getConnect',
    method: 'GET',
    path: '/documents/{id}/connect',
    summary: 'The WebSocket URL of the node that owns the document (a hint).',
    spec: '05 §6.2; 06 §2.1',
    security: BOTH,
    requires: 'view',
    success: ok(ref('ConnectHint')),
    owner: PRO,
  }),
  op({
    operationId: 'listThreads',
    method: 'GET',
    path: '/documents/{id}/threads',
    summary: 'Comment threads; `?seq` maps ranges to that seq.',
    spec: '05 §6.2; 07 §6',
    security: BOTH,
    feature: 'comments',
    query: { seq: opt(seq()) },
    success: list(ref('Thread')),
    gaps: ['G71'],
    owner: PRO,
  }),
  op({
    operationId: 'createThread',
    method: 'POST',
    path: '/documents/{id}/threads',
    summary:
      'Starts a thread on a range or a block, with the first comment. `baseSeq` must be within the rebase window.',
    spec: '05 §6.2; 07 §6',
    security: BOTH,
    feature: 'comments',
    requires: 'comment in the scopes of the target',
    body: ref('CreateThreadRequest'),
    idempotencyKey: true,
    success: created(ref('Thread'), { etag: true }),
    codes: ['idempotency_mismatch'],
    owner: PRO,
  }),
  op({
    operationId: 'getThread',
    method: 'GET',
    path: '/threads/{tid}',
    summary: "A thread. Resolved to its document; the caller's token must cover it (05 §6.1).",
    spec: '05 §6.2',
    security: BOTH,
    feature: 'comments',
    success: ok(ref('Thread'), { etag: true }),
    owner: PRO,
  }),
  op({
    operationId: 'updateThread',
    method: 'PATCH',
    path: '/threads/{tid}',
    summary: 'Changes `state` (`open`, `resolved`) or `assignee`.',
    spec: '05 §6.2; 07 §12',
    security: BOTH,
    feature: 'comments',
    requires: 'comment in its scope',
    body: ref('UpdateThreadRequest'),
    ifMatch: 'required',
    success: ok(ref('Thread'), { etag: true }),
    owner: PRO,
  }),
  op({
    operationId: 'deleteThread',
    method: 'DELETE',
    path: '/threads/{tid}',
    summary: 'Deletes a thread.',
    spec: '05 §6.2; 07 §12',
    security: BOTH,
    feature: 'comments',
    requires: 'the author or manage',
    ifMatch: 'optional',
    success: ok(),
    decisions: ['D15'],
    owner: PRO,
  }),
  op({
    operationId: 'createComment',
    method: 'POST',
    path: '/threads/{tid}/comments',
    summary: 'Replies to a thread; the body may contain mentions (13 §5).',
    spec: '05 §6.2; 13 §5',
    security: BOTH,
    feature: 'comments',
    requires: 'comment in the scopes of the target',
    body: ref('CommentInput'),
    idempotencyKey: true,
    success: created(ref('Comment'), { etag: true }),
    codes: ['idempotency_mismatch'],
    owner: PRO,
  }),
  op({
    operationId: 'updateComment',
    method: 'PATCH',
    path: '/comments/{cid}',
    summary: 'Edits a comment. Author only, or `manage`.',
    spec: '05 §6.2',
    security: BOTH,
    feature: 'comments',
    requires: 'the author or manage',
    body: ref('CommentInput'),
    ifMatch: 'required',
    success: ok(ref('Comment'), { etag: true }),
    gaps: ['G80'],
    owner: PRO,
  }),
  op({
    operationId: 'deleteComment',
    method: 'DELETE',
    path: '/comments/{cid}',
    summary: 'Deletes a comment. Author only, or `manage`.',
    spec: '05 §6.2',
    security: BOTH,
    feature: 'comments',
    requires: 'the author or manage',
    ifMatch: 'optional',
    success: ok(),
    decisions: ['D15'],
    owner: PRO,
  }),
  op({
    operationId: 'createAsset',
    method: 'POST',
    path: '/documents/{id}/assets',
    summary:
      'Returns an asset identifier and a size-bound pre-signed upload into a quarantine area.',
    spec: '05 §6.2; 06 §4.4',
    security: BOTH,
    feature: 'assets',
    requires: 'edit, suggest or fill somewhere in the document',
    body: ref('CreateAssetRequest'),
    idempotencyKey: true,
    success: created(ref('AssetUpload')),
    codes: ['idempotency_mismatch'],
    owner: PRO,
  }),
  op({
    operationId: 'completeAsset',
    method: 'POST',
    path: '/assets/{aid}/complete',
    summary:
      'The asset worker validates, re-encodes, hashes and stores the asset, then raises `asset.ready` or `asset.failed`.',
    spec: '05 §6.2',
    security: BOTH,
    feature: 'assets',
    success: accepted(),
    gaps: ['G72'],
    owner: PRO,
  }),
  op({
    operationId: 'resolveAssets',
    method: 'POST',
    path: '/documents/{id}/assets/resolve',
    summary: 'Returns short-lived signed URLs, because an `<img>` cannot send a bearer token.',
    spec: '05 §6.2',
    security: BOTH,
    feature: 'assets',
    requires: 'view on a document the asset is attached to',
    body: ref('ResolveAssetsRequest'),
    success: ok(ref('ResolvedAssets')),
    gaps: ['G72', 'G80'],
    owner: PRO,
  }),
  op({
    operationId: 'createExport',
    method: 'POST',
    path: '/documents/{id}/exports',
    summary:
      'Requests an export; returns 202 with a job. Refused for callers restricted with `no-export`.',
    spec: '05 §6.2; 09 §9.1',
    security: BOTH,
    feature: 'exports',
    requires: 'view, unless restricted with no-export; raw compile logs need edit',
    body: ref('CreateExportRequest'),
    idempotencyKey: true,
    success: accepted(ref('ExportJob')),
    codes: ['pending_suggestions', 'idempotency_mismatch'],
    decisions: ['D68', 'D69'],
    owner: PRO,
  }),
  op({
    operationId: 'getExport',
    method: 'GET',
    path: '/exports/{jid}',
    summary: 'State, progress, result, diagnostics.',
    spec: '05 §6.2; 09 §9.1',
    security: BOTH,
    feature: 'exports',
    requires: 'the requester, or a service credential (review SR-C4)',
    success: ok(ref('ExportJob'), { etag: true }),
    decisions: ['D69'],
    owner: PRO,
  }),
  op({
    operationId: 'cancelExport',
    method: 'DELETE',
    path: '/exports/{jid}',
    summary: 'Cancels an export job.',
    spec: '05 §6.2',
    security: BOTH,
    feature: 'exports',
    requires: 'the requester, or a service credential (review SR-C4)',
    ifMatch: 'optional',
    success: ok(),
    gaps: ['G80'],
    decisions: ['D15', 'D68', 'D69'],
    owner: PRO,
  }),
  op({
    operationId: 'createImport',
    method: 'POST',
    path: '/documents/{id}/imports',
    summary:
      'Imports a Word file from an uploaded asset; returns a job with warnings on completion.',
    spec: '05 §6.2; 07 §12; 09 §12',
    security: SERVICE,
    requires: 'Service credential (07 §12)',
    body: ref('CreateImportRequest'),
    idempotencyKey: true,
    success: accepted(ref('ImportJob')),
    codes: ['idempotency_mismatch'],
    gaps: ['G79'],
    decisions: ['D16'],
    owner: PRO,
  }),
  op({
    operationId: 'getImport',
    method: 'GET',
    path: '/imports/{jid}',
    summary: 'An import job.',
    spec: '05 §6.2',
    security: BOTH,
    success: ok(ref('ImportJob'), { etag: true }),
    gaps: ['G74'],
    owner: PRO,
  }),
  op({
    operationId: 'getFonts',
    method: 'GET',
    path: '/fonts',
    summary: 'Font manifest: families, styles, file URLs, hashes, licences, manifest version.',
    spec: '05 §6.2',
    security: BOTH,
    success: ok(ref('FontManifest')),
    gaps: ['G75', 'G06'],
    owner: PRO,
  }),
  op({
    operationId: 'listWebhooks',
    method: 'GET',
    path: '/webhooks',
    summary: 'Webhook subscriptions.',
    spec: '05 §6.2, §7',
    security: SERVICE,
    requires: 'Service credential',
    success: list(ref('WebhookSubscription')),
    gaps: ['G76'],
    owner: PRO,
  }),
  op({
    operationId: 'createWebhook',
    method: 'POST',
    path: '/webhooks',
    summary: 'Creates a webhook subscription.',
    spec: '05 §6.2, §7',
    security: SERVICE,
    requires: 'Service credential',
    body: ref('WebhookSubscription'),
    idempotencyKey: true,
    success: created(ref('WebhookSubscription'), { etag: true }),
    codes: ['idempotency_mismatch'],
    gaps: ['G76'],
    owner: PRO,
  }),
  ...(['GET', 'PATCH', 'DELETE'] as const).map((method) =>
    op({
      operationId: `${{ GET: 'get', PATCH: 'update', DELETE: 'delete' }[method]}Webhook`,
      method,
      path: '/webhooks/{id}',
      summary: {
        GET: 'A webhook subscription.',
        PATCH: 'Changes filters or rotates the secret.',
        DELETE: 'Deletes a subscription.',
      }[method],
      spec: '05 §6.2, §7',
      security: SERVICE,
      requires: 'Service credential',
      params: { id: req(text({ minLength: 1 }), 'Subscription identifier.', { gaps: ['G59'] }) },
      ...(method === 'PATCH'
        ? { body: ref('WebhookSubscription'), ifMatch: 'required' as const }
        : {}),
      ...(method === 'DELETE' ? { ifMatch: 'optional' as const } : {}),
      success: method === 'DELETE' ? ok() : ok(ref('WebhookSubscription'), { etag: true }),
      gaps: ['G76', 'G100'],
      owner: PRO,
    }),
  ),
  op({
    operationId: 'pingWebhook',
    method: 'POST',
    path: '/webhooks/{id}/ping',
    summary: 'Sends a test delivery to one subscription, marked as a test.',
    spec: '05 §6.2; 13 §10; ADR 0330 §2 (decision 177)',
    security: SERVICE,
    requires: 'Service credential',
    params: { id: req(text({ minLength: 1 }), 'Subscription identifier.', { gaps: ['G59'] }) },
    success: accepted(
      obj({ deliveryId: req(text({ minLength: 1 }), 'The identifier of the test delivery.') }),
    ),
    gaps: ['G76'],
    owner: PRO,
  }),
  op({
    operationId: 'replayWebhookDelivery',
    method: 'POST',
    path: '/webhooks/{id}/deliveries/{deliveryId}/replay',
    summary: 'Sends a recent delivery of the subscription again, under its own webhook-id.',
    spec: '05 §6.2; 13 §10; ADR 0330 §2 (decision 177)',
    security: SERVICE,
    requires: 'Service credential',
    params: {
      id: req(text({ minLength: 1 }), 'Subscription identifier.', { gaps: ['G59'] }),
      deliveryId: req(text({ minLength: 1 }), 'The delivery to send again.', { gaps: ['G59'] }),
    },
    success: accepted(
      obj({ deliveryId: req(text({ minLength: 1 }), 'The identifier of the delivery sent.') }),
    ),
    gaps: ['G76'],
    owner: PRO,
  }),
  op({
    operationId: 'getAudit',
    method: 'GET',
    path: '/audit',
    summary: 'The audit trail with filters (13 §10).',
    spec: '05 §6.2; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    query: {
      document: opt(uuid7(), 'Only events of this document.'),
      actor: opt(text(), 'Only events of this actor.'),
      kind: opt(text(), 'Only events of this kind (for example `grants.changed`).'),
      from: opt(
        text(),
        'Only events at or after this time: ISO 8601 with a time zone (inclusive).',
      ),
      to: opt(text(), 'Only events before this time: ISO 8601 with a time zone (exclusive).'),
    },
    success: list(ref('AuditEntry')),
    gaps: ['G77'],
    owner: 'UX',
  }),
  op({
    operationId: 'search',
    method: 'GET',
    path: '/search',
    summary: 'Search for service credentials, so a host can build its own catalogue (13 §10).',
    spec: '05 §6.2; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    success: list(ref('SearchResult')),
    gaps: ['G77'],
    owner: 'UX',
  }),
  op({
    operationId: 'getTenantRetention',
    method: 'GET',
    path: '/retention',
    summary: 'The tenant retention policy; keep_all when none is set (UX-080).',
    spec: '08 §11; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    success: ok(ref('RetentionPolicy'), { etag: true }),
    owner: 'UX',
  }),
  op({
    operationId: 'setTenantRetention',
    method: 'PUT',
    path: '/retention',
    summary: 'Sets the tenant retention policy; audited (UX-080).',
    spec: '08 §11; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    body: ref('RetentionPolicy'),
    ifMatch: 'required',
    success: ok(ref('RetentionPolicy'), { etag: true }),
    owner: 'UX',
  }),
  op({
    operationId: 'getDocumentRetention',
    method: 'GET',
    path: '/documents/{id}/retention',
    summary: 'A document retention policy and the effective policy that applies to it (UX-080).',
    spec: '08 §11; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    success: ok(ref('RetentionView'), { etag: true }),
    owner: 'UX',
  }),
  op({
    operationId: 'setDocumentRetention',
    method: 'PUT',
    path: '/documents/{id}/retention',
    summary: 'Sets the retention policy of one document; audited (UX-080).',
    spec: '08 §11; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    body: ref('RetentionPolicy'),
    ifMatch: 'required',
    success: ok(ref('RetentionView'), { etag: true }),
    owner: 'UX',
  }),
  op({
    operationId: 'getTenantOrigins',
    method: 'GET',
    path: '/origins',
    summary: 'The origins the tenant allows (UX-077).',
    spec: '05 §4; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    success: ok(ref('OriginList')),
    owner: 'UX',
  }),
  op({
    operationId: 'getTenantKeys',
    method: 'GET',
    path: '/keys',
    summary: 'The public keys registered for the tenant (UX-077).',
    spec: '05 §3.2; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    success: ok(ref('KeyList')),
    owner: 'UX',
  }),
  op({
    operationId: 'registerTenantKey',
    method: 'POST',
    path: '/keys',
    summary: 'Registers a public key for the tenant; audited (UX-077).',
    spec: '05 §3.2; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    body: ref('KeyRegistration'),
    idempotencyKey: true,
    success: created(ref('TenantKeyView')),
    codes: ['idempotency_mismatch', 'conflict'],
    owner: 'UX',
  }),
  op({
    operationId: 'removeTenantKey',
    method: 'DELETE',
    path: '/keys/{kid}',
    summary: 'Removes a registered key; tokens it signed are refused at once; audited (UX-077).',
    spec: '05 §3.2; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    params: { kid: req(text({ minLength: 1 }), 'The key identifier.') },
    ifMatch: 'optional',
    success: ok(),
    owner: 'UX',
  }),
  op({
    operationId: 'addTenantOrigin',
    method: 'POST',
    path: '/origins',
    summary: 'Allows an origin for the tenant; audited (UX-077).',
    spec: '05 §4; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    body: ref('OriginRegistration'),
    idempotencyKey: true,
    success: created(ref('OriginRegistration')),
    codes: ['idempotency_mismatch'],
    owner: 'UX',
  }),
  op({
    operationId: 'removeTenantOrigin',
    method: 'DELETE',
    path: '/origins/{origin}',
    summary:
      'Removes an allowed origin; the origin is percent-encoded in the path; audited (UX-077).',
    spec: '05 §4; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    params: { origin: req(text({ minLength: 1 }), 'The origin, percent-encoded.') },
    ifMatch: 'optional',
    success: ok(),
    owner: 'UX',
  }),
  op({
    operationId: 'getTenantQuotas',
    method: 'GET',
    path: '/quotas',
    summary: 'The tenant quota values; null for a dimension with no value (UX-078).',
    spec: '06 §12; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    success: ok(ref('QuotaSettings'), { etag: true }),
    owner: 'UX',
  }),
  op({
    operationId: 'setTenantQuotas',
    method: 'PUT',
    path: '/quotas',
    summary: 'Sets the quota values given; the others keep their value; audited (UX-078).',
    spec: '06 §12; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    body: ref('QuotaSettings'),
    ifMatch: 'required',
    success: ok(ref('QuotaSettings'), { etag: true }),
    owner: 'UX',
  }),
  op({
    operationId: 'placeHold',
    method: 'POST',
    path: '/documents/{id}/holds',
    summary: 'Places a legal hold on a document with a reason; audited (UX-080).',
    spec: '08 §11; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    body: ref('HoldRequest'),
    // 05 §6.1: a POST that creates something accepts `Idempotency-Key` (PRO-002 criterion 2).
    idempotencyKey: true,
    success: created(ref('Hold')),
    owner: 'UX',
  }),
  op({
    operationId: 'listHolds',
    method: 'GET',
    path: '/holds',
    summary: 'The legal holds of the tenant, one page at a time (UX-080).',
    spec: '08 §11; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    success: list(ref('Hold')),
    owner: 'UX',
  }),
  op({
    operationId: 'erasePerson',
    method: 'POST',
    path: '/users/erase',
    summary:
      'Erases a person: deletes their mapping row, display name and read markers; the log does not change; audited (HIS-038). A person in a document under legal hold is erased after the release (owner decision 38). An unknown `sub` is `not_found`.',
    spec: '08 §13; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    body: ref('ErasePersonRequest'),
    success: ok(ref('ErasePersonResult')),
    owner: 'HIS',
  }),
  op({
    operationId: 'tombstoneCommit',
    method: 'POST',
    path: '/documents/{id}/commits/{seq}/tombstone',
    params: { seq: req(seq(), 'The sequence number of the commit whose payload is removed.') },
    summary:
      'Replaces the payload of one commit with a tombstone; the metadata, the payload hash and the chain stay; refused under a legal hold; audited with the actor and the reason; the answer lists the copies that may still hold the text (HIS-040).',
    spec: '08 §13; 13 §10',
    security: SERVICE,
    requires: 'Service credential',
    body: ref('TombstoneRequest'),
    success: ok(ref('TombstoneResult')),
    owner: 'HIS',
  }),
];
