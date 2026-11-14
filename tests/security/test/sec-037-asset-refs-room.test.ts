/**
 * SEC-037 criterion 3, the room's half: a commit that places a figure whose asset is not attached to
 * the document is refused with `invalid_op`, and the document is unchanged (I4; validate.ts, the
 * `asset_not_attached` check). The room checks a reference only when it holds an attached-asset set
 * (`RoomInit.attachedAssets`). This test builds a room with that set, the way a host would.
 *
 * Not covered here: the set itself. The check holds only for the assets the host puts in the set; the
 * data plane does not yet fill it per document (see the story's Notes), and the other-document and
 * other-tenant cases depend on that. So criterion 3 stays unticked. Node.js only (vitest). No network.
 */
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room } from '../../../packages/authority/src/room/room.ts';
import { stepsToJson } from '../../../packages/authority/src/steps.ts';
import {
  rejection,
  commitId,
  morePermissions,
} from '../../../packages/authority/test/permission-fixtures.ts';
import {
  REQUIRES,
  baseDoc,
  posOf,
  schema,
  USERS,
} from '../../../packages/authority/test/fixtures.ts';

const TERMS = 'rTerms000000000A';
const ATTACHED = '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10';
const NOT_ATTACHED = '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a11';
const CHANNEL = 'c1';

function roomWithAssets(attached: ReadonlySet<string>): Room {
  const perms = morePermissions();
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms,
    initialRevision: perms.revision,
    epoch: 1,
    incarnation: 'inc-sec-037',
    now: () => 1_770_700_000_000,
    attachedAssets: attached,
  });
}

/** Inserts a figure that refers to `asset` at the start of the terms region. */
function figureStep(doc: ReturnType<typeof baseDoc>, asset: string): Step {
  const pos = posOf(doc, TERMS) + 1;
  const figure = schema.nodes['figure']!.create({
    id: 'fgSec03700000001',
    asset,
    width: 4000,
    height: 3000,
  });
  return new ReplaceStep(pos, pos, new Slice(Fragment.from(figure), 0, 0));
}

describe('SEC-037 criterion 3 (room half): a figure must name an attached asset', () => {
  it('accepts a figure whose asset is attached to the document', () => {
    const room = roomWithAssets(new Set([ATTACHED]));
    room.open(CHANNEL, USERS.carol);
    const fx = room.submit(CHANNEL, {
      id: commitId(),
      base: 0,
      steps: stepsToJson([figureStep(room.document, ATTACHED)]),
    });
    expect(rejection(fx, CHANNEL)).toBeNull();
    // The acknowledgement follows the store's write: complete the write as the host would.
    const sent = [...fx.send];
    for (
      let next = room.writeCompleted({ status: 'ok' });
      ;
      next = room.writeCompleted({ status: 'ok' })
    ) {
      sent.push(...next.send);
      if (!next.write) break;
    }
    expect(sent.some((o) => o.channel === CHANNEL && o.msg.t === 'sync.ack')).toBe(true);
    expect(room.document.toString()).toContain('figure');
  });

  it('refuses a figure whose asset is not attached, as invalid_op, and leaves the document unchanged', () => {
    const room = roomWithAssets(new Set([ATTACHED]));
    room.open(CHANNEL, USERS.carol);
    const before = room.document.toJSON();
    const fx = room.submit(CHANNEL, {
      id: commitId(),
      base: 0,
      steps: stepsToJson([figureStep(room.document, NOT_ATTACHED)]),
    });
    const reject = rejection(fx, CHANNEL);
    expect(reject).not.toBeNull();
    expect(reject?.code).toBe('invalid_op');
    expect(room.document.toJSON()).toEqual(before);
  });
});
