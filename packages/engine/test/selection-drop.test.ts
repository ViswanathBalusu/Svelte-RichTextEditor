/**
 * A rejection with action `drop` rebuilds the visible state from the confirmed document plus the later
 * local steps that still apply. The selection must land where it was (FE-035 criterion 2).
 */
import { describe, expect, it } from 'vitest';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, join, newService, sleep, textOfNode, type, until } from './support.ts';

describe('selection after a dropped rejection (FE-035 criterion 2)', () => {
  it('keeps the caret in the paragraph and offset it had, after the work it followed was set aside', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const g = await join(service, docId, 'grace', 'editor', {}, { groups: ['legal'] });
    const ig = internals(g.core);
    const hold = service.holdWrites(docId);

    // The rejected work: in the restricted paragraph, which grace loses before the write lands.
    caret(g.core, IDS.lockedPara, 0);
    type(g.core, 'clause ');
    await sleep(5);

    // The later work that still applies: five characters into the paragraph after it.
    caret(g.core, IDS.mid, 0);
    type(g.core, 'kept ');
    const selectionBefore = ig.state.selection;
    expect(selectionBefore.$from.parent.attrs['id']).toBe(IDS.mid);
    expect(selectionBefore.$from.parentOffset).toBe(5);

    service.setGrants(docId, []);
    await hold.release();
    await until(() => g.core.saveState.get() === 'saved', 'saved', 5000);

    // The rejected work is gone, the later work is there, and the caret is where it was.
    expect(g.core.recovered.get().items.map((r) => r.reason)).toContain('permission_denied');
    expect(textOfNode(ig.state.doc, IDS.lockedPara)).toBe('Restricted text');
    expect(textOfNode(ig.state.doc, IDS.mid)).toBe('kept Between');
    const selection = ig.state.selection;
    expect(selection.empty).toBe(true);
    expect(selection.$from.parent.attrs['id']).toBe(IDS.mid);
    expect(selection.$from.parentOffset).toBe(5);
    expect(g.core.selectionScope().blockId).toBe(IDS.mid);
    g.detach();
    await service.dispose();
  });
});
