/**
 * The document, users and steps the contract suite works with. Steps are built as JSON (04 §4) and
 * positions are computed from CDM JSON with the CDM definition, without ProseMirror (PRO-091).
 */
import type { CdmEnvelope } from '@docedit/model';
import { CDM1 } from '@docedit/model/definition';
import type { Step } from '../ports/types.ts';
import type { ContractUser, GrantSpec } from './harness.ts';

export const IDS = {
  intro: 'pIntro0000000001',
  open: 'rOpen00000000001',
  openPara: 'pOpen00000000001',
  mid: 'pMid000000000001',
  locked: 'rLocked000000001',
  lockedPara: 'pLocked000000001',
  end: 'pEnd000000000001',
} as const;

export const LOCKED_SCOPE = `region:${IDS.locked}`;

const para = (id: string, text: string) => ({
  type: 'paragraph',
  attrs: { id },
  ...(text ? { content: [{ type: 'text', text }] } : {}),
});

/** A body with an open region and a restricted region between paragraphs (07 §4). */
export function contractDocument(): CdmEnvelope {
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'en-GB' } },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            para(IDS.intro, 'Hello world'),
            {
              type: 'region',
              attrs: { id: IDS.open, title: 'Open', policy: 'inherit' },
              content: [para(IDS.openPara, 'Open region')],
            },
            para(IDS.mid, 'Between'),
            {
              type: 'region',
              attrs: { id: IDS.locked, title: 'Locked', policy: 'restricted' },
              content: [para(IDS.lockedPara, 'Restricted text')],
            },
            para(IDS.end, ''),
          ],
        },
      ],
    },
  } as unknown as CdmEnvelope;
}

/** A replacement content for a snapshot commit. */
export function importedDocument(): CdmEnvelope {
  const doc = contractDocument();
  const body = (doc.doc.content as unknown as Array<{ type: string; content: unknown[] }>)[1]!;
  body.content = [para(IDS.intro, 'Imported text'), para(IDS.end, '')];
  return doc;
}

/** The cast: document roles in the token, and the grant that opens the restricted region. */
export const USERS = {
  owner: { sub: 'olivia', name: 'Olivia' },
  editor: { sub: 'eddie', name: 'Eddie' },
  grantee: { sub: 'grace', name: 'Grace', groups: ['legal'] },
  viewer: { sub: 'victor', name: 'Victor' },
} as const satisfies Record<string, ContractUser>;

export const ROLES = {
  owner: 'owner',
  editor: 'editor',
  grantee: 'editor',
  viewer: 'viewer',
} as const;

export const LEGAL_GRANT: GrantSpec = {
  region: IDS.locked,
  principal: 'group:legal',
  role: 'editor',
};

// --- Positions --------------------------------------------------------------------------------

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
}

const LEAVES: ReadonlySet<string> = new Set(
  CDM1.nodes.filter((n) => !n.content).map((n) => n.name),
);

/** ProseMirror size of a node from its JSON: text length, 1 for a leaf, 2 plus content otherwise. */
export function nodeSize(n: JsonNode): number {
  if (n.type === 'text') return (n.text ?? '').length;
  if (LEAVES.has(n.type)) return 1;
  return 2 + (n.content ?? []).reduce((s, c) => s + nodeSize(c), 0);
}

/** The position just inside the start of the node with this `id`, plus `offset`. */
export function posIn(doc: unknown, id: string, offset = 0): number {
  const found = search(doc as JsonNode, id, 0);
  if (found === null) throw new Error(`no node ${id} in the document`);
  return found + 1 + offset;
}

function search(node: JsonNode, id: string, start: number): number | null {
  // `start` is the position before `node`; its content starts at start + 1 (the root has none).
  let pos = node.type === 'doc' ? 0 : start + 1;
  for (const child of node.content ?? []) {
    if (child.attrs?.['id'] === id) return pos;
    if (child.type !== 'text' && !LEAVES.has(child.type)) {
      const inner = search(child, id, pos);
      if (inner !== null) return inner;
    }
    pos += nodeSize(child);
  }
  return null;
}

/** The plain text of the node with this `id`. */
export function textOf(doc: unknown, id: string): string {
  const find = (n: JsonNode): JsonNode | null => {
    if (n.attrs?.['id'] === id) return n;
    for (const c of n.content ?? []) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  const node = find(doc as JsonNode);
  if (!node) throw new Error(`no node ${id} in the document`);
  const collect = (n: JsonNode): string =>
    n.type === 'text' ? (n.text ?? '') : (n.content ?? []).map(collect).join('');
  return collect(node);
}

// --- Steps ------------------------------------------------------------------------------------

export function insertText(pos: number, text: string): Step {
  return { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } };
}

export function deleteRange(from: number, to: number): Step {
  return { stepType: 'replace', from, to };
}
