/**
 * EXP-104: the editable ranges of a protected Word file (`w:permStart` and `w:permEnd`) become
 * regions where they can, and are reported where they cannot. The files are the S11 sample package
 * with a body written here, so each case holds exactly the ranges it names (no corpus file has one).
 *
 * Criteria 1 to 5 are tested on the importer and the patching writer: a region is a direct child of
 * the body that holds whole blocks, has a new identifier and policy `inherit` or `restricted`, no
 * grants, and a body paragraph after it; the file is exported byte for byte when nothing changed,
 * and the markers stay in place when a block of a region is regenerated.
 */
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import { entryData, exportDocx, importDocx, ImportError, readZip, writeZip } from '../src/index.ts';
import type { ZipWriteEntry } from '../src/index.ts';
import { checkR0 } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const SAMPLE = corpusFiles().find((f) => f.name === 'docx4j/sample-docx.docx')!;
const enc = new TextEncoder();
const dec = new TextDecoder();

const p = (text: string, extra = ''): string => `<w:p>${extra}<w:r><w:t>${text}</w:t></w:r></w:p>`;
const start = (id: number, attrs = 'w:edGrp="everyone"'): string =>
  `<w:permStart w:id="${id}" ${attrs}/>`;
const end = (id: number): string => `<w:permEnd w:id="${id}"/>`;
const table = (cell: string): string =>
  `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${cell}</w:tc></w:tr></w:tbl>`;

/** The sample package with `body` as the content of w:body (the final sectPr is kept). */
function docx(body: string): Uint8Array {
  const bytes = readFile(SAMPLE);
  const zip = readZip(bytes);
  const xml = dec.decode(entryData(zip, zip.byName.get('word/document.xml')!));
  const open = xml.indexOf('<w:body>') + '<w:body>'.length;
  const sect = xml.lastIndexOf('<w:sectPr');
  const next = xml.slice(0, open) + body + xml.slice(sect);
  const entries: ZipWriteEntry[] = zip.entries.map((e) =>
    e.name === 'word/document.xml'
      ? { name: e.name, data: enc.encode(next), like: e }
      : { name: e.name, copyOf: e, from: zip },
  );
  return writeZip(entries);
}

const bodyOf = (envelope: { doc: unknown }): JsonNode[] => {
  const doc = envelope.doc as JsonNode;
  return doc.content!.find((n) => n.type === 'body')!.content!;
};
const textOf = (n: JsonNode): string =>
  n.type === 'text' ? String(n.text ?? '') : (n.content ?? []).map(textOf).join('');

