/**
 * The `fuzz` profile (PRO-116; 05 §11; 10 §5): random and mutated frames against the envelope
 * parser, random and mutated steps against step validation, and the `maxMessageBytes` boundary.
 * Every fuzzer runs for a time budget (`--fuzz-ms`; the target for a full run is one hour) from a
 * recorded seed; the first crash, stall, undefined close code or invalid document fails the run and
 * the report keeps the input and the seed that produced it.
 */
import { DEP1, utf8Length } from '@docedit/protocol';
import { uuid7 } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import fc from 'fast-check';
import { KitFailure, check, equal, show } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import { nodeSize, type JsonNode } from '../documents.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import type { Wire } from '../wire.ts';
import { CLOSE_CODES } from './core-session.ts';
import { join, readContent, submit } from './support.ts';

const f = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('fuzz', def);

const SYNC_CODES = new Set(
  DEP1.errors.filter((e) => e.surfaces.includes('sync')).map((e) => e.code),
);
const ALL_CODES = new Set(DEP1.errors.map((e) => e.code));

/** Valid client messages for a session with channel 1 open on `doc`: the seeds of the mutations. */
function templates(doc: string): Record<string, unknown>[] {
  return [
    { t: 'ping', id: 'p' },
    { t: 'pong' },
    { t: 'ch.close', ch: 9 },
    {
      t: 'ch.open',
      id: 'o',
      ch: 7,
      d: { kind: 'doc', doc, engine: 'pm-steps/1', cdm: 1, features: [] },
    },
    {
      t: 'sync.submit',
      id: 's',
      ch: 1,
      d: { id: uuid7(), base: 0, steps: [{ stepType: 'replace', from: 1, to: 1 }] },
    },
    {
      t: 'presence.update',
      ch: 1,
      d: { seq: 0, state: { selection: { anchor: 1, head: 1 }, scope: 'body', status: 'idle' } },
    },
    { t: 'auth.refresh', id: 'a', d: { token: 'x' } },
    { t: 'chunk', d: { of: uuid7(), i: 0, n: 2, part: '{"t":' } },
    {
      t: 'hello',
      id: 'h',
      d: {
        versions: ['1.0'],
        token: 'x',
        client: { name: 'tck', version: '0' },
        engines: ['pm-steps/1'],
        cdm: { min: 1, max: 1 },
        features: [],
      },
    },
    // Server-to-client types sent the wrong way (D03: bad_message, not fatal).
    { t: 'welcome', re: 'x', d: {} },
    {
      t: 'sync.ack',
      re: 'x',
      ch: 1,
      d: { id: 'x', seq: 1, serverTime: '2026-01-01T00:00:00.000Z', rebased: false },
    },
    { t: 'error', d: { code: 'internal', message: 'x', retryable: true, fatal: false } },
  ];
}

const jsonValue = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.double(),
  fc.string({ maxLength: 12 }),
  fc.constant(Number.MAX_SAFE_INTEGER + 2),
  fc.constant(-1),
  fc.array(fc.integer(), { maxLength: 3 }),
  fc.dictionary(fc.string({ maxLength: 4 }), fc.integer(), { maxKeys: 3 }),
);

type Mutation = {
  kind: 'drop' | 'set' | 'type' | 'extra' | 'wrap' | 'truncate' | 'nest';
  path: number;
  value: unknown;
  text: string;
  cut: number;
};

const mutation: fc.Arbitrary<Mutation> = fc.record({
  kind: fc.constantFrom('drop', 'set', 'type', 'extra', 'wrap', 'truncate', 'nest'),
  path: fc.nat(20),
  value: jsonValue,
  text: fc.string({ maxLength: 16 }),
  cut: fc.nat(200),
});

/** Applies a mutation to a message, giving the text of one frame. */
function mutate(msg: Record<string, unknown>, m: Mutation): string {
  const copy = JSON.parse(JSON.stringify(msg)) as Record<string, unknown>;
  const holders: Array<Record<string, unknown>> = [copy];
  if (copy['d'] && typeof copy['d'] === 'object')
    holders.push(copy['d'] as Record<string, unknown>);
  const target = holders[m.path % holders.length]!;
  const keys = Object.keys(target);
  const key = keys.length ? keys[m.path % keys.length]! : 'x';
  switch (m.kind) {
    case 'drop':
      for (const k of Object.keys(target)) if (k === key) Reflect.deleteProperty(target, k);
      return JSON.stringify(copy);
    case 'set':
      target[key] = m.value;
      return JSON.stringify(copy);
    case 'type':
      copy['t'] = m.text;
      return JSON.stringify(copy);
    case 'extra':
      target[`x${m.text}`] = m.value;
      return JSON.stringify(copy);
    case 'wrap':
      return JSON.stringify([copy]);
    case 'truncate': {
      const s = JSON.stringify(copy);
      return s.slice(0, m.cut % Math.max(1, s.length));
    }
    case 'nest': {
      let v: unknown = copy;
      for (let i = 0; i < 40 + m.cut; i++) v = { d: v };
      return JSON.stringify(v);
    }
  }
}

