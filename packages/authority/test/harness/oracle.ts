/**
 * The permission oracle for the property tests (PRM-017; 07 §5.1: "no sequence of commits from a
 * user may change a scope outside their writable set").
 *
 * Deliberately independent of the implementation under test:
 * - scopes are found by serialising each one to canonical JSON, never by object identity;
 * - capabilities are re-derived here from 07 §2 and §4 with their own role table;
 * - the suggestion baseline is computed as a character stream, not as a node tree.
 * Where a rule is not modelled here (noted inline), the oracle is more permissive than the spec, so
 * it can miss a violation of that rule but can never report a false one.
 */
import { canonicalize } from '@docedit/model';
import type { Node } from 'prosemirror-model';
import type { Connection, PermissionState } from '../../src/permissions/model.ts';

type Cap = 'view' | 'comment' | 'suggest' | 'edit' | 'fill' | 'structure' | 'manage';

const ROLES: Record<string, Cap[]> = {
  viewer: ['view'],
  commenter: ['view', 'comment'],
  suggester: ['view', 'comment', 'suggest'],
  filler: ['view', 'fill'],
  editor: ['view', 'comment', 'suggest', 'edit', 'fill', 'structure'],
  owner: ['view', 'comment', 'suggest', 'edit', 'fill', 'structure', 'manage'],
};
const REGION_CAPS: Cap[] = ['view', 'comment', 'suggest', 'edit'];

type J = Record<string, unknown>;

/** Every scope of a document as canonical JSON text. */
export function scopeTexts(doc: Node): Map<string, string> {
  const json = doc.toJSON() as J;
  const content = (json['content'] as J[]) ?? [];
  const out = new Map<string, string>();
  const defs = content[0]!;
  const body = content[content.length - 1]!;
  const stories = content.slice(1, -1);
  const stripValues = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(stripValues);
    if (n && typeof n === 'object') {
      const o = n as J;
      const copy: J = {};
      for (const [k, v] of Object.entries(o)) copy[k] = stripValues(v);
      if (o['type'] === 'form_field' && copy['attrs'])
        copy['attrs'] = { ...(copy['attrs'] as J), value: '<field>' };
      return copy;
    }
    return n;
  };
  const defKey = (d: J) => {
    const id = (d['attrs'] as J | undefined)?.['id'];
    return typeof id === 'string' ? `defs:${String(d['type'])}/${id}` : `defs:${String(d['type'])}`;
  };
  out.set(
    'doc',
    canonicalize({
      attrs: json['attrs'] ?? null,
      stories: stories.map((s) => (s['attrs'] as J)['id'] ?? null),
      body: body['attrs'] ?? null,
      // The definitions node itself: its attributes and the order of its children.
      defsAttrs: defs['attrs'] ?? null,
      defs: ((defs['content'] as J[]) ?? []).map(defKey),
    }),
  );
  for (const d of (defs['content'] as J[]) ?? []) out.set(defKey(d), canonicalize(d));
  for (const s of stories)
    out.set(`story:${String((s['attrs'] as J)['id'])}`, canonicalize(stripValues(s)));
  const bodyItems: unknown[] = [];
  for (const c of (body['content'] as J[]) ?? []) {
    if (c['type'] === 'region') {
      const id = String((c['attrs'] as J)['id']);
      bodyItems.push({ region: id });
      out.set(`region:${id}`, canonicalize(stripValues(c)));
    } else bodyItems.push(stripValues(c));
  }
  out.set('body', canonicalize(bodyItems));
  // Field values, wherever the field is.
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      const o = n as J;
      if (o['type'] === 'form_field') {
        const a = o['attrs'] as J;
        out.set(`field:${String(a['id'])}`, canonicalize(a['value'] ?? null));
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(body);
  for (const s of stories) walk(s);
  return out;
}

export function changedScopes(before: Node, after: Node): string[] {
  const a = scopeTexts(before);
  const b = scopeTexts(after);
  const out: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) out.push(k);
  return out.sort();
}

type Policy = 'inherit' | 'restricted' | 'confidential';

