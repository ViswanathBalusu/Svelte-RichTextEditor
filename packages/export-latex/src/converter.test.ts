/**
 * Converter contract tests (Node.js only): EXP-002 (stateless, in step with the model) and EXP-011
 * (the bundle and its manifest). The documents come from `test/docs.ts`; nothing here compiles.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '@docedit/model';
import { CLASS_FILES, FONTS, codes, doc, nid, para, run } from '../test/docs.ts';
import { bundleHashInput, canonicalJson, cdmWriter, latexWriter } from './index.ts';

const sha256 = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

/** A small document: two paragraphs in two styles and one picture of a ready PNG asset. */
const PNG_SHA = 'c'.repeat(64);
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
function sample(): CdmEnvelope {
  return doc(
    [
      para('First paragraph.'),
      para('Second paragraph.', { style: 'Normal' }),
      {
        type: 'figure',
        attrs: { id: nid('f'), asset: 'pic1', width: 1440, height: 1440, alt: 'A picture' },
      },
    ],
    {
      styles: [
        {
          type: 'style_def',
          attrs: { id: 'Heading1', kind: 'paragraph', name: 'Heading 1', builtIn: true },
        },
      ],
    },
  );
}
const ASSETS = {
  pic1: { sha256: PNG_SHA, mediaType: 'image/png', status: 'ready' as const, bytes: PNG_BYTES },
};

describe('EXP-002 converter is stateless and in step with the model', () => {
  it('gives byte-identical bundles for the same input, run twice', async () => {
    const env = sample();
    const a = await run(structuredClone(env), {
      assets: ASSETS,
      seq: 7,
      chainHead: 'ab'.repeat(32),
    });
    const b = await run(structuredClone(env), {
      assets: ASSETS,
      seq: 7,
      chainHead: 'ab'.repeat(32),
    });
    expect(b.files).toEqual(a.files);
    expect(b.map).toEqual(a.map);
    expect(b.manifest).toEqual(a.manifest);
    expect(b.manifest.bundleHash).toBe(a.manifest.bundleHash);
    expect(Object.keys(b.assets)).toEqual(Object.keys(a.assets));
  });

  it('does not change the envelope it reads', async () => {
    const env = sample();
    const before = JSON.stringify(env);
    await run(env, { assets: ASSETS });
    expect(JSON.stringify(env)).toBe(before);
  });

  it('fails with a diagnostic naming a required feature it cannot read, and opens nothing', async () => {
    const bundle = await run(doc([para('Text.')], { requires: ['tracked-changes-v9'] }));
    expect(bundle.ok).toBe(false);
    const d = bundle.diagnostics.find((x) => x.code === 'unsupported_feature');
    expect(d?.severity).toBe('error');
    expect(d?.message).toContain('tracked-changes-v9');
  });

  it('accepts the features it reads without a diagnostic', async () => {
    const bundle = await run(doc([para('Text.')], { requires: ['fields', 'extensions'] }));
    expect(codes(bundle)).not.toContain('unsupported_feature');
    expect(bundle.ok).toBe(true);
  });

  it('keeps Pandoc out of the PDF path: no dependency and no import of it', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(names.some((n) => /pandoc/i.test(n))).toBe(false);
  });

  it('gives the writer interface no LaTeX-specific type: the CDM writer reads the same input', async () => {
    const env = sample();
    const json = await cdmWriter.write(
      { document: env, seq: 1, chainHead: null, fonts: FONTS, assets: {} },
      {},
    );
    expect(json.sha256).toBe(sha256(json.bytes));
    const tex = await latexWriter.write(
      { document: env, seq: 1, chainHead: null, fonts: FONTS, assets: ASSETS },
      {
        classFiles: CLASS_FILES,
      },
    );
    expect(tex.manifest.seq).toBe(1);
  });
});

