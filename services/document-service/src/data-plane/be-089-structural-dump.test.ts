/**
 * The structural dump (BE-089). The first test writes commits through the real data plane, then
 * works from the stores alone, as an operator would: the dump replays to the same structure and
 * holds no text run of the source. The property tests cover the pure dump over generated text.
 */
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';
import { MemoryAudit } from './memory-ports.ts';
import { materialise } from './tasks.ts';
import {
  collectTextRuns,
  containsSourceRun,
  DumpRefusedError,
  dumpStructure,
  fillTextRuns,
  runStructuralDump,
  type DumpSource,
} from './structural-dump.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('the structural dump of a document (BE-089)', () => {
  it('replaces every text run by filler of its length, replays to the same structure, and leaves no run of the source', async () => {
    const p = await startPlane();
    planes.push(p);
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    const words = ['Confidential alpha', 'beta secret', 'gamma'];
    for (let i = 0; i < words.length; i++) {
      const r = await a.submit(1, { base: i, steps: [insertText(intro(), words[i]!)] });
      expect(r.t).toBe('sync.ack');
    }
    await p.close();
    planes = [];

    const load = async (r: typeof ref): Promise<DumpSource> => {
      const envelope = (await p.checkpoints.get(r, 0))!;
      const log = await p.stores.logs.read(r, 1, 3);
      return { envelope, commits: log.map((c) => ('steps' in c ? c.steps : [])) };
    };
    const source = await load(ref);
    const audit = new MemoryAudit();
    const dump = await runStructuralDump(ref, load, {
      actor: 'operator-1',
      assigned: () => true,
      audit,
      now: () => 42,
    });

    // Text runs are replaced; the dump holds no run of the source.
    expect(dump.runs).toBeGreaterThan(words.length);
    expect(
      collectTextRuns(dump.envelope.doc).every((t) => [...t].every((c) => c === dump.filler)),
    ).toBe(true);
    expect(containsSourceRun(dump, source)).toBe(false);
    for (const w of words) expect(JSON.stringify(dump)).not.toContain(w);

    // Each run keeps its length, so the dumped steps still replay to the same structure.
    const expected = materialise({
      base: { doc: source.envelope.doc },
      cdm: source.envelope.cdm,
      requires: source.envelope.requires,
      commits: source.commits,
    });
    const replayed = materialise({
      base: { doc: dump.envelope.doc },
      cdm: dump.envelope.cdm,
      requires: dump.envelope.requires,
      commits: dump.commits,
    });
    expect(replayed.doc).toEqual(fillTextRuns(expected.doc, dump.filler));

    // The run is in the audit trail with the operator and the document, and no content.
    const events = await audit.query(ref.tenant, {
      doc: ref.doc,
      kind: 'document.structural_dump',
      limit: 10,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: 'operator-1',
      kind: 'document.structural_dump',
      doc: ref.doc,
      at: 42,
    });
    expect(JSON.stringify(events[0])).not.toContain('Confidential');
  });

  it('refuses a document of a tenant the operator is not assigned to, before reading it', async () => {
    const audit = new MemoryAudit();
    let loaded = false;
    const ref = { tenant: 'tenant-x', doc: 'doc-x' };
    await expect(
      runStructuralDump(
        ref,
        async () => {
          loaded = true;
          return {
            envelope: { cdm: 1, requires: [], doc: { type: 'doc', content: [] } },
            commits: [],
          };
        },
        { actor: 'operator-2', assigned: (tenant) => tenant === 'tenant-y', audit },
      ),
    ).rejects.toBeInstanceOf(DumpRefusedError);
    expect(loaded).toBe(false);
    expect(audit.events).toHaveLength(0);
  });
});

describe('the pure dump (BE-089, property tests)', () => {
  const runsArb = fc.array(fc.string({ minLength: 1, maxLength: 24 }), {
    minLength: 1,
    maxLength: 8,
  });

  it('keeps the length of every run and leaves no source run in the dump', () => {
    fc.assert(
      fc.property(runsArb, (runs) => {
        const source: DumpSource = {
          envelope: {
            cdm: 1,
            requires: [],
            doc: {
              type: 'doc',
              content: runs.map((t) => ({
                type: 'paragraph',
                content: [{ type: 'text', text: t }],
              })),
            },
          } as unknown as DumpSource['envelope'],
          commits: [],
        };
        const dump = dumpStructure(source);
        const dumped = collectTextRuns(dump.envelope.doc);
        expect(dumped.map((t) => t.length)).toEqual(runs.map((t) => t.length));
        for (const r of runs) expect(r.includes(dump.filler)).toBe(false);
        expect(containsSourceRun(dump, source)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
