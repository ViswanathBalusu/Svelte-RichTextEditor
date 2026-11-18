/**
 * Node.js measurement of the room's permission indexes and the outcome check on a document at the
 * limits (PRM-016 criterion 5; FND-007): 500 regions (I7), 2,000 form fields (I15) and a canonical
 * form just under 16 MiB (I7).
 *
 * The document is synthetic: every identifier is unique, so that the indexes are not given the
 * repeated identifiers the model-costs script uses. Its body holds 500 regions of four form fields
 * each, half restricted and half inherit, and filler paragraphs spread over the regions and the
 * body until the canonical form (RFC 8785, `canonicalText`) is between 98 % and 100 % of 16 MiB.
 *
 * Measured, for a typical commit (a word typed into one paragraph, by an owner), with a warm-up
 * and then `RUNS` timed runs of each, wall time and CPU time (`process.cpuUsage`, which ticks at
 * about 15.6 ms on Windows, so the CPU figures of a short step are mostly 0 or one tick; read the
 * wall times):
 *
 * - `check`: `outcomeCheck`, which includes `diffScopes` (07 §5.1), as the room calls it at step 7;
 * - `indexNext`: `PermissionIndex.next`, the update of the three indexes by mapping through the
 *   commit's steps (07 §5.4);
 * - `definitionUse`: the definitions in use per region after the commit, which the room asks for
 *   only when a definition changed; shown for the cost of that case;
 * - `fullRebuild`: `PermissionIndex.build` of the whole document, which is what opening a room costs.
 *
 * One commit types into a paragraph inside a restricted region (so a region scope is judged), the
 * other into a body paragraph outside every region.
 *
 * The room's whole step (rebase, apply, invariants, outcome check, index update, storage) is not
 * timed here: only the two parts PRM-016 names. Result: test-results/permissions/<run>.json. No
 * target is applied: 07 gives no budget for the outcome check (PRM-016 Notes).
 *
 * `@docedit/authority` is imported by its relative path, since `@docedit/perf` has no dependency on
 * it; see the story's Notes.
 *
 * Usage: node scripts/permission-costs.ts   (from packages/perf)
 */
import { corpusStamp } from '@docedit/corpus';
import { canonicalText, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem, type as osType } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIMITS,
  PermissionIndex,
  applySteps,
  computeAccess,
  mapsOf,
  outcomeCheck,
  parseSteps,
  type PermissionState,
} from '../../authority/src/index.ts';
import { summarise } from '../src/stats.ts';

const here = fileURLToPath(import.meta.url);
const pkg = resolve(dirname(here), '..');
const MIB = 1024 * 1024;
const LIMIT = 16 * MIB;
const REGIONS = 500;
const FIELDS = 2000;
const RUNS = 100;
const WARM = 5;

const encoder = new TextEncoder();
const schema = cdmSchema();
type Node = ReturnType<typeof schema.nodeFromJSON>;

const sentence =
  'The parties agree that the amounts due under this clause are payable in arrears, ' +
  'and that no set-off applies unless the other party agrees in writing before the date. ';

const pid = (n: number): string => `p${String(n).padStart(15, '0')}`;
const rid = (n: number): string => `r${String(n).padStart(15, '0')}`;
const fid = (n: number): string => `f${String(n).padStart(15, '0')}`;

const paragraph = (n: number, chars: number): JsonNode => ({
  type: 'paragraph',
  attrs: { id: pid(n) },
  content: [
    { type: 'text', text: sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars) },
  ],
});

