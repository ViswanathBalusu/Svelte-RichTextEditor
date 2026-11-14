/**
 * EXP-123 criterion 2 at the converter (Node.js only): a projected export's manifest lists what the
 * projection hid, and each placeholder prints a neutral notice. The projection arrives as an
 * envelope that already holds `hidden_region` placeholders and redacted values (ADR 0019); the
 * converter never sees the hidden content. Nothing here compiles.
 */
import { describe, expect, it } from 'vitest';
import { decodeStrings, doc, para, run } from '../test/docs.ts';

const NOTICE = 'This part of the document is not shown';

describe('EXP-123 a projected export lists its redactions and prints neutral placeholders', () => {
  it('lists a hidden region in the manifest and prints the notice, not its title', async () => {
    const b = await run(
      doc([
        para('Shown paragraph.'),
        { type: 'hidden_region', attrs: { id: 'rLegal0000000001', title: null } },
        para('Another shown paragraph.'),
      ]),
    );
    expect(b.ok).toBe(true);
    expect(b.manifest.redactions).toEqual([{ kind: 'region', id: 'rLegal0000000001' }]);
    const plain = decodeStrings(b.files['main.tex']!);
    expect(plain).toContain(NOTICE);
    expect(plain).toContain('Shown paragraph.');
  });

  it('keeps the title of a hidden region only when the projection shows it', async () => {
    const b = await run(
      doc([{ type: 'hidden_region', attrs: { id: 'rOpen00000000001', title: 'Board minutes' } }]),
    );
    expect(decodeStrings(b.files['main.tex']!)).toContain('Board minutes');
  });

  it('lists a redacted form field value in the manifest', async () => {
    const b = await run(
      doc([
        para('Name: ', {}, [
          {
            type: 'form_field',
            attrs: {
              id: 'fSecret00000001',
              key: 'secret',
              label: 'Secret',
              width: 1440,
              value: { redacted: true },
              default: null,
            },
          },
        ]),
      ]),
    );
    expect(b.manifest.redactions).toEqual([{ kind: 'fieldValue', id: 'fSecret00000001' }]);
  });

  it('lists nothing for a full export with no placeholders', async () => {
    const b = await run(doc([para('Everything is shown.')]));
    expect(b.manifest.redactions).toEqual([]);
    expect(decodeStrings(b.files['main.tex']!)).not.toContain(NOTICE);
  });
});
