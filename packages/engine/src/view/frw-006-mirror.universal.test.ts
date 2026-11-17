/**
 * A mirror of a field value on the body web view (FRW-006 criteria 1 and 5, lane w4): a `field` of
 * kind `formValue` shows the value of its target field and follows it without a reload, whether the
 * change is made here or arrives from another client through backend-mock's real room. The mirror
 * is an atom, and its accessible name says which field's value it shows.
 *
 * Runs through `pnpm vitest run --project browser <this file>`; skipped in Node.js, which has no DOM.
 */
import { MockService } from '@docedit/backend-mock';
import { NodeSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { FIELD_IDS, fieldsDocument } from '../../test/frw-fields-fixture.ts';
import { DocumentCore } from '../core.ts';
import { internals } from '../testing.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

const microtask = (run: () => void): void => queueMicrotask(run);

async function until(done: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

function mirrorOf(host: HTMLElement): HTMLElement {
  const el = host.querySelector<HTMLElement>('.de-field-mirror');
  if (!el) throw new Error('the mirror is not drawn');
  return el;
}

describe.skipIf(!isBrowser)('a mirror of a field value (FRW-006)', () => {
  it('shows the new value when its target changes here, in the same element (criterion 1)', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const core = new EditorCore({ doc: fieldsDocument(), schedule: microtask });
    const unmount = core.mountBody(host);
    try {
      const mirror = mirrorOf(host);
      expect(mirror.textContent).toBe('');
      core.enterFieldValue(FIELD_IDS.amount, '12.50');
      expect(mirrorOf(host)).toBe(mirror);
      expect(mirror.textContent).toBe('12.50');
      core.enterFieldValue(FIELD_IDS.amount, '13');
      expect(mirror.textContent).toBe('13');
      core.enterFieldValue(FIELD_IDS.amount, null);
      expect(mirror.textContent).toBe('');
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });

  it('shows a value another client stored, without a reload (criterion 1)', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(fieldsDocument());
    const join = async <C extends DocumentCore>(sub: string, make: (doc: never) => C) => {
      const backend = service.backend({ sub }, { [docId]: 'editor' });
      await backend.connect();
      const content = await backend.sync.loadContent(docId);
      const core = make(content as never);
      const channel = await backend.sync.open(docId, {
        resume: { seq: content.seq, incarnation: content.incarnation },
      });
      const detach = core.attach(channel, {
        seq: content.seq,
        incarnation: content.incarnation,
        sync: backend.sync,
        batchMs: 0,
      });
      return { core, detach };
    };
    const host = document.createElement('div');
    document.body.append(host);
    const reader = await join('rita', (doc) => new EditorCore({ doc, schedule: microtask }));
    const writer = await join('walt', (doc) => new DocumentCore({ doc, schedule: microtask }));
    const unmount = reader.core.mountBody(host);
    try {
      const mirror = mirrorOf(host);
      expect(mirror.textContent).toBe('');
      expect(writer.core.enterFieldValue(FIELD_IDS.amount, '250.75')).toEqual({
        ok: true,
        problems: [],
      });
      await until(() => mirror.textContent === '250.75', 'the mirror shows the stored value');
      // The same element in the same view: nothing was loaded again.
      expect(mirrorOf(host)).toBe(mirror);
      expect(mirror.isConnected).toBe(true);
      // The reader's own control of the target shows it too.
      expect(
        host.querySelector<HTMLInputElement>(`[data-field="${FIELD_IDS.amount}"] input`)?.value,
      ).toBe('250.75');
    } finally {
      unmount();
      reader.detach();
      writer.detach();
      reader.core.destroy();
      writer.core.destroy();
      host.remove();
    }
  });

  it('is an atom, named by the field whose value it shows (criterion 5)', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const core = new EditorCore({ doc: fieldsDocument(), schedule: microtask });
    const unmount = core.mountBody(host);
    try {
      const mirror = mirrorOf(host);
      expect(mirror.getAttribute('role')).toBe('note');
      expect(mirror.getAttribute('aria-label')).toBe('Value of the field Amount: empty');
      core.enterFieldValue(FIELD_IDS.amount, '12.50');
      expect(mirror.getAttribute('aria-label')).toBe('Value of the field Amount: 12.50');
      // The text of the mirror is not editable in place.
      expect(mirror.isContentEditable).toBe(false);

      // Selecting it selects the whole node: one position wide, no position inside it.
      const i = internals(core);
      let pos = -1;
      i.state.doc.descendants((node, p) => {
        if (pos < 0 && node.type.name === 'field' && node.attrs['kind'] === 'formValue') pos = p;
        return pos < 0;
      });
      const node = i.state.doc.nodeAt(pos)!;
      expect(node.isAtom).toBe(true);
      expect(node.nodeSize).toBe(1);
      i.dispatch(i.state.tr.setSelection(NodeSelection.create(i.state.doc, pos)));
      const selection = internals(core).state.selection;
      expect(selection instanceof NodeSelection && selection.node.type.name).toBe('field');
      expect(selection.to - selection.from).toBe(1);
      expect(mirrorOf(host).classList.contains('ProseMirror-selectednode')).toBe(true);
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });
});
