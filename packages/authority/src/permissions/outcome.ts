/**
 * The outcome check (07 §5; 12 §4.2; PRM-009 to PRM-012; FRW-008 to FRW-010; ADR 0019). It
 * compares the document before and after a commit and never looks at step shapes: the only question
 * is whether every scope that differs is in the submitter's writable set.
 *
 * The core justifies a changed scope only by `edit` (P1). A scope where the user may only suggest
 * goes to the registered P4 module, a field value the user may not change under P1 to the
 * registered P7 module (`registry.ts`); a missing module leaves the scope unjustified, so the commit
 * is refused. Everything that forbids, rather than permits, is here in the core and applies whatever
 * is registered: P2 and the `manage` operations, 07 §5.3, P8, P9, and the rule that nobody changes
 * a value they cannot read. P3 and P5 are checked on the steps with the invariants (04 §5 step 6),
 * and P6 first of all, before any comparison.
 */
import { SERVER_SET_FIELD_KINDS } from '@docedit/model/definition';
import type { Node } from 'prosemirror-model';
import type { Access } from './access.ts';
import { canSubmitAnything } from './access.ts';
import { suggestionIdentity } from './identity.ts';
import {
  type Caps,
  type OperationId,
  type PermissionState,
  operationNeeds,
  regionPolicyOf,
} from './model.ts';
import type { OutcomeRules, ScopeContent } from './registry.ts';
import { deepEqual, diffScopes, type ScopeDiff } from './scopes.ts';
import { STANDARD_RULES } from './standard.ts';
import { canReadValue } from './visibility.ts';

export interface OutcomeInput {
  before: Node;
  after: Node;
  user: string;
  access: Access;
  perms: PermissionState;
  /** Suggestion identifier → owner (P4). */
  suggestionOwners: ReadonlyMap<string, string>;
  /** Field identifiers changed by any commit accepted after the commit's base (P9). */
  fieldsChangedSinceBase: ReadonlySet<string>;
  /** Server-authored commits may set signature, date-signed and formula values (P8). */
  serverAuthored: boolean;
  origin: string;
  /** Visibility and enablement of fields under the rules (12 §5); FRW supplies it. */
  fieldEnabled?: (fieldId: string, after: Node, key?: string) => boolean;
  /** The registered modules (PRM-010). Omitted: `STANDARD_RULES`, that is P4 and P7. */
  rules?: OutcomeRules;
  /**
   * The definitions each region uses before and after the commit (07 §5.3), from the room's
   * index (PRM-016). Omitted: computed from the documents when a definition changed.
   */
  definitionUse?: {
    before: () => ReadonlyMap<string, ReadonlySet<string>>;
    after: (diff: ScopeDiff) => ReadonlyMap<string, ReadonlySet<string>>;
  };
}

export type OutcomeVerdict =
  | {
      ok: true;
      scopes: string[];
      /** Suggestion identifiers the commit used for the first time (03 §5). */
      claimedSuggestionIds: string[];
      /** The user, or import label, each claimed identifier belongs to from now on. */
      claimedBy: ReadonlyMap<string, string>;
      diff: ScopeDiff;
    }
  | { ok: false; code: 'permission_denied' | 'conflict'; scopes: string[]; reason: string };

/** Field kinds whose values only the server sets (P8): the model's list (12 §3.3). */
export const SERVER_ONLY_KINDS: ReadonlySet<string> = new Set(SERVER_SET_FIELD_KINDS);

