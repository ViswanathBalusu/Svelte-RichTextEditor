// The release notes state the kit version and the protocol version it tests (PRO-127 criterion 3).
// The notes are written by the release pipeline (`scripts/release/notes.ts`, FND-012), which reads
// the kit's version from its package manifest. The kit reports its own version in every report, so
// the two must be one number: otherwise the notes would name a kit that no run ever reports.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEP1 } from '@docedit/protocol';
import { readCompatibility, renderReleaseNotes } from '../../../scripts/release/notes.ts';
import { KIT_VERSION } from '../src/runner.ts';

const root = resolve(import.meta.dirname, '../../..');

describe('the kit in the release notes (PRO-127 criterion 3)', () => {
  const compatibility = readCompatibility(root);

  it('reads the kit and the protocol of this repository', () => {
    expect(compatibility.kit).toEqual({ name: '@docedit/tck', version: KIT_VERSION });
    expect(compatibility.protocol?.version).toBe(DEP1.version);
  });

  it('is the version the kit reports about itself, and the protocol its reports name', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'packages/tck/package.json'), 'utf8'),
    ) as { version: string };
    expect(manifest.version).toBe(KIT_VERSION);
    // `runKit` names the protocol it tests in `report.kit.protocol`; the release notes read the same.
    expect(compatibility.protocol?.version).toBe('1.0');
  });

  it('states both in the release notes of a release', () => {
    const notes = renderReleaseNotes({
      version: '0.1.0',
      date: '2026-11-18',
      dryRun: true,
      previous: null,
      compatibility,
      artefacts: [],
      images: [],
      missing: [],
      changes: [],
      coverage: [],
    });
    expect(notes).toContain(`| Protocol (DEP) | ${DEP1.version},`);
    expect(notes).toContain(
      `| Conformance kit | @docedit/tck ${KIT_VERSION}, tests protocol ${DEP1.version} | |`,
    );
  });
});
