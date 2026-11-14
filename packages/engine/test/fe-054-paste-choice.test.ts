// FE-054 criterion 1 (the choice): HTML that the view read through the whitelist is pasted in preference
// to plain text, after an embedded fragment. HTML the view did not read is ignored, as before FE-054.
// The sanitiser itself runs in a browser (src/view/fe-054-paste-html.universal.test.ts), because it
// needs DOMParser.
import { describe, expect, it } from 'vitest';
import type { CdmFragment } from '../src/cdm-fragment.ts';
import { chooseClipboard, clipboardPayload } from '../src/clipboard.ts';

function fragment(text: string): CdmFragment {
  return {
    cdm: 1,
    requires: [],
    defs: [],
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    openStart: 1,
    openEnd: 1,
  };
}

describe('the paste choice with HTML read through the whitelist (FE-054 criterion 1)', () => {
  it('uses the HTML the view read before plain text', () => {
    const choice = chooseClipboard({
      html: '<p>Rich</p>',
      text: 'plain',
      foreign: fragment('Rich'),
    });
    expect(choice).toEqual({ kind: 'fragment', fragment: fragment('Rich') });
  });

  it('uses plain text when the view read nothing from the HTML', () => {
    expect(chooseClipboard({ html: '<script>x</script>', text: 'plain', foreign: null })).toEqual({
      kind: 'text',
      text: 'plain',
    });
  });

  it('ignores HTML the view did not read, as before FE-054', () => {
    expect(chooseClipboard({ html: '<p>Rich</p>', text: 'plain' })).toEqual({
      kind: 'text',
      text: 'plain',
    });
  });

  it('keeps an embedded CDM fragment ahead of any HTML the view read', () => {
    const copied = clipboardPayload(fragment('Copied'));
    const choice = chooseClipboard({
      html: copied['text/html'],
      text: copied['text/plain'],
      foreign: fragment('Foreign'),
    });
    expect(choice).toEqual({ kind: 'fragment', fragment: fragment('Copied') });
  });
});