/** Which definitions every region uses, directly or through `basedOn` (07 §5.3; PRM-012). */
export function definitionUse(doc: Node): Map<string, Set<string>> {
  const styles = new Map<string, { basedOn: string | null; numbering: string | null }>();
  let defaultParagraphStyle = 'Normal';
  doc.child(0).forEach((d) => {
    if (d.type.name === 'style_def') {
      const num = d.attrs['numbering'] as { numberingId?: string } | null;
      styles.set(String(d.attrs['id']), {
        basedOn: (d.attrs['basedOn'] as string | null) ?? null,
        numbering: num?.numberingId ?? null,
      });
    } else if (d.type.name === 'settings')
      defaultParagraphStyle = String(d.attrs['defaultParagraphStyle']);
  });
  const expandStyle = (id: string, out: Set<string>) => {
    for (let cur: string | null = id, guard = 0; cur && guard < 20; guard++) {
      out.add(`defs:style_def/${cur}`);
      const s = styles.get(cur);
      if (s?.numbering) out.add(`defs:numbering_def/${s.numbering}`);
      cur = s?.basedOn ?? null;
    }
  };
  const use = new Map<string, Set<string>>();
  const body = doc.child(doc.childCount - 1);
  let pageSetup = String(body.attrs['pageSetup']);
  body.forEach((block) => {
    if (block.type.name === 'section_break') pageSetup = String(block.attrs['pageSetup']);
    if (block.type.name !== 'region') return;
    const out = new Set<string>([`defs:page_setup/${pageSetup}`]);
    block.descendants((n) => {
      if (n.type.name === 'paragraph') {
        expandStyle((n.attrs['style'] as string | null) ?? defaultParagraphStyle, out);
        const num = n.attrs['numbering'] as { numberingId?: string } | null;
        if (num?.numberingId) out.add(`defs:numbering_def/${num.numberingId}`);
      } else if (n.type.name === 'table' && typeof n.attrs['style'] === 'string')
        expandStyle(n.attrs['style'], out);
      for (const m of n.marks)
        if (m.type.name === 'charStyle') expandStyle(String(m.attrs['style']), out);
      return true;
    });
    use.set(String(block.attrs['id']), out);
  });
  return use;
}

/**
 * The section each region sits in: the attributes of the last `section_break` before it, or the
 * body's own page setup for the first section (07 §5.2 P2; PRM-011). A change of section breaks
 * affects every region whose entry differs between the two versions.
 */
export function regionSections(doc: Node): Map<string, string> {
  const body = doc.child(doc.childCount - 1);
  let section = `body:${String(body.attrs['pageSetup'])}`;
  const out = new Map<string, string>();
  body.forEach((block) => {
    if (block.type.name === 'section_break')
      section = `section_break:${canonicalAttrs(block.attrs)}`;
    else if (block.type.name === 'region') out.set(String(block.attrs['id']), section);
  });
  return out;
}

/** Attributes as text with sorted keys, for comparing two nodes' attributes. */
function canonicalAttrs(attrs: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(attrs)
      .sort()
      .map((k) => [k, attrs[k]]),
  );
}

function bodyContent(doc: Node): ScopeContent {
  const out: Array<Node | { regionRef: string }> = [];
  doc
    .child(doc.childCount - 1)
    .forEach((c) => out.push(c.type.name === 'region' ? { regionRef: String(c.attrs['id']) } : c));
  return out;
}

function findStory(doc: Node, id: string): Node | null {
  let found: Node | null = null;
  doc.forEach((c) => {
    if (c.type.name === 'story' && c.attrs['id'] === id) found = c;
  });
  return found;
}

function findRegion(doc: Node, id: string): Node | null {
  let found: Node | null = null;
  doc.child(doc.childCount - 1).forEach((c) => {
    if (c.type.name === 'region' && c.attrs['id'] === id) found = c;
  });
  return found;
}

function trackChanges(doc: Node): boolean {
  let on = false;
  doc.child(0).forEach((d) => {
    if (d.type.name === 'settings') on = d.attrs['trackChanges'] === 'everyone';
  });
  return on;
}

/** A module's answer, or null when it threw: a module never makes the check throw (SYN-001). */
function consult<T>(ask: () => T): T | null {
  try {
    return ask();
  } catch {
    return null;
  }
}

