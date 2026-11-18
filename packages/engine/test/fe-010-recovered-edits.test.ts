/**
 * FE-010 criteria 1, 2, 3 and 6 at the engine: work set aside is kept with its reason, the region it
 * was meant for and a CDM fragment of what it inserted.
 *
 * - End to end through the mock service (authority room, protocol bridge, sync session): a
 *   `permission_denied` rejection while later steps wait in the queue, and a rebase that drops a
 *   step because another person removed the text it applied to.
 * - At the state machine: a reload and a `sync.reset` that leave work unsent.
 */
import type { Content } from '@docedit/protocol';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { fragmentOfSteps, recoveredKind } from '../src/recovered-fragment.ts';
import { editingSchema } from '../src/schema.ts';
import { internals } from '../src/testing.ts';
import {
  type SyncState,
  initialState,
  local,
  reload,
  reset,
  takeCommit,
} from '../src/sync/state.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, join, newService, posOf, sleep, textOfNode, type, until } from './support.ts';

const schema = editingSchema();
const limits = { maxStepsPerCommit: 500, maxCommitBytes: 1 << 20 };

function start(): SyncState {
  return initialState(schema.nodeFromJSON(contractDocument().doc), 3, 'inc-1');
}

function typeAt(s: SyncState, id: string, offset: number, text: string): SyncState {
  const tr = new Transform(s.visible).insert(posOf(s.visible, id) + 1 + offset, schema.text(text));
  return local(s, tr.steps, tr.doc);
}

/** The text of a fragment's content, whatever its depth. */
function fragmentText(content: readonly unknown[]): string {
  let out = '';
  const walk = (n: unknown): void => {
    const node = n as { text?: string; content?: unknown[] };
    if (typeof node.text === 'string') out += node.text;
    node.content?.forEach(walk);
  };
  content.forEach(walk);
  return out;
}

describe('FE-010 criterion 1: a refused commit is set aside with its region, and later work stays', () => {
  it('keeps the queued steps in the document and sends them, and names the region of the refused text', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const g = await join(service, docId, 'grace', 'editor', {}, { groups: ['legal'] });
    const hold = service.holdWrites(docId);
    caret(g.core, IDS.lockedPara, 0);
    type(g.core, 'clause ');
    await sleep(5); // in flight, its write held
    caret(g.core, IDS.intro, 'end');
    type(g.core, ' later');
    expect(g.core.saveState.get()).not.toBe('saved'); // the second change waits in the queue
    service.setGrants(docId, []); // the region is no longer grace's
    await hold.release();
    await until(() => g.core.saveState.get() === 'saved', 'saved', 5000);

    const items = g.core.recovered.get().items;
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item).toMatchObject({
      reason: 'permission_denied',
      kind: 'rejected',
      text: 'clause ',
      region: `region:${IDS.locked}`,
    });
    // The refused text is out of the region, and the later work stayed and was sent.
    const doc = internals(g.core).state.doc;
    expect(textOfNode(doc, IDS.lockedPara)).not.toContain('clause ');
    expect(textOfNode(doc, IDS.intro)).toMatch(/ later$/);
    expect(g.core.saveState.get()).toBe('saved');
    g.detach();
    await service.dispose();
  });
});

describe('FE-010 criterion 3: a step another person made impossible is dropped, and kept', () => {
  it('keeps the typed text as a dropped item with its region and fragment', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const g = await join(service, docId, 'grace', 'editor');
    const a = await join(service, docId, 'ada', 'editor');
    const hold = service.holdWrites(docId);
    // Ada removes the text first; her commit is held, then grace types into that text, and her
    // commit is held too. When the writes are released, the Room stores ada's commit first, and
    // grace receives it while her own is in flight.
    const ai = internals(a.core);
    const from = posOf(ai.state.doc, IDS.intro) + 1;
    const node = ai.state.doc.nodeAt(from - 1)!;
    ai.dispatch(ai.state.tr.delete(from, from + node.content.size));
    await sleep(5);
    caret(g.core, IDS.intro, 3);
    type(g.core, 'zz');
    await sleep(5);
    await hold.release();
    await until(
      () => g.core.recovered.get().items.some((r) => r.reason === 'rebase'),
      'the dropped step is set aside',
      5000,
    );
    const item = g.core.recovered.get().items.find((r) => r.reason === 'rebase')!;
    expect(item).toMatchObject({ kind: 'dropped', text: 'zz', region: 'body' });
    expect(fragmentText(item.fragment!.content)).toBe('zz');
    g.detach();
    a.detach();
    await service.dispose();
  });
});

