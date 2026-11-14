/**
 * EXP-099, criteria 3 to 5, beyond the layer tests (test/layers.test.ts): a document type
 * declaration is refused in every XML part the importer reads, an external relationship is kept as
 * data and never followed (no request is made while importing), and a macro-enabled package is
 * refused with a clear message. The ZIP limits are in layers.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { utf8 } from '@docedit/model';
import { entryData, importDocx, readFragment, readZip, writeZip } from '../src/index.ts';
import { ImportError } from '../src/import.ts';
import { corpusFiles, readFile } from './corpus.ts';

const base = (): Uint8Array =>
  readFile(corpusFiles().find((x) => x.name === 'poi/WordWithAttachments.docx')!);

/** A copy of the package with one part replaced, or with extra text appended to one part. */
function rewrite(bytes: Uint8Array, name: string, change: (xml: string) => string): Uint8Array {
  const zip = readZip(bytes);
  const entries = zip.entries.map((e) => {
    const data = entryData(zip, e);
    if (e.name !== name) return { name: e.name, data };
    return { name: e.name, data: utf8(change(new TextDecoder().decode(data))) };
  });
  return writeZip(entries);
}

const DTD = '<!DOCTYPE r [<!ENTITY a "b">]>';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EXP-099: refusals and external targets', () => {
  it.each(['word/document.xml', 'word/styles.xml', 'word/settings.xml'])(
    'refuses a document type declaration in %s',
    async (part) => {
      const bad = rewrite(base(), part, (xml) =>
        xml.replace(/^(<\?xml[^>]*\?>)?/, (m) => `${m}${DTD}`),
      );
      await expect(importDocx(bad)).rejects.toThrow(ImportError);
    },
  );

  it('keeps an external relationship as data and makes no request while importing', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', (...args: unknown[]) => {
      calls.push(args);
      throw new Error('a network request was made');
    });
    const withExternal = rewrite(base(), 'word/_rels/document.xml.rels', (xml) =>
      xml.replace(
        '</Relationships>',
        '<Relationship Id="rId900" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/picture.png" TargetMode="External"/>' +
          '<Relationship Id="rId901" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://example.invalid/template.dotm" TargetMode="External"/>' +
          '</Relationships>',
      ),
    );
    const imported = await importDocx(withExternal);
    expect(calls).toEqual([]);
    // The fixture's external hyperlinks are kept as data, in their preserved fragments.
    const external = new Set<string>();
    for (const asset of imported.assets.all()) {
      if (asset.role !== 'fragment') continue;
      for (const r of readFragment(asset.bytes).meta.rels) if (r.external) external.add(r.target);
    }
    expect([...external]).toEqual(expect.arrayContaining(['http://www.google.com']));
  });

  it('refuses a macro-enabled main document without reading its content', async () => {
    const zip = readZip(base());
    const ct = new TextDecoder().decode(entryData(zip, zip.byName.get('[Content_Types].xml')!));
    const macro = ct.replace(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
      'application/vnd.ms-word.document.macroEnabled.main+xml',
    );
    expect(macro).not.toBe(ct);
    const bad = rewrite(base(), '[Content_Types].xml', () => macro);
    await expect(importDocx(bad)).rejects.toThrow(/macro-enabled files are refused/);
  });
});
