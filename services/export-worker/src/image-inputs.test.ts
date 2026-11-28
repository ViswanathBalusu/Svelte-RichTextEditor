import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildInputsHash } from './image-inputs.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(containerfile: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'docedit-image-inputs-'));
  dirs.push(root);
  writeFileSync(join(root, 'Containerfile'), containerfile);
  mkdirSync(join(root, 'image', 'sub'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'image', name), text);
  return root;
}

describe('the hash of the worker image inputs (the label that marks a stale local image)', () => {
  it('is the same for a checkout with CRLF line ends and one with LF', () => {
    const lf = tree('FROM x\nRUN y\n', { 'a.sh': 'one\ntwo\n', 'sub/b.lua': 'x\n' });
    const crlf = tree('FROM x\r\nRUN y\r\n', { 'a.sh': 'one\r\ntwo\r\n', 'sub/b.lua': 'x\r\n' });
    expect(buildInputsHash(crlf)).toBe(buildInputsHash(lf));
  });

  it('changes with the Containerfile, with a file of the context and with a name', () => {
    const base = buildInputsHash(tree('FROM x\n', { 'a.sh': 'one\n' }));
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
    expect(buildInputsHash(tree('FROM y\n', { 'a.sh': 'one\n' }))).not.toBe(base);
    expect(buildInputsHash(tree('FROM x\n', { 'a.sh': 'two\n' }))).not.toBe(base);
    expect(buildInputsHash(tree('FROM x\n', { 'b.sh': 'one\n' }))).not.toBe(base);
  });

  it('is null where the sources are not present', () => {
    const empty = mkdtempSync(join(tmpdir(), 'docedit-image-inputs-'));
    dirs.push(empty);
    expect(buildInputsHash(empty)).toBeNull();
  });
});
