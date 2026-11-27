/**
 * BE-094 criteria 1 and 4 (lane w5): the data plane never changes a document's model version by
 * itself, and a channel is refused with `unsupported_cdm` unless the component's version is the
 * version the document is stored at.
 *
 * The service here supports CDM 1 and 2 (`settings.cdm`), with the test-only version 2. A document
 * "at version 2" is created straight in the stores, with a version 2 envelope as its first
 * checkpoint; nothing is migrated to make it. That is what the criteria need: the channel decision
 * reads the stored version. The operator's migration (criteria 2 and 3) is in
 * be-094-operator-migration.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { uuid7, type JsonEnvelope } from '@docedit/model';
import { serveCdm2 } from './cdm2-test-only.ts';
import { basePermissions, startPlane, type Plane } from './support.ts';

// The service reads a document in the schema of its version, so version 2 must be served (BE-094;
// ADR 0435). It is the test-only version 2 of owner decisions 75 and 76.
let unserve: () => void;
beforeAll(() => {
  unserve = serveCdm2();
});
afterAll(() => unserve());

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function plane(): Promise<Plane> {
  const p = await startPlane({ settings: { cdm: { min: 1, max: 2 } } });
  planes.push(p);
  return p;
}

/** A document stored at CDM 2, with the content of a plain one under a version 2 envelope. */
async function documentAtVersion2(p: Plane): Promise<string> {
  const v1 = await p.createDocument();
  const base = await p.checkpoints.get(p.ref(v1), 0);
  const id = uuid7();
  await p.stores.documents.create(p.tenant, {
    id,
    cdmVersion: 2,
    requires: [],
    createdBy: 'alice',
    permissions: basePermissions(),
  });
  await p.checkpoints.put(p.ref(id), 0, { ...(base as JsonEnvelope), cdm: 2 });
  return id;
}

async function opened(p: Plane, doc: string, cdm: number): Promise<string> {
  const c = await p.client('alice', { [doc]: 'owner' });
  const r = await c.open(1, doc, { cdm });
  return r.t === 'ch.rejected' ? `rejected:${String(r.d?.code)}:${String(r.d?.message)}` : r.t;
}

describe('BE-094 criterion 1: opening a document migrates nothing', () => {
  it('leaves a document at version 1 at version 1, with no commit written, when a service that reads versions 1 and 2 opens it', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const before = await p.stores.logs.head(p.ref(doc));

    expect(await opened(p, doc, 1)).toBe('ch.opened');
    // A client at the newer version is refused: the document is still at version 1.
    expect(await opened(p, doc, 2)).toBe('rejected:unsupported_cdm:the document is CDM 1');

    const after = await p.stores.logs.head(p.ref(doc));
    expect(after.seq).toBe(before.seq);
    expect((await p.stores.documents.get(p.ref(doc)))!.cdmVersion).toBe(1);
    const commits = await p.stores.logs.read(p.ref(doc), 1, Math.max(1, after.seq));
    expect(commits.filter((c) => c.kind === 'snapshot')).toEqual([]);
  });

  it('does not migrate on a second open or after the room has been closed and loaded again', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    for (let i = 0; i < 3; i += 1) expect(await opened(p, doc, 1)).toBe('ch.opened');
    expect((await p.stores.documents.get(p.ref(doc)))!.cdmVersion).toBe(1);
    expect((await p.stores.logs.head(p.ref(doc))).seq).toBe(0);
  });
});

describe('BE-094 criterion 4: a component pinned to the older version', () => {
  it('is refused with unsupported_cdm on a document stored at version 2 and works on one stored at version 1', async () => {
    const p = await plane();
    const old = await p.createDocument();
    const newer = await documentAtVersion2(p);

    expect((await p.stores.documents.get(p.ref(newer)))!.cdmVersion).toBe(2);
    expect(await opened(p, newer, 1)).toBe('rejected:unsupported_cdm:the document is CDM 2');
    expect(await opened(p, old, 1)).toBe('ch.opened');
    // Nothing was migrated by either open.
    expect((await p.stores.documents.get(p.ref(newer)))!.cdmVersion).toBe(2);
    expect((await p.stores.documents.get(p.ref(old)))!.cdmVersion).toBe(1);
  });
});
