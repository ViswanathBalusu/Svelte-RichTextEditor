/**
 * SEC-005 criterion 1 (lane w3): the injection corpus at every attribute and text position of the
 * CDM, submitted as commits by the adversarial client over the wire, on memory and on PostgreSQL
 * (10 §3.1; 03 §8, I11).
 *
 * The positions are not a hand-made list. The document is the `all-constructs` canonical fixture
 * of CDM-011, and the test first checks that it holds every node type and every mark type of the
 * schema. Then, as an owner (so that a refusal is the grammars' and not a missing right):
 *
 * - every attribute the schema declares on every node of the document gets every payload
 *   (`AttrStep`, or `DocAttrStep` for the top node);
 * - every attribute of every mark type gets every payload (`AddMarkStep` on a run of text);
 * - every textblock gets every payload as inserted text;
 * - every node gets an attribute named `__proto__`, `constructor` and `prototype`.
 *
 * Each answer must be a refusal with a registry code, or an acknowledgement after which the stored
 * value is exactly the payload string and the document holds no node type it did not hold before.
 * A URL-like attribute must never store a `javascript:` or `data:` payload (I9). After every
 * position a commit from a second client is acknowledged, so the room keeps serving others, and
 * `Object.prototype` of the service's process is unchanged at the end.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AddMarkStep, AttrStep, DocAttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { PAYLOADS } from './support/payloads.ts';
import { Fragment, Slice, loadDoc, schema, stepsJson, type Node } from './support/cdm.ts';
import {
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

interface Json {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: Json[];
  [key: string]: unknown;
}

/**
 * The fixture without what needs an uploaded asset or a preserved fragment (I4): a new document
 * has none, and this harness completes no upload. A node that names one is removed, and an
 * `origin` that names a fragment is cleared. The node types this leaves out are in `LEFT_OUT`.
 */
function withoutStoredObjects(node: Json): Json | null {
  const attrs = node.attrs ?? {};
  for (const name of ['asset', 'fallbackAsset', 'fragment'])
    if (typeof attrs[name] === 'string') return null;
  const out: Json = { ...node };
  const origin = attrs['origin'];
  if (origin && typeof origin === 'object' && 'fragment' in origin)
    out.attrs = { ...attrs, origin: null };
  if (node.content)
    out.content = node.content
      .map((child) => withoutStoredObjects(child))
      .filter((child): child is Json => child !== null);
  return out;
}

/** Node types of the schema the document of this test does not hold (see `withoutStoredObjects`). */
const LEFT_OUT: readonly string[] = [
  'caption',
  'figure',
  'image',
  'preserved_block',
  'preserved_inline',
];

/** The features the fixture requires, which the client must announce to open it. */
const FEATURES = ['presence', 'regions', 'extensions', 'fields', 'preserve'];

const RAW = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../packages/model/fixtures/canonical/inputs/all-constructs.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as Record<string, unknown>;
const FIXTURE: Record<string, unknown> = {
  ...RAW,
  doc: withoutStoredObjects(RAW['doc'] as Json),
};

/** The codes of 05 §9 a commit is refused with. Anything else fails the test. */
const REFUSALS: ReadonlySet<string> = new Set(['invalid_op', 'permission_denied']);
const URL_LIKE = /href|src|url|asset|target|link/i;
const ACTIVE_URL = /^\s*(javascript|data|vbscript):/i;
const PROTO_NAMES = ['__proto__', 'constructor', 'prototype'] as const;

interface Tally {
  positions: number;
  submitted: number;
  refused: number;
  inert: number;
  /** Commits acknowledged that changed nothing (an attribute the node type does not declare). */
  noOp: number;
  rateLimited: number;
  codes: Set<string>;
}

function typesOf(d: Node): Set<string> {
  const s = new Set<string>([d.type.name]);
  d.descendants((n) => {
    s.add(n.type.name);
    return true;
  });
  return s;
}

function markTypesOf(d: Node): Set<string> {
  const s = new Set<string>();
  d.descendants((n) => {
    for (const m of n.marks) s.add(m.type.name);
    return true;
  });
  return s;
}

