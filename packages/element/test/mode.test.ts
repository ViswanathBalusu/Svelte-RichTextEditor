// The `mode` attribute (05 §8.1; FE-029): the requested mode the element passes to the core. The
// surface's response to it is checked in a browser (e2e/mode.spec.ts).
import { describe, expect, it } from 'vitest';
import { modeFrom } from '../src/doc-editor.ts';

describe('modeFrom (FE-029)', () => {
  it('reads the four modes of 05 §8.1', () => {
    expect(modeFrom('edit')).toBe('edit');
    expect(modeFrom('review')).toBe('review');
    expect(modeFrom('view')).toBe('view');
    expect(modeFrom('fill')).toBe('fill');
    expect(modeFrom(' View ')).toBe('view');
  });

  it('absent or unknown is edit, the core default (the spec states no default; PRO-077 Notes)', () => {
    expect(modeFrom(null)).toBe('edit');
    expect(modeFrom('')).toBe('edit');
    expect(modeFrom('readonly')).toBe('edit');
  });
});
