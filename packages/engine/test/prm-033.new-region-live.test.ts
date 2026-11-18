/**
 * PRM-033 criterion 5 at the engine (lane w9): a region that one person marks reaches the others,
 * and a person whose access does not name it cannot edit it until an `access` that does arrives.
 *
 * Two tests. The first drives one core directly: a region the access does not list is read-only, and
 * `setAccess` with the region's scope makes it editable. The second runs end to end through the
 * mock service (authority room and protocol bridge): an owner marks a region, a connected editor
 * receives the commit and then an `access` that lists the region, and may type in it. The order of the
 * commit and the `access` on the wire is not asserted in the second test; the first covers the
 * interval between them.
 */
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument, editorAccess, spikeDocument } from './fixtures.ts';
import {
  caret,
  join,
  microtask,
  newService,
  posOf,
  sleep,
  textOfNode,
  type,
  until,
} from './support.ts';

const NEW_REGION = 'rNewRegion00001';
const NEW_PARAGRAPH = 'pNewRegion00001';

describe('a new region is not editable until an access that includes it arrives (PRM-033 criterion 5)', () => {
  it('refuses typing in a region the access does not list, then allows it after setAccess', () => {
    const envelope = spikeDocument();
    const body = (
      envelope.doc as { content: Array<{ type: string; content: unknown[] }> }
    ).content.find((n) => n.type === 'body')!;
    body.content.push({
      type: 'region',
      attrs: { id: NEW_REGION, title: 'New', policy: 'inherit' },
      content: [
        {
          type: 'paragraph',
          attrs: { id: NEW_PARAGRAPH },
          content: [{ type: 'text', text: 'Fresh' }],
        },
      ],
    });
    const c = new DocumentCore({ doc: envelope, access: editorAccess(), schedule: microtask });
    expect(c.canEdit(`region:${NEW_REGION}`)).toBe(false);

    caret(c, NEW_PARAGRAPH, 0);
    type(c, 'zz');
    expect(textOfNode(internals(c).state.doc, NEW_PARAGRAPH)).toBe('Fresh');

    const base = editorAccess();
    c.setAccess({
      ...base,
      rev: base.rev + 1,
      scopes: {
        ...base.scopes,
        [`region:${NEW_REGION}`]: ['view', 'comment', 'suggest', 'edit'],
      },
    });
    expect(c.canEdit(`region:${NEW_REGION}`)).toBe(true);
    caret(c, NEW_PARAGRAPH, 0);
    type(c, 'zz');
    expect(textOfNode(internals(c).state.doc, NEW_PARAGRAPH)).toBe('zzFresh');
  });

  it('end to end: an owner marks a region, a connected editor sees it and then may edit it', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [] });
    const alice = await join(service, docId, 'alice', 'owner');
    const bob = await join(service, docId, 'bob', 'editor');

    const i = internals(alice.core);
    const from = posOf(i.state.doc, IDS.mid) + 1;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, from + 1)));
    expect(alice.core.run('markRegion', { title: 'Terms' })).toBe(true);
    await until(() => alice.core.saveState.get() === 'saved', 'the commit is saved');

    let id = '';
    await until(() => {
      internals(bob.core).state.doc.descendants((n) => {
        if (n.type.name === 'region' && n.attrs['title'] === 'Terms') id = n.attrs['id'] as string;
        return true;
      });
      return id !== '';
    }, 'the new region reaches Bob');
    expect(internals(bob.core).state.doc.eq(internals(alice.core).state.doc)).toBe(true);

    const scope = `region:${id}`;
    await until(
      () => bob.core.permissions.get()?.scopes[scope]?.includes('edit') === true,
      'access',
    );
    caret(bob.core, IDS.mid, 0);
    type(bob.core, 'zz');
    await sleep(20);
    expect(textOfNode(internals(bob.core).state.doc, IDS.mid)).toBe('zzBetween');

    alice.detach();
    bob.detach();
    await service.dispose();
  });
});
