/**
 * The R0 and R1 checks of ADR 0017, for spike S11 and for CI (EXP-120).
 *
 * Canonical XML here (the R1 (b) tolerance, S11 report §5): names spelt by namespace URI, attributes
 * sorted, namespace declarations ignored, character references resolved, `<a/>` equal to
 * `<a></a>`, and whitespace-only text ignored where its parent also has element children.
 *
 * R1 is checked at block level, as the second review proposes (SR-M13): blocks outside the edit,
 * and the material between blocks, must be canonically equal and in place; an edited block is
 * regenerated, so its runs may be regrouped, but it must keep its attributes, its unmodelled
 * properties, the run properties of its text, its atoms in order, and its text as edited.
 */
import { NS, REGENERATED, w } from './ooxml.ts';
import { parseRelationships, referencedRelIds, relsPartName, resolveTarget } from './opc.ts';
import type { SourceMap } from './source-map.ts';
import {
  type XmlElement,
  type XmlNode,
  canonical,
  nameOf,
  isWhitespaceText,
  parseXml,
} from './xml.ts';
import { type ZipArchive, entryData, readZip } from './zip.ts';

export interface PartDiff {
  identical: string[];
  changed: string[];
  missing: string[];
  added: string[];
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function diffParts(original: Uint8Array, exported: Uint8Array): PartDiff {
  const a = readZip(original);
  const b = readZip(exported);
  const out: PartDiff = { identical: [], changed: [], missing: [], added: [] };
  for (const e of a.entries) {
    const o = b.byName.get(e.name);
    if (!o) out.missing.push(e.name);
    else if (same(entryData(a, e), entryData(b, o))) out.identical.push(e.name);
    else out.changed.push(e.name);
  }
  for (const e of b.entries) if (!a.byName.has(e.name)) out.added.push(e.name);
  return out;
}

/** R0: same parts, every part byte-identical. A failure names each changed part's first differing element (EXP-120). */
export function checkR0(
  original: Uint8Array,
  exported: Uint8Array,
): { pass: boolean; diff: PartDiff; differences: string[] } {
  const diff = diffParts(original, exported);
  const differences: string[] = [];
  if (diff.changed.length) {
    const a = readZip(original);
    const b = readZip(exported);
    for (const part of diff.changed)
      differences.push(
        `${part}: ${firstDifference(entryData(a, a.byName.get(part)!), entryData(b, b.byName.get(part)!)) ?? 'bytes differ, canonical XML equal'}`,
      );
  }
  return {
    pass: !diff.changed.length && !diff.missing.length && !diff.added.length,
    diff,
    differences,
  };
}

/**
 * The path of the first element where two XML parts differ, compared canonically
 * (`/w:document[1]/w:body[1]/w:p[12]`), or null when they are canonically equal. A part that is
 * not XML is reported by its first differing byte.
 */
export function firstDifference(a: Uint8Array, b: Uint8Array): string | null {
  let da;
  let db;
  try {
    da = parseXml(a);
    db = parseXml(b);
  } catch {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `byte ${i}`;
    return a.length === b.length ? null : `byte ${n} (lengths ${a.length} and ${b.length})`;
  }
  return elementDifference(da.root, db.root, `/${nameOf(da.root)}[1]`);
}

/** The path of the first element where two elements differ canonically, or null. */
export function elementDifference(a: XmlElement, b: XmlElement, base: string): string | null {
  const stack: Array<[XmlElement, XmlElement, string]> = [[a, b, base]];
  while (stack.length) {
    const [x, y, path] = stack.pop()!;
    if (nameOf(x) !== nameOf(y)) return `${path} (now <${nameOf(y)}>)`;
    const head = (e: XmlElement): string => canonical({ ...e, children: [] });
    if (head(x) !== head(y)) return `${path} (attributes)`;
    const kx = significant(x.children);
    const ky = significant(y.children);
    const ex = kx.filter((c): c is XmlElement => c.kind === 'element');
    const ey = ky.filter((c): c is XmlElement => c.kind === 'element');
    const text = (nodes: XmlNode[]): string =>
      nodes
        .map((c) => (c.kind === 'text' ? c.value : c.kind === 'element' ? '\u0000' : ''))
        .join('');
    if (text(kx) !== text(ky)) return `${path} (text)`;
    const counts = new Map<string, number>();
    const paths = ex.map((c) => {
      const n = nameOf(c);
      counts.set(n, (counts.get(n) ?? 0) + 1);
      return `${path}/${n}[${counts.get(n)}]`;
    });
    if (ex.length !== ey.length) {
      for (let i = 0; i < Math.min(ex.length, ey.length); i++)
        if (canonical(ex[i]!) !== canonical(ey[i]!)) return paths[i]!;
      return `${path} (${ex.length} child elements, now ${ey.length})`;
    }
    for (let i = ex.length - 1; i >= 0; i--) stack.push([ex[i]!, ey[i]!, paths[i]!]);
  }
  return null;
}

/** What a scripted edit did, in terms of node identifiers. */
export interface R1Edit {
  name: string;
  /** Nodes whose elements the edit changes; they are regenerated. */
  edited: string[];
  /** Nodes the edit removes, with their descendants. */
  deleted: string[];
  /** New nodes, with the original node whose properties they keep (a split's second half). */
  added: Array<{ id: string; from: string }>;
  /** An atom moved between paragraphs (or within one): its canonical XML leaves `from` and arrives at the start or end of `to`. */
  movedAtom?: { from: string; to: string; canonical: string; position: 'start' | 'end' };
  /** The style a restyled paragraph must now have (Word style id). */
  restyled?: { id: string; wordStyle: string };
  /** The text each edited or added paragraph must hold afterwards. */
  text: Record<string, string>;
}

export interface R1Result {
  pass: boolean;
  /** Parts whose bytes changed. */
  changedParts: string[];
  removedParts: string[];
  violations: string[];
}

const W_P = w('p');
const W_R = w('r');
const W_PPR = w('pPr');
const W_RPR = w('rPr');
const W_SECTPR = w('sectPr');
const TEXT = new Set([w('t'), w('delText')]);

const blockChildren = (el: XmlElement): XmlElement[] =>
  el.children.filter((c): c is XmlElement => c.kind === 'element');

function significant(nodes: XmlNode[]): XmlNode[] {
  return nodes.filter((n) => !(n.kind === 'text' && isWhitespaceText(n)));
}

/**
 * A revision wrapper of inline content. The importer maps every one in a paragraph it imports to
 * suggestion marks on what it holds, text and inline atoms alike (CDM-051); a paragraph with a
 * revision the model cannot express is a preserved block instead (owner decision 13).
 */
function isRevision(el: XmlElement): boolean {
  return el.ns === NS.w && (el.local === 'ins' || el.local === 'del');
}

interface ParagraphFacts {
  attrs: Map<string, string>;
  pPr: string[];
  rPrs: Set<string>;
  atoms: string[];
  text: string;
  revisions: Set<string>;
}

/** What R1 (c) and (d) must keep of a paragraph. */
function paragraphFacts(p: XmlElement): ParagraphFacts {
  const facts: ParagraphFacts = {
    attrs: new Map(),
    pPr: [],
    rPrs: new Set(),
    atoms: [],
    text: '',
    revisions: new Set(),
  };
  for (const a of p.attrs) facts.attrs.set(nameOf(a), a.value);
  const walk = (nodes: XmlNode[]): void => {
    for (const c of nodes) {
      if (c.kind !== 'element') continue;
      const name = nameOf(c);
      if (name === W_PPR) {
        for (const k of blockChildren(c)) if (nameOf(k) !== W_SECTPR) facts.pPr.push(canonical(k));
        continue;
      }
      if (REGENERATED.has(name)) continue;
      if (isRevision(c)) {
        const attrs = c.attrs
          .filter((a) => a.local !== 'id')
          .map((a) => `${nameOf(a)}=${a.value}`)
          .sort()
          .join(' ');
        facts.revisions.add(`${c.local} ${attrs}`);
        walk(c.children);
        continue;
      }
      if (name === W_R) {
        const rPr = blockChildren(c).find((k) => nameOf(k) === W_RPR);
        const rPrText = rPr && blockChildren(rPr).length + rPr.attrs.length ? canonical(rPr) : '';
        for (const k of blockChildren(c)) {
          const n = nameOf(k);
          if (n === W_RPR || REGENERATED.has(n)) continue;
          if (TEXT.has(n)) {
            const t = k.children.map((x) => (x.kind === 'text' ? x.value : '')).join('');
            if (t) {
              facts.text += t;
              facts.rPrs.add(rPrText);
            }
          } else facts.atoms.push(canonical(k));
        }
        continue;
      }
      facts.atoms.push(canonical(c));
    }
  };
  walk(p.children);
  return facts;
}

interface Ctx {
  sm: SourceMap;
  edit: R1Edit;
  edited: Set<string>;
  deleted: Set<string>;
  /** Nodes with an edited descendant: compared structurally, not as a whole. */
  ancestors: Set<string>;
  addedAfter: Map<string, string[]>;
  byStart: Map<string, Map<number, string>>;
  violations: string[];
  exportedFacts: Map<string, ParagraphFacts>;
  originalFacts: Map<string, ParagraphFacts>;
}

function nodeIdOf(ctx: Ctx, part: string, el: XmlElement): string | undefined {
  return ctx.byStart.get(part)?.get(el.start);
}

/**
 * Compares a container's children: the expected sequence comes from the original children with
 * deleted nodes removed, gaps of deleted nodes passed on, added nodes after their origin and the
 * moved atom's paragraphs marked as edited.
 */
function compareContainer(
  ctx: Ctx,
  part: string,
  key: string,
  orig: XmlElement,
  out: XmlElement,
): void {
  const o = significant(orig.children).filter((c): c is XmlElement => c.kind === 'element');
  const x = significant(out.children).filter((c): c is XmlElement => c.kind === 'element');
  type Expect =
    | { kind: 'same'; el: XmlElement }
    | { kind: 'edited'; id: string; el: XmlElement }
    | { kind: 'ancestor'; id: string; el: XmlElement }
    | { kind: 'added'; id: string; from: XmlElement };
  const expect: Expect[] = [];
  const pendingGap: XmlElement[] = [];
  for (const el of o) {
    const id = nodeIdOf(ctx, part, el);
    if (id === undefined) {
      pendingGap.push(el);
      continue;
    }
    if (ctx.deleted.has(id)) continue;
    for (const g of pendingGap.splice(0)) expect.push({ kind: 'same', el: g });
    if (ctx.edited.has(id)) expect.push({ kind: 'edited', id, el });
    else if (ctx.ancestors.has(id)) expect.push({ kind: 'ancestor', id, el });
    else expect.push({ kind: 'same', el });
    for (const a of ctx.addedAfter.get(id) ?? []) expect.push({ kind: 'added', id: a, from: el });
  }
  for (const g of pendingGap) expect.push({ kind: 'same', el: g });
  if (expect.length !== x.length) {
    ctx.violations.push(`${part} ${key}: ${x.length} children, expected ${expect.length}`);
    return;
  }
  expect.forEach((e, i) => {
    const got = x[i]!;
    if (e.kind === 'same') {
      if (canonical(e.el) !== canonical(got))
        ctx.violations.push(
          `${part} ${key}: child ${i} <${e.el.qname}> changed outside the edit, first at ${elementDifference(e.el, got, `child ${i}`) ?? 'its text'}`,
        );
      return;
    }
    const origEl = e.kind === 'added' ? e.from : e.el;
    if (nameOf(got) !== nameOf(origEl)) {
      ctx.violations.push(
        `${part} ${key}: child ${i} is <${got.qname}>, expected <${origEl.qname}>`,
      );
      return;
    }
    if (e.kind === 'ancestor') {
      compareAncestor(ctx, part, e.id, e.el, got);
      return;
    }
    if (nameOf(got) !== W_P) return;
    if (e.kind === 'edited') {
      ctx.originalFacts.set(e.id, paragraphFacts(e.el));
      ctx.exportedFacts.set(e.id, paragraphFacts(got));
    } else ctx.exportedFacts.set(e.id, paragraphFacts(got));
  });
}

/** A table, row or cell with an edited descendant: its own properties must stay, its children are compared as a container. */
function compareAncestor(
  ctx: Ctx,
  part: string,
  id: string,
  orig: XmlElement,
  out: XmlElement,
): void {
  for (const a of orig.attrs) {
    const b = out.attrs.find((y) => nameOf(y) === nameOf(a));
    if (!b || b.value !== a.value)
      ctx.violations.push(`${part} ${id}: attribute ${a.qname} of <${orig.qname}> not kept`);
  }
  const head = (el: XmlElement): XmlElement[] =>
    blockChildren(el).filter((c) =>
      ['tblPr', 'tblGrid', 'trPr', 'tblPrEx', 'tcPr'].includes(c.local),
    );
  const h1 = head(orig)
    .map((c) => canonical(c))
    .join('');
  const h2 = head(out)
    .map((c) => canonical(c))
    .join('');
  if (h1 !== h2) ctx.violations.push(`${part} ${id}: properties of <${orig.qname}> changed`);
  const strip = (el: XmlElement): XmlElement => ({
    ...el,
    children: el.children.filter(
      (c) =>
        !(
          c.kind === 'element' && ['tblPr', 'tblGrid', 'trPr', 'tblPrEx', 'tcPr'].includes(c.local)
        ),
    ),
  });
  compareContainer(ctx, part, id, strip(orig), strip(out));
}

function sameSequence(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** R1 (c) and (d) for the edited and added paragraphs. */
function compareParagraphs(ctx: Ctx): void {
  const { edit } = ctx;
  for (const [id, before] of ctx.originalFacts) {
    const after = ctx.exportedFacts.get(id)!;
    const siblings = edit.added
      .filter((a) => a.from === id)
      .map((a) => ctx.exportedFacts.get(a.id))
      .filter((f): f is ParagraphFacts => !!f);
    for (const [k, v] of before.attrs)
      if (after.attrs.get(k) !== v) ctx.violations.push(`${id}: paragraph attribute ${k} not kept`);
    const pPrWanted = before.pPr.filter(
      (c) => !(edit.restyled?.id === id && c.startsWith(`<${w('pStyle')}`)),
    );
    let pos = 0;
    for (const c of pPrWanted) {
      const at = after.pPr.indexOf(c, pos);
      if (at < 0) ctx.violations.push(`${id}: paragraph property ${c.slice(0, 120)} not kept`);
      else pos = at + 1;
    }
    if (
      edit.restyled?.id === id &&
      !after.pPr.includes(
        `<${w('pStyle')} ${w('val')}="${edit.restyled.wordStyle}"></${w('pStyle')}>`,
      )
    )
      ctx.violations.push(`${id}: the new style ${edit.restyled.wordStyle} was not written`);
    const rPrsAfter = new Set([...after.rPrs, ...siblings.flatMap((s) => [...s.rPrs])]);
    for (const r of before.rPrs)
      if (!rPrsAfter.has(r))
        ctx.violations.push(`${id}: run properties ${r.slice(0, 160)} not kept`);
    let atomsBefore = before.atoms;
    let atomsAfter = [...after.atoms, ...siblings.flatMap((s) => s.atoms)];
    if (edit.movedAtom?.from === id) {
      const i = atomsBefore.indexOf(edit.movedAtom.canonical);
      if (i < 0) ctx.violations.push(`${id}: the moved atom was not in the original paragraph`);
      else atomsBefore = [...atomsBefore.slice(0, i), ...atomsBefore.slice(i + 1)];
    }
    if (edit.movedAtom?.to === id) {
      const atEnd = edit.movedAtom.position === 'end';
      const got = atEnd ? atomsAfter[atomsAfter.length - 1] : atomsAfter[0];
      if (got !== edit.movedAtom.canonical)
        ctx.violations.push(
          `${id}: the moved atom did not arrive at the ${edit.movedAtom.position} of the paragraph`,
        );
      else atomsAfter = atEnd ? atomsAfter.slice(0, -1) : atomsAfter.slice(1);
    }
    if (!sameSequence(atomsBefore, atomsAfter))
      ctx.violations.push(
        `${id}: content the model does not represent changed (${atomsBefore.length} atoms before, ${atomsAfter.length} after)`,
      );
    // A moved atom takes its suggestion marks, and so its revision, with it.
    const moved =
      edit.movedAtom?.from === id
        ? [...(ctx.exportedFacts.get(edit.movedAtom.to)?.revisions ?? [])]
        : [];
    const revAfter = new Set([
      ...after.revisions,
      ...siblings.flatMap((s) => [...s.revisions]),
      ...moved,
    ]);
    for (const r of before.revisions)
      if (!revAfter.has(r)) ctx.violations.push(`${id}: revision ${r.slice(0, 120)} not kept`);
    const wantText = edit.text[id];
    const gotText = after.text;
    if (wantText !== undefined && wantText !== gotText)
      ctx.violations.push(
        `${id}: text is ${JSON.stringify(gotText.slice(0, 60))}, expected ${JSON.stringify(wantText.slice(0, 60))}`,
      );
    for (const a of edit.added.filter((x) => x.from === id)) {
      const f = ctx.exportedFacts.get(a.id);
      if (!f) ctx.violations.push(`${a.id}: added paragraph not found`);
      else if (edit.text[a.id] !== undefined && f.text !== edit.text[a.id])
        ctx.violations.push(
          `${a.id}: text is ${JSON.stringify(f.text.slice(0, 60))}, expected ${JSON.stringify(edit.text[a.id]!.slice(0, 60))}`,
        );
      else
        for (const c of before.pPr)
          if (!f.pPr.includes(c))
            ctx.violations.push(
              `${a.id}: paragraph property ${c.slice(0, 120)} of the split paragraph not kept`,
            );
    }
  }
}

/**
 * R1: parts the edit did not reach are byte-identical; in the main part, every block and gap
 * outside the edit is canonically unchanged and in place; edited blocks keep what the model does
 * not represent.
 */
export function checkR1(
  original: Uint8Array,
  exported: Uint8Array,
  sm: SourceMap,
  edit: R1Edit,
): R1Result {
  const diff = diffParts(original, exported);
  const violations: string[] = [];
  const main = sm.mainPart;
  const relsName = relsPartName(main);
  const allowed = new Set([main]);
  if (edit.deleted.length) {
    allowed.add(relsName);
    allowed.add('[Content_Types].xml');
  }
  for (const p of diff.changed)
    if (!allowed.has(p)) violations.push(`part ${p} changed, but no edit reaches it (R1 a)`);
  for (const p of diff.added) violations.push(`part ${p} was added`);
  const a = readZip(original);
  const b = readZip(exported);
  // A part may go only with deleted content, and no relationship may be left pointing at it.
  if (diff.missing.length && !edit.deleted.length)
    violations.push(`parts removed without a deletion: ${diff.missing.join(', ')}`);
  for (const d of danglingTargets(b)) violations.push(`relationship ${d} points at a missing part`);
  // Every relationship the main part refers to must still exist.
  if (b.byName.has(relsName)) {
    const refs = referencedRelIds(parseXml(entryData(b, b.byName.get(main)!)).root);
    const rels = parseRelationships(main, entryData(b, b.byName.get(relsName)!));
    for (const id of refs)
      if (!rels.byId.has(id))
        violations.push(`the main part refers to relationship ${id}, which no longer exists`);
  }
  if (diff.changed.includes(main)) {
    const ctx = buildCtx(sm, edit, violations);
    const before = parseXml(entryData(a, a.byName.get(main)!));
    const after = parseXml(entryData(b, b.byName.get(main)!));
    const bodyA = blockChildren(before.root).find((c) => c.local === 'body');
    const bodyB = blockChildren(after.root).find((c) => c.local === 'body');
    if (!bodyA || !bodyB) violations.push('no body');
    else {
      const rootAttrs = (el: XmlElement): string => canonical({ ...el, children: [] });
      if (rootAttrs(before.root) !== rootAttrs(after.root))
        violations.push('the root element changed');
      compareContainer(ctx, main, 'body', bodyA, bodyB);
      compareParagraphs(ctx);
    }
  }
  return {
    pass: violations.length === 0,
    changedParts: diff.changed,
    removedParts: diff.missing,
    violations,
  };
}

/** Internal relationship targets that are not in the package, as `source#id`. */
export function danglingTargets(zip: ZipArchive): string[] {
  const out: string[] = [];
  for (const e of zip.entries) {
    if (!e.name.endsWith('.rels')) continue;
    const source = e.name === '_rels/.rels' ? '' : e.name.replace(/_rels\/([^/]+)\.rels$/, '$1');
    for (const r of parseRelationships(source, entryData(zip, e)).list) {
      if (r.external) continue;
      if (!zip.byName.has(resolveTarget(source, r.target)))
        out.push(`${source || '(package)'}#${r.id}`);
    }
  }
  return out;
}

function buildCtx(sm: SourceMap, edit: R1Edit, violations: string[]): Ctx {
  const byStart = new Map<string, Map<number, string>>();
  for (const [id, n] of Object.entries(sm.nodes)) {
    let m = byStart.get(n.part);
    if (!m) byStart.set(n.part, (m = new Map()));
    m.set(n.start, id);
  }
  const edited = new Set([
    ...edit.edited,
    ...(edit.movedAtom ? [edit.movedAtom.from, edit.movedAtom.to] : []),
  ]);
  const ancestors = new Set<string>();
  const contains = (outer: string, inner: string): boolean => {
    const o = sm.nodes[outer];
    const i = sm.nodes[inner];
    return !!o && !!i && o.part === i.part && o.start < i.start && i.end <= o.end;
  };
  const touched = [...edited, ...edit.deleted, ...edit.added.map((x) => x.from)];
  for (const id of Object.keys(sm.nodes))
    if (touched.some((t) => t !== id && contains(id, t))) ancestors.add(id);
  const addedAfter = new Map<string, string[]>();
  for (const x of edit.added) addedAfter.set(x.from, [...(addedAfter.get(x.from) ?? []), x.id]);
  return {
    sm,
    edit,
    edited,
    deleted: new Set(edit.deleted),
    ancestors,
    addedAfter,
    byStart,
    violations,
    exportedFacts: new Map(),
    originalFacts: new Map(),
  };
}

export type { ZipArchive };