function regionPolicy(doc: Node, id: string): Policy | null {
  let p: Policy | null = null;
  doc.child(doc.childCount - 1).forEach((c) => {
    if (c.type.name === 'region' && c.attrs['id'] === id)
      p =
        c.attrs['policy'] === 'restricted'
          ? 'restricted'
          : c.attrs['policy'] === 'confidential'
            ? 'confidential'
            : 'inherit';
  });
  return p;
}

/** Whether one of the user's grants on the region matches now (07 §4, second paragraph). */
function holdsGrant(conn: Connection, perms: PermissionState, id: string, now: number): boolean {
  return perms.grants.some(
    (g) =>
      g.region === id &&
      ['viewer', 'commenter', 'suggester', 'editor'].includes(g.role) &&
      (g.expiresAt === null || now < g.expiresAt) &&
      (g.principal === 'everyone' ||
        g.principal === `user:${conn.sub}` ||
        (g.principal.startsWith('group:') && conn.groups.includes(g.principal.slice(6))) ||
        (g.principal.startsWith('role:') &&
          perms.workflowActive &&
          conn.participantRoles.includes(g.principal.slice(5)))),
  );
}

/**
 * ADR 0019 for a field value marked `sensitive`: "Proposed readers: the field's assignee role,
 * users with `manage`, and principals named by a grant." Grants exist only on regions, so a grant
 * names its principals as readers of the values inside that region (the reading ADR 0033 records).
 */
export function readsValue(
  conn: Connection,
  perms: PermissionState,
  field: Node,
  region: string | null,
  now: number,
): boolean {
  if (field.attrs['sensitive'] !== true) return true;
  if (ROLES[conn.role]!.includes('manage')) return true;
  if (
    typeof field.attrs['assignee'] === 'string' &&
    conn.participantRoles.includes(field.attrs['assignee'])
  )
    return true;
  return region !== null && holdsGrant(conn, perms, region, now);
}

/** 07 §4 for one user and one region, re-derived; ADR 0019 for confidential regions. */
export function regionCaps(
  conn: Connection,
  perms: PermissionState,
  id: string,
  policy: Policy,
  now: number,
): Set<Cap> {
  const role = ROLES[conn.role]!;
  let best: Cap[] | null = null;
  for (const g of perms.grants) {
    if (g.region !== id) continue;
    // 07 §2: region grants use the four region roles; any other grant conveys nothing.
    if (!['viewer', 'commenter', 'suggester', 'editor'].includes(g.role)) continue;
    if (g.expiresAt !== null && now >= g.expiresAt) continue;
    const match =
      g.principal === 'everyone' ||
      g.principal === `user:${conn.sub}` ||
      (g.principal.startsWith('group:') && conn.groups.includes(g.principal.slice(6))) ||
      (g.principal.startsWith('role:') &&
        perms.workflowActive &&
        conn.participantRoles.includes(g.principal.slice(5)));
    if (!match) continue;
    const c = ROLES[g.role]!.filter((x) => REGION_CAPS.includes(x));
    if (!best || c.length > best.length) best = c;
  }
  let caps: Set<Cap>;
  if (conn.role === 'owner') caps = new Set(REGION_CAPS);
  else if (policy === 'inherit')
    caps = new Set([...role, ...(best ?? [])].filter((c) => REGION_CAPS.includes(c)));
  else if (policy === 'restricted')
    caps = best ? new Set(best) : new Set(role.filter((c) => c === 'view' || c === 'comment'));
  // ADR 0019: grants convey `view` explicitly; with no matching grant, nothing but a placeholder.
  else caps = best ? new Set(best) : new Set();
  const frozen =
    (perms.regionStates.get(id) ?? 'draft') === 'approved' ||
    perms.leases.some((l) => l.region === id && l.expiresAt > now && l.holder !== conn.sub);
  if (frozen) caps = new Set([...caps].filter((c) => c === 'view' || c === 'comment'));
  if (perms.documentState !== 'active')
    caps = new Set(
      [...caps].filter(
        (c) => c === 'view' || (c === 'comment' && perms.documentState === 'locked'),
      ),
    );
  return caps;
}

