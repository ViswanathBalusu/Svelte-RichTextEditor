/**
 * UX-053: the range-based document API for extensions (`DocumentCore.extensionApi`, src/extension-api.ts).
 * The core is the headless one on the spike document. Remote work is the spike's stand-in
 * (`applyRemote`), which applies steps with the `REMOTE` metadata as a commit of another user would.
 * Delivery is driven by a queue the test runs by hand, so "after the change" is what is checked.
 */
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import {
  DocumentCore,
  type CoreConfig,
  type ExtEventMap,
  type ExtEventName,
} from '../src/headless.ts';
import type { CdmFragment } from '../src/cdm-fragment.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, editorAccess, regionOnlyAccess, spikeDocument } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

/** A queue of deliveries the test runs on its own. */
function manual(): { later: (run: () => void) => void; run: () => void; waiting: () => number } {
  const queue: Array<() => void> = [];
  return {
    later: (run) => queue.push(run),
    run: () => {
      for (const job of queue.splice(0)) job();
    },
    waiting: () => queue.length,
  };
}

function setup(config: Partial<CoreConfig> = {}) {
  const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask, ...config });
  if (config.mode === 'review') core.setAccess(editorAccess());
  const queue = manual();
  const api = core.extensionApi({ maxRanges: 8, later: queue.later });
  const state = () => internals(core).state;
  const introFrom = () => posOf(state().doc, SPIKE_IDS.intro) + 1;
  const introText = () => {
    const node = state().doc.nodeAt(introFrom() - 1)!;
    return node.textBetween(0, node.content.size, '', '￼');
  };
  return { core, api, queue, state, introFrom, introText };
}

const events = (api: ReturnType<typeof setup>['api'], names: readonly ExtEventName[]) => {
  const got: Array<{ name: string; event: unknown }> = [];
  for (const name of names)
    api.on(name, (event: ExtEventMap[typeof name]) => got.push({ name, event }));
  return got;
};

const paragraph = (text: string): CdmFragment => ({
  cdm: 1,
  requires: [],
  defs: [],
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  openStart: 0,
  openEnd: 0,
});

