/**
 * SEC-030 criterion 5 (lane SEC-027-039, round 6): a whole-document restore that would change an
 * approved region is refused, and the same restore is accepted once the region's state has been
 * changed away from `approved` (10 §3.3; 07 §11, §13; PRM-047, PRM-049).
 *
 * Node.js, the authority room with its permission state (no network, no storage). The restore is a
 * snapshot commit with reason `restore` (room.snapshot, the path the data plane's PUT /content and the
 * control plane's restore both reach). The owner is the requester, so the manage check passes and the
 * refusal comes from the approval alone.
 */
import { ReplaceStep, type Step } from 'prosemirror-transform';
import { Fragment, Slice } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { baseDoc, posInside, schema, USERS } from '../../../packages/authority/test/fixtures.ts';
import {
  commitId,
  morePermissions,
  rejection,
  roomWith,
} from '../../../packages/authority/test/permission-fixtures.ts';
import type { Node } from 'prosemirror-model';
import type { Room } from '../../../packages/authority/src/room/room.ts';

const TERMS = 'rTerms000000000A';
const TERMS_PARA = 'pTerms000000001A';
const NOW = 1_770_700_000_000;

/** The base document with a sentence typed into the approved region. */
function restoredContent(doc: Node): Node {
  const pos = posInside(doc, TERMS_PARA);
  const step: Step = new ReplaceStep(
    pos,
    pos,
    new Slice(Fragment.from(schema.text('Restored. ')), 0, 0),
  );
  const result = step.apply(doc);
  if (result.failed || !result.doc) throw new Error(`cannot build content: ${result.failed}`);
  return result.doc;
}

/** Completes every write the room asks for, as the document service would. */
function storeAll(room: Room): void {
  let fx = room.writeCompleted({ status: 'ok' });
  while (fx.write) fx = room.writeCompleted({ status: 'ok' });
}

function regionText(doc: Node): string {
  let text = '';
  doc.descendants((n) => {
    if (n.attrs['id'] === TERMS_PARA) text = n.textContent;
    return true;
  });
  return text;
}

describe('SEC-030 criterion 5: a whole-document restore cannot change an approved region', () => {
  it('refuses the restore while the region is approved, and accepts it once the state is changed', () => {
    const approved = morePermissions({ regionStates: new Map([[TERMS, 'approved' as const]]) });
    const room = roomWith(baseDoc(), approved, () => NOW);
    room.open('a1', USERS.alice);
    const before = room.document.toJSON();
    const content = restoredContent(room.document);

    // 1. The owner asks for the restore. The approved region would change, so it is refused.
    const refused = room.snapshot('control', {
      id: commitId(),
      reason: 'restore',
      content,
      checkpoint: 'c',
      as: USERS.alice,
    });
    expect(refused.write).toBeNull();
    expect(rejection(refused, 'control')).toMatchObject({
      t: 'sync.reject',
      code: 'permission_denied',
    });
    expect(room.document.toJSON()).toEqual(before);
    expect(regionText(room.document)).not.toContain('Restored.');

    // 2. The owner moves the region out of `approved` (a control commit, as in PRM-046).
    const changed = room.permissionsChanged({
      ...approved,
      revision: approved.revision + 1,
      regionStates: new Map(),
    });
    expect(changed.write?.commits.map((c) => c.kind)).toEqual(['control']);
    storeAll(room);

    // 3. The same restore is now accepted and stored as a whole-document snapshot.
    const accepted = room.snapshot('control', {
      id: commitId(),
      reason: 'restore',
      content,
      checkpoint: 'c',
      as: USERS.alice,
    });
    expect(rejection(accepted, 'control')).toBeNull();
    expect(accepted.write?.snapshot).toMatchObject({ origin: 'restore' });
    storeAll(room);
    expect(regionText(room.document)).toContain('Restored.');
  });
});
