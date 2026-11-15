/**
 * SEC-027 criterion 3 — for each attribute of the schema, a commit that sets a value outside its
 * grammar (type, range, length, pattern) is refused (I11; 03 §8).
 *
 * The attributes are not listed here. They are read from the CDM definition (`CDM1`,
 * `@docedit/model/definition`), which is what the schema, the JSON Schema and the validator are
 * generated from. For each attribute of each node type and mark the suite derives values that break
 * its grammar, one per kind of problem the grammar can have, and sends each as one commit to a Room
 * (the authority the service hosts):
 *
 * - a node attribute by an `attr` step on the first node of that type in the base document;
 * - a mark attribute by an `addMark` step that puts the mark, with that one value wrong, on text.
 *
 * The base is the kitchen-sink fixture of the model with the four node types it lacks added
 * (`source_def`, `preserved_def`, `citation`, `bibliography`), so that every node type of the
 * definition is in it. The suite first shows that the base is valid: a harmless commit is accepted.
 *
 * Each commit must be answered `sync.reject` with `invalid_op` (`field_invalid` for a form field's
 * value), write nothing and leave the document unchanged, and the reason must point at the
 * attribute. The invariant the reason names is I11, or the one the definition assigns to that kind
 * of problem (`reportAs`: I7 for the length of `latex`, I9 for a link, I12 for an extension's
 * envelope, and so on). Two classes are refused by an earlier check and are asserted as such:
 * a change of `id` is refused as an I2 transition, and a wrong value on an attribute of the `doc`
 * node cannot be sent at all, because only `docAttr` addresses it and that step type is not allowed
 * (criterion 1).
 *
 * Node.js only (vitest). No network.
 */
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '@docedit/authority';
import {
  CDM1,
  attrsOf,
  type AttrDef,
  type Grammar,
  type GrammarProblemKind,
} from '@docedit/model/definition';
import { cdmSchema } from '@docedit/model/prosemirror';
import { Room } from '../../../packages/authority/src/room/room.ts';
import type { Effects, ToClient } from '../../../packages/authority/src/room/types.ts';
import { USERS, basePermissions } from '../../../packages/authority/test/fixtures.ts';
import { baseOf, readCase, type Json } from './support/invariant-corpus.ts';

const schema = cdmSchema();
const CONTEXT = readCase('i2-duplicate-id')['context'] as Json; // the corpus's shared context

/** The kitchen sink plus the node types it lacks, so that every node type has an instance. */
function everythingBase(): Json {
  const base = baseOf('kitchen-sink');
  const [defs, , , body] = base['doc']['content'] as [Json, Json, Json, Json];
  (defs['content'] as Json[]).push(
    { type: 'source_def', attrs: { id: 'smith2026', kind: 'book', title: 'A book' } },
    {
      type: 'preserved_def',
      attrs: { id: 'pdKeepLines01', tree: { children: [{ name: 'w:keepLines' }] } },
    },
  );
  (body['content'] as Json[]).push(
    {
      type: 'paragraph',
      attrs: { id: 'pCitation0000001' },
      content: [
        { type: 'text', text: 'As shown ' },
        { type: 'citation', attrs: { items: [{ source: 'smith2026' }] } },
      ],
    },
    { type: 'bibliography', attrs: { id: 'bibMain000000001' } },
  );
  return base;
}

interface Violation {
  kind: GrammarProblemKind;
  value: unknown;
}

/** A string of `length` that the pattern refuses, or null when none of the candidates does. */
function outsidePattern(pattern: string, length: number): string | null {
  const re = new RegExp(pattern);
  for (const ch of [' ', '<', '!', '\\', '{', '"', '/', 'é', '0', 'Z', 'z'])
    for (const len of [Math.max(1, Math.min(length, 3)), 1, 2]) {
      const s = ch.repeat(len);
      if (!re.test(s)) return s;
    }
  return null;
}

