/**
 * The engine's configuration in the image, as written (EXP-068 criteria 1 and 3; 09 §9.3 item 2).
 * The image is not built or run here (it needs Podman): these tests read the Containerfile, the
 * script it runs and the sandbox's arguments. That the running engine honours them is checked by
 * sandbox.escape.test.ts, which needs Podman and the image and was not run on 2026-11-13.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sandboxArgs } from './sandbox.ts';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** The text without comment lines, so that a comment saying "not `--safer`" does not count. */
const code = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');

const containerfile = read('../Containerfile');
const compileSh = read('../image/compile.sh');
const fontsLua = read('../image/fonts.lua');

// ENV continues lines with a trailing backslash: join them, then read the NAME=value pairs.
const envPairs = (() => {
  const m = /^ENV ((?:.*\\\n)*.*)$/m.exec(containerfile);
  const joined = (m?.[1] ?? '').replace(/\\\n/g, ' ').trim();
  return new Map(
    joined
      .split(/\s+/)
      .filter((p) => p.includes('='))
      .map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i), p.slice(i + 1)] as const;
      }),
  );
})();

// The one call that starts the engine, with its continuation lines joined.
const engineCall =
  compileSh
    .replace(/\\\n/g, ' ')
    .split('\n')
    .find((l) => /\blualatex --/.test(l)) ?? '';

describe('the engine configuration in the image (EXP-068 criterion 1)', () => {
  it('turns shell escape off in the image and passes --no-shell-escape to the engine', () => {
    expect(envPairs.get('shell_escape')).toBe('f');
    expect(envPairs.get('shell_escape_commands')).toBe('');
    expect(engineCall.split(/\s+/)).toContain('--no-shell-escape');
  });

  it('sets reading and writing of files outside the job to paranoid', () => {
    expect(envPairs.get('openin_any')).toBe('p');
    expect(envPairs.get('openout_any')).toBe('p');
  });

  it('keeps the engine away from a home tree and from system font directories', () => {
    expect(envPairs.get('TEXMFHOME')).toBe('/nonexistent');
    expect(envPairs.get('OSFONTDIR')).toBe('/nonexistent');
  });
});

describe('--safer is not used and OpenType fonts load from files (EXP-068 criterion 3)', () => {
  it('never passes --safer to the engine, in the image or in the worker', () => {
    expect(code(containerfile)).not.toMatch(/--safer\b/);
    expect(code(compileSh)).not.toMatch(/--safer\b/);
    expect(sandboxArgs('docedit-engine-config-test').join(' ')).not.toMatch(/--safer\b/);
  });

  it('reads fonts from the image directory the build writes them to, by path', () => {
    expect(envPairs.get('DOCEDIT_FONT_PATH')).toBe('/opt/docedit/fonts/');
    expect(containerfile).toMatch(/texlua \/opt\/docedit\/fonts\.lua \/opt\/docedit\/fonts\b/);
  });

  it('writes the font files as .otf or .ttf files named by hash', () => {
    expect(fontsLua).toContain('".otf"');
    expect(fontsLua).toContain('".ttf"');
    expect(fontsLua).toMatch(/local file = sha \.\. /);
  });
});

describe('the build gate on the engine version (EXP-068 criterion 2, the gate only)', () => {
  // The RUN line that stops the build when `luatex --version` is older than 1.17.
  const gate = /luatex --version \| head -1 \| grep -E '([^']+)'/.exec(containerfile)?.[1] ?? '';
  const re = new RegExp(gate);

  it('is present in the Containerfile', () => {
    expect(gate).not.toBe('');
  });

  it('accepts 1.17 and later and rejects 1.16 and earlier', () => {
    expect(re.test('This is LuaHBTeX, Version 1.17.0')).toBe(true);
    expect(re.test('This is LuaHBTeX, Version 1.24.0')).toBe(true);
    expect(re.test('This is LuaHBTeX, Version 1.19.9')).toBe(true);
    expect(re.test('This is LuaTeX, Version 1.16.0')).toBe(false);
    expect(re.test('This is LuaTeX, Version 1.9.0')).toBe(false);
    expect(re.test('This is LuaTeX, Version 0.95.0')).toBe(false);
  });
});
