/**
 * A refused server-authored operation on a closed document stores nothing (BE-023 criterion 3).
 * `RoomHost.apply` runs a transient authority when no room of the document is open on the node;
 * when the operation's precondition does not hold (here a base ahead of the head, which the
 * commit checks refuse with `invalid_op`), the requester gets the rejection and the log is
 * unchanged. Real data plane over the in-memory stores, with no channel open for the document.
 */
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';
import { RequestRefused } from './wire.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
async function plane(): Promise<Plane> {
  const p = await startPlane();
  planes.push(p);
  return p;
}
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('a refused transient operation stores nothing (BE-023 criterion 3)', () => {
  it('rejects a prefill whose base is ahead of the head, stores no commit and leaves no room', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const id = uuid7();

    const refused = await p.plane.host
      .apply(ref, {
        kind: 'author',
        id,
        origin: 'prefill',
        actor: 'system',
        base: 9,
        steps: [insertText(intro(), 'never stored')],
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(refused).toBeInstanceOf(RequestRefused);
    expect((refused as RequestRefused).rejection).toMatchObject({ code: 'invalid_op' });

    // Nothing was stored: the head is still 0, no room or transient authority is left behind.
    expect((await p.stores.logs.head(ref)).seq).toBe(0);
    expect((await p.stores.logs.read(ref, 1)).length).toBe(0);
    expect(p.plane.host.rooms).toHaveLength(0);
    expect(p.plane.host.transientCount).toBe(0);

    // A later, valid operation is applied from the unchanged head.
    const ok = await p.plane.host.apply(ref, {
      kind: 'author',
      id: uuid7(),
      origin: 'prefill',
      actor: 'system',
      base: 0,
      steps: [insertText(intro(), 'stored')],
    });
    expect(ok.seq).toBe(1);
    expect(p.errors).toEqual([]);
  });
});