/** Values that break `g`, one for each kind of problem this grammar can have. */
function violations(g: Grammar): Violation[] {
  const out: Violation[] = [];
  if (!g.nullable) out.push({ kind: 'null', value: null });
  switch (g.kind) {
    case 'string': {
      out.push({ kind: 'type', value: 7 });
      out.push({ kind: 'length', value: 'x'.repeat(g.maxLength + 1) });
      if ((g.minLength ?? 0) > 0) out.push({ kind: 'length', value: '' });
      if (g.pattern !== undefined) {
        const s = outsidePattern(g.pattern, g.maxLength);
        if (s === null) throw new Error(`no candidate outside the pattern ${g.pattern}`);
        out.push({ kind: 'pattern', value: s });
      }
      break;
    }
    case 'integer':
      out.push({ kind: 'type', value: 'seven' });
      out.push({ kind: 'range', value: g.max + 1 });
      out.push({ kind: 'range', value: g.min - 1 });
      out.push({ kind: 'range', value: g.min + 0.5 });
      break;
    case 'boolean':
      out.push({ kind: 'type', value: 'yes' });
      break;
    case 'enum':
      out.push({ kind: 'type', value: 7 });
      out.push({ kind: 'enum', value: 'not-a-value-of-this-enumeration' });
      break;
    case 'ref':
      out.push({ kind: 'type', value: 7 });
      break;
    case 'object':
      out.push({ kind: 'type', value: 'not an object' });
      out.push({ kind: 'member', value: { notDeclared: 1 } });
      break;
    case 'array':
      out.push({ kind: 'type', value: 'not an array' });
      break;
    case 'json':
      if (g.objectOnly) out.push({ kind: 'type', value: 'not an object' });
      out.push({ kind: 'size', value: { big: 'x'.repeat(g.maxBytes) } });
      break;
    case 'elementTree':
      out.push({ kind: 'type', value: 'not a tree' });
      out.push({
        kind: 'size',
        value: { children: [{ name: 'w:t', text: 'x'.repeat(g.maxBytes) }] },
      });
      break;
  }
  return out;
}

interface GrammarCase {
  title: string;
  owner: string;
  attr: string;
  def: AttrDef;
  kind: GrammarProblemKind;
  /** The step in step JSON (`pm-steps/1`), as a hostile client would write it. */
  step: (doc: Node) => Json;
}

function firstOf(doc: Node, type: string): number {
  let found = -1;
  doc.descendants((x, pos) => {
    if (found < 0 && x.type.name === type) found = pos;
    return found < 0;
  });
  return found;
}

const show = (v: unknown) => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
};

function grammarCases(): GrammarCase[] {
  const out: GrammarCase[] = [];
  for (const nodeDef of CDM1.nodes) {
    if (nodeDef.name === CDM1.topNode) continue; // only `docAttr` addresses it (see the header)
    for (const [attr, def] of attrsOf(nodeDef))
      for (const v of violations(def.grammar))
        out.push({
          title: `${nodeDef.name}.${attr} ${v.kind} ${show(v.value)}`,
          owner: nodeDef.name,
          attr,
          def,
          kind: v.kind,
          step: (doc) => new AttrStep(firstOf(doc, nodeDef.name), attr, v.value).toJSON() as Json,
        });
  }
  for (const markDef of CDM1.marks)
    for (const [attr, def] of attrsOf(markDef))
      for (const v of violations(def.grammar))
        out.push({
          title: `mark ${markDef.name}.${attr} ${v.kind} ${show(v.value)}`,
          owner: `mark ${markDef.name}`,
          attr,
          def,
          kind: v.kind,
          step: (doc) => {
            const from = firstOf(doc, 'paragraph') + 2; // inside "Terms", after the anchor
            const valid = VALID_MARK_ATTRS[markDef.name] ?? {};
            const mark = { type: markDef.name, attrs: { ...valid, [attr]: v.value } };
            return { stepType: 'addMark', mark, from, to: from + 2 };
          },
        });
  return out;
}

/** Valid values for the attributes a mark must carry, so that only the one under test is wrong. */
const VALID_MARK_ATTRS: Record<string, Json> = {
  link: { href: 'https://example.org/' },
  charStyle: { style: 'Strong' },
  ins: { id: 'sGrammarCase0001', user: 'alice' },
  del: { id: 'sGrammarCase0001', user: 'alice' },
  fmt: { id: 'sGrammarCase0001', user: 'alice', before: { marks: [], attrs: {} } },
  preserved: { props: { children: [{ name: 'w:shadow' }] } },
};

const LIMITS = { ...DEFAULT_LIMITS, maxStepsPerCommit: 1_000_000, maxCommitBytes: 256 * 2 ** 20 };
let clock = 1_790_000_000_000;
let counter = 0;
const commitId = () => `0192f0c4-7b1e-7000-9028-${(++counter).toString(16).padStart(12, '0')}`;

const base = everythingBase();
const initial = schema.nodeFromJSON(base['doc']);

