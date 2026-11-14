/**
 * SEC-034 criterion 1 with the gate injected in production (lane SEC-027-039, round 2 fix): the room
 * gates only LaTeX the document did not hold before the commit (09 §6.3; CDM-030; `previous` in
 * the validator). A commit that touches no formula does not call the gate, a formula stored earlier
 * does not make every later commit fail, and a new formula the gate refuses is still refused.
 */
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room } from '../src/room/room.ts';
import { stepsToJson } from '../src/steps.ts';
import { BASE_JSON, REQUIRES, basePermissions, posInside, schema } from './fixtures.ts';
import { commitId, messages } from './permission-fixtures.ts';

type J = { type: string; attrs?: Record<string, unknown>; content?: J[] };

const find = (n: J, id: string): J | null => {
  if (n.attrs?.['id'] === id) return n;
  for (const c of n.content ?? []) {
    const f = find(c, id);
    if (f) return f;
  }
  return null;
};

/** The base document with an inline equation the gate refuses, stored before the gate ran. */
function docWithLegacyFormula() {
  const json = structuredClone(BASE_JSON) as unknown as J;
  find(json, 'pIntro0000000001')!.content!.push({
    type: 'equation',
    attrs: { latex: '\\def\\a{x}\\a' },
  });
  return schema.nodeFromJSON(json);
}

function gatedRoom(calls: string[]) {
  return new Room({
    schema,
    initial: docWithLegacyFormula(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: basePermissions().revision,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => 1_770_700_000_000,
    mathGate: (latex) => {
      calls.push(latex);
      return latex.includes('\\def') || latex.includes('\\input') ? 'not on the allow-list' : null;
    },
  });
}

const insert = (room: Room, node: ReturnType<typeof schema.text>) => {
  const at = posInside(room.document, 'pIntro0000000001');
  return room.author('control', {
    id: commitId(),
    base: room.head,
    steps: stepsToJson([new ReplaceStep(at, at, new Slice(Fragment.from(node), 0, 0))]),
    origin: 'prefill',
    as: 'system',
  });
};

describe('the math gate runs on new LaTeX only (SEC-034)', () => {
  it('accepts a text commit to a document that holds a formula stored earlier, without calling the gate', () => {
    const calls: string[] = [];
    const room = gatedRoom(calls);
    const fx = insert(room, schema.text('plain'));
    expect(messages(fx, 'control')).toEqual([]);
    expect(fx.write).not.toBeNull();
    expect(calls).toEqual([]);
  });

  it('still refuses a new formula the gate refuses, with invalid_op and I8', () => {
    const calls: string[] = [];
    const room = gatedRoom(calls);
    const fx = insert(room, schema.nodes['equation']!.create({ latex: '\\input file' }));
    expect(messages(fx, 'control')).toEqual([
      expect.objectContaining({ t: 'sync.reject', code: 'invalid_op' }),
    ]);
    expect(calls).toEqual(['\\input file']);
    expect(fx.write).toBeNull();
  });
});
