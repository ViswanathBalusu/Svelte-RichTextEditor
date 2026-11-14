// Fuzzing the authority (SPK-016; PRM-017 fuzz target; SYN-049). Arbitrary envelopes, structured
// hostile step JSON, and valid steps of every type with random mutations go to validation, rebase,
// apply and the invariant check, and through the room. Nothing may throw or stall, every refusal
// carries a code of DEP's registry, whatever the room accepts must leave a valid document, and
// adversarial structures (deep nesting, very large slices, long attribute strings) must respect
// the structural limits. Each run reports the inputs that cost the most per unit of the admission
// estimate (SYN-037), so that the estimate can be corrected.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateDoc } from '@docedit/model/validate';
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { type Step, Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, type RejectCode } from '../src/codes.ts';
import { checkInvariants } from '../src/invariants.ts';
import { applySteps, mapsOf, rebaseOver } from '../src/rebase.ts';
import { Room } from '../src/room/room.ts';
import type { ToClient } from '../src/room/types.ts';
import { ALLOWED_STEP_TYPES, commitBytes, parseSteps } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, posOf, schema } from './fixtures.ts';
import { storeIfSlow } from './slow-input.ts';

const TIME_BOX_MS = Number(process.env['FUZZ_MS'] ?? 10_000);
/**
 * The bound on one input, as a stall detector: no spec target exists for it (04 §12 targets well
 * under a millisecond for a typical commit). FUZZ_INPUT_MS overrides it.
 */
const INPUT_LIMIT_MS = Number(process.env['FUZZ_INPUT_MS'] ?? 2_000);
/** Where an over-limit input is stored (SEC-028 criterion 5); created on demand. */
const SLOW_DIR = fileURLToPath(new URL('./slow-inputs', import.meta.url));

/** Codes DEP's registry allows on `sync.reject` (spec/dep/dep-1.registry.json, surface `sync`). */
const SYNC_CODES: ReadonlySet<string> = new Set(
  (
    JSON.parse(
      readFileSync(new URL('../../../spec/dep/dep-1.registry.json', import.meta.url), 'utf8'),
    ) as { errors: Array<{ code: string; surfaces: string[] }> }
  ).errors
    .filter((e) => e.surfaces.includes('sync'))
    .map((e) => e.code),
);

/**
 * Crashes the fuzzer found, minimised, replayed first on every run (SYN-049 criterion 3). Each is
 * a commit as JSON and the user who submits it on a fresh room.
 */
const REGRESSIONS: Array<{ user: keyof typeof USERS; commit: unknown; note: string }> = [
  {
    user: 'mallory',
    // Spike S3: a mark step mapped past the end of the document threw inside AddMarkStep.apply.
    commit: { base: 0, steps: [{ stepType: 'addMark', from: 1, to: 1e9, mark: { type: 'bold' } }] },
    note: 'a mark step past the end of the document',
  },
  {
    user: 'alice',
    // Spike S12: a crafted step mapped outside the document made ProseMirror throw.
    commit: { base: 0, steps: [{ stepType: 'replace', from: 9_999, to: 10_001 }] },
    note: 'a replace step outside the document',
  },
];

let counter = 0;
const uuid = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

