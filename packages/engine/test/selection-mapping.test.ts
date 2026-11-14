/**
 * The selection and the find matches through rebuilds of the visible state (FE-035), against
 * backend-mock, which runs the real `Room`. A local edit waits for a batch window so that a remote
 * commit lands first; the room then rebases the local commit and acknowledges it with `rebased`.
 */
import type { EditorState } from 'prosemirror-state';
import { findMatches } from '../src/search.ts';
import { internals } from '../src/testing.ts';
import { REMOTE } from '../src/meta.ts';
import { unconfirmed } from '../src/sync/state.ts';
import { describe, expect, it } from 'vitest';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, join, newService, posOf, textOfNode, traffic, type, until } from './support.ts';

async function pair(batchMs: number) {
  const service = newService();
  const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
  const a = await join(service, docId, 'eddie', 'editor', {}, { batchMs });
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

/** The text of the paragraph `id` before the selection head, when the head is inside it. */
function textBeforeHead(core: { state: EditorState }, id: string): string | null {
  const $head = core.state.selection.$head;
  if ($head.parent.attrs['id'] !== id) return null;
  return $head.parent.textContent.slice(0, $head.parentOffset);
}

describe('selection and matches through rebuilds (FE-035)', () => {
  it('a remote commit before the caret moves the caret with its text (criterion 1, remote rebuild)', async () => {
    const { a, b, done } = await pair(120);
    const ia = internals(a.core);
    caret(a.core, IDS.mid, 0);
    type(a.core, 'local '); // unconfirmed: a batch window holds it back
    expect(unconfirmed(ia.sync)).toHaveLength(1);
    caret(b.core, IDS.intro, 0);
    type(b.core, 'remote ');
    await saved(a, b);
    await until(() => textOfNode(ia.state.doc, IDS.intro).startsWith('remote '), 'remote text');
    await until(() => unconfirmed(ia.sync).length === 0, 'local commit acknowledged');
    expect(textBeforeHead(ia, IDS.mid)).toBe('local ');
    expect(ia.state.doc.eq(ia.sync.visible)).toBe(true);
    await done();
  });

  it('an acknowledgement with rebased steps maps the selection through the change (criterion 1)', async () => {
    traffic.clear();
    const { a, b, done } = await pair(150);
    const ia = internals(a.core);
    caret(a.core, IDS.mid, 0);
    type(a.core, 'mine ');
    // b's commit reaches the room before a's batch is sent, so a's commit is rebased on it.
    caret(b.core, IDS.intro, 'end');
    type(b.core, ' theirs');
    await saved(a, b);
    await until(() => unconfirmed(ia.sync).length === 0, 'local commit acknowledged');
    expect(traffic.rebasedAcks).toBeGreaterThanOrEqual(1);
    expect(textBeforeHead(ia, IDS.mid)).toBe('mine ');
    expect(textOfNode(ia.state.doc, IDS.mid)).toBe('mine Between');
    expect(ia.state.doc.eq(ia.sync.visible)).toBe(true);
    await done();
  });

  it('find matches equal a recomputation from scratch after a rebuild (criterion 3, find only)', async () => {
    const { a, b, done } = await pair(120);
    const ia = internals(a.core);
    const query = 'Between';
    a.core.findText(query);
    caret(a.core, IDS.mid, 0);
    type(a.core, 'local ');
    caret(b.core, IDS.intro, 0);
    type(b.core, 'remote ');
    await saved(a, b);
    await until(() => unconfirmed(ia.sync).length === 0, 'local commit acknowledged');
    const fresh = findMatches(ia.state.doc, query);
    expect(fresh.length).toBeGreaterThan(0);
    const kept = a.core.findResults().map((r) => r.text);
    expect(kept).toEqual(fresh.map((m) => m.text));
    // the matches' positions also agree: they are recomputed on each document change
    expect(a.core.findResults().map((r) => r.after)).toEqual(fresh.map((m) => m.after));
    await done();
  });

  it('an acknowledgement that equals the local document is a no-op (criterion 4)', async () => {
    const { a, done } = await pair(0);
    const ia = internals(a.core);
    caret(a.core, IDS.intro, 0);
    type(a.core, 'solo ');
    const docAtEdit = ia.state.doc;
    const remote: boolean[] = [];
    const stop = ia.onTransaction((tr) => {
      if (tr.docChanged) remote.push(tr.getMeta(REMOTE) === true);
    });
    await saved(a);
    await until(() => unconfirmed(ia.sync).length === 0, 'local commit acknowledged');
    stop();
    // nothing rebuilt the state: no remote transaction ran and the document object is the same
    expect(remote.filter(Boolean)).toHaveLength(0);
    expect(ia.state.doc).toBe(docAtEdit);
    expect(posOf(ia.state.doc, IDS.intro)).toBeGreaterThanOrEqual(0);
    await done();
  });
});