describe('UX-053 criterion 1: subscribed events are delivered for local and remote changes', () => {
  it('delivers blocks.changed for a local edit and blocks.added and blocks.deleted for new and removed blocks', () => {
    const { core, api, queue, state, introFrom } = setup();
    const got = events(api, ['blocks.added', 'blocks.changed', 'blocks.deleted']);
    const i = internals(core);

    i.dispatch(state().tr.insertText('Big ', introFrom()));
    queue.run();
    expect(got.map((g) => [g.name, (g.event as { ids: string[] }).ids])).toEqual([
      ['blocks.changed', [SPIKE_IDS.intro]],
    ]);
    expect((got[0]!.event as { origin: string }).origin).toBe('local');

    got.length = 0;
    const at = api.range(introFrom() - 1, introFrom() - 1);
    expect(api.insertBlocks(at, paragraph('Inserted'))).toEqual({ ok: true });
    queue.run();
    const added = got.find((g) => g.name === 'blocks.added')!.event as { ids: string[] };
    expect(added.ids).toHaveLength(1);
    const newId = added.ids[0]!;

    got.length = 0;
    const from = posOf(state().doc, newId);
    const node = api.range(from, from + state().doc.nodeAt(from)!.nodeSize);
    expect(api.deleteRange(node)).toEqual({ ok: true });
    queue.run();
    expect(got.map((g) => [g.name, (g.event as { ids: string[] }).ids])).toContainEqual([
      'blocks.deleted',
      [newId],
    ]);
  });

  it('delivers a remote change with origin remote and the confirmed seq', () => {
    const { core, api, queue, state, introFrom } = setup();
    const got = events(api, ['blocks.changed']);
    const tr = state().tr.insertText('Remote ', introFrom());
    expect(internals(core).applyRemote(tr.steps, 'map')).toBe('applied');
    queue.run();
    expect(got).toHaveLength(1);
    const event = got[0]!.event as ExtEventMap['blocks.changed'];
    expect(event.ids).toEqual([SPIKE_IDS.intro]);
    expect(event.origin).toBe('remote');
    expect(typeof event.seq).toBe('number');
  });

  it('reports origin both when local and remote changes come before one delivery', () => {
    const { core, api, queue, state, introFrom } = setup();
    const got = events(api, ['blocks.changed']);
    const i = internals(core);
    i.dispatch(state().tr.insertText('A', introFrom()));
    i.applyRemote(state().tr.insertText('B', introFrom()).steps, 'map');
    queue.run();
    expect(got).toHaveLength(1);
    expect((got[0]!.event as { origin: string }).origin).toBe('both');
  });

  it('delivers selection.changed with the new anchor and head', () => {
    const { core, api, queue, state, introFrom } = setup();
    const got = events(api, ['selection.changed']);
    const i = internals(core);
    i.dispatch(
      state().tr.setSelection(TextSelection.create(state().doc, introFrom(), introFrom() + 3)),
    );
    queue.run();
    expect(got).toHaveLength(1);
    expect(got[0]!.event).toMatchObject({ anchor: introFrom(), head: introFrom() + 3 });
  });

  it('delivers suggestions.changed when a suggestion is recorded', () => {
    const { core, api, queue, introFrom } = setup({ user: 'writer', mode: 'review' });
    const got = events(api, ['suggestions.changed']);
    const r = api.range(introFrom(), introFrom());
    expect(api.replaceRange(r, 'Suggested ')).toEqual({ ok: true });
    queue.run();
    expect(got).toHaveLength(1);
    const ids = (got[0]!.event as { ids: string[] }).ids;
    expect(ids).toHaveLength(1);
    const around = api.range(introFrom(), introFrom() + 20);
    expect(api.suggestions(around).map((s) => [s.id, s.kind, s.author])).toEqual([
      [ids[0], 'ins', 'writer'],
    ]);
    core.destroy();
  });

  it('delivers comments.changed when the service sets, moves or removes a thread range', () => {
    const { core, api, queue, introFrom } = setup();
    const got = events(api, ['comments.changed']);
    core.setThreadRange('t1', { from: introFrom(), to: introFrom() + 4 }, 1);
    queue.run();
    core.removeThreadRange('t1');
    queue.run();
    expect(got.map((g) => (g.event as { ids: string[] }).ids)).toEqual([['t1'], ['t1']]);
    // A thread over a range is listed by `comments(range)`.
    core.setThreadRange('t2', { from: introFrom(), to: introFrom() + 4 }, 2);
    expect(api.comments(api.range(introFrom(), introFrom() + 10))).toEqual([
      { id: 't2', detached: false },
    ]);
  });

  it('delivers nothing to an unsubscribed handler and to a disposed API', () => {
    const { core, api, queue, state, introFrom } = setup();
    const got: unknown[] = [];
    const off = api.on('blocks.changed', (e) => got.push(e));
    off();
    internals(core).dispatch(state().tr.insertText('x', introFrom()));
    queue.run();
    expect(got).toEqual([]);
    api.on('blocks.changed', (e) => got.push(e));
    api.dispose();
    expect(() => api.range(0, 0)).toThrow();
    internals(core).dispatch(state().tr.insertText('y', introFrom()));
    queue.run();
    expect(got).toEqual([]);
  });
});