function docCaps(conn: Connection, perms: PermissionState): Set<Cap> {
  const caps = new Set(ROLES[conn.role]!);
  if (perms.documentState !== 'active')
    return new Set([...caps].filter((c) => c === 'view' || c === 'comment' || c === 'fill'));
  return caps;
}

// -- suggestions as a character stream ------------------------------------------------------------

function baselineStream(nodes: Node[]): string {
  const out: string[] = [];
  const visit = (n: Node) => {
    const marks = n.marks;
    if (marks.some((m) => m.type.name === 'ins')) return;
    let formatting = marks
      .filter((m) => !['ins', 'del', 'fmt'].includes(m.type.name))
      .map((m) => canonicalize(m.toJSON()));
    let attrs: Record<string, unknown> = n.isText ? {} : { ...n.attrs };
    for (const f of marks.filter((m) => m.type.name === 'fmt')) {
      const before = f.attrs['before'] as {
        marks?: unknown[];
        attrs?: Record<string, unknown>;
      } | null;
      if (before?.marks) formatting = before.marks.map((m) => canonicalize(m));
      if (before?.attrs) attrs = { ...attrs, ...before.attrs };
    }
    formatting.sort();
    if (n.isText) {
      for (const ch of n.text ?? '') out.push(`${ch}|${formatting.join(',')}`);
      return;
    }
    if (n.type.name === 'form_field') attrs = { ...attrs, value: '<field>' };
    out.push(`<${n.type.name} ${canonicalize(attrs)} ${formatting.join(',')}>`);
    n.forEach(visit);
    out.push(`</${n.type.name}>`);
  };
  nodes.forEach(visit);
  return out.join('\n');
}

/**
 * The scope as a character stream with only the suggestions `rejected` selects taken back: their
 * `ins` content left out, their `del` marks dropped, their `fmt` changes restored to `before`;
 * every other suggestion mark stays, with its identifier and user. 07 §5.2 P4 asks that "other
 * users' suggestions and their marks MUST be unchanged" and that the baseline be unchanged: both
 * hold exactly when this stream, with the submitter's own suggestions taken back, is the same
 * before and after the commit (the reading of ADR 0050 item 2), written here as text.
 */
function streamWithout(nodes: Node[], rejected: (m: Node['marks'][number]) => boolean): string {
  const out: string[] = [];
  const SUGGESTIONS = ['ins', 'del', 'fmt'];
  const visit = (n: Node) => {
    const mine = n.marks.filter((m) => SUGGESTIONS.includes(m.type.name) && rejected(m));
    if (mine.some((m) => m.type.name === 'ins')) return;
    const kept = n.marks.filter((m) => !mine.includes(m));
    let plain = kept
      .filter((m) => !SUGGESTIONS.includes(m.type.name))
      .map((m) => canonicalize(m.toJSON()));
    const others = kept
      .filter((m) => SUGGESTIONS.includes(m.type.name))
      .map((m) => canonicalize(m.toJSON()));
    let attrs: Record<string, unknown> = n.isText ? {} : { ...n.attrs };
    for (const f of mine.filter((m) => m.type.name === 'fmt')) {
      const before = f.attrs['before'] as {
        marks?: unknown[];
        attrs?: Record<string, unknown>;
      } | null;
      if (before?.marks) plain = before.marks.map((m) => canonicalize(m));
      if (before?.attrs) attrs = { ...attrs, ...before.attrs };
    }
    const formatting = [...plain, ...others].sort().join(',');
    if (n.isText) {
      for (const ch of n.text ?? '') out.push(`${ch}|${formatting}`);
      return;
    }
    if (n.type.name === 'form_field') attrs = { ...attrs, value: '<field>' };
    out.push(`<${n.type.name} ${canonicalize(attrs)} ${formatting}>`);
    n.forEach(visit);
    out.push(`</${n.type.name}>`);
  };
  nodes.forEach(visit);
  return out.join('\n');
}

/** Whether a mark's `user` is an import label (07 §15; spike S11: `word:<author>`). */
export function isLabel(user: unknown): boolean {
  return typeof user === 'string' && /^word:./.test(user);
}

