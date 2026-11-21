/**
 * SEC-005 criterion 1 (lanes w3 and w8): the injection corpus at every attribute and text position
 * of the CDM, submitted as commits by the adversarial client over the wire, on memory and on
 * PostgreSQL (10 §3.1; 03 §8, I11).
 *
 * The positions are not a hand-made list. The document is the `all-constructs` canonical fixture
 * of CDM-011, and the test first checks that it holds every node type and every mark type of the
 * schema. Five node types name a stored object (`image`, `figure` and its `caption`,
 * `preserved_block`, `preserved_inline`: an asset or a preserved fragment, I4), and a new document
 * has none. So the document is created without them, the adversary declares one upload for each
 * stored object the fixture names (`POST /documents/{id}/assets`) and the registry settles each as
 * ready, as the asset worker leaves it, and the whole fixture, renamed to those assets, is then put
 * in place with `PUT /documents/{id}/content`. From there the document holds every node type.
 * Then, as an owner (so that a refusal is the grammars' and not a missing right):
 *
 * - every attribute the schema declares on every node of the document gets every payload
 *   (`AttrStep`, or `DocAttrStep` for the top node);
 * - every attribute of every mark type gets every payload: an `addMark` step, written as JSON, on
 *   the text that carries a mark of that type, with its other attributes as they were (lane w8;
 *   before, a mark with a required attribute beside the one under test was never submitted);
 * - every place inside an attribute that holds more than one value gets every payload (lane w8):
 *   the members of an object, the items of an array, the values and the names of free JSON and
 *   the attributes, names and texts of a preserved element tree. The places are derived from the
 *   grammars of the definition (support/sec-005-nested.ts), and each attribute is first given a
 *   value with every declared member, which the service must acknowledge, so that a refusal is
 *   about the payload and not about the value around it;
 * - every textblock gets every payload as inserted text;
 * - every node gets an attribute named `__proto__`, `constructor` and `prototype`.
 *
 * Each answer must be a refusal with a registry code, or an acknowledgement after which the stored
 * value is exactly the payload string and the document holds no node type it did not hold before.
 * A URL-like attribute must never store a `javascript:` or `data:` payload (I9). After every
 * position a commit from a second client is acknowledged, so the room keeps serving others, and
 * `Object.prototype` of the service's process is unchanged at the end.
 */
