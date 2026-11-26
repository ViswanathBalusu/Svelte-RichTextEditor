/**
 * EXP-033 criterion 6, the width case (Node.js, compiled locally through `test/cdm-local-tex.ts`).
 * The converter has no font metrics, so the house class measures the flattened value against the
 * field's width and writes one log line, `docedit: field too wide N`, where N is the field's number
 * in `map.json` (`fields`). The worker's log parser turns that line into a `field_too_wide` warning
 * naming the field (`services/export-worker/src/exp-033-field-width.test.ts`).
 *
 * Here: a field 72 pt wide holds a long value and another holds a short one; the log names the
 * first field's number and not the second's, and `map.json` gives that number's field identifier.
 * Skips when `lualatex` or the local fonts are not present.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { compileLocal, convertLocal, lualatexAvailable } from '../test/cdm-local-tex.ts';

const ready = lualatexAvailable();

function field(id: string, value: string): J {
  return {
    type: 'form_field',
    attrs: { id, key: id, kind: 'text', label: `Label ${id}`, width: 1440, value },
  };
}

describe.skipIf(!ready)('EXP-033 criterion 6 (width case): a value wider than its field', () => {
  it('logs the number of the field that is too wide, and of no other', async () => {
    const wide = 'ff-wide-0001';
    const narrow = 'ff-narrow-001';
    const bundle = await convertLocal(
      doc([
        para('Name: ', {}, [
          field(wide, 'A value that is far too long to fit in a box of seventy-two points'),
        ]),
        para('Code: ', {}, [field(narrow, 'Short')]),
      ]) as never,
      { profile: 'preview', title: 'exp-033-width', layout: 'block' } as never,
    );
    const map = JSON.parse(bundle.files['map.json'] as string) as { fields: Array<string | null> };
    const kWide = map.fields.indexOf(wide);
    const kNarrow = map.fields.indexOf(narrow);
    expect(kWide).toBeGreaterThan(0);
    expect(kNarrow).toBeGreaterThan(0);
    const c = compileLocal(bundle, 'exp-033-width');
    if (!c.ok) throw new Error(`the compile failed (${c.dir}):\n${c.log.slice(-1500)}`);
    const lines = c.log.split('\n').filter((l) => l.startsWith('docedit: field too wide'));
    expect(lines).toContain(`docedit: field too wide ${kWide}`);
    expect(lines.some((l) => l.endsWith(` ${kNarrow}`))).toBe(false);
  });
});