describe('UX-053 criterion 5: delivery is asynchronous and cannot stop the editor', () => {
  it('calls no handler inside the transaction, only when the scheduler runs', () => {
    const { core, api, queue, state, introFrom } = setup();
    let calls = 0;
    api.on('blocks.changed', () => calls++);
    internals(core).dispatch(state().tr.insertText('x', introFrom()));
    expect(calls).toBe(0);
    expect(queue.waiting()).toBe(1);
    queue.run();
    expect(calls).toBe(1);
  });

  it('schedules one delivery however many changes come before it', () => {
    const { core, api, queue, state, introFrom } = setup();
    api.on('blocks.changed', () => undefined);
    for (let n = 0; n < 5; n++) internals(core).dispatch(state().tr.insertText('x', introFrom()));
    expect(queue.waiting()).toBe(1);
  });

  it('reports a handler that throws and still calls the next one, and editing goes on', () => {
    const errors: unknown[] = [];
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const queue = manual();
    const api = core.extensionApi({
      maxRanges: 2,
      later: queue.later,
      onError: (error) => errors.push(error),
    });
    const seen: string[] = [];
    api.on('blocks.changed', () => {
      throw new Error('bad handler');
    });
    api.on('blocks.changed', (e) => seen.push(...e.ids));
    const i = internals(core);
    const at = posOf(i.state.doc, SPIKE_IDS.intro) + 1;
    i.dispatch(i.state.tr.insertText('x', at));
    queue.run();
    expect(errors).toHaveLength(1);
    expect(seen).toEqual([SPIKE_IDS.intro]);
    i.dispatch(i.state.tr.insertText('y', at));
    expect(
      internals(core)
        .state.doc.nodeAt(at - 1)!
        .textContent.startsWith('yx'),
    ).toBe(true);
  });
});

describe('UX-053 criterion 2: writes meet the guards of typing', () => {
  it('refuses a write in a scope without edit rights, changes nothing and says permission_denied', () => {
    const { core, api, state, introFrom } = setup();
    core.setAccess(regionOnlyAccess());
    const before = state().doc;
    const r = api.range(introFrom(), introFrom() + 3);
    const result = api.replaceRange(r, 'no');
    expect(result).toMatchObject({ ok: false, reason: 'permission_denied' });
    expect(api.deleteRange(r)).toMatchObject({ ok: false, reason: 'permission_denied' });
    expect(api.insertBlocks(r, paragraph('x'))).toMatchObject({
      ok: false,
      reason: 'permission_denied',
    });
    expect(api.setMark(r, 'bold', { value: true })).toMatchObject({
      ok: false,
      reason: 'permission_denied',
    });
    expect(state().doc).toBe(before);
  });

  it('refuses a write in a region the user may only read, and writes where the user may edit', () => {
    const { core, api, state } = setup();
    core.setAccess(editorAccess());
    const legal = posOf(state().doc, SPIKE_IDS.legal) + 1;
    const refused = api.replaceRange(api.range(legal, legal + 2), 'zz');
    expect(refused).toMatchObject({ ok: false, reason: 'permission_denied' });
    const intro = posOf(state().doc, SPIKE_IDS.intro) + 1;
    expect(api.replaceRange(api.range(intro, intro + 2), 'zz')).toEqual({ ok: true });
  });

  it('refuses every write in a locked document', () => {
    const { core, api, state, introFrom } = setup();
    core.setMode('view');
    const before = state().doc;
    expect(api.replaceRange(api.range(introFrom(), introFrom() + 2), 'x')).toMatchObject({
      ok: false,
      reason: 'permission_denied',
    });
    expect(state().doc).toBe(before);
  });

  it('records a write as a suggestion in suggestion mode, and leaves the text in place', () => {
    const { core, api, state, introFrom, introText } = setup({ user: 'writer', mode: 'review' });
    const original = introText();
    const r = api.range(introFrom(), introFrom() + 5);
    expect(api.replaceRange(r, 'Hello')).toEqual({ ok: true });
    const marks = api.marks(api.range(introFrom(), introFrom() + 40)).flatMap((m) => m.marks);
    expect(marks.map((m) => m.type)).toEqual(expect.arrayContaining(['ins', 'del']));
    expect(state().doc.nodeAt(introFrom() - 1)!.textContent).toContain(original.slice(0, 5));
    core.destroy();
  });

  it('refuses a write that suggestion mode cannot record, with the refused reason', () => {
    const { core, api, state, introFrom } = setup({ mode: 'review' }); // no user to name
    const before = state().doc;
    const result = api.replaceRange(api.range(introFrom(), introFrom() + 2), 'x');
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    expect(state().doc).toBe(before);
    core.destroy();
  });

  it('sets a mark through the same path, and refuses protected and unknown marks', () => {
    const { api, state, introFrom } = setup();
    const r = api.range(introFrom(), introFrom() + 4);
    expect(api.setMark(r, 'bold', { value: true })).toEqual({ ok: true });
    const runs = api.marks(api.range(introFrom(), introFrom() + 4));
    expect(runs.flatMap((m) => m.marks.map((x) => x.type))).toContain('bold');
    expect(api.setMark(api.range(introFrom(), introFrom() + 4), 'ins')).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(api.setMark(api.range(introFrom(), introFrom() + 4), 'nope')).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(state().doc.nodeAt(introFrom() - 1)).not.toBeNull();
  });
});

