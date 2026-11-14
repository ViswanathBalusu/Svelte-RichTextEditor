/**
 * The inputs that make one bundle give one PDF (EXP-076 criterion 1; 09 §9.4, §8): the date
 * variables come from the job, the job path inside the sandbox is fixed, fonts are addressed by
 * hash, and the image is pinned by digest. Criteria 2 and 3 (byte-identical PDFs on several hosts,
 * no host or random identifier in the PDF) need Podman and are not checked here. Criterion 4 (the
 * manifest records the image digest) is open: see docs/adr/0116-export-worker-backlog-batch.md.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sandboxArgs } from './sandbox.ts';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('the date variables come from the job (EXP-076 criterion 1; 09 §9.4)', () => {
  it('passes the job epoch as SOURCE_DATE_EPOCH and sets FORCE_SOURCE_DATE', () => {
    const args = sandboxArgs('docedit-repro-test', { sourceDateEpoch: 1_800_000_123 });
    expect(args).toContain('--env=SOURCE_DATE_EPOCH=1800000123');
    expect(args).toContain('--env=FORCE_SOURCE_DATE=1');
  });

  it('gives the same date variables when the epoch is the same, whatever the job name', () => {
    const env = (xs: string[]) =>
      xs
        .filter((x) => x.startsWith('--env=SOURCE_DATE') || x.startsWith('--env=FORCE_SOURCE'))
        .sort();
    const a = env(sandboxArgs('docedit-repro-a', { sourceDateEpoch: 1_800_000_123 }));
    const b = env(sandboxArgs('docedit-repro-b', { sourceDateEpoch: 1_800_000_123 }));
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
  });
});

describe('the job path is fixed and the image is pinned (EXP-076 criterion 1; 09 §8)', () => {
  const script = read('../image/compile.sh');
  const containerfile = read('../Containerfile');

  it('runs every pass in /work/job, a path that does not change between jobs', () => {
    expect(script).toMatch(/^JOB=\/work\/job$/m);
    expect(script).toMatch(/^cd "\$JOB" \|\|/m);
    expect(script).not.toMatch(/mktemp|\$RANDOM|\$\$/);
  });

  it('pins the base image by digest, not by a tag that moves', () => {
    const from = containerfile.split('\n').find((l) => l.startsWith('FROM ')) ?? '';
    expect(from).toMatch(/^FROM \S+:latest@sha256:[0-9a-f]{64}$/);
  });
});

describe('fonts are addressed by hash (EXP-076 criterion 1; 09 §5)', () => {
  const manifestPath = fileURLToPath(new URL('../out/fonts-local/fonts.json', import.meta.url));
  const dir = fileURLToPath(new URL('../out/fonts-local/', import.meta.url));

  // The build output is not in version control: the check runs where it has been built.
  it.runIf(existsSync(manifestPath))('names every font file by the SHA-256 of its bytes', () => {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      families: Array<
        Record<'regular' | 'bold' | 'italic' | 'boldItalic', { file: string; sha256: string }>
      >;
      math: { file: string; sha256: string };
    };
    const faces = [
      ...m.families.flatMap((f) => [f.regular, f.bold, f.italic, f.boldItalic]),
      m.math,
    ];
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face.file).toMatch(/^[0-9a-f]{64}\.(ttf|otf)$/);
      expect(face.file.slice(0, 64)).toBe(face.sha256);
      const bytes = readFileSync(`${dir}${face.file}`);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(face.sha256);
    }
  });
});