function othersMarks(nodes: Node[], user: string): string {
  const out: string[] = [];
  const visit = (n: Node) => {
    for (const m of n.marks) {
      if (!['ins', 'del', 'fmt'].includes(m.type.name) || m.attrs['user'] === user) continue;
      out.push(`${canonicalize(m.toJSON())}:${n.isText ? n.text : n.type.name}`);
    }
    n.forEach(visit);
  };
  nodes.forEach(visit);
  // Text nodes may be split differently; compare per mark, concatenated in order.
  const byMark = new Map<string, string>();
  for (const line of out) {
    const i = line.lastIndexOf('}:');
    const k = line.slice(0, i + 1);
    byMark.set(k, (byMark.get(k) ?? '') + line.slice(i + 2));
  }
  return canonicalize([...byMark.entries()].sort());
}

function scopeNodes(doc: Node, scope: string): Node[] {
  const body = doc.child(doc.childCount - 1);
  const out: Node[] = [];
  if (scope === 'body') body.forEach((c) => c.type.name !== 'region' && out.push(c));
  else if (scope.startsWith('region:'))
    body.forEach(
      (c) => c.type.name === 'region' && c.attrs['id'] === scope.slice(7) && out.push(c),
    );
  else if (scope.startsWith('story:'))
    doc.forEach((c) => c.type.name === 'story' && c.attrs['id'] === scope.slice(6) && out.push(c));
  return out;
}

function validSuggestion(
  before: Node,
  after: Node,
  scope: string,
  user: string,
  owners: Map<string, string>,
  importing = false,
): string | null {
  const b = scopeNodes(before, scope);
  const a = scopeNodes(after, scope);
  if (scope === 'body') {
    const regions = (d: Node) => {
      const ids: string[] = [];
      d.child(d.childCount - 1).forEach(
        (c) => c.type.name === 'region' && ids.push(String(c.attrs['id'])),
      );
      return ids.join(',');
    };
    if (regions(before) !== regions(after)) return 'regions changed';
  }
  // The user's own suggestions: marks naming them, and in an import the labels of new
  // identifiers (spike S11 change 6). A label never names a user.
  const own = (m: Node['marks'][number]) =>
    isLabel(m.attrs['user'])
      ? importing && !owners.has(String(m.attrs['id']))
      : m.attrs['user'] === user;
  if (streamWithout(b, own) !== streamWithout(a, own))
    return "changed other than through the user's own suggestions";
  if (!importing && baselineStream(b) !== baselineStream(a)) return 'baseline changed';
  if (!importing && othersMarks(b, user) !== othersMarks(a, user))
    return "another user's suggestion changed";
  let bad: string | null = null;
  const visit = (n: Node) => {
    for (const m of n.marks) {
      if (!['ins', 'del', 'fmt'].includes(m.type.name) || m.attrs['user'] !== user) continue;
      const owner = owners.get(String(m.attrs['id']));
      if (owner !== undefined && owner !== user)
        bad = `suggestion id ${String(m.attrs['id'])} belongs to ${owner}`;
    }
    n.forEach(visit);
  };
  a.forEach(visit);
  return bad;
}

function fieldNode(doc: Node, id: string): Node | null {
  let f: Node | null = null;
  doc.descendants((n) => {
    if (n.type.name === 'form_field' && n.attrs['id'] === id) f = n;
    return f === null;
  });
  return f;
}

function fieldContainer(doc: Node, id: string): string {
  let scope = 'body';
  doc.child(doc.childCount - 1).forEach((c) => {
    if (c.type.name !== 'region') return;
    c.descendants((n) => {
      if (n.type.name === 'form_field' && n.attrs['id'] === id)
        scope = `region:${String(c.attrs['id'])}`;
      return true;
    });
  });
  return scope;
}

