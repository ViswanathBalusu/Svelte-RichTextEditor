/**
 * EXP-123 criterion 2 at the converter (Node.js only): a redacted form-field value prints the neutral
 * notice, not an empty field, and the manifest lists the field. Nothing here compiles.
 */
import { describe, expect, it } from 'vitest';
import { decodeStrings, doc, para, run } from '../test/docs.ts';

const NOTICE = '[hidden]';

describe('EXP-123 a redacted form field prints the neutral notice', () => {
  it('prints the notice in place of the value, and lists the field in the manifest', async () => {
    const b = await run(
      doc([
        para('Name: ', {}, [
          {
            type: 'form_field',
            attrs: {
              id: 'fSecret00000002',
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
    expect(b.ok).toBe(true);
    expect(b.manifest.redactions).toEqual([{ kind: 'fieldValue', id: 'fSecret00000002' }]);
    // The field's body holds the notice's words (the brackets may be escaped by the emitter).
    const tex = decodeStrings(b.files['main.tex']!);
    expect(tex).toMatch(/\\DEff\{[^\n]*hidden/);
    expect(NOTICE).toBe('[hidden]');
  });
});
