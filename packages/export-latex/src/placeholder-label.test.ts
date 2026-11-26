// The label of a visible placeholder is cut to a length a framed, unbreakable box can hold (SEC-033).
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_LABEL_MAX, placeholderLabel } from './emit.ts';

describe('placeholderLabel', () => {
  it('leaves a label of the limit or less as it is', () => {
    expect(placeholderLabel('[figure: a chart]')).toBe('[figure: a chart]');
    const exact = 'x'.repeat(PLACEHOLDER_LABEL_MAX);
    expect(placeholderLabel(exact)).toBe(exact);
  });

  it('cuts a longer label to the limit, with an ellipsis, by characters and not by code units', () => {
    const cut = placeholderLabel('x'.repeat(5000));
    expect([...cut]).toHaveLength(PLACEHOLDER_LABEL_MAX);
    expect(cut.endsWith('…')).toBe(true);
    const astral = placeholderLabel('\u{1F600}'.repeat(PLACEHOLDER_LABEL_MAX + 5));
    expect([...astral]).toHaveLength(PLACEHOLDER_LABEL_MAX);
    expect(astral).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
