/**
 * Edits the scripted edits of SPK-028 do not make, each with what the written package must show
 * (EXP-118, EXP-119, owner decision 2): a copied paragraph, a copied chart, an atom moved into a
 * header, deletions of a copied atom, an edited, a replaced and a new picture, header rows, and
 * preserved data the import did not create. Shared by test/patch.test.ts and the Word check
 * (scripts/export-for-word.ts).
 */
import { nodeId, type JsonEnvelope, type JsonNode } from '@docedit/model';
import {
  type ExportResult,
  type ImportResult,
  type XmlElement,
  NS,
  danglingTargets,
  entryData,
  importDocx,
  parseXml,
  readFragment,
  readZip,
} from '../src/index.ts';
import { parseRelationships, referencedRelIds, relsPartName } from '../src/opc.ts';
import { corpusFiles, readFile } from './corpus.ts';

export interface PatchCase {
  name: string;
  file: string;
  bytes: Uint8Array;
  imported: ImportResult;
  envelope: JsonEnvelope;
  /** Problems with the written package; empty when it is as expected. */
  check(out: ExportResult): string[];
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const bodyOf = (env: JsonEnvelope): JsonNode => env.doc.content!.find((n) => n.type === 'body')!;

function find(
  n: JsonNode,
  pred: (n: JsonNode) => boolean,
  path: JsonNode[] = [],
): JsonNode[] | null {
  if (pred(n)) return [...path, n];
  for (const c of n.content ?? []) {
    const r = find(c, pred, [...path, n]);
    if (r) return r;
  }
  return null;
}

/** Fresh identifiers for a copy of a block and its descendants (03 §9). */
function copyBlock(n: JsonNode): JsonNode {
  const c = clone(n);
  const walk = (x: JsonNode): void => {
    if (typeof x.attrs?.['id'] === 'string') x.attrs['id'] = nodeId();
    for (const k of x.content ?? []) walk(k);
  };
  walk(c);
  return c;
}

const text = (zip: ReturnType<typeof readZip>, name: string): string => {
  const e = zip.byName.get(name);
  return e ? new TextDecoder().decode(entryData(zip, e)) : '';
};

/** Every relationship each part refers to resolves, and no relationship points at a missing part. */
function integrity(out: ExportResult): string[] {
  const zip = readZip(out.bytes);
  const problems = danglingTargets(zip).map((d) => `dangling relationship ${d}`);
  for (const e of zip.entries) {
    if (!/^word\/[^/]+\.xml$/.test(e.name)) continue;
    const refs = referencedRelIds(parseXml(entryData(zip, e)).root);
    if (!refs.size) continue;
    const rels = parseRelationships(
      e.name,
      zip.byName.has(relsPartName(e.name))
        ? entryData(zip, zip.byName.get(relsPartName(e.name))!)
        : undefined,
    );
    for (const id of refs)
      if (!rels.byId.has(id))
        problems.push(`${e.name} refers to ${id}, which its relationships lack`);
  }
  return problems;
}

async function load(name: string): Promise<{ bytes: Uint8Array; imported: ImportResult }> {
  const f = corpusFiles().find((x) => x.name === name);
  if (!f) throw new Error(`no corpus file ${name}`);
  const bytes = readFile(f);
  return { bytes, imported: await importDocx(bytes) };
}

const isChart = (n: JsonNode): boolean =>
  n.type === 'preserved_inline' && n.attrs?.['label'] === 'chart';

export async function patchCases(): Promise<PatchCase[]> {
  const cases: PatchCase[] = [];

  // EXP-118: a copy of a paragraph has a fresh identifier and no identity-bound values of its own.
  {
    const { bytes, imported } = await load('docx4j/76t52-round-8-control-word365.docx');
    const env = clone(imported.envelope);
    const body = bodyOf(env);
    const i = (body.content ?? []).findIndex(
      (n) =>
        n.type === 'paragraph' &&
        !!imported.sourceMap.nodes[String(n.attrs?.['id'])]?.identity?.['w14:paraId'],
    );
    const p = body.content![i]!;
    const paraId = imported.sourceMap.nodes[String(p.attrs?.['id'])]!.identity!['w14:paraId']!;
    body.content!.splice(i + 1, 0, copyBlock(p));
    cases.push({
      name: 'copy-paragraph',
      file: 'docx4j/76t52-round-8-control-word365.docx',
      bytes,
      imported,
      envelope: env,
      check: (out) => {
        const doc = text(readZip(out.bytes), 'word/document.xml');
        const n = doc.split(`w14:paraId="${paraId}"`).length - 1;
        return [...(n === 1 ? [] : [`paraId ${paraId} appears ${n} times`]), ...integrity(out)];
      },
    });
  }

  // EXP-119: a copied chart gets its own chart part and relationships; the original keeps its own.
  {
    const { bytes, imported } = await load('docx4j/chart.docx');
    const env = clone(imported.envelope);
    const body = bodyOf(env);
    const path = find(body, isChart)!;
    const p = path[path.length - 2]!;
    body.content!.splice(body.content!.indexOf(p) + 1, 0, copyBlock(p));
    cases.push({
      name: 'copy-chart',
      file: 'docx4j/chart.docx',
      bytes,
      imported,
      envelope: env,
      check: (out) => {
        const zip = readZip(out.bytes);
        const problems = integrity(out);
        const charts = zip.entries
          .filter((e) => /^word\/charts\/[^/]+\.xml$/.test(e.name))
          .map((e) => e.name);
        const before = readZip(bytes).entries.filter((e) =>
          /^word\/charts\/[^/]+\.xml$/.test(e.name),
        ).length;
        if (charts.length !== before + 1)
          problems.push(`${charts.length} chart parts, expected ${before + 1}`);
        const rels = parseRelationships(
          'word/document.xml',
          entryData(zip, zip.byName.get('word/_rels/document.xml.rels')!),
        );
        const chartRels = rels.list.filter((r) => r.type.endsWith('/chart'));
        if (
          new Set(chartRels.map((r) => r.target)).size !== chartRels.length ||
          chartRels.length < 2
        )
          problems.push(
            `chart relationships ${chartRels.map((r) => `${r.id}->${r.target}`).join(', ')}`,
          );
        const ct = text(zip, '[Content_Types].xml');
        for (const c of charts)
          if (!ct.includes(`/${c}"`)) problems.push(`no content type for ${c}`);
        return problems;
      },
    });
  }

  // EXP-119: the copy of a chart whose original was deleted keeps the original part.
  {
    const { bytes, imported } = await load('docx4j/chart.docx');
    const env = clone(imported.envelope);
    const body = bodyOf(env);
    const path = find(body, isChart)!;
    const p = path[path.length - 2]!;
    const at = body.content!.indexOf(p);
    body.content!.splice(at, 1, copyBlock(p));
    cases.push({
      name: 'copy-chart-delete-original',
      file: 'docx4j/chart.docx',
      bytes,
      imported,
      envelope: env,
      check: (out) => {
        const zip = readZip(out.bytes);
        const problems = integrity(out);
        const charts = zip.entries.filter((e) => /^word\/charts\/[^/]+\.xml$/.test(e.name)).length;
        const before = readZip(bytes).entries.filter((e) =>
          /^word\/charts\/[^/]+\.xml$/.test(e.name),
        ).length;
        if (charts !== before) problems.push(`${charts} chart parts, expected ${before}`);
        if (Object.values(out.parts).includes('added')) problems.push('a part was added');
        return problems;
      },
    });
  }

  // EXP-119: deleting the only chart removes its parts (they are not written).
  {
    const { bytes, imported } = await load('docx4j/chart.docx');
    const env = clone(imported.envelope);
    const body = bodyOf(env);
    const path = find(body, isChart)!;
    const p = path[path.length - 2]!;
    const others = (body.content ?? []).filter((n) => n !== p && n.type !== 'section_break');
    body.content = others.length
      ? body.content!.filter((n) => n !== p)
      : [{ type: 'paragraph', attrs: { id: nodeId() } }];
    cases.push({
      name: 'delete-chart',
      file: 'docx4j/chart.docx',
      bytes,
      imported,
      envelope: env,
      check: (out) => {
        const zip = readZip(out.bytes);
        const left = zip.entries
          .filter((e) => e.name.startsWith('word/charts/'))
          .map((e) => e.name);
        return [
          ...integrity(out),
          ...(left.length ? [`chart parts left: ${left.join(', ')}`] : []),
        ];
      },
    });
  }

  // EXP-119: an atom moved into another part (a header or footer) brings its relationships there.
  {
    const { bytes, imported } = await load('poi/WordWithAttachments.docx');
    const env = clone(imported.envelope);
    const body = bodyOf(env);
    const path = find(
      body,
      (n) => n.type === 'preserved_inline' && n.attrs?.['label'] === 'embedded object',
    )!;
    const atom = path[path.length - 1]!;
    const p = path[path.length - 2]!;
    p.content = p.content!.filter((c) => c !== atom);
    if (!p.content.length) delete p.content;
    const story = env.doc.content!.find((n) => n.type === 'story')!;
    const target = find(story, (n) => n.type === 'paragraph')!.pop()!;
    target.content = [...(target.content ?? []), atom];
    const storyPart = imported.sourceMap.stories[String(story.attrs?.['id'])]!.part;
    const fragment = readFragment(imported.assets.get(String(atom.attrs?.['fragment']))!.bytes);
    cases.push({
      name: 'atom-to-header',
      file: 'poi/WordWithAttachments.docx',
      bytes,
      imported,
      envelope: env,
      check: (out) => {
        const zip = readZip(out.bytes);
        const problems = integrity(out);
        const rels = parseRelationships(
          storyPart,
          entryData(zip, zip.byName.get(relsPartName(storyPart))!),
        );
        for (const r of fragment.meta.rels)
          if (!rels.list.some((x) => x.type === r.type))
            problems.push(`${storyPart} has no ${r.type.split('/').pop()} relationship`);
        return problems;
      },
    });
  }

  // EXP-091 and R1 (c) for pictures: an edited picture keeps its drawing, with the new size and text.
  {
    const { bytes, imported } = await load('poi/VariousPictures.docx');
    const env = clone(imported.envelope);
    const img = find(bodyOf(env), (n) => n.type === 'image')!.pop()!;
    const w0 = Number(img.attrs!['width']);
    img.attrs = {
      ...img.attrs,
      width: Math.min(31680, w0 * 2),
      height: Math.min(31680, Number(img.attrs!['height']) * 2),
      alt: 'A picture, resized',
    };
    cases.push({
      name: 'resize-picture',
      file: 'poi/VariousPictures.docx',
      bytes,
      imported,
      envelope: env,
      check: (out) => {
        const doc = text(readZip(out.bytes), 'word/document.xml');
        const problems = integrity(out);
        if (!doc.includes('descr="A picture, resized"'))
          problems.push('the new alternative text is not written');
        const cx = String(Math.round(Math.min(31680, w0 * 2) * 635));
        if (doc.split(`cx="${cx}"`).length - 1 < 2)
          problems.push(`extent ${cx} is not written to wp:extent and a:ext`);
        return problems;
      },
    });
  }

  // A picture replaced by another asset, and a new picture without an origin.
  {
    const { bytes, imported } = await load('poi/VariousPictures.docx');
    const env = clone(imported.envelope);
    const images: JsonNode[] = [];
    const walk = (n: JsonNode): void => {
      if (n.type === 'image') images.push(n);
      for (const c of n.content ?? []) walk(c);
    };
    walk(bodyOf(env));
    const first = images[0]!;
    const other = images.find((i) => i.attrs?.['asset'] !== first.attrs?.['asset'])!;
    first.attrs = { ...first.attrs, asset: other.attrs!['asset']! };
    const p = find(
      bodyOf(env),
      (n) => n.type === 'paragraph' && !!n.content?.some((c) => c.type === 'text'),
    )!.pop()!;
    p.content = [
      ...(p.content ?? []),
      {
        type: 'image',
        attrs: { asset: other.attrs!['asset']!, width: 1440, height: 1440, alt: 'A new picture' },
      },
    ];
    cases.push({
      name: 'replace-and-add-picture',
      file: 'poi/VariousPictures.docx',
      bytes,
      imported,
      envelope: env,
      check: (out) => {
        const zip = readZip(out.bytes);
        const problems = integrity(out);
        if (!text(zip, 'word/document.xml').includes('descr="A new picture"'))
          problems.push('the new picture is not written');
        if (!zip.entries.some((e) => /^word\/media\/docedit/.test(e.name)))
          problems.push('no new picture part');
        return problems;
      },
    });
  }

  // Header rows: one more repeated row than at import.
  {
    const { bytes, imported } = await load('docx4j/tables.docx');
    const env = clone(imported.envelope);
    const table = find(
      bodyOf(env),
      (n) =>
        n.type === 'table' &&
        typeof n.attrs?.['headerRows'] === 'number' &&
        (n.content?.length ?? 0) > Number(n.attrs['headerRows']),
    )!.pop()!;
    const before = Number(table.attrs!['headerRows']);
    table.attrs = { ...table.attrs, headerRows: before + 1 };
    cases.push({
      name: 'header-rows',
      file: 'docx4j/tables.docx',
      bytes,
      imported,
      envelope: env,
      check: (out) => {
        const a = text(readZip(bytes), 'word/document.xml').split('<w:tblHeader/>').length;
        const b = text(readZip(out.bytes), 'word/document.xml').split('<w:tblHeader/>').length;
        return [
          ...integrity(out),
          ...(b === a + 1 ? [] : [`${b - 1} tblHeader elements, expected ${a}`]),
        ];
      },
    });
  }

  // Owner decision 2: preserved data the import did not create is not written.
  {
    const { bytes, imported } = await load('poi/EmbeddedDocument.docx');
    const env = clone(imported.envelope);
    const body = bodyOf(env);
    const objectPath = find(
      body,
      (n) => n.type === 'preserved_inline' && n.attrs?.['label'] === 'embedded object',
    )!;
    const object = objectPath.pop()!;
    const p = find(
      body,
      (n) => n.type === 'paragraph' && !!n.content?.some((c) => c.type === 'text'),
    )!.pop()!;
    p.attrs = {
      ...p.attrs,
      preserved: {
        children: [{ name: 'w:pPr', children: [{ name: 'w:framePr', attrs: { 'w:w': '1' } }] }],
      },
    };
    const anyImage = imported.assets.ofRole('image')[0]!;
    p.content = [
      ...(p.content ?? []),
      // A made-up origin: the embedded object's fragment presented as a picture's original.
      {
        type: 'image',
        attrs: {
          asset: anyImage.id,
          width: 720,
          height: 720,
          origin: { fragment: String(object.attrs!['fragment']), hash: '0'.repeat(64) },
        },
      },
      // A made-up atom whose fragment the import did not create.
      {
        type: 'preserved_inline',
        attrs: {
          label: 'made up',
          fragment: String(object.attrs!['fragment']),
          fallbackText: 'made up',
        },
      },
    ];
    cases.push({
      name: 'untrusted-payloads',
      file: 'poi/EmbeddedDocument.docx',
      bytes,
      imported,
      envelope: env,
      check: (out) => {
        const doc = text(readZip(out.bytes), 'word/document.xml');
        const problems = integrity(out);
        if (out.untrusted < 3)
          problems.push(`${out.untrusted} untrusted payloads, expected at least 3`);
        if (doc.includes('w:framePr w:w="1"')) problems.push('a made-up property was written');
        const objects = doc.split('<w:object').length - 1;
        const original = text(readZip(bytes), 'word/document.xml').split('<w:object').length - 1;
        if (objects !== original)
          problems.push(`${objects} embedded objects, expected ${original}`);
        return problems;
      },
    });
  }

  // EXP-119, criterion 2: a fragment's relationship identifiers that clash with those the story
  // part already uses are renumbered. Four embedded objects fill the header's relationships up to
  // rId8; a copy of the first object refers to rId8 in its fragment, which the header gives to
  // another object's OLE part, so the copy must be written with the identifier of its own image.
  {
    const { bytes, imported } = await load('poi/WordWithAttachments.docx');
    const env = clone(imported.envelope);
    const body = bodyOf(env);
    const objects: Array<{ atom: JsonNode; parent: JsonNode }> = [];
    const walk = (n: JsonNode): void => {
      for (const c of n.content ?? []) {
        if (c.type === 'preserved_inline' && c.attrs?.['label'] === 'embedded object')
          objects.push({ atom: c, parent: n });
        walk(c);
      }
    };
    walk(body);
    const moved = objects.slice(0, 4);
    for (const { atom, parent } of moved)
      parent.content = parent.content!.filter((c) => c !== atom);
    const story = env.doc.content!.find((n) => n.type === 'story')!;
    const target = find(story, (n) => n.type === 'paragraph')!.pop()!;
    const copy = clone(moved[0]!.atom);
    target.content = [...(target.content ?? []), ...moved.map((m) => m.atom), copy];
    const storyPart = imported.sourceMap.stories[String(story.attrs?.['id'])]!.part;
    cases.push({
      name: 'clash-relationship-ids',
      file: 'poi/WordWithAttachments.docx',
      bytes,
      imported,
      envelope: env,
      check: (out) => {
        const zip = readZip(out.bytes);
        const problems = integrity(out);
        const rels = parseRelationships(
          storyPart,
          entryData(zip, zip.byName.get(relsPartName(storyPart))!),
        );
        const refs: string[] = [];
        const collect = (el: XmlElement): void => {
          for (const a of el.attrs) if (a.ns === NS.r) refs.push(a.value);
          for (const c of el.children) if (c.kind === 'element') collect(c);
        };
        collect(parseXml(entryData(zip, zip.byName.get(storyPart)!)).root);
        const targets = refs.map((id) => rels.byId.get(id)?.target ?? `missing ${id}`);
        // The first object's image is referred to once by the original and once by its copy.
        const expected = new Map<string, number>();
        for (const m of [...moved, { atom: copy }]) {
          const f = readFragment(imported.assets.get(String(m.atom.attrs!['fragment']))!.bytes);
          for (const r of f.meta.rels)
            if (r.type.endsWith('/image'))
              expected.set(r.target, (expected.get(r.target) ?? 0) + 1);
        }
        const seen = new Map<string, number>();
        for (const t of targets) if (t.startsWith('media/')) seen.set(t, (seen.get(t) ?? 0) + 1);
        for (const [t, n] of expected)
          if (seen.get(t) !== n)
            problems.push(`${t} referred to ${seen.get(t) ?? 0} times, expected ${n}`);
        return problems;
      },
    });
  }

  return cases;
}