export interface OracleCommit {
  user: Connection;
  perms: PermissionState;
  time: number;
  before: Node;
  after: Node;
  /** Suggestion identifier → owner, from the oracle's own replay. */
  owners: Map<string, string>;
  /** The commit's origin, and whether the server authored it (an import may name labels). */
  origin?: string;
  serverAuthored?: boolean;
  /**
   * The `field:<id>` scopes changed by commits accepted after this commit's `base` and before
   * it, from the oracle's own replay (P9). Left out, P9 is not checked.
   */
  fieldsChangedSinceBase?: ReadonlySet<string>;
}

/**
 * 03 §5 for every commit, whoever submits it: "The authority checks that `user` equals the
 * submitting user" and "A suggestion `id` belongs to the user who first used it". Every
 * suggestion mark of the result either uses an identifier that belongs to the user it names, or a
 * new identifier and names the submitter; an import may name a label instead (spike S11 change 6).
 */
function identityViolations(c: OracleCommit, importing: boolean): string[] {
  const out: string[] = [];
  const fresh = new Map<string, string>();
  c.after.descendants((n) => {
    for (const m of n.marks) {
      if (!['ins', 'del', 'fmt'].includes(m.type.name)) continue;
      const id = String(m.attrs['id']);
      const who = String(m.attrs['user']);
      const owner = c.owners.get(id) ?? fresh.get(id);
      if (owner !== undefined) {
        if (owner !== who) out.push(`suggestion ${id} names ${who}, but belongs to ${owner}`);
      } else if (isLabel(who) ? !importing : who !== c.user.sub)
        out.push(`a new suggestion ${id} names ${who}, not the submitter ${c.user.sub}`);
      else fresh.set(id, who);
    }
    return true;
  });
  return out;
}

// -- the writable set and its hooks ---------------------------------------------------------------

/** One changed scope of one commit, as a hook sees it. */
export interface WritableQuery {
  commit: OracleCommit;
  /** `body`, `region:<id>` or `field:<id>`; a field is asked about only when it exists on both sides. */
  scope: string;
  /** The submitter's document capabilities under the document's state. */
  caps: ReadonlySet<Cap>;
  /** Their capabilities in the scope, or for a field in the scope that contains it; null when unknown. */
  scopeCaps: ReadonlySet<Cap> | null;
  /** Whether P1 alone already lets the submitter change the scope (`edit` there, tracking not forced). */
  p1: boolean;
  /** `settings.trackChanges` is `everyone` (07 §5.2). */
  everyone: boolean;
  /** A server-authored import, which may name labels (spike S11). */
  importing: boolean;
}

/**
 * A rule beyond P1. It answers null when it says nothing about the change, an empty list when it
 * puts the scope in the submitter's writable set, and its violations otherwise. A changed scope is
 * accepted when P1 or some hook puts it in the writable set and no hook reports a violation; when
 * neither P1 nor any hook speaks for it, the oracle reports it as changed without the right.
 */
export type WritableHook = (q: WritableQuery) => string[] | null;

const HOOKS = new Map<string, WritableHook>();

/**
 * Registers a rule that extends (or narrows) the writable set of 07 §5.1 (PRM-017). The generator
 * and the suites do not change: they call `oracleViolations`, which asks every registered hook.
 * Returns a function that takes the rule out again.
 */
export function registerWritableHook(rule: string, hook: WritableHook): () => void {
  if (HOOKS.has(rule)) throw new Error(`the oracle already has a hook for ${rule}`);
  HOOKS.set(rule, hook);
  return () => {
    if (HOOKS.get(rule) === hook) HOOKS.delete(rule);
  };
}

/** The rules registered now, in order of registration. */
export function writableRules(): string[] {
  return [...HOOKS.keys()];
}

/** 07 §5.2 P4: with `suggest` but not `edit`, a scope may change only through one's own suggestions. */
export const p4Suggestions: WritableHook = (q) => {
  if (q.p1 || q.scope.startsWith('field:') || !q.scopeCaps?.has('suggest')) return null;
  const { commit: c } = q;
  const why = validSuggestion(c.before, c.after, q.scope, c.user.sub, c.owners, q.importing);
  return why ? [`${q.scope}: invalid suggestion (${why})`] : [];
};