/** The document with `perBlock` filler paragraphs of `chars` characters per region and for the body. */
function build(perBlock: number, chars: number): JsonEnvelope {
  let n = 0;
  let f = 0;
  const body: JsonNode[] = [];
  for (let i = 0; i < perBlock; i++) body.push(paragraph(++n, chars));
  for (let r = 0; r < REGIONS; r++) {
    const content: JsonNode[] = [];
    const first = paragraph(++n, chars);
    const fields: JsonNode[] = [];
    for (let k = 0; k < FIELDS / REGIONS; k++) {
      f += 1;
      fields.push(
        {
          type: 'form_field',
          attrs: {
            id: fid(f),
            key: `field_${f}`,
            kind: 'text',
            label: `Field ${f}`,
            assignee: 'role_tenant',
          },
        },
        { type: 'text', text: ' ' },
      );
    }
    first.content = [...(first.content ?? []), { type: 'text', text: ' ' }, ...fields.slice(0, -1)];
    content.push(first);
    for (let i = 1; i < perBlock; i++) content.push(paragraph(++n, chars));
    body.push({
      type: 'region',
      attrs: { id: rid(r + 1), title: `Region ${r + 1}`, policy: r % 2 ? 'restricted' : 'inherit' },
      content,
    });
  }
  return {
    cdm: 1,
    requires: ['fields'],
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
            { type: 'role_def', attrs: { id: 'role_tenant', name: 'Tenant', color: '#1F77B4' } },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  } as unknown as JsonEnvelope;
}

/** Grows the filler until the canonical form is between 98 % and 100 % of 16 MiB. */
function atTheLimits(): { env: JsonEnvelope; bytes: number; perBlock: number; chars: number } {
  const chars = 400;
  let perBlock = 40;
  for (let attempt = 0; attempt < 12; attempt++) {
    const env = build(perBlock, chars);
    const bytes = encoder.encode(canonicalText(env)).length;
    if (bytes <= LIMIT && bytes >= LIMIT * 0.98) return { env, bytes, perBlock, chars };
    perBlock = Math.max(2, Math.round((perBlock * (LIMIT * 0.99)) / bytes));
  }
  throw new Error('could not reach 98 % of 16 MiB');
}

function findParagraph(doc: Node, inRegion: boolean, region: number): { pos: number; id: string } {
  let found: { pos: number; id: string } | null = null;
  doc.descendants((node, pos, parent) => {
    if (found) return false;
    if (node.type.name === 'region') {
      if (!inRegion || node.attrs['id'] !== rid(region)) return false;
      return true;
    }
    if (node.type.name === 'paragraph' && (parent?.type.name === 'region') === inRegion) {
      found = { pos, id: String(node.attrs['id']) };
      return false;
    }
    return true;
  });
  if (!found) throw new Error('no paragraph found');
  return found;
}

function typeWord(
  doc: Node,
  at: { pos: number },
): ReturnType<typeof applySteps> & { steps: unknown } {
  const json = [
    {
      stepType: 'replace',
      from: at.pos + 1,
      to: at.pos + 1,
      slice: { content: [{ type: 'text', text: 'typed ' }] },
    },
  ];
  const parsed = parseSteps(schema, json, DEFAULT_LIMITS);
  if (!parsed.ok) throw new Error(parsed.reason);
  const applied = applySteps(doc, parsed.value);
  return Object.assign(applied, { steps: parsed.value });
}

const permissions: PermissionState = {
  revision: 1,
  grants: [],
  regionStates: new Map(),
  leases: [],
  documentState: 'active',
  workflowActive: false,
};

const owner = {
  sub: 'alice',
  session: 's-alice',
  role: 'owner',
  groups: [],
  participantRoles: [],
  participantActive: false,
} as const;

interface Timed {
  wallMs: ReturnType<typeof summarise>;
  cpuMs: ReturnType<typeof summarise>;
}

function time(run: () => unknown, runs = RUNS, warm = WARM): Timed {
  for (let i = 0; i < warm; i++) run();
  const wall: number[] = [];
  const cpu: number[] = [];
  for (let i = 0; i < runs; i++) {
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    run();
    wall.push(performance.now() - t0);
    const c = process.cpuUsage(c0);
    cpu.push((c.user + c.system) / 1000);
  }
  return { wallMs: summarise(wall), cpuMs: summarise(cpu) };
}

