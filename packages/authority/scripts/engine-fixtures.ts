/**
 * The engine definition of `pm-steps/1` and its golden fixtures (04 §4; SYN-002).
 *
 * The step semantics are those of one exact release of prosemirror-transform. This module builds,
 * from that release and the generated CDM schema, language-neutral JSON fixtures for apply, map and
 * rebase, so that an authority written in another language can show it reproduces the semantics.
 * `scripts/generate.ts` writes them; `test/engine.test.ts` replays them.
 *
 * Inputs are made by a seeded generator (no clock, no platform randomness), so a run with the same
 * release and schema writes the same bytes.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, canonicalNode, sha256Hex, type JsonNode } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import type { Node } from 'prosemirror-model';
import { Mapping, Step, Transform } from 'prosemirror-transform';
import { applySteps, mapsOf, rebaseOver } from '../src/rebase.ts';
import { ALLOWED_STEP_TYPES } from '../src/steps.ts';

export const ENGINE_ID = 'pm-steps/1';
/**
 * The releases `pm-steps/1` is pinned to. prosemirror-model is pinned too, because applying a step
 * runs its replace algorithm and its content checks. A release that changes any fixture output is
 * a new engine identifier, never a silent upgrade (04 §4).
 */
export const PINNED = {
  'prosemirror-transform': '1.12.5',
  'prosemirror-model': '1.25.12',
} as const;

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIR = resolve(here, '..');
export const ROOT = resolve(PACKAGE_DIR, '../..');
export const ENGINE_DIR = 'packages/authority/fixtures/engine';

/** The version of a dependency as the authority package resolves it. */
export function installedVersion(name: keyof typeof PINNED): string {
  const pkg = JSON.parse(
    readFileSync(resolve(PACKAGE_DIR, 'node_modules', name, 'package.json'), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

/** The generated CDM ProseMirror schema and its published hash (CDM-008). */
export async function schemaInfo(): Promise<{
  cdm: number;
  status: string;
  artifact: string;
  sha256: string;
}> {
  const manifest = JSON.parse(
    readFileSync(resolve(ROOT, 'spec/cdm/cdm-1.manifest.json'), 'utf8'),
  ) as { cdm: number; status: string; prosemirrorSchemaHash: string };
  const artifact = 'spec/cdm/cdm-1.prosemirror.json';
  const actual = await sha256Hex(
    canonicalize(JSON.parse(readFileSync(resolve(ROOT, artifact), 'utf8')) as unknown),
  );
  if (actual !== manifest.prosemirrorSchemaHash)
    throw new Error(`${artifact} does not match its manifest hash; run pnpm generate`);
  return { cdm: manifest.cdm, status: manifest.status, artifact, sha256: actual };
}

// -------------------------------------------------------------------------------------------------
// The base document: paragraphs with marks, a region, a table and a footnote.

const t = (text: string, marks?: unknown[]) =>
  marks ? { type: 'text', text, marks } : { type: 'text', text };
const p = (id: string, content: unknown[], attrs: Record<string, unknown> = {}) => ({
  type: 'paragraph',
  attrs: { id, ...attrs },
  content,
});
const cell = (id: string, text: string) => ({
  type: 'table_cell',
  attrs: { id },
  content: [p(`p${id.slice(1)}`, [t(text)])],
});

export const BASE_DOC = {
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
        {
          type: 'style_def',
          attrs: {
            id: 'Heading1',
            kind: 'paragraph',
            name: 'Heading 1',
            builtIn: true,
            basedOn: 'Normal',
            outlineLevel: 1,
          },
        },
        { type: 'page_setup', attrs: { id: 'ps1' } },
      ],
    },
    {
      type: 'body',
      attrs: { pageSetup: 'ps1' },
      content: [
        p('pTitle0000000001', [t('Engine fixtures')], { style: 'Heading1' }),
        p('pMarks0000000001', [
          t('Plain '),
          t('bold', [{ type: 'bold' }]),
          t(' and '),
          t('italic', [{ type: 'italic' }]),
          t(' text.'),
        ]),
        {
          type: 'region',
          attrs: { id: 'rClause000000001', title: 'Clause', policy: 'inherit' },
          content: [
            p('pClause000000001', [t('Liability is limited.')]),
            p('pClause000000002', [t('Notice is in writing.')]),
          ],
        },
        {
          ...p('pMiddle000000001', [t('Between the region and the table.')]),
          marks: [{ type: 'del', attrs: { id: 'sSuggestion00002', user: 'u2' } }],
        },
        {
          type: 'table',
          attrs: { id: 'tTable0000000001', grid: [2000, 2000] },
          content: [
            {
              type: 'table_row',
              attrs: { id: 'trRow00000000001' },
              content: [cell('cA00000000000001', 'Rent'), cell('cB00000000000001', 'Monthly')],
            },
            {
              type: 'table_row',
              attrs: { id: 'trRow00000000002' },
              content: [cell('cA00000000000002', 'Deposit'), cell('cB00000000000002', 'One month')],
            },
          ],
        },
        p('pNote00000000001', [
          t('With a note'),
          {
            type: 'footnote',
            attrs: { id: 'fnNote0000000001' },
            content: [p('pFootnote0000001', [t('Footnote text.')])],
          },
          t('.'),
        ]),
        p('pEnd000000000001', []),
      ],
    },
  ],
};

