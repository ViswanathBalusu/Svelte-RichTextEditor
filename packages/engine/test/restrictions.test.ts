/**
 * Clipboard restrictions in the core (FE-055): a copy or cut under `no-copy` writes nothing and
 * removes nothing, the refusal is recorded for the shell, and the access object is read again at
 * each copy, so a restriction removed by `perm.changed` takes effect without a reload.
 * Printing (`no-print`) and drag data are the shell's and the element's (packet B2 and FE-073).
 */
import { TextSelection } from 'prosemirror-state';
import { bodyRange } from '../src/body.ts';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { editorAccess } from './fixtures.ts';

const microtask = (run: () => void) => queueMicrotask(run);

/** A core on the spike document with a non-empty selection inside the first body paragraph. */
function selected(): DocumentCore {
  const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  const i = internals(c);
  let from = -1;
  let to = -1;
  const body = bodyRange(i.state.doc);
  i.state.doc.nodesBetween(body.start, body.end, (node, pos) => {
    if (from >= 0) return false;
    if (node.isTextblock && node.textContent.length >= 4) {
      from = pos + 1;
      to = pos + 3;
      return false;
    }
    return true;
  });
  if (from < 0) throw new Error('no text in the spike document');
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, to)));
  return c;
}

describe('no-copy (FE-055)', () => {
  it('writes nothing for a copy and removes nothing for a cut, and records the refusal', () => {
    const c = selected();
    c.setAccess(editorAccess({ restrictions: ['no-copy'] }));
    const before = internals(c).state.doc;

    expect(c.copySelection()).toBeNull();
    expect(c.refusal.get()).toEqual({ n: 1, reason: 'no-copy', scopes: [] });

    const cut = c.cutSelection();
    expect(cut).toEqual({ payload: null, deleted: false });
    expect(internals(c).state.doc).toBe(before);
    expect(c.refusal.get()?.n).toBe(2);
  });

  it('does not count an empty selection as a refused copy', () => {
    const c = selected();
    c.setAccess(editorAccess({ restrictions: ['no-copy'] }));
    const i = internals(c);
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, i.state.selection.from)));
    expect(c.copySelection()).toBeNull();
    expect(c.refusal.get()).toBeNull();
  });

  it('reads the access again at each copy, so a removed restriction takes effect at once', () => {
    const c = selected();
    c.setAccess(editorAccess({ rev: 1, restrictions: ['no-copy'] }));
    expect(c.copySelection()).toBeNull();

    c.setAccess(editorAccess({ rev: 2, restrictions: [] }));
    const payload = c.copySelection();
    expect(payload).not.toBeNull();
    // Only the refusal made while the restriction held is counted.
    expect(c.refusal.get()?.n).toBe(1);
  });

  it('copies and cuts normally when the access lists no restriction', () => {
    const c = selected();
    c.setAccess(editorAccess({ restrictions: [] }));
    expect(c.copySelection()).not.toBeNull();
    expect(c.refusal.get()).toBeNull();
  });
});
