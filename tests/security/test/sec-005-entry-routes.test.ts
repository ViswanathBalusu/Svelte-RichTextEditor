/**
 * SEC-005 criterion 4 (lane w8): the injection corpus through the other ways content enters a
 * document, against the real service over HTTP, on memory and on PostgreSQL (10 §3.1; 03 §8, I11):
 *
 * - `PUT /documents/{id}/content`: every attribute of every node type and mark type, and every
 *   textblock type, of the `all-constructs` fixture gets every payload, one replacement each;
 *   every place inside an attribute that holds more than one value gets every payload too (the
 *   members of an object, the items of an array, the values and names of free JSON, the parts of
 *   a preserved element tree; support/sec-005-nested.ts); and an attribute named `__proto__`,
 *   `constructor` or `prototype` is sent on every node type;
 * - prefill, `PATCH /documents/{id}/field-values`: every payload as the value of a field of every
 *   kind a prefill may set, and as a key;
 * - a Word import, `POST /documents/{id}/imports`, with the real importer of
 *   packages/export-docx: the payloads as text, as hyperlink targets (a relationship and a field
 *   code), as the author of a tracked change and as a bookmark name, and elements Word does not
 *   have, in the sample package. Each package goes through the job twice: as the service is
 *   built, and with the importer's assets attached to the document, which is the one step the
 *   import worker that is not built yet (EXP-099) will add;
 * - restore, `POST /documents/{id}/restore`, of the whole document and of one region, to a
 *   version that held the payloads.
 *
 * "The same results hold" as for commits (criterion 1, sec-005-every-position.test.ts): a payload
 * is refused with a code of the registry and the document is as it was, or it is stored as the
 * exact string, inert, in a document that is valid and holds no node type it did not hold; a
 * URL-like attribute never stores an active URL; `Object.prototype` of the service's process is
 * unchanged; and after each route a commit from a wire client is acknowledged, so the room keeps
 * serving others.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { CDM1, type AttrDef } from '@docedit/model/definition';
import { validate } from '@docedit/model/validate';
import {
  entryData,
  importDocx,
  readZip,
  writeZip,
  type ZipWriteEntry,
} from '../../../packages/export-docx/src/index.ts';
import { loadDoc, schema } from './support/cdm.ts';
import {
  documentWithRegions,
  insertText,
  postgresUnavailable,
  startHarness,
  type CallResult,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { PAYLOADS } from './support/payloads.ts';
import { FEATURES, placeWholeFixture, type Json } from './support/sec-005-fixture.ts';
import { chooseBase, isStructured, nestedEdits, refsOf } from './support/sec-005-nested.ts';
import { WireClient } from './support/wire.ts';

const URL_LIKE = /href|src|url|asset|fragment|target|link/i;
const ACTIVE_URL = /^\s*(javascript|data|vbscript):/i;
const PROTO_NAMES = ['__proto__', 'constructor', 'prototype'] as const;
/**
 * Members of an example value that are not free. A replacement by the service credential is a
 * commit of `system` (05 §3.2: no `DEP-Actor`), and a new suggestion names who submits it.
 */
const SERVICE_HINTS = { user: 'system' } as const;
const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const clone = <T>(value: T): T => structuredClone(value);

/** The node at a path of child indexes below `doc`. */
function nodeAt(doc: Json, path: readonly number[]): Json {
  let node = doc;
  for (const i of path) {
    const next = node.content?.[i];
    if (!next) throw new Error(`no node at ${path.join('/')}`);
    node = next;
  }
  return node;
}

/** Every node of the content with its path, in document order. */
function walk(doc: Json, visit: (node: Json, path: number[]) => void, path: number[] = []): void {
  visit(doc, path);
  (doc.content ?? []).forEach((child, i) => walk(child, visit, [...path, i]));
}

function typesOf(doc: Json): Set<string> {
  const out = new Set<string>();
  walk(doc, (n) => {
    if (n.type) out.add(n.type);
    for (const m of n.marks ?? []) out.add(`mark:${m.type}`);
  });
  return out;
}

/** An own property with the given name, the prototype chain's names included (`__proto__`). */
function own(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** The content of a document as the service stores it, with the tag a write must match. */
async function head(h: Harness, doc: string): Promise<{ doc: Json; etag: string; seq: number }> {
  const r = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey });
  expect(r.status, r.text).toBe(200);
  const body = r.json as { doc: Json; seq: number };
  return { doc: body.doc, etag: r.headers.get('etag') ?? '', seq: body.seq };
}

/** Sends a request again after the pause the service asks for, when it answers 429. */
async function patient(send: () => Promise<CallResult>): Promise<CallResult> {
  for (let tries = 0; ; tries += 1) {
    const r = await send();
    if (r.status !== 429) return r;
    expect(tries, 'the rate limit lets the request through in the end').toBeLessThan(200);
    await sleep(Math.max(5, Number(r.headers.get('retry-after') ?? 0) * 1000));
  }
}

/** A wire client that has opened `doc` as an editor, to show the room still serves others. */
async function roomServes(h: Harness, doc: string, features: string[] = []): Promise<void> {
  const now = await head(h, doc);
  const token = await h.mintToken(h.a, 'u-other', { [doc]: 'owner' });
  const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
  try {
    expect((await c.hello(token, features.length ? { features } : {})).t).toBe('welcome');
    const opened = await c.open(1, doc, features.length ? { features } : {});
    expect(opened.t, JSON.stringify(opened.d)).toBe('ch.opened');
    let at = -1;
    loadDoc(now.doc).descendants((n, p) => {
      if (at < 0 && n.type.name === 'paragraph') at = p + 1;
      return at < 0;
    });
    expect(at).toBeGreaterThan(0);
    const r = await c.submit(1, { id: uuid7(), base: now.seq, steps: [insertText(at, 'ok ')] });
    expect(r.t, `the room keeps serving another client: ${JSON.stringify(r.d)}`).toBe('sync.ack');
  } finally {
    c.terminate();
  }
}

