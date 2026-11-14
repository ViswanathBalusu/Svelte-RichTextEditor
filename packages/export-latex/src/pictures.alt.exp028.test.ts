/**
 * EXP-028 criterion 4 (Node.js only): the alternative text of an inline image or a figure is written
 * through the `pdfString` emitter, as the graphic's alternative text. The converter writes the
 * `alt` of `\DEimg` as a key-value option value, which is `kvValue`: braces around `pdfString`.
 * These tests read main.tex and decode the hex of the `\DEstr` the option carries, so they show the
 * text that reaches the class, not only the macro's name. No PDF is compiled.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blockLines, decodeStrings, doc, nid, para, run, type J } from '../test/docs.ts';

const SHA = 'f'.repeat(64);
const ASSETS = {
  asset1: {
    sha256: SHA,
    mediaType: 'image/png',
    status: 'ready' as const,
    bytes: new Uint8Array([137, 80, 78, 71]),
  },
};

const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;

/** The `\DEimg` line's alternative-text option: the hex of its `\DEstr`, decoded to the text. */
function altOf(body: string): string | null {
  const m = /\\DEimg\{[^}]*\}\{[^}]*\}\{[^}]*\}\{[^}]*\}\{\{(\\DEstr\{[0-9A-F]*\})\}\}/.exec(body);
  return m ? decodeStrings(m[1]!) : null;
}

describe('EXP-028 criterion 4: alternative text goes through the pdfString emitter', () => {
  it('writes the alternative text of a block figure as a pdfString in its \\DEimg option', async () => {
    const f: J = {
      type: 'figure',
      attrs: { id: nid('f'), asset: 'asset1', width: 2880, height: 1440, alt: 'A test picture' },
    };
    const b = await run(doc([f]), { assets: ASSETS });
    expect(altOf(blockLines(b, idOf(f)).join('\n'))).toBe('A test picture');
  });

  it('writes the alternative text of an inline image as a pdfString in its \\DEimg option', async () => {
    const pid = nid('p');
    const img: J = {
      type: 'image',
      attrs: { id: nid('i'), asset: 'asset1', width: 2880, height: 1440, alt: 'Inline picture' },
    };
    const b = await run(doc([para('Before ', { id: pid }, [img])]), { assets: ASSETS });
    expect(altOf(blockLines(b, pid).join('\n'))).toBe('Inline picture');
  });

  it('round-trips any printable alternative text through the hex of pdfString (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[A-Za-z0-9 ,.;:()-]{1,60}$/), async (alt) => {
        const f: J = {
          type: 'figure',
          attrs: { id: nid('f'), asset: 'asset1', width: 2880, height: 1440, alt },
        };
        const b = await run(doc([f]), { assets: ASSETS });
        const body = blockLines(b, idOf(f)).join('\n');
        expect(body).toMatch(/\{\{\\DEstr\{[0-9A-F]+\}\}\}/);
        expect(altOf(body)).toBe(alt);
      }),
      { numRuns: 25 },
    );
  });
});
