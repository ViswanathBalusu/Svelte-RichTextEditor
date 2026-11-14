/**
 * SEC-034 criterion 1 (lane SEC-027-039, round 2 fix): the document service builds its rooms with
 * the math gate of `@docedit/export-latex` (`mathGateReason`), so invariant I8 holds at commit time
 * (03 §8; 09 §6.3). A real commit over the wire that brings `\def` or `\input` in a `latex`
 * attribute is refused with `invalid_op` and nothing is stored; a formula the gate allows is stored.
 * The replacement of the content (a snapshot commit) passes the same gate. The data plane runs
 * over the in-memory stores; no PostgreSQL and no browser is used.
 */
import type { JsonEnvelope } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE_JSON, baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { REQUIRES, startPlane, type Plane } from '../../test/data-plane/support.ts';
import { RequestRefused } from './wire.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

/** A step that inserts an inline equation with this LaTeX at `pos`. */
const insertEquation = (pos: number, latex: string): Record<string, unknown> => ({
  stepType: 'replace',
  from: pos,
  to: pos,
  slice: { content: [{ type: 'equation', attrs: { latex } }] },
});

type JsonNodeish = { type: string; attrs?: Record<string, unknown>; content?: JsonNodeish[] };

/** The node with this identifier in a JSON document. */
function paragraph(n: JsonNodeish, id: string): JsonNodeish | null {
  if (n.attrs?.['id'] === id) return n;
  for (const c of n.content ?? []) {
    const found = paragraph(c, id);
    if (found) return found;
  }
  return null;
}

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function opened() {
  const p = await startPlane();
  planes.push(p);
  const doc = await p.createDocument();
  const alice = await p.client('alice', { [doc]: 'owner' });
  await alice.open(1, doc);
  return { p, doc, ref: p.ref(doc), alice };
}

/**
 * The definitions and primitives of SEC-034 criterion 1, the same corpus as
 * `tests/security/test/math-commit-gate.test.ts` (which runs it through a bare room and the converter).
 */
const DEFINITIONS: readonly string[] = [
  '\\def\\a{x}',
  '\\let\\a\\b',
  '\\csname a\\endcsname',
  '\\catcode`\\@=11',
  '\\input file',
  '\\include file',
  '\\openin1=file',
  '\\write18{ls}',
  '\\write 1{x}',
  '\\directlua{os.exit()}',
  '\\special{x}',
  '\\immediate x',
  '\\newcommand{\\a}{x}',
  '^^5cinput file',
  '^^5Cinput file',
  '^^^^005cinput file',
  '\\def\\a{x}\\a',
  '\\input{/etc/passwd}',
];

describe('the document service checks math at commit time (SEC-034 criterion 1)', () => {
  it('refuses each definition or primitive of the corpus with invalid_op (I8) and stores nothing', async () => {
    const { p, ref, alice } = await opened();
    for (const latex of DEFINITIONS) {
      const r = await alice.submit(1, { base: 0, steps: [insertEquation(intro(), latex)] });
      expect(r.t, latex).toBe('sync.reject');
      expect(r.d, latex).toMatchObject({ code: 'invalid_op' });
      const message = String((r.d as { message?: unknown }).message);
      expect(message, latex).toContain('I8');
      expect(message, latex).toContain('math gate');
    }
    expect((await p.stores.logs.head(ref)).seq).toBe(0);
  });

  it('stores a commit whose equation the gate allows', async () => {
    const { p, ref, alice } = await opened();
    const r = await alice.submit(1, { base: 0, steps: [insertEquation(intro(), '\\frac{a}{b}')] });
    expect(r.t).toBe('sync.ack');
    expect((await p.stores.logs.head(ref)).seq).toBe(1);
  });

  it('refuses a content replacement that brings \\def, through the same gate', async () => {
    const { p, ref } = await opened();
    const doc = structuredClone(BASE_JSON) as unknown as JsonNodeish;
    paragraph(doc, 'pIntro0000000001')!.content!.push({
      type: 'equation',
      attrs: { latex: '\\def\\x{1}\\x' },
    });
    const envelope = { cdm: 1, requires: [...REQUIRES], doc } as unknown as JsonEnvelope;
    const refused = await p.plane.replaceContent(ref, envelope, 'alice').then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(RequestRefused);
    expect((refused as RequestRefused).rejection).toMatchObject({ code: 'invalid_op' });
    expect((refused as RequestRefused).rejection.reason).toContain('math gate');
    expect((await p.stores.logs.head(ref)).seq).toBe(0);
  });
});
