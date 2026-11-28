/**
 * SEC-053 criterion 3 and EXP-073 criteria 3 and 4 (export worker, Podman): the licence manifest
 * and the source offer that a release lists are made from what is inside the real image. The same
 * three reads as `scripts/release/image.ts` (`tlmgr info --only-installed`, fonts.json,
 * `dpkg-query`) are run against the image, and the manifest and the offer are built from them
 * with `scripts/release/licence-manifest.ts`. The two files are written to `out/licence/` (not
 * under version control) so a person can read them. Skipped when Podman or the worker image is
 * not available here (see sandbox-ready.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TLMGR_FIELDS } from '../../../scripts/release/image.ts';
import {
  DPKG_STATUS,
  licenceManifest,
  parseDpkg,
  sourceOffer,
  type LicenceManifestInput,
} from '../../../scripts/release/licence-manifest.ts';
import { parseTlmgrInfo, type FontManifest } from '../../../scripts/release/texlive.ts';
import { podman } from './container.ts';
import { IMAGE } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

const ready = await sandboxReady();

async function inside(entrypoint: string, args: string[]): Promise<string> {
  const r = await podman(
    [
      'run',
      '--rm',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--user=10001:10001',
      `--entrypoint=${entrypoint}`,
      IMAGE,
      ...args,
    ],
    { timeoutMs: 120_000, maxStdoutBytes: 16 * 1024 * 1024 },
  );
  expect(r.code, r.stderr.slice(0, 400)).toBe(0);
  return new TextDecoder().decode(r.stdout);
}

describe.skipIf(!ready.ok)(
  `SEC-053 criterion 3: the licence manifest and the source offer of the image (${ready.reason})`,
  () => {
    it('lists every TeX Live package of the image with its Catalogue licence, and names LuaTeX in the offer', async () => {
      const tex = parseTlmgrInfo(
        await inside('tlmgr', ['info', '--only-installed', '--data', TLMGR_FIELDS]),
      );
      const kept = (await inside('cat', ['/opt/docedit/licences/tex/tex-packages-kept.txt']))
        .split('\n')
        .filter(Boolean);
      const fonts = JSON.parse(
        await inside('cat', ['/opt/docedit/fonts/fonts.json']),
      ) as FontManifest;
      const baseSystem = parseDpkg(await inside('cat', [DPKG_STATUS]));
      const input: LicenceManifestInput = {
        image: 'localhost/docedit-export-worker',
        imageId: 'sha256:' + '0'.repeat(64),
        version: '0.0.0-test',
        base: null,
        tex,
        fonts,
        houseClass: { version: '0.2.23', licence: 'Apache-2.0' },
        baseSystem,
      };
      const manifest = licenceManifest(input);
      const offer = sourceOffer(input);

      // Everything the image keeps is listed, and nothing else.
      expect(manifest.tex.packages.map((p) => p.name).sort()).toEqual([...kept].sort());
      expect(manifest.tex.packageCount).toBe(kept.length);
      // The licences are the Catalogue's: LaTeX packages are LPPL, LuaTeX is GPL.
      const luatex = manifest.tex.packages.find((p) => p.name === 'luatex');
      expect(luatex?.licences.some((l) => /^gpl/i.test(l))).toBe(true);
      expect(manifest.tex.byLicence['lppl1.3c']).toBeGreaterThan(0);
      expect(manifest.copyleft.map((c) => c.name)).toContain('luatex');
      // The fonts and the base system are in it.
      expect(manifest.fonts.length).toBeGreaterThan(0);
      expect(manifest.fonts.every((f) => f.licence.length > 0)).toBe(true);
      expect(manifest.baseSystem.packageCount).toBeGreaterThan(0);
      expect(manifest.houseClass.licence).toBe('Apache-2.0');
      // The offer names LuaTeX and the revision of the database.
      expect(offer).toMatch(
        new RegExp(`\\| luatex \\| [^|]+ \\| [^|]*gpl[^|]* \\| ${luatex?.revision} \\|`, 'i'),
      );

      const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'out', 'licence');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'release-licence-manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      writeFileSync(join(dir, 'release-source-offer.md'), offer);
      console.log(
        `licence manifest: ${manifest.tex.packageCount} TeX Live packages, ${manifest.tex.unknownLicence.length} without a Catalogue licence, ${manifest.copyleft.length} GNU-licensed, ${manifest.baseSystem.packageCount} base system packages`,
      );
    }, 300_000);
  },
);