const pos = fc.oneof(
  fc.integer({ min: -5, max: 400 }),
  fc.constantFrom(0, 1, 2, 1e9, -1, 3.5, Number.NaN),
);
const markJson = fc.oneof(
  fc.record({
    type: fc.constantFrom('bold', 'italic', 'link', 'ins', 'del', 'fmt', 'comment', 'preserved'),
    attrs: fc.option(
      fc.dictionary(
        fc.constantFrom('value', 'href', 'id', 'user', 'before', 'props'),
        fc.jsonValue(),
      ),
      { nil: undefined },
    ),
  }),
  fc.jsonValue(),
);
const nodeJson: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  node: fc.oneof(
    {
      weight: 3,
      arbitrary: fc.record({
        type: fc.constant('text'),
        text: fc.string({ maxLength: 5 }),
        marks: fc.option(fc.array(markJson, { maxLength: 2 }), { nil: undefined }),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        type: fc.constantFrom(
          'paragraph',
          'region',
          'table',
          'table_row',
          'table_cell',
          'form_field',
          'footnote',
          'section_break',
          'image',
          'defs',
          'body',
          'story',
          'hidden_region',
          'nope',
        ),
        attrs: fc.option(
          fc.dictionary(
            fc.constantFrom(
              'id',
              'policy',
              'style',
              'value',
              'kind',
              'asset',
              'ext',
              'grid',
              'title',
            ),
            fc.jsonValue(),
          ),
          { nil: undefined },
        ),
        content: fc.option(fc.array(tie('node'), { maxLength: 3 }), { nil: undefined }),
      }),
    },
    { weight: 1, arbitrary: fc.jsonValue() },
  ),
})).node;
const sliceJson = fc.option(
  fc.record({
    content: fc.option(fc.array(nodeJson, { maxLength: 3 }), { nil: undefined }),
    openStart: fc.option(fc.integer({ min: -1, max: 4 }), { nil: undefined }),
    openEnd: fc.option(fc.integer({ min: -1, max: 4 }), { nil: undefined }),
  }),
  { nil: undefined },
);
const stepJson = fc.oneof(
  fc.record({
    stepType: fc.constant('replace'),
    from: pos,
    to: pos,
    slice: sliceJson,
    structure: fc.option(fc.boolean(), { nil: undefined }),
  }),
  fc.record({
    stepType: fc.constant('replaceAround'),
    from: pos,
    to: pos,
    gapFrom: pos,
    gapTo: pos,
    insert: pos,
    slice: sliceJson,
    structure: fc.option(fc.boolean(), { nil: undefined }),
  }),
  fc.record({
    stepType: fc.constantFrom('addMark', 'removeMark'),
    from: pos,
    to: pos,
    mark: markJson,
  }),
  fc.record({ stepType: fc.constantFrom('addNodeMark', 'removeNodeMark'), pos, mark: markJson }),
  fc.record({
    stepType: fc.constant('attr'),
    pos,
    attr: fc.constantFrom('id', 'policy', 'style', 'value', 'title', 'ext', 'nope'),
    value: fc.jsonValue(),
  }),
  fc.record({
    stepType: fc.constantFrom('docAttr', 'bogus', ''),
    attr: fc.string(),
    value: fc.jsonValue(),
  }),
  fc.jsonValue(),
);

/** Valid steps of every allowed type, made by real edits on the base document. */
function validSteps(doc: Node): Array<Record<string, unknown>> {
  const out: Step[] = [];
  const intro = posInside(doc, 'pIntro0000000001');
  const p = posOf(doc, 'pIntro0000000001');
  const region = posOf(doc, 'rNotes000000000C');
  const bold = schema.marks['bold']!.create();
  const del = schema.marks['del']!.create({ id: 'sSuggestion00001', user: 'alice' });
  const tr = new Transform(doc);
  tr.insert(intro, schema.text('hello'));
  tr.addMark(intro, intro + 5, bold);
  tr.removeMark(intro, intro + 2, bold);
  tr.addNodeMark(p, del);
  tr.removeNodeMark(p, del);
  tr.setNodeAttribute(p, 'style', 'Heading1');
  tr.setNodeMarkup(p, null, { ...tr.doc.nodeAt(p)!.attrs, style: 'Normal' });
  tr.delete(intro, intro + 3);
  tr.split(tr.mapping.map(intro + 2));
  out.push(...tr.steps);
  const wrap = new Transform(doc);
  const $p = wrap.doc.resolve(intro);
  wrap.wrap($p.blockRange()!, [
    { type: schema.nodes['region']!, attrs: { id: 'rWrapped0000000W' } },
  ]);
  out.push(...wrap.steps);
  const lift = new Transform(doc);
  const $r = lift.doc.resolve(region + 2);
  const range = $r.blockRange();
  if (range) lift.lift(range, 1);
  out.push(...lift.steps);
  return out.map((s) => s.toJSON() as Record<string, unknown>);
}