/** 12 §4.2 P7: with `fill`, the value of a field assigned to one of the participant's roles. */
export const p7Fill: WritableHook = (q) => {
  if (q.p1 || !q.scope.startsWith('field:')) return null;
  const { user, perms, after } = q.commit;
  const field = fieldNode(after, q.scope.slice(6));
  const ok =
    q.caps.has('fill') &&
    (perms.documentState === 'active' || perms.workflowActive) &&
    user.participantActive &&
    typeof field?.attrs['assignee'] === 'string' &&
    user.participantRoles.includes(field.attrs['assignee']);
  return ok ? [] : null;
};

/**
 * 12 §4.2 P9: "If any commit accepted after the commit's `base` changed the same field, the commit
 * is rejected with `conflict`". It narrows the set, whoever writes the value; it says nothing when
 * the replay did not supply the fields changed since the base.
 */
export const p9ExclusiveFill: WritableHook = (q) => {
  if (!q.scope.startsWith('field:') || q.commit.serverAuthored === true) return null;
  return q.commit.fieldsChangedSinceBase?.has(q.scope)
    ? [`${q.scope}: changed although another commit changed it after the base (P9)`]
    : null;
};

registerWritableHook('P4', p4Suggestions);
registerWritableHook('P7', p7Fill);
registerWritableHook('P9', p9ExclusiveFill);

/**
 * Returns the violations of one stored commit: scopes changed outside the writable set. P1, P2,
 * P8 and the `manage` operations are here; every other rule is a registered hook.
 */
export function oracleViolations(
  c: OracleCommit,
  hooks: ReadonlyMap<string, WritableHook> = HOOKS,
): string[] {
  const { user, perms, time, before, after } = c;
  const caps = docCaps(user, perms);
  const everyone = before.child(0).child(0).attrs['trackChanges'] === 'everyone';
  const importing = c.serverAuthored === true && c.origin === 'import';
  const out: string[] = [...identityViolations(c, importing)];
  const regionCapsAt = (doc: Node, id: string) => {
    const p = regionPolicy(doc, id);
    return p ? regionCaps(user, perms, id, p, time) : null;
  };
  /** Asks P1 and every hook about one scope; `denied` is reported when nothing lets it change. */
  const ask = (scope: string, scopeCaps: Set<Cap> | null, p1: boolean, denied: string) => {
    let writable = p1;
    for (const hook of hooks.values()) {
      const said = hook({ commit: c, scope, caps, scopeCaps, p1, everyone, importing });
      if (said === null) continue;
      // A hook that judged the change has spoken for it: its violations replace `denied`.
      writable = true;
      out.push(...said);
    }
    if (!writable) out.push(denied);
  };
  for (const scope of changedScopes(before, after)) {
    if (scope === 'doc' || scope.startsWith('defs:') || scope.startsWith('story:')) {
      if (!caps.has('structure')) out.push(`${scope}: changed without structure`);
      // Not modelled here: 07 §5.3 (definitions used by protected regions).
      continue;
    }
    if (scope === 'body') {
      ask(scope, caps, caps.has('edit') && !everyone, 'body: changed without edit or suggest');
      continue;
    }
    if (scope.startsWith('region:')) {
      const id = scope.slice(7);
      const b = regionCapsAt(before, id);
      const a = regionCapsAt(after, id);
      if (b && a) {
        if (regionPolicy(before, id) !== regionPolicy(after, id) && !caps.has('manage'))
          out.push(`${scope}: policy changed without manage`);
        ask(scope, b, b.has('edit') && !everyone, `${scope}: changed without edit or suggest`);
      } else {
        // Added or removed: structure, edit in the body, edit in the region (P2).
        if (!caps.has('structure') || !caps.has('edit'))
          out.push(`${scope}: added or removed without structure and edit`);
        if (b && !b.has('edit')) out.push(`${scope}: removed without edit in it`);
        // 07 §16: flipping a region to restricted to lock others out needs `manage`, so creating
        // one does too; ADR 0019: so does confidential, which also hides the region.
        if (a && !b && regionPolicy(after, id) !== 'inherit' && !caps.has('manage'))
          out.push(`${scope}: ${String(regionPolicy(after, id))} region created without manage`);
      }
      continue;
    }
    if (scope.startsWith('field:')) {
      const id = scope.slice(6);
      const nb = fieldNode(before, id);
      const na = fieldNode(after, id);
      if (!nb || !na) continue; // a field added or removed changes its container, checked above
      const kind = String(na.attrs['kind']);
      if (['signature', 'initials', 'dateSigned', 'formula'].includes(kind)) {
        out.push(`${scope}: server-only kind changed by a user`);
        continue;
      }
      const container = fieldContainer(before, id);
      const containerCaps = container === 'body' ? caps : regionCapsAt(before, container.slice(7));
      ask(
        scope,
        containerCaps,
        containerCaps?.has('edit') === true && !perms.workflowActive && !everyone,
        `${scope}: filled without the fill rules`,
      );
    }
  }
  out.push(...fieldViolations(c));
  return out;
}

