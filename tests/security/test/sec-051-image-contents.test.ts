/**
 * SEC-051 criterion 2, the image-contents half for the export worker image (10 §3.8; ADR 0044).
 * The TeX Live packages the bill lists for the image are compared with what tlmgr reports inside the
 * real image, and the font manifest is read from the image. Both reads run in Podman with no network.
 * A mismatch is what makes the release fail; a mutated listing must be reported.
 *
 * Runs against the local image localhost/docedit-export-worker:s4 (or DOCEDIT_EXPORT_WORKER_IMAGE).
 * The runs pass --cgroups=disabled: on the test host Podman 6 cannot attach a container when the
 * pids controller is missing from its cgroup, and the image runs fine without cgroup accounting.
 * Skipped when the container CLI or the image is missing. The Syft comparison of the npm packages
 * stays with CI (Syft is not installed here).
 *
 * Run: pnpm vitest run --project <security project> tests/security/test/sec-051-image-contents.test.ts
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { compareTexWithImage, imageSbom } from '../../../scripts/release/sbom.ts';
import { parseTlmgrInfo, type TexPackage } from '../../../scripts/release/texlive.ts';
import type { FontManifest } from '../../../scripts/release/texlive.ts';

const cli = process.env['DOCEDIT_CONTAINER_CLI'] || 'podman';
const image = process.env['DOCEDIT_EXPORT_WORKER_IMAGE'] || 'localhost/docedit-export-worker:s4';
const FIELDS = 'name,category,localrev,cat-version,cat-license';

function run(args: string[]): string | null {
  try {
    return execFileSync(cli, args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

const available = run(['image', 'exists', image]) !== null;

describe.runIf(available)(
  'SEC-051 the export worker image bill matches the image (criterion 2)',
  () => {
    let tex: TexPackage[] = [];
    let fonts: FontManifest | null = null;
    let texText = '';

    it('reads tlmgr and the font manifest from inside the image without network', () => {
      const out = run([
        'run',
        '--rm',
        '--cgroups=disabled',
        '--network=none',
        '--entrypoint',
        'tlmgr',
        image,
        'info',
        '--only-installed',
        '--data',
        FIELDS,
      ]);
      expect(out).not.toBeNull();
      texText = out ?? '';
      tex = parseTlmgrInfo(texText);
      expect(tex.length).toBeGreaterThan(100);

      const manifest = run([
        'run',
        '--rm',
        '--cgroups=disabled',
        '--network=none',
        '--entrypoint',
        'cat',
        image,
        '/opt/docedit/fonts/fonts.json',
      ]);
      expect(manifest).not.toBeNull();
      fonts = JSON.parse(manifest ?? 'null') as FontManifest;
      expect(fonts.families.length).toBeGreaterThan(0);
      // Two container runs; `tlmgr info` over the whole TeX Live tree takes longer than the default
      // 60 s on a loaded machine. The timeout covers the real work, the assertions are unchanged.
    }, 240_000);

    it('the bill built from the image lists every TeX Live package the image holds, both ways', () => {
      const r = imageSbom({
        id: 'export-worker',
        image: 'localhost/docedit-export-worker',
        tex,
        fonts,
        ctx: {
          version: '0.0.0-sec-051',
          created: '2026-11-06T00:00:00Z',
          namespaceBase: 'https://docedit.invalid/spdx',
          projectLicence: 'Apache-2.0',
        },
      });
      expect(r.problems).toEqual([]);
      expect(compareTexWithImage(r.doc, tex)).toEqual([]);

      // A mismatch fails the comparison: a bill missing one package, and a bill with an extra one.
      const withoutFirst = r.doc.packages.filter(
        (p, i) => !(i > 0 && p.SPDXID.startsWith('SPDXRef-texlive-') && p.name === tex[0]!.name),
      );
      const missing = { ...r.doc, packages: withoutFirst };
      expect(compareTexWithImage(missing, tex).join('\n')).toMatch(
        new RegExp(
          `TeX Live package ${tex[0]!.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} .* is in the image but not in its bill`,
        ),
      );
      const extra = parseTlmgrInfo(`${texText}\nsec051-phantom,TLCore,1,1.0,gpl2+\n`);
      expect(compareTexWithImage(r.doc, extra).join('\n')).toMatch(/sec051-phantom/);
    }, 240_000);
  },
);
