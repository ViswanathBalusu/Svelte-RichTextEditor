/**
 * Rule P4 (07 §5.2; PRM-013, PRM-014, PRM-062): where a user has `suggest` but not `edit`, the
 * scope's baseline must be unchanged, other users' suggestions must be unchanged, and every
 * suggestion mark the user adds must name them and use a suggestion identifier that belongs to them.
 *
 * The baseline is the content with every suggestion rejected: `ins` content removed, `del` marks
 * ignored, `fmt` changes taken back to their recorded `before`. It includes attributes, bookmarks
 * (anchor atoms) and block suggestions (the suggest attribute of paragraphs, table rows and tables,
 * 03 §5; owner decision 92).
 * Field values are not part of it: a value is its own scope (`field:<id>`, 07 §5.1).
 *
 * The check (ADR 0050 item 2): the scope with the submitter's own suggestions rejected must be the
 * same before and after the commit. That one comparison holds exactly when the commit changed the
 * scope through the submitter's own suggestion marks and nothing else, so it implies all three
 * clauses: another user's suggestion, its marks, its content and the text it covers stay as they
 * were; a mark that names someone else is kept by the rejection and shows as a change; and the
 * baseline, the scope with every suggestion rejected, cannot move. Accepting one's own suggestion
 * (removing an `ins` mark) changes the comparison, deleting text one suggested oneself does not.
 *
 * Unchanged subtrees are shared between the versions, so the comparison trims the common prefix
 * and suffix of each child list by identity and descends into the one child that changed: it
 * converts the changed blocks only (PRM-013, PRM-016).
 *
 * Import labels (spike S11 change 6; second review SR-M14; 07 §15): a commit with origin `import`
 * may carry suggestion marks whose `user` is a label such as `word:<author>`, not the committing
 * user. In such a commit, marks that name a label and use an identifier never seen before count
 * as the importer's own suggestions, here and in the core's identity rule (`identity.ts`). A label
 * is never a user identity: no connection owns a mark that names one.
 *
 * P4 is a module of the outcome check, registered as `SUGGESTION_RULE` (PRM-010): without it, a
 * scope where the user may only suggest cannot change at all.
 */
import { canonicalNodeText, type JsonNode } from '@docedit/model';
import { FILL_ATTRIBUTES } from '@docedit/model/definition';
import type { Mark, Node } from 'prosemirror-model';
import type {
  ScopeContent,
  SuggestRule,
  SuggestionContext,
  SuggestionVerdict,
} from './registry.ts';

export type { ScopeContent, SuggestionContext, SuggestionVerdict } from './registry.ts';

const SUGGESTION: ReadonlySet<string> = new Set(['ins', 'del', 'fmt']);

/** Whether a mark is a suggestion mark (03 §5). */
export function isSuggestionMark(m: Mark): boolean {
  return SUGGESTION.has(m.type.name);
}

/** One suggestion: a suggestion mark, or an entry of the `suggest` attribute of a block. */
export interface SuggestionEntry {
  readonly type: string;
  readonly attrs: Readonly<Record<string, unknown>>;
}

/** The entries of a block's `suggest` attribute that have the shape of a suggestion. */
export function blockSuggestions(n: Node): SuggestionEntry[] {
  const s: unknown = n.attrs['suggest'];
  if (!Array.isArray(s)) return [];
  return s.filter(
    (e): e is SuggestionEntry =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as SuggestionEntry).type === 'string' &&
      SUGGESTION.has((e as SuggestionEntry).type) &&
      !!(e as SuggestionEntry).attrs &&
      typeof (e as SuggestionEntry).attrs === 'object',
  );
}

/** Every suggestion a node carries itself: its suggestion marks and its block suggestions. */
export function suggestionsOn(n: Node): SuggestionEntry[] {
  const out: SuggestionEntry[] = [];
  for (const m of n.marks) if (isSuggestionMark(m)) out.push({ type: m.type.name, attrs: m.attrs });
  out.push(...blockSuggestions(n));
  return out;
}

/**
 * The prefixes of the labels an import gives the authors of tracked changes (07 §15; spike S11:
 * `word:<author>`). EXP registers a prefix here for every format it imports.
 */
export const IMPORT_LABEL_PREFIXES: readonly string[] = ['word:'];