const built = atTheLimits();
const t0 = performance.now();
const doc = schema.nodeFromJSON(built.env.doc);
const parseMs = performance.now() - t0;

const index = PermissionIndex.build(doc);
const regionCount = index.regionList().length;
let fieldCount = 0;
doc.descendants((n) => {
  if (n.type.name === 'form_field') fieldCount += 1;
  return true;
});
if (regionCount !== REGIONS || fieldCount !== FIELDS)
  throw new Error(`built ${regionCount} regions and ${fieldCount} fields`);

const access = computeAccess(owner, index.regionList(), permissions, 0);
const commits: Array<{ name: string; where: Record<string, unknown>; result: unknown }> = [];

for (const [name, inRegion] of [
  ['typed into a restricted region', true],
  ['typed into the body outside every region', false],
] as const) {
  const at = findParagraph(doc, inRegion, inRegion ? 250 : 0);
  const applied = typeWord(doc, at);
  if (!applied.ok) throw new Error(applied.reason);
  const after = applied.value.doc;
  const maps = mapsOf(applied.steps as never);
  const input = {
    before: doc,
    after,
    user: owner.sub,
    access,
    perms: permissions,
    suggestionOwners: new Map(),
    fieldsChangedSinceBase: new Set<string>(),
    serverAuthored: false,
    origin: 'input',
  };
  const verdict = outcomeCheck(input);
  if (!verdict.ok) throw new Error(`the commit was refused: ${verdict.reason}`);
  commits.push({
    name,
    where: { paragraph: at.id, scopes: verdict.scopes },
    result: {
      check: time(() => outcomeCheck(input)),
      indexNext: time(() => index.next(doc, after, maps, verdict.diff)),
      definitionUse: time(() => index.definitionUse(after)),
    },
  });
}

const fullRebuild = time(() => PermissionIndex.build(doc), 10, 2);

const id = new Date()
  .toISOString()
  .replace(/\.\d+Z$/, 'Z')
  .replace(/:/g, '-');
const report = {
  schema: 'docedit-perf-permissions/1',
  runId: id,
  machine: {
    cpu: cpus()[0]?.model.trim(),
    logicalProcessors: cpus().length,
    memoryBytes: totalmem(),
    os: `${osType()} ${release()}`,
    node: process.version,
  },
  corpus: corpusStamp(),
  document: {
    regions: regionCount,
    formFields: fieldCount,
    canonicalBytes: built.bytes,
    canonicalMiB: built.bytes / MIB,
    paragraphsPerBlock: built.perBlock,
    charactersPerParagraph: built.chars,
    nodeCount: (() => {
      let n = 0;
      doc.descendants(() => {
        n += 1;
        return true;
      });
      return n;
    })(),
    parseMs,
  },
  runs: RUNS,
  warmUps: WARM,
  cpuClockNote: 'process.cpuUsage ticks at about 15.6 ms on Windows; read the wall times',
  commits,
  fullRebuild,
};
mkdirSync(join(pkg, 'test-results/permissions'), { recursive: true });
writeFileSync(
  join(pkg, `test-results/permissions/${id}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
);
const row = (label: string, t: Timed): string =>
  `${label.padEnd(52)} median ${t.wallMs.median.toFixed(2)} ms, p95 ${t.wallMs.p95.toFixed(2)} ms, max ${t.wallMs.max.toFixed(2)} ms (n=${t.wallMs.n})`;
console.log(
  `${regionCount} regions, ${fieldCount} fields, ${(built.bytes / MIB).toFixed(2)} MiB canonical, ${report.document.nodeCount} nodes`,
);
for (const c of commits) {
  const r = c.result as { check: Timed; indexNext: Timed; definitionUse: Timed };
  console.log(c.name);
  console.log(row('  outcome check', r.check));
  console.log(row('  index update (next)', r.indexNext));
  console.log(row('  definition use (after a definition changes)', r.definitionUse));
}
console.log(row('full index build (a room opening the document)', fullRebuild));