describe('SEC-005: the fixture reaches every construct of the CDM', () => {
  const d = loadDoc(FIXTURE['doc']);
  it('the whole fixture holds every node type of the schema', () => {
    const have = typesOf(loadDoc(RAW['doc']));
    expect(Object.keys(schema.nodes).filter((n) => !have.has(n))).toEqual([]);
  });
  it('the document of this test holds every node type but those that need a stored object', () => {
    const have = typesOf(d);
    const missing = Object.keys(schema.nodes).filter((n) => !have.has(n));
    expect(missing.sort()).toEqual([...LEFT_OUT].sort());
  });
  it('holds every mark type of the schema', () => {
    const have = markTypesOf(d);
    const missing = Object.keys(schema.marks).filter((m) => !have.has(m));
    expect(missing).toEqual([]);
  });
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  const run = skip ? it.skip : it;

  describe(`SEC-005 criterion 1: every attribute and text position, over the wire (${storage})`, () => {
    let h: Harness;
    let doc: string;
    let adversary: WireClient;
    let other: WireClient;
    let base = 0;
    let baseTypes: Set<string>;
    const tally: Tally = {
      positions: 0,
      submitted: 0,
      refused: 0,
      inert: 0,
      noOp: 0,
      rateLimited: 0,
      codes: new Set(),
    };

    const content = async (): Promise<Node> => {
      const r = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey });
      return loadDoc((r.json as { doc: unknown }).doc);
    };

    const connect = async (sub: string): Promise<WireClient> => {
      const token = await h.mintToken(h.a, sub, { [doc]: 'owner' });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      const welcome = await c.hello(token, { features: FEATURES });
      expect(welcome.t).toBe('welcome');
      const opened = await c.open(1, doc, { features: FEATURES });
      expect(['error', 'ch.rejected'], JSON.stringify(opened.d)).not.toContain(opened.t);
      return c;
    };

    /** Submits steps; true when acknowledged. A refusal must carry a registry code. */
    const submit = async (c: WireClient, steps: readonly Step[] | unknown[]): Promise<boolean> => {
      const json =
        steps.length > 0 && typeof (steps[0] as Step).toJSON === 'function'
          ? stepsJson(steps as Step[])
          : (steps as unknown[]);
      let r = await c.submit(1, { id: uuid7(), base, steps: json }, 15_000);
      // The service's rate limit is not an answer about the payload: wait as it asks and send again.
      for (let tries = 0; r.t === 'sync.reject' && r.d?.['code'] === 'rate_limited'; tries += 1) {
        expect(tries, 'the rate limit lets the commit through in the end').toBeLessThan(200);
        tally.rateLimited += 1;
        await new Promise((done) => setTimeout(done, Math.max(5, Number(r.d?.['retryAfterMs']))));
        r = await c.submit(1, { id: uuid7(), base, steps: json }, 15_000);
      }
      if (r.t === 'sync.ack') {
        base = Number(r.d?.['seq']);
        expect(Number.isInteger(base), 'an acknowledgement carries the new seq').toBe(true);
        return true;
      }
      expect(r.t, JSON.stringify(r.d)).toBe('sync.reject');
      const code = String(r.d?.['code']);
      tally.codes.add(code);
      expect(REFUSALS.has(code), `refused with ${code}: ${JSON.stringify(r.d)}`).toBe(true);
      return false;
    };

    const attack = async (steps: readonly Step[]): Promise<boolean> => {
      tally.submitted += 1;
      const acked = await submit(adversary, steps);
      if (acked) tally.inert += 1;
      else tally.refused += 1;
      return acked;
    };

    /**
     * A second client's commit is acknowledged: the room still serves it. The commit sets a
     * region's title, an attribute change, so that it moves no position the test still uses.
     */
    let benignCount = 0;
    const benign = async (): Promise<void> => {
      const d = await content();
      let at = -1;
      d.descendants((n, p) => {
        if (at < 0 && n.type.name === 'region') at = p;
        return at < 0;
      });
      expect(at, 'the fixture has a region').toBeGreaterThan(0);
      benignCount += 1;
      const acked = await submit(other, [new AttrStep(at, 'title', `Checked ${benignCount}`)]);
      expect(acked, 'the room keeps serving another client').toBe(true);
    };
    const expectNoNewTypes = (d: Node): void => {
      for (const t of typesOf(d))
        expect(baseTypes.has(t), `node type ${t} was not in the document before`).toBe(true);
    };

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
      doc = await h.createDocument(h.a, FIXTURE);
      baseTypes = typesOf(await content());
      adversary = await connect('u-adversary');
      other = await connect('u-other');
    }, 60_000);

    afterAll(async () => {
      adversary?.terminate();
      other?.terminate();
      await h?.close();
    });

    run(
      'every attribute of every node: refused, or stored as the exact inert string',
      async () => {
        const d = await content();
        const targets: { pos: number; type: string; attrs: string[] }[] = [];
        d.descendants((n, p) => {
          const attrs = Object.keys(n.type.spec.attrs ?? {});
          if (attrs.length > 0) targets.push({ pos: p, type: n.type.name, attrs });
          return true;
        });
        expect(targets.length).toBeGreaterThan(30);
        for (const target of targets) {
          for (const attr of target.attrs) {
            tally.positions += 1;
            for (const payload of PAYLOADS) {
              const acked = await attack([new AttrStep(target.pos, attr, payload)]);
              if (!acked) continue;
              const now = await content();
              const stored = now.nodeAt(target.pos);
              expect(stored?.type.name, `${target.type}.${attr}`).toBe(target.type);
              expect(stored?.attrs[attr], `${target.type}.${attr} holds the exact string`).toBe(
                payload,
              );
              if (URL_LIKE.test(attr))
                expect(
                  ACTIVE_URL.test(payload),
                  `${target.type}.${attr} stored an active URL: ${payload}`,
                ).toBe(false);
              expectNoNewTypes(now);
            }
          }
          await benign();
        }
        // The top node's own attributes.
        for (const attr of Object.keys(d.type.spec.attrs ?? {})) {
          tally.positions += 1;
          for (const payload of PAYLOADS) {
            const acked = await attack([new DocAttrStep(attr, payload)]);
            if (acked) expect((await content()).attrs[attr]).toBe(payload);
          }
        }
        await benign();
      },
      600_000,
    );

    run(
      'every attribute of every mark type: refused, or stored as the exact inert string',
      async () => {
        const d = await content();
        // A run of plain text in a body paragraph, long enough to carry a mark.
        let from = -1;
        d.descendants((n, p, parent) => {
          if (from < 0 && n.isText && parent?.type.name === 'paragraph' && n.nodeSize >= 2)
            from = p;
          return from < 0;
        });
        expect(from).toBeGreaterThan(0);
        for (const type of Object.values(schema.marks)) {
          for (const attr of Object.keys(type.spec.attrs ?? {})) {
            tally.positions += 1;
            for (const payload of PAYLOADS) {
              let mark;
              try {
                mark = type.create({ [attr]: payload });
              } catch {
                // The schema itself refuses to build the mark: there is nothing to submit.
                continue;
              }
              const acked = await attack([new AddMarkStep(from, from + 1, mark)]);
              if (!acked) continue;
              const now = await content();
              const stored = now.nodeAt(from)?.marks.find((m) => m.type === type);
              expect(stored?.attrs[attr], `mark ${type.name}.${attr}`).toBe(payload);
              if (URL_LIKE.test(attr) || type.name === 'link')
                expect(
                  ACTIVE_URL.test(payload),
                  `mark ${type.name}.${attr} stored an active URL: ${payload}`,
                ).toBe(false);
              expectNoNewTypes(now);
            }
          }
          await benign();
        }
      },
      300_000,
    );

    run(
      'an attribute named for the prototype chain is refused on every node',
      async () => {
        const d = await content();
        const positions: number[] = [];
        d.descendants((_n, p) => {
          positions.push(p);
          return true;
        });
        let before = JSON.stringify(d.toJSON());
        for (const pos of positions) {
          tally.positions += 1;
          for (const name of PROTO_NAMES) {
            const acked = await attack([new AttrStep(pos, name, { polluted: true })]);
            if (!acked) continue;
            // Acknowledged: then it changed nothing. The schema drops an attribute the node type
            // does not declare, so the document is the same, byte for byte.
            tally.inert -= 1;
            tally.noOp += 1;
            const after = JSON.stringify((await content()).toJSON());
            expect(
              after === before,
              `an attribute named ${name} at ${pos} changed the document`,
            ).toBe(true);
            before = after;
          }
        }
        await benign();
        expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
      },
      300_000,
    );

    run(
      'every text position: the payload is stored as text, or refused',
      async () => {
        for (const payload of PAYLOADS) {
          const d = await content();
          const blocks: { pos: number; type: string }[] = [];
          d.descendants((n, p) => {
            if (n.isTextblock) blocks.push({ pos: p, type: n.type.name });
            return true;
          });
          expect(blocks.length).toBeGreaterThan(5);
          // From the last block to the first, so an insertion does not move the blocks still to do.
          for (const block of blocks.reverse()) {
            tally.positions += 1;
            const slice = new Slice(Fragment.from(schema.text(payload)), 0, 0);
            const acked = await attack([new ReplaceStep(block.pos + 1, block.pos + 1, slice)]);
            if (!acked) continue;
            const now = await content();
            const stored = now.nodeAt(block.pos);
            expect(stored?.type.name).toBe(block.type);
            expect(stored?.textContent.startsWith(payload), `${block.type} holds the text`).toBe(
              true,
            );
            expectNoNewTypes(now);
          }
          await benign();
        }
      },
      600_000,
    );

    run('the corpus was refused or stored inert at every position', () => {
      expect(tally.positions).toBeGreaterThan(200);
      expect(tally.refused + tally.inert + tally.noOp).toBe(tally.submitted);
      expect([...tally.codes].filter((c) => !REFUSALS.has(c))).toEqual([]);
      console.info(
        `SEC-005 ${storage}: ${tally.positions} positions, ${tally.submitted} commits, ` +
          `${tally.refused} refused (${[...tally.codes].sort().join(', ')}), ${tally.inert} stored as inert text, ` +
          `${tally.noOp} acknowledged without effect, ${tally.rateLimited} waits for the rate limit`,
      );
    });
  });
}