/** Whether a suggestion mark's `user` is an import label rather than a user identity. */
export function isImportLabel(user: unknown): boolean {
  return (
    typeof user === 'string' &&
    IMPORT_LABEL_PREFIXES.some((p) => user.startsWith(p) && user.length > p.length)
  );
}

/** Which suggestion marks a rejection takes back. */
export type Rejects = (suggestion: SuggestionEntry) => boolean;

/** Counts the nodes a comparison converted, for the instrumented tests (PRM-013, PRM-016). */
export interface Counter {
  visited: number;
}

type Item = Node | { regionRef: string };

const isRef = (x: Item): x is { regionRef: string } => 'regionRef' in x;
const sameItem = (a: Item, b: Item): boolean =>
  a === b || (isRef(a) && isRef(b) && a.regionRef === b.regionRef);

interface Head {
  removed: boolean;
  /** The node without its children, with the selected suggestions taken back. */
  json: JsonNode;
}

/** A node's own part (type, attributes, marks) with the suggestions `rejects` selects taken back. */
function headOf(n: Node, rejects: Rejects): Head {
  let removed = false;
  let formatting: unknown[] | null = null;
  let attrs: Record<string, unknown> | undefined = n.isText ? undefined : { ...n.attrs };
  const takeBack = (type: string, entryAttrs: Readonly<Record<string, unknown>>) => {
    if (type === 'ins') removed = true;
    else if (type === 'fmt') {
      const before = entryAttrs['before'] as {
        marks?: unknown;
        attrs?: Record<string, unknown>;
      } | null;
      if (before && Array.isArray(before.marks)) formatting = before.marks;
      if (before && before.attrs && typeof before.attrs === 'object' && attrs)
        attrs = { ...attrs, ...before.attrs };
    }
    // `del`: rejecting a suggested deletion keeps the content and drops the suggestion.
  };
  const kept: Mark[] = [];
  for (const m of n.marks) {
    if (!SUGGESTION.has(m.type.name) || !rejects({ type: m.type.name, attrs: m.attrs })) {
      kept.push(m);
      continue;
    }
    takeBack(m.type.name, m.attrs);
  }
  // Block suggestions: the entries of `suggest` that stay are the ones the rejection does not take.
  const block = blockSuggestions(n);
  if (block.length && attrs) {
    const stay: SuggestionEntry[] = [];
    for (const e of block) {
      if (rejects(e)) takeBack(e.type, e.attrs);
      else stay.push(e);
    }
    attrs['suggest'] = stay.length ? stay : null;
  }
  // A `fmt` that is not rejected stands for a change of formatting that this rejection leaves in
  // place, and every `fmt` of a run records the baseline, not the run's marks before its own change
  // (owner decision 79; ADR 0378). Taking one user's `fmt` back then cannot restore the run's
  // formatting before that user's change, so the run's formatting is left out of a comparison that
  // keeps another user's `fmt`. The baseline (every `fmt` rejected) still compares it.
  const keptFmt = kept.some((m) => m.type.name === 'fmt');
  const marks: unknown[] = keptFmt
    ? kept.filter((m) => SUGGESTION.has(m.type.name)).map((m) => m.toJSON())
    : formatting
      ? [...formatting, ...kept.filter((m) => SUGGESTION.has(m.type.name)).map((m) => m.toJSON())]
      : kept.map((m) => m.toJSON());
  if (attrs && n.type.name === 'form_field')
    for (const a of FILL_ATTRIBUTES) Reflect.deleteProperty(attrs, a);
  const json: JsonNode = { type: n.type.name };
  if (n.isText) json.text = n.text ?? '';
  if (attrs) json.attrs = attrs as NonNullable<JsonNode['attrs']>;
  if (marks.length) json.marks = marks as NonNullable<JsonNode['marks']>;
  return { removed, json };
}
/** The whole subtree with the selected suggestions taken back, or null when it is removed. */
function rejectedNode(n: Node, rejects: Rejects, count: Counter): JsonNode | null {
  count.visited++;
  const head = headOf(n, rejects);
  if (head.removed) return null;
  if (n.childCount) {
    const content: JsonNode[] = [];
    n.forEach((c) => {
      const r = rejectedNode(c, rejects, count);
      if (r) content.push(r);
    });
    if (content.length) head.json.content = content;
  }
  return head.json;
}

