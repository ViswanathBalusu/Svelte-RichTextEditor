/**
 * Documents for the direct DOCX writer (EXP-090 to EXP-096), one per feature group, built from the
 * model's new document. Shared by test/writer.test.ts and scripts/writer-word-check.ts.
 */
import { newDocument, type JsonEnvelope, type JsonMark, type JsonNode } from '@docedit/model';
import { deflateSync } from 'node:zlib';
import { AssetStore, crc32 } from '../src/index.ts';

/** A PNG of `width` × `height` pixels in four colours, built here so that its checksums are right. */
export function makePng(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const body = new Uint8Array(4 + data.length);
    body.set(
      [...type].map((c) => c.charCodeAt(0)),
      0,
    );
    body.set(data, 4);
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(body, 4);
    new DataView(out.buffer).setUint32(8 + data.length, crc32(body));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (1 + width * 3));
  const colours = [
    [220, 30, 30],
    [30, 160, 60],
    [40, 80, 200],
    [250, 250, 250],
  ];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const c = colours[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)]!;
      raw.set(c, y * (1 + width * 3) + 1 + x * 3);
    }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

export const PNG = makePng(16, 16);

/** Text that must survive escaping: markup, an entity, a CDATA end and both quotes. */
export const HOSTILE = `<script>alert("x")</script> & &amp; ]]> 'quoted' "double"`;

type Attrs = NonNullable<JsonNode['attrs']>;

let counter = 0;
/** A node identifier: 16 characters of the URL-safe alphabet (03 §9). */
export const nid = (prefix: string): string =>
  `${prefix}${String(++counter).padStart(15, '0')}`.slice(0, 16);

const t = (text: string, marks?: JsonMark[]): JsonNode =>
  marks ? { type: 'text', text, marks } : { type: 'text', text };
const p = (content: JsonNode[], attrs: Record<string, unknown> = {}): JsonNode => ({
  type: 'paragraph',
  attrs: { id: nid('p'), ...attrs } as Attrs,
  content,
});

function defsOf(env: JsonEnvelope): JsonNode {
  return env.doc.content!.find((n) => n.type === 'defs')!;
}
function bodyOf(env: JsonEnvelope): JsonNode {
  return env.doc.content!.find((n) => n.type === 'body')!;
}
function styleOf(env: JsonEnvelope, id: string): JsonNode {
  return defsOf(env).content!.find((n) => n.type === 'style_def' && n.attrs?.['id'] === id)!;
}
/** Definitions go before the page setups and what follows them (03 §4.1 content order). */
function addDef(env: JsonEnvelope, node: JsonNode, before = 'page_setup'): void {
  const defs = defsOf(env).content!;
  const i = defs.findIndex((n) => n.type === before);
  defs.splice(i < 0 ? defs.length : i, 0, node);
}

export interface WriterDoc {
  name: string;
  envelope: JsonEnvelope;
  assets: AssetStore;
  /** Text that must appear in the written document part. */
  texts: string[];
  /** A valid CDM document (projections are not). */
  valid: boolean;
}

