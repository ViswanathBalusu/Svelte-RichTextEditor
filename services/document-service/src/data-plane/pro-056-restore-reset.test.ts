/**
 * PRO-056 criterion 2 (server half): a restore stored as a snapshot commit with reason `restore`
 * reaches every open client as `sync.reset` with that reason, and a replacement that is not a
 * restore keeps the reason `import`. The restore route passes `reason: 'restore'` to
 * `replaceContent` (control-plane/restore-route.ts). The real data plane runs over the in-memory
 * stores (test/data-plane/support.ts).
 */
import type { JsonEnvelope } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE_JSON } from '../../../../packages/authority/test/fixtures.ts';
import { REQUIRES, startPlane, type Plane } from '../../test/data-plane/support.ts';

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

const content = () =>
  ({ cdm: 1, requires: [...REQUIRES], doc: structuredClone(BASE_JSON) }) as unknown as JsonEnvelope;

describe('PRO-056 criterion 2: sync.reset carries the reason of the snapshot', () => {
  it('sends reason restore for a restore and import for a replacement', async () => {
    const p = await startPlane();
    planes.push(p);
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);

    const restored = await p.plane.replaceContent(p.ref(doc), content(), 'alice', {
      reason: 'restore',
    });
    const reset = await alice.take((m) => m.t === 'sync.reset');
    expect(reset.d).toMatchObject({ seq: restored.seq, reason: 'restore' });

    const imported = await p.plane.replaceContent(p.ref(doc), content(), 'alice');
    const next = await alice.take((m) => m.t === 'sync.reset');
    expect(next.d).toMatchObject({ seq: imported.seq, reason: 'import' });

    const [commit] = await p.stores.logs.read(p.ref(doc), restored.seq, restored.seq);
    expect(commit).toMatchObject({ kind: 'snapshot', origin: 'restore' });
  });
});
