/**
 * The region guard (02 §5.2; 07 §5.5, §7; FE-036): refuses a local transaction that changes a scope
 * the user cannot change, before anything is sent, so that a person normally never meets a
 * rejection. It is a convenience; the authority's outcome check (07 §5.1) is the boundary.
 *
 * The scopes a transaction touches are found as the authority finds them: by comparing the document
 * before and after (`diffScopes` from @docedit/authority, the same code the room runs), never from
 * the shape of the steps, so attribute and mark changes are caught too (FE-036 criterion 2). An
 * edit in place is compared without walking the whole document (scope-diff.ts; FE-118).
 *
 * Read restrictions (ADR 0019, "What a reader may not send"): a step that touches a placeholder of a
 * hidden region, a slice that carries a placeholder or a redacted value, and a change to a value the
 * reader cannot read are refused whatever the access says.
 */
import { ALLOWED_STEP_TYPES } from '@docedit/authority';
import { isRedactionMarker, type JsonValue } from '@docedit/model/definition';
import type { Access, Capability } from '@docedit/protocol';
import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import { AttrStep, ReplaceAroundStep, ReplaceStep, type Step } from 'prosemirror-transform';
import type { RefusalReason } from './api.ts';
import { INTERNAL, REMOTE } from './meta.ts';
import { PLACEHOLDER } from './schema.ts';
import { scopeDiff } from './scope-diff.ts';
import { flattenSteps } from './steps.ts';

export type { RefusalReason };

/** Why a local change was refused, for the interface to explain (FE-036 criterion 1). */
export interface Refusal {
  readonly reason: RefusalReason;
  /** The scopes that blocked it, as DEP scope identifiers (05 §5.3): `body`, `region:<id>`, … */
  readonly scopes: readonly string[];
  /** How many suggestions a suggestion-resolving command skipped (FE-047 criterion 6), when it counts them. */
  readonly count?: number;
}

export interface GuardContext {
  /** The access in force; null means no backend told the core anything, and nothing is refused. */
  access(): Access | null;
  readOnly(): boolean;
  /**
   * Whether only the values of form fields may change (the `fill` mode, 12 §4.2): any other
   * change is refused as read-only, whatever the access allows.
   */
  valuesOnly?(): boolean;
  refused(r: Refusal): void;
}

/** Whether a change from `before` to `after` touches nothing but the values of form fields. */
function onlyFieldValues(before: Node, after: Node): boolean {
  return scopeDiff(before, after).changed.every((scope) => scope.startsWith('field:'));
}

/** The capabilities that let a person change a scope in some way (07 §7: edit, suggest or fill). */
const WRITE: readonly Capability[] = ['edit', 'suggest', 'fill'];

const writes = (caps: readonly string[] | undefined): boolean =>
  caps !== undefined && caps.some((c) => (WRITE as readonly string[]).includes(c));

/**
 * Whether a capability list lets a person change something other than a form field value (12 §4.2,
 * FRW-076 criterion 1): `fill` alone does not. A participant who may only fill cannot type in the body.
 */
const editsText = (caps: readonly string[] | undefined): boolean =>
  caps !== undefined && caps.some((c) => c === 'edit' || c === 'suggest');

/**
 * Whether the fill permission (12 §4.2, rule P7) may change this field's value, as far as the
 * core can tell: the field is assigned to one of the participant's roles, the participant is
 * active, and the field is not static read-only. The authority's P7 check is the boundary; this
 * is the local refusal. With no fill access to read (`fill` null), the core leaves the decision to
 * the authority, as before.
 */
function fillMayChange(access: Access, field: Node | undefined): boolean {
  if (!field || !access.caps.includes('fill')) return false;
  const fill = access.fill;
  if (fill === null) return true;
  const assignee = field.attrs['assignee'];
  return (
    typeof assignee === 'string' &&
    fill.roles.includes(assignee) &&
    fill.active &&
    field.attrs['readOnly'] !== true
  );
}

/** The DEP scope of an authority scope: definitions are one `defs` scope in DEP (05 §5.3; G41). */
export function depScope(scope: string): string {
  return scope.startsWith('defs:') ? 'defs' : scope;
}

/**
 * The capabilities of a scope under an access. A region the access does not list is not editable
 * (05 §5.5: until an access with `asOfSeq` at or after the commit that created it arrives). `doc`,
 * `defs` and stories follow 07 §4 when the access does not list them: `edit` with `structure`.
 */
