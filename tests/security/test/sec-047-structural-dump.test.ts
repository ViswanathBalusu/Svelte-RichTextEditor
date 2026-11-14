/**
 * SEC-047 criterion 4 (lane U-SEC-033-048): the structural dump of BE-089 holds no text run of the
 * source. Canary strings are typed into a document through the real data plane (memory stores, the
 * same plane as services/document-service/src/data-plane/be-089-structural-dump.test.ts); the dump
 * is built from the stores alone, and it is searched for every canary, for every text run of the
 * source, and for each canary's words. A control shows the source does hold the canaries, so the
 * search is not vacuous.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../../services/document-service/test/data-plane/client.ts';
import {
  startPlane,
  type Plane,
} from '../../../services/document-service/test/data-plane/support.ts';
import { MemoryAudit } from '../../../services/document-service/src/data-plane/memory-ports.ts';
import {
  collectTextRuns,
  containsSourceRun,
  runStructuralDump,
  type DumpSource,
} from '../../../services/document-service/src/data-plane/structural-dump.ts';

const CANARIES = [
  'U-SEC-033-048 canary alpha confidential',
  'U-SEC-033-048 canary beta 7f3a9c',
  'U-SEC-033-048 canary gamma pricing',
] as const;

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('SEC-047 criterion 4: the structural dump holds no canary of the source', () => {
  it('finds no canary, no source run and no canary word in the dump or its audit record', async () => {
    const p = await startPlane();
    planes.push(p);
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    for (let i = 0; i < CANARIES.length; i++) {
      const r = await a.submit(1, { base: i, steps: [insertText(intro(), CANARIES[i]!)] });
      expect(r.t).toBe('sync.ack');
    }
    await p.close();
    planes = [];

    const load = async (r: typeof ref): Promise<DumpSource> => {
      const envelope = (await p.checkpoints.get(r, 0))!;
      const log = await p.stores.logs.read(r, 1, CANARIES.length);
      return { envelope, commits: log.map((c) => ('steps' in c ? c.steps : [])) };
    };
    const source = await load(ref);
    const audit = new MemoryAudit();
    const dump = await runStructuralDump(ref, load, {
      actor: 'operator-sec-047',
      assigned: () => true,
      audit,
      now: () => 47,
    });

    // Control: the source holds the canaries, so the search below is not vacuous.
    const sourceText = JSON.stringify(source);
    for (const c of CANARIES) expect(sourceText).toContain(c);

    const dumpText = JSON.stringify(dump);
    for (const c of CANARIES) {
      expect(dumpText).not.toContain(c);
      for (const word of c.split(' ')) {
        // A word of three letters or more is also searched for, so a partial copy is caught.
        if (word.length >= 3) expect(dumpText).not.toContain(word);
      }
    }
    expect(containsSourceRun(dump, source)).toBe(false);
    // Every run of the source of six characters or more (shorter runs also occur in keys and markup).
    for (const run of collectTextRuns(source.envelope.doc)) {
      if (run.length >= 6) expect(dumpText).not.toContain(run);
    }

    const events = await audit.query(ref.tenant, {
      doc: ref.doc,
      kind: 'document.structural_dump',
      limit: 10,
    });
    expect(events).toHaveLength(1);
    const auditText = JSON.stringify(events);
    for (const c of CANARIES) expect(auditText).not.toContain(c);
  });
});