// -------------------------------------------------------------------------------------------------
// A seeded generator of edits (mulberry32), independent of any test library.

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

interface Textblock {
  pos: number;
  node: Node;
}

function textblocks(doc: Node): Textblock[] {
  const out: Textblock[] = [];
  const body = doc.child(doc.childCount - 1);
  const start = doc.content.size - body.nodeSize + 1;
  body.descendants((node, pos) => {
    if (node.isTextblock) out.push({ pos: start + pos, node });
    return true;
  });
  return out;
}

let fresh = 0;
const freshId = (prefix: string) => `${prefix}${String(++fresh).padStart(15, '0')}`.slice(0, 16);

/** One random edit through a Transform; returns false when it did not apply. */
function edit(tr: Transform, rnd: () => number): boolean {
  const schema = tr.doc.type.schema;
  const blocks = textblocks(tr.doc);
  const b = blocks[Math.floor(rnd() * blocks.length)]!;
  const size = b.node.content.size;
  const from = b.pos + 1 + Math.floor(rnd() * (size + 1));
  const to = Math.min(b.pos + 1 + size, from + 1 + Math.floor(rnd() * 6));
  const kind = Math.floor(rnd() * 11);
  const before = tr.steps.length;
  try {
    switch (kind) {
      case 0:
      case 1:
        tr.insert(from, schema.text(['x', 'new ', 'é', '中'][Math.floor(rnd() * 4)]!));
        break;
      case 2:
        if (to > from) tr.delete(from, to);
        break;
      case 3:
        if (to > from)
          tr.addMark(from, to, schema.marks[rnd() < 0.5 ? 'bold' : 'italic']!.create());
        break;
      case 4:
        // Remove a mark wherever it is in the body, so that the step usually exists.
        tr.removeMark(1, tr.doc.content.size - 1, schema.marks[rnd() < 0.5 ? 'bold' : 'italic']!);
        break;
      case 5:
        if (b.node.type.name === 'paragraph') {
          tr.split(from);
          const $after = tr.doc.resolve(tr.mapping.map(from));
          tr.setNodeAttribute($after.before($after.depth), 'id', freshId('p'));
        }
        break;
      case 6:
        if (b.node.type.name === 'paragraph')
          tr.setNodeAttribute(b.pos, 'style', rnd() < 0.5 ? 'Heading1' : null);
        break;
      case 7: {
        if (b.node.type.name !== 'paragraph') break;
        const del = b.node.marks.find((m) => m.type.name === 'del');
        if (del) tr.removeNodeMark(b.pos, del);
        else
          tr.addNodeMark(
            b.pos,
            schema.marks['del']!.create({ id: 'sSuggestion00001', user: 'u1' }),
          );
        break;
      }
      case 8: {
        // Lift a paragraph out of its region, or wrap a body paragraph in a new region: both are
        // replaceAround steps.
        const $p = tr.doc.resolve(b.pos + 1);
        const range = $p.blockRange();
        if (!range) break;
        if (range.parent.type.name === 'region') tr.lift(range, range.depth - 1);
        else if (range.parent.type.name === 'body')
          tr.wrap(range, [{ type: schema.nodes['region']!, attrs: { id: freshId('r') } }]);
        break;
      }
      case 9: {
        // Join a paragraph with the next one when both are direct children of the same parent.
        const $p = tr.doc.resolve(b.pos);
        const after = b.pos + b.node.nodeSize;
        if (
          $p.parent.childAfter($p.parentOffset).node === b.node &&
          tr.doc.resolve(after).nodeAfter?.isTextblock
        )
          tr.join(after);
        break;
      }
      case 10:
        tr.addMark(
          from,
          Math.max(to, from + 1),
          schema.marks['link']!.create({ href: 'https://example.org/' }),
        );
        break;
    }
  } catch {
    // An edit that ProseMirror refuses for this position is skipped.
  }
  return tr.steps.length > before;
}

function editSteps(doc: Node, rnd: () => number, count: number): Step[] {
  const tr = new Transform(doc);
  for (let i = 0; i < count * 4 && tr.steps.length < count; i++) edit(tr, rnd);
  return tr.steps;
}

// -------------------------------------------------------------------------------------------------

