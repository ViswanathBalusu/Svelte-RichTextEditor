// CDM-050 criterion 2: the package says which `cdm` version and which build of itself a commit
// stamp carries. The room that writes the stamp is tested in packages/authority.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CDM1, MODEL_PACKAGE, modelStampIdentity } from '../src/definition/index.ts';
import { supportedVersions } from '../src/validate/read.ts';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
  name: string;
  version: string;
};

describe('the stamp identity of the model package (CDM-050)', () => {
  it('names the cdm version of its definition and the package as name@version', () => {
    const id = modelStampIdentity();
    expect(id.cdm).toBe(CDM1.cdm);
    expect(id.cdm).toBe(supportedVersions().max);
    expect(id.package).toBe(`${manifest.name}@${manifest.version}`);
  });

  it('keeps the constant equal to package.json, so a release cannot stamp a stale version', () => {
    expect(MODEL_PACKAGE.name).toBe(manifest.name);
    expect(MODEL_PACKAGE.version).toBe(manifest.version);
  });

  it('follows the definition it is given', () => {
    expect(modelStampIdentity({ ...CDM1, cdm: 2 }).cdm).toBe(2);
  });
});
