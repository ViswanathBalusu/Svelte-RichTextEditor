/**
 * SEC-052 criterion 4 (10 §3.8; ADR 0044 §5): every container image definition of the repository
 * (`Containerfile`, built with Podman) pins its base image by digest, and an unpinned base fails the
 * check. The check itself is `scripts/supply-chain/pin-check.ts`, which `.github/workflows/
 * supply-chain.yml` runs on pull requests that touch a container definition and `release.ts` runs in
 * every release. This file runs the same rule over this repository and over a small unpinned sample.
 *
 * Not covered here: whether CI has run the workflow (no remote in this environment).
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkContainerfile, scanRepository } from '../../../scripts/supply-chain/pin-check.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('SEC-052 criterion 4: base images are pinned by digest', () => {
  it('finds every Containerfile of the repository and no unpinned base in any of them', () => {
    const { findings, files } = scanRepository(ROOT, ['containerfiles']);
    expect(files.containerfiles).toBeGreaterThanOrEqual(5);
    expect(findings.map((f) => `${f.file}:${f.line} ${f.message}`)).toEqual([]);
  });

  it('fails a base image given by tag only, and names the file and the image', () => {
    const findings = checkContainerfile(
      'FROM docker.io/library/node:22.18.0-bookworm-slim\nRUN true\n',
      'packages/example/Containerfile',
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.rule === 'containerfiles')).toBe(true);
    expect(findings.every((f) => f.file === 'packages/example/Containerfile')).toBe(true);
    expect(findings.some((f) => f.message.includes('node:22.18.0-bookworm-slim'))).toBe(true);
  });

  it('passes the same base once it is pinned by digest', () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    const findings = checkContainerfile(
      `FROM docker.io/library/node:22.18.0-bookworm-slim@${digest}\nRUN true\n`,
      'packages/example/Containerfile',
    );
    expect(findings).toEqual([]);
  });
});