interface FieldAt {
  node: Node;
  /** `region:<id>` when the field is inside a region, `body` or `story:<id>` otherwise. */
  container: string;
}

/** Every form field of a document with the scope that contains it. */
function fieldsOf(doc: Node): Map<string, FieldAt> {
  const out = new Map<string, FieldAt>();
  doc.forEach((top) => {
    const walk = (n: Node, container: string) =>
      n.descendants((x) => {
        if (x.type.name === 'form_field') out.set(String(x.attrs['id']), { node: x, container });
        return true;
      });
    if (top.type.name === 'story') walk(top, `story:${String(top.attrs['id'])}`);
    if (top.type.name === 'body')
      top.forEach((block) =>
        block.type.name === 'region'
          ? walk(block, `region:${String(block.attrs['id'])}`)
          : walk(block, 'body'),
      );
  });
  return out;
}

const SERVER_KINDS = ['signature', 'initials', 'dateSigned', 'formula'];

/**
 * Rules on fields that the scope loop above does not see, because they concern attributes other
 * than the value or fields that appear or disappear:
 * - ADR 0019 (change 5): changing `sensitive` needs `manage`; a field that appears with it set
 *   changes it from its default;
 * - 12 §3.3 and P8: a client never sets the value of a signature, initials, date-signed or
 *   formula field, so a field of those kinds cannot appear with a value either (a pasted copy of a
 *   signed field), nor become one of those kinds while keeping a value;
 * - ADR 0019 (change 5): "an editor cannot change a value they cannot read"; the assignee, the
 *   container and every other attribute decide who reads it, so none may change (ADR 0033).
 */
function fieldViolations(c: OracleCommit): string[] {
  const { user, perms, time, before, after } = c;
  const caps = docCaps(user, perms);
  const fb = fieldsOf(before);
  const fa = fieldsOf(after);
  const out: string[] = [];
  const region = (container: string) =>
    container.startsWith('region:') ? container.slice(7) : null;
  for (const [id, a] of fa) {
    const b = fb.get(id);
    const scope = `field:${id}`;
    const was = b?.node.attrs['sensitive'] === true;
    const is = a.node.attrs['sensitive'] === true;
    if (was !== is && !caps.has('manage')) out.push(`${scope}: sensitive changed without manage`);
    const kind = String(a.node.attrs['kind']);
    const value = a.node.attrs['value'] ?? null;
    if (SERVER_KINDS.includes(kind) && value !== null) {
      const same =
        b !== undefined &&
        String(b.node.attrs['kind']) === kind &&
        canonicalize(b.node.attrs['value'] ?? null) === canonicalize(value);
      if (!same) out.push(`${scope}: a server-set ${kind} value set by a user`);
    }
    if (b && was && !readsValue(user, perms, b.node, region(b.container), time)) {
      const moved = a.container !== b.container;
      const changed =
        canonicalize(a.node.toJSON()) !== canonicalize(b.node.toJSON()) ||
        a.node.marks.length !== b.node.marks.length;
      if (moved || changed) out.push(`${scope}: a field whose value the user cannot read changed`);
    }
  }
  return out;
}
