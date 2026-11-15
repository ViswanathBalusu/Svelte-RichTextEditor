/**
 * The DOCX writer on the shared corpus (FND-006, last criterion: the export tests use the corpus).
 * Every corpus document kept in Git is written as a DOCX package with its images, the package is
 * read back by the importer, which validates what it reads (EXP-109), and a sample of the
 * document's text is found in the written parts. Each result records the corpus version.
 *
 * The corpus is imported by path, as the export worker's tests do: the package has no dependency
 * on `@docedit/corpus`.
 */
import { describe, expect, it } from 'vitest';
import type { JsonEnvelope, JsonNode } from '@docedit/model';
import { type CorpusStamp, corpusStamp, loadDocument } from '../../../packages/corpus/src/index.ts';
import type { Asset } from '../src/assets.ts';
import { entryData, importDocx, readZip } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';

declare module 'vitest' {
  interface TaskMeta {
    corpus?: CorpusStamp;
  }
}

/** The corpus documents kept in Git (corpus README, "Documents"). */
const DOCUMENTS = ['pages-1', 'form-fields', 'pages-20'] as const;

/** The text of every text node, in document order. */
function texts(node: JsonNode, out: string[] = []): string[] {
  if (typeof node.text === 'string') out.push(node.text);
  for (const child of node.content ?? []) texts(child, out);
  return out;
}

/** The text of the `w:t` elements of a part, with the XML entities resolved. */
function textOfPart(xml: string): string {
  return [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)]
    .map((m) => m[1]!)
    .join('')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

describe('the DOCX writer on the shared corpus (FND-006)', () => {
  it.each(DOCUMENTS)('writes %s, and the importer reads it back', async (name) => {
    const doc = await loadDocument(name);
    const stored = new Map<string, Asset>(
      doc.assets.map((a) => [
        a.entry.id,
        {
          id: a.entry.id,
          bytes: a.bytes,
          contentType: a.entry.mediaType,
          sha256: a.entry.sha256,
          role: 'image',
          serverOnly: false,
        },
      ]),
    );
    const asked = new Set<string>();
    const out = await writeDocx(
      doc.envelope as unknown as JsonEnvelope,
      {
        get(id) {
          asked.add(id);
          return stored.get(id);
        },
      },
      { instant: '2026-11-06T09:30:00.000Z', timeZone: 'Europe/London', title: name },
    );

    // The package holds the document's text: every text node of eight characters or more.
    const zip = readZip(out.bytes);
    const written = zip.entries
      .filter((e) => /^word\/(document|footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(e.name))
      .map((e) => textOfPart(new TextDecoder().decode(entryData(zip, e))))
      .join('\n');
    const sample = texts(doc.envelope.doc as unknown as JsonNode).filter((t) => t.length >= 8);
    expect(sample.length).toBeGreaterThan(5);
    const missing = sample.filter((t) => !written.includes(t));
    expect(missing).toEqual([]);

    // Every image of the document was asked for and is in the package.
    for (const id of doc.attachedAssets) expect(asked, id).toContain(id);
    const media = zip.entries.filter((e) => e.name.startsWith('word/media/'));
    expect(media.length > 0).toBe(doc.assets.length > 0);

    // The importer validates what it reads, so this is validate() on the round trip.
    const back = await importDocx(out.bytes);
    expect(back.envelope.doc.content?.some((n) => n.type === 'body')).toBe(true);
    const readBack = texts(back.envelope.doc).join('');
    expect(readBack.length).toBeGreaterThan(written.length / 2);
  });

  it('records the corpus version with its results', ({ task }) => {
    task.meta.corpus = corpusStamp();
    expect(task.meta.corpus.corpus).toBe('docedit-corpus');
    expect(task.meta.corpus.version).toBeGreaterThan(0);
  });
});