const notPolluted = (): void => {
  expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
};

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  const run = skip ? it.skip : it;

  describe(`SEC-005 criterion 4: the corpus through PUT content (${storage})`, () => {
    let h: Harness;
    let doc: string;
    let envelope: Record<string, unknown>;
    let base: Json;
    let etag: string;
    let baseTypes: Set<string>;
    const tally = { positions: 0, puts: 0, refused: 0, stored: 0 };
    const codes = new Set<string>();

    /** The replacements the current document has stored. */
    let storedHere = 0;
    /**
     * Moves on to a new document that holds the whole fixture. A replacement costs more the more
     * replacements its document already holds (see the Notes of SEC-005 for the measurement), so
     * a test that stores thousands of them spreads them over documents.
     */
    const fresh = async (): Promise<void> => {
      const placed = await placeWholeFixture(h, 'u-adversary');
      doc = placed.doc;
      envelope = placed.envelope;
      base = placed.envelope.doc;
      etag = placed.etag;
      storedHere = 0;
    };

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
      await fresh();
      baseTypes = typesOf((await head(h, doc)).doc);
    }, 60_000);
    afterAll(async () => {
      await h?.close();
    });

    /**
     * Replaces the content with `changed`. A refusal must carry a code of the registry, and the
     * tag stays good for the next replacement, which proves the head did not move (a moved head
     * would answer 412). An accepted one gives the stored content. `attack` false: the
     * replacement carries no payload (it prepares a value), and is not counted.
     */
    const put = async (changed: Json, attack = true): Promise<Json | null> => {
      if (attack) tally.puts += 1;
      const r = await patient(() =>
        h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.a.apiKey,
          body: { ...envelope, doc: changed },
          headers: { 'If-Match': etag },
        }),
      );
      if (r.status === 204) {
        if (attack) tally.stored += 1;
        storedHere += 1;
        const now = await head(h, doc);
        etag = now.etag;
        for (const t of typesOf(now.doc))
          expect(baseTypes.has(t), `${t} was not in the document before`).toBe(true);
        return now.doc;
      }
      if (attack) tally.refused += 1;
      // The control plane's own check names the violations. A snapshot it passes can still be
      // refused by the room, which answers the code alone: `validation_failed`, or `forbidden`
      // for content only its author may write (a suggestion mark in another user's name).
      const code = (r.json as { code?: string } | undefined)?.code ?? '';
      codes.add(code);
      expect(['validation_failed', 'forbidden'], r.text).toContain(code);
      expect(r.status, r.text).toBe(code === 'forbidden' ? 403 : 400);
      return null;
    };

    run(
      'every attribute of every node type: refused, or stored as the exact inert string',
      async () => {
        // The first node of each type, and the top node, with every attribute its type declares.
        const first = new Map<string, number[]>();
        walk(base, (n, path) => {
          if (n.type && !first.has(n.type)) first.set(n.type, path);
        });
        expect(Object.keys(schema.nodes).filter((t) => t !== 'text' && !first.has(t))).toEqual([]);
        for (const [type, path] of first) {
          if (storedHere >= 40) await fresh();
          for (const attr of Object.keys(schema.nodes[type]?.spec.attrs ?? {})) {
            tally.positions += 1;
            for (const payload of PAYLOADS) {
              const changed = clone(base);
              const target = nodeAt(changed, path);
              target.attrs = { ...(target.attrs ?? {}), [attr]: payload };
              const stored = await put(changed);
              if (stored === null) continue;
              expect(nodeAt(stored, path).type, `${type}.${attr}`).toBe(type);
              expect(nodeAt(stored, path).attrs?.[attr], `${type}.${attr} holds the string`).toBe(
                payload,
              );
              if (URL_LIKE.test(attr))
                expect(ACTIVE_URL.test(payload), `${type}.${attr} stored ${payload}`).toBe(false);
            }
          }
        }
        expect(tally.positions).toBeGreaterThan(150);
      },
      900_000,
    );

    run(
      'every attribute of every mark type: refused, or stored as the exact inert string',
      async () => {
        // The first text that carries each mark type; the fixture has every one.
        const carriers = new Map<string, number[]>();
        walk(base, (n, path) => {
          for (const m of n.marks ?? []) if (!carriers.has(m.type)) carriers.set(m.type, path);
        });
        expect(Object.keys(schema.marks).filter((m) => !carriers.has(m))).toEqual([]);
        for (const [type, path] of carriers) {
          if (storedHere >= 40) await fresh();
          for (const attr of Object.keys(schema.marks[type]?.spec.attrs ?? {})) {
            tally.positions += 1;
            for (const payload of PAYLOADS) {
              const changed = clone(base);
              const mark = nodeAt(changed, path).marks!.find((m) => m.type === type)!;
              mark.attrs = { ...(mark.attrs ?? {}), [attr]: payload };
              const stored = await put(changed);
              if (stored === null) continue;
              const kept = nodeAt(stored, path).marks?.find((m) => m.type === type);
              expect(kept?.attrs?.[attr], `mark ${type}.${attr} holds the string`).toBe(payload);
              if (URL_LIKE.test(attr))
                expect(ACTIVE_URL.test(payload), `mark ${type}.${attr} stored ${payload}`).toBe(
                  false,
                );
            }
          }
        }
      },
      600_000,
    );

    run(
      'every textblock type: the payload is stored as text, or refused',
      async () => {
        const first = new Map<string, number[]>();
        walk(base, (n, path) => {
          if (n.type && schema.nodes[n.type]?.isTextblock && !first.has(n.type))
            first.set(n.type, path);
        });
        const textblocks = Object.values(schema.nodes).filter((t) => t.isTextblock);
        expect(textblocks.map((t) => t.name).filter((t) => !first.has(t))).toEqual([]);
        for (const [type, path] of first) {
          if (storedHere >= 40) await fresh();
          tally.positions += 1;
          for (const payload of PAYLOADS) {
            const changed = clone(base);
            const block = nodeAt(changed, path);
            block.content = [{ type: 'text', text: payload }, ...(block.content ?? [])];
            const stored = await put(changed);
            if (stored === null) continue;
            const kept = nodeAt(stored, path);
            expect(kept.type).toBe(type);
            // Adjoining text of the same marks is one node, so the block's text starts with it.
            const text = (kept.content ?? []).map((c) => c.text ?? '').join('');
            expect(text.startsWith(payload), `${type} holds the text`).toBe(true);
          }
        }
      },
      300_000,
    );

    run(
      'every place inside a structured attribute of every node type and mark type: refused, or stored exactly',
      async () => {
        // The places inside an attribute that holds more than one value (an object, an array,
        // free JSON, a preserved element tree), derived from the grammars of the definition as
        // for commits (support/sec-005-nested.ts). Each attribute is first given a value with
        // every declared member, which the service must take, so that a refusal is about the
        // payload. A replacement keeps the suggestions the document holds, with their users; a
        // new one names `system`, who submits it (SERVICE_HINTS).
        await fresh();
        let refs = refsOf(base);
        // On memory every place takes the whole corpus. On PostgreSQL it takes three payloads of
        // the twelve, a different three from one place to the next, so that every payload is
        // used at a quarter of the places: a value is checked before the storage is reached,
        // and a stored replacement costs far more there (with the whole corpus on PostgreSQL
        // too, this file ran for 854 s beside three other files, on the lane's test container).
        const payloadsAt = (place: number): readonly string[] =>
          storage === 'memory'
            ? PAYLOADS
            : [0, 4, 8].map((k) => PAYLOADS[(place + k) % PAYLOADS.length]!);
        const report = {
          attributes: 0,
          places: 0,
          full: 0,
          held: [] as string[],
          single: [] as string[],
          closed: [] as string[],
        };
        interface Holder {
          what: string;
          attr: string;
          def: AttrDef;
          /** The node, or the text that carries the mark. */
          path: number[];
          mark: string | null;
        }
        const holders: Holder[] = [];
        const ownOf = (attrs: Record<string, unknown> | undefined, name: string): unknown =>
          attrs && Object.hasOwn(attrs, name) ? attrs[name] : undefined;
        for (const def of CDM1.nodes) {
          if (def.name === 'text') continue;
          for (const [attr, attrDef] of Object.entries(def.attrs)) {
            if (!isStructured(attrDef.grammar)) continue;
            // The node of this type that holds a value for the attribute, or else the first one.
            let first = null as number[] | null;
            let held = null as number[] | null;
            walk(base, (n, path) => {
              if (n.type !== def.name) return;
              first ??= path;
              const value = ownOf(n.attrs, attr);
              if (held === null && value !== undefined && value !== null) held = path;
            });
            expect(first, `${def.name} is in the document`).not.toBeNull();
            holders.push({
              what: `${def.name}.${attr}`,
              attr,
              def: attrDef,
              path: (held ?? first)!,
              mark: null,
            });
          }
        }
        for (const def of CDM1.marks) {
          let carrier = null as number[] | null;
          walk(base, (n, path) => {
            if (carrier === null && (n.marks ?? []).some((m) => m.type === def.name))
              carrier = path;
          });
          expect(carrier, `a text carries ${def.name}`).not.toBeNull();
          for (const [attr, attrDef] of Object.entries(def.attrs))
            if (isStructured(attrDef.grammar))
              holders.push({
                what: `mark ${def.name}.${attr}`,
                attr,
                def: attrDef,
                path: carrier!,
                mark: def.name,
              });
        }

        for (const holder of holders) {
          // The paths hold in every copy of the fixture; the assets it names differ.
          if (storedHere >= 40) {
            await fresh();
            refs = refsOf(base);
          }
          /** The attributes of the node or the mark in a document. */
          const attrsIn = (content: Json): Record<string, unknown> | undefined => {
            const node = nodeAt(content, holder.path);
            return holder.mark === null
              ? node.attrs
              : node.marks?.find((m) => m.type === holder.mark)?.attrs;
          };
          // An attribute the stored form leaves out has its default (03 §2).
          const read = (content: Json): unknown => {
            const value = ownOf(attrsIn(content), holder.attr);
            return value === undefined ? holder.def.default : value;
          };
          const withValue = (value: unknown): Json => {
            const changed = clone(base);
            const node = nodeAt(changed, holder.path);
            const target =
              holder.mark === null ? node : node.marks!.find((m) => m.type === holder.mark)!;
            const attrs: Record<string, unknown> = { ...(target.attrs ?? {}) };
            own(attrs, holder.attr, value);
            target.attrs = attrs;
            return changed;
          };
          report.attributes += 1;
          const original = read(base);
          const found = await chooseBase(
            holder.def.grammar,
            original,
            refs,
            SERVICE_HINTS,
            async (value) => (await put(withValue(value), false)) !== null,
          );
          if (found?.how === 'full') report.full += 1;
          else if (found?.how === 'held') report.held.push(holder.what);
          else if (found?.how === 'single') report.single.push(holder.what);
          else report.closed.push(holder.what);
          const edits = nestedEdits(holder.def.grammar, found?.base ?? original ?? {});
          tally.positions += edits.length;
          for (const edit of edits) {
            report.places += 1;
            for (const payload of payloadsAt(report.places)) {
              const stored = await put(withValue(edit.value(payload)));
              notPolluted();
              if (stored === null) continue;
              const { got, want } = edit.stored(read(stored), payload);
              expect(got, `${holder.what}${edit.where} holds the exact string`).toEqual(want);
              if (
                URL_LIKE.test(holder.attr) ||
                (edit.member !== null && URL_LIKE.test(edit.member))
              )
                expect(
                  ACTIVE_URL.test(payload),
                  `${holder.what}${edit.where} stored ${payload}`,
                ).toBe(false);
            }
          }
        }
        // Every attribute that holds more than one value was attacked inside.
        const structured = [...CDM1.nodes, ...CDM1.marks].reduce(
          (n, def) => n + Object.values(def.attrs).filter((a) => isStructured(a.grammar)).length,
          0,
        );
        expect(report.attributes).toBe(structured);
        // Each was attacked in a value that holds every member its grammar declares, but the
        // value of a form field and its default, which for a text field are one string.
        expect(report.closed, 'no attribute refuses every value').toEqual([]);
        expect(report.held).toEqual([]);
        expect(report.single).toEqual(['form_field.value', 'form_field.default']);
        console.info(
          `SEC-005 ${storage}: PUT inside structured attributes: ${report.attributes} attributes, ` +
            `${report.places} places; ${report.full} attacked in a value with every declared member; ` +
            `in the value they hold or the smallest valid one: ${report.held.join(', ') || 'none'}; ` +
            `one value with nothing inside: ${report.single.join(', ') || 'none'}`,
        );
      },
      900_000,
    );

    run(
      'an attribute named for the prototype chain is refused, or dropped, on every node type',
      async () => {
        const first = new Map<string, number[]>();
        walk(base, (n, path) => {
          if (n.type && n.type !== 'text' && !first.has(n.type)) first.set(n.type, path);
        });
        let dropped = 0;
        for (const [type, path] of first) {
          tally.positions += 1;
          for (const name of PROTO_NAMES) {
            const changed = clone(base);
            const target = nodeAt(changed, path);
            target.attrs = { ...(target.attrs ?? {}) };
            own(target.attrs, name, { polluted: true });
            expect(JSON.stringify(changed)).toContain(`"${name}":{"polluted":true}`);
            const stored = await put(changed);
            notPolluted();
            if (stored === null) continue;
            // Accepted: then the attribute is not in what was stored.
            dropped += 1;
            const kept = nodeAt(stored, path);
            expect(kept.type).toBe(type);
            expect(Object.prototype.hasOwnProperty.call(kept.attrs ?? {}, name), name).toBe(false);
            expect(JSON.stringify(stored)).not.toContain('polluted');
          }
        }
        console.info(
          `SEC-005 ${storage}: PUT with a prototype-chain attribute name: ${dropped} dropped`,
        );
      },
      300_000,
    );

    run(
      'the corpus was refused or stored inert at every position, and the room serves on',
      async () => {
        expect(tally.refused + tally.stored).toBe(tally.puts);
        expect(tally.stored, 'some payloads are stored as inert text').toBeGreaterThan(0);
        expect(tally.refused, 'some payloads are refused by the grammars').toBeGreaterThan(0);
        // The stored document is valid CDM, and a wire client still gets its commit acknowledged.
        const now = await head(h, doc);
        // (I4 apart: the validator is not told here which assets the document has.)
        expect(
          validate({ ...envelope, doc: now.doc } as never).violations.filter(
            (v) => v.invariant !== 'I4',
          ),
        ).toEqual([]);
        await roomServes(h, doc, FEATURES);
        notPolluted();
        console.info(
          `SEC-005 ${storage}: PUT content: ${tally.positions} positions, ${tally.puts} replacements, ` +
            `${tally.refused} refused (${[...codes].sort().join(', ')}), ${tally.stored} stored as inert text`,
        );
      },
    );
  });

  describe(`SEC-005 criterion 4: the corpus through prefill (${storage})`, () => {
    let h: Harness;
    let doc: string;
    const KINDS = ['text', 'number', 'date', 'checkbox', 'choice'] as const;
    const idOf = (kind: string): string => `fPre${kind.padEnd(12, '0')}`.slice(0, 16);
    const tally = { values: 0, stored: 0, refused: 0 };

    /** A document with one field of each kind a prefill may set, and one the server alone sets. */
    const fieldsDocument = (): Record<string, unknown> => {
      const envelope = documentWithRegions() as {
        requires: string[];
        doc: { content: Array<{ content: unknown[] }> };
      };
      envelope.requires = ['fields'];
      const field = (kind: string, extra: Record<string, unknown> = {}): unknown => ({
        type: 'form_field',
        attrs: { id: idOf(kind), key: `k.${kind}`, kind, label: kind, value: null, ...extra },
      });
      envelope.doc.content[1]!.content.push({
        type: 'paragraph',
        attrs: { id: 'pFields000000001', style: 'Normal' },
        content: [
          field('text'),
          field('number'),
          field('date'),
          field('checkbox'),
          field('choice', { options: [{ id: 'opt_a', label: 'A' }] }),
          field('formula'),
        ],
      });
      return envelope;
    };

    const values = async (): Promise<{ values: Record<string, unknown>; etag: string }> => {
      const r = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: h.a.apiKey });
      expect(r.status, r.text).toBe(200);
      return {
        values: (r.json as { values: Record<string, unknown> }).values,
        etag: r.headers.get('etag') ?? '',
      };
    };
    const prefill = async (body: unknown, etag: string): Promise<CallResult> =>
      patient(() =>
        h.call('PATCH', `/v1/documents/${doc}/field-values`, {
          token: h.a.apiKey,
          body,
          headers: { 'If-Match': etag },
        }),
      );

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
      doc = await h.createDocument(h.a, fieldsDocument());
    }, 60_000);
    afterAll(async () => {
      await h?.close();
    });

    run(
      'every payload as the value of every kind: stored as the exact string in a text field, refused elsewhere',
      async () => {
        for (const kind of [...KINDS, 'formula']) {
          for (const payload of PAYLOADS) {
            tally.values += 1;
            const before = await values();
            const r = await prefill({ values: { [`k.${kind}`]: payload } }, before.etag);
            if (r.status === 200) {
              tally.stored += 1;
              expect(kind, `a ${kind} field took a string`).toBe('text');
              const after = await values();
              expect(after.values[`k.${kind}`]).toBe(payload);
              // The same string is in the content, as the field's value and nowhere as markup.
              const now = await head(h, doc);
              let seen = false;
              walk(now.doc, (n) => {
                if (n.type === 'form_field' && n.attrs?.['key'] === `k.${kind}`) {
                  seen = true;
                  expect(n.attrs['value']).toBe(payload);
                }
              });
              expect(seen).toBe(true);
              expect(typesOf(now.doc).has('form_field')).toBe(true);
            } else {
              tally.refused += 1;
              expect(r.status, r.text).toBeGreaterThanOrEqual(400);
              expect(r.status).toBeLessThan(500);
              expect((r.json as { code: string }).code, r.text).toBe('field_invalid');
              // Nothing was applied: the values are as they were.
              expect((await values()).values).toEqual(before.values);
            }
          }
        }
        // A text field takes every payload as text; number, date, checkbox, choice and formula none.
        expect(tally.stored).toBe(PAYLOADS.length);
        expect(tally.refused).toBe(PAYLOADS.length * 5);
      },
      300_000,
    );

    run(
      'a payload, or a name of the prototype chain, as a key is refused and applies nothing',
      async () => {
        for (const key of [...PAYLOADS, ...PROTO_NAMES]) {
          const before = await values();
          const body: Record<string, unknown> = {};
          own(body, key, 'x');
          // With a good key beside it: the prefill is atomic, so the good one is not applied either.
          own(body, 'k.text', 'must not be stored');
          const r = await prefill({ values: body }, before.etag);
          expect(r.status, `${key}: ${r.text}`).toBeGreaterThanOrEqual(400);
          expect(r.status).toBeLessThan(500);
          expect((r.json as { code: string }).code, r.text).toBe('field_invalid');
          expect((await values()).values).toEqual(before.values);
          notPolluted();
        }
      },
    );

    run('the room serves another client afterwards', async () => {
      await roomServes(h, doc, ['fields']);
      console.info(
        `SEC-005 ${storage}: prefill: ${tally.values} values, ${tally.stored} stored as inert text, ` +
          `${tally.refused} refused (field_invalid)`,
      );
    });
  });

  describe(`SEC-005 criterion 4: the corpus through restore (${storage})`, () => {
    let h: Harness;
    afterAll(async () => {
      await h?.close();
    });

    const OPEN = 'rOpen00000000001';
    const regionOf = (d: Json): Json =>
      d.content![1]!.content!.find((n) => n.attrs?.['id'] === OPEN)!;

    /** The regions fixture whose open region has `title` and one paragraph for each payload. */
    const laden = (title: string): { cdm: number; requires: string[]; doc: Json } => {
      const envelope = documentWithRegions() as { cdm: number; requires: string[]; doc: Json };
      const region = regionOf(envelope.doc);
      region.attrs = { ...region.attrs, title };
      region.content = PAYLOADS.map((payload, i) => ({
        type: 'paragraph',
        attrs: { id: `pLaden${String(i).padStart(10, '0')}`, style: 'Normal' },
        content: [{ type: 'text', text: payload }],
      }));
      return envelope;
    };

    run(
      'a whole-document restore and a region restore bring the payloads back as the same inert text',
      async () => {
        h = await startHarness(storage);
        const doc = await h.createDocument(h.a, documentWithRegions());
        const replace = async (content: unknown): Promise<number> => {
          const now = await head(h, doc);
          const r = await patient(() =>
            h.call('PUT', `/v1/documents/${doc}/content`, {
              token: h.a.apiKey,
              body: content,
              headers: { 'If-Match': now.etag },
            }),
          );
          expect(r.status, r.text).toBe(204);
          return (await head(h, doc)).seq;
        };
        // Every payload is text; a title takes those the grammar of `region.title` accepts.
        const titles: string[] = [];
        for (const payload of PAYLOADS) {
          const probe = documentWithRegions() as { doc: Json };
          regionOf(probe.doc).attrs!['title'] = payload;
          const now = await head(h, doc);
          const r = await patient(() =>
            h.call('PUT', `/v1/documents/${doc}/content`, {
              token: h.a.apiKey,
              body: probe,
              headers: { 'If-Match': now.etag },
            }),
          );
          if (r.status === 204) titles.push(payload);
          else expect((r.json as { code: string }).code).toBe('validation_failed');
        }
        expect(titles.length).toBeGreaterThan(0);

        const ladenSeq = await replace(laden(titles[0]!));
        const ladenDoc = (await head(h, doc)).doc;
        for (const payload of PAYLOADS)
          expect(JSON.stringify(ladenDoc)).toContain(JSON.stringify(payload).slice(1, -1));
        const cleanSeq = await replace(documentWithRegions());
        expect(cleanSeq).toBeGreaterThan(ladenSeq);
        for (const payload of PAYLOADS.filter((p) => p.length > 9))
          expect(JSON.stringify((await head(h, doc)).doc)).not.toContain(
            JSON.stringify(payload).slice(1, -1),
          );

        // One region, by an owner: the region is as it was at the laden version.
        const owner = await h.mintToken(h.a, 'olga', { [doc]: 'owner' });
        const part = await patient(() =>
          h.call('POST', `/v1/documents/${doc}/restore`, {
            token: owner,
            body: { toSeq: ladenSeq, region: OPEN },
          }),
        );
        expect(part.status, part.text).toBe(200);
        const afterPart = (await head(h, doc)).doc;
        // A region restore brings back the region's content; its title is the region's own
        // attribute and stays as it is now. The whole-document restore below brings the title.
        expect((regionOf(afterPart).content ?? []).map((p) => p.content?.[0]?.text)).toEqual([
          ...PAYLOADS,
        ]);
        // Outside the region nothing came back.
        expect(JSON.stringify(afterPart.content![1]!.content![0])).toContain('Hello');

        // The whole document, by the service: the content is that of the laden version.
        await replace(documentWithRegions());
        const whole = await patient(() =>
          h.call('POST', `/v1/documents/${doc}/restore`, {
            token: h.a.apiKey,
            body: { toSeq: ladenSeq },
          }),
        );
        expect(whole.status, whole.text).toBe(200);
        const restored = (await head(h, doc)).doc;
        expect(restored).toEqual(ladenDoc);
        expect(typesOf(restored)).toEqual(typesOf(ladenDoc));
        expect(validate({ cdm: 1, requires: [], doc: restored } as never).violations).toEqual([]);
        await roomServes(h, doc);
        notPolluted();
        console.info(
          `SEC-005 ${storage}: restore: ${PAYLOADS.length} payloads as text and ${titles.length} of them accepted as a region title, back as the same strings`,
        );
      },
      300_000,
    );
  });
}