const json = (steps: readonly Step[]) => steps.map((s) => s.toJSON() as Record<string, unknown>);
const canonicalDoc = (doc: Node) => canonicalNode(doc.toJSON() as JsonNode);
const docHash = (doc: Node) => sha256Hex(canonicalize(canonicalDoc(doc)));

/** Steps that a correct engine must refuse to apply, each for a different reason. */
function failingCases(doc: Node): Array<{ name: string; steps: Record<string, unknown>[] }> {
  const size = doc.content.size;
  const region = textblocks(doc).find((b) => b.node.attrs['id'] === 'pClause000000001')!;
  const middle = textblocks(doc).find((b) => b.node.attrs['id'] === 'pMiddle000000001')!;
  return [
    {
      name: 'a mark step past the end of the document',
      steps: [{ stepType: 'addMark', from: size - 2, to: size + 40, mark: { type: 'bold' } }],
    },
    {
      name: 'a replace step whose slice does not fit (a region inside a region)',
      steps: [
        {
          stepType: 'replace',
          from: region.pos + 1,
          to: region.pos + 1,
          slice: {
            content: [
              {
                type: 'region',
                attrs: { id: 'rInner0000000001' },
                content: [{ type: 'paragraph', attrs: { id: 'pInner0000000001' } }],
              },
            ],
          },
        },
      ],
    },
    {
      name: 'an attribute step at a position with no node',
      steps: [{ stepType: 'attr', pos: size + 5, attr: 'style', value: 'Heading1' }],
    },
    {
      name: 'a node mark that the parent does not allow (bold on a body paragraph)',
      steps: [{ stepType: 'addNodeMark', pos: middle.pos, mark: { type: 'bold' } }],
    },
    {
      name: 'a replace step that deletes past the end of the document',
      steps: [{ stepType: 'replace', from: size - 1, to: size + 10 }],
    },
    {
      name: 'a valid step followed by a step that cannot apply',
      steps: [
        {
          stepType: 'replace',
          from: region.pos + 1,
          to: region.pos + 1,
          slice: { content: [{ type: 'text', text: 'ok ' }] },
        },
        { stepType: 'removeMark', from: 3, to: size + 40, mark: { type: 'bold' } },
      ],
    },
  ];
}

export interface EngineFile {
  path: string;
  text: string;
}

/**
 * JSON as the repository's Prettier configuration prints it: short arrays and objects on one line,
 * longer ones broken. Any JSON parser reads it; people can review it; `pnpm lint` accepts it.
 */
export async function pretty(value: unknown): Promise<string> {
  const prettier = await import('prettier');
  const options = (await prettier.resolveConfig(resolve(ROOT, 'package.json'))) ?? {};
  return prettier.format(JSON.stringify(value), { ...options, parser: 'json' });
}

const out = (value: unknown) => pretty(value);

