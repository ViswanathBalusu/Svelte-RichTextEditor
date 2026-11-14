/**
 * Trimmed deletion (FE-037): a deletion across protected content removes only the editable text,
 * reports the scopes it kept, and the room accepts the commit. Runs against backend-mock, which
 * runs the real `Room`, and through the key bindings the web view installs (FE-121).
 */
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { press } from '../src/keys.ts';
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

const bodyIds = (doc: ReturnType<typeof internals>['state']['doc']): string[] => {
  const ids: string[] = [];
  doc.lastChild!.forEach((child) => ids.push(String(child.attrs['id'])));
  return ids;
};

describe('trimmed deletion (FE-037)', () => {
  it('removes only the editable text of a deletion across a region the user cannot edit (criteria 1, 5)', async () => {
    const { a, done } = await editor();
    const i = internals(a.core);
    const before = bodyIds(i.state.doc);
    const lockedBefore = textOfNode(i.state.doc, IDS.lockedPara);
    // from the start of the first body paragraph to the middle of the locked paragraph
    select(i, IDS.intro, 0, IDS.lockedPara, 3);
    expect(press(i.schema, 'Backspace', i.state, i.dispatch)).toBe(true);
    expect(textOfNode(i.state.doc, IDS.intro)).toBe('');
    expect(textOfNode(i.state.doc, IDS.lockedPara)).toBe(lockedBefore);
    // no paragraph or region boundary was removed: the body children are the same
    expect(bodyIds(i.state.doc)).toEqual(before);
    expect(a.core.trimmed.get()?.skipped).toEqual([`region:${IDS.locked}`]);
    await until(() => a.core.saveState.get() === 'saved', 'saved');
    await done();
  });

  it('the room accepts the trimmed commit and the server holds the same document (criterion 3)', async () => {
    const { docId, a, done } = await editor();
    const i = internals(a.core);
    select(i, IDS.intro, 0, IDS.lockedPara, 3);
    press(i.schema, 'Backspace', i.state, i.dispatch);
    await until(() => a.core.saveState.get() === 'saved', 'saved');
    expect(a.core.refusal.get()).toBeNull();
    const server = await a.backend.sync.loadContent(docId);
    expect(i.state.doc.toJSON()).toEqual(server.doc);
    await done();
  });

  it('a selection wholly inside protected content changes nothing and reports the scope (criterion 4)', async () => {
    const { a, done } = await editor();
    const i = internals(a.core);
    const doc = i.state.doc;
    select(i, IDS.lockedPara, 1, IDS.lockedPara, 3);
    expect(press(i.schema, 'Delete', i.state, i.dispatch)).toBe(true);
    expect(i.state.doc.eq(doc)).toBe(true);
    expect(a.core.trimmed.get()).toEqual({ n: 1, skipped: [`region:${IDS.locked}`] });
    await done();
  });

  it('a deletion with no protected scope runs as the ordinary deletion and reports nothing', async () => {
    const { a, done } = await editor();
    const i = internals(a.core);
    select(i, IDS.intro, 0, IDS.intro, 5);
    expect(press(i.schema, 'Backspace', i.state, i.dispatch)).toBe(true);
    expect(textOfNode(i.state.doc, IDS.intro)).toBe(' world');
    expect(a.core.trimmed.get()).toBeNull();
    await done();
  });
});