// --- Word import -------------------------------------------------------------------------------

const SAMPLE = fileURLToPath(
  new URL('../../../packages/export-docx/corpus/poi/sample.docx', import.meta.url),
);
const DOC_RELS = 'word/_rels/document.xml.rels';
const HYPERLINK_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

const xml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** The sample package with each part passed through `edit`; undefined keeps the part as it is. */
function rebuild(edit: (name: string, text: string) => string | undefined): Uint8Array {
  const zip = readZip(new Uint8Array(readFileSync(SAMPLE)));
  const entries: ZipWriteEntry[] = zip.entries.map((e) => {
    const next = edit(e.name, new TextDecoder().decode(entryData(zip, e)));
    if (next === undefined) return { name: e.name, copyOf: e, from: zip };
    return { name: e.name, data: new TextEncoder().encode(next), like: e };
  });
  return writeZip(entries);
}

/** Puts `snippet` first in the body of the main part. */
function afterBodyStart(text: string, snippet: string): string {
  const next = text.replace(/<w:body(\s[^>]*)?>/, (open) => open + snippet);
  if (next === text) throw new Error('the sample has no w:body');
  return next;
}

function replaceIn(text: string, needle: string, with_: string): string {
  const next = text.replace(needle, with_);
  if (next === text) throw new Error(`the sample does not contain ${needle}`);
  return next;
}

