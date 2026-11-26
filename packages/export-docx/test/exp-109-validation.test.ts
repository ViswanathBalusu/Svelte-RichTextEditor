/**
 * EXP-109, criteria 3 to 5 as reworded by owner decision 144 (the model cannot hold it, so it is
 * kept as preserved content and reported, A2): what the importer does with a value that fails a
 * grammar, with a combination that invariant I10 forbids, and with content over a limit of I7. The
 * 16 MiB limit is in `import-refusal.test.ts`. The fixtures are `poi/footnotes.docx` and
 * `poi/headerFooter.docx` with a body or part of our own.
 */
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { type JsonNode } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import {
  ImportError,
  importDocx,
  readZip,
  writeZip,
  type ImportReportItem,
  type ZipWriteEntry,
} from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const enc = new TextEncoder();
const file = (name: string) => corpusFiles().find((f) => f.name === name)!;

/** `name` with its parts changed by `edit`, keyed by part name; other parts are copied raw. */
function withParts(name: string, edit: Record<string, (xml: string) => string>): Uint8Array {
  const bytes = readFile(file(name));
  const zip = readZip(bytes);
  const parts = unzipSync(bytes);
  return writeZip(
    zip.entries.map((e): ZipWriteEntry => {
      const f = edit[e.name];
      return f
        ? { name: e.name, data: enc.encode(f(strFromU8(parts[e.name]!))), like: e }
        : { name: e.name, copyOf: e, from: zip };
    }),
  );
}

