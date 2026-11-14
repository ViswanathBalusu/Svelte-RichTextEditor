/**
 * EXP-100, criterion 5 (document language, part of it): the language of the run defaults in
 * `w:docDefaults` of styles.xml becomes `settings.lang`. The test reads styles.xml of every corpus
 * file itself and compares it with the imported settings node. The other part of criterion 5
 * (the defaults as the default paragraph style) is not tested here and stays open in the story.
 * Run in Node.js with vitest.
 */
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import { entryData, importDocx, readZip } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

/** The w:val of the w:lang in w:docDefaults, read from the XML text of styles.xml. */
function docDefaultsLang(xml: string): string | undefined {
  const m = /<w:docDefaults>(?:(?!<\/w:docDefaults>)[\s\S])*?<w:lang\b[^>]*?\bw:val="([^"]+)"/.exec(
    xml,
  );
  return m ? m[1] : undefined;
}

function settingsOf(doc: JsonNode): JsonNode | undefined {
  const stack: JsonNode[] = [doc];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'settings') return n;
    for (const c of n.content ?? []) stack.push(c);
  }
  return undefined;
}

describe('EXP-100 criterion 5: the document language of w:docDefaults becomes settings.lang', () => {
  it('matches the docDefaults language of every corpus file that has one', async () => {
    let matched = 0;
    for (const file of corpusFiles()) {
      const bytes = readFile(file);
      const zip = readZip(bytes);
      const entry = zip.entries.find((e) => e.name === 'word/styles.xml');
      if (!entry) continue;
      const expected = docDefaultsLang(new TextDecoder().decode(entryData(zip, entry)));
      if (expected === undefined) continue;
      const imported = await importDocx(bytes);
      const settings = settingsOf(imported.envelope.doc as JsonNode);
      expect(settings, file.name).toBeDefined();
      expect(settings!.attrs?.['lang'], file.name).toBe(expected);
      matched++;
    }
    expect(matched).toBeGreaterThan(0);
  });

  it('reads en-US from poi/sample.docx, whose docDefaults carry w:lang en-US', async () => {
    const file = corpusFiles().find((f) => f.name === 'poi/sample.docx');
    if (!file) throw new Error('missing corpus file poi/sample.docx');
    const imported = await importDocx(readFile(file));
    expect(settingsOf(imported.envelope.doc as JsonNode)?.attrs?.['lang']).toBe('en-US');
  });
});