const para = (inner: string): string => `<w:p>${inner}</w:p>`;
const runOf = (text: string): string => `<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;

/** The hostile packages: what each adds to the sample. */
interface ImportCase {
  /** What the package adds first in the body of the sample. */
  body: string;
  /** What it adds to the relationships of the main part. */
  rels?: string;
  /** A text of the added content, to see that the import took it. */
  marker: string;
  /** How many preserved atoms the importer makes of the added content; absent: it is text. */
  preserved?: number | 'some';
}

const IMPORT_CASES: Record<string, ImportCase> = {
  'the payloads as text': {
    marker: 'IMPORT-TEXT',
    body: PAYLOADS.map((p, i) => para(runOf(`IMPORT-TEXT-${i} ${p}`))).join(''),
  },
  'the payloads as the targets of hyperlink relationships': {
    marker: 'IMPORT-LINK',
    preserved: PAYLOADS.length,
    body: PAYLOADS.map((_, i) =>
      para(`<w:hyperlink r:id="rIdSec${i}">${runOf(`IMPORT-LINK-${i}`)}</w:hyperlink>`),
    ).join(''),
    rels: PAYLOADS.map(
      (p, i) =>
        `<Relationship Id="rIdSec${i}" Type="${HYPERLINK_TYPE}" Target="${xml(p)}" TargetMode="External"/>`,
    ).join(''),
  },
  'the payloads as the targets of hyperlink field codes': {
    marker: 'IMPORT-FIELD',
    preserved: PAYLOADS.length,
    body: PAYLOADS.map((p, i) =>
      para(
        `<w:fldSimple w:instr="${xml(` HYPERLINK "${p.replaceAll('"', '')}" `)}">${runOf(`IMPORT-FIELD-${i}`)}</w:fldSimple>`,
      ),
    ).join(''),
  },
  'the payloads as the author of a tracked insertion': {
    marker: 'IMPORT-AUTHOR',
    body: PAYLOADS.map((p, i) =>
      para(
        `<w:ins w:id="${9000 + i}" w:author="${xml(p)}" w:date="2026-11-20T10:00:00Z">${runOf(`IMPORT-AUTHOR-${i}`)}</w:ins>`,
      ),
    ).join(''),
  },
  'the payloads as bookmark names': {
    marker: 'IMPORT-MARK',
    body: PAYLOADS.map((p, i) =>
      para(
        `<w:bookmarkStart w:id="${9100 + i}" w:name="${xml(p)}"/>${runOf(`IMPORT-MARK-${i}`)}<w:bookmarkEnd w:id="${9100 + i}"/>`,
      ),
    ).join(''),
  },
  'elements Word does not have, with script, in the body': {
    marker: 'IMPORT-ALIEN',
    preserved: 'some',
    body:
      para(runOf('IMPORT-ALIEN-0')) +
      '<script xmlns="http://www.w3.org/1999/xhtml">window.__pwned = 1</script>' +
      para(
        `${runOf('IMPORT-ALIEN-1')}<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>`,
      ),
  },
};

function hostilePackage(name: string): Uint8Array {
  const c = IMPORT_CASES[name]!;
  return rebuild((part, text) => {
    if (part === 'word/document.xml') return afterBodyStart(text, c.body);
    if (part === DOC_RELS && c.rels)
      return replaceIn(text, '</Relationships>', `${c.rels}</Relationships>`);
    return undefined;
  });
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  const run = skip ? it.skip : it;

  describe(`SEC-005 criterion 4: the corpus through a Word import (${storage})`, () => {
    let h: Harness;
    const outcomes: string[] = [];
    /** What the import of the sample itself holds, to tell what a hostile package added. */
    const plain = { preserved: 0, links: 0 };
    /** The document the importer's assets are attached to while a job runs; null: to none. */
    let attachTo: string | null = null;
    /** Records an asset of a document as the asset worker leaves an accepted upload: ready. */
    const ready = async (doc: string, id: string, mime: string, sha256: string): Promise<void> => {
      await h.parts.assetRegistry.create(
        h.a.id,
        {
          id,
          doc,
          filename: 'imported',
          mime,
          declaredBytes: 1,
          createdBy: 'system',
          uploadExpiresAt: Date.now() + 60_000,
        },
        Date.now(),
      );
      await h.parts.assetRegistry.settleReady(
        h.a.id,
        id,
        {
          sha256,
          bytes: 1,
          contentType: mime,
          objectKey: `test/${id}`,
          width: null,
          height: null,
          frames: null,
          renditions: [],
        },
        Date.now(),
      );
    };

    beforeAll(async () => {
      if (skip) return;
      const sample = (await importDocx(new Uint8Array(readFileSync(SAMPLE)))).envelope.doc as Json;
      walk(sample, (n) => {
        if (n.type === 'preserved_inline' || n.type === 'preserved_block') plain.preserved += 1;
        plain.links += (n.marks ?? []).filter((m) => m.type === 'link').length;
      });
      h = await startHarness(storage, {
        importer: async (bytes) => {
          const r = await importDocx(bytes);
          // See `importInto`: the importer's own assets, attached to the document.
          if (attachTo !== null)
            for (const a of r.assets.all()) await ready(attachTo, a.id, a.contentType, a.sha256);
          return { envelope: r.envelope, warnings: r.warnings };
        },
        env: { DOCEDIT_JOB_IDLE_MS: '20' },
      });
    }, 60_000);
    afterAll(async () => {
      await h?.close();
    });

    /**
     * Imports `bytes` into a new document through the route and the job; gives the job and the
     * content. The service as it is built stores none of the assets the importer makes (the
     * fragments of preserved content, the pictures): the sandboxed import worker that will is
     * not built (EXP-099), so a package that needs one is refused for I4. `attach` stands in for
     * that one step and no other: the importer's assets are recorded as ready assets of the
     * document, and the job then decides about the content itself.
     */
    const importInto = async (
      bytes: Uint8Array,
      attach = false,
    ): Promise<{ doc: string; job: Record<string, unknown>; before: Json; after: Json }> => {
      const probe = await importDocx(bytes).catch(() => null);
      const doc = await h.createDocument(h.a, {
        ...documentWithRegions(),
        requires: probe ? probe.envelope.requires : ['preserve'],
      });
      attachTo = attach ? doc : null;
      const before = (await head(h, doc)).doc;
      const asset = uuid7();
      const sha = await h.service.assets.putFinal(h.a.id, bytes, DOCX_CONTENT_TYPE);
      await h.parts.assetRegistry.create(
        h.a.id,
        {
          id: asset,
          doc,
          filename: 'hostile.docx',
          mime: DOCX_CONTENT_TYPE,
          declaredBytes: bytes.length,
          createdBy: 'system',
          uploadExpiresAt: Date.now() + 60_000,
        },
        Date.now(),
      );
      await h.parts.assetRegistry.settleReady(
        h.a.id,
        asset,
        {
          sha256: sha,
          bytes: bytes.length,
          contentType: DOCX_CONTENT_TYPE,
          objectKey: `test/${asset}`,
          width: null,
          height: null,
          frames: null,
          renditions: [],
        },
        Date.now(),
      );
      const accepted = await h.call('POST', `/v1/documents/${doc}/imports`, {
        token: h.a.apiKey,
        body: { asset, format: 'docx' },
      });
      expect(accepted.status, accepted.text).toBe(202);
      let job: Record<string, unknown> = {};
      for (let i = 0; i < 1200 && job['state'] !== 'completed' && job['state'] !== 'failed'; i++) {
        job = (
          await h.call('GET', `/v1/imports/${(accepted.json as { id: string }).id}`, {
            token: h.a.apiKey,
          })
        ).json as Record<string, unknown>;
        await sleep(25);
      }
      attachTo = null;
      return { doc, job, before, after: (await head(h, doc)).doc };
    };

    run('control: the sample itself is imported through the job', async () => {
      const { job, before, after } = await importInto(new Uint8Array(readFileSync(SAMPLE)));
      expect(job['error'] ?? null).toBeNull();
      expect(job['state']).toBe('completed');
      expect(after).not.toEqual(before);
    });

    /**
     * What an imported document may hold: node and mark types of the schema only, no attribute
     * named like an event handler, no active URL in a URL-like attribute, and links that point
     * only where the grammar allows (I9).
     */
    const expectInert = (content: Json, what: string): void => {
      const known = new Set([
        ...Object.keys(schema.nodes),
        ...Object.keys(schema.marks).map((m) => `mark:${m}`),
      ]);
      for (const t of typesOf(content)) expect(known.has(t), `${what}: ${t}`).toBe(true);
      expect(() => loadDoc(content), what).not.toThrow();
      walk(content, (n) => {
        for (const holder of [n, ...(n.marks ?? [])])
          for (const [attr, value] of Object.entries(holder.attrs ?? {})) {
            expect(/^on[a-z]/i.test(attr), `${what}: attribute ${attr}`).toBe(false);
            if (typeof value === 'string' && URL_LIKE.test(attr))
              expect(ACTIVE_URL.test(value), `${what}: ${holder.type}.${attr} = ${value}`).toBe(
                false,
              );
          }
        for (const m of n.marks ?? [])
          if (m.type === 'link')
            expect(String(m.attrs?.['href']), what).toMatch(/^(https?:|mailto:|#)/i);
      });
    };
    const textOf = (content: Json): string => {
      let text = '';
      walk(content, (n) => {
        if (n.type === 'text') text += `${n.text ?? ''}\n`;
      });
      return text;
    };

    for (const name of Object.keys(IMPORT_CASES)) {
      run(
        `${name}: refused, or imported as inert text with no active URL`,
        async () => {
          const c = IMPORT_CASES[name]!;
          const bytes = hostilePackage(name);
          // What the importer itself makes of the package, whatever the job then does with it.
          // The importer models text and tracked changes; a hyperlink, a field code and an
          // element Word does not have are kept as preserved content (ADR 0017): an atom with a
          // label and at most a fallback text, whose original bytes are a fragment asset that is
          // never parsed or drawn. So no link mark, and no node of the alien element, is made.
          const made = (await importDocx(bytes)).envelope.doc as Json;
          expectInert(made, 'the importer');
          let preserved = 0;
          let links = 0;
          walk(made, (n) => {
            if (n.type === 'preserved_inline' || n.type === 'preserved_block') preserved += 1;
            links += (n.marks ?? []).filter((m) => m.type === 'link').length;
          });
          const kept = `${preserved - plain.preserved} preserved, ${links - plain.links} links`;
          if (c.preserved !== undefined) {
            if (c.preserved === 'some') expect(preserved).toBeGreaterThan(plain.preserved);
            else expect(preserved - plain.preserved, `${name}: preserved`).toBe(c.preserved);
            expect(links - plain.links, `${name}: no link mark is made`).toBe(0);
          } else {
            expect(textOf(made), 'the importer read the text').toContain(c.marker);
          }
          if (name === 'the payloads as text')
            for (const payload of PAYLOADS) expect(textOf(made)).toContain(payload);
          // The script of an alien element is no text of the document.
          if (name.startsWith('elements Word does not have'))
            expect(textOf(made)).not.toContain('__pwned');

          // The same package through the route and the job: as the service is built, and then
          // with the importer's assets attached to the document (see `importInto`).
          const said: string[] = [];
          for (const attach of [false, true]) {
            const { doc, job, before, after } = await importInto(bytes, attach);
            notPolluted();
            if (job['state'] === 'failed') {
              // Refused: a code of the registry, and the document is as it was.
              const error = job['error'] as { code?: string; message?: string } | undefined;
              said.push(`${attach ? 'with its assets attached, ' : ''}refused (${error?.code})`);
              expect(['validation_failed', 'invalid_op', 'too_large']).toContain(error?.code);
              // Without its assets a package is refused for them alone (I4), not for a payload.
              if (!attach) expect(error?.message, name).toContain('(I4)');
              expect(after).toEqual(before);
              continue;
            }
            expect(job['state'], JSON.stringify(job)).toBe('completed');
            said.push(`${attach ? 'with its assets attached, ' : ''}imported`);
            expectInert(after, 'the stored document');
            let stored = 0;
            walk(after, (n) => {
              if (n.type === 'preserved_inline' || n.type === 'preserved_block') stored += 1;
            });
            // What was stored is what the importer made: the same preserved atoms, the same text.
            expect(stored, `${name}: preserved atoms stored`).toBe(preserved);
            if (c.preserved === undefined)
              expect(textOf(after), 'the import replaced the content').toContain(c.marker);
            if (name === 'the payloads as text')
              for (const payload of PAYLOADS) expect(textOf(after)).toContain(payload);
            if (name.startsWith('elements Word does not have')) {
              // The source of the alien script is kept in one place: the fallback text of the
              // preserved block that stands for the element. It is a string of an atom, never a
              // text of the document and never a node; the element itself is in the fragment.
              let keptIn = 0;
              walk(after, (n) => {
                if (n.type === 'text') expect(n.text).not.toContain('__pwned');
                if (!JSON.stringify(n.attrs ?? {}).includes('__pwned')) return;
                keptIn += 1;
                expect(n.type).toBe('preserved_block');
                expect(n.attrs?.['fallbackText']).toBe('window.__pwned = 1');
                expect(JSON.stringify({ ...n.attrs, fallbackText: null })).not.toContain('__pwned');
              });
              expect(keptIn).toBe(1);
            }
            await roomServes(h, doc, ['preserve', 'extensions', 'fields', 'regions', 'presence']);
          }
          // With its assets attached every package is imported: then nothing was refused only
          // because an asset was missing, and what the stored document holds was checked above.
          expect(said[1], name).toBe('with its assets attached, imported');
          outcomes.push(`${name}: importer ${kept}; ${said.join('; ')}`);
        },
        180_000,
      );
    }

    run('reports what each package did', () => {
      expect(outcomes.length).toBe(Object.keys(IMPORT_CASES).length);
      console.info(`SEC-005 ${storage}: import: ${outcomes.join('; ')}`);
    });
  });
}
