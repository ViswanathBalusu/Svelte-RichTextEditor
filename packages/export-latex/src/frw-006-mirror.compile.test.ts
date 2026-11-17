/**
 * FRW-006 criterion 4, checked on the compiled PDF (Node.js only, sandbox; lane w4): a mirror
 * (`field` of kind `formValue`) prints the value of its target field in the text; when the value
 * is empty it prints nothing and the export raises no diagnostic.
 *
 * The text comes from `pdftotext`. Each mirror sits between two marker words in a paragraph of its
 * own, so the words between the markers are what the mirror printed. The tests skip when
 * `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

function field(key: string, value: string | null): J {
  return {
    type: 'form_field',
    attrs: { id: nid('ff'), key, kind: 'text', label: `Label ${key}`, width: 2880, value },
  };
}

/** A paragraph `<open> <mirror of key> <close>`. */
function mirrored(open: string, key: string, close: string): J {
  return para(`${open} `, {}, [
    { type: 'field', attrs: { kind: 'formValue', target: `field:${key}` } },
    { type: 'text', text: ` ${close}` },
  ]);
}

/** The text of a PDF as `pdftotext` reads it, with white space collapsed. */
function pdfText(pdf: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-frw006-'));
  const file = join(dir, 'main.pdf');
  writeFileSync(file, pdf);
  const r = spawnSync('pdftotext', [file, '-'], { encoding: 'utf8', timeout: 60_000 });
  if (r.error || r.status !== 0) throw new Error('pdftotext is not installed or failed');
  return r.stdout.replace(/\s+/g, ' ');
}

describe.skipIf(!ready)('FRW-006 criterion 4: a mirror in the PDF export', () => {
  it('prints the value of its target in the text, and nothing for an empty value, with no diagnostic', async () => {
    const body = [
      para('Name: ', {}, [field('tenant.name', 'ADAVALUE')]),
      para('Other: ', {}, [field('tenant.other', null)]),
      mirrored('FILLEDOPEN', 'tenant.name', 'FILLEDCLOSE'),
      mirrored('EMPTYOPEN', 'tenant.other', 'EMPTYCLOSE'),
    ];
    const c = await convertAndCompile(doc(body), {
      profile: 'final',
      title: 'frw-006-mirror',
      instant: INSTANT,
      timeZone: 'Europe/London',
      suggestions: 'accept',
      fields: 'flatten',
    } as never);
    if (!c.compile.ok || !c.compile.pdf)
      throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);

    const text = pdfText(c.compile.pdf);
    // The value is printed in the text, between the words either side of the mirror.
    expect(text).toContain('FILLEDOPEN ADAVALUE FILLEDCLOSE');
    // An empty value prints nothing: the two words are neighbours.
    expect(text).toContain('EMPTYOPEN EMPTYCLOSE');
    // No diagnostic of the converter names a field, and none is an error or a warning.
    const diagnostics = c.bundle.diagnostics;
    expect(diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(diagnostics.filter((d) => /field|mirror|formValue/i.test(JSON.stringify(d)))).toEqual(
      [],
    );
  }, 600_000);
});