describe('FE-010 criterion 2 and 6: work left unsent by a reload or a reset', () => {
  const content = (seq: number): Content =>
    ({ ...(contractDocument() as unknown as Content), seq, incarnation: 'inc-1' }) as Content;

  it('a reload sets the work aside as unsent, with the region it was made in', () => {
    let s = typeAt(start(), IDS.lockedPara, 0, 'clause ');
    s = takeCommit(s, 'c1', limits)!.state;
    s = typeAt(s, IDS.intro, 0, 'x');
    const t = reload(s, content(9), schema, undefined, false);
    expect(t.state.discarded.map((d) => [d.reason, d.region])).toEqual([
      ['reload', `region:${IDS.locked}`],
    ]);
    expect(recoveredKind('reload')).toBe('unsent');
  });

  it('a reset sets aside the steps that no longer apply, as unsent, with their region', () => {
    const s = typeAt(start(), IDS.lockedPara, 0, 'clause ');
    // The new content is a body of one paragraph: the step's position lies beyond it.
    const doc = contractDocument().doc as unknown as {
      content: Array<{ type: string; content: unknown[] }>;
    };
    const body = doc.content.find((n) => n.type === 'body')!;
    const short = {
      ...doc,
      content: doc.content.map((n) => (n === body ? { ...n, content: [n.content[0]] } : n)),
    };
    const next = { ...content(9), doc: short } as Content;
    const t = reset(s, next, schema);
    expect(t.state.discarded).toHaveLength(1);
    expect(t.state.discarded[0]).toMatchObject({
      reason: 'reset',
      text: 'clause ',
      region: `region:${IDS.locked}`,
    });
    expect(t.state.visible.eq(t.state.confirmed)).toBe(true);
    expect(recoveredKind('reset')).toBe('unsent');
    expect(recoveredKind('rebase')).toBe('dropped');
    expect(recoveredKind('conflict')).toBe('rejected');
  });
});

describe('FE-010 criterion 6: the fragment of set-aside work', () => {
  it('is a CDM fragment of the typed text, with the document version and no definitions needed', () => {
    const s = typeAt(typeAt(start(), IDS.intro, 0, 'ab'), IDS.intro, 2, 'cd');
    const d = reload(
      s,
      { ...(contractDocument() as unknown as Content), seq: 9, incarnation: 'inc-1' } as Content,
      schema,
      undefined,
      false,
    ).state.discarded;
    const fragment = fragmentOfSteps(s.visible, d[0]!.steps, schema, 1, ['core']);
    expect(fragment).not.toBeNull();
    expect(fragment!.cdm).toBe(1);
    expect(fragment!.requires).toEqual(['core']);
    expect(fragment!.openStart).toBe(0);
    expect(fragmentText(fragment!.content)).toBe('abcd');
  });

  it('is null for work that inserted nothing', () => {
    const s = start();
    const from = posOf(s.visible, IDS.intro) + 1;
    const tr = new Transform(s.visible).delete(from, from + 2);
    const d = reload(
      local(s, tr.steps, tr.doc),
      { ...(contractDocument() as unknown as Content), seq: 9, incarnation: 'inc-1' } as Content,
      schema,
      undefined,
      false,
    ).state.discarded;
    expect(d).toHaveLength(1);
    expect(d[0]!.text).toBe('');
    expect(fragmentOfSteps(s.visible, d[0]!.steps, schema, 1, [])).toBeNull();
  });

  it('joins block content and typed runs into a valid fragment', () => {
    let s = typeAt(start(), IDS.intro, 0, 'ab');
    const at = posOf(s.visible, IDS.intro) + 1 + 2;
    const tr = new Transform(s.visible).split(at);
    s = local(s, tr.steps, tr.doc);
    s = typeAt(s, IDS.intro, 0, 'q');
    const d = reload(
      s,
      { ...(contractDocument() as unknown as Content), seq: 9, incarnation: 'inc-1' } as Content,
      schema,
      undefined,
      false,
    ).state.discarded;
    const fragment = fragmentOfSteps(s.visible, d[0]!.steps, schema, 1, []);
    expect(fragment).not.toBeNull();
    expect(fragmentText(fragment!.content)).toContain('ab');
    expect(fragmentText(fragment!.content)).toContain('q');
  });
});