/** The scope an operation on structure is refused in, and the operation itself. */
function structureOperation(scope: string): OperationId {
  if (scope === 'doc') return 'doc.change';
  return scope.startsWith('story:') ? 'story.change' : 'defs.change';
}

export function outcomeCheck(input: OutcomeInput): OutcomeVerdict {
  const { access, before, after, user, perms } = input;
  const rules = input.rules ?? STANDARD_RULES;
  // P6: connections limited to view and comment are refused without analysis.
  if (!canSubmitAnything(access)) {
    return {
      ok: false,
      code: 'permission_denied',
      scopes: [],
      reason: 'the connection can only view or comment (P6)',
    };
  }
  const diff = diffScopes(before, after);
  const offending = new Set<string>();
  const reasons: string[] = [];
  const deny = (scope: string, why: string, also: readonly string[] = []) => {
    offending.add(scope);
    for (const s of also) offending.add(s);
    reasons.push(`${scope}: ${why}`);
  };
  const claimed: string[] = [];
  const everyone = trackChanges(before); // P4 for every user while trackChanges is `everyone` (07 §5.2)
  const regionCaps = (id: string): Caps => access.regions.get(id) ?? access.newRegion;
  const hasStructure = access.docRole.has('structure') && access.structureScopes.has('edit');
  const manage = access.docRole.has('manage');
  // Spike S11 change 6 (SR-M14): an import may attribute new suggestions to import labels.
  const importLabels = input.serverAuthored && input.origin === 'import';

  // The P4 seam: a scope where the user may only suggest is justified by the registered module's
  // positive verdict and by nothing else.
  const suggestOnly = (c: Caps) => c.has('suggest') && (!c.has('edit') || everyone);
  const p4 = (scope: string, b: ScopeContent, a: ScopeContent) => {
    const rule = rules.suggest;
    if (!rule) {
      deny(scope, 'only `suggest` is held here and no suggestion rule is registered (fail closed)');
      return;
    }
    const v = consult(() =>
      rule.check(scope, b, a, { user, owners: input.suggestionOwners, importLabels }),
    );
    if (v === null) deny(scope, `the suggestion rule ${rule.id} failed (fail closed)`);
    else if (v.ok === true) claimed.push(...v.claimed);
    else deny(scope, `${v.reason} (${rule.id})`);
  };

  for (const scope of diff.changed) {
    if (scope === 'doc' || scope.startsWith('defs:') || scope.startsWith('story:')) {
      if (!hasStructure) {
        deny(scope, `${operationNeeds(structureOperation(scope))}`);
        continue;
      }
      if (scope.startsWith('story:') && everyone) {
        const id = scope.slice(6);
        const b = findStory(before, id);
        const a = findStory(after, id);
        if (b && a) p4(scope, [b], [a]);
      }
      continue;
    }
    if (scope === 'body') {
      if (suggestOnly(access.body)) p4(scope, bodyContent(before), bodyContent(after));
      else if (!access.body.has('edit')) deny(scope, 'needs `edit` in the body (P1)');
      continue;
    }
    if (scope.startsWith('region:')) {
      const id = scope.slice(7);
      const b = findRegion(before, id);
      const a = findRegion(after, id);
      const c = b ? regionCaps(id) : access.newRegion;
      if (b && a && !diff.regionsMoved.includes(id)) {
        if (suggestOnly(c)) p4(scope, [b], [a]);
        else if (!c.has('edit')) deny(scope, 'needs `edit` in the region (P1)');
      } else if (!c.has('edit')) {
        const op: OperationId = !b ? 'region.create' : !a ? 'region.delete' : 'region.move';
        deny(scope, `\`${op}\` needs \`edit\` in the region (P2)`);
      }
      continue;
    }
    // Field scopes are decided below.
  }

  // P2: structural changes of regions and section breaks. A split creates a region; a merge
  // deletes one and changes the other (ADR 0033).
  const structural: OperationId[] = [];
  if (diff.regionsAdded.length) structural.push('region.create');
  if (diff.regionsRemoved.length) structural.push('region.delete');
  if (diff.regionsMoved.length) structural.push('region.move');
  if (diff.regionTitleChanged.length) structural.push('region.retitle');
  if (diff.sectionBreaksChanged) structural.push('section_break.change');
  if (structural.length) {
    if (!access.docRole.has('structure'))
      for (const op of structural) deny('body', `${operationNeeds(op)}`);
    if (!access.body.has('edit')) deny('body', 'structural changes need `edit` in the body (P2)');
    for (const id of diff.regionTitleChanged)
      if (!regionCaps(id).has('edit'))
        deny(`region:${id}`, '`region.retitle` needs `edit` in the region (P2)');
    // A region is affected by a change of section breaks when the section it sits in differs
    // afterwards: a break added, removed, moved or changed before it. Regions the commit adds or
    // removes are checked as regions above.
    if (diff.sectionBreaksChanged) {
      const sectionsBefore = regionSections(before);
      for (const [id, section] of regionSections(after)) {
        const was = sectionsBefore.get(id);
        if (was !== undefined && was !== section && !regionCaps(id).has('edit'))
          deny(
            `region:${id}`,
            '`section_break.change` needs `edit` in every region whose section it changes (P2)',
          );
      }
    }
  }
  // `manage`: a region's policy, including at creation (07 §2, §16; ADR 0019).
  for (const id of diff.regionPolicyChanged)
    if (!manage) deny(`region:${id}`, operationNeeds('region.policy'));
  for (const r of diff.regionsAdded) {
    if (regionPolicyOf(r.attrs['policy']) !== 'inherit' && !manage)
      deny(`region:${String(r.attrs['id'])}`, operationNeeds('region.policy'));
  }

  // 03 §5: every suggestion mark the commit brings names its submitter and uses an identifier
  // that belongs to them, whoever submits it (ADR 0050 item 3). It forbids, so it is the core's.
  const identity = suggestionIdentity({
    before,
    after,
    user,
    owners: input.suggestionOwners,
    importLabels,
  });
  if (!identity.ok) {
    for (const s of identity.scopes) offending.add(s);
    reasons.push(...identity.reasons);
  }

  // 07 §5.3: definitions used by protected regions. The rejection names the definition and every
  // region that makes it protected (PRM-012).
  if (diff.definitionsChanged.length) {
    const useBefore = input.definitionUse?.before() ?? definitionUse(before);
    const useAfter = input.definitionUse?.after(diff) ?? definitionUse(after);
    for (const d of diff.definitionsChanged) {
      if (d.type === 'settings') {
        if (trackChanges(before) && !trackChanges(after) && !manage)
          deny(d.scope, operationNeeds('settings.track_changes_off'));
        continue;
      }
      const users = new Set<string>();
      for (const [region, uses] of [...useBefore, ...useAfter])
        if (uses.has(d.scope)) users.add(region);
      for (const region of users) {
        if ((perms.regionStates.get(region) ?? 'draft') === 'approved')
          deny(d.scope, `region ${region}, which uses it, is approved (07 §5.3)`, [
            `region:${region}`,
          ]);
        else if (!regionCaps(region).has('edit') && !manage)
          deny(d.scope, `region ${region} uses it and needs \`edit\` or \`manage\` (07 §5.3)`, [
            `region:${region}`,
          ]);
      }
    }
  }

  // Fields. First what no module may relax, on every field of the subtrees that differ.
  const serverOrigin =
    input.serverAuthored && (input.origin === 'sign' || input.origin === 'rules');
  const serverSet = new Set<string>();
  for (const f of diff.fieldNodes) {
    const scope = `field:${f.id}`;
    const b = f.before;
    const a = f.after;
    // `manage`: setting or clearing `sensitive`, including by inserting a field with it set.
    const was = b?.attrs['sensitive'] === true;
    const is = a?.attrs['sensitive'] === true;
    if (a && was !== is && !manage) deny(scope, operationNeeds('field.sensitive'));
    // A user who cannot read a value can delete the field, but cannot change it in any way or move
    // it: its value, its default, its assignee and its container decide who reads it (ADR 0019,
    // change 5; ADR 0033).
    if (b && a && was && !canReadValue(access, b, f.containerBefore)) {
      if (
        f.containerAfter !== f.containerBefore ||
        !deepEqual(a.attrs, b.attrs) ||
        a.marks.length !== b.marks.length ||
        a.marks.some((m, i) => !m.eq(b.marks[i]!))
      )
        deny(scope, 'you cannot change a field whose value you cannot read (ADR 0019)');
    }
    // P8: values of server-set kinds change only through server-authored commits, whether the
    // value is changed, inserted with the field (a pasted signature) or kept while the kind changes.
    const kindBefore = b ? String(b.attrs['kind']) : null;
    const kindAfter = a ? String(a.attrs['kind']) : null;
    const serverKind =
      (kindBefore !== null && SERVER_ONLY_KINDS.has(kindBefore)) ||
      (kindAfter !== null && SERVER_ONLY_KINDS.has(kindAfter));
    if (!serverKind || !a) continue;
    serverSet.add(f.id);
    const valueAfter = a.attrs['value'] ?? null;
    const valueBefore = b ? (b.attrs['value'] ?? null) : null;
    const set = b
      ? !deepEqual(valueBefore, valueAfter) || (kindBefore !== kindAfter && valueAfter !== null)
      : valueAfter !== null;
    if (set && !serverOrigin)
      deny(
        scope,
        `${kindAfter ?? kindBefore ?? 'server-set'} values change only through server-authored commits (P8)`,
      );
  }

  // Then value changes: P1 where the container is editable while the document is a draft, else
  // the registered P7 module; P9 for every value change.
  let conflict = false;
  for (const f of diff.fields) {
    const scope = `field:${f.id}`;
    if (serverSet.has(f.id)) continue; // decided by P8 above
    const containerCaps =
      f.container === 'body'
        ? access.body
        : f.container.startsWith('region:')
          ? regionCaps(f.container.slice(7))
          : access.structureScopes;
    if (containerCaps.has('edit') && !perms.workflowActive && !everyone) {
      // An editor may change any attribute of a field while the document is a draft (12 §4.3).
    } else {
      const rule = rules.fill;
      if (!rule) deny(scope, 'no fill rule is registered (fail closed)');
      else {
        const v = consult(() =>
          rule.check(f, {
            user,
            access,
            perms,
            after,
            ...(input.fieldEnabled ? { fieldEnabled: input.fieldEnabled } : {}),
          }),
        );
        if (v === null) deny(scope, `the fill rule ${rule.id} failed (fail closed)`);
        else if (v.ok !== true) deny(scope, `${v.reason} (${rule.id})`);
      }
    }
    if (input.fieldsChangedSinceBase.has(f.id)) conflict = true;
  }

  if (offending.size)
    return {
      ok: false,
      code: 'permission_denied',
      scopes: [...offending].sort(),
      reason: reasons.join('; '),
    };
  if (conflict) {
    return {
      ok: false,
      code: 'conflict',
      scopes: diff.fields
        .filter((f) => input.fieldsChangedSinceBase.has(f.id))
        .map((f) => `field:${f.id}`),
      reason: 'another commit changed the same field after your base (P9)',
    };
  }
  const claimedBy = identity.ok ? new Map(identity.claimed) : new Map<string, string>();
  for (const id of claimed) if (!claimedBy.has(id)) claimedBy.set(id, user);
  return {
    ok: true,
    scopes: diff.changed,
    claimedSuggestionIds: [...claimedBy.keys()].sort(),
    claimedBy,
    diff,
  };
}
