/**
 * The direct DOCX writer (EXP-090 to EXP-096; owner decision 1's projection exports). Every
 * written package is checked as a package (every part parses, no document type declaration, every
 * relationship and every `r:` reference resolves, every part has a content type), then by feature:
 * styles and formatting, numbering (the labels the file's numbering produces under ECMA-376's rules
 * equal the model's), tables and pictures, sections, notes and fields, suggestions in the three
 * modes, regions and protection, form fields and their custom XML part, and projections. Each
 * written file is read back by the importer, which validates it (EXP-109), and its text survives.
 * The corpus is written as projections too.
 */
import { describe, expect, it } from 'vitest';
import {
  computeLabels,
  dateFieldText,
  formatNumber,
  type JsonNode,
  type TreeNode,
} from '@docedit/model';
import { validate } from '@docedit/model/validate';
import {
  danglingTargets,
  entryData,
  importDocx,
  parseXml,
  readZip,
  type XmlElement,
} from '../src/index.ts';
import {
  parseContentTypes,
  parseRelationships,
  referencedRelIds,
  relsPartName,
} from '../src/opc.ts';
import { writeDocx } from '../src/writer.ts';
import { corpusFiles, readFile } from './corpus.ts';
import { HOSTILE, writerDocs, type WriterDoc } from './writer-docs.ts';

const docs = await writerDocs();
const doc = (name: string): WriterDoc => docs.find((d) => d.name === name)!;

interface Inspected {
  parts: Map<string, string>;
  problems: string[];
}

/** Checks a package as a package and returns its XML parts as text. */
function inspect(bytes: Uint8Array): Inspected {
  const zip = readZip(bytes);
  const problems: string[] = [];
  const parts = new Map<string, string>();
  const ct = parseContentTypes(entryData(zip, zip.byName.get('[Content_Types].xml')!));
  for (const e of zip.entries) {
    const data = entryData(zip, e);
    if (/\.(xml|rels)$/.test(e.name)) {
      const text = new TextDecoder().decode(data);
      parts.set(e.name, text);
      if (/<!DOCTYPE/i.test(text)) problems.push(`${e.name} has a document type declaration`);
      try {
        parseXml(data);
      } catch (err) {
        problems.push(`${e.name} does not parse: ${(err as Error).message}`);
      }
    }
    if (e.name === '[Content_Types].xml') continue;
    const ext = e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase();
    if (!ct.overrides.has(e.name.toLowerCase()) && !ct.defaults.has(ext))
      problems.push(`${e.name} has no content type`);
  }
  problems.push(...danglingTargets(zip).map((d) => `dangling relationship ${d}`));
  for (const [name, text] of parts) {
    if (name.endsWith('.rels') || name === '[Content_Types].xml') continue;
    const refs = referencedRelIds(parseXml(new TextEncoder().encode(text)).root);
    if (!refs.size) continue;
    const relsName = relsPartName(name);
    const rels = parseRelationships(
      name,
      zip.byName.has(relsName) ? entryData(zip, zip.byName.get(relsName)!) : undefined,
    );
    for (const id of refs)
      if (!rels.byId.has(id))
        problems.push(`${name} refers to ${id}, which is not a relationship of it`);
    for (const r of rels.list)
      if (r.external && !r.type.endsWith('/hyperlink'))
        problems.push(`${name} has an external ${r.type} relationship`);
  }
  return { parts, problems };
}

const all = (root: XmlElement, local: string): XmlElement[] => {
  const out: XmlElement[] = [];
  const stack = [root];
  while (stack.length) {
    const e = stack.pop()!;
    if (e.local === local) out.push(e);
    for (let i = e.children.length - 1; i >= 0; i--) {
      const c = e.children[i]!;
      if (c.kind === 'element') stack.push(c);
    }
  }
  return out;
};
const att = (e: XmlElement | undefined, local: string): string | undefined =>
  e?.attrs.find((a) => a.local === local)?.value;
const kid = (e: XmlElement | undefined, local: string): XmlElement | undefined =>
  e?.children.find((c): c is XmlElement => c.kind === 'element' && c.local === local);
const xml = (text: string): XmlElement => parseXml(new TextEncoder().encode(text)).root;

