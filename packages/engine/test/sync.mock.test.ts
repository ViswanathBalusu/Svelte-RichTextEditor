/**
 * The sync client hosted in the editing core, against backend-mock (FE-033, FE-121; SYN-017 to
 * SYN-020). backend-mock runs the real `Room`, so acknowledgements, rebases and rejections are the
 * authority's own.
 */
import { MockService } from '@docedit/backend-mock';
import { importedDocument } from '@docedit/protocol/contract';
import { undoDepth } from 'prosemirror-history';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { REMOTE } from '../src/meta.ts';
import { unconfirmed } from '../src/sync/state.ts';
import { internals, press } from '../src/testing.ts';
import {
  IDS,
  LEGAL_GRANT_FOR_TESTS,
  SPIKE_IDS,
  contractDocument,
  projectedDocument,
} from './fixtures.ts';
import {
  caret,
  join,
  microtask,
  newService,
  posOf,
  sleep,
  textOfNode,
  type,
  until,
} from './support.ts';

async function pair() {
  const service = newService();
  const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
  const a = await join(service, docId, 'eddie', 'editor');
  const b = await join(service, docId, 'olivia', 'owner');
  const done = async () => {
    a.detach();
    b.detach();
    await service.dispose();
  };
  return { service, docId, a, b, done };
}

const saved = (...cores: Array<{ core: { saveState: { get(): string } } }>) =>
  until(() => cores.every((m) => m.core.saveState.get() === 'saved'), 'saved');

