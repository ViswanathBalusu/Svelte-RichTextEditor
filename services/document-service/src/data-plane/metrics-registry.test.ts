/**
 * The data plane's metrics against the registry and the content rule (BE-086 criteria 3 and 4).
 *
 * Criterion 3: the label of `dep_rejections_total` is a code of the registry PRO-038, and every code
 * the authority can answer with is in that registry. Criterion 4: no label or value of any series
 * holds document text, a field value or a token. The tests drive a real data plane over in-memory
 * ports with WebSocket clients, put canary text into the document and into a rejected commit, and
 * scan the scrape.
 */
import { DEFAULT_ACTION } from '@docedit/authority';
import { definition } from '@docedit/protocol';
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
async function plane(...args: Parameters<typeof startPlane>): Promise<Plane> {
  const p = await startPlane(...args);
  planes.push(p);
  return p;
}
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

/** The label pairs of every series line of a scrape, one object per series. */
function labelsOf(scrape: string): Array<Record<string, string>> {
  return scrape
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((line) => {
      const open = line.indexOf('{');
      if (open < 0) return {};
      const close = line.indexOf('}', open);
      const out: Record<string, string> = {};
      for (const m of line.slice(open + 1, close).matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g))
        out[m[1]!] = m[2]!;
      return out;
    });
}

describe('rejection labels are registry codes (BE-086 criterion 3)', () => {
  it('finds every rejection code the authority answers with in the registry PRO-038', () => {
    const emitted = Object.keys(DEFAULT_ACTION);
    expect(emitted.length).toBeGreaterThan(0);
    for (const code of emitted) expect(definition.ERROR_CODES, code).toContain(code);
  });

  it('labels the rejections a data plane counts with codes of the registry', async () => {
    const node = `node-${uuid7()}`;
    const p = await plane({ node });
    const doc = await p.createDocument();
    const owner = await p.client('alice', { [doc]: 'owner' });
    const viewer = await p.client('dave', { [doc]: 'viewer' });
    await owner.open(1, doc);
    await viewer.open(1, doc);

    const denied = await viewer.submit(1, { base: 0, steps: [insertText(intro(), 'x')] });
    expect(denied.d).toMatchObject({ code: 'permission_denied' });

    const scrape = p.plane.metrics();
    const codes = labelsOf(scrape)
      .filter((l) => 'code' in l && l['tenant'] === p.tenant)
      .map((l) => l['code']!);
    expect(codes).toContain('permission_denied');
    for (const c of codes) expect(definition.ERROR_CODES, c).toContain(c);
  }, 30_000);
});

describe('no series holds content, field values or tokens (BE-086 criterion 4)', () => {
  it('keeps document text and a rejected commit text out of every label and value', async () => {
    const node = `node-${uuid7()}`;
    const p = await plane({ node });
    const doc = await p.createDocument();
    const owner = await p.client('alice', { [doc]: 'owner' });
    const viewer = await p.client('dave', { [doc]: 'viewer' });
    await owner.open(1, doc);
    await viewer.open(1, doc);

    const documentText = 'CANARY-DOC-TEXT-7f3a9c';
    const rejectedText = 'CANARY-REJECTED-TEXT-41be0d';
    const stored = await owner.submit(1, {
      base: 0,
      steps: [insertText(intro(), documentText)],
    });
    expect(stored.t).toBe('sync.ack');
    const denied = await viewer.submit(1, {
      base: 1,
      steps: [insertText(intro(), rejectedText)],
    });
    expect(denied.d).toMatchObject({ code: 'permission_denied' });

    const scrape = p.plane.metrics();
    expect(scrape).not.toContain(documentText);
    expect(scrape).not.toContain(rejectedText);
    // No bearer token (a JWT begins with `eyJ`), and no signature-like secret.
    expect(scrape).not.toMatch(/eyJ[A-Za-z0-9_-]{5,}/);

    // Every label value is an identifier or a code (the histogram bucket bound `le` is a number).
    for (const labels of labelsOf(scrape))
      for (const [name, value] of Object.entries(labels))
        if (name !== 'le') expect(value, `${name}=${value}`).toMatch(/^[A-Za-z0-9_.-]+$/);
  }, 30_000);
});
