/**
 * What goes into the sandbox image (scripts/build-image.ts): `src/sandbox/` must import nothing but
 * its own files, Node.js built-ins the sandbox is allowed (no network, file, process or worker
 * modules), and the three decoders, so that no supervisor code, configuration or credential
 * handling can end up inside the container.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('../src/sandbox/', import.meta.url));
const ALLOWED = new Set(['node:zlib', 'pngjs', 'jpeg-js', 'omggif']);

describe('the sandbox sources (BE-043 criterion 1)', () => {
  it('import only themselves, node:zlib and the decoders', () => {
    const seen = new Set<string>();
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const text = readFileSync(join(dir, f), 'utf8');
      for (const m of text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm)) {
        const spec = m[1]!;
        if (spec.startsWith('./')) {
          expect(spec, `${f} imports ${spec}`).toMatch(/^\.\/[a-z-]+\.ts$/);
          continue;
        }
        seen.add(spec);
        expect(ALLOWED.has(spec), `${f} imports ${spec}`).toBe(true);
      }
      expect(text, f).not.toMatch(/\bimport\s*\(/);
      expect(text, f).not.toMatch(/\brequire\s*\(/);
      expect(text, f).not.toMatch(/process\.env/);
    }
    expect([...seen].sort()).toEqual([...ALLOWED].sort());
  });
});