describe('EXP-011 the bundle holds its files and a manifest', () => {
  it('holds main.tex, styles.tex, the class, map.json and manifest.json, with the picture under assets/, and no font file', async () => {
    const bundle = await run(sample(), { assets: ASSETS });
    expect(Object.keys(bundle.files).sort()).toEqual(
      ['docedit.cls', 'docedit.lua', 'main.tex', 'manifest.json', 'map.json', 'styles.tex'].sort(),
    );
    expect(Object.keys(bundle.assets)).toEqual([`assets/${PNG_SHA}.png`]);
    const all = [...Object.keys(bundle.files), ...Object.keys(bundle.assets)];
    expect(all.some((n) => /\.(ttf|otf|ttc|otc)$/i.test(n))).toBe(false);
  });

  it('records seq, chain head, CDM version, class version, fonts with hashes, options and the bundle hash', async () => {
    const head = 'ef'.repeat(32);
    const bundle = await run(sample(), {
      assets: ASSETS,
      seq: 42,
      chainHead: head,
      title: 'Report',
    });
    const m = bundle.manifest;
    expect(m.seq).toBe(42);
    expect(m.chainHead).toBe(head);
    expect(m.cdm).toBe(1);
    expect(m.classVersion).toMatch(/^\d+\.\d+\.\d+$/);
    const serif = m.fonts.find((f) => f.family === 'Noto Serif');
    expect(serif?.files.map((f) => f.sha256)).toEqual(
      ['a', 'b', 'c', 'd'].map((c) => c.repeat(64)),
    );
    expect(m.fonts.find((f) => f.role === 'math')?.files[0]?.sha256).toBe(FONTS.math.sha256);
    expect(m.options['profile']).toBe('final');
    expect(m.options['title']).toBe('Report');
    expect(m.bundleHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lists the SHA-256 of every file but the manifest, and the bundle hash over those lines', async () => {
    const bundle = await run(sample(), { assets: ASSETS });
    const expected: Record<string, string> = {};
    for (const [name, text] of Object.entries(bundle.files))
      if (name !== 'manifest.json') expected[name] = sha256(text);
    for (const [name, bytes] of Object.entries(bundle.assets)) expected[name] = sha256(bytes);
    expect(bundle.manifest.files).toEqual(
      Object.fromEntries(Object.entries(expected).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))),
    );
    const optionsDigest = sha256(canonicalJson(bundle.manifest.options));
    expect(bundle.manifest.bundleHash).toBe(
      sha256(bundleHashInput(bundle.manifest.files, optionsDigest)),
    );
  });

  it('changes the bundle hash when an option reaches no file (EXP-005 criterion 6)', async () => {
    const a = await run(doc([para('One.')]), { timeZone: 'UTC' });
    const b = await run(doc([para('One.')]), { timeZone: 'Europe/Berlin' });
    // The block identifiers come from a counter, so only the files that hold no identifier are compared.
    for (const n of ['main.tex', 'styles.tex', 'docedit.cls']) expect(b.files[n]).toBe(a.files[n]);
    expect(b.manifest.options.timeZone).not.toBe(a.manifest.options.timeZone);
    expect(b.manifest.bundleHash).not.toBe(a.manifest.bundleHash);
  });

  it('changes the bundle hash when any file changes (property over the class file)', async () => {
    const env = sample();
    const base = await run(structuredClone(env), { assets: ASSETS });
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 40 }), async (extra) => {
        const changed = await run(structuredClone(env), {
          assets: ASSETS,
          classFiles: { ...CLASS_FILES, 'docedit.cls': `% class\n${extra}` },
        });
        if (changed.files['docedit.cls'] === base.files['docedit.cls']) {
          expect(changed.manifest.bundleHash).toBe(base.manifest.bundleHash);
        } else {
          expect(changed.manifest.bundleHash).not.toBe(base.manifest.bundleHash);
        }
      }),
      { numRuns: 25 },
    );
  });

  it('changes the bundle hash when the text of the document changes', async () => {
    const a = await run(doc([para('One.')]));
    const b = await run(doc([para('Two.')]));
    expect(b.manifest.bundleHash).not.toBe(a.manifest.bundleHash);
  });
});
