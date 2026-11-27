/**
 * Invariants on the result of a commit (04 §5 step 6; 03 §8; 12 §3.6; SYN-011). The document must
 * pass model.validate(), and two rules about the transition hold: a non-null `id` never changes
 * (I2, P5), and a region identifier removed earlier is never reused (I3).
 *
 * I2 is judged by the commit's outcome, as the outcome check judges permissions (07 §5.1; ADR 0050
 * item 1): an `attr` step that gives a node another identifier is refused only when that node is
 * still in the commit's result with the new identifier and the old one has gone from the result.
 * A node that a later step of the same commit removes cannot violate it (the undo of a split
 * restores the copy's identifier and then joins the copy away), and a copy that receives an
 * identifier of its own leaves the original holding the old one (a split).
 */
import {
  type CommitValidator,
  validateDoc,
  type ValidationContext,
  type Violation,
} from '@docedit/model/validate';
import type { Node } from 'prosemirror-model';
import { AttrStep, Mapping, ReplaceAroundStep, type Step } from 'prosemirror-transform';
import { type Result, fail, ok } from './codes.ts';
import { regionBoundaryViolation } from './permissions/boundaries.ts';
import { RULE_INVARIANTS } from './room/rules.ts';

export interface InvariantContext {
  requires: readonly string[];
  /** Region identifiers ever removed from this document (I3). */
  retiredRegionIds: ReadonlySet<string>;
  attachedAssets?: ReadonlySet<string>;
  mathGate?: ValidationContext['mathGate'];
  /** The model definition the document is checked against; CDM 1 when absent. */
  def?: ValidationContext['def'];
  /**
   * The room's incremental validator (ADR 0422; SYN-040): it answers what `validateDoc` answers for
   * the result, from the nodes the commit changed. Absent: the whole document is validated.
   */
  validator?: CommitValidator;
}

export interface InvariantOutcome {
  /** Regions present before and absent after: their identifiers are retired once stored. */
  removedRegions: string[];
}

function countId(doc: Node, id: unknown, atMost = 2): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.attrs['id'] === id) n++;
    return n < atMost;
  });
  return n;
}

/**
 * The node a `replaceAround` step puts in place of one node around that node's whole content, or
 * null for any other shape. This is the step `setNodeMarkup` makes: the content stays where it is
 * and only the type, the attributes and the marks of its parent are replaced, so the node is the
 * same node and its identifier may not change (ADR 0362, proposed; CDM-012).
 */
function sameNodeMarkup(s: ReplaceAroundStep): Node | null {
  if (s.gapFrom !== s.from + 1 || s.gapTo !== s.to - 1 || s.insert !== 1) return null;
  const { content, openStart, openEnd } = s.slice;
  if (openStart !== 0 || openEnd !== 0 || content.childCount !== 1) return null;
  const node = content.firstChild;
  return node && node.content.size === 0 && !node.isLeaf ? node : null;
}

/**
 * The I2 transition, judged by the outcome (ADR 0050 item 1). For each `attr` step on `id`, and
 * each `replaceAround` step that replaces a node around its own content (`sameNodeMarkup`), that
 * changes a non-null identifier X held before the commit: the node is followed through the later
 * steps of the commit by its opening token; if a later step removes that token the node is gone
 * and nothing changed identity. Otherwise the node is in the result, and it may hold another
 * identifier only when X itself is still held by a node of the result (a copy took a fresh
 * identifier and the original kept X). Returns a refusal, or null.
 */
function identityChange(
  before: Node,
  after: Node,
  steps: readonly Step[],
  docs: readonly Node[],
): Result<never> | null {
  let maps: ReturnType<Step['getMap']>[] | null = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const doc = docs[i];
    let pos: number;
    let value: unknown;
    let node: Node | null | undefined;
    try {
      if (s instanceof AttrStep && s.attr === 'id') {
        pos = s.pos;
        value = s.value;
        node = doc?.nodeAt(pos);
      } else if (s instanceof ReplaceAroundStep) {
        // A node replaced around its own content (ADR 0362): the same node with new markup.
        const markup = sameNodeMarkup(s);
        if (!markup) continue;
        pos = s.from;
        value = markup.attrs['id'];
        node = doc?.nodeAt(pos);
        if (node && pos + node.nodeSize !== s.to) continue;
      } else continue;
    } catch {
      // Steps that do not belong to these documents: refuse, never throw (SYN-001).
      return fail('invalid_op', `step ${i} does not apply to the document it was checked against`);
    }
    const old: unknown = node?.attrs['id'];
    if (!doc || !node || old === null || old === undefined || old === value) continue;
    // An identifier the commit itself gave out earlier is no identity yet.
    if (countId(before, old, 1) === 0) continue;
    maps ??= steps.map((x) => x.getMap());
    const followed = new Mapping(maps.slice(i + 1)).mapResult(pos, 1);
    if (followed.deletedAfter) continue; // a later step removed the node: it has no identity left
    let now: Node | null;
    try {
      now = after.nodeAt(followed.pos);
    } catch {
      now = null;
    }
    if (!now || now.attrs['id'] === old) continue;
    if (countId(after, old, 1) > 0) continue; // another holder keeps the identity (a split)
    return fail('invalid_op', `step ${i} changes the identifier of a ${node.type.name} (I2)`);
  }
  return null;
}