/** A random mutation of one step's JSON: positions, types, marks, slices and attributes. */
function mutate(step: Record<string, unknown>, r: () => number): Record<string, unknown> {
  const s = structuredClone(step);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const k = Math.floor(r() * 8);
  if (k === 0) {
    for (const f of ['from', 'to', 'gapFrom', 'gapTo', 'pos', 'insert'])
      if (typeof s[f] === 'number') s[f] = (s[f] as number) + Math.floor(r() * 21) - 10;
  } else if (k === 1) s['stepType'] = pick(ALLOWED_STEP_TYPES);
  else if (k === 2)
    s['mark'] = { type: pick(['bold', 'link', 'ins', 'fmt', 'nope']), attrs: { id: 'x', user: 7 } };
  else if (k === 3 && s['slice'])
    (s['slice'] as Record<string, unknown>)['openStart'] = Math.floor(r() * 6);
  else if (k === 4 && s['slice'])
    (s['slice'] as Record<string, unknown>)['content'] = [
      {
        type: pick(['region', 'table', 'paragraph', 'hidden_region']),
        attrs: { id: 'pMutated00000001' },
      },
    ];
  else if (k === 5) s['attr'] = pick(['id', 'policy', 'value', 'sensitive', 'nope']);
  else if (k === 6) s['value'] = pick([null, 'x'.repeat(5000), { redacted: true }, 42, ['a']]);
  else {
    // Drop one member.
    const drop = pick(Object.keys(s));
    return Object.fromEntries(Object.entries(s).filter(([key]) => key !== drop));
  }
  return s;
}

function newRoom(now: () => number = () => Date.now()): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now,
  });
}

interface Probe {
  ms: number;
  units: number;
  what: string;
}