export async function writerDocs(): Promise<WriterDoc[]> {
  const docs: WriterDoc[] = [];

  // Text, styles and direct formatting (EXP-090).
  {
    const env = newDocument({ lang: 'en-GB' });
    const assets = new AssetStore();
    Object.assign(styleOf(env, 'Normal').attrs!, { fontSize: 240, spaceAfter: 120 });
    Object.assign(styleOf(env, 'Heading1').attrs!, { bold: true, fontSize: 320, keepNext: true });
    addDef(
      env,
      {
        type: 'style_def',
        attrs: { id: 'Remark', kind: 'character', name: 'Remark', italic: true, bold: true },
      },
      'page_setup',
    );
    addDef(
      env,
      {
        type: 'style_def',
        attrs: {
          id: 'Plain',
          kind: 'paragraph',
          name: `Plain ${HOSTILE}`,
          color: '#336699',
          spaceBefore: 240,
        },
      },
      'page_setup',
    );
    bodyOf(env).content = [
      p([t('A heading')], { style: 'Heading1' }),
      p([
        t('Bold ', [{ type: 'bold', attrs: { value: true } }]),
        t('italic ', [{ type: 'italic', attrs: { value: true } }]),
        t('underlined ', [{ type: 'underline', attrs: { style: 'double' } }]),
        t('coloured ', [{ type: 'color', attrs: { value: '#C00000' } }]),
        t('highlighted ', [{ type: 'highlight', attrs: { value: 'yellow' } }]),
        t('Courier ', [{ type: 'fontFamily', attrs: { value: 'Courier New' } }]),
        t('big ', [{ type: 'fontSize', attrs: { value: 400 } }]),
        t('super', [{ type: 'vertAlign', attrs: { value: 'super' } }]),
        t(' styled', [{ type: 'charStyle', attrs: { style: 'Remark' } }]),
        t(' not bold in a bold style', [
          { type: 'charStyle', attrs: { style: 'Remark' } },
          { type: 'bold', attrs: { value: false } },
        ]),
        t(' Deutsch', [{ type: 'lang', attrs: { value: 'de-DE' } }]),
        t(' hidden', [{ type: 'hidden', attrs: { value: true } }]),
      ]),
      p([t(HOSTILE), { type: 'tab' }, t('after a tab'), { type: 'break' }, t('after a break')], {
        style: 'Plain',
        align: 'justify',
        indentLeft: 720,
        indentFirstLine: -360,
        lineSpacing: 1500,
        lineRule: 'multiple',
        tabs: [{ position: 2880, align: 'right', leader: 'dot' }],
        borders: { bottom: { style: 'single', width: 10, color: '#000000', space: 20 } },
        shading: { fill: '#EEEEEE' },
      }),
      p([
        t('A link', [{ type: 'link', attrs: { href: 'https://example.com/?a=1&b=2' } }]),
        t(' and '),
        t('a link to a bookmark', [{ type: 'link', attrs: { href: '#mark' } }]),
        { type: 'anchor', attrs: { id: nid('a'), name: 'mark' } },
      ]),
      p([t('Right to left'), { type: 'break', attrs: { kind: 'page' } }, t('after a page break')], {
        dir: 'rtl',
        align: 'end',
      }),
    ];
    docs.push({
      name: 'text-styles',
      envelope: env,
      assets,
      texts: [HOSTILE, 'A heading', 'after a tab', 'Right to left'],
      valid: true,
    });
  }

  // Numbering (EXP-090): three levels, a second list on the same definition, a restart, a numbered heading style.
  {
    const env = newDocument();
    const assets = new AssetStore();
    addDef(env, {
      type: 'numbering_def',
      attrs: {
        id: 'Outline',
        name: 'Outline',
        levels: [
          { format: 'decimal', text: '%1.', start: 1, indentLeft: 360, hanging: 360 },
          {
            format: 'lowerLetter',
            text: '%1.%2)',
            start: 1,
            indentLeft: 720,
            hanging: 360,
            restartAfter: null,
          },
          { format: 'bullet', text: '', start: 1, bulletChar: '–', indentLeft: 1080, hanging: 360 },
        ],
      },
    });
    addDef(env, {
      type: 'numbering_def',
      attrs: {
        id: 'Chapters',
        levels: [{ format: 'upperRoman', text: '%1', start: 1, indentLeft: 0, hanging: 0 }],
      },
    });
    Object.assign(styleOf(env, 'Heading1').attrs!, {
      numbering: { numberingId: 'Chapters', level: 0, listId: 'chaptersList0001' },
    });
    const item = (
      text: string,
      level: number,
      listId: string,
      extra: Record<string, unknown> = {},
    ): JsonNode => p([t(text)], { numbering: { numberingId: 'Outline', level, listId }, ...extra });
    bodyOf(env).content = [
      p([t('Chapter one')], { style: 'Heading1' }),
      item('first', 0, 'listAAAAAAAAAAA1'),
      item('first a', 1, 'listAAAAAAAAAAA1'),
      item('a bullet', 2, 'listAAAAAAAAAAA1'),
      item('second', 0, 'listAAAAAAAAAAA1'),
      item('first a again', 1, 'listAAAAAAAAAAA1'),
      p([t('Chapter two')], { style: 'Heading1' }),
      item('another list', 0, 'listBBBBBBBBBBB2'),
      item('restarted at five', 0, 'listBBBBBBBBBBB2', { numberingRestart: 5 }),
      item('six', 0, 'listBBBBBBBBBBB2'),
    ];
    docs.push({
      name: 'numbering',
      envelope: env,
      assets,
      texts: ['first a again', 'restarted at five'],
      valid: true,
    });
  }

  // Tables, pictures and captions (EXP-091).
  {
    const env = newDocument();
    const assets = new AssetStore();
    const png = await assets.add(PNG, 'image/png', 'image');
    Object.assign(styleOf(env, 'TableGrid').attrs!, {
      borders: {
        top: { style: 'single', width: 10 },
        bottom: { style: 'single', width: 10 },
        left: { style: 'single', width: 10 },
        right: { style: 'single', width: 10 },
        insideH: { style: 'single', width: 5 },
        insideV: { style: 'single', width: 5 },
      },
      headerRowShading: { fill: '#DDDDDD' },
      bandedRows: true,
    });
    const cell = (text: string, attrs: Record<string, unknown> = {}): JsonNode => ({
      type: 'table_cell',
      attrs: { id: nid('c'), ...attrs } as Attrs,
      content: [p([t(text)])],
    });
    const row = (cells: JsonNode[], attrs: Record<string, unknown> = {}): JsonNode => ({
      type: 'table_row',
      attrs: { id: nid('r'), ...attrs } as Attrs,
      content: cells,
    });
    bodyOf(env).content = [
      p([t('Before the table')]),
      {
        type: 'table',
        attrs: {
          id: nid('t'),
          style: 'TableGrid',
          grid: [2000, 2000, 3000],
          headerRows: 1,
          width: { type: 'pct', value: 10000 },
          align: 'center',
          cellMargins: { top: 40, bottom: 40, left: 100, right: 100 },
        },
        content: [
          row([cell('Head 1'), cell('Head 2'), cell('Head 3')], { cantSplit: true }),
          row(
            [
              cell('Spans two columns', { colspan: 2, shading: { fill: '#FFF2CC' } }),
              cell('Spans two rows', { rowspan: 2, vAlign: 'center' }),
            ],
            { height: 600, heightRule: 'atLeast' },
          ),
          row([
            cell('a', { borders: { bottom: { style: 'double', width: 15, color: '#FF0000' } } }),
            cell('b', { margins: { left: 200 } }),
          ]),
        ],
      },
      p([
        t('An inline picture '),
        {
          type: 'image',
          attrs: { asset: png, width: 720, height: 720, alt: `A picture ${HOSTILE}` },
        },
      ]),
      {
        type: 'figure',
        attrs: {
          id: nid('f'),
          asset: png,
          width: 2880,
          height: 2880,
          alt: 'A figure',
          align: 'center',
        },
        content: [
          {
            type: 'caption',
            content: [
              t('Figure '),
              { type: 'field', attrs: { kind: 'seq', name: 'Figure' } },
              t(': a red and green square'),
            ],
          },
        ],
      },
      {
        type: 'figure',
        attrs: { id: nid('f'), asset: png, width: 1440, height: 1440, placement: 'float' },
        content: [
          {
            type: 'caption',
            content: [
              t('Figure '),
              { type: 'field', attrs: { kind: 'seq', name: 'Figure' } },
              t(': floating'),
            ],
          },
        ],
      },
    ];
    docs.push({
      name: 'tables-pictures',
      envelope: env,
      assets,
      texts: ['Spans two columns', 'a red and green square'],
      valid: true,
    });
  }

  // Page structure, notes, fields and references (EXP-092).
  {
    const env = newDocument();
    const assets = new AssetStore();
    const defs = defsOf(env).content!;
    const ps0 = defs.find((n) => n.type === 'page_setup')!;
    const header = nid('h');
    const first = nid('h');
    const footer = nid('o');
    const even = nid('o');
    Object.assign(ps0.attrs!, {
      headerDefault: header,
      headerFirst: first,
      footerDefault: footer,
      footerEven: even,
      differentFirstPage: true,
      differentOddEven: true,
      pageNumberStart: 3,
      pageNumberFormat: 'lowerRoman',
      watermark: 'DRAFT',
    });
    const ps1 = nid('s');
    defs.push({
      type: 'page_setup',
      attrs: {
        id: ps1,
        width: 16838,
        height: 11906,
        orientation: 'landscape',
        columns: 2,
        columnGap: 360,
        footerDefault: footer,
      },
    });
    const story = (id: string, kind: 'header' | 'footer', content: JsonNode[]): JsonNode => ({
      type: 'story',
      attrs: { id, kind },
      content: [p(content)],
    });
    env.doc.content!.splice(
      1,
      0,
      story(header, 'header', [
        t('Header, page '),
        { type: 'field', attrs: { kind: 'page' } },
        t(' of '),
        { type: 'field', attrs: { kind: 'pageCount' } },
      ]),
      story(first, 'header', [t('First-page header')]),
      story(footer, 'footer', [t('Footer')]),
      story(even, 'footer', [t('Even footer')]),
    );
    Object.assign(styleOf(env, 'Heading1').attrs!, { outlineLevel: 1 });
    const target = nid('p');
    bodyOf(env).content = [
      { type: 'toc', attrs: { id: nid('c'), minLevel: 1, maxLevel: 2 } },
      {
        type: 'paragraph',
        attrs: { id: target, style: 'Heading1' },
        content: [t('Introduction'), { type: 'anchor', attrs: { id: nid('a'), name: 'intro' } }],
      },
      p([
        t('A note'),
        {
          type: 'footnote',
          attrs: { id: nid('n') },
          content: [
            p([
              t('The footnote text, with a '),
              t('link', [{ type: 'link', attrs: { href: 'mailto:someone@example.com' } }]),
            ]),
          ],
        },
        t('. See '),
        { type: 'field', attrs: { kind: 'ref', target: 'bookmark:intro' } },
        t('. Dated '),
        { type: 'field', attrs: { kind: 'date', format: 'dd/MM/yyyy' } },
        t(', titled '),
        { type: 'field', attrs: { kind: 'title' } },
        t(', under '),
        { type: 'field', attrs: { kind: 'styleRef', target: 'style:Heading1' } },
        t('.'),
      ]),
      { type: 'section_break', attrs: { id: nid('b'), pageSetup: ps1, start: 'oddPage' } },
      {
        type: 'paragraph',
        attrs: { id: nid('p'), style: 'Heading1' },
        content: [t('A landscape section in two columns')],
      },
      p([t('Display maths follows.')]),
      {
        type: 'equation_block',
        attrs: { id: nid('e'), latex: 'E = mc^2', numbered: true, label: 'eq:energy' },
      },
      p([
        t('Inline maths '),
        { type: 'equation', attrs: { latex: '\\alpha + \\beta' } },
        t(' and a reference to the equation: '),
        { type: 'field', attrs: { kind: 'ref', target: 'eq:eq:energy' } },
      ]),
    ];
    docs.push({
      name: 'sections-notes-fields',
      envelope: env,
      assets,
      texts: ['The footnote text', 'A landscape section in two columns'],
      valid: true,
    });
  }

  // Suggestions (EXP-093): insertions, deletions, a formatting change, a suggested paragraph and a deleted row.
  {
    const env = newDocument();
    const assets = new AssetStore();
    const ins = (id: string): JsonMark => ({
      type: 'ins',
      attrs: { id, user: 'word:Ada Lovelace' },
    });
    const del = (id: string): JsonMark => ({ type: 'del', attrs: { id, user: 'user-0001' } });
    const fmt: JsonMark = {
      type: 'fmt',
      attrs: {
        id: nid('g'),
        user: 'user-0002',
        before: { marks: [{ type: 'italic', attrs: { value: true } }] },
      },
    };
    const cell = (text: string): JsonNode => ({
      type: 'table_cell',
      attrs: { id: nid('c') },
      content: [p([t(text)])],
    });
    bodyOf(env).content = [
      p([
        t('Kept '),
        t('inserted ', [ins('insSuggestion001')]),
        t('deleted ', [del('delSuggestion001')]),
        t('reformatted', [{ type: 'bold', attrs: { value: true } }, fmt]),
      ]),
      {
        type: 'paragraph',
        attrs: { id: nid('p') },
        marks: [ins('insSuggestion002')],
        content: [t('A suggested paragraph')],
      },
      {
        type: 'table',
        attrs: { id: nid('t'), grid: [3000, 3000] },
        content: [
          { type: 'table_row', attrs: { id: nid('r') }, content: [cell('kept row'), cell('kept')] },
          {
            type: 'table_row',
            attrs: { id: nid('r') },
            marks: [del('delSuggestion002')],
            content: [cell('deleted row'), cell('deleted')],
          },
        ],
      },
      p([t('End')]),
    ];
    docs.push({
      name: 'suggestions',
      envelope: env,
      assets,
      texts: ['Kept', 'A suggested paragraph'],
      valid: true,
    });
  }

  // Regions (EXP-094) and form fields (EXP-095).
  {
    const env = newDocument();
    const assets = new AssetStore();
    env.requires = ['fields'];
    addDef(
      env,
      { type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#2E75B6' } },
      'rule_def',
    );
    const field = (key: string, kind: string, extra: Record<string, unknown> = {}): JsonNode => ({
      type: 'form_field',
      attrs: {
        id: nid('i'),
        key,
        kind,
        label: `${key} ${HOSTILE}`,
        assignee: 'tenant',
        ...extra,
      } as Attrs,
    });
    bodyOf(env).content = [
      p([t('Outside every region')]),
      {
        type: 'region',
        attrs: { id: nid('g'), title: `Open ${HOSTILE}` },
        content: [p([t('Everyone may edit this region.')])],
      },
      {
        type: 'region',
        attrs: { id: 'lockedRegion0001', title: 'Locked', policy: 'restricted' },
        content: [p([t('Only some may edit this region.')])],
      },
      p([
        t('Name: '),
        field('tenant.name', 'text', { value: `Ann & Bob <x>` }),
        t(' Income: '),
        field('tenant.income', 'number', { value: '1200.50' }),
        t(' Since: '),
        field('tenant.since', 'date', { value: '2026-11-06' }),
        t(' Agrees: '),
        field('tenant.agrees', 'checkbox', { value: true }),
        t(' Plan: '),
        field('tenant.plan', 'choice', {
          value: 'b',
          options: [
            { id: 'a', label: 'Basic' },
            { id: 'b', label: 'Better & best' },
          ],
        }),
        t(' Signed: '),
        field('tenant.signature', 'signature'),
      ]),
    ];
    docs.push({
      name: 'regions-forms',
      envelope: env,
      assets,
      texts: ['Everyone may edit this region.', 'Outside every region'],
      valid: true,
    });
  }

  // A projection (owner decision 1): preserved atoms, a hidden region, extension content, a redacted value.
  {
    const env = newDocument();
    const assets = new AssetStore();
    const png = await assets.add(PNG, 'image/png', 'image');
    const fragment = await assets.add(
      new Uint8Array([1, 2, 3]),
      'application/vnd.docedit.fragment+zip',
      'fragment',
    );
    env.requires = ['fields', 'extensions', 'preserve'];
    addDef(
      env,
      { type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#2E75B6' } },
      'rule_def',
    );
    bodyOf(env).content = [
      p([
        t('Before a chart: '),
        {
          type: 'preserved_inline',
          attrs: { label: 'chart', fragment, fallbackText: 'Chart: sales by quarter' },
        },
        t(' and an extension: '),
        {
          type: 'extension_inline',
          attrs: { extension: 'example.widget', fallbackText: 'a widget' },
        },
      ]),
      {
        type: 'preserved_block',
        attrs: {
          id: nid('k'),
          label: 'text box',
          fragment,
          fallbackAsset: png,
          fallbackText: 'A text box',
          width: 1440,
          height: 1440,
        },
      },
      { type: 'hidden_region', attrs: { id: nid('g'), title: null } },
      p([
        t('Value: '),
        {
          type: 'form_field',
          attrs: {
            id: nid('i'),
            key: 'secret.value',
            kind: 'text',
            label: 'Secret',
            assignee: 'tenant',
            sensitive: true,
            value: { redacted: true },
          },
        },
      ]),
    ];
    docs.push({
      name: 'projection',
      envelope: env,
      assets,
      texts: ['Chart: sales by quarter', 'a widget'],
      valid: false,
    });
  }

  return docs;
}