/** The text of every `w:t` (and `w:delText`) in a part, in order. */
const textOfPart = (text: string): string =>
  [...all(xml(text), 't'), ...all(xml(text), 'delText')]
    .sort((a, b) => a.start - b.start)
    .map((t) => t.children.map((c) => (c.kind === 'text' ? c.value : '')).join(''))
    .join('');

/**
 * The labels a numbering part gives the numbered paragraphs of a document part, under ECMA-376's
 * rules: one count per abstract numbering, a start override applied when its `w:num` is first
 * used, `w:lvlRestart` (absent: after any higher level; 0: never), `w:isLgl` and `w:lvlText`.
 */
function wordLabels(numberingXml: string, documentXml: string): string[] {
  const n = xml(numberingXml);
  const abstracts = new Map<
    string,
    Array<{ start: number; fmt: string; text: string; restart: number | null; legal: boolean }>
  >();
  for (const a of all(n, 'abstractNum')) {
    const levels = all(a, 'lvl').map((l) => ({
      start: Number(att(kid(l, 'start'), 'val') ?? 1),
      fmt: att(kid(l, 'numFmt'), 'val') ?? 'decimal',
      text: att(kid(l, 'lvlText'), 'val') ?? '',
      restart: kid(l, 'lvlRestart') ? Number(att(kid(l, 'lvlRestart'), 'val')) : null,
      legal: !!kid(l, 'isLgl'),
    }));
    abstracts.set(att(a, 'abstractNumId')!, levels);
  }
  const nums = new Map<string, { abstract: string; overrides: Map<number, number> }>();
  for (const m of all(n, 'num')) {
    const overrides = new Map<number, number>();
    for (const o of all(m, 'lvlOverride'))
      overrides.set(Number(att(o, 'ilvl')), Number(att(kid(o, 'startOverride'), 'val')));
    nums.set(att(m, 'numId')!, { abstract: att(kid(m, 'abstractNumId'), 'val')!, overrides });
  }
  const counters = new Map<string, number[]>();
  const used = new Set<string>();
  const out: string[] = [];
  for (const p of all(xml(documentXml), 'p')) {
    const numPr = kid(kid(p, 'pPr'), 'numPr');
    if (!numPr) continue;
    const level = Number(att(kid(numPr, 'ilvl'), 'val') ?? 0);
    const num = nums.get(att(kid(numPr, 'numId'), 'val') ?? '')!;
    const levels = abstracts.get(num.abstract)!;
    let c = counters.get(num.abstract);
    if (!c) counters.set(num.abstract, (c = levels.map((l) => l.start - 1)));
    const numId = att(kid(numPr, 'numId'), 'val')!;
    if (!used.has(numId)) {
      used.add(numId);
      for (const [k, v] of num.overrides) c[k] = v - 1;
    }
    c[level]!++;
    for (let k = level + 1; k < levels.length; k++) {
      const r = levels[k]!.restart;
      if (r === null || (r > 0 && level < r)) c[k] = levels[k]!.start - 1;
    }
    const lv = levels[level]!;
    out.push(
      lv.fmt === 'bullet'
        ? lv.text
        : lv.text.replace(/%([1-9])/g, (_, d: string) => {
            const k = Number(d) - 1;
            const l = levels[k];
            if (!l) return '';
            if (l.fmt === 'none' && k === level) return '';
            return formatNumber(c[k]!, lv.legal && k < level ? 'decimal' : l.fmt);
          }),
    );
  }
  return out;
}