/** Frames that have broken parsers before: deep nesting, lone surrogates, a BOM, odd numbers. */
const EDGES = [
  '',
  ' ',
  'null',
  '"t"',
  '{}',
  '﻿{"t":"ping"}',
  '{"t":"ping","t":"pong"}',
  '{"t":"\uD800"}',
  `{"t":"ping","d":${'['.repeat(5000)}${']'.repeat(5000)}}`,
  `{"t":"ping","d":${'{"a":'.repeat(3000)}1${'}'.repeat(3000)}}`,
  '{"t":"sync.submit","id":"z","ch":1e400,"d":{}}',
  '{"t":"sync.submit","id":"z","ch":1.5,"d":{}}',
  '{"t":"__proto__","id":"z","__proto__":{"polluted":1}}',
  '{"t":"constructor","id":"c","d":{"constructor":{"prototype":{"x":1}}}}',
];

function frames(doc: string): fc.Arbitrary<string> {
  const t = templates(doc);
  return fc.oneof(
    { weight: 2, arbitrary: fc.string({ maxLength: 120 }) },
    { weight: 2, arbitrary: fc.json({ maxDepth: 3 }) },
    {
      weight: 5,
      arbitrary: fc.tuple(fc.constantFrom(...t), mutation).map(([msg, m]) => mutate(msg, m)),
    },
    { weight: 1, arbitrary: fc.constantFrom(...EDGES) },
  );
}

interface Session {
  wire: Wire;
  doc: string;
}

async function openSession(ctx: ScenarioContext, doc: string): Promise<Session> {
  const m = await join(ctx, 'fuzz', doc, 'editor');
  return { wire: m.wire, doc };
}

/** Probes the connection after a frame: a pong proves the server handled the frame and goes on. */
async function probe(ctx: ScenarioContext, s: Session, n: number): Promise<'alive' | 'closed'> {
  if (!s.wire.open) return 'closed';
  const id = `probe-${n}`;
  s.wire.send({ t: 'ping', id });
  const answered = await s.wire.arrives(
    (m) => m.t === 'pong' && (m.re === id || m.re === undefined),
    ctx.timeoutMs,
    0,
  );
  if (answered) return 'alive';
  if (s.wire.closed) return 'closed';
  throw new KitFailure(
    'the server stalled: no answer and no close after a fuzzed frame (05 §11)',
    'pong, an error or a defined close',
    `no reply within ${ctx.timeoutMs} ms`,
  );
}