const bodyOf = (body: string) => ({
  'word/document.xml': (xml: string) => {
    const edited = xml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${body}</w:body>`);
    expect(edited).not.toBe(xml);
    return edited;
  },
});
const withBody = (body: string) => withParts('poi/footnotes.docx', bodyOf(body));

const cell = (c: string) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${c}</w:tc>`;
const line = (r: ImportReportItem[], kind: string) => r.find((i) => i.kind === kind);

function walk(doc: JsonNode, visit: (n: JsonNode, parents: JsonNode[]) => void): void {
  const go = (n: JsonNode, parents: JsonNode[]): void => {
    visit(n, parents);
    for (const c of n.content ?? []) go(c, [...parents, n]);
  };
  go(doc, []);
}

describe('EXP-109 criterion 3: a value that fails its grammar is kept as preserved content, not stored', () => {
  it('a colour, a length and a size that the model refuses are kept and reported, and the result validates', async () => {
    const bytes = withBody(
      '<w:p><w:pPr><w:shd w:val="clear" w:fill="ZZZZZZ"/><w:ind w:left="abc"/>' +
        '<w:spacing w:before="99999999999"/></w:pPr><w:r><w:rPr><w:sz w:val="9999999"/>' +
        '<w:color w:val="nothex"/></w:rPr><w:t>x</w:t></w:r></w:p>',
    );
    const imported = await importDocx(bytes);
    expect(validate(imported.envelope, { attachedAssets: imported.assets.ids() }).valid).toBe(true);
    const item = line(imported.report, 'formatting the editor does not show');
    expect(item?.action).toBe('preserved');
    expect(item?.count).toBeGreaterThanOrEqual(1);
    expect(item?.blocks.length).toBeGreaterThanOrEqual(1);
    // None of the refused values reached a modelled attribute or mark: they are in the residue only.
    walk(imported.envelope.doc as JsonNode, (n) => {
      const { preserved: _kept, ...attrs } = n.attrs ?? {};
      const marks = (n.marks ?? []).filter((m) => m.type !== 'preserved');
      const modelled = JSON.stringify({ attrs, marks });
      for (const bad of ['ZZZZZZ', 'nothex', '99999999999', '9999999'])
        expect(modelled, `${n.type} ${bad}`).not.toContain(bad);
    });
    expect(JSON.stringify(imported.envelope.doc)).toContain('ZZZZZZ');
  });
});

describe('EXP-109 criterion 4: combinations that I10 forbids are kept as preserved content', () => {
  it('a page break in a table cell stays a preserved atom, and no page break node is made in a cell', async () => {
    const imported = await importDocx(
      withBody(
        `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr>${cell('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')}</w:tr></w:tbl><w:p/>`,
      ),
    );
    expect(line(imported.report, 'break')?.action).toBe('preserved');
    walk(imported.envelope.doc as JsonNode, (n, parents) => {
      if (n.type === 'break' && n.attrs?.['kind'] !== undefined)
        expect(parents.some((p) => p.type === 'table_cell')).toBe(false);
    });
    expect(validate(imported.envelope, { attachedAssets: imported.assets.ids() }).valid).toBe(true);
  });

  it('a table in a footnote is kept with the footnote, which is preserved whole', async () => {
    const bytes = withParts('poi/footnotes.docx', {
      ...bodyOf('<w:p><w:r><w:footnoteReference w:id="1"/></w:r></w:p>'),
      'word/footnotes.xml': (x) =>
        x.replace(
          /(<w:footnote\b[^>]*w:id="1"[^>]*>)([\s\S]*?)(<\/w:footnote>)/,
          '$1$2<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:p/>$3',
        ),
    });
    const imported = await importDocx(bytes);
    expect(line(imported.report, 'footnote')?.action).toBe('preserved');
    let tables = 0;
    walk(imported.envelope.doc as JsonNode, (n) => {
      if (n.type === 'table') tables++;
    });
    expect(tables, 'no table node is made from the footnote').toBe(0);
    expect(validate(imported.envelope, { attachedAssets: imported.assets.ids() }).valid).toBe(true);
  });

  it('a table in a header is kept as a preserved block and reported', async () => {
    const source = readFile(file('poi/headerFooter.docx'));
    const header = [...readZip(source).byName.keys()].find((n) =>
      /^word\/header\d*\.xml$/.test(n),
    )!;
    const bytes = withParts('poi/headerFooter.docx', {
      [header]: (x) =>
        x.replace(
          /<\/w:hdr>\s*$/,
          '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:p/></w:hdr>',
        ),
    });
    const imported = await importDocx(bytes);
    expect(line(imported.report, 'table in a header or footer')?.action).toBe('preserved');
    expect(validate(imported.envelope, { attachedAssets: imported.assets.ids() }).valid).toBe(true);
  });
});

describe('EXP-109 criterion 5: content over a limit of I7', () => {
  const ranges = (n: number) =>
    Array.from(
      { length: n },
      (_, i) =>
        `<w:p><w:permStart w:id="${i}" w:edGrp="everyone"/><w:r><w:t>r${i}</w:t></w:r><w:permEnd w:id="${i}"/></w:p>`,
    ).join('');
  const regionsOf = (doc: JsonNode): number => {
    let n = 0;
    walk(doc, (x) => {
      if (x.type === 'region') n++;
    });
    return n;
  };

  it('500 editable ranges are 500 regions and import', async () => {
    const imported = await importDocx(withBody(ranges(500)));
    expect(regionsOf(imported.envelope.doc as JsonNode)).toBe(500);
  });

  it('501 editable ranges fail the import as a whole and name the limit, and no document is returned', async () => {
    const error = await importDocx(withBody(ranges(501))).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ImportError);
    expect((error as Error).message).toMatch(/too_many_regions/);
    expect((error as Error).message).toMatch(/501 regions, more than 500/);
  });

  it('a table of 64 columns is kept as a preserved block and reported, not refused', async () => {
    const columns = 64;
    const imported = await importDocx(
      withBody(
        `<w:tbl><w:tblPr/><w:tblGrid>${'<w:gridCol w:w="100"/>'.repeat(columns)}</w:tblGrid><w:tr>${Array.from({ length: columns }, () => cell('<w:p/>')).join('')}</w:tr></w:tbl><w:p/>`,
      ),
    );
    expect(line(imported.report, 'table')?.action).toBe('preserved');
    let tables = 0;
    walk(imported.envelope.doc as JsonNode, (n) => {
      if (n.type === 'table') tables++;
    });
    expect(tables).toBe(0);
    expect(validate(imported.envelope, { attachedAssets: imported.assets.ids() }).valid).toBe(true);
  });

  it('a table of 63 columns is a table', async () => {
    const columns = 63;
    const imported = await importDocx(
      withBody(
        `<w:tbl><w:tblPr/><w:tblGrid>${'<w:gridCol w:w="100"/>'.repeat(columns)}</w:tblGrid><w:tr>${Array.from({ length: columns }, () => cell('<w:p/>')).join('')}</w:tr></w:tbl><w:p/>`,
      ),
    );
    let tables = 0;
    walk(imported.envelope.doc as JsonNode, (n) => {
      if (n.type === 'table') tables++;
    });
    expect(tables).toBe(1);
  });
});
