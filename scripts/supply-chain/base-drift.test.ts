// Pinned bases whose tag moved upstream (SEC-052): which pins are checked, and how.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { manifestDigest, pinnedImages } from './base-drift.ts';

const D = `sha256:${'a'.repeat(64)}`;

describe('base-image drift', () => {
  it('lists images pinned with a tag and a digest, in Containerfiles and compose files', () => {
    const root = mkdtempSync(join(tmpdir(), 'docedit-drift-'));
    try {
      const put = (path: string, text: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      put(
        'services/a/Containerfile',
        `FROM docker.io/texlive/texlive:latest@${D} AS tex\nFROM tex\nFROM docker.io/library/debian@${D}\n`,
      );
      put(
        'infra/compose.json',
        JSON.stringify({
          services: {
            pg: { image: `docker.io/library/postgres:17.11-trixie@${D}` },
            w: { image: '${IMAGE}', build: {} },
          },
        }),
      );
      put('node_modules/x/Containerfile', `FROM docker.io/library/node:22@${D}\n`);
      expect(pinnedImages(root)).toEqual([
        {
          file: 'infra/compose.json',
          line: 1,
          tagged: 'docker.io/library/postgres:17.11-trixie',
          digest: D,
        },
        {
          file: 'services/a/Containerfile',
          line: 1,
          tagged: 'docker.io/texlive/texlive:latest',
          digest: D,
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('takes a manifest digest over the exact bytes the registry serves', () => {
    const raw = Buffer.from('{"schemaVersion":2}');
    expect(manifestDigest(raw)).toBe(`sha256:${createHash('sha256').update(raw).digest('hex')}`);
  });
});
