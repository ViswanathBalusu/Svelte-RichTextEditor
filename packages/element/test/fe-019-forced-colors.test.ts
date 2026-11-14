/**
 * FE-019 criterion 3 (lane FE-014-026): under `forced-colors: active`, each decoration the editing
 * core draws keeps a cue that is not a background colour. This is a source check of the element's
 * stylesheet: the `@media (forced-colors: active)` block of `src/styles/element.css` must give the
 * find-match and current-match classes an outline. Comment ranges and suggestions have no decoration
 * class yet (FE-046, FE-048), so they are not covered here; the criterion stays unticked.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(import.meta.dirname, '..', 'src', 'styles', 'element.css'), 'utf8');
const MEDIA = '@media (forced-colors: active) {';

/** The text of the forced-colours block, from its opening brace to the matching closing brace. */
function forcedBlock(css: string): string {
  const start = css.indexOf(MEDIA);
  if (start < 0) throw new Error('element.css has no @media (forced-colors: active) block');
  let depth = 0;
  for (let i = start + MEDIA.length - 1; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(start + MEDIA.length, i);
    }
  }
  throw new Error('the forced-colours block is not closed');
}

/** The declarations of the rule whose selector is exactly `selector`, or undefined. */
function ruleBody(block: string, selector: string): string | undefined {
  const re = new RegExp(
    `(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'm',
  );
  return re.exec(block)?.[2];
}

const block = forcedBlock(CSS);

describe('forced colours of decorations (FE-019, criterion 3)', () => {
  it('has a forced-colours block whose rules the reader finds (so the checks below are not empty)', () => {
    expect(ruleBody(block, '.de-region')).toContain('border-inline-start-color');
  });

  it.each(['.de-find-match', '.de-find-current'])(
    '%s keeps an outline in forced colours, not a background colour alone',
    (selector) => {
      const body = ruleBody(block, selector);
      expect(body, `${selector} has a rule in the forced-colours block`).toBeDefined();
      expect(body).toMatch(/(^|;|\s)outline\s*:/);
      expect(body).not.toMatch(/(^|;|\s)background(-color)?\s*:/);
    },
  );

  it('the current match has a heavier outline than the other matches', () => {
    const match = ruleBody(block, '.de-find-match') ?? '';
    const current = ruleBody(block, '.de-find-current') ?? '';
    expect(match).toMatch(/outline:\s*1px\s+dashed\s+Highlight/);
    expect(current).toMatch(/outline:\s*3px\s+solid\s+Highlight/);
  });
});
