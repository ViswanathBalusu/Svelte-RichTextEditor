// EXP-015 criterion 4, the cache-key part (lane w2): the house class version the converter
// releases (`CLASS_VERSION`, the last entry of packages/export-latex/class/releases.json) is the
// version the document service keys every export request by, and the one this worker compiles
// with. So a released class change gives every request a new key, and a job keyed under another
// class version is not answered by this worker's class.
import { readFileSync } from 'node:fs';
import { exportRequestKey, SERVICE_DEFAULTS } from '@docedit/document-service';
import { CLASS_VERSION } from '@docedit/export-latex';
import { describe, expect, it } from 'vitest';

const ledger = JSON.parse(
  readFileSync(
    new URL('../../../packages/export-latex/class/releases.json', import.meta.url),
    'utf8',
  ),
) as { releases: Array<{ version: string }> };

const request = {
  tenant: 'tenant-1',
  doc: 'doc-1',
  incarnation: 'inc-1',
  seq: 7,
  view: 'full',
  options: {},
  full: true,
};

describe('EXP-015 criterion 4: the class version is in every cache key', () => {
  it('the service keys requests by the released class version unless it is configured otherwise', () => {
    const released = ledger.releases.at(-1)?.version;
    expect(released).toBe(CLASS_VERSION);
    expect(SERVICE_DEFAULTS.exportClassVersion).toBe(released);
  });

  it('every target and profile of a request gets another key under another class version', () => {
    const previous = ledger.releases.at(-2)?.version;
    expect(previous).toBeDefined();
    expect(previous).not.toBe(CLASS_VERSION);
    for (const target of ['pdf', 'latex'])
      for (const options of [{}, { preview: true }, { tagging: 'draft' }]) {
        const now = exportRequestKey({ ...request, target, options, classVersion: CLASS_VERSION });
        const before = exportRequestKey({ ...request, target, options, classVersion: previous! });
        expect(now, `${target} ${JSON.stringify(options)}`).not.toBe(before);
        expect(exportRequestKey({ ...request, target, options, classVersion: CLASS_VERSION })).toBe(
          now,
        );
      }
  });
});
