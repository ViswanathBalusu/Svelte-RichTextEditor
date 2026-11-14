// Source maps of the build output (SEC-051, SEC-054): decoding and finding a position's source.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeMappings, loadSourceMap, sourceAt } from './source-map.ts';

const dir = mkdtempSync(join(tmpdir(), 'docedit-sourcemap-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('source maps', () => {
  it('decodes VLQ mappings with relative fields per line and across the file', () => {
    expect(decodeMappings('AAAA;AACA,EAAE')).toEqual([
      [[0, 0, 0, 0]],
      [
        [0, 0, 1, 0],
        [2, 0, 1, 2],
      ],
    ]);
    // "gB" is 16 (a continuation digit); "D" is -1; "C" moves to the next source.
    expect(decodeMappings('gBAAA,CCDC')).toEqual([
      [
        [16, 0, 0, 0],
        [17, 1, -1, 1],
      ],
    ]);
    // Segments of one field (a generated column only) map nothing and are skipped.
    expect(decodeMappings('A,CAAA;;')).toEqual([[[1, 0, 0, 0]], [], []]);
  });

  it('finds the source of the last segment at or before a column', () => {
    const lines = decodeMappings('GAAA,UCAA;');
    expect(sourceAt(lines, 0, 2)).toBeNull();
    expect(sourceAt(lines, 0, 3)).toBe(0);
    expect(sourceAt(lines, 0, 12)).toBe(0);
    expect(sourceAt(lines, 0, 13)).toBe(1);
    expect(sourceAt(lines, 0, 10_000)).toBe(1);
    expect(sourceAt(lines, 1, 0)).toBeNull();
    expect(sourceAt(lines, 7, 0)).toBeNull();
  });

  it('loads a map from the sourceMappingURL comment, a sibling file or an inline data URL', () => {
    const map = {
      version: 3,
      sources: ['../src/a.ts', 'file.css?inline'],
      sourceRoot: '',
      mappings: 'AAAA',
    };
    writeFileSync(join(dir, 'a.js.map'), JSON.stringify(map));
    writeFileSync(join(dir, 'a.js'), 'x\n//# sourceMappingURL=a.js.map\n');
    const byComment = loadSourceMap(join(dir, 'a.js'), 'x\n//# sourceMappingURL=a.js.map\n');
    expect(byComment?.paths).toEqual([resolve(dir, '../src/a.ts'), resolve(dir, 'file.css')]);
    expect(loadSourceMap(join(dir, 'a.js'), 'x')?.file).toBe(join(dir, 'a.js.map'));
    const inline = `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
    expect(loadSourceMap(join(dir, 'b.js'), inline)?.file).toBeNull();
    expect(loadSourceMap(join(dir, 'none.js'), 'no map')).toBeNull();
  });

  it('refuses maps it cannot read correctly', () => {
    writeFileSync(join(dir, 'c.js.map'), JSON.stringify({ version: 2, sources: [], mappings: '' }));
    expect(() => loadSourceMap(join(dir, 'c.js'), '')).toThrow(/version 3/);
    writeFileSync(
      join(dir, 'd.js.map'),
      JSON.stringify({ version: 3, sources: [], mappings: '', sections: [] }),
    );
    expect(() => loadSourceMap(join(dir, 'd.js'), '')).toThrow(/index maps/);
    expect(() => decodeMappings('A!A')).toThrow(/invalid character/);
  });
});
