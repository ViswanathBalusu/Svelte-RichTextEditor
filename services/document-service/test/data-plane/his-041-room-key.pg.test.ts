// HIS-041 criterion 3 with a real room (lane w7, 2026-11-17): a room that opens a document with its
// own key gets the key from the key service. While the key service is unreachable the room does not
// open, so the document is unavailable and never served unsealed; when the key service is back the
// same document opens and shows what was written. Over PostgreSQL, with the checkpoints of the
// document as objects under its key. Test values only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { PgCheckpointIndex } from '../../src/data-plane/pg/checkpoint-index.ts';
import { DocumentKeyedObjectStore } from '../../src/objects/document-keyed-store.ts';
import { ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { MemoryObjectStore } from '../../src/objects/store.ts';
import { DocumentKeys, isSealed } from '../../src/storage/document-keys.ts';
import { PgDocumentKeyStore } from '../../src/storage/document-keys-pg.ts';
import { MemoryKeyService, type KeyService } from '../../src/storage/key-service.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)('a room opens a document with its own key (HIS-041)', () => {
  let db: TestDatabase;
  const planes: Plane[] = [];
  const service = new MemoryKeyService();
  let down = false;
  const keyService: KeyService = {
    create: (...a) => service.create(...a),
    publicJwk: (...a) => service.publicJwk(...a),
    sign: (...a) => service.sign(...a),
    unwrap: async (...a) => {
      if (down) throw new Error('the key service is unreachable');
      return service.unwrap(...a);
    },
    enabled: (...a) => service.enabled(...a),
    disable: (...a) => service.disable(...a),
    destroy: (...a) => service.destroy(...a),
  };

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    for (const p of planes.splice(0)) await p.close().catch(() => undefined);
    await db?.drop();
  });

  it('does not open while the key service is down, and opens with the same text when it is back', async () => {
    const tenant = newTenant();
    const s = pgStores(db.service);
    const raw = new MemoryObjectStore();
    const keys = new DocumentKeys({
      store: new PgDocumentKeyStore(db.service),
      keys: keyService,
      headSeq: async (ref) => (await s.logs.head(ref)).seq,
      now: () => Date.now(),
    });
    s.logs.useDocumentKeys(keys);
    const objects = new ObjectCheckpointStore(new DocumentKeyedObjectStore(raw, keys));
    const deps = { checkpoints: objects, checkpointIndex: new PgCheckpointIndex(db.service) };
    const stores = { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs };

    const first = await startPlane({ stores, tenant, node: 'node-a', deps });
    planes.push(first);
    const doc = await first.createDocument();
    const ref = first.ref(doc);
    await keys.setTenantOption(tenant, true);
    await keys.provision(ref);
    // The room opens from the object store's content at 0, which is now sealed under the key.
    await objects.put(ref, 0, (await first.checkpoints.get(ref, 0))!);
    const key0 = [...(await raw.list(`tenants/${tenant}/docs/${doc}/`))][0]!;
    expect(isSealed((await raw.get(key0))!)).toBe(true);

    const alice = await first.client('alice', { [doc]: 'owner' });
    const opened = await alice.open(1, doc);
    if (opened.t !== 'ch.opened') throw new Error(`open: ${JSON.stringify(opened)}`);
    const ack = await alice.submit(1, { base: 0, steps: [insertText(intro(), 'Sealed words')] });
    expect(ack.t).toBe('sync.ack');
    // The payload row in the table is sealed.
    const row = await db.admin.query<{ payload: Buffer }>(
      'SELECT payload FROM doc_commit_payloads WHERE doc_id = $1',
      [doc],
    );
    expect(row.rows).toHaveLength(1);
    expect(isSealed(row.rows[0]!.payload)).toBe(true);
    await first.close();
    planes.pop();

    // A node that starts now loads the room from the key service's data key. With the service
    // down, the room does not open.
    const second = await startPlane({ stores, tenant, node: 'node-b', deps });
    planes.push(second);
    down = true;
    try {
      const b = await second.client('bob', { [doc]: 'owner' });
      const refused = await b.open(1, doc);
      expect(refused.t).not.toBe('ch.opened');
      expect(JSON.stringify(refused)).toContain('unavailable');
      expect(JSON.stringify(refused)).not.toContain('Sealed words');
    } finally {
      down = false;
    }
    // The key service is back: the same document opens and shows what was written.
    const c = await second.client('carol', { [doc]: 'owner' });
    const again = await c.open(1, doc);
    if (again.t !== 'ch.opened') throw new Error(`open after the outage: ${JSON.stringify(again)}`);
    expect(again.d?.head).toBe(1);
    // The commit written under the key reads back with its text.
    const [commit] = await s.logs.read(ref, 1, 1);
    expect(JSON.stringify(commit?.steps)).toContain('Sealed words');
  }, 90_000);
});
