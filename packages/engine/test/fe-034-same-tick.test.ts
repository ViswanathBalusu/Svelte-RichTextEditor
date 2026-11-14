/**
 * FE-034 criterion 5, at the engine's level: a keystroke and a remote commit that arrive together
 * are both kept, and the two clients converge with the room. The element's animation frame (the
 * ViewHub's schedule) is not run here, so the frame itself is not tested; the browser run is open.
 */
import type { MockService } from '@docedit/backend-mock';
import { describe, expect, it } from 'vitest';
import { unconfirmed } from '../src/sync/state.ts';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, join, newService, textOfNode, type, until } from './support.ts';

describe('FE-034 criterion 5: a keystroke and a remote commit in the same tick', () => {
  it('keeps the keystroke and the remote text, in order, and both clients equal the room', async () => {
    const service: MockService = newService();
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const a = await join(service, docId, 'eddie', 'editor');
    const b = await join(service, docId, 'olivia', 'owner');
    try {
      caret(b.core, IDS.intro, 0);
      caret(a.core, IDS.mid, 0);
      // b's commit is in flight when a types: a's keystroke is queued while the remote text arrives.
      type(b.core, 'remote ');
      type(a.core, 'Kx');
      await until(
        () => a.core.saveState.get() === 'saved' && b.core.saveState.get() === 'saved',
        'saved',
      );
      const server = await a.backend.sync.loadContent(docId);
      await until(
        () =>
          internals(a.core).sync.seq === server.seq && internals(b.core).sync.seq === server.seq,
        'both at the head',
      );
      const ia = internals(a.core);
      expect(textOfNode(ia.state.doc, IDS.mid)).toContain('Kx');
      expect(textOfNode(ia.state.doc, IDS.intro)).toContain('remote ');
      expect(ia.state.doc.toJSON()).toEqual(server.doc);
      expect(internals(b.core).state.doc.toJSON()).toEqual(server.doc);
      expect(unconfirmed(ia.sync)).toHaveLength(0);
    } finally {
      a.detach();
      b.detach();
      await service.dispose();
    }
  });
});
