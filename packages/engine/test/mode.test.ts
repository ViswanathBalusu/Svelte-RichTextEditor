/**
 * The editing mode (FE-029): the host's requested mode, the effective mode under the access, the
 * locks of `view` and `fill`, and a mode change while the editor is open.
 */
import { describe, expect, it } from 'vitest';
import type { Access } from '@docedit/protocol';
import { DocumentCore } from '../src/headless.ts';
import { effectiveMode } from '../src/mode.ts';
import { internals } from '../src/testing.ts';
import {
  IDS,
  SPIKE_IDS,
  contractDocument,
  editorAccess,
  regionOnlyAccess,
  spikeDocument,
} from './fixtures.ts';
import { caret, join, microtask, newService, sleep, textOfNode, type, until } from './support.ts';

/** Whether a dispatched change reached the document (the state's document object changed). */
function changes(core: DocumentCore, act: () => void): boolean {
  const before = internals(core).state.doc;
  act();
  return internals(core).state.doc !== before;
}

/** An access whose document-level and body capabilities are `caps` (no region is listed). */
const withCaps = (caps: string[]): Access => {
  const list = caps as Access['caps'];
  return editorAccess({
    caps: list,
    scopes: { doc: ['view'], body: list, defs: ['view'] },
  });
};

describe('effective mode under an access (FE-029 criterion 4)', () => {
  it('keeps the requested mode when the access allows it, and nothing limits it without an access', () => {
    expect(effectiveMode('edit', editorAccess())).toBe('edit');
    expect(effectiveMode('review', editorAccess())).toBe('review');
    expect(effectiveMode('edit', null)).toBe('edit');
    expect(effectiveMode('fill', null)).toBe('fill');
  });

  it('gives the most restrictive mode the access allows', () => {
    const viewer = withCaps(['view', 'comment']);
    expect(effectiveMode('edit', viewer)).toBe('view');
    expect(effectiveMode('review', viewer)).toBe('view');
    expect(effectiveMode('fill', viewer)).toBe('view');
    const suggester = withCaps(['view', 'comment', 'suggest']);
    expect(effectiveMode('edit', suggester)).toBe('review');
    expect(effectiveMode('review', suggester)).toBe('review');
    expect(effectiveMode('view', editorAccess())).toBe('view');
  });

  it('lets a region editor, with no document-level edit, keep edit mode', () => {
    expect(effectiveMode('edit', regionOnlyAccess())).toBe('edit');
  });

  it('gives fill only to a user with the fill capability', () => {
    expect(effectiveMode('fill', withCaps(['view', 'comment', 'fill']))).toBe('fill');
    expect(effectiveMode('fill', editorAccess())).toBe('view');
  });
});

