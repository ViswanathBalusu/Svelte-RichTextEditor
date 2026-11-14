/**
 * EXP-085 criterion 5 (lane U-EXP-081-096): the `tex` archive, compiled with the command its README
 * documents and the fonts it lists, gives a PDF whose text equals the service's PDF of the same
 * bundle. The service's PDF is the real sandbox compile of the bundle (compile.sh in the worker
 * image). The archive is compiled in the same image: the fonts are the image's, which the README
 * names by SHA-256, and the run has no network, a read-only root and a writable /work only.
 *
 * Needs Podman, the worker image and `pdftotext` (skips otherwise).
 */
import { describe, expect, it, vi } from 'vitest';
import { texArchive } from '@docedit/export-latex';
import { killContainer, podman } from '../src/container.ts';
import { buildBundle, compileFiles } from '../src/bundle-io.ts';
import { imageFontManifest } from '../src/fonts.ts';
import { planJob } from '../src/profile.ts';
import { compileInSandbox, IMAGE, LIMITS, sandboxArgs } from '../src/sandbox.ts';
import { sandboxReady } from '../src/sandbox-ready.ts';
import { demoDocument } from './documents.ts';
import { pdftotextAvailable, pdfText, squash } from './pdf-text.ts';

vi.setConfig({ testTimeout: 420_000, hookTimeout: 180_000 });

const ready = await sandboxReady();

/**
 * The documented command, as a shell script read from standard input (the machine route passes
 * arguments through ssh, which accepts no spaces). The archive travels inside the script as a
 * base64 here-document, so the image's shell unpacks it itself.
 */
function scriptFor(archive: Uint8Array): string {
  return [
    'set -e',
    'mkdir -p /work/job /work/.texmf-var/luatex-cache/generic',
    'cp -r /opt/docedit/luaotfload-names /work/.texmf-var/luatex-cache/generic/names',
    "base64 -d > /work/archive.tar <<'DOCEDIT_ARCHIVE'",
    Buffer.from(archive).toString('base64'),
    'DOCEDIT_ARCHIVE',
    'cd /work/job',
    'tar -x -f /work/archive.tar',
    'export TEXMFVAR=/work/.texmf-var',
    'export DOCEDIT_FONT_PATH=/opt/docedit/fonts/ SOURCE_DATE_EPOCH=0 FORCE_SOURCE_DATE=1',
    // The README's command, run twice so that page references converge as the service's do.
    'lualatex --no-shell-escape --interaction=nonstopmode --halt-on-error main.tex >/dev/null 2>&1',
    'lualatex --no-shell-escape --interaction=nonstopmode --halt-on-error main.tex >/dev/null 2>&1',
    'cat main.pdf',
    '',
  ].join('\n');
}

describe.skipIf(!ready.ok)(
  `EXP-085 archive compiles to the service's text (${ready.reason})`,
  () => {
    it.skipIf(!pdftotextAvailable())(
      'compiled with its documented command and fonts, the archive gives the same PDF text as the service (EXP-085 criterion 5)',
      async () => {
        const planned = planJob({ profile: 'preview' }, 'en');
        if (!planned.ok)
          throw new Error(`the plan refused: ${JSON.stringify(planned.diagnostics)}`);
        const plan = planned.plan;
        const fonts = await imageFontManifest(IMAGE);
        const bundle = await buildBundle(demoDocument().envelope, {
          fonts,
          tagging: 'off',
          pdfStandard: 'none',
          renderer: 'node',
          layout: 'line',
          profile: plan.profile,
          seq: 0,
          chainHead: null,
          title: 'Document',
          instant: '2026-11-13T00:00:00.000Z',
          timeZone: plan.timeZone,
          date: '13 November 2026',
          fields: plan.fields,
        });
        expect(bundle.ok, JSON.stringify(bundle.diagnostics)).not.toBe(false);

        // The service's PDF: the bundle compiled in the sandbox, as the worker compiles it.
        const service = await compileInSandbox(
          { ...compileFiles(bundle), ...(bundle.assets ?? {}) },
          {
            minPasses: plan.minPasses,
            maxPasses: plan.maxPasses,
            sourceDateEpoch: 1_788_000_000,
            name: `docedit-u-exp-081-096-s85-svc-${Date.now().toString(36)}`,
          },
        );
        expect(service.ok, service.log.slice(-2000)).toBe(true);
        const serviceText = squash(pdfText(service.pdf!)!);

        // The archive, through standard input, compiled with the documented command in the image.
        const archive = texArchive(bundle);
        // The same sandbox arguments as the worker's compile (limits, no network, dropped
        // capabilities), with the script as the entry point instead of compile.sh.
        const name = `docedit-u-exp-081-096-s85-tex-${Date.now().toString(36)}`;
        const run = await podman(sandboxArgs(name, { entrypoint: 'sh' }), {
          stdin: new TextEncoder().encode(scriptFor(archive)),
          timeoutMs: 400_000,
          maxStdoutBytes: LIMITS.outputBytes + 1024 * 1024,
          onKill: () => {
            void killContainer(name);
          },
        });
        expect(run.code, String(run.stderr).slice(-2000)).toBe(0);
        const archivePdf = new Uint8Array(run.stdout);
        expect(new TextDecoder().decode(archivePdf.subarray(0, 5))).toBe('%PDF-');
        const archiveText = squash(pdfText(archivePdf)!);
        expect(archiveText.length).toBeGreaterThan(0);
        expect(archiveText).toBe(serviceText);
      },
    );
  },
);