export function capsOf(access: Access, scope: string): readonly string[] {
  const listed = access.scopes[scope];
  if (listed) return listed;
  if (scope === 'doc' || scope === 'defs' || scope.startsWith('story:'))
    return access.caps.includes('structure') ? ['view', 'edit'] : ['view'];
  if (scope === 'body') return access.caps;
  return [];
}

/** Whether the user may change a scope (02 §5.1 `canEdit`). */
export function canWrite(access: Access | null, readOnly: boolean, scope: string): boolean {
  if (readOnly) return false;
  if (!access) return true;
  return writes(capsOf(access, depScope(scope)));
}

/** The capabilities a region created by the transaction itself will have (07 §4). */
function newRegionCaps(access: Access, policy: unknown): readonly string[] {
  if (policy === 'inherit' || policy === undefined || policy === null)
    return capsOf(access, 'body');
  // restricted or confidential: no grant can match a region that does not exist yet.
  return access.docRole === 'owner'
    ? ['view', 'comment', 'suggest', 'edit']
    : access.caps.filter((c) => c === 'view' || c === 'comment');
}

interface PlaceholderInfo {
  id: unknown;
  title: unknown;
}

function placeholders(doc: Node): PlaceholderInfo[] {
  const out: PlaceholderInfo[] = [];
  const body = doc.lastChild;
  body?.forEach((child) => {
    if (child.type.name === PLACEHOLDER)
      out.push({ id: child.attrs['id'], title: child.attrs['title'] });
  });
  return out;
}

function carries(node: Node, test: (n: Node) => boolean): boolean {
  if (test(node)) return true;
  let found = false;
  node.descendants((child) => {
    if (!found && test(child)) found = true;
    return !found;
  });
  return found;
}

const isPlaceholder = (n: Node): boolean => n.type.name === PLACEHOLDER;
const isFootnote = (n: Node): boolean => n.type.name === 'footnote';

/** Whether a replace step inserts inside a footnote or a caption of the document it applies to. */
function insideNoteOrCaption(doc: Node | undefined, step: Step): boolean {
  if (!doc || !(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) return false;
  const $from = doc.resolve(Math.min(step.from, doc.content.size));
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === 'footnote' || name === 'caption') return true;
  }
  return false;
}
/** A table, or a page or column break: what a footnote may not hold (I10, 03 §8; FE-058). */
const isNoteBlocker = (n: Node): boolean =>
  n.type.name === 'table' || (n.type.name === 'break' && n.attrs['kind'] !== 'line');

/** Whether a replace step inserts a table or a page or column break inside a footnote (FE-058). */
function insertsBlockerInFootnote(doc: Node | undefined, step: Step): boolean {
  if (!doc || !(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) return false;
  const $from = doc.resolve(Math.min(step.from, doc.content.size));
  let inFootnote = false;
  for (let d = $from.depth; d > 0; d--)
    if ($from.node(d).type.name === 'footnote') inFootnote = true;
  return inFootnote && sliceCarries(step, isNoteBlocker);
}

const hasRedacted = (n: Node): boolean =>
  Object.values(n.attrs).some((v) => isRedactionMarker(v as JsonValue | undefined));

function sliceCarries(step: Step, test: (n: Node) => boolean): boolean {
  if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) return false;
  let found = false;
  step.slice.content.forEach((n) => {
    if (!found && carries(n, test)) found = true;
  });
  return found;
}

/**
 * Checks a local change from `before` to `after` made by `steps` (each applied to the document the
 * previous one produced, starting from `before`). Returns the refusal, or null.
 */