describe('authority fuzzing (SYN-049)', () => {
  it('never throws or stalls, refuses only with registry codes, and accepts only valid documents', () => {
    const r = newRoom();
    const users = [USERS.alice, USERS.carol, USERS.dave, USERS.erin, USERS.mallory];
    users.forEach((u, i) => r.open(`ch${i}`, u));
    const valid = validSteps(baseDoc());
    let seed = 1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    };
    const probes: Probe[] = [];
    const codes = new Map<string, number>();
    const types = new Set<string>();
    let runs = 0;
    let accepted = 0;
    let slowest = 0;
    const submit = (who: number, input: unknown, what: string) => {
      runs++;
      const channel = `ch${who}`;
      const steps =
        input && typeof input === 'object' && Array.isArray((input as { steps?: unknown }).steps)
          ? (input as { steps: unknown[] }).steps
          : [];
      for (const s of steps) {
        const t = (s as { stepType?: unknown } | null)?.stepType;
        if (typeof t === 'string') types.add(t);
      }
      const base = (input as { base?: unknown } | null)?.base;
      const units = r.estimateCost({
        steps: steps.length,
        base: typeof base === 'number' ? base : 0,
        bytes: commitBytes(input),
      });
      const t0 = performance.now();
      let fx;
      try {
        fx = r.submit(channel, input as never);
      } catch (e) {
        throw new Error(
          `room.submit threw on ${JSON.stringify(input)?.slice(0, 500)}: ${(e as Error).stack}`,
          { cause: e },
        );
      }
      const ms = performance.now() - t0;
      slowest = Math.max(slowest, ms);
      // SEC-028 criterion 5: an input over the limit fails the build and is stored for replay.
      storeIfSlow('authority-fuzz', input, ms, { limitMs: INPUT_LIMIT_MS, storeDir: SLOW_DIR });
      probes.push({ ms, units, what });
      const answered =
        fx.send.some((o) => o.channel === channel) || fx.write !== null || r.pendingCount > 0;
      expect(answered, `no answer to ${JSON.stringify(input)?.slice(0, 300)}`).toBe(true);
      for (const o of fx.send) {
        const m = o.msg as ToClient;
        if (m.t !== 'sync.reject') continue;
        codes.set(m.code, (codes.get(m.code) ?? 0) + 1);
        expect(SYNC_CODES.has(m.code), `code ${m.code} is not in DEP's registry`).toBe(true);
      }
      if (fx.write) {
        const done = r.writeCompleted({ status: 'ok' });
        accepted += done.send.filter((o) => o.msg.t === 'sync.ack').length;
        const v = validateDoc(r.document, REQUIRES, { retiredRegionIds: new Set() });
        expect(v.violations, 'an accepted commit left an invalid document').toEqual([]);
      }
    };
    for (const reg of REGRESSIONS) {
      const fresh = newRoom();
      fresh.open('x', USERS[reg.user]);
      expect(
        () => fresh.submit('x', { id: uuid(), ...(reg.commit as object) } as never),
        reg.note,
      ).not.toThrow();
    }
    const started = Date.now();
    const commit = fc.oneof(
      {
        weight: 6,
        arbitrary: fc.record({
          id: fc.constant(null),
          base: fc.integer({ min: -2, max: 6 }),
          steps: fc.array(stepJson, { minLength: 0, maxLength: 4 }),
          origin: fc.option(fc.constantFrom('input', 'paste', 'restore', 'sign', 'x'), {
            nil: undefined,
          }),
        }),
      },
      { weight: 1, arbitrary: fc.anything() },
    );
    while (Date.now() - started < TIME_BOX_MS) {
      const batch = fc.sample(fc.tuple(fc.nat(users.length - 1), commit), {
        numRuns: 100,
        seed: runs,
      });
      for (const [who, raw] of batch) {
        const input =
          raw && typeof raw === 'object' && 'id' in raw && (raw as { id: unknown }).id === null
            ? { ...(raw as object), id: uuid() }
            : raw;
        submit(who, input, 'hostile');
      }
      // Valid steps of every type, mutated, on the room's current head.
      for (let i = 0; i < 100; i++) {
        const n = 1 + Math.floor(rand() * 3);
        const steps = Array.from({ length: n }, () => {
          const s = valid[Math.floor(rand() * valid.length)]!;
          return rand() < 0.3 ? s : mutate(s, rand);
        });
        const base = rand() < 0.8 ? r.head : Math.max(0, r.head - Math.floor(rand() * 5));
        submit(Math.floor(rand() * users.length), { id: uuid(), base, steps }, 'mutated');
      }
    }
    // The CPU each input cost per unit of the estimate; the outliers are where the estimate is
    // furthest off (SYN-037; SYN-038 calibrates it).
    const perUnit = probes
      .filter((p) => p.units > 0)
      .map((p) => ({ ...p, perUnit: p.ms / p.units }))
      .sort((a, b) => b.perUnit - a.perUnit);
    const median = perUnit[Math.floor(perUnit.length / 2)]?.perUnit ?? 0;
    console.log(
      `fuzz: ${runs} submissions in ${TIME_BOX_MS} ms; ${accepted} accepted; slowest ${slowest.toFixed(2)} ms; step types ${[...types].filter((t) => ALLOWED_STEP_TYPES.includes(t)).length} of 7; codes ${JSON.stringify(Object.fromEntries(codes))}; median ${(median * 1000).toFixed(1)} µs per estimated unit; outliers ${JSON.stringify(perUnit.slice(0, 5).map((p) => ({ ms: +p.ms.toFixed(3), units: p.units, what: p.what })))}`,
    );
    expect(runs).toBeGreaterThan(1000);
    expect(accepted).toBeGreaterThan(10);
    for (const t of ALLOWED_STEP_TYPES) expect(types.has(t), t).toBe(true);
  });

  it('keeps the pure functions total on mutated steps: parse, rebase, apply and the invariant check', () => {
    const doc = baseDoc();
    const valid = validSteps(doc);
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    };
    const over = mapsOf(
      new Transform(doc).insert(posInside(doc, 'pTitle0000000001'), schema.text('abc')).steps,
    );
    const moved = new Transform(doc).insert(
      posInside(doc, 'pTitle0000000001'),
      schema.text('abc'),
    ).doc;
    let refused = 0;
    let parsed = 0;
    for (let i = 0; i < 3000; i++) {
      const json = Array.from({ length: 1 + Math.floor(rand() * 3) }, () =>
        mutate(valid[Math.floor(rand() * valid.length)]!, rand),
      );
      const check = <T>(f: () => T): T => {
        let out!: T;
        expect(() => (out = f()), JSON.stringify(json).slice(0, 300)).not.toThrow();
        return out;
      };
      const p = check(() => parseSteps(schema, json, DEFAULT_LIMITS));
      if (!p.ok) {
        expect(SYNC_CODES.has(p.code)).toBe(true);
        refused++;
        continue;
      }
      parsed++;
      for (const mode of ['reject', 'drop'] as const) {
        const rb = check(() => rebaseOver(p.value, over, moved, mode));
        if (!rb.ok) expect(rb.code).toBe('rebase_failed');
      }
      const a = check(() => applySteps(doc, p.value));
      if (!a.ok) {
        expect(a.code as RejectCode).toBe('invalid_op');
        continue;
      }
      const inv = check(() =>
        checkInvariants(doc, a.value.doc, p.value, a.value.docs, {
          requires: REQUIRES,
          retiredRegionIds: new Set(),
        }),
      );
      if (!inv.ok) expect(['invalid_op', 'field_invalid']).toContain(inv.code);
    }
    expect(parsed).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(10);
  });

  it('holds the structural limits against deep nesting, very large slices and long attribute strings', () => {
    const r = newRoom();
    r.open('a1', USERS.alice);
    const end = () => posOf(r.document, 'pEnd00000000001Z');
    const submitSlice = (nodes: unknown[]): { code: string | null; ms: number } => {
      const at = end();
      const step = { stepType: 'replace', from: at, to: at, slice: { content: nodes } };
      const t0 = performance.now();
      const fx = r.submit('a1', { id: uuid(), base: r.head, steps: [step] });
      const ms = performance.now() - t0;
      if (fx.write) r.writeCompleted({ status: 'ok' });
      const rej = fx.send.find((o) => o.msg.t === 'sync.reject')?.msg;
      return { code: rej?.t === 'sync.reject' ? rej.code : null, ms };
    };
    // Tables nested in cells, to and beyond the depth limit.
    let ids = 0;
    const nid = (p: string) => `${p}${String(++ids).padStart(15, '0')}`.slice(0, 16);
    const nested = (depth: number): unknown => {
      let inner: unknown = {
        type: 'paragraph',
        attrs: { id: nid('p') },
        content: [{ type: 'text', text: 'deep' }],
      };
      for (let d = 0; d < depth; d++)
        inner = {
          type: 'table',
          attrs: { id: nid('t'), grid: [1000] },
          content: [
            {
              type: 'table_row',
              attrs: { id: nid('w') },
              content: [{ type: 'table_cell', attrs: { id: nid('c') }, content: [inner] }],
            },
          ],
        };
      return inner;
    };
    // CDM 1 lets no table into a cell, so the deepest legal path is a region holding a table
    // (doc, body, region, table, row, cell, paragraph, text) and the schema keeps nesting below
    // I7's limit of 12; nested tables are refused when the step applies, at once.
    const results: Record<string, string | null> = {};
    results['a table in a region'] = submitSlice([
      { type: 'region', attrs: { id: nid('r') }, content: [nested(1)] },
    ]).code;
    expect(results['a table in a region']).toBeNull();
    for (const depth of [2, 6, 12, 13, 40]) {
      const { code, ms } = submitSlice([nested(depth)]);
      results[`tables ${depth} deep`] = code;
      expect(ms, `${depth} deep`).toBeLessThan(INPUT_LIMIT_MS);
      expect(code, `${depth} deep`).toBe('invalid_op');
    }
    // A slice close to the commit limit, and one over it.
    const big = (chars: number) => [
      {
        type: 'paragraph',
        attrs: { id: nid('p') },
        content: [{ type: 'text', text: 'x'.repeat(chars) }],
      },
    ];
    const near = submitSlice(big(900_000));
    expect(near.ms).toBeLessThan(INPUT_LIMIT_MS);
    expect(submitSlice(big(1_100_000)).code).toBe('too_large');
    // Attribute strings at and beyond their grammar limits: a region title of 255 characters, of
    // 256, and a link far longer than any href.
    const region = (title: string) => ({
      type: 'region',
      attrs: { id: nid('r'), title },
      content: [{ type: 'paragraph', attrs: { id: nid('p') } }],
    });
    expect(submitSlice([region('t'.repeat(255))]).code).toBeNull();
    expect(submitSlice([region('t'.repeat(256))]).code).toBe('invalid_op');
    const link = {
      type: 'paragraph',
      attrs: { id: nid('p') },
      content: [
        {
          type: 'text',
          text: 'link',
          marks: [{ type: 'link', attrs: { href: `https://example.org/${'a'.repeat(200_000)}` } }],
        },
      ],
    };
    const l = submitSlice([link]);
    expect(l.ms).toBeLessThan(INPUT_LIMIT_MS);
    expect(l.code === null || SYNC_CODES.has(l.code)).toBe(true);
    // Whatever was accepted is valid, the limits of I7 included.
    expect(validateDoc(r.document, REQUIRES, { retiredRegionIds: new Set() }).violations).toEqual(
      [],
    );
    console.log(
      `adversarial structures: ${JSON.stringify(results)}; title 255 accepted, 256 refused`,
    );
  });
});