function rejectedItems(items: readonly Item[], rejects: Rejects, count: Counter): string {
  const nodes: JsonNode[] = [];
  for (const item of items) {
    if (isRef(item)) nodes.push({ type: 'region_ref', attrs: { id: item.regionRef } });
    else {
      const r = rejectedNode(item, rejects, count);
      if (r) nodes.push(r);
    }
  }
  return canonicalNodeText({ type: 'scope', content: nodes });
}

const children = (n: Node): Node[] => {
  const out: Node[] = [];
  n.forEach((c) => out.push(c));
  return out;
};

/**
 * Whether two lists of items are equal once the selected suggestions are taken back, converting
 * only what differs: the common prefix and suffix are skipped by identity, and a single changed
 * container on each side is entered rather than converted whole.
 */
function sameRejected(b: readonly Item[], a: readonly Item[], rejects: Rejects, count: Counter) {
  let start = 0;
  while (start < b.length && start < a.length && sameItem(b[start]!, a[start]!)) start++;
  let end = 0;
  while (
    end < b.length - start &&
    end < a.length - start &&
    sameItem(b[b.length - 1 - end]!, a[a.length - 1 - end]!)
  )
    end++;
  const mb = b.slice(start, b.length - end);
  const ma = a.slice(start, a.length - end);
  if (mb.length === 0 && ma.length === 0) return true;
  const x = mb[0];
  const y = ma[0];
  if (
    mb.length === 1 &&
    ma.length === 1 &&
    x !== undefined &&
    y !== undefined &&
    !isRef(x) &&
    !isRef(y) &&
    !x.isText &&
    !y.isText &&
    x.type === y.type
  ) {
    count.visited += 2;
    const hx = headOf(x, rejects);
    const hy = headOf(y, rejects);
    if (hx.removed || hy.removed) return hx.removed && hy.removed;
    if (canonicalNodeText(hx.json) !== canonicalNodeText(hy.json)) return false;
    return sameRejected(children(x), children(y), rejects, count);
  }
  return rejectedItems(mb, rejects, count) === rejectedItems(ma, rejects, count);
}

/** The baseline of a scope (every suggestion rejected) as canonical text (PRM-013). */
export function baselineText(content: ScopeContent, count: Counter = { visited: 0 }): string {
  return rejectedItems(content, () => true, count);
}

/**
 * Whether two versions of a scope have the same baseline, converting only the blocks that differ
 * (PRM-013 criterion 6).
 */
export function sameBaseline(
  before: ScopeContent,
  after: ScopeContent,
  count: Counter = { visited: 0 },
): boolean {
  return sameRejected(before, after, () => true, count);
}

/** Which marks are the submitter's own suggestions, for the rejection of P4. */
export function ownSuggestions(ctx: SuggestionContext): Rejects {
  return (m) => {
    const user = m.attrs['user'];
    if (isImportLabel(user))
      return ctx.importLabels === true && !ctx.owners.has(String(m.attrs['id']));
    return user === ctx.user;
  };
}

/**
 * P4's justification of a scope. The identity clause (a mark names its submitter, an identifier
 * belongs to the user who first used it) forbids rather than permits, so it is the core's and
 * applies to every commit (`identity.ts`, 03 §5); this module answers only whether the commit
 * changed the scope through the submitter's own suggestions and nothing else. Identifiers are
 * claimed by the core, so `claimed` is empty here.
 */
export function checkSuggestion(
  before: ScopeContent,
  after: ScopeContent,
  ctx: SuggestionContext,
  count: Counter = { visited: 0 },
): SuggestionVerdict {
  if (sameRejected(before, after, ownSuggestions(ctx), count)) return { ok: true, claimed: [] };
  return {
    ok: false,
    reason: sameRejected(before, after, () => true, { visited: 0 })
      ? "another user's suggestions changed, or a mark names someone else"
      : 'the baseline changed: suggesters change text only through suggestion marks',
  };
}

/** P4 as a registered module of the outcome check. */
export const SUGGESTION_RULE: SuggestRule = Object.freeze({
  id: 'P4',
  check: (_scope: string, before: ScopeContent, after: ScopeContent, ctx: SuggestionContext) =>
    checkSuggestion(before, after, ctx),
});