export const FUZZ: ProfileDef = {
  id: 'fuzz',
  title: 'Fuzzing of the envelope parser and of step validation',
  spec: '05 §4, §5.7, §11; 10 §5',
  stories: ['PRO-116'],
  requires: { kind: 'mode', mode: 'authority' },
  scenarios: [
    f({
      id: 'envelope',
      title:
        'random and mutated frames are answered, ignored or closed with a defined code; the server stays up',
      spec: '05 §1 rule 3, §4, §5.7; D03',
      budget: 'fuzz',
      covers: { messages: ['ping', 'pong', 'error'], closeCodes: [4400] },
      async run(ctx) {
        const doc = await ctx.document();
        const seed = ctx.config.fuzz.seed;
        const deadline = Date.now() + ctx.config.fuzz.budgetMs;
        let s = await openSession(ctx, doc);
        let sent = 0;
        let closes = 0;
        const codes = new Map<number, number>();
        for (let batch = 0; Date.now() < deadline && sent < ctx.config.fuzz.maxRuns; batch++) {
          const inputs = fc.sample(frames(doc), { seed: seed + batch, numRuns: 50 });
          for (let i = 0; i < inputs.length && Date.now() < deadline; i++) {
            const text = inputs[i]!;
            if (utf8Length(text) > ctx.limits.maxMessageBytes) continue;
            const from = s.wire.mark();
            s.wire.sendText(text);
            sent++;
            let state: 'alive' | 'closed';
            try {
              state = await probe(ctx, s, sent);
            } catch (e) {
              throw new KitFailure(
                `${e instanceof Error ? e.message : String(e)} (seed ${seed}, batch ${batch}, input ${i})`,
                'an answer, a defined close or nothing',
                show(text),
              );
            }
            for (const m of s.wire.messages.slice(from))
              if (m.t === 'error')
                check(
                  ALL_CODES.has(m.d.code),
                  `an error code of the registry (seed ${seed}, batch ${batch}, input ${i})`,
                  'a registry code',
                  { frame: text, error: m.d },
                );
            if (state === 'closed') {
              const code = s.wire.closed!.code;
              codes.set(code, (codes.get(code) ?? 0) + 1);
              ctx.closeCode(code);
              check(
                CLOSE_CODES.includes(code),
                `a close code of 05 §5.7 (seed ${seed}, batch ${batch}, input ${i})`,
                CLOSE_CODES,
                { code, frame: text },
              );
              closes++;
              s = await openSession(ctx, doc).catch((e: unknown) => {
                throw new KitFailure(
                  `the server did not accept a new connection after a fuzzed frame (seed ${seed}, batch ${batch}, input ${i})`,
                  'the server stays up',
                  { frame: text, error: String(e) },
                );
              });
            }
          }
        }
        if (ctx.problems().length)
          throw new KitFailure(
            'the server sent invalid frames while fuzzed',
            'valid messages only',
            ctx.problems().slice(0, 3),
          );
        ctx.note(
          `seed ${seed}: ${sent} frames in ${ctx.config.fuzz.budgetMs} ms, ${closes} closes (${[...codes].map(([c, n]) => `${c}×${n}`).join(', ') || 'none'})`,
        );
        const last = await openSession(ctx, doc);
        equal(await probe(ctx, last, -1), 'alive', 'the server answers after the run');
      },
    }),
    f({
      id: 'steps',
      title:
        'random and mutated steps are applied or rejected with a registry code; the document stays valid',
      spec: '04 §4, §5; 03 §6; 10 §5',
      budget: 'fuzz',
      covers: { messages: ['sync.submit', 'sync.ack', 'sync.reject'], errors: ['invalid_op'] },
      async run(ctx) {
        const doc = await ctx.document();
        const m = await join(ctx, 'steps', doc, 'owner');
        const seed = ctx.config.fuzz.seed;
        const deadline = Date.now() + ctx.config.fuzz.budgetMs;
        let base = m.content.seq;
        let size = nodeSize(m.content.doc as unknown as JsonNode);
        let sent = 0;
        let accepted = 0;
        const codes = new Map<string, number>();
        const recent: unknown[] = [];
        const checkValid = async (why: string) => {
          const content = await readContent(ctx, m.token, doc);
          const r = validate({
            cdm: content.cdm,
            requires: content.requires,
            doc: content.doc,
          } as never);
          if (!r.valid)
            throw new KitFailure(
              `the document is no longer valid ${why} (seed ${seed})`,
              'a document valid against the CDM schema (03 §6)',
              {
                violations: r.violations.slice(0, 5),
                lastSteps: recent.slice(-5),
              },
            );
          return content;
        };
        for (let batch = 0; Date.now() < deadline && sent < ctx.config.fuzz.maxRuns; batch++) {
          const inputs = fc.sample(stepsArb(size), { seed: seed + batch, numRuns: 25 });
          for (const steps of inputs) {
            if (Date.now() >= deadline) break;
            recent.push(steps);
            if (recent.length > 20) recent.shift();
            const r = await submit(m.wire, 1, { base, steps: steps as never });
            sent++;
            if (r.t === 'sync.ack') {
              accepted++;
              base = r.d.seq;
            } else if (r.t === 'sync.reject') {
              check(
                SYNC_CODES.has(r.d.code),
                'a rejection carries a sync code of the registry',
                [...SYNC_CODES],
                { steps, reply: r.d },
              );
              codes.set(r.d.code, (codes.get(r.d.code) ?? 0) + 1);
              base = Math.max(base, r.d.head);
            } else if (r.t === 'error') {
              check(
                r.d.code === 'bad_message' && !r.d.fatal,
                'a malformed commit is a non-fatal bad_message (D03)',
                'bad_message',
                { steps, reply: r.d },
              );
            } else
              throw new KitFailure(
                'an unexpected reply to sync.submit',
                'sync.ack, sync.reject or error',
                r,
              );
          }
          const content = await checkValid(`after batch ${batch}`);
          base = content.seq;
          size = nodeSize(content.doc as unknown as JsonNode);
        }
        await checkValid('at the end');
        ctx.note(
          `seed ${seed}: ${sent} commits, ${accepted} accepted; rejections ${[...codes].map(([c, n]) => `${c}×${n}`).join(', ')}`,
        );
        check(sent > 0, 'the fuzzer submitted commits', '> 0', sent);
      },
    }),
    f({
      id: 'boundary',
      title: 'a frame of exactly maxMessageBytes is delivered; one byte more is closed with 4413',
      spec: '05 §4, §5.7',
      covers: { closeCodes: [4413], messages: ['ping', 'pong'] },
      async run(ctx) {
        const doc = await ctx.document();
        const s = await openSession(ctx, doc);
        const max = ctx.limits.maxMessageBytes;
        const frame = (n: number, id: string) => {
          const head = `{"t":"ping","id":"${id}","x":"`;
          return `${head}${'x'.repeat(n - utf8Length(head) - 2)}"}`;
        };
        const at = frame(max, 'at');
        equal(utf8Length(at), max, 'a frame of maxMessageBytes');
        s.wire.sendText(at);
        const pong = await s.wire.next(
          (m) => m.t === 'pong',
          'the answer to a frame of exactly maxMessageBytes',
        );
        check(pong.t === 'pong', 'delivered', 'pong', pong);
        const over = frame(max + 1, 'over');
        s.wire.sendText(over);
        const closed = await s.wire.closes('a frame of maxMessageBytes + 1');
        ctx.closeCode(closed.code);
        equal(closed.code, 4413, 'the close code for a frame above maxMessageBytes (05 §5.7)');
      },
    }),
  ],
};