export function checkChange(
  before: Node,
  after: Node,
  steps: readonly Step[],
  docs: readonly Node[],
  access: Access | null,
  readOnly: boolean,
): Refusal | null {
  if (readOnly) return { reason: 'read-only', scopes: [] };

  // ADR 0019: nothing that touches or carries a placeholder or a redacted value.
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    // 04 §4: the authority accepts seven step types only (`docAttr` is refused). A `markSet` step
    // is sent as its inner steps (steps.ts), so those are what must be allowed.
    for (const inner of flattenSteps([step])) {
      const type = (inner.toJSON() as { stepType?: unknown }).stepType;
      if (typeof type !== 'string' || !ALLOWED_STEP_TYPES.includes(type))
        return { reason: 'step', scopes: [] };
    }
    if (sliceCarries(step, isPlaceholder)) return { reason: 'placeholder', scopes: [] };
    if (sliceCarries(step, hasRedacted)) return { reason: 'redacted', scopes: [] };
    if (step instanceof AttrStep) {
      const node = docs[i]?.nodeAt(step.pos);
      if (
        isRedactionMarker(step.value as JsonValue) ||
        (node && isRedactionMarker(node.attrs[step.attr] as JsonValue | undefined))
      )
        return { reason: 'redacted', scopes: [] };
    }
    // I10: no footnote inside a footnote or a caption (03 §8), whichever way it arrives (a paste
    // into the footnote panel, inserted content).
    if (sliceCarries(step, isFootnote) && insideNoteOrCaption(docs[i], step))
      return { reason: 'invariant', scopes: [] };
    // I10 (03 §8, §13; FE-058): a footnote takes no table and no page or column break.
    if (insertsBlockerInFootnote(docs[i], step)) return { reason: 'invariant', scopes: [] };
  }
  const was = placeholders(before);
  const now = placeholders(after);
  if (
    was.length !== now.length ||
    was.some((p, i) => p.id !== now[i]!.id || p.title !== now[i]!.title)
  ) {
    const ids = new Set([...was, ...now].map((p) => String(p.id)));
    return { reason: 'placeholder', scopes: [...ids].map((id) => `region:${id}`) };
  }

  if (!access) return null;
  const diff = scopeDiff(before, after);
  if (diff.changed.length === 0) return null;
  const added = new Map(diff.regionsAdded.map((r) => [`region:${String(r.attrs['id'])}`, r]));

  // P2: structure for regions and section breaks; manage for a region's policy (07 §5.2).
  const structural =
    diff.regionsAdded.length > 0 ||
    diff.regionsRemoved.length > 0 ||
    diff.regionsMoved.length > 0 ||
    diff.regionTitleChanged.length > 0 ||
    diff.sectionBreaksChanged;
  if (structural && !access.caps.includes('structure'))
    return {
      reason: 'structure',
      scopes: [
        ...diff.regionsAdded.map((r) => `region:${String(r.attrs['id'])}`),
        ...diff.regionsRemoved.map((r) => `region:${String(r.attrs['id'])}`),
        ...diff.regionsMoved.map((id) => `region:${id}`),
        ...diff.regionTitleChanged.map((id) => `region:${id}`),
      ],
    };
  if (diff.regionPolicyChanged.length > 0 && !access.caps.includes('manage'))
    return { reason: 'manage', scopes: diff.regionPolicyChanged.map((id) => `region:${id}`) };

  const blocked = new Set<string>();
  const fieldContainers = new Map(diff.fields.map((f) => [`field:${f.id}`, f.container]));
  const fieldNodes = new Map(diff.fields.map((f) => [`field:${f.id}`, f.node]));
  for (const scope of diff.changed) {
    const dep = depScope(scope);
    if (dep.startsWith('field:')) {
      // A value change: edit or suggest in the container, or fill of a field assigned to the
      // participant's role (12 §4.2, P7). The authority's check is the boundary.
      const container = fieldContainers.get(dep);
      if (container && editsText(capsOf(access, depScope(container)))) continue;
      if (fillMayChange(access, fieldNodes.get(dep))) continue;
      if (!container) continue; // a field added or removed: its container scope decides
      blocked.add(dep);
      continue;
    }
    const region = added.get(dep);
    const caps = region ? newRegionCaps(access, region.attrs['policy']) : capsOf(access, dep);
    // Text outside a form field needs edit or suggest; fill alone does not allow it (FRW-076).
    if (!editsText(caps)) blocked.add(dep);
  }
  return blocked.size ? { reason: 'scope', scopes: [...blocked].sort() } : null;
}

export const guardKey = new PluginKey('docedit-region-guard');

/**
 * The guard as a plugin. `complete` returns the document a transaction leads to once the core's own
 * additions are made (the paragraph after a region, FE-039), so that a transaction whose addition
 * the user may not make is refused whole and never split (FE-039 criterion 5).
 */
export function guardPlugin(
  ctx: GuardContext,
  complete: (after: Node, before: Node) => Node,
): Plugin {
  return new Plugin({
    key: guardKey,
    filterTransaction(tr: Transaction, state) {
      if (!tr.docChanged) return true;
      if (tr.getMeta(REMOTE) === true || tr.getMeta(INTERNAL) === true) return true;
      const access = ctx.access();
      const readOnly = ctx.readOnly();
      const completed = complete(tr.doc, state.doc);
      const refusal =
        checkChange(state.doc, completed, tr.steps, tr.docs, access, readOnly) ??
        (ctx.valuesOnly?.() === true && !onlyFieldValues(state.doc, completed)
          ? ({ reason: 'read-only', scopes: [] } as const)
          : null);
      if (!refusal) return true;
      ctx.refused(refusal);
      return false;
    },
  });
}
