/**
 * HIS-024 criterion 4: a table of every route and message field that carries a sequence number,
 * each gated or exempt with a reason, and a new ungated field fails the build. The table is
 * `SEQ_INPUTS` (gate.ts). This test walks the protocol definition (`DEP1`, the routes of
 * `operations` and the client messages of `messages`) and compares what it finds with the table,
 * in both directions: a client-supplied sequence field that is not listed fails, and a listed
 * input that the definition no longer has fails too.
 */
import { DEP1, type definition } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { SEQ_INPUTS } from './gate.ts';

type Shape = definition.Shape;
type OperationDef = definition.OperationDef;
type MessageDef = definition.MessageDef;

/** Member names that carry a sequence number a client may supply (07 §8; 05 §6.2; 04 §5). */
const SEQ_NAMES: ReadonlySet<string> = new Set([
  'seq',
  'fromSeq',
  'toSeq',
  'atSeq',
  'after',
  'baseSeq',
  'base',
]);

/** The named shapes of a definition, for resolving `ref` shapes. */
function namedOf(def: { readonly shapes: readonly definition.NamedShape[] }): Map<string, Shape> {
  return new Map(def.shapes.map((s) => [s.name, s.shape]));
}

/**
 * The member paths of a shape whose last member name is a sequence name. Refs are followed once
 * per path (a cycle stops at the ref name already on the path).
 */
export function seqPathsOf(
  shape: Shape | undefined,
  named: ReadonlyMap<string, Shape>,
  path = '',
  stack: readonly string[] = [],
  out: string[] = [],
): string[] {
  if (!shape) return out;
  switch (shape.kind) {
    case 'object':
      for (const [name, prop] of Object.entries(shape.props)) {
        const p = path === '' ? name : `${path}.${name}`;
        if (SEQ_NAMES.has(name)) out.push(p);
        seqPathsOf(prop.shape, named, p, stack, out);
      }
      return out;
    case 'map':
      seqPathsOf(shape.values, named, path, stack, out);
      return out;
    case 'array':
      seqPathsOf(shape.items, named, path, stack, out);
      return out;
    case 'nullable':
      seqPathsOf(shape.of, named, path, stack, out);
      return out;
    case 'anyOf':
      for (const s of shape.of) seqPathsOf(s, named, path, stack, out);
      return out;
    case 'ref': {
      if (stack.includes(shape.name)) return out;
      const target = named.get(shape.name);
      seqPathsOf(target, named, path, [...stack, shape.name], out);
      return out;
    }
    default:
      return out;
  }
}

/** The client-supplied sequence fields of a definition, as `where|field` keys of `SEQ_INPUTS`. */
export function clientSeqFieldsOf(def: {
  readonly shapes: readonly definition.NamedShape[];
  readonly operations: readonly OperationDef[];
  readonly messages: readonly MessageDef[];
}): Set<string> {
  const named = namedOf(def);
  const found = new Set<string>();
  for (const op of def.operations) {
    const where = `${op.method} ${op.path}`;
    for (const name of Object.keys(op.query ?? {}))
      if (SEQ_NAMES.has(name)) found.add(`${where}|query.${name}`);
    if (op.body) for (const p of seqPathsOf(op.body, named)) found.add(`${where}|body.${p}`);
  }
  for (const m of def.messages) {
    // A server message is not an input: the client reads it and supplies nothing.
    if (m.dir === 's2c' || !m.payload) continue;
    for (const p of seqPathsOf(m.payload, named)) found.add(`${m.t}|${p}`);
  }
  return found;
}

const listed = (): Set<string> => new Set(SEQ_INPUTS.map((i) => `${i.where}|${i.field}`));

/**
 * Listed inputs the definition does not declare yet. None: the attribution route takes `seq` (PRO-055),
 * so every listed input is a field of the definition.
 */
const NOT_IN_DEFINITION: ReadonlySet<string> = new Set<string>();

describe('the sequence inputs of the protocol are one table (HIS-024 criterion 4)', () => {
  it('every client-supplied sequence field of the definition is gated or exempt in SEQ_INPUTS', () => {
    const found = clientSeqFieldsOf(DEP1);
    // The walk must see the known inputs, or the test would pass on an empty definition.
    expect(found.has('ch.open|resume.seq')).toBe(true);
    expect(found.has('GET /documents/{id}/content|query.seq')).toBe(true);
    expect(found.has('POST /documents/{id}/restore|body.toSeq')).toBe(true);
    const ungated = [...found].filter((k) => !listed().has(k));
    expect(ungated).toEqual([]);
  });

  it('every listed input is still a field of the definition', () => {
    const found = clientSeqFieldsOf(DEP1);
    const stale = [...listed()].filter((k) => !found.has(k) && !NOT_IN_DEFINITION.has(k));
    expect(stale).toEqual([]);
    expect(found.has('GET /documents/{id}/attribution|query.seq')).toBe(true);
  });

  it('a new ungated sequence field fails the walk', () => {
    const extra: OperationDef = {
      ...DEP1.operations[0]!,
      operationId: 'his024.probe',
      method: 'GET',
      path: '/documents/{id}/his-024-probe',
      query: { atSeq: { shape: { kind: 'integer' }, required: false } as definition.Prop },
    };
    const probe = { ...DEP1, operations: [...DEP1.operations, extra] };
    const ungated = [...clientSeqFieldsOf(probe)].filter((k) => !listed().has(k));
    expect(ungated).toEqual(['GET /documents/{id}/his-024-probe|query.atSeq']);
  });

  it('a server message with a sequence number is not an input', () => {
    const serverOnly: MessageDef = {
      ...DEP1.messages.find((m) => m.t === 'ch.opened')!,
      t: 'his024.server',
      dir: 's2c',
      payload: { kind: 'object', props: { seq: { shape: { kind: 'integer' }, required: true } } },
    } as MessageDef;
    const probe = { ...DEP1, messages: [...DEP1.messages, serverOnly] };
    expect([...clientSeqFieldsOf(probe)].some((k) => k.startsWith('his024.server'))).toBe(false);
  });
});