const STEP_TYPES = [
  'replace',
  'replaceAround',
  'addMark',
  'removeMark',
  'addNodeMark',
  'removeNodeMark',
  'attr',
];
const NODE_TYPES = [
  'paragraph',
  'text',
  'region',
  'heading',
  'table',
  'body',
  'defs',
  'doc',
  'image',
  'x-tck-node',
];
const MARKS = ['bold', 'italic', 'underline', 'link', 'ins', 'del', 'x-tck-mark'];

/** Random steps over a document of `size` positions, valid and invalid alike. */
function stepsArb(size: number): fc.Arbitrary<Array<Record<string, unknown>>> {
  const pos = fc.oneof(
    { weight: 8, arbitrary: fc.integer({ min: 0, max: size + 2 }) },
    { weight: 1, arbitrary: fc.integer({ min: -5, max: size * 3 + 10 }) },
  );
  const text = fc.string({ minLength: 1, maxLength: 6 });
  const node: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
    text.map((t) => ({ type: 'text', text: t })),
    fc
      .record({
        type: fc.constantFrom(...NODE_TYPES),
        attrs: fc.option(
          fc.dictionary(
            fc.constantFrom('id', 'style', 'policy', 'title', 'x'),
            fc.oneof(fc.string({ maxLength: 16 }), fc.integer()),
          ),
          { nil: undefined },
        ),
      })
      .map((n) => {
        const o: Record<string, unknown> = { type: n.type };
        if (n.attrs) o['attrs'] = n.attrs;
        if (n.type === 'paragraph') o['content'] = [{ type: 'text', text: 'p' }];
        return o;
      }),
  );
  const slice = fc.option(
    fc.record({
      content: fc.array(node, { minLength: 1, maxLength: 3 }),
      openStart: fc.nat(3),
      openEnd: fc.nat(3),
    }),
    { nil: undefined },
  );
  const mark = fc.record({
    type: fc.constantFrom(...MARKS),
    attrs: fc.option(
      fc.dictionary(fc.constantFrom('href', 'id', 'user'), fc.string({ maxLength: 12 })),
      { nil: undefined },
    ),
  });
  const step: fc.Arbitrary<Record<string, unknown>> = fc
    .record({
      stepType: fc.oneof(
        { weight: 9, arbitrary: fc.constantFrom(...STEP_TYPES) },
        { weight: 1, arbitrary: fc.string({ maxLength: 8 }) },
      ),
      from: pos,
      to: pos,
      gapFrom: pos,
      gapTo: pos,
      insert: fc.nat(4),
      structure: fc.boolean(),
      slice,
      mark,
      attr: fc.constantFrom('style', 'id', 'policy', 'title', 'level', 'x'),
      value: jsonValue,
    })
    .map((r) => {
      const [a, b] = r.from <= r.to ? [r.from, r.to] : [r.to, r.from];
      switch (r.stepType) {
        case 'replace':
          return { stepType: 'replace', from: a, to: b, ...(r.slice ? { slice: r.slice } : {}) };
        case 'replaceAround':
          return {
            stepType: 'replaceAround',
            from: a,
            to: b,
            gapFrom: Math.min(r.gapFrom, r.gapTo),
            gapTo: Math.max(r.gapFrom, r.gapTo),
            insert: r.insert,
            structure: r.structure,
            ...(r.slice ? { slice: r.slice } : {}),
          };
        case 'addMark':
        case 'removeMark':
          return { stepType: r.stepType, mark: r.mark, from: a, to: b };
        case 'addNodeMark':
        case 'removeNodeMark':
          return { stepType: r.stepType, pos: a, mark: r.mark };
        case 'attr':
          return { stepType: 'attr', pos: a, attr: r.attr, value: r.value };
        default:
          return { stepType: r.stepType, from: a };
      }
    });
  return fc.array(step, { minLength: 1, maxLength: 3 });
}