describe('sync client in the core, against backend-mock', () => {
  it('two clients edit concurrently and converge with the room (FE-033, FE-121)', async () => {
    const { docId, a, b, done } = await pair();
    caret(a.core, IDS.intro, 0);
    caret(b.core, IDS.intro, 'end');
    for (let i = 0; i < 5; i++) {
      type(a.core, `a${i}`);
      type(b.core, `b${i}`);
    }
    await saved(a, b);
    const server = await a.backend.sync.loadContent(docId);
    await until(
      () => internals(a.core).sync.seq === server.seq && internals(b.core).sync.seq === server.seq,
      'both at the head',
    );
    const ia = internals(a.core);
    const ib = internals(b.core);
    expect(ia.state.doc.toJSON()).toEqual(server.doc);
    expect(ib.state.doc.toJSON()).toEqual(server.doc);
    const text = textOfNode(ia.state.doc, IDS.intro);
    for (let i = 0; i < 5; i++) {
      expect(text).toContain(`a${i}`);
      expect(text).toContain(`b${i}`);
    }
    await done();
  });

  it('a local edit shows at once and its steps join the queue before any answer (FE-033 criterion 1)', async () => {
    const { a, done } = await pair();
    caret(a.core, IDS.intro, 0);
    type(a.core, 'now');
    const i = internals(a.core);
    expect(textOfNode(i.state.doc, IDS.intro)).toBe('nowHello world');
    expect(unconfirmed(i.sync)).toHaveLength(1);
    expect(a.core.saveState.get()).toBe('saving');
    await saved(a);
    await done();
  });

  it('a change the guard refuses puts no step in the queue (criterion 2)', async () => {
    const { a, done } = await pair();
    caret(a.core, IDS.lockedPara, 1); // eddie may not edit the restricted region
    type(a.core, 'no');
    const i = internals(a.core);
    expect(unconfirmed(i.sync)).toHaveLength(0);
    expect(a.core.refusal.get()?.scopes).toEqual([`region:${IDS.locked}`]);
    await done();
  });

  it('a remote commit arrives as one transaction marked remote; the state equals the rebuilt document (criterion 3)', async () => {
    const { a, b, done } = await pair();
    const ia = internals(a.core);
    caret(a.core, IDS.mid, 0);
    type(a.core, 'local '); // unconfirmed while the remote commit arrives
    const remote: boolean[] = [];
    const stop = ia.onTransaction((tr) => remote.push(tr.getMeta(REMOTE) === true));
    caret(b.core, IDS.intro, 0);
    type(b.core, 'remote ');
    await saved(a, b);
    await until(() => textOfNode(ia.state.doc, IDS.intro).startsWith('remote '), 'remote text');
    stop();
    expect(remote.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(ia.state.doc.eq(ia.sync.visible)).toBe(true);
    expect(textOfNode(ia.state.doc, IDS.mid)).toBe('local Between');
    await done();
  });

  it('a remote change to a region the user may not edit is applied, not filtered (criterion 4)', async () => {
    const { a, b, done } = await pair();
    caret(b.core, IDS.lockedPara, 0);
    type(b.core, 'owner ');
    await saved(b);
    await until(
      () => textOfNode(internals(a.core).state.doc, IDS.lockedPara).startsWith('owner '),
      'the region change at eddie',
    );
    expect(a.core.canEdit(`region:${IDS.locked}`)).toBe(false);
    await done();
  });

  it('remote changes are not in the local undo history (criterion 5)', async () => {
    const { a, b, done } = await pair();
    const ia = internals(a.core);
    caret(a.core, IDS.mid, 0);
    type(a.core, 'mine ');
    await saved(a);
    caret(b.core, IDS.intro, 0);
    type(b.core, 'theirs ');
    await saved(b);
    await until(() => textOfNode(ia.state.doc, IDS.intro).startsWith('theirs '), 'their text');
    expect(undoDepth(ia.state)).toBe(1);
    expect(a.core.run('undo')).toBe(true);
    expect(textOfNode(ia.state.doc, IDS.mid)).toBe('Between');
    expect(textOfNode(ia.state.doc, IDS.intro)).toBe('theirs Hello world');
    await saved(a);
    await done();
  });

  it('exposes the confirmed document, seq, incarnation, in-flight commit and queue (criterion 7)', async () => {
    const { a, done } = await pair();
    caret(a.core, IDS.intro, 0);
    type(a.core, 'x');
    const snap = a.core.syncSnapshot();
    expect(snap.inflight?.steps).toHaveLength(1);
    expect(snap.incarnation).toBe(internals(a.core).sync.incarnation);
    expect(a.core.syncSummary.get().inflight).toBe(snap.inflight?.id);
    await saved(a);
    expect(a.core.syncSummary.get()).toMatchObject({ seq: 1, inflight: null, queued: 0 });
    expect(a.core.confirmedContent().seq).toBe(1);
    expect(a.core.confirmedSeq.get()).toBe(1);
    await done();
  });

  it('an undo of formatting is accepted by the authority (markSet steps are sent as their inner steps)', async () => {
    const { docId, a, done } = await pair();
    const ia = internals(a.core);
    const from = posOf(ia.state.doc, IDS.intro) + 1;
    ia.dispatch(ia.state.tr.setSelection(TextSelection.create(ia.state.doc, from, from + 11)));
    expect(a.core.run('italic')).toBe(true);
    await saved(a);
    expect(a.core.run('undo')).toBe(true);
    await saved(a);
    const server = await a.backend.sync.loadContent(docId);
    expect(ia.state.doc.toJSON()).toEqual(server.doc);
    const intro = ia.state.doc.nodeAt(posOf(ia.state.doc, IDS.intro))!;
    expect(intro.firstChild!.marks).toEqual([]);
    expect(a.core.recovered.get().count).toBe(0);
    // A mark that replaces one of its type (subscript to superscript): the exact inverse removes the
    // new mark and adds the old one back, a markSet step, refused by the authority if sent as such.
    const vert = (value: string) => ia.schema.marks['vertAlign']!.create({ value });
    ia.dispatch(ia.state.tr.addMark(from, from + 5, vert('sub')));
    await saved(a);
    ia.dispatch(ia.state.tr.addMark(from, from + 5, vert('super')));
    await saved(a);
    const types: string[] = [];
    const stop = ia.onTransaction((tr) => {
      for (const s of tr.steps) types.push(String((s.toJSON() as { stepType: string }).stepType));
    });
    expect(a.core.run('undo')).toBe(true);
    expect(ia.state.doc.nodeAt(from)!.marks.map((m) => m.attrs['value'])).toEqual(['sub']);
    expect(a.core.run('undo')).toBe(true);
    stop();
    expect(types).toContain('markSet'); // the path this case is about
    await saved(a);
    const after = await a.backend.sync.loadContent(docId);
    expect(ia.state.doc.toJSON()).toEqual(after.doc);
    expect(ia.state.doc.nodeAt(posOf(ia.state.doc, IDS.intro))!.firstChild!.marks).toEqual([]);
    expect(a.core.recovered.get().count).toBe(0);
    await done();
  });
});

describe('undo through the authority', () => {
  it('undo after Enter (at the end, the start and the middle) is accepted by the room', async () => {
    const { docId, a, done } = await pair();
    const ia = internals(a.core);
    for (const where of ['end', 0, 3] as const) {
      const original = await a.backend.sync.loadContent(docId);
      caret(a.core, IDS.intro, where);
      if (where === 'end') type(a.core, ' typed');
      press(ia.schema, 'Enter', ia.state, ia.dispatch);
      type(a.core, 'New paragraph');
      await saved(a);
      // One undo group or two (the typing after Enter at the start is a group of its own).
      for (
        let k = 0;
        k < 3 && JSON.stringify(ia.state.doc.toJSON()) !== JSON.stringify(original.doc);
        k++
      ) {
        expect(a.core.run('undo'), String(where)).toBe(true);
        await saved(a);
      }
      const server = await a.backend.sync.loadContent(docId);
      expect(ia.state.doc.toJSON(), String(where)).toEqual(server.doc);
      expect(server.doc, String(where)).toEqual(original.doc);
    }
    expect(a.core.recovered.get().count).toBe(0);
    expect(a.core.problem.get()).toBeNull();
    await done();
  });
});

describe('presence through the core (04 §11; ADR 0019)', () => {
  it('publishes the selection in confirmed positions and lists the peers, not this session', async () => {
    const service = new MockService({ presence: true });
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const joinWithPresence = async (sub: string) => {
      const backend = service.backend({ sub, name: sub.toUpperCase() }, { [docId]: 'editor' });
      await backend.connect();
      const content = await backend.sync.loadContent(docId);
      const core = new DocumentCore({ doc: content, schedule: microtask });
      const channel = await backend.sync.open(docId, {
        resume: { seq: content.seq, incarnation: content.incarnation },
      });
      const session = backend.auth.session!;
      const detach = core.attach(channel, {
        seq: content.seq,
        incarnation: content.incarnation,
        sync: backend.sync,
        presence: backend.presence!,
        session: session.session,
        features: [...backend.features],
        limits: session.limits,
        batchMs: 0,
      });
      return { core, detach };
    };
    const a = await joinWithPresence('ann');
    const b = await joinWithPresence('bob');
    expect(a.core.features.get()).toContain('presence');
    caret(a.core, IDS.intro, 3);
    caret(b.core, IDS.mid, 1);
    await until(
      () => a.core.presence.get().length === 1 && b.core.presence.get().length === 1,
      'peers',
    );
    expect(a.core.presence.get()).toEqual([
      { session: expect.any(String), user: 'bob', name: 'BOB', status: 'active' },
    ]);
    expect(b.core.presence.get()[0]!.user).toBe('ann');
    a.detach();
    b.detach();
    await service.dispose();
  });

  it('never lists a peer whose selection is in a region this reader sees as a placeholder', async () => {
    const { hiddenRegions, visiblePeer } = await import('../src/presence.ts');
    const core = new DocumentCore({ doc: projectedDocument(), schedule: microtask });
    const doc = internals(core).state.doc;
    const peer = (scope: string) => ({
      session: 's1',
      user: { id: 'u' },
      seq: 0,
      state: { selection: { anchor: 3, head: 3 }, scope, status: 'active' as const },
    });
    const hidden = hiddenRegions(doc);
    expect([...hidden]).toEqual([SPIKE_IDS.region]);
    expect(visiblePeer(peer(`region:${SPIKE_IDS.region}`), doc, hidden)).toBe(false);
    expect(visiblePeer(peer('body'), doc, hidden)).toBe(true);
  });
});

describe('rejections end to end (SYN-020; SYN-017 criterion 5)', () => {
  it('permission_denied: the work is set aside, its undo entry dropped, later work kept', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const g = await join(service, docId, 'grace', 'editor', {}, { groups: ['legal'] });
    const ig = internals(g.core);
    const hold = service.holdWrites(docId);
    caret(g.core, IDS.lockedPara, 0);
    type(g.core, 'clause ');
    await sleep(5); // in flight, its write held
    caret(g.core, IDS.mid, 0);
    type(g.core, 'kept ');
    const depth = undoDepth(ig.state);
    service.setGrants(docId, []); // the region is no longer grace's
    await hold.release();
    await until(() => g.core.saveState.get() === 'saved', 'saved', 5000);
    expect(textOfNode(ig.state.doc, IDS.lockedPara)).toBe('Restricted text');
    expect(textOfNode(ig.state.doc, IDS.mid)).toBe('kept Between');
    expect(g.core.recovered.get().items.map((r) => [r.reason, r.text])).toContainEqual([
      'permission_denied',
      'clause ',
    ]);
    // The undo entry of the discarded work is gone; the one of the kept work remains (04 §7).
    expect(depth).toBe(2);
    expect(undoDepth(ig.state)).toBe(1);
    expect(g.core.run('undo')).toBe(true);
    expect(textOfNode(ig.state.doc, IDS.mid)).toBe('Between');
    expect(textOfNode(ig.state.doc, IDS.lockedPara)).toBe('Restricted text');
    expect(ig.state.selection.from).toBeLessThanOrEqual(ig.state.doc.content.size);
    g.detach();
    await service.dispose();
  });

  it('read_only: the editor switches to read-only, and back when the document is unlocked', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const e = await join(service, docId, 'eddie', 'editor');
    const hold = service.holdWrites(docId);
    caret(e.core, IDS.intro, 0);
    type(e.core, 'late ');
    await sleep(5);
    service.setDocumentState(docId, 'locked');
    await hold.release();
    await until(() => e.core.saveState.get() === 'readonly', 'read-only', 5000);
    caret(e.core, IDS.intro, 0);
    type(e.core, 'refused');
    expect(textOfNode(internals(e.core).state.doc, IDS.intro)).toBe('Hello world');
    service.setDocumentState(docId, 'active');
    await until(() => e.core.saveState.get() === 'saved', 'editable again', 5000);
    type(e.core, 'ok ');
    await until(
      () => e.core.saveState.get() === 'saved' && e.core.confirmedSeq.get() > 0,
      'saved',
      5000,
    );
    expect(textOfNode(internals(e.core).state.doc, IDS.intro)).toBe('ok Hello world');
    e.detach();
    await service.dispose();
  });

  it('a snapshot commit: reset reloads the content; an old base gets stale_base and is resubmitted', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const e = await join(service, docId, 'eddie', 'editor');
    const ie = internals(e.core);
    service.replaceContent(docId, importedDocument());
    await until(() => textOfNode(ie.state.doc, IDS.intro) === 'Imported text', 'the snapshot');
    caret(e.core, IDS.intro, 0);
    type(e.core, 'after ');
    await until(() => e.core.saveState.get() === 'saved', 'saved');
    const server = await e.backend.sync.loadContent(docId);
    expect(ie.state.doc.toJSON()).toEqual(server.doc);
    expect(textOfNode(ie.state.doc, IDS.intro)).toBe('after Imported text');
    e.detach();
    await service.dispose();
  });
});
