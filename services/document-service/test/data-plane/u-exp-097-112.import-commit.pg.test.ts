/**
 * EXP-109 criterion 1 and EXP-098 criterion 2 (lane U-EXP-097-112) on PostgreSQL: a Word file's
 * imported content is validated by the import and then stored as a whole-document snapshot commit
 * with origin `import`. The import is `importDocx` (packages/export-docx, through a relative path,
 * because this service does not list that package); the commit is the data plane's snapshot path,
 * which the HTTP route `PUT /documents/{id}/content` also takes. Run against the shared PostgreSQL
 * container (infra/test-env.ps1 up). The database and tenant are created by this file and dropped
 * afterwards.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JsonEnvelope } from '@docedit/model';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { importDocx } from '../../../../packages/export-docx/src/index.ts';
import type { PgLogStore } from '../../src/index.ts';
import {
  pgStores,
  postgresUnavailable,
  createTestDatabase,
  type TestDatabase,
} from '../support/env.ts';
import { REQUIRES, startPlane, type Plane } from './support.ts';

const CORPUS = fileURLToPath(
  new URL('../../../../packages/export-docx/corpus/docx4j/sample-docx.docx', import.meta.url),
);

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'EXP-109 and EXP-098 on PostgreSQL: an imported Word file is stored as an import snapshot',
  () => {
    let db: TestDatabase;
    let planes: Plane[] = [];

    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterEach(async () => {
      for (const p of planes) await p.close();
      planes = [];
    });
    afterAll(async () => {
      await db?.drop();
    });

    it('stores the validated import as one snapshot commit with origin import, and refuses content that fails the model', async () => {
      const s = pgStores(db.service);
      const p = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
      });
      planes.push(p);
      const logs = s.logs as PgLogStore;

      // The import keeps Word content the editor does not model as `preserve` atoms (A2), so the
      // document must list that feature in `requires` (03 §11.1). A document created without it
      // refuses the import (see the Notes of EXP-098 and EXP-109).
      const doc = await p.createDocument({ requires: [...REQUIRES, 'preserve'] });
      const ref = p.ref(doc);
      const headBefore = await logs.head(ref);

      // The import validates the tree before it returns (EXP-109 criterion 1, first half).
      const imported = await importDocx(new Uint8Array(readFileSync(CORPUS)));
      const envelope = imported.envelope as unknown as JsonEnvelope;

      const { seq } = await p.plane.replaceContent(ref, envelope, 'alice');
      expect(seq).toBe(headBefore.seq + 1);

      // The snapshot is the commit at the new seq, with origin `import` (EXP-098 criterion 2).
      const [commit] = await logs.read(ref, seq, seq);
      expect(commit).toBeDefined();
      expect(commit).toMatchObject({ seq, kind: 'snapshot', origin: 'import' });

      // The chain verifies end to end, with the payloads hashed again.
      expect((await logs.verify(ref, { payloads: true })).ok).toBe(true);

      // Content that fails the math gate (I8, SEC-034) is refused and nothing is stored: the import's
      // own validation is not the only check, and the commit is refused before it is written.
      const headAfter = await logs.head(ref);
      const broken = structuredClone(envelope) as unknown as {
        doc: { content: Array<{ type: string; content?: unknown[] }> };
      };
      const body = broken.doc.content.find((n) => n.type === 'body')!;
      body.content!.push({
        type: 'paragraph',
        attrs: { id: 'uexp109badlatex01', style: 'Normal' },
        content: [{ type: 'equation', attrs: { latex: '\\def\\x{y}' } }],
      });
      await expect(
        p.plane.replaceContent(ref, broken as unknown as JsonEnvelope, 'alice'),
      ).rejects.toBeDefined();
      expect((await logs.head(ref)).seq).toBe(headAfter.seq);
    });
  },
);
