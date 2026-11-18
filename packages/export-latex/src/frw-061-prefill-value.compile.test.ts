/**
 * FRW-061 criterion 4, checked on the compiled PDF (Node.js only, sandbox; lane w4): a field value
 * that holds TeX control sequences, markup or spreadsheet formula characters is data. It reaches the
 * page only through the text emitter and its escaping layer, so the PDF shows the characters as
 * typed and no command in them runs. The values are the ones the prefill test of the document
 * service stores (`frw-061.prefill-hostile.test.ts`): a prefill writes the value as the `value`
 * attribute of the field, which is what the documents here carry.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

/** What a hostile prefill carries, one case each; keep in step with the service test. */
const CASES: ReadonlyArray<{ word: string; value: string; shows: string }> = [
  {
    word: 'CTRLONE',
    value: String.raw`CTRLONE \textbf{BOLDMARK} \input{/etc/passwd}`,
    shows: 'BOLDMARK',
  },
  {
    word: 'CTRLTWO',
    value: String.raw`CTRLTWO \write18{id} \def\x{y} $$ \end{document}`,
    shows: 'write18',
  },
  { word: 'SPECIALS', value: 'SPECIALS # $ % & _ { } ~ ^ \\ end', shows: 'SPECIALS' },
  {
    word: 'MARKUP',
    value: 'MARKUP <b>bold</b> <script>alert(1)</script> &amp; ]]>',
    shows: '<script>',
  },
  {
    word: 'FORMULA',
    value: `FORMULA =HYPERLINK("http://example.invalid","x") +cmd|' /C calc'!A0`,
    shows: '=HYPERLINK',
  },
];

function field(key: string, value: string): J {
  return {
    type: 'form_field',
    attrs: { id: nid('ff'), key, kind: 'text', label: key, width: 4320, value },
  };
}

describe.skipIf(!ready)(
  'FRW-061 criterion 4: a prefilled value with TeX, markup or formula characters is printed as typed',
  () => {
    it('compiles to a PDF that shows each value as text, and none of its commands ran', async () => {
      const body = [
        para('PREFIXWORD'),
        ...CASES.map((c) => para('', {}, [field(`k.${c.word.toLowerCase()}`, c.value)])),
        para('SUFFIXWORD'),
      ];
      const c = await convertAndCompile(doc(body), {
        profile: 'final',
        title: 'frw-061-prefill-value',
        instant: '2026-11-06T10:00:00.000Z',
        timeZone: 'Europe/London',
        suggestions: 'accept',
        fields: 'flatten',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);

      // The source: a value with TeX special characters is not in a TeX file as typed. A raw command
      // would be one; the escaping layer writes the characters as text. Markup and formula
      // characters are not special to TeX and are written as the text they are.
      const tex = Object.entries(c.bundle.files)
        .filter(([name]) => name.endsWith('.tex'))
        .map(([, text]) => text)
        .join('\n');
      for (const k of CASES.slice(0, 3)) expect(tex, k.word).not.toContain(k.value);
      expect(tex).not.toContain(String.raw`\input{/etc/passwd}`);
      expect(tex).not.toContain(String.raw`\write18{id}`);

      // The page: each value shows as characters. `pdftotext` is what reads them back.
      const text = pdfText(c.compile.pdf, '-raw');
      if (text === null) throw new Error('pdftotext is not installed or failed');
      const flat = text.replace(/\s+/g, ' ');
      for (const k of CASES) {
        expect(flat, `${k.word} is on the page`).toContain(k.word);
        expect(flat, `${k.word} is shown as typed: ${k.shows}`).toContain(k.shows);
      }
      // The commands did not run: the command word of each value is on the page as characters
      // (`\textbf` and `\input` are printed, not applied), and the page after them is intact.
      expect(flat).toContain('textbf');
      expect(flat).toContain('input');
      expect(flat).not.toContain('root:'); // what /etc/passwd would begin with
      expect(flat).toContain('SUFFIXWORD'); // `\end{document}` did not end the page early
    });
  },
);