describe('the mode in the core (FE-029)', () => {
  it('edit mode with a user who may edit: the body accepts changes (criterion 1, core side)', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
    });
    expect(c.mode.get()).toEqual({ requested: 'edit', effective: 'edit' });
    expect(c.readOnly).toBe(false);
    expect(c.canEdit('body')).toBe(true);
    caret(c, SPIKE_IDS.intro, 0);
    expect(changes(c, () => type(c, 'x'))).toBe(true);
  });

  it('view mode: no text input or structural edit, and selection and copy still work (criterion 2, core side)', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
      mode: 'view',
    });
    expect(c.mode.get()).toEqual({ requested: 'view', effective: 'view' });
    expect(c.readOnly).toBe(true);
    caret(c, SPIKE_IDS.intro, 0);
    expect(changes(c, () => type(c, 'x'))).toBe(false);
    expect(c.refusal.get()?.reason).toBe('read-only');
    expect(c.run('bold')).toBe(false);
    expect(c.run('paragraphStyle', { style: 'Normal' })).toBe(false);
    // Selection moves, and copying reads the selection.
    caret(c, SPIKE_IDS.after, 2);
    expect(c.selectionScope().blockId).toBe(SPIKE_IDS.after);
    expect(c.getSelectionContent().content.length).toBe(0);
    expect(c.run('selectAll')).toBe(true);
    expect(c.getSelectionContent().content.length).toBeGreaterThan(0);
  });

  it('review mode: the effective mode is review; suggestion mode itself is FE-041 and not built here', () => {
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
      mode: 'review',
    });
    expect(c.mode.get()).toEqual({ requested: 'review', effective: 'review' });
  });

  it('keeps the host’s requested value and reports the effective one (criterion 4)', () => {
    const viewer = withCaps(['view', 'comment']);
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: viewer,
      schedule: microtask,
      mode: 'edit',
    });
    expect(c.mode.get()).toEqual({ requested: 'edit', effective: 'view' });
    caret(c, SPIKE_IDS.intro, 0);
    expect(changes(c, () => type(c, 'x'))).toBe(false);
    // A later access that allows editing lifts the lock without the host setting anything again.
    c.setAccess(editorAccess({ rev: 2 }));
    expect(c.mode.get()).toEqual({ requested: 'edit', effective: 'edit' });
    expect(changes(c, () => type(c, 'y'))).toBe(true);
  });

  it('fill mode: the body is read-only; field values are FRW’s and not built here (criterion 6)', () => {
    const filler = withCaps(['view', 'comment', 'suggest', 'edit', 'fill']);
    const c = new DocumentCore({
      doc: spikeDocument(),
      access: filler,
      schedule: microtask,
      mode: 'fill',
    });
    expect(c.mode.get()).toEqual({ requested: 'fill', effective: 'fill' });
    expect(c.canEdit('body')).toBe(false);
    expect(c.readOnly).toBe(true);
    caret(c, SPIKE_IDS.intro, 0);
    expect(changes(c, () => type(c, 'x'))).toBe(false);
    expect(c.refusal.get()?.reason).toBe('read-only');
    // A user without the fill capability gets view instead.
    const other = new DocumentCore({
      doc: spikeDocument(),
      access: editorAccess(),
      schedule: microtask,
      mode: 'fill',
    });
    expect(other.mode.get().effective).toBe('view');
    expect(other.canEdit('body')).toBe(false);
  });

  it('a mode change while open updates the surface and keeps unconfirmed work (criterion 7)', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const e = await join(service, docId, 'eddie', 'editor');
    const hold = service.holdWrites(docId);
    caret(e.core, IDS.intro, 0);
    type(e.core, 'queued ');
    await sleep(5);
    const pending = e.core.syncSummary.get();
    expect(pending.queued + (pending.inflight ? 1 : 0)).toBeGreaterThan(0);

    // The same core object: no reload. Switching to view stops local changes, and keeps the queue.
    e.core.setMode('view');
    expect(e.core.readOnly).toBe(true);
    expect(e.core.syncSummary.get()).toEqual(pending);
    type(e.core, 'refused ');
    expect(textOfNode(internals(e.core).state.doc, IDS.intro)).toContain('queued ');
    expect(textOfNode(internals(e.core).state.doc, IDS.intro)).not.toContain('refused ');

    await hold.release();
    await until(
      () => e.core.saveState.get() === 'saved' && e.core.confirmedSeq.get() > 0,
      'saved',
      5000,
    );
    const server = await e.backend.sync.loadContent(docId);
    expect(JSON.stringify(server.doc)).toContain('queued ');
    expect(JSON.stringify(server.doc)).not.toContain('refused ');

    // Back to edit: the same core accepts changes again.
    e.core.setMode('edit');
    expect(e.core.readOnly).toBe(false);
    caret(e.core, IDS.intro, 0);
    type(e.core, 'again ');
    await until(() => e.core.saveState.get() === 'saved', 'saved again', 5000);
    expect(textOfNode(internals(e.core).state.doc, IDS.intro)).toContain('again ');
    e.detach();
    await service.dispose();
  });

  it('a lock that moves without a state change is passed to the mounted views (criterion 7)', () => {
    // The web view reads ProseMirror's `editable` only when given a state or props, so the core
    // must tell it when the lock moves on its own (setMode, setAccess). The DOM side is
    // packages/element/e2e/mode.spec.ts.
    const calls: boolean[] = [];
    const updates: number[] = [];
    class Probe extends DocumentCore {
      constructor() {
        super({ doc: spikeDocument() });
        this.addView({
          update: () => updates.push(1),
          composing: () => null,
          focus: () => {},
          lockChanged: (locked) => calls.push(locked),
        });
      }
    }
    const c = new Probe();
    c.setMode('view');
    c.setMode('view'); // no move, no call
    c.setMode('edit');
    c.setMode('review'); // still unlocked
    c.setMode('fill');
    c.setMode('edit');
    c.setAccess(withCaps(['view', 'comment'])); // edit asked, view in force
    c.setAccess(withCaps(['view', 'comment', 'edit']));
    expect(calls).toEqual([true, false, true, false, true, false]);
    // None of these was a state change.
    expect(updates).toEqual([]);
  });
});
