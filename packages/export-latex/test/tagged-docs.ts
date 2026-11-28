/**
 * Documents and helpers for the tagged-PDF compile tests (EXP-111, EXP-112; Node.js only).
 */
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { CdmEnvelope } from '@docedit/model';
import { nid, para, type J } from './docs.ts';
import { convertAndCompile, keep } from './harness.ts';

export const INSTANT = '2026-11-06T10:00:00.000Z';

/** A PNG of one colour, `size` pixels square (8-bit RGB), made here so no file is read. */
export function png(size = 8, rgb: readonly [number, number, number] = [200, 30, 30]): Uint8Array {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: size }, () => rgb).flat()),
  ]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', head),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** The `assets` option for one PNG under the asset identifier `id`. */
export function pngAsset(id: string): Record<string, unknown> {
  const bytes = png();
  return {
    [id]: {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mediaType: 'image/png',
      status: 'ready',
      bytes,
    },
  };
}

export const numbering = (id: string, levels: J[]): J => ({
  type: 'numbering_def',
  attrs: { id, levels },
});

export const item = (text: string, numberingId: string, listId: string, level = 0): J =>
  para(text, { numbering: { numberingId, level, listId } });

export const cell = (text: string, attrs: J = {}): J => ({
  type: 'table_cell',
  attrs: { id: nid('c'), ...attrs },
  content: [para(text)],
});
export const row = (...cells: J[]): J => ({
  type: 'table_row',
  attrs: { id: nid('r') },
  content: cells,
});

export const story = (id: string, paragraphs: J[]): J => ({
  type: 'story',
  attrs: { id },
  content: paragraphs,
});

export const field = (kind: string): J => ({ type: 'field', attrs: { id: nid('f'), kind } });

export const A4: J = {
  width: 11906,
  height: 16838,
  marginTop: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  marginRight: 1440,
  gutter: 0,
  headerDistance: 720,
  footerDistance: 720,
};

/** Compiles a document as a tagged PDF in the sandbox and returns the PDF; throws with the log. */
export async function taggedPdf(
  name: string,
  envelope: CdmEnvelope,
  options: Record<string, unknown> = {},
  compileOptions: { limits?: { wallSeconds?: number; memoryMiB?: number } } = {},
): Promise<Uint8Array> {
  const c = await convertAndCompile(
    envelope,
    {
      profile: 'final',
      title: name,
      instant: INSTANT,
      timeZone: 'Europe/London',
      suggestions: 'accept',
      layout: 'block',
      tagging: 'on',
      pdfStandard: 'ua-2',
      ...options,
    } as never,
    compileOptions,
  );
  // DOCEDIT_KEEP=1 writes the bundle and the log of every compile to the temporary directory.
  if (process.env['DOCEDIT_KEEP'] === '1') keep(name, c);
  if (!c.compile.ok || !c.compile.pdf)
    throw new Error(
      `the compile of ${name} failed (${keep(name, c)}):\n${c.compile.log.slice(-1500)}`,
    );
  return c.compile.pdf;
}