describe('the direct DOCX writer', () => {
  it('is given valid documents (the projection excepted)', () => {
    for (const d of docs.filter((x) => x.valid)) {
      const r = validate(d.envelope, { attachedAssets: d.assets.ids() });
      expect(r.violations.map((v) => `${d.name}: ${v.invariant} ${v.path} ${v.message}`)).toEqual(
        [],
      );
    }
  });

  it.each(docs.map((d) => [d.name, d] as const))(
    'writes a well-formed package for %s, read back by the importer',
    async (_n, d) => {
      const out = await writeDocx(d.envelope, d.assets, {
        instant: '2026-11-06T09:30:00.000Z',
        timeZone: 'Europe/London',
        title: `The title ${HOSTILE}`,
      });
      const { parts, problems } = inspect(out.bytes);
      expect(problems).toEqual([]);
      const text =
        textOfPart(parts.get('word/document.xml')!) +
        [...parts]
          .filter(([k]) => /footnotes|header|footer/.test(k))
          .map(([, v]) => textOfPart(v))
          .join('');
      for (const t of d.texts) expect(text).toContain(t);
      // The importer validates what it reads (EXP-109), so this is also validate() on the round trip.
      const back = await importDocx(out.bytes);
      expect(back.envelope.doc.content?.some((n) => n.type === 'body')).toBe(true);
    },
  );

  it('escapes every string: hostile text, alternative text, style names and titles arrive as written', async () => {
    const out = await writeDocx(doc('text-styles').envelope, doc('text-styles').assets);
    const { parts } = inspect(out.bytes);
    expect(textOfPart(parts.get('word/document.xml')!)).toContain(HOSTILE);
    const styles = xml(parts.get('word/styles.xml')!);
    expect(all(styles, 'name').map((e) => att(e, 'val'))).toContain(`Plain ${HOSTILE}`);
    const tp = await writeDocx(doc('tables-pictures').envelope, doc('tables-pictures').assets);
    const docPr = all(xml(inspect(tp.bytes).parts.get('word/document.xml')!), 'docPr').map((e) =>
      att(e, 'descr'),
    );
    expect(docPr).toContain(`A picture ${HOSTILE}`);
  });

  it('writes the base values as document defaults, styles with Word built-in names, and explicit toggles under a character style', async () => {
    const out = await writeDocx(doc('text-styles').envelope, doc('text-styles').assets, {
      defaultFont: 'Carlito',
    });
    const { parts } = inspect(out.bytes);
    const styles = xml(parts.get('word/styles.xml')!);
    const defaults = kid(styles, 'docDefaults')!;
    expect(att(all(defaults, 'sz')[0], 'val')).toBe('22');
    expect(att(all(defaults, 'rFonts')[0], 'ascii')).toBe('Carlito');
    expect(all(defaults, 'widowControl').length).toBe(1);
    expect(att(all(defaults, 'spacing')[0], 'line')).toBe('240');
    const byId = new Map(all(styles, 'style').map((s) => [att(s, 'styleId'), s]));
    expect(att(kid(byId.get('Heading1'), 'name'), 'val')).toBe('heading 1');
    expect(att(byId.get('Normal'), 'default')).toBe('1');
    // A root paragraph style is based on the default style (layer 1 of 03 §6).
    expect(att(kid(byId.get('Plain'), 'basedOn'), 'val')).toBe('Normal');
    const runs = all(xml(parts.get('word/document.xml')!), 'r');
    const styled = runs.filter((r) => att(kid(kid(r, 'rPr'), 'rStyle'), 'val') === 'Remark');
    expect(styled.length).toBe(2);
    // The model says: the character style's bold, then the mark's `false`. Word would XOR styles, so both are explicit.
    expect(styled.map((r) => att(kid(kid(r, 'rPr'), 'b'), 'val') ?? 'on')).toEqual(['on', '0']);
    expect(styled.every((r) => !!kid(kid(r, 'rPr'), 'i'))).toBe(true);
  });

  it('writes numbering whose labels, under ECMA-376, equal the shared algorithm (EXP-090)', async () => {
    const d = doc('numbering');
    const out = await writeDocx(d.envelope, d.assets);
    const { parts } = inspect(out.bytes);
    const labels = computeLabels(d.envelope.doc as unknown as TreeNode);
    const model: string[] = [];
    const walk = (n: JsonNode): void => {
      if (n.type === 'paragraph') {
        const l = labels.lists.get(String(n.attrs?.['id']));
        if (l) model.push(l.text);
      }
      for (const c of n.content ?? []) walk(c);
    };
    walk(d.envelope.doc);
    expect(model).toEqual(['I', '1.', '1.a)', '–', '2.', '2.a)', 'II', '1.', '5.', '6.']);
    expect(wordLabels(parts.get('word/numbering.xml')!, parts.get('word/document.xml')!)).toEqual(
      model,
    );
    const numbering = xml(parts.get('word/numbering.xml')!);
    expect(all(numbering, 'startOverride').map((e) => att(e, 'val'))).toEqual(['5']);
    // Two lists of one definition are two abstract numberings, so Word counts them apart.
    expect(all(numbering, 'abstractNum').length).toBe(3);
  });

  it('writes tables with their grid, spans, header rows, borders, shading and margins, and pictures as parts (EXP-091)', async () => {
    const d = doc('tables-pictures');
    const out = await writeDocx(d.envelope, d.assets);
    const { parts } = inspect(out.bytes);
    const body = xml(parts.get('word/document.xml')!);
    const tbl = all(body, 'tbl')[0]!;
    expect(all(kid(tbl, 'tblGrid')!, 'gridCol').map((g) => att(g, 'w'))).toEqual([
      '2000',
      '2000',
      '3000',
    ]);
    const rows = all(tbl, 'tr');
    expect(rows.map((r) => all(r, 'tc').length)).toEqual([3, 2, 3]);
    expect(!!kid(kid(rows[0], 'trPr'), 'tblHeader')).toBe(true);
    expect(!!kid(kid(rows[0], 'trPr'), 'cantSplit')).toBe(true);
    expect(att(kid(kid(all(rows[1]!, 'tc')[0], 'tcPr'), 'gridSpan'), 'val')).toBe('2');
    expect(att(kid(kid(all(rows[1]!, 'tc')[1], 'tcPr'), 'vMerge'), 'val')).toBe('restart');
    // The covered cell of a row span is written, continuing the merge.
    const cont = all(rows[2]!, 'tc')[2]!;
    expect(kid(kid(cont, 'tcPr'), 'vMerge')?.attrs.length).toBe(0);
    expect(att(kid(kid(all(rows[1]!, 'tc')[0], 'tcPr'), 'shd'), 'fill')).toBe('FFF2CC');
    expect(
      att(all(kid(kid(all(rows[2]!, 'tc')[0], 'tcPr'), 'tcBorders')!, 'bottom')[0], 'val'),
    ).toBe('double');
    expect(att(kid(kid(tbl, 'tblPr'), 'tblStyle'), 'val')).toBe('TableGrid');
    // Banded rows: the table look turns horizontal banding on (the fixture sets `bandedRows`).
    expect(att(kid(kid(tbl, 'tblPr'), 'tblLook'), 'noHBand')).toBe('0');
    // Pictures: a media part, the size in EMU, the alternative text.
    expect([...parts.keys()].some((k) => k.startsWith('word/'))).toBe(true);
    const zip = readZip(out.bytes);
    expect(zip.entries.filter((e) => e.name.startsWith('word/media/')).length).toBe(1);
    const extents = all(body, 'extent').map((e) => att(e, 'cx'));
    expect(extents).toContain(String(720 * 635));
    // A caption numbers its figure with a SEQ field whose result is the shared algorithm's label.
    const instr = all(body, 'instrText').map((e) =>
      e.children.map((c) => (c.kind === 'text' ? c.value : '')).join(''),
    );
    expect(instr.filter((s) => s.includes('SEQ Figure')).length).toBe(2);
    expect(out.warnings.some((w) => w.includes('floating figure'))).toBe(true);
  });

  it('writes sections, headers and footers with their variants, a watermark, footnotes, fields and references (EXP-092)', async () => {
    const d = doc('sections-notes-fields');
    const out = await writeDocx(d.envelope, d.assets, {
      instant: '2026-11-06T23:30:00.000Z',
      timeZone: 'Pacific/Auckland',
      title: 'Title',
    });
    const { parts } = inspect(out.bytes);
    const body = xml(parts.get('word/document.xml')!);
    const sects = all(body, 'sectPr');
    expect(sects.length).toBe(2);
    // The first section's properties end its last paragraph; the second is landscape in two columns, starting on an odd page.
    expect(sects[0]!.parent?.local).toBe('pPr');
    expect(att(kid(sects[0], 'pgNumType'), 'fmt')).toBe('lowerRoman');
    expect(att(kid(sects[0], 'pgNumType'), 'start')).toBe('3');
    expect(!!kid(sects[0], 'titlePg')).toBe(true);
    expect(
      all(sects[0]!, 'headerReference')
        .map((h) => att(h, 'type'))
        .sort(),
    ).toEqual(['default', 'first']);
    expect(
      all(sects[0]!, 'footerReference')
        .map((h) => att(h, 'type'))
        .sort(),
    ).toEqual(['default', 'even']);
    expect(att(kid(sects[1], 'pgSz'), 'orient')).toBe('landscape');
    expect(att(kid(sects[1], 'cols'), 'num')).toBe('2');
    expect(att(kid(sects[1], 'type'), 'val')).toBe('oddPage');
    // Odd and even pages are document-wide in Word: the second section shows its default footer on even pages.
    expect(
      all(sects[1]!, 'footerReference')
        .map((h) => att(h, 'type'))
        .sort(),
    ).toEqual(['default', 'even']);
    expect(parts.get('word/settings.xml')).toContain('<w:evenAndOddHeaders/>');
    const headers = [...parts].filter(([k]) => /^word\/header\d+\.xml$/.test(k));
    expect(headers.some(([, v]) => v.includes('string="DRAFT"'))).toBe(true);
    // Footnotes: the separators Word needs, then the note with its mark.
    const notes = xml(parts.get('word/footnotes.xml')!);
    expect(all(notes, 'footnote').map((f) => att(f, 'type') ?? att(f, 'id'))).toEqual([
      'separator',
      'continuationSeparator',
      '1',
    ]);
    expect(all(notes, 'footnoteRef').length).toBe(1);
    expect(att(all(body, 'footnoteReference')[0], 'id')).toBe('1');
    expect(parts.get('word/settings.xml')).toContain('<w:footnote w:id="-1"/>');
    // Fields Word can update; the date is the server's, locked.
    const instr = all(body, 'instrText').map((e) =>
      e.children
        .map((c) => (c.kind === 'text' ? c.value : ''))
        .join('')
        .trim(),
    );
    expect(instr).toEqual(
      expect.arrayContaining([
        'TOC \\o "1-2" \\h \\z \\u',
        'REF intro \\h',
        'DATE \\@ "dd/MM/yyyy"',
        'TITLE',
        'STYLEREF "heading 1"',
      ]),
    );
    const date = dateFieldText({
      instant: '2026-11-06T23:30:00.000Z',
      timeZone: 'Pacific/Auckland',
      format: 'dd/MM/yyyy',
    });
    expect(date).toBe('07/11/2026');
    expect(textOfPart(parts.get('word/document.xml')!)).toContain(date);
    expect(all(body, 'fldChar').some((f) => att(f, 'fldLock') === '1')).toBe(true);
    const header = headers.map(([, v]) => v).join('');
    expect(header).toContain('PAGE');
    expect(header).toContain('NUMPAGES');
    // The equation reference resolves to a bookmark around the equation's number.
    expect(instr.some((s) => /^REF _Ref\d+ \\w \\h$/.test(s))).toBe(true);
    // The equations are Office math now (EXP-096), so no warning says they are written as source.
    expect(out.warnings.some((w) => w.includes('LaTeX source'))).toBe(false);
    expect(all(body, 'oMath').length).toBeGreaterThan(0);
  });

  it('writes suggestions as tracked changes with author and date, or settles them (EXP-093)', async () => {
    const d = doc('suggestions');
    const dates = {
      insSuggestion001: '2026-11-01T10:00:00Z',
      delSuggestion002: '2026-11-02T11:00:00Z',
    };
    const markup = inspect(
      (await writeDocx(d.envelope, d.assets, { suggestionDates: dates })).bytes,
    );
    const body = xml(markup.parts.get('word/document.xml')!);
    const ins = all(body, 'ins');
    const del = all(body, 'del');
    expect(
      ins.some(
        (e) => att(e, 'author') === 'Ada Lovelace' && att(e, 'date') === '2026-11-01T10:00:00Z',
      ),
    ).toBe(true);
    expect(del.some((e) => att(e, 'author') === 'user-0001')).toBe(true);
    expect(all(body, 'delText').length).toBeGreaterThan(0);
    expect(all(body, 'rPrChange').length).toBe(1);
    // A suggested paragraph: its mark is inserted; a deleted row: its row properties say so.
    expect(all(body, 'pPr').some((p) => !!kid(kid(p, 'rPr'), 'ins'))).toBe(true);
    expect(
      all(body, 'trPr').some((t) => att(kid(t, 'del'), 'date') === '2026-11-02T11:00:00Z'),
    ).toBe(true);
    const accept = inspect(
      (await writeDocx(d.envelope, d.assets, { suggestions: 'accept' })).bytes,
    ).parts.get('word/document.xml')!;
    expect(accept).not.toMatch(/<w:(ins|del|rPrChange)\b/);
    expect(textOfPart(accept)).toContain('inserted');
    expect(textOfPart(accept)).not.toContain('deleted');
    expect(textOfPart(accept)).toContain('A suggested paragraph');
    const reject = inspect(
      (await writeDocx(d.envelope, d.assets, { suggestions: 'reject' })).bytes,
    ).parts.get('word/document.xml')!;
    expect(reject).not.toMatch(/<w:(ins|del|rPrChange)\b/);
    expect(textOfPart(reject)).not.toContain('inserted');
    expect(textOfPart(reject)).toContain('deleted row');
    expect(textOfPart(reject)).not.toContain('A suggested paragraph');
    // Rejected formatting goes back to what it was: italic, not bold.
    const rejected = all(xml(reject), 'r').find((r) =>
      all(r, 't').some((t) =>
        t.children.some((c) => c.kind === 'text' && c.value === 'reformatted'),
      ),
    );
    expect(!!kid(kid(rejected, 'rPr'), 'i')).toBe(true);
    expect(!!kid(kid(rejected, 'rPr'), 'b')).toBe(false);
  });

  it('writes regions as content controls, with read-only protection and editable ranges when a region is restricted (EXP-094)', async () => {
    const d = doc('regions-forms');
    const out = await writeDocx(d.envelope, d.assets, {
      regionEditableByEveryone: (id) => id !== 'lockedRegion0001',
      regionEditors: (id) => (id === 'lockedRegion0001' ? ['editor@example.com'] : []),
      approvedRegions: new Set(['lockedRegion0001']),
      grants: { lockedRegion0001: [{ role: 'editor', principal: 'group:editors' }] },
    });
    const { parts } = inspect(out.bytes);
    const body = xml(parts.get('word/document.xml')!);
    const blockSdts = all(body, 'sdt').filter(
      (s) => s.parent?.local === 'body' || s.parent?.local === 'permStart',
    );
    const tags = all(body, 'tag').map((t) => att(t, 'val'));
    expect(tags).toContain('lockedRegion0001');
    expect(all(body, 'alias').map((a) => att(a, 'val'))).toContain(`Open ${HOSTILE}`);
    expect(blockSdts.length).toBeGreaterThanOrEqual(2);
    expect(parts.get('word/settings.xml')).toContain(
      '<w:documentProtection w:edit="readOnly" w:enforcement="1"/>',
    );
    const perms = all(body, 'permStart');
    expect(perms.map((p) => att(p, 'edGrp') ?? att(p, 'ed'))).toEqual(
      expect.arrayContaining(['everyone', 'editor@example.com']),
    );
    expect(all(body, 'lock').map((l) => att(l, 'val'))).toContain('sdtContentLocked');
    expect(
      [...parts.values()].some(
        (v) => v.includes('urn:docedit:grants:1') && v.includes('group:editors'),
      ),
    ).toBe(true);
    expect(out.warnings.some((w) => w.includes('advisory'))).toBe(true);
    // Without the callback nothing is protected.
    const open = inspect((await writeDocx(d.envelope, d.assets)).bytes).parts.get(
      'word/settings.xml',
    )!;
    expect(open).not.toContain('readOnly');
  });

  it('writes form fields as content controls bound to a custom XML part of their values (EXP-095)', async () => {
    const d = doc('regions-forms');
    const out = await writeDocx(d.envelope, d.assets);
    const { parts } = inspect(out.bytes);
    const body = xml(parts.get('word/document.xml')!);
    const controls = all(body, 'sdt').filter((s) =>
      all(s, 'tag').some((t) => att(t, 'val')?.startsWith('tenant.')),
    );
    expect(controls.map((c) => att(all(c, 'tag')[0], 'val'))).toEqual([
      'tenant.name',
      'tenant.income',
      'tenant.since',
      'tenant.agrees',
      'tenant.plan',
      'tenant.signature',
    ]);
    // EXP-095: the label is the alias, the control is inline (in a paragraph) and locked.
    expect(controls.map((c) => att(all(c, 'alias')[0], 'val'))).toEqual(
      [
        'tenant.name',
        'tenant.income',
        'tenant.since',
        'tenant.agrees',
        'tenant.plan',
        'tenant.signature',
      ].map((k) => `${k} ${HOSTILE}`),
    );
    expect(controls.every((c) => c.parent?.local === 'p')).toBe(true);
    expect(controls.every((c) => all(c, 'lock').length === 1)).toBe(true);
    expect(controls.every((c) => att(all(c, 'lock')[0], 'val') === 'sdtLocked')).toBe(true);
    const binding = all(body, 'dataBinding')[0]!;
    const item = [...parts].find(
      ([k]) => /^customXml\/item\d+\.xml$/.test(k) && parts.get(k)!.includes('f:fields'),
    )!;
    const props = parts.get(item[0].replace('item', 'itemProps'))!;
    expect(props).toContain(att(binding, 'storeItemID')!);
    const values = xml(item[1]);
    expect(
      all(values, 'field').map((f) => [
        att(f, 'key'),
        f.children.map((c) => (c.kind === 'text' ? c.value : '')).join(''),
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['tenant.name', 'Ann & Bob <x>'],
        ['tenant.income', '1200.50'],
        ['tenant.plan', 'b'],
      ]),
    );
    // EXP-095: the special characters are escaped in the custom part, and read back as written.
    expect(item[1]).toContain('Ann &amp; Bob &lt;x&gt;');
    expect(all(body, 'checkbox').length).toBe(1);
    expect(all(body, 'dropDownList').length).toBe(1);
    expect(parts.get('word/settings.xml')).toContain('w:edit="forms"');
    // EXP-095: the warnings say the protection is advisory, and the enforcement is the document service's.
    expect(out.warnings.some((w) => w.includes('form protection is advisory'))).toBe(true);
    // Assignees (roles) are in a second custom XML part.
    // The assignees and rules are in a part of their own, not in the values part.
    const defs = [...parts.values()].filter((v) => v.includes('<f:definitions'));
    expect(defs.length).toBe(1);
    expect(defs[0]).toContain('Tenant');
    expect(defs[0]).not.toBe(item[1]);
    expect(item[1]).not.toContain('<f:definitions');
  });

  it('writes a projection from the model alone: preserved atoms as their fallbacks, hidden content as a placeholder, redacted values left out (owner decisions 1 and 12)', async () => {
    const d = doc('projection');
    const out = await writeDocx(d.envelope, d.assets);
    const { parts, problems } = inspect(out.bytes);
    expect(problems).toEqual([]);
    const text = textOfPart(parts.get('word/document.xml')!);
    expect(text).toContain('Chart: sales by quarter');
    expect(text).toContain('Hidden content');
    expect(out.redacted).toEqual(['secret.value']);
    // The text box's fallback picture is a picture; no fragment is in the package.
    const zip = readZip(out.bytes);
    expect(zip.entries.some((e) => e.name.startsWith('word/media/'))).toBe(true);
    expect(zip.entries.every((e) => !/embeddings|activeX|vbaProject/.test(e.name))).toBe(true);
    expect(out.warnings.some((w) => w.includes('preserved content'))).toBe(true);
  });

  it('refuses a document that requires a feature it cannot write', async () => {
    const d = doc('text-styles');
    await expect(
      writeDocx({ ...d.envelope, requires: ['teleportation'] }, d.assets),
    ).rejects.toThrow(/teleportation/);
  });
});

describe('the corpus written as projections', () => {
  it.each(corpusFiles().map((f) => [f.name, f] as const))('%s', async (_n, f) => {
    const imported = await importDocx(readFile(f));
    const out = await writeDocx(imported.envelope, imported.assets);
    const { parts, problems } = inspect(out.bytes);
    expect(problems).toEqual([]);
    // No preserved content of the original reaches the projection.
    const zip = readZip(out.bytes);
    expect(zip.entries.every((e) => !/embeddings|activeX|vbaProject|charts\//.test(e.name))).toBe(
      true,
    );
    // The body's own text arrives, and the importer reads the file back (validating it).
    const want: string[] = [];
    const walk = (n: JsonNode): void => {
      if (n.type === 'text' && n.text && !(n.marks ?? []).some((m) => m.type === 'del'))
        want.push(n.text);
      for (const c of n.content ?? []) if (c.type !== 'story') walk(c);
    };
    walk(imported.envelope.doc.content!.find((n) => n.type === 'body')!);
    const got = textOfPart(parts.get('word/document.xml')!);
    for (const t of want.slice(0, 50)) expect(got).toContain(t);
    await importDocx(out.bytes);
  });
});