describe('EXP-104 criterion 1: whole-block ranges become regions', () => {
  const bytes = docx(
    p('before') + start(1) + p('inside one') + table(p('in a cell')) + end(1) + p('after'),
  );

  it('makes one region, a direct child of the body, that holds the blocks between the markers', async () => {
    const { envelope, report } = await importDocx(bytes);
    const body = bodyOf(envelope);
    expect(body.map((n) => n.type)).toEqual(['paragraph', 'region', 'paragraph']);
    const region = body[1]!;
    expect(region.content!.map((n) => n.type)).toEqual(['paragraph', 'table']);
    expect(textOf(region)).toContain('inside one');
    // A region has an identifier of its own, never one of a paragraph or of the file (w:id 1).
    const id = String(region.attrs!['id']);
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(body.filter((n) => n.attrs!['id'] === id)).toHaveLength(1);
    // The region is not nested, and a body paragraph follows it.
    expect(JSON.stringify(region.content)).not.toContain('"type":"region"');
    expect(body[2]!.type).toBe('paragraph');
    expect(report.some((r) => r.kind === 'editable range')).toBe(true);
  });

  it('writes a new identifier for each import, never the id of the Word range', async () => {
    const a = bodyOf((await importDocx(bytes)).envelope)[1]!.attrs!['id'];
    const b = bodyOf((await importDocx(bytes)).envelope)[1]!.attrs!['id'];
    expect(a).not.toBe(b);
  });

  it('adds a body paragraph when the region ends the body, and does not write it back', async () => {
    const tail = docx(p('before') + start(1) + p('last') + end(1));
    const imported = await importDocx(tail);
    const body = bodyOf(imported.envelope);
    expect(body.map((n) => n.type)).toEqual(['paragraph', 'region', 'paragraph']);
    expect(textOf(body[2]!)).toBe('');
    const out = await exportDocx(imported.envelope, tail, imported.sourceMap, imported.assets);
    expect(checkR0(tail, out.bytes).diff.changed).toEqual([]);
  });

  it('separates two regions that follow each other with a paragraph', async () => {
    const two = docx(start(1) + p('a') + end(1) + start(2) + p('b') + end(2) + p('c'));
    const body = bodyOf((await importDocx(two)).envelope);
    expect(body.map((n) => n.type)).toEqual(['region', 'paragraph', 'region', 'paragraph']);
  });

  it('exports the file byte for byte when nothing changed (R0)', async () => {
    const imported = await importDocx(bytes);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    const r0 = checkR0(bytes, out.bytes);
    expect(r0.diff.changed).toEqual([]);
    expect(r0.diff.missing).toEqual([]);
    expect(r0.diff.added).toEqual([]);
    expect(out.regenerated).toEqual([]);
  });

  it('keeps the markers where they were when a block of the region is written again', async () => {
    const imported = await importDocx(bytes);
    const region = bodyOf(imported.envelope)[1]!;
    const first = region.content![0]!;
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets, {
      regenerate: new Set([String(first.attrs!['id'])]),
    });
    const zip = readZip(out.bytes);
    const xml = dec.decode(entryData(zip, zip.byName.get('word/document.xml')!));
    expect(out.regenerated).toContain(String(first.attrs!['id']));
    expect(xml).toContain('<w:permStart w:id="1" w:edGrp="everyone"/>');
    expect(xml).toContain('<w:permEnd w:id="1"/>');
    expect(xml.indexOf('<w:permStart')).toBeLessThan(xml.indexOf('inside one'));
    expect(xml.indexOf('inside one')).toBeLessThan(xml.indexOf('in a cell'));
    expect(xml.indexOf('in a cell')).toBeLessThan(xml.indexOf('<w:permEnd'));
    expect(xml.indexOf('<w:permEnd')).toBeLessThan(xml.indexOf('after'));
  });
});

describe('EXP-104 criterion 2: a range that does not cover whole blocks is imported as locked and reported', () => {
  it('locks the paragraph that holds a range inside it, and reports where', async () => {
    const inside = docx(
      p('one') +
        `<w:p><w:r><w:t>two </w:t></w:r>${start(7, 'w:ed="alice@example.org"')}<w:r><w:t>open</w:t></w:r>${end(7)}</w:p>` +
        p('three'),
    );
    const { envelope, warnings, report } = await importDocx(inside);
    const body = bodyOf(envelope);
    expect(body.map((n) => n.type)).toEqual(['paragraph', 'region', 'paragraph']);
    expect(body[1]!.attrs!['policy']).toBe('restricted');
    expect(textOf(body[1]!)).toContain('open');
    const w = warnings.find((x) => x.includes('locked region'))!;
    expect(w).toContain('editable range 7');
    expect(w).toContain('body block 2');
    expect(w).toContain('alice@example.org');
    expect(report.find((r) => r.kind === 'editable range')!.blocks.length).toBeGreaterThan(0);
  });

  it('locks the whole table for a column range', async () => {
    const col = docx(
      p('one') +
        table(
          `${start(3, 'w:edGrp="everyone" w:colFirst="0" w:colLast="0"')}${p('cell')}${end(3)}`,
        ) +
        p('three'),
    );
    const body = bodyOf((await importDocx(col)).envelope);
    expect(body.map((n) => n.type)).toEqual(['paragraph', 'region', 'paragraph']);
    expect(body[1]!.attrs!['policy']).toBe('restricted');
    expect(body[1]!.content!.map((n) => n.type)).toEqual(['table']);
  });

  it('locks every block from the one that holds the start to the one that holds the end', async () => {
    const span = docx(
      p('a') +
        `<w:p><w:r><w:t>b </w:t></w:r>${start(4)}<w:r><w:t>b2</w:t></w:r></w:p>` +
        p('c') +
        `<w:p><w:r><w:t>d</w:t></w:r>${end(4)}<w:r><w:t> d2</w:t></w:r></w:p>` +
        p('e'),
    );
    const body = bodyOf((await importDocx(span)).envelope);
    expect(body.map((n) => n.type)).toEqual(['paragraph', 'region', 'paragraph']);
    expect(body[1]!.content).toHaveLength(3);
  });

  it('exports a locked region byte for byte when nothing changed (R0)', async () => {
    const inside = docx(
      `<w:p><w:r><w:t>two </w:t></w:r>${start(7)}<w:r><w:t>open</w:t></w:r>${end(7)}</w:p>` +
        p('x'),
    );
    const imported = await importDocx(inside);
    const out = await exportDocx(imported.envelope, inside, imported.sourceMap, imported.assets);
    expect(checkR0(inside, out.bytes).diff.changed).toEqual([]);
  });
});

