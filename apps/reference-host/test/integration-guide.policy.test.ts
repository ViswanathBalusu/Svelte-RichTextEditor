/**
 * The strict-policy section of the integration guide (UX-090 criterion 4; spike S2 section 8). The
 * directives were measured in spike S2 in four browsers. This test cannot judge the prose; it checks
 * that each feature and each framework has its section, that the policy names are the ones the
 * component really creates, that the options the guide names exist, and that the spike it cites
 * exists and has the section the guide points to.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(HOST, '..', '..');
const GUIDE = readFileSync(join(HOST, 'docs', 'integration-guide.md'), 'utf8');
const SPIKE = join(REPO, 'docs', 'spikes', '2026-11-06-s2-csp-trusted-types.md');
const TRUSTED_TYPES = readFileSync(
  join(REPO, 'packages', 'element', 'src', 'trusted-types.ts'),
  'utf8',
);
const CONFIG = readFileSync(join(REPO, 'packages', 'element', 'src', 'config.ts'), 'utf8');
const PDF = readFileSync(join(REPO, 'packages', 'element', 'src', 'features', 'pdf.ts'), 'utf8');

function policySection(): string {
  const start = GUIDE.indexOf('\n## Strict content security policy\n');
  if (start < 0) return '';
  const end = GUIDE.indexOf('\n## ', start + 1);
  return end < 0 ? GUIDE.slice(start) : GUIDE.slice(start, end);
}

const SECTION = policySection();

describe('integration guide: strict content security policy (UX-090 criterion 4)', () => {
  it('has the section, before the limits section', () => {
    expect(SECTION).not.toBe('');
    expect(GUIDE.indexOf('## Strict content security policy')).toBeLessThan(
      GUIDE.indexOf('## Limits of the embedding'),
    );
  });

  it('has a sub-section for every feature the component needs', () => {
    for (const heading of [
      '### Every host (the editor itself)',
      '### Paste',
      '### Math display (KaTeX)',
      '### Math editor (MathLive)',
      '### PDF panel (PDF.js)',
      '### WebAssembly kernels (ADR 0016, later)',
    ]) {
      expect(SECTION, heading).toContain(heading);
    }
  });

  it('has a framework note for React, Angular, Vue, SvelteKit and plain HTML', () => {
    for (const framework of [
      '**Plain HTML.**',
      '**React.**',
      '**Angular.**',
      '**Vue.**',
      '**SvelteKit.**',
    ]) {
      expect(SECTION, framework).toContain(framework);
    }
  });

  it('names the policy names the component creates, exactly as trusted-types.ts defines them', () => {
    expect(TRUSTED_TYPES).toContain("worker: 'docedit-worker'");
    expect(TRUSTED_TYPES).toContain("mathEditor: 'docedit-math'");
    expect(SECTION).toContain('docedit-worker');
    expect(SECTION).toContain('docedit-math');
    expect(SECTION).toContain('ProseMirrorClipboard');
  });

  it('names the paste policy docedit-paste, which the paste view creates', () => {
    const PASTE = readFileSync(
      join(REPO, 'packages', 'engine', 'src', 'view', 'paste-policy.ts'),
      'utf8',
    );
    expect(PASTE).toContain("PASTE_POLICY_NAME = 'docedit-paste'");
    expect(SECTION).toContain('docedit-paste');
    expect(GUIDE).toContain('`trusted-types docedit-paste`');
  });

  it('names directives that the measured spike used', () => {
    for (const directive of [
      "'wasm-unsafe-eval'",
      "style-src-attr 'unsafe-inline'",
      "require-trusted-types-for 'script'",
      'worker-src',
      'blob:',
    ]) {
      expect(SECTION, directive).toContain(directive);
    }
  });

  it('names options that exist in the element source', () => {
    expect(CONFIG).toContain('styleNonce');
    expect(SECTION).toContain('config.styleNonce');
    expect(PDF).toContain('useWasm');
    expect(SECTION).toContain('useWasm: false');
  });

  it('cites a spike that exists and has the section the guide points to', () => {
    expect(existsSync(SPIKE)).toBe(true);
    const spike = readFileSync(SPIKE, 'utf8');
    expect(spike).toContain('## 8. For the integration guide: what a host must allow, per feature');
    expect(SECTION).toContain('docs/spikes/2026-11-06-s2-csp-trusted-types.md');
  });
});
