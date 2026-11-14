/**
 * PRM-028 criteria 1 and 7 at the engine (lane PRM-015-028, round 2): a cut in a region the user
 * may not edit and an `insertContent` into it are refused by the region guard, and neither puts
 * anything in the sync queue. The typing, paste, drop, replace-all and undo cases are in
 * `guard.test.ts`; the boundary behaviour is in `regions.test.ts` and `content.test.ts`.
 */
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { unconfirmed } from '../src/sync/state.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, editorAccess, ownerAccess, spikeDocument } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

const REGION = `region:${SPIKE_IDS.region}`;

function core(access = editorAccess()): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), access, schedule: microtask });
}

/** A fragment copied from the body, to insert into the region. */
function bodyFragment(): ReturnType<DocumentCore['getSelectionContent']> {
  const source = new DocumentCore({
    doc: spikeDocument(),
    access: ownerAccess(),
    schedule: microtask,
  });
  const i = internals(source);
  const from = posOf(i.state.doc, SPIKE_IDS.intro) + 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, from + 3)));
  return source.getSelectionContent();
}

describe('a cut or an inserted block in a region the user may not edit is refused (PRM-028 criteria 1 and 7)', () => {
  it('refuses a cut of region text: the document is unchanged and nothing is queued', () => {
    const c = core();
    const i = internals(c);
    const doc = i.state.doc;
    const queued = unconfirmed(i.sync).length;
    const from = posOf(doc, SPIKE_IDS.legal) + 1;
    // The cut is a deletion of the selected text, as the browser's cut command makes it.
    i.dispatch(i.state.tr.setSelection(TextSelection.create(doc, from, from + 4)));
    i.dispatch(i.state.tr.deleteSelection());

    expect(internals(c).state.doc).toBe(doc);
    expect(unconfirmed(internals(c).sync).length).toBe(queued);
    expect(c.refusal.get()).toMatchObject({ reason: 'scope', scopes: [REGION] });
  });

  it('refuses insertContent at a caret in the region: refused, unchanged, nothing queued', () => {
    const c = core();
    const i = internals(c);
    const from = posOf(i.state.doc, SPIKE_IDS.legal) + 1;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, from)));
    const doc = internals(c).state.doc;
    const queued = unconfirmed(internals(c).sync).length;

    expect(c.insertContent(bodyFragment())).toMatchObject({
      ok: false,
      reason: 'refused',
      refusal: 'scope',
    });
    expect(internals(c).state.doc).toBe(doc);
    expect(unconfirmed(internals(c).sync).length).toBe(queued);
    expect(c.refusal.get()?.scopes).toEqual([REGION]);
  });
});
