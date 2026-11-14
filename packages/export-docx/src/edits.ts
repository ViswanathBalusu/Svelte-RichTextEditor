/**
 * The scripted edits of SPK-028, applied to an imported document as the editor would apply them:
 * typing in a paragraph, splitting it, deleting a block, changing a paragraph's style and moving a
 * preserved atom. Each returns the edited document and what the R1 check must expect.
 */
import { nodeId, utf8, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { readFragment } from './assets.ts';
import type { R1Edit } from './conformance.ts';
import type { AssetSource } from './export.ts';
import { NS } from './ooxml.ts';
import { sharedTrees } from './share.ts';
import { type TreeBody, type TreeElement, canonicalTree, isTreeRef } from './tree.ts';
import type { SourceMap } from './source-map.ts';
import { canonical, elements, parseXml } from './xml.ts';

export interface ScriptedEdit {
  name: string;
  envelope: JsonEnvelope;
  edit: R1Edit;
}

export interface SkippedEdit {
  name: string;
  skipped: string;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function bodyOf(env: JsonEnvelope): JsonNode {
  const b = env.doc.content?.find((n) => n.type === 'body');
  if (!b) throw new Error('no body');
  return b;
}

const idOf = (n: JsonNode): string => String(n.attrs?.['id']);
const textOf = (p: JsonNode): string =>
  (p.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');

function descendantIds(n: JsonNode, out: string[] = []): string[] {
  if (typeof n.attrs?.['id'] === 'string') out.push(n.attrs['id']);
  for (const c of n.content ?? []) descendantIds(c, out);
  return out;
}

/** A paragraph and the node whose content holds it (the body or a table cell). */
interface Located {
  p: JsonNode;
  parent: JsonNode;
}

/** Paragraphs that came from the file, body-level ones first, then those in table cells, in document order. */
function paragraphs(body: JsonNode, sm: SourceMap): Located[] {
  const synthetic = new Set(sm.synthetic);
  const top: Located[] = [];
  const nested: Located[] = [];
  const walk = (parent: JsonNode, depth: number): void => {
    for (const n of parent.content ?? []) {
      if (n.type === 'paragraph') {
        if (!synthetic.has(idOf(n)) && sm.nodes[idOf(n)])
          (depth === 0 ? top : nested).push({ p: n, parent });
      } else if (n.type === 'table' || n.type === 'table_row' || n.type === 'table_cell')
        walk(n, depth + 1);
    }
  };
  walk(body, 0);
  return [...top, ...nested];
}

/** Paragraphs that hold text. */
function textParagraphs(body: JsonNode, sm: SourceMap): Located[] {
  return paragraphs(body, sm).filter((l) => textOf(l.p).length > 0);
}

const MOVABLE = new Set([
  'text box',
  'shape',
  'chart',
  'SmartArt',
  'picture',
  'embedded object',
  'equation',
  'content control',
  'hyperlink',
  'group',
  'canvas',
  'drawing',
  'alternate content',
  'symbol',
  'smart tag',
  'custom XML',
  'footnote',
  'endnote',
  'ruby',
  'ptab',
  'tab',
  'break',
  'sym',
]);

/** The canonical XML of the element an atom's fragment holds (its run content, for a run). */
export function atomCanonical(fragmentBytes: Uint8Array): string {
  const f = readFragment(fragmentBytes);
  const decls = Object.entries(f.meta.namespaces)
    .map(([p, u]) => (p ? ` xmlns:${p}="${u.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"` : ''))
    .join('');
  const doc = parseXml(utf8(`<s11-wrap${decls}>${f.xml}</s11-wrap>`));
  const el = elements(doc.root)[0]!;
  if (el.ns === NS.w && el.local === 'r') {
    const content = elements(el).filter((c) => !(c.ns === NS.w && c.local === 'rPr'));
    if (content.length === 1) return canonical(content[0]!);
  }
  return canonical(el);
}

/** The canonical XML of an atom's content, from its fragment or its tree (shared trees resolved). */
export function atomCanonicalOf(
  atom: JsonNode,
  env: JsonEnvelope,
  assets: AssetSource,
): string | null {
  const fragment = atom.attrs?.['fragment'];
  if (typeof fragment === 'string') {
    const asset = assets.get(fragment);
    return asset ? atomCanonical(asset.bytes) : null;
  }
  let tree = atom.attrs?.['tree'] as unknown;
  if (isTreeRef(tree)) tree = sharedTrees(env).get(tree.ref);
  const kids = (tree as TreeBody | null | undefined)?.children ?? [];
  const el = kids.find((c): c is TreeElement => 'name' in c);
  return kids.length === 1 && el ? canonicalTree(el) : null;
}

export function scriptedEdits(
  env: JsonEnvelope,
  sm: SourceMap,
  assets: AssetSource,
): Array<ScriptedEdit | SkippedEdit> {
  return [
    typeText(env, sm),
    split(env, sm),
    deleteBlock(env, sm, assets),
    restyle(env, sm),
    moveAtom(env, sm, assets),
  ];
}

export function typeText(env0: JsonEnvelope, sm: SourceMap): ScriptedEdit | SkippedEdit {
  const env = clone(env0);
  const p = textParagraphs(bodyOf(env), sm)[0]?.p;
  if (!p) return { name: 'type', skipped: 'no paragraph with text outside preserved content' };
  const t = p.content!.find((c) => c.type === 'text')!;
  t.text = `S11 ${t.text}`;
  return {
    name: 'type',
    envelope: env,
    edit: {
      name: 'type',
      edited: [idOf(p)],
      deleted: [],
      added: [],
      text: { [idOf(p)]: textOf(p) },
    },
  };
}

export function split(env0: JsonEnvelope, sm: SourceMap): ScriptedEdit | SkippedEdit {
  const env = clone(env0);
  const body = bodyOf(env);
  for (const { p, parent } of textParagraphs(body, sm)) {
    const k = p.content!.findIndex((c) => c.type === 'text' && (c.text ?? '').length >= 2);
    if (k < 0) continue;
    const node = p.content![k]!;
    const at = Math.floor(node.text!.length / 2);
    const left: JsonNode = { ...node, text: node.text!.slice(0, at) };
    const right: JsonNode = { ...node, text: node.text!.slice(at) };
    const q: JsonNode = {
      type: 'paragraph',
      attrs: { ...p.attrs, id: nodeId() },
      content: [right, ...p.content!.slice(k + 1)],
    };
    p.content = [...p.content!.slice(0, k), left];
    parent.content!.splice(parent.content!.indexOf(p) + 1, 0, q);
    return {
      name: 'split',
      envelope: env,
      edit: {
        name: 'split',
        edited: [idOf(p)],
        deleted: [],
        added: [{ id: idOf(q), from: idOf(p) }],
        text: { [idOf(p)]: textOf(p), [idOf(q)]: textOf(q) },
      },
    };
  }
  return { name: 'split', skipped: 'no paragraph with a text node of two characters' };
}

export function deleteBlock(
  env0: JsonEnvelope,
  sm: SourceMap,
  assets: AssetSource,
): ScriptedEdit | SkippedEdit {
  const env = clone(env0);
  const body = bodyOf(env);
  const blocks = (body.content ?? []).filter(
    (n, i, all) =>
      n.type !== 'section_break' && sm.nodes[idOf(n)] && all[i + 1]?.type !== 'section_break',
  );
  if ((body.content ?? []).filter((n) => n.type !== 'section_break').length < 2 || !blocks.length)
    return { name: 'delete', skipped: 'too few blocks' };
  // Prefer a block whose preserved content refers to relationships, so that clean-up is exercised.
  const withRels = blocks.find((b) => {
    const atoms: JsonNode[] = [];
    const walk = (n: JsonNode): void => {
      if (n.type === 'preserved_inline' || n.type === 'preserved_block') atoms.push(n);
      for (const c of n.content ?? []) walk(c);
    };
    walk(b);
    return atoms.some((a) => {
      const asset = assets.get(String(a.attrs?.['fragment']));
      return !!asset && readFragment(asset.bytes).meta.rels.length > 0;
    });
  });
  const target = withRels ?? blocks[Math.min(1, blocks.length - 1)]!;
  body.content = body.content!.filter((n) => n !== target);
  return {
    name: 'delete',
    envelope: env,
    edit: { name: 'delete', edited: [], deleted: descendantIds(target), added: [], text: {} },
  };
}

export function restyle(env0: JsonEnvelope, sm: SourceMap): ScriptedEdit | SkippedEdit {
  const env = clone(env0);
  const p = textParagraphs(bodyOf(env), sm)[0]?.p;
  if (!p) return { name: 'restyle', skipped: 'no paragraph with text outside preserved content' };
  const defs = env.doc.content?.find((n) => n.type === 'defs')?.content ?? [];
  const styles = defs.filter(
    (d) =>
      d.type === 'style_def' &&
      (d.attrs?.['kind'] ?? 'paragraph') === 'paragraph' &&
      sm.styles[idOf(d)] &&
      sm.defs[idOf(d)],
  );
  const current = p.attrs?.['style'] ?? null;
  const next =
    styles.find((s) => idOf(s) === 'Heading1' && current !== 'Heading1') ??
    styles.find((s) => idOf(s) !== current);
  if (!next) return { name: 'restyle', skipped: 'no other paragraph style' };
  p.attrs = { ...p.attrs, style: idOf(next) };
  return {
    name: 'restyle',
    envelope: env,
    edit: {
      name: 'restyle',
      edited: [idOf(p)],
      deleted: [],
      added: [],
      restyled: { id: idOf(p), wordStyle: sm.styles[idOf(next)]! },
      text: { [idOf(p)]: textOf(p) },
    },
  };
}

export function moveAtom(
  env0: JsonEnvelope,
  sm: SourceMap,
  assets: AssetSource,
): ScriptedEdit | SkippedEdit {
  const env = clone(env0);
  const body = bodyOf(env);
  const all = paragraphs(body, sm).map((l) => l.p);
  for (let i = 0; i < all.length; i++) {
    const p1 = all[i]!;
    const k = (p1.content ?? []).findIndex(
      (c) => c.type === 'preserved_inline' && MOVABLE.has(String(c.attrs?.['label'])),
    );
    if (k < 0) continue;
    const atom = p1.content![k]!;
    const canonicalXml = atomCanonicalOf(atom, env, assets);
    if (!canonicalXml) continue;
    // To the end of the next paragraph; with no other paragraph, to the other end of its own.
    const p2 = all[i + 1] ?? all[i - 1] ?? p1;
    let position: 'start' | 'end' = 'end';
    p1.content = p1.content!.filter((_, j) => j !== k);
    if (p2 === p1 && k === p1.content.length) position = 'start';
    if (p2 === p1 && p1.content.length === 0) {
      p1.content.push(atom);
      continue;
    }
    p2.content = position === 'end' ? [...(p2.content ?? []), atom] : [atom, ...(p2.content ?? [])];
    if (!p1.content.length) delete p1.content;
    return {
      name: 'move atom',
      envelope: env,
      edit: {
        name: 'move atom',
        edited: [...new Set([idOf(p1), idOf(p2)])],
        deleted: [],
        added: [],
        movedAtom: {
          from: idOf(p1),
          to: idOf(p2),
          canonical: canonicalXml,
          position,
        },
        text: { [idOf(p1)]: textOf(p1), [idOf(p2)]: textOf(p2) },
      },
    };
  }
  return { name: 'move atom', skipped: 'no movable preserved atom in a paragraph' };
}

/** Marks every body paragraph (at any depth) as edited, for the regeneration stress test. */
export function everyParagraph(env: JsonEnvelope, sm: SourceMap): R1Edit {
  const edited: string[] = [];
  const text: Record<string, string> = {};
  const synthetic = new Set(sm.synthetic);
  const walk = (n: JsonNode): void => {
    if (n.type === 'paragraph' && sm.nodes[idOf(n)] && !synthetic.has(idOf(n))) {
      edited.push(idOf(n));
      text[idOf(n)] = textOf(n);
    }
    if (n.type !== 'paragraph') for (const c of n.content ?? []) walk(c);
  };
  walk(bodyOf(env));
  return { name: 'regenerate every paragraph', edited, deleted: [], added: [], text };
}