/** Builds the engine definition file and the three golden fixture files. */
export async function buildEngineFiles(): Promise<EngineFile[]> {
  fresh = 0;
  const schema = cdmSchema();
  const base = schema.nodeFromJSON(BASE_DOC);
  base.check();
  const info = await schemaInfo();
  const library = {
    'prosemirror-transform': installedVersion('prosemirror-transform'),
    'prosemirror-model': installedVersion('prosemirror-model'),
  };
  const header = (kind: string, description: string) => ({
    engine: ENGINE_ID,
    kind,
    description,
    library,
    schema: { cdm: info.cdm, sha256: info.sha256 },
    docs: { base: BASE_DOC },
  });

  // apply: random edits that apply, and crafted steps that must fail.
  const rnd = prng(0x5e1f1a);
  const apply: unknown[] = [];
  const editsForMap: Step[][] = [];
  for (let i = 0; i < 24; i++) {
    const steps = editSteps(base, rnd, 1 + Math.floor(rnd() * 4));
    const r = applySteps(base, steps);
    if (!r.ok) throw new Error(`generated steps do not apply: ${r.reason}`);
    editsForMap.push(steps);
    apply.push({
      id: `apply-${String(i + 1).padStart(3, '0')}`,
      doc: 'base',
      steps: json(steps),
      expected: { ok: true, doc: canonicalDoc(r.value.doc), docSha256: await docHash(r.value.doc) },
    });
  }
  for (const [i, c] of failingCases(base).entries()) {
    const r = applySteps(
      base,
      c.steps.map((s) => Step.fromJSON(schema, s)),
    );
    if (r.ok) throw new Error(`failing case "${c.name}" applies`);
    const failedStep = Number(/^step (\d+)/.exec(r.reason)![1]);
    apply.push({
      id: `apply-fail-${String(i + 1).padStart(3, '0')}`,
      name: c.name,
      doc: 'base',
      steps: c.steps,
      expected: { ok: false, failedStep },
    });
  }

  // map: positions through the maps of the generated edits, with both associations.
  const map: unknown[] = [];
  for (const [i, steps] of editsForMap.slice(0, 16).entries()) {
    const mapping = new Mapping(mapsOf(steps));
    const positions: Array<{ pos: number; assoc: -1 | 1 }> = [];
    for (let k = 0; k < 12; k++) {
      const pos = Math.floor(rnd() * (base.content.size + 1));
      positions.push({ pos, assoc: rnd() < 0.5 ? -1 : 1 });
    }
    map.push({
      id: `map-${String(i + 1).padStart(3, '0')}`,
      steps: json(steps),
      positions,
      expected: positions.map(({ pos, assoc }) => {
        const r = mapping.mapResult(pos, assoc);
        return {
          pos: r.pos,
          deleted: r.deleted,
          deletedBefore: r.deletedBefore,
          deletedAfter: r.deletedAfter,
          deletedAcross: r.deletedAcross,
        };
      }),
    });
  }

  // rebase: a commit made on the base, mapped over concurrent steps accepted after the base.
  const rebase: unknown[] = [];
  let withDrops = 0;
  for (let i = 0; rebase.length < 44 && i < 4000; i++) {
    const over = editSteps(base, rnd, 1 + Math.floor(rnd() * 3));
    const steps = editSteps(base, rnd, 1 + Math.floor(rnd() * 3));
    if (!over.length || !steps.length) continue;
    const head = applySteps(base, over);
    if (!head.ok) throw new Error(head.reason);
    const drop = rebaseOver(steps, mapsOf(over), head.value.doc, 'drop');
    const reject = rebaseOver(steps, mapsOf(over), head.value.doc, 'reject');
    if (!drop.ok) throw new Error('drop mode never fails');
    // Keep every case with a dropped step, and enough of the others.
    if (!drop.value.dropped.length && rebase.length - withDrops >= 28) continue;
    if (drop.value.dropped.length) withDrops++;
    rebase.push({
      id: `rebase-${String(rebase.length + 1).padStart(3, '0')}`,
      doc: 'base',
      over: json(over),
      steps: json(steps),
      expected: {
        reject: reject.ok
          ? {
              ok: true,
              steps: json(reject.value.steps),
              docSha256: await docHash(reject.value.doc),
            }
          : { ok: false, code: 'rebase_failed', failedStep: drop.value.dropped[0] },
        drop: {
          steps: json(drop.value.steps),
          dropped: drop.value.dropped,
          docSha256: await docHash(drop.value.doc),
        },
      },
    });
  }

  const definition = {
    engine: ENGINE_ID,
    spec: '04 §4; SYN-002',
    description:
      'Step semantics of the server-authoritative engine: the JSON of Step.toJSON() in the release of prosemirror-transform named here, applied against the generated CDM ProseMirror schema named here. A release that changes any fixture output is a new engine identifier.',
    library: { name: 'prosemirror-transform', version: PINNED['prosemirror-transform'] },
    alsoPinned: [
      {
        name: 'prosemirror-model',
        version: PINNED['prosemirror-model'],
        why: 'Applying a step runs the replace algorithm and the content checks of prosemirror-model.',
      },
    ],
    schema: info,
    stepTypes: [...ALLOWED_STEP_TYPES],
    fixtures: {
      apply: 'golden/apply.json',
      map: 'golden/map.json',
      rebase: 'golden/rebase.json',
    },
    comparison:
      'Documents are compared in the CDM canonical form (03 §2) and by the SHA-256 of its RFC 8785 text; steps by their JSON. A failing step is identified by its index.',
    generator: 'packages/authority/scripts/generate.ts',
  };

  return [
    { path: `${ENGINE_DIR}/pm-steps-1.json`, text: await out(definition) },
    {
      path: `${ENGINE_DIR}/golden/apply.json`,
      text: await out({
        ...header(
          'apply',
          "Apply each case's steps in order to the named document. `ok` with the resulting document, or the index of the first step that fails.",
        ),
        cases: apply,
      }),
    },
    {
      path: `${ENGINE_DIR}/golden/map.json`,
      text: await out({
        ...header(
          'map',
          "Map each position, with its association (-1 or 1), through the maps of the steps in order. The result is the mapped position and the deletion flags of ProseMirror's MapResult.",
        ),
        cases: map,
      }),
    },
    {
      path: `${ENGINE_DIR}/golden/rebase.json`,
      text: await out({
        ...header(
          'rebase',
          'Apply `over` to the document; then map `steps`, made on the document, over the maps of `over` with the procedure of 04 §6. `reject` is the authority (any step that maps to nothing or fails rejects the commit); `drop` is the client (such steps are dropped).',
        ),
        cases: rebase,
      }),
    },
  ];
}