describe('EXP-104 criterion 3: regions have no grants and policy inherit', () => {
  it('imports an open region with policy inherit and no grants anywhere in the envelope', async () => {
    const { envelope } = await importDocx(docx(start(1) + p('a') + end(1) + p('b')));
    const region = bodyOf(envelope)[0]!;
    expect(region.attrs!['policy']).toBe('inherit');
    const text = JSON.stringify(envelope);
    expect(text).not.toContain('grant');
    expect(Object.keys(envelope).sort()).toEqual(['cdm', 'doc', 'requires']);
  });
});

describe('EXP-104 criterion 4: overlapping and nested ranges are flattened, with a warning', () => {
  it.each([
    ['nested', start(1) + p('a') + start(2) + p('b') + end(2) + p('c') + end(1) + p('z')],
    ['overlapping', start(1) + p('a') + start(2) + p('b') + end(1) + p('c') + end(2) + p('z')],
    ['identical', start(1) + start(2) + p('a') + end(1) + end(2) + p('z')],
  ])('%s ranges give one region, and the warning names both', async (_name, body) => {
    const { envelope, warnings } = await importDocx(docx(body));
    const top = bodyOf(envelope);
    expect(top.filter((n) => n.type === 'region')).toHaveLength(1);
    expect(JSON.stringify(top[0]!.content)).not.toContain('"type":"region"');
    const w = warnings.find((x) => x.includes('flattened'))!;
    expect(w).toContain('1');
    expect(w).toContain('2');
  });

  it('keeps the file byte for byte after flattening (R0)', async () => {
    const bytes = docx(start(1) + p('a') + start(2) + p('b') + end(1) + p('c') + end(2) + p('z'));
    const imported = await importDocx(bytes);
    const out = await exportDocx(imported.envelope, bytes, imported.sourceMap, imported.assets);
    expect(checkR0(bytes, out.bytes).diff.changed).toEqual([]);
  });
});

describe('EXP-104: ranges that cannot be regions stay preserved, with a warning', () => {
  it('leaves a range that crosses a section break as markers', async () => {
    const sect =
      '<w:p><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr><w:r><w:t>end of section</w:t></w:r></w:p>';
    const bytes = docx(start(1) + p('a') + sect + p('b') + end(1) + p('z'));
    const { envelope, warnings } = await importDocx(bytes);
    expect(bodyOf(envelope).some((n) => n.type === 'region')).toBe(false);
    expect(
      warnings.some((x) => x.includes('editable range 1') && x.includes('section break')),
    ).toBe(true);
  });

  it('leaves a range with no end as a marker', async () => {
    const { envelope, warnings } = await importDocx(docx(p('a') + start(1) + p('b')));
    expect(bodyOf(envelope).some((n) => n.type === 'region')).toBe(false);
    expect(warnings.some((x) => x.includes('editable range 1') && x.includes('no end'))).toBe(true);
  });
});

describe('EXP-104 criterion 5: more than 500 regions fail as a whole', () => {
  const many = (n: number): Uint8Array => {
    let body = '';
    for (let i = 1; i <= n; i++) body += start(i) + p(`r${i}`) + end(i) + p(`gap${i}`);
    return docx(body);
  };

  it('imports 500 regions', async () => {
    const { envelope } = await importDocx(many(500));
    expect(bodyOf(envelope).filter((n) => n.type === 'region')).toHaveLength(500);
  }, 60_000);

  it('refuses 501 with the limit named, and returns no document', async () => {
    const error = await importDocx(many(501)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ImportError);
    expect(String((error as Error).message)).toMatch(/too_many_regions|500 regions|I7/);
  }, 60_000);
});