describe('UX-053 criterion 3: no ProseMirror type appears in the API', () => {
  it('names no prosemirror module in the types file', () => {
    const file = fileURLToPath(new URL('../src/extension-api-types.ts', import.meta.url));
    expect(/from\s+['"]prosemirror-/.test(readFileSync(file, 'utf8'))).toBe(false);
  });

  it('gives only plain data: every answer survives a JSON round trip unchanged', () => {
    const { api, state } = setup();
    const doc = state().doc;
    const all = api.range(0, doc.content.size);
    const answers = [
      all,
      api.current(all),
      api.blocks(all),
      api.text(all),
      api.marks(all),
      api.comments(all),
      api.suggestions(all),
      api.selection(),
    ];
    for (const a of answers) expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    for (const a of answers.filter((x) => typeof x === 'object' && x !== null))
      expect(Object.getPrototypeOf(a) === Object.prototype || Array.isArray(a)).toBe(true);
  });

  it('reads blocks with identifiers and the text of a range', () => {
    const { api, state, introFrom, introText } = setup();
    const all = api.range(0, state().doc.content.size);
    expect(api.blocks(all).map((b) => b.id)).toContain(SPIKE_IDS.intro);
    expect(api.blocks(all).find((b) => b.id === SPIKE_IDS.intro)!.text).toBe(introText());
    expect(api.text(api.range(introFrom(), introFrom() + 4))).toBe(introText().slice(0, 4));
  });

  it('gives no text, block or identifier from a scope the reader may not view', () => {
    const { core, api, state } = setup();
    core.setAccess(
      editorAccess({
        scopes: {
          doc: ['view'],
          body: ['view', 'edit'],
          defs: ['view'],
          [`region:${SPIKE_IDS.region}`]: [],
        },
      }),
    );
    const all = api.range(0, state().doc.content.size);
    expect(api.blocks(all).map((b) => b.id)).not.toContain(SPIKE_IDS.legal);
    expect(api.text(all)).not.toContain(
      state().doc.nodeAt(posOf(state().doc, SPIKE_IDS.legal))!.textContent,
    );
  });
});

describe('UX-053 criterion 4: a write lands on the intended content or is refused', () => {
  it('maps a range through a change before it, and the write lands on the same text', () => {
    const { core, api, state, introFrom, introText } = setup();
    const r = api.range(introFrom() + 2, introFrom() + 5);
    const covered = introText().slice(2, 5);
    internals(core).dispatch(state().tr.insertText('Prefix ', introFrom()));
    const now = api.current(r)!;
    expect(now).toMatchObject({ from: introFrom() + 2 + 7, to: introFrom() + 5 + 7, stale: false });
    expect(api.text(r)).toBe(covered);
    const before = introText();
    expect(api.replaceRange(r, 'ZZZ')).toEqual({ ok: true });
    expect(introText()).toBe(before.slice(0, 9) + 'ZZZ' + before.slice(12));
    expect(before.slice(9, 12)).toBe(covered);
  });

  it('refuses after a local change inside the range, and changes nothing', () => {
    const { core, api, state, introFrom } = setup();
    const r = api.range(introFrom() + 2, introFrom() + 8);
    internals(core).dispatch(state().tr.insertText('!', introFrom() + 4));
    expect(api.current(r)!.stale).toBe(true);
    const before = state().doc;
    expect(api.replaceRange(r, 'X')).toMatchObject({ ok: false, reason: 'conflict' });
    expect(api.deleteRange(r)).toMatchObject({ ok: false, reason: 'conflict' });
    expect(state().doc).toBe(before);
  });

  it('refuses after a remote change inside the range', () => {
    const { core, api, state, introFrom } = setup();
    const r = api.range(introFrom() + 2, introFrom() + 8);
    internals(core).applyRemote(state().tr.delete(introFrom() + 3, introFrom() + 5).steps, 'map');
    const before = state().doc;
    expect(api.replaceRange(r, 'X')).toMatchObject({ ok: false, reason: 'conflict' });
    expect(state().doc).toBe(before);
  });

  it('marks a range detached when everything it covered is deleted, and refuses a write', () => {
    const { core, api, state, introFrom } = setup();
    const r = api.range(introFrom() + 2, introFrom() + 6);
    internals(core).dispatch(state().tr.delete(introFrom(), introFrom() + 10));
    expect(api.current(r)).toMatchObject({ detached: true, stale: true });
    expect(api.replaceRange(r, 'X')).toMatchObject({ ok: false, reason: 'conflict' });
  });

  it('refuses a range that was released or never made, and a forged one', () => {
    const { api, state, introFrom } = setup();
    const r = api.range(introFrom(), introFrom() + 2);
    api.release(r);
    expect(api.current(r)).toBeNull();
    expect(api.replaceRange(r, 'x')).toMatchObject({ ok: false, reason: 'invalid' });
    const before = state().doc;
    expect(
      api.replaceRange({ id: 'r999', from: introFrom(), to: introFrom() + 2 }, 'x'),
    ).toMatchObject({ ok: false, reason: 'invalid' });
    expect(state().doc).toBe(before);
  });

  it('holds at most maxRanges and frees one on release', () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const api = core.extensionApi({ maxRanges: 2 });
    const a = api.range(0, 0);
    api.range(1, 1);
    expect(() => api.range(2, 2)).toThrow(RangeError);
    api.release(a);
    expect(() => api.range(2, 2)).not.toThrow();
    expect(() => api.range(5, 4)).toThrow(RangeError);
    expect(() => api.range(0, 1e9)).toThrow(RangeError);
    expect(() => core.extensionApi({ maxRanges: 0 })).toThrow(RangeError);
  });

  it('never writes to the wrong place: any edit between the read and the write gives a refusal or the same content (property)', () => {
    const edit = fc.oneof(
      fc.record({
        kind: fc.constant('insert' as const),
        at: fc.nat(60),
        text: fc.string({ minLength: 1, maxLength: 4 }),
      }),
      fc.record({
        kind: fc.constant('delete' as const),
        at: fc.nat(60),
        len: fc.integer({ min: 1, max: 10 }),
      }),
    );
    fc.assert(
      fc.property(
        fc.nat(30),
        fc.integer({ min: 0, max: 12 }),
        fc.boolean(),
        edit,
        (offset, len, remote, e) => {
          const { core, api, state, introFrom, introText } = setup();
          const original = introText();
          const plain = 19; // "Alpha bravo charlie": the text before the first inline object
          const a = Math.min(offset, plain);
          const b = Math.min(a + len, plain);
          const covered = original.slice(a, b);
          const r = api.range(introFrom() + a, introFrom() + b);
          const at = introFrom() + Math.min(e.at, plain);
          const tr =
            e.kind === 'insert'
              ? state().tr.insertText(e.text.replace(/§/g, ''), at)
              : state().tr.delete(at, Math.min(at + e.len, introFrom() + plain));
          if (!tr.docChanged) return true;
          if (remote) internals(core).applyRemote(tr.steps, 'map');
          else internals(core).dispatch(tr);
          const edited = introText();
          const result = api.replaceRange(r, '§§');
          if (!result.ok) return result.reason === 'conflict' && introText() === edited;
          const final = introText();
          const i = final.indexOf('§§');
          return i >= 0 && final.slice(0, i) + covered + final.slice(i + 2) === edited;
        },
      ),
      { numRuns: 200 },
    );
  });
});
