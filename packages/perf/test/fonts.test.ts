/**
 * The font manifest (S5, S10; 02 §6): every file is present with the recorded hash and size, its
 * licence is one the policy allows for fonts, its licence text ships with it, and runs map to the
 * faces the harness expects.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluate, type Policy } from '../../../scripts/licence-policy.ts';
import { faceFor, fontManifest, resolveFace, roleOf } from '../src/fonts.ts';

const pkg = resolve(import.meta.dirname, '..');
const policy = JSON.parse(
  readFileSync(resolve(pkg, '../../licences/policy.json'), 'utf8'),
) as Policy;

describe('font manifest', () => {
  it.each(fontManifest.fonts.map((f) => [f.file, f] as const))(
    '%s matches its record',
    (_name, f) => {
      const bytes = readFileSync(join(pkg, 'fonts', f.file));
      expect(bytes.length).toBe(f.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.sha256);
      expect(evaluate(f.licence, policy, 'font')).toMatchObject({ ok: true });
      expect(existsSync(join(pkg, 'fonts', f.licenceFile))).toBe(true);
      expect(f.version).not.toBe('');
    },
  );

  it('maps runs to faces', () => {
    expect(faceFor('Noto Serif', true, false).file).toBe('files/NotoSerif-Bold.ttf');
    expect(faceFor('Noto Sans', false, true).file).toBe('files/NotoSans-Italic.ttf');
    expect(faceFor('Calibri', false, false).file).toBe('files/NotoSerif-Regular.ttf');
    expect(faceFor('Noto Sans Mono', false, true).file).toBe('files/NotoSansMono-Regular.ttf');
    expect(faceFor('Noto Serif', false, false, 'cjk').file).toBe(
      'files/HaranoAjiGothic-Regular.otf',
    );
    expect(resolveFace({ family: 'Harano Aji Gothic', bold: true, italic: false }).file).toBe(
      'files/HaranoAjiGothic-Regular.otf',
    );
    expect(roleOf('office')).toBe('latin');
    expect(roleOf('日本語')).toBe('cjk');
    expect(roleOf('한국어')).toBe('hangul');
  });
});
