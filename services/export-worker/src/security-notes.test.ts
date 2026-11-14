/**
 * The security notes of the service documentation (EXP-068 criterion 5; 09 §9.3 item 2). The
 * notes must state that a TeX injection is arbitrary Lua and that the container is the boundary,
 * and every engine setting they cite must be the one the image is configured with. These are
 * static checks of the text; the running engine is checked by sandbox.escape.test.ts (Podman).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const readme = read('../README.md');
const containerfile = read('../Containerfile');

/** The text of the "Security notes" section: from its heading to the next heading or the end. */
const section = (() => {
  const start = readme.indexOf('\n## Security notes\n');
  if (start < 0) return '';
  const rest = readme.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  return next < 0 ? rest : rest.slice(0, next);
})();

describe('the security notes of the export worker (EXP-068 criterion 5)', () => {
  it('has a "Security notes" section', () => {
    expect(section.length).toBeGreaterThan(0);
  });

  it('states that any TeX injection is arbitrary Lua and that the container is the boundary', () => {
    expect(section).toMatch(/Lua's `debug` and file libraries remain reachable/);
    expect(section).toMatch(/treated as arbitrary Lua/);
    expect(section).toMatch(/The container is the boundary/);
  });

  it('cites only engine settings that the image is configured with', () => {
    for (const setting of ['shell_escape=f', 'openin_any=p', 'openout_any=p']) {
      expect(section).toContain(setting);
      expect(containerfile).toContain(setting);
    }
  });

  it('states the LuaTeX version floor and the two CVEs it answers', () => {
    expect(section).toContain('1.17');
    expect(section).toContain('CVE-2023-32700');
    expect(section).toContain('CVE-2023-32668');
  });

  it('states that --safer is not used and why', () => {
    expect(section).toMatch(/`--safer` flag not used/);
    expect(section).toMatch(/disables loading OpenType fonts/);
  });
});
