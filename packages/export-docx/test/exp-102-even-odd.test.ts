/**
 * EXP-102, criterion 1 (even-page variants): a file whose settings.xml holds w:evenAndOddHeaders
 * gets `differentOddEven` on its page setups, so that the even-page header and footer stories
 * can be switched on in the editor. Checked on two corpus files that hold the setting
 * (python-docx/doc-odd-even-hdrs.docx and poi/PageSpecificHeadFoot.docx), and on a file that
 * does not hold it (the flag must stay off there).
 */
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import { importDocx } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const corpus = new Map(corpusFiles().map((f) => [f.name, f]));

async function pageSetupsOf(name: string): Promise<JsonNode[]> {
  const file = corpus.get(name);
  if (!file) throw new Error(`missing corpus file ${name}`);
  const imported = await importDocx(readFile(file));
  const out: JsonNode[] = [];
  const stack: JsonNode[] = [imported.envelope.doc as JsonNode];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'page_setup') out.push(n);
    for (const c of n.content ?? []) stack.push(c);
  }
  return out;
}

describe('EXP-102 criterion 1: even-page variants follow w:evenAndOddHeaders', () => {
  for (const name of ['python-docx/doc-odd-even-hdrs.docx', 'poi/PageSpecificHeadFoot.docx']) {
    it(`sets differentOddEven on every page setup of ${name}`, async () => {
      const setups = await pageSetupsOf(name);
      expect(setups.length).toBeGreaterThan(0);
      for (const ps of setups)
        expect(ps.attrs?.['differentOddEven'], String(ps.attrs?.['id'])).toBe(true);
      // The even-page header story is named by the page setup, so it can be switched on.
      expect(setups.some((ps) => typeof ps.attrs?.['headerEven'] === 'string')).toBe(true);
    });
  }

  it('keeps differentOddEven off where the file does not turn it on', async () => {
    const setups = await pageSetupsOf('docx4j/sections_multiple.docx');
    expect(setups.length).toBeGreaterThan(0);
    for (const ps of setups) expect(ps.attrs?.['differentOddEven']).not.toBe(true);
  });
});
