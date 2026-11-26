/**
 * EXP-048 criterion 1 in the export worker's sandbox (Node.js, Podman; `DOCEDIT_PODMAN_MACHINE` on
 * Windows). The same bundle as `exp-048-tenant-font.compile.test.ts`, compiled in the container:
 * the tenant's face travels in the job's tar under `tenant-fonts/`, the read-only image does not
 * have it, and the document compiles and prints. The image is the one `IMAGE` names; the bundle
 * carries its own copy of the class. Skips when `sandboxReady()` reports that sandboxed compiles
 * cannot run here (EXP-070).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { convert } from './index.ts';
import { classFiles, compileBundle, imageFonts, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;
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

describe.skipIf(!ready)('EXP-048 criterion 1 (sandbox): a tenant font in tenant-fonts/', () => {
  it('compiles in the container with the file in the job tar, and not without it', async () => {
    const fonts = await imageFonts();
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
    const bundle = await convert(doc(body), {
      fonts: withTenant,
      classFiles: classFiles(),
      profile: 'preview',
      title: 'exp-048',
    });
    expect(bundle.files['styles.tex']).toContain(t.name);

    const withFile = {
      ...bundle,
      assets: { ...bundle.assets, [`tenant-fonts/${t.name}`]: t.bytes },
    };
    const yes = await compileBundle(withFile, { maxPasses: 2 });
    if (!yes.compile.ok || !yes.compile.pdf)
      throw new Error(`the compile failed:
${yes.compile.log.slice(-1500)}`);
    expect(pdfText(yes.compile.pdf)).toContain('TENANTWORD');

    const no = await compileBundle(bundle, { maxPasses: 2 });
    expect(no.compile.ok).toBe(false);
  }, 900_000);
});
