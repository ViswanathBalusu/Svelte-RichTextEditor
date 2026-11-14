// Release notes (FND-012 criterion 4): the protocol and CDM versions come from the generated
// manifests, and every artefact is listed with its checksum and bill of materials.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCompatibility, renderReleaseNotes, type NotesInput } from './notes.ts';

describe('release notes', () => {
  it('read the supported versions from spec/ and the element', () => {
    const root = mkdtempSync(join(tmpdir(), 'docedit-notes-'));
    try {
      const put = (path: string, text: string) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      put(
        'spec/dep/dep-1.manifest.json',
        JSON.stringify({
          protocol: '1.1',
          status: 'final',
          subprotocol: 'dep.v1',
          definitionHash: 'f'.repeat(64),
          cdm: { min: 1, max: 2, sha256: 'e'.repeat(64) },
        }),
      );
      put('spec/cdm/cdm-1.manifest.json', JSON.stringify({ cdm: 1, status: 'final' }));
      put('packages/element/src/version.ts', "export const EMBEDDING_VERSION = '1.0';\n");
      expect(readCompatibility(root)).toEqual({
        protocol: {
          version: '1.1',
          status: 'final',
          subprotocol: 'dep.v1',
          definitionHash: 'f'.repeat(64),
        },
        cdm: { min: 1, max: 2, status: 'final', schemaHash: 'e'.repeat(64) },
        rules: null,
        embedding: '1.0',
        kit: null,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('read this repository’s manifests', () => {
    const c = readCompatibility(resolve(import.meta.dirname, '../..'));
    const dep = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../spec/dep/dep-1.manifest.json'), 'utf8'),
    ) as { protocol: string };
    expect(c.protocol?.version).toBe(dep.protocol);
    expect(c.cdm?.min).toBe(1);
  });

  const input = (over: Partial<NotesInput> = {}): NotesInput => ({
    version: '0.2.0',
    date: '2026-11-06',
    dryRun: false,
    previous: '0.1.0',
    compatibility: {
      protocol: {
        version: '1.0',
        status: 'draft',
        subprotocol: 'dep.v1',
        definitionHash: 'a'.repeat(64),
      },
      cdm: { min: 1, max: 1, status: 'draft', schemaHash: 'b'.repeat(64) },
      rules: { version: 'rules/1', status: 'draft' },
      embedding: '0.1',
      kit: { name: '@docedit/tck', version: '0.2.0' },
    },
    artefacts: [
      {
        file: 'docedit-element-0.2.0.tgz',
        kind: 'npm package',
        size: 10,
        sha256: 'c'.repeat(64),
        sbom: 'docedit-element-0.2.0.spdx.json',
      },
    ],
    images: [
      {
        id: 'export-worker',
        image: 'ghcr.io/o/docedit-export-worker',
        digest: `sha256:${'d'.repeat(64)}`,
        sbom: 'x.spdx.json',
      },
    ],
    missing: ['document-service image: not built'],
    changes: [],
    coverage: [{ requirement: 'R10', before: ['SEC-050'], after: ['SEC-050', 'SEC-051'] }],
    signer: { repository: 'o/r', workflow: '.github/workflows/release.yml' },
    ...over,
  });

  it('state the protocol, CDM, rules, embedding and kit versions', () => {
    const text = renderReleaseNotes(input());
    expect(text).toContain('| Protocol (DEP) | 1.0, WebSocket subprotocol `dep.v1`');
    expect(text).toContain('| Document model (CDM) | 1, schema hash');
    expect(text).toContain('| Field rules | rules/1 | draft |');
    expect(text).toContain('| Embedding API of `<doc-editor>` | 0.1 |');
    expect(text).toContain('| Conformance kit | @docedit/tck 0.2.0, tests protocol 1.0 |');
  });

  it('list artefacts, images, what is missing, how to verify and the coverage that changed', () => {
    const text = renderReleaseNotes(input());
    expect(text).toContain(
      `| \`docedit-element-0.2.0.tgz\` | npm package | 10 | \`${'c'.repeat(64)}\` | \`docedit-element-0.2.0.spdx.json\` |`,
    );
    expect(text).toContain(
      `| \`ghcr.io/o/docedit-export-worker\` (export-worker) | \`sha256:${'d'.repeat(64)}\``,
    );
    expect(text).toContain('- document-service image: not built');
    expect(text).toContain(
      '--certificate-identity https://github.com/o/r/.github/workflows/release.yml@refs/tags/v0.2.0',
    );
    expect(text).toContain('| R10 | 1 | 2 (SEC-051) |');
    expect(renderReleaseNotes(input({ dryRun: true, previous: null }))).toMatch(
      /^# Release 0\.2\.0 \(dry run, not published\)\n\nDate: 2026-11-06\. First release\./,
    );
  });

  it('say so when a manifest is missing, rather than guess', () => {
    const text = renderReleaseNotes(
      input({
        compatibility: { protocol: null, cdm: null, rules: null, embedding: null, kit: null },
      }),
    );
    expect(text).toContain(
      '| Protocol (DEP) | not found: spec/dep/dep-1.manifest.json is missing | |',
    );
    expect(text).toContain('| Conformance kit | not part of this release | |');
  });
});
