/**
 * EXP-048 criterion 1, the class side (Node.js, compiled locally through `test/cdm-local-tex.ts`).
 * A tenant's font comes with the job in `tenant-fonts/<hash>.ttf` (the export worker puts it there
 * for that tenant's jobs only; `services/export-worker/src/exp-048-tenant-fonts.test.ts`). The
 * class takes a family's files from that directory when the file is there, and from the image's
 * font directory otherwise (`docedit.fontpath_of` in `class/docedit.lua`).
 *
 * The tenant face is a copy of a local face with one header word changed (the head table's check
 * sum adjustment), so its hash is in no font directory of this host. Two compiles of one bundle:
 * with the file in `tenant-fonts/` the document compiles and prints the paragraph in that family;
 * without it the compile fails, because the face is nowhere else. Skips when `lualatex` or the
 * local fonts are not present.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import {
  compileLocal,
  convertLocal,
  lualatexAvailable,
  localFonts,
} from '../test/cdm-local-tex.ts';

const ready = lualatexAvailable();
const FONT_DIR = fileURLToPath(
  new URL('../../../services/export-worker/out/fonts-local/', import.meta.url),
);

/** The bytes of a local face with its head table's checkSumAdjustment changed. */
function tenantFace(file: string): { bytes: Uint8Array; sha256: string; name: string } {
  const bytes = new Uint8Array(readFileSync(join(FONT_DIR, file)));
  const v = new DataView(bytes.buffer);
  const count = v.getUint16(4);
  for (let i = 0; i < count; i++) {
    const rec = 12 + 16 * i;
    const tag = String.fromCharCode(bytes[rec]!, bytes[rec + 1]!, bytes[rec + 2]!, bytes[rec + 3]!);
    if (tag === 'head') v.setUint32(v.getUint32(rec + 8) + 8, 0x0badf00d);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha256, name: `${sha256}.ttf` };
}

describe.skipIf(!ready)('EXP-048 criterion 1 (class side): a tenant font in tenant-fonts/', () => {
  it('compiles with the file in the job directory, and not without it', async () => {
    const fonts = localFonts();
    const base = fonts.families[0]!;
    const t = tenantFace(base.regular.file);
    const face = { file: t.name, sha256: t.sha256 };
    const withTenant = {
      ...fonts,
      families: [
        ...fonts.families,
        {
          ...base,
          name: 'Acme Sans',
          regular: face,
          bold: face,
          italic: face,
          boldItalic: face,
          serverUse: true,
        },
      ],
    };
    const body: J[] = [
      para('', {}, [
        {
          type: 'text',
          text: 'TENANTWORD',
          marks: [{ type: 'fontFamily', attrs: { value: 'Acme Sans' } }],
        },
      ]),
    ];
    const bundle = await convertLocal(
      doc(body) as never,
      {
        fonts: withTenant,
        profile: 'preview',
        title: 'exp-048',
      } as never,
    );
    expect(bundle.files['styles.tex']).toContain(t.name);

    const withFile = {
      ...bundle,
      assets: { ...bundle.assets, [`tenant-fonts/${t.name}`]: t.bytes },
    };
    const yes = compileLocal(withFile, 'exp-048-with');
    if (!yes.ok || !yes.pdf)
      throw new Error(`the compile failed (${yes.dir}):\n${yes.log.slice(-1500)}`);
    expect(Buffer.from(yes.pdf).toString('latin1')).toContain('%PDF');

    const no = compileLocal(bundle, 'exp-048-without');
    expect(no.ok).toBe(false);
  }, 300_000);
});
