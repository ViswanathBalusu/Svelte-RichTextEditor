import { describe, expect, it } from 'vitest';
import { readTar, writeTar } from './tar.ts';

const enc = new TextEncoder();
const allow = new Set(['main.pdf', 'main.log']);

describe('tar transport', () => {
  it('round-trips files', () => {
    const data = writeTar([
      ['main.pdf', enc.encode('%PDF-2.0 ...')],
      ['main.log', new Uint8Array(1000).fill(65)],
    ]);
    const out = readTar(data, { allow, maxFileBytes: 10_000 });
    expect(new TextDecoder().decode(out.get('main.pdf'))).toBe('%PDF-2.0 ...');
    expect(out.get('main.log')?.length).toBe(1000);
  });

  it('refuses to write odd names', () => {
    expect(() => writeTar([['../x', new Uint8Array()]])).toThrow();
    expect(() => writeTar([['/etc/passwd', new Uint8Array()]])).toThrow();
  });

  it('reads only allow-listed regular files within the size limit (outputs are hostile)', () => {
    const data = writeTar([
      ['evil.sh', enc.encode('rm -rf /')],
      ['main.log', new Uint8Array(5000)],
      ['main.pdf', enc.encode('ok')],
    ]);
    const out = readTar(data, { allow, maxFileBytes: 1000 });
    expect([...out.keys()]).toEqual(['main.pdf']);
  });

  it('stops at truncated or malformed input without throwing', () => {
    const data = writeTar([['main.pdf', new Uint8Array(3000)]]);
    expect(readTar(data.subarray(0, 1000), { allow, maxFileBytes: 10_000 }).size).toBe(0);
    const bad = new Uint8Array(data);
    bad.set(enc.encode('zzzzzzzzzzz'), 124);
    expect(readTar(bad, { allow, maxFileBytes: 10_000 }).size).toBe(0);
    expect(readTar(new Uint8Array(17), { allow, maxFileBytes: 10 }).size).toBe(0);
  });
});