/**
 * The formulas of a document, in the JSON shape the validator reads `previous` in: only the
 * `equation` and `equation_block` nodes with their `latex`, so the document is not serialised whole.
 */
function formulasOf(doc: Node): { content: { type: string; attrs: { latex: unknown } }[] } {
  const content: { type: string; attrs: { latex: unknown } }[] = [];
  doc.descendants((n) => {
    const t = n.type.name;
    if (t === 'equation' || t === 'equation_block')
      content.push({ type: t, attrs: { latex: n.attrs['latex'] } });
    return true;
  });
  return { content };
}

function regionIds(doc: Node): Set<string> {
  const out = new Set<string>();
  doc.child(doc.childCount - 1).forEach((c) => {
    if (c.type.name === 'region') out.add(String(c.attrs['id']));
  });
  return out;
}

/**
 * @param docs the document before each step (as returned by applySteps), so that attribute steps
 * can be checked against the node they changed.
 */
export function checkInvariants(
  before: Node,
  after: Node,
  steps: readonly Step[],
  docs: readonly Node[],
  ctx: InvariantContext,
): Result<InvariantOutcome> {
  // I2 transition, judged by the outcome: a node still in the result with another identifier,
  // whose old identifier no node of the result holds, changed identity. Splitting and pasting copy
  // a node's attributes, so a copy may take an identifier of its own; a node that a later step
  // removes (the undo of a split joins it away) has no identity left to change.
  const identity = identityChange(before, after, steps, docs);
  if (identity) return identity;
  // P3: a step may not remove exactly one of a region's two boundaries (07 §5.2; PRM-011).
  const boundary = regionBoundaryViolation(steps, docs);
  if (boundary)
    return fail(
      'invalid_op',
      `step ${boundary.step} removes one boundary of region ${boundary.region} but not the other (P3)`,
    );
  const ctxV: ValidationContext = { retiredRegionIds: ctx.retiredRegionIds };
  if (ctx.def) ctxV.def = ctx.def;
  if (ctx.attachedAssets) ctxV.attachedAssets = ctx.attachedAssets;
  if (ctx.mathGate) {
    ctxV.mathGate = ctx.mathGate;
    // Only LaTeX the document did not hold before is gated (09 §6.3; CDM-030): a commit that
    // touches no formula does not call the gate, and a formula stored earlier does not make every
    // later commit to the document fail.
    // The validator reads the formulas of the document before itself.
    if (!ctx.validator) ctxV.previous = formulasOf(before);
  }
  // The rule half of I14 (12 §3.6; FRW-019), through the model's registration point (CDM-013).
  ctxV.invariants = [RULE_INVARIANTS];
  const result = ctx.validator
    ? ctx.validator.validate(before, after, ctx.requires, ctxV)
    : validateDoc(after, ctx.requires, ctxV);
  if (!result.valid) {
    const v = result.violations;
    // A wrongly typed field value is `field_invalid`, so the client shows the validation message (12 §4.2 P7).
    const onlyValues = v.every((x) => x.invariant === 'I15' && x.path.endsWith('/value'));
    // PRO-028 criterion 4: a field_invalid names the rule that failed, which is I15 here.
    if (onlyValues) return { ok: false, code: 'field_invalid', reason: describe(v), rule: 'I15' };
    return fail('invalid_op', describe(v));
  }
  const b = regionIds(before);
  const a = regionIds(after);
  return ok({ removedRegions: [...b].filter((id) => !a.has(id)) });
}

function describe(v: readonly Violation[]): string {
  const head = v.slice(0, 3).map((x) => `${x.invariant} ${x.path}: ${x.message}`);
  return v.length > 3 ? `${head.join('; ')}; and ${v.length - 3} more` : head.join('; ');
}
