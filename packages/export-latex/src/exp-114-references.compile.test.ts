/**
 * EXP-114 criterion 3 (lane U-EXP-113-123): every stored reference PDF under `test/references/`
 * is listed in its manifest, is unchanged (SHA-256), and passes veraPDF for the flavours the
 * manifest names. The references are made by `scripts/exp-114-make-references.ts` in the export
 * worker's sandbox. This test runs veraPDF in Podman (EXP-016), outside the compile sandbox (the
 * validator has its own container, verapdf.ts), so it waits only for Podman and the pinned veraPDF
 * image, not for the slow sandbox readiness probe. Without them it skips with a warning, and with
 * DOCEDIT_REQUIRE_SANDBOX=1 (the form for a CI job) it fails instead. It does not compare the
 * references with new output (criterion 2) and does not check that every corpus mapping has a
 * reference (criterion 1); both stay open in the story.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { containerCli, podmanInfo } from '../../../services/export-worker/src/container.ts';
import { sandboxRequired } from '../../../services/export-worker/src/sandbox-ready.ts';
import { VERAPDF_IMAGE } from '../../../services/export-worker/src/verapdf.ts';
import { validatePdf, type Flavour } from '../test/harness.ts';

function veraPdfAbsence(): string | null {
  if (!podmanInfo()) return 'podman info failed: Podman is not available';
  const r = spawnSync(containerCli(), ['image', 'exists', VERAPDF_IMAGE], {
    timeout: 120_000,
    windowsHide: true,
  });
  return r.status === 0
    ? null
    : `the veraPDF image ${VERAPDF_IMAGE} is not present (podman pull it)`;
}

const absent = veraPdfAbsence();
const ready = absent === null;
const required = sandboxRequired();
if (!ready && !required) console.warn(`EXP-114 criterion 3: veraPDF cases skipped: ${absent}`);
const refDir = fileURLToPath(new URL('../test/references/', import.meta.url));

interface ManifestEntry {
  file: string;
  flavours: Flavour[];
  sha256: string;
}

const manifest = JSON.parse(readFileSync(refDir + 'manifest.json', 'utf8')) as {
  references: ManifestEntry[];
};

describe('EXP-114 criterion 3: the manifest lists every stored reference PDF', () => {
  it('has a manifest entry for each PDF file and no entry without a file', () => {
    const pdfs = readdirSync(refDir)
      .filter((f) => f.endsWith('.pdf'))
      .sort();
    expect(manifest.references.map((r) => r.file).sort()).toEqual(pdfs);
  });
});

describe.runIf(!ready && required)(
  'EXP-114 criterion 3: veraPDF is required (DOCEDIT_REQUIRE_SANDBOX=1)',
  () => {
    it('has Podman and the pinned veraPDF image', () => {
      expect.fail(`veraPDF cannot run here: ${absent}`);
    });
  },
);

// The reason is in the title, so a skip shows why in the reporter (console output of the module is
// not always shown).
describe.skipIf(!ready)(
  `EXP-114 criterion 3: every reference PDF validates with veraPDF${ready ? '' : ` (skipped: ${absent})`}`,
  () => {
    for (const ref of manifest.references) {
      it(`${ref.file} is unchanged and passes veraPDF (${ref.flavours.join(', ')})`, async () => {
        const bytes = new Uint8Array(readFileSync(refDir + ref.file));
        expect(
          createHash('sha256').update(bytes).digest('hex'),
          'SHA-256 matches the manifest',
        ).toBe(ref.sha256);
        for (const flavour of ref.flavours) {
          const v = await validatePdf(bytes, flavour);
          expect(v.error, `the veraPDF output of ${flavour} parses`).toBeUndefined();
          expect(v.failures, `no ${flavour} rule fails`).toEqual([]);
          expect(v.compliant, `${flavour} compliant`).toBe(true);
        }
      }, 600_000);
    }
  },
);
