/**
 * EXP-015 criterion 1 (lane U-EXP-001-016): every package that `docedit.cls` loads works with
 * tagging in the pinned TeX Live. The document is the kitchen-sink CDM fixture with a two-column
 * section added (exp-015-u-exp-001-016.fixture.ts) and its pictures supplied as PNG assets, so that
 * each package the class loads is used: the test first checks that the converter's output reaches
 * every one of them (`CLASS_PACKAGE_USE`). It is compiled in the sandbox with tagging on and
 * validated by veraPDF as PDF/UA-2 and PDF/A-4f. The compile log must show each package loaded,
 * the layout must show the paragraphs of the two-column section set in two columns, and the TeX
 * Live inside the image must be the one services/export-worker/Containerfile pins (release year,
 * LuaHBTeX, the LaTeX kernel and tagpdf). Needs Podman and the worker image; skips otherwise.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FontManifest } from '@docedit/export-latex';
import { describe, expect, it, vi } from 'vitest';
import { podman } from './container.ts';
import {
  CLASS_PACKAGE_USE,
  COLUMN_PARAGRAPHS,
  packagesAssets,
  packagesDocument,
  pinnedTexLive,
} from './exp-015-u-exp-001-016.fixture.ts';
import { runExport } from './pipeline.ts';
import { IMAGE } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';
import { validatePdf } from './verapdf.ts';

vi.setConfig({ testTimeout: 600_000 });

const ready = await sandboxReady();

/**
 * Runs `entrypoint` in the worker image, with no network and a read-only root, and returns stdout.
 * A failed run throws with its stderr. Only a container that could not be started (an OCI runtime
 * error of a loaded shared Podman host) is tried again, twice.
 */
async function inImage(entrypoint: string, args: string[]): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const r = await podman(
      [
        'run',
        '--rm',
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        `--entrypoint=${entrypoint}`,
        IMAGE,
        ...args,
      ],
      { timeoutMs: 120_000, maxStdoutBytes: 1024 * 1024 },
    );
    if (r.code === 0) return new TextDecoder().decode(r.stdout);
    if (attempt >= 3 || !/OCI runtime error/.test(r.stderr))
      throw new Error(`${entrypoint} in the image failed (${String(r.code)}): ${r.stderr}`);
  }
}

const imageFonts = async () =>
  JSON.parse(await inImage('cat', ['/opt/docedit/fonts/fonts.json'])) as FontManifest;

const CLASS = readFileSync(
  fileURLToPath(new URL('../../../packages/export-latex/class/docedit.cls', import.meta.url)),
  'utf8',
);
const CONTAINERFILE = readFileSync(
  fileURLToPath(new URL('../Containerfile', import.meta.url)),
  'utf8',
);

/** The packages the class loads, in order (comments removed). */
const loaded = [
  ...CLASS.replace(/(^|[^\\])%.*$/gm, '$1').matchAll(/\\RequirePackage(?:\[[^\]]*\])?\{([^}]+)\}/g),
]
  .flatMap((m) => m[1]!.split(','))
  .map((p) => p.trim())
  // `\def\RequirePackage{\ClassError...}` (the refusal for bundles) loads nothing.
  .filter((p) => /^[A-Za-z][\w-]*$/.test(p));

describe('EXP-015 criterion 1: the fixture names a use for every package', () => {
  it('the packages the class loads are the packages the fixture names a use for', () => {
    expect(loaded.length).toBeGreaterThan(0);
    expect(new Set(loaded)).toEqual(new Set(Object.keys(CLASS_PACKAGE_USE)));
  });
});

describe.skipIf(!ready.ok)(`EXP-015 packages with tagging (${ready.reason})`, () => {
  it('the converter output reaches every package the class loads', async () => {
    const { buildBundle } = await import('./bundle-io.ts');
    const bundle = await buildBundle(packagesDocument(), {
      fonts: await imageFonts(),
      tagging: 'on',
      pdfStandard: 'ua-2+a-4f',
      layout: 'block',
      title: 'Kitchen sink',
      assets: packagesAssets(),
    });
    const tex = `${bundle.files['styles.tex']}\n${bundle.files['main.tex']}`;
    for (const [pkg, use] of Object.entries(CLASS_PACKAGE_USE))
      if (use) expect(use.test(tex), `the bundle uses ${pkg} (${use})`).toBe(true);
  });

  it('the image runs the pinned TeX Live', async () => {
    const pin = pinnedTexLive(CONTAINERFILE);
    const release = await inImage('cat', [`/usr/local/texlive/${pin.release}/release-texlive.txt`]);
    expect(release.split('\n')[0]).toMatch(new RegExp(`version ${pin.release}\\b`));
    const engine = await inImage('luahbtex', ['--version']);
    expect(engine.split('\n')[0]).toContain(`Version ${pin.luahbtex}`);
  });

  it('compiles the document with tagging on and validates it as PDF/UA-2 and PDF/A-4f', async () => {
    const pin = pinnedTexLive(CONTAINERFILE);
    const r = await runExport(
      packagesDocument(),
      await imageFonts(),
      {
        tagging: 'on',
        pdfStandard: 'ua-2+a-4f',
        layout: 'block',
        title: 'Kitchen sink',
        assets: packagesAssets(),
      },
      { kind: 'sandbox' },
    );
    const log = r.compile.log;
    expect(r.compile.ok, log.slice(-3000)).toBe(true);

    // The kernel and tagpdf of the pinned TeX Live; every package of the class loaded.
    expect(log).toContain(`LaTeX2e <${pin.latex}>`);
    expect(log).toMatch(new RegExp(`Package: tagpdf \\S+ v${pin.tagpdf.replace('.', '\\.')}\\b`));
    for (const pkg of loaded)
      expect(log, `the log shows ${pkg} loaded`).toMatch(
        new RegExp(`(Package|File): ${pkg.replace(/[-.]/g, '\\$&')} \\d{4}[-/]`),
      );

    // The two-column section: on the page that holds its paragraphs, a later paragraph starts
    // higher than an earlier one, which a single column cannot do.
    expect(r.layoutErrors).toEqual([]);
    const blocks = COLUMN_PARAGRAPHS.map((id) => r.layout!.blocks[id]!);
    expect(blocks.every((b) => b !== undefined)).toBe(true);
    const sameColumnPage = blocks.filter((b) => b.page === blocks[0]!.page);
    expect(sameColumnPage.some((b, i) => i > 0 && b.y < sameColumnPage[i - 1]!.y)).toBe(true);

    for (const flavour of ['ua2', '4f'] as const) {
      const v = await validatePdf(r.compile.pdf!, flavour);
      expect(v.error).toBeUndefined();
      expect(v.compliant, JSON.stringify(v.failures.slice(0, 5))).toBe(true);
    }
  });
});
