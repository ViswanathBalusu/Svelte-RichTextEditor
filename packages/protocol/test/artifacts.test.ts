// Published artifacts (SPK-019; PRO-001 to PRO-003): byte-equal to a fresh generation, generated
// twice identically, carrying protocol version 1.0, and referencing the CDM schema unchanged.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEP1 } from '../src/definition/index.ts';
import { generateArtifacts } from '../src/generate/artifacts.ts';
import { CDM_PATH, readJson, readText, root } from './support.ts';

const cdm = () => ({ path: CDM_PATH, text: readText(CDM_PATH) });
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('the published DEP artifacts', () => {
  it('match a fresh generation byte for byte', async () => {
    for (const a of await generateArtifacts(DEP1, cdm())) {
      const file = resolve(root, a.path);
      expect(
        existsSync(file),
        `${a.path} is missing; run pnpm --filter @docedit/protocol generate`,
      ).toBe(true);
      expect(
        readText(a.path),
        `${a.path} is stale; run pnpm --filter @docedit/protocol generate`,
      ).toBe(a.text);
    }
  });

  it('are identical when generated twice', async () => {
    const first = await generateArtifacts(DEP1, cdm());
    const second = await generateArtifacts(DEP1, cdm());
    expect(second).toEqual(first);
  });

  it('carry protocol version 1.0', () => {
    expect(readJson('spec/dep/dep-1.asyncapi.json')['info']).toMatchObject({ version: '1.0' });
    expect(readJson('spec/dep/dep-1.openapi.json')['info']).toMatchObject({ version: '1.0' });
    expect(readJson('spec/dep/dep-1.manifest.json')).toMatchObject({
      protocol: '1.0',
      subprotocol: 'dep.v1',
    });
  });

  it('record the hash of every file in the manifest', () => {
    const manifest = readJson<{ files: Record<string, string> }>('spec/dep/dep-1.manifest.json');
    for (const [path, hash] of Object.entries(manifest.files))
      expect(sha(readText(path)), path).toBe(hash);
  });

  it('include the CDM schema unchanged, with the versions discovery announces (PRO-003)', () => {
    const manifest = readJson<{
      cdm: { schema: string; sha256: string; id: string; min: number; max: number };
    }>('spec/dep/dep-1.manifest.json');
    const cdmManifest = readJson<{ cdm: number; files: Record<string, string> }>(
      'spec/cdm/cdm-1.manifest.json',
    );
    expect(manifest.cdm.schema).toBe(CDM_PATH);
    // The file is the CDM epic's, as its own manifest records it: DEP references it and never copies it.
    expect(manifest.cdm.sha256).toBe(cdmManifest.files[CDM_PATH]);
    expect(sha(readText(CDM_PATH))).toBe(manifest.cdm.sha256);
    expect(manifest.cdm.id).toBe(readJson(CDM_PATH)['$id']);
    expect([manifest.cdm.min, manifest.cdm.max]).toEqual([cdmManifest.cdm, cdmManifest.cdm]);
    expect(DEP1.cdm).toEqual({ min: cdmManifest.cdm, max: cdmManifest.cdm });
  });

  it('list every gap and decision of the definition', () => {
    const gaps = readJson<{ gaps: Array<{ id: string }>; decisions: Array<{ id: string }> }>(
      'spec/dep/dep-1.gaps.json',
    );
    expect(gaps.gaps.map((g) => g.id)).toEqual(DEP1.gaps.map((g) => g.id));
    expect(gaps.decisions.map((d) => d.id)).toEqual(DEP1.decisions.map((d) => d.id));
  });
});
