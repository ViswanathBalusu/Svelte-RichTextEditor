/**
 * The engine's command line in the image (EXP-064 criterion 1; 09 §9.2). The image is not run
 * here (it needs Podman): this reads the script the image runs as its entry point and checks the
 * one call that starts the engine. The compile itself is checked by compile.e2e.test.ts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = readFileSync(fileURLToPath(new URL('../image/compile.sh', import.meta.url)), 'utf8');
// The engine call spans two lines with a trailing backslash; join them to read it as one command.
const joined = script.replace(/\\\n/g, ' ');
const engineCall = joined.split('\n').find((l) => /\blualatex --/.test(l)) ?? '';

describe('the engine command line in the image (EXP-064 criterion 1)', () => {
  it('starts the engine once per pass from the job directory', () => {
    expect(engineCall).toMatch(/\blualatex\b/);
    expect(engineCall).toContain('--interaction=nonstopmode');
    expect(engineCall).toContain('main.tex');
  });

  it('runs the engine with file and line error messages enabled', () => {
    expect(engineCall.split(/\s+/)).toContain('--file-line-error');
  });

  it('stops a pass at its first error, so that the log names the one that failed', () => {
    expect(engineCall.split(/\s+/)).toContain('--halt-on-error');
  });
});