import { AttrStep, DocAttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { CDM1, type AttrDef } from '@docedit/model/definition';
import { PAYLOADS } from './support/payloads.ts';
import { Fragment, Slice, loadDoc, schema, stepsJson, type Node } from './support/cdm.ts';
import {
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import {
  FEATURES,
  NEED_STORED,
  RAW,
  STORED_OBJECTS,
  WITHOUT_STORED,
  placeWholeFixture,
  storedObjects,
  type Json,
} from './support/sec-005-fixture.ts';
import {
  chooseBase,
  declaresMember,
  exampleOf,
  isStructured,
  nestedEdits,
  refsOf,
  same,
} from './support/sec-005-nested.ts';
import { WireClient } from './support/wire.ts';

/** The codes of 05 §9 a commit is refused with. Anything else fails the test. */
const REFUSALS: ReadonlySet<string> = new Set(['invalid_op', 'permission_denied']);
const URL_LIKE = /href|src|url|asset|fragment|target|link/i;
const ACTIVE_URL = /^\s*(javascript|data|vbscript):/i;
const PROTO_NAMES = ['__proto__', 'constructor', 'prototype'] as const;

/** The `sub` of the user who attacks. */
const ADVERSARY = 'u-adversary';
/** The attributes of a node type or a mark type that hold more than one value. */
const structuredOf = (attrs: Readonly<Record<string, AttrDef>>): Array<[string, AttrDef]> =>
  Object.entries(attrs).filter(([, def]) => isStructured(def.grammar));

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
  const whole = loadDoc(RAW['doc']);
  it('the whole fixture holds every node type of the schema', () => {
    const have = typesOf(whole);
    expect(Object.keys(schema.nodes).filter((n) => !have.has(n))).toEqual([]);
  });
  it('without its stored objects it lacks exactly the node types that need one', () => {
    const have = typesOf(loadDoc(WITHOUT_STORED['doc']));
    const missing = Object.keys(schema.nodes).filter((n) => !have.has(n));
    expect(missing.sort()).toEqual([...NEED_STORED].sort());
    // Each stored object is named by an asset attribute, so an uploaded asset can stand for it.
    expect(STORED_OBJECTS.length).toBeGreaterThan(0);
    expect(storedObjects(WITHOUT_STORED['doc'] as Json).size).toBe(0);
  });
  it('holds every mark type of the schema', () => {
    const have = markTypesOf(whole);
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

    /**
     * The adversary as the room names it: the tenant's surrogate for the host's `sub` (BE-013).
     * A suggestion in this name is the adversary's own, and `hints` puts it where an example
     * value names its user.
     */
    let adversaryUser = ADVERSARY;
    let hints: Readonly<Record<string, unknown>> = { user: ADVERSARY };
    /** The adversary as `welcome` names it, to record which of the two names the wire shows. */
    let welcomedAs = '';

    const connect = async (sub: string): Promise<WireClient> => {
      const token = await h.mintToken(h.a, sub, { [doc]: 'owner' });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      const welcome = await c.hello(token, { features: FEATURES });
      expect(welcome.t).toBe('welcome');
      if (sub === ADVERSARY) {
        welcomedAs = String((welcome.d?.['user'] as { id?: unknown } | undefined)?.id);
        adversaryUser = (await h.parts.users.resolve(h.a.id, sub)).surrogate;
        hints = { user: adversaryUser };
      }
      const opened = await c.open(1, doc, { features: FEATURES });
      expect(['error', 'ch.rejected'], JSON.stringify(opened.d)).not.toContain(opened.t);
      return c;
    };

    /** What the service said when it last refused a commit, for the message of a failed check. */
    let lastRefusal = '';
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
      lastRefusal = JSON.stringify(r.d);
      tally.codes.add(code);
      expect(REFUSALS.has(code), `refused with ${code}: ${JSON.stringify(r.d)}`).toBe(true);
      return false;
    };

    const attack = async (steps: readonly Step[] | unknown[]): Promise<boolean> => {
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
      // The whole fixture in a real document, its stored objects uploaded by the adversary.
      const placed = await placeWholeFixture(h, ADVERSARY);
      doc = placed.doc;
      base = placed.seq;
      baseTypes = typesOf(await content());
      // The document of this test now holds every node type of the schema.
      expect(Object.keys(schema.nodes).filter((n) => !baseTypes.has(n))).toEqual([]);
      adversary = await connect(ADVERSARY);
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
        // Every node type that declares an attribute is among the targets, the five that name a
        // stored object included; the top node's attributes follow below.
        const reached = new Set(targets.map((t) => t.type));
        for (const [name, type] of Object.entries(schema.nodes))
          if (type !== schema.topNodeType && Object.keys(type.spec.attrs ?? {}).length > 0)
            expect(reached.has(name), `${name} is in the document`).toBe(true);
        for (const name of NEED_STORED) expect(reached.has(name), name).toBe(true);
        for (const target of targets) {
          for (const attr of target.attrs) {
            tally.positions += 1;
            let stored = false;
            for (const payload of PAYLOADS) {
              const acked = await attack([new AttrStep(target.pos, attr, payload)]);
              if (!acked) continue;
              stored = true;
              const now = await content();
              const node = now.nodeAt(target.pos);
              expect(node?.type.name, `${target.type}.${attr}`).toBe(target.type);
              expect(node?.attrs[attr], `${target.type}.${attr} holds the exact string`).toBe(
                payload,
              );
              if (URL_LIKE.test(attr))
                expect(
                  ACTIVE_URL.test(payload),
                  `${target.type}.${attr} stored an active URL: ${payload}`,
                ).toBe(false);
              expectNoNewTypes(now);
            }
            // The attribute gets its own value back, so every later test meets the fixture.
            if (stored) {
              const original = d.nodeAt(target.pos)!.attrs[attr] as unknown;
              const back = await submit(adversary, [new AttrStep(target.pos, attr, original)]);
              expect(back, `${target.type}.${attr} is put back: ${lastRefusal}`).toBe(true);
            }
          }
          await benign();
        }
        // The top node's own attributes.
        for (const attr of Object.keys(d.type.spec.attrs ?? {})) {
          tally.positions += 1;
          let stored = false;
          for (const payload of PAYLOADS) {
            const acked = await attack([new DocAttrStep(attr, payload)]);
            if (!acked) continue;
            stored = true;
            expect((await content()).attrs[attr]).toBe(payload);
          }
          if (stored)
            expect(await submit(adversary, [new DocAttrStep(attr, d.attrs[attr])])).toBe(true);
        }
        await benign();
      },
      600_000,
    );

    /** The text that carries a mark of a type, and the attributes the mark has there. */
    interface Carrier {
      from: number;
      to: number;
      attrs: Record<string, unknown>;
    }
    /** The first text that carries each mark type (the fixture has every one). */
    const carriersOf = (d: Node): Map<string, Carrier> => {
      const carriers = new Map<string, Carrier>();
      d.descendants((n, p) => {
        if (n.isText)
          for (const m of n.marks)
            if (!carriers.has(m.type.name))
              carriers.set(m.type.name, { from: p, to: p + n.nodeSize, attrs: { ...m.attrs } });
        return true;
      });
      expect(Object.keys(schema.marks).filter((m) => !carriers.has(m))).toEqual([]);
      return carriers;
    };
    // The steps are written as JSON, not built: the client's own schema would refuse to make a
    // mark whose attribute has the wrong type, and an attacker has no such check.
    const addMark = (c: Carrier, type: string, attrs: Record<string, unknown>): unknown => ({
      stepType: 'addMark',
      from: c.from,
      to: c.to,
      mark: { type, attrs },
    });
    /** Takes a mark the adversary added away again, and puts back the one that was there. */
    const undoMark = (c: Carrier, type: string, attrs: Record<string, unknown>): unknown[] => [
      { stepType: 'removeMark', from: c.from, to: c.to, mark: { type, attrs } },
      addMark(c, type, c.attrs),
    ];
    /**
     * The attributes a mark of this type is submitted with: those of the mark that is there, one
     * of them then replaced by the payload, so that a mark with several required attributes is a
     * valid mark but for the payload. A suggestion mark is made the adversary's own first (a new
     * identifier, the adversary as its user): rule P4 refuses a suggestion in another user's
     * name whatever else it holds, and the grammar would never be asked. The service must accept
     * that mark as it is, which is checked here, and it is taken away again.
     */
    const submittedAs = async (type: string, c: Carrier): Promise<Record<string, unknown>> => {
      if (!Object.hasOwn(schema.marks[type]?.spec.attrs ?? {}, 'user')) return c.attrs;
      const mine = { ...c.attrs, id: 'sec005nested0002', user: adversaryUser };
      const accepted = await submit(adversary, [addMark(c, type, mine)]);
      expect(accepted, `the adversary's own ${type} suggestion is accepted: ${lastRefusal}`).toBe(
        true,
      );
      expect(await submit(adversary, undoMark(c, type, mine)), `${type} is taken away`).toBe(true);
      return mine;
    };

    run(
      'every attribute of every mark type: refused, or stored as the exact inert string',
      async () => {
        const carriers = carriersOf(await content());
        let submittedHere = 0;
        for (const type of Object.values(schema.marks)) {
          const at = carriers.get(type.name)!;
          const mine = await submittedAs(type.name, at);
          for (const attr of Object.keys(type.spec.attrs ?? {})) {
            tally.positions += 1;
            for (const payload of PAYLOADS) {
              submittedHere += 1;
              const attrs = { ...mine, [attr]: payload };
              const acked = await attack([addMark(at, type.name, attrs)]);
              if (!acked) continue;
              const now = await content();
              // (A mark type that may repeat on the same text keeps the earlier mark beside it.)
              const stored = (now.nodeAt(at.from)?.marks ?? []).filter((m) => m.type === type);
              expect(
                stored.some((m) => m.attrs[attr] === payload),
                `mark ${type.name}.${attr} holds the exact string`,
              ).toBe(true);
              if (URL_LIKE.test(attr))
                expect(
                  ACTIVE_URL.test(payload),
                  `mark ${type.name}.${attr} stored an active URL: ${payload}`,
                ).toBe(false);
              expectNoNewTypes(now);
              // The text gets its own mark back, so the next payload meets the same document.
              expect(await submit(adversary, undoMark(at, type.name, attrs))).toBe(true);
            }
          }
          await benign();
        }
        // Every attribute of every mark type took every payload: none was left out.
        const markAttributes = Object.values(schema.marks).reduce(
          (n, type) => n + Object.keys(type.spec.attrs ?? {}).length,
          0,
        );
        expect(submittedHere).toBe(markAttributes * PAYLOADS.length);
      },
      300_000,
    );

    /** What the nested tests report at the end: the attributes and the places inside them. */
    const nested = {
      attributes: 0,
      places: 0,
      /** Attributes whose value with every declared member was accepted, so every member is reached. */
      filledOut: 0,
      /** Attributes attacked in the value they hold, or in the smallest valid one. */
      asHeld: [] as string[],
      /** Attributes whose accepted value is one string or number: nothing is inside it. */
      single: [] as string[],
      /** Attributes no commit can set at all: the answer is the same for every payload. */
      closed: [] as string[],
    };

    /**
     * The value an attribute is given before the payloads go in (`chooseBase`), recorded for the
     * report. `send` submits a value and says whether it was acknowledged.
     */
    const baseFor = async (
      what: string,
      def: AttrDef,
      original: unknown,
      refs: ReturnType<typeof refsOf>,
      send: (value: unknown) => Promise<boolean>,
    ): Promise<{ base: unknown; sent: boolean }> => {
      nested.attributes += 1;
      const found = await chooseBase(def.grammar, original, refs, hints, send);
      if (found?.how === 'full') nested.filledOut += 1;
      else if (found?.how === 'held') nested.asHeld.push(what);
      else if (found?.how === 'single') nested.single.push(what);
      else nested.closed.push(what);
      // Closed to commits: the payloads are still sent, in the value the document holds.
      return found ?? { base: original ?? exampleOf(def.grammar, refs, hints, false), sent: false };
    };

    run(
      'every place inside a structured attribute of every node type: refused, or stored exactly',
      async () => {
        const start = await content();
        const refs = refsOf(start.toJSON() as Json);
        for (const def of CDM1.nodes) {
          if (def.name === 'text') continue;
          const top = def.name === CDM1.topNode;
          for (const [attr, attrDef] of structuredOf(def.attrs)) {
            const what = `${def.name}.${attr}`;
            // The node of this type that holds a value for the attribute, or else the first one.
            // A value that names its user (a block suggestion) is the adversary's own instead,
            // on a node that has none: another user's suggestion is refused by rule P4 whatever
            // is put in it.
            let pos = -1;
            let held = -1;
            let free = -1;
            if (!top)
              start.descendants((n, p) => {
                if (n.type.name !== def.name) return true;
                if (pos < 0) pos = p;
                if (held < 0 && n.attrs[attr] !== null) held = p;
                if (free < 0 && n.attrs[attr] === null) free = p;
                return true;
              });
            if (free >= 0 && declaresMember(attrDef.grammar, Object.keys(hints))) pos = free;
            else if (held >= 0) pos = held;
            expect(top || pos >= 0, `${def.name} is in the document`).toBe(true);
            const original = (top ? start : start.nodeAt(pos)!).attrs[attr] as unknown;
            const step = (value: unknown): Step =>
              top ? new DocAttrStep(attr, value) : new AttrStep(pos, attr, value);
            const found = await baseFor(what, attrDef, original, refs, (value) =>
              submit(adversary, [step(value)]),
            );
            let changed = found.sent;
            const edits = nestedEdits(attrDef.grammar, found.base);
            nested.places += edits.length;
            tally.positions += edits.length;
            for (const edit of edits) {
              for (const payload of PAYLOADS) {
                const acked = await attack([step(edit.value(payload))]);
                if (!acked) continue;
                changed = true;
                const now = await content();
                const node = top ? now : now.nodeAt(pos);
                expect(node?.type.name, what).toBe(def.name);
                const { got, want } = edit.stored(node?.attrs[attr], payload);
                expect(got, `${what}${edit.where} holds the exact string`).toEqual(want);
                if (URL_LIKE.test(attr) || (edit.member !== null && URL_LIKE.test(edit.member)))
                  expect(
                    ACTIVE_URL.test(payload),
                    `${what}${edit.where} stored an active URL: ${payload}`,
                  ).toBe(false);
                expectNoNewTypes(now);
              }
            }
            // The attribute gets its own value back, so the tests that follow meet the fixture.
            if (changed) {
              expect(await submit(adversary, [step(original)]), `${what} is put back`).toBe(true);
              const now = await content();
              expect((top ? now : now.nodeAt(pos))?.attrs[attr], what).toEqual(original);
            }
          }
          await benign();
        }
      },
      900_000,
    );

    run(
      'every place inside a structured attribute of every mark type: refused, or stored exactly',
      async () => {
        const start = await content();
        const refs = refsOf(start.toJSON() as Json);
        const carriers = carriersOf(start);
        for (const def of CDM1.marks) {
          const at = carriers.get(def.name)!;
          const type = schema.marks[def.name]!;
          const mine = await submittedAs(def.name, at);
          for (const [attr, attrDef] of structuredOf(def.attrs)) {
            const what = `mark ${def.name}.${attr}`;
            const original = mine[attr];
            const withValue = (value: unknown): Record<string, unknown> => ({
              ...mine,
              [attr]: value,
            });
            // A value is tried on a mark of its own, which is taken away again when accepted.
            const found = await baseFor(what, attrDef, original, refs, async (value) => {
              if (!(await submit(adversary, [addMark(at, def.name, withValue(value))])))
                return false;
              expect(await submit(adversary, undoMark(at, def.name, withValue(value)))).toBe(true);
              return true;
            });
            const edits = nestedEdits(attrDef.grammar, found.base);
            nested.places += edits.length;
            tally.positions += edits.length;
            for (const edit of edits) {
              for (const payload of PAYLOADS) {
                const attrs = withValue(edit.value(payload));
                const acked = await attack([addMark(at, def.name, attrs)]);
                if (!acked) continue;
                const now = await content();
                const stored = (now.nodeAt(at.from)?.marks ?? []).filter((m) => m.type === type);
                expect(
                  stored.some((m) => {
                    const { got, want } = edit.stored(m.attrs[attr], payload);
                    return same(got, want);
                  }),
                  `${what}${edit.where} holds the exact string`,
                ).toBe(true);
                if (URL_LIKE.test(attr) || (edit.member !== null && URL_LIKE.test(edit.member)))
                  expect(
                    ACTIVE_URL.test(payload),
                    `${what}${edit.where} stored an active URL: ${payload}`,
                  ).toBe(false);
                expectNoNewTypes(now);
                expect(await submit(adversary, undoMark(at, def.name, attrs))).toBe(true);
              }
            }
          }
          await benign();
        }
      },
      600_000,
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
          // Every textblock type of the schema is among them, a figure's caption included.
          const kinds = new Set(blocks.map((b) => b.type));
          for (const [name, type] of Object.entries(schema.nodes))
            if (type.isTextblock) expect(kinds.has(name), `a ${name} takes text`).toBe(true);
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
      // Every attribute that holds more than one value was attacked inside, on nodes and marks.
      const structured = [...CDM1.nodes, ...CDM1.marks].reduce(
        (n, def) => n + structuredOf(def.attrs).length,
        0,
      );
      expect(nested.attributes).toBe(structured);
      // Each was attacked in a value that holds every member its grammar declares, but the value
      // of a form field and its default: the service types them by the field's kind, and a text
      // field takes one string, which has nothing inside. No attribute was closed to commits.
      expect(nested.asHeld).toEqual([]);
      expect(nested.closed).toEqual([]);
      expect(nested.single).toEqual(['form_field.value', 'form_field.default']);
      console.info(
        `SEC-005 ${storage}: ${tally.positions} positions, ${tally.submitted} commits, ` +
          `${tally.refused} refused (${[...tally.codes].sort().join(', ')}), ${tally.inert} stored as inert text, ` +
          `${tally.noOp} acknowledged without effect, ${tally.rateLimited} waits for the rate limit`,
      );
      console.info(
        `SEC-005 ${storage}: inside structured attributes: ${nested.attributes} attributes, ` +
          `${nested.places} places; ${nested.filledOut} attacked in a value with every declared member; ` +
          `in the value they hold or the smallest valid one: ${nested.asHeld.join(', ') || 'none'}; ` +
          `one value with nothing inside: ${nested.single.join(', ') || 'none'}; ` +
          `no commit sets: ${nested.closed.join(', ') || 'none'}; ` +
          `welcome names the adversary ${welcomedAs === adversaryUser ? 'as the room does' : 'by the host sub, the room by its surrogate'}`,
      );
    });
  });
}
