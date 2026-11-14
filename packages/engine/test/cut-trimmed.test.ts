/**
 * Cut across protected content (FE-037 criterion 6): the whole selection is copied, and only the
 * editable parts are removed, as a trimmed deletion does. Runs against backend-mock (the real
 * `Room`), so the server must accept the trimmed commit (FE-037 criterion 3).
 */
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { join, newService, posOf, textOfNode, until } from './support.ts';

async function editor() {
  const service = newService();
  const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
  const a = await join(service, docId, 'eddie', 'editor');
  const done = async () => {
    a.detach();
    await service.dispose();
  };
  return { docId, a, done };
}

/** Selects from `fromId` at `fromOffset` to `toId` at `toOffset` (both inside their paragraphs). */
function select(
  core: ReturnType<typeof internals>,
  fromId: string,
  fromOffset: number,
  toId: string,
  toOffset: number,
): void {
  const doc = core.state.doc;
  const from = posOf(doc, fromId) + 1 + fromOffset;
  const to = posOf(doc, toId) + 1 + toOffset;
  core.dispatch(core.state.tr.setSelection(TextSelection.create(doc, from, to)));
}

describe('cut across protected content (FE-037 criterion 6)', () => {
  it('copies the whole selection and removes only the editable text', async () => {
    const { a, done } = await editor();
    const i = internals(a.core);
    const lockedBefore = textOfNode(i.state.doc, IDS.lockedPara);
    select(i, IDS.intro, 0, IDS.lockedPara, 3);
    const cut = a.core.cutSelection();
    // The clipboard holds what was selected, the protected part included.
    expect(cut.payload).not.toBeNull();
    expect(cut.payload?.['text/plain']).toContain(lockedBefore.slice(0, 3));
    expect(cut.deleted).toBe(true);
    expect(textOfNode(i.state.doc, IDS.intro)).toBe('');
    expect(textOfNode(i.state.doc, IDS.lockedPara)).toBe(lockedBefore);
    expect(a.core.trimmed.get()?.skipped).toEqual([`region:${IDS.locked}`]);
    expect(a.core.refusal.get()).toBeNull();
    await done();
  });

  it('the room accepts the trimmed cut and the server holds the same document', async () => {
    const { docId, a, done } = await editor();
    const i = internals(a.core);
    select(i, IDS.intro, 0, IDS.lockedPara, 3);
    a.core.cutSelection();
    await until(() => a.core.saveState.get() === 'saved', 'saved');
    expect(a.core.refusal.get()).toBeNull();
    const server = await a.backend.sync.loadContent(docId);
    expect(i.state.doc.toJSON()).toEqual(server.doc);
    await done();
  });

  it('deletes nothing and says why when the selection holds no editable content', async () => {
    const { a, done } = await editor();
    const i = internals(a.core);
    select(i, IDS.lockedPara, 1, IDS.lockedPara, 3);
    const before = i.state.doc;
    const cut = a.core.cutSelection();
    expect(cut.payload).not.toBeNull();
    expect(cut.deleted).toBe(false);
    expect(i.state.doc.eq(before)).toBe(true);
    expect(a.core.refusal.get()?.scopes).toEqual([`region:${IDS.locked}`]);
    await done();
  });
});