function submit(step: Json): {
  fx: Effects;
  room: Room;
  reject?: Extract<ToClient, { t: 'sync.reject' }>;
} {
  const gate = CONTEXT['mathGateRefuses'] as string;
  const room = new Room({
    schema,
    initial,
    requires: base['requires'] as string[],
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-sec-027-grammar',
    now: () => ++clock,
    limits: LIMITS,
    retiredRegionIds: CONTEXT['retiredRegionIds'] as string[],
    attachedAssets: new Set<string>(CONTEXT['attachedAssets'] as string[]),
    mathGate: (latex: string) => (latex.includes(gate) ? `${gate} is not allowed` : null),
  });
  room.open('c1', USERS.alice);
  const fx = room.submit('c1', { id: commitId(), base: 0, steps: [step] });
  const reject = fx.send
    .filter((o) => o.channel === 'c1')
    .map((o) => o.msg as ToClient)
    .find((m) => m.t === 'sync.reject') as Extract<ToClient, { t: 'sync.reject' }> | undefined;
  return { fx, room, ...(reject ? { reject } : {}) };
}

const cases = grammarCases();

describe('SEC-027 a value outside the grammar of any attribute is refused (I11)', () => {
  it('the base holds every node type of the definition and is valid', () => {
    for (const nodeDef of CDM1.nodes)
      if (nodeDef.name !== CDM1.topNode && nodeDef.name !== 'text')
        expect(firstOf(initial, nodeDef.name), nodeDef.name).toBeGreaterThanOrEqual(0);
    const end = initial.content.size - 1;
    const para = schema.nodeFromJSON({
      type: 'paragraph',
      attrs: { id: 'pHarmless0000001' },
      content: [{ type: 'text', text: 'ok' }],
    });
    const { fx, reject } = submit(
      new ReplaceStep(end, end, new Slice(Fragment.from(para), 0, 0)).toJSON() as Json,
    );
    expect(reject, JSON.stringify(reject)).toBeUndefined();
    expect(fx.write).not.toBeNull();
  });

  it('derives a case for every attribute of every node type and mark', () => {
    const have = new Set(cases.map((c) => `${c.owner}.${c.attr}`));
    let attributes = 0;
    for (const nodeDef of CDM1.nodes) {
      if (nodeDef.name === CDM1.topNode) continue;
      for (const [attr] of attrsOf(nodeDef)) {
        attributes += 1;
        expect(have, `${nodeDef.name}.${attr}`).toContain(`${nodeDef.name}.${attr}`);
      }
    }
    for (const markDef of CDM1.marks)
      for (const [attr] of attrsOf(markDef)) {
        attributes += 1;
        expect(have, `mark ${markDef.name}.${attr}`).toContain(`mark ${markDef.name}.${attr}`);
      }
    expect(have.size).toBe(attributes);
    // Type for every attribute; range, length and pattern wherever the grammar has them.
    for (const kind of ['type', 'range', 'length', 'pattern'] as const)
      expect(
        cases.some((c) => c.kind === kind),
        kind,
      ).toBe(true);
  });

  it.each(cases.map((c) => [c.title, c] as const))('%s', (_title, c) => {
    const { fx, room, reject } = submit(c.step(initial));
    expect(reject, 'the Room must answer sync.reject').toBeDefined();
    expect(['invalid_op', 'field_invalid'], reject?.reason).toContain(reject?.code);
    expect(fx.write, 'a refused commit must not reach storage').toBeNull();
    expect(room.document.eq(initial)).toBe(true);
    const reason = String(reject?.reason);
    // The ProseMirror schema is generated from the same definition and checks the JSON type of
    // every attribute when a step is read, so a wrong type is refused there, by name.
    const typed =
      /^step 0 (?:threw|is malformed): Expected value of type \S+ for attribute (\w+) on type /.exec(
        reason,
      );
    if (typed) {
      expect(typed[1]).toBe(c.attr);
      expect(['type', 'null'], `${c.kind}: ${reason}`).toContain(c.kind);
      return;
    }
    if (c.attr === 'id' && !c.owner.startsWith('mark ')) {
      // Any change of a node's identifier is refused as an I2 transition, before the grammar.
      expect(reason).toMatch(/\bI2\b/);
      return;
    }
    const invariant = c.def.reportAs?.[c.kind] ?? c.def.reportAs?.['*'] ?? 'I11';
    expect(reason).toMatch(new RegExp(`\\b${invariant}\\b`));
    expect(reason).toContain(`/attrs/${c.attr}`);
  });
});
