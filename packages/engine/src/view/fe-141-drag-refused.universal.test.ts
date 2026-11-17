/**
 * FE-141 criterion 3, the drag: a drag of a selection that holds a placeholder or a redacted value
 * does not start, and no drag data is written (ADR 0019, "What a reader may not send").
 *
 * The test mounts the body view and dispatches a `dragstart` event with a `DataTransfer` on the
 * editing surface, which is the event a pointer drag fires first; the pointer itself is not moved.
 * It runs in real browser engines through `pnpm vitest run --project browser <this file>`
 * (Chromium, Firefox and WebKit) and is skipped in Node.js, where there is no DOM.
 */
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../api.ts';
import { internals } from '../testing.ts';
import { SPIKE_IDS, ownerAccess, projectedDocument, spikeDocument } from '../../test/fixtures.ts';
import { posOf } from '../../test/support.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

function mount(doc: CdmEnvelope): { core: EditorCore; surface: HTMLElement; done: () => void } {
  const host = document.createElement('div');
  document.body.append(host);
  const core = new EditorCore({
    doc,
    access: ownerAccess(),
    schedule: (run) => queueMicrotask(run),
  });
  const unmount = core.mountBody(host);
  return {
    core,
    surface: host,
    done: () => {
      unmount();
      core.destroy();
      host.remove();
    },
  };
}

/** Dispatches a `dragstart` on the surface and returns the event and its data. */
function dragStart(surface: HTMLElement): { event: DragEvent; data: DataTransfer } {
  const data = new DataTransfer();
  const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data });
  surface.dispatchEvent(event);
  return { event, data };
}

/** The spike document with a paragraph that holds a field whose value is redacted. */
function redactedDocument(): CdmEnvelope {
  const env = spikeDocument();
  const doc = structuredClone(env.doc) as {
    content: Array<{ content?: Array<Record<string, unknown>> }>;
  };
  doc.content[doc.content.length - 1]!.content!.push({
    type: 'paragraph',
    attrs: { id: 'pField0000000002' },
    content: [
      {
        type: 'form_field',
        attrs: { id: 'fSecret000000002', kind: 'text', key: 'salary', value: { redacted: true } },
      },
    ],
  });
  return { ...env, requires: ['fields'], doc } as CdmEnvelope;
}

describe.skipIf(!isBrowser)('a drag of hidden content does not start (FE-141 criterion 3)', () => {
  it('refuses a drag of a text selection that spans a placeholder', () => {
    const { core, surface, done } = mount(projectedDocument('Clause'));
    try {
      const i = internals(core);
      const at = posOf(i.state.doc, SPIKE_IDS.region);
      const before = i.state.doc;
      i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at - 2, at + 3)));
      const { event, data } = dragStart(surface);
      expect(event.defaultPrevented).toBe(true);
      expect([...data.types]).toEqual([]);
      expect(core.refusal.get()?.reason).toBe('placeholder');
      expect(internals(core).state.doc).toBe(before);
    } finally {
      done();
    }
  });

  it('refuses a drag of the placeholder selected whole', () => {
    const { core, surface, done } = mount(projectedDocument('Clause'));
    try {
      const i = internals(core);
      const at = posOf(i.state.doc, SPIKE_IDS.region);
      i.dispatch(i.state.tr.setSelection(NodeSelection.create(i.state.doc, at)));
      const { event, data } = dragStart(surface);
      expect(event.defaultPrevented).toBe(true);
      expect([...data.types]).toEqual([]);
    } finally {
      done();
    }
  });

  it('refuses a drag of a redacted value', () => {
    const { core, surface, done } = mount(redactedDocument());
    try {
      const i = internals(core);
      let field = -1;
      i.state.doc.descendants((n, pos) => {
        if (n.type.name === 'form_field') field = pos;
        return field < 0;
      });
      i.dispatch(i.state.tr.setSelection(NodeSelection.create(i.state.doc, field)));
      const { event, data } = dragStart(surface);
      expect(event.defaultPrevented).toBe(true);
      expect([...data.types]).toEqual([]);
      expect(core.refusal.get()?.reason).toBe('redacted');
    } finally {
      done();
    }
  });

  it('lets a drag of a selection without hidden content start', () => {
    const { core, surface, done } = mount(projectedDocument('Clause'));
    try {
      const i = internals(core);
      const after = posOf(i.state.doc, SPIKE_IDS.after);
      i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, after + 1, after + 3)));
      const { event } = dragStart(surface);
      expect(event.defaultPrevented).toBe(false);
      expect(core.refusal.get()).toBeNull();
    } finally {
      done();
    }
  });
});
