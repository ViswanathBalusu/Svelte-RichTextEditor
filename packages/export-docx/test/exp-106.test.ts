/**
 * EXP-106, criteria 1 to 3 over the S11 corpus and by unit cases: the families an imported document
 * names are mapped through the font manifest (02 §6); a family with no metric-compatible substitute
 * gets the default and a reflow warning; each substituted family is listed once; and the document
 * keeps the names the file gives (SR-M12). Criterion 4 (tenant fonts come from BE-047) is not
 * ticked; the manifest order, which it depends on, is tested at the end.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_FONT_MANIFEST,
  DEFAULT_IMPORT_FONT,
  type FontManifestEntry,
  familiesOf,
  familyKey,
  substituteFonts,
} from '../src/font-substitution.ts';
import { importDocx } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const PROPRIETARY: ReadonlyArray<readonly [string, string]> = [
  ['Calibri', 'Carlito'],
  ['Cambria', 'Caladea'],
  ['Arial', 'Liberation Sans'],
  ['Times New Roman', 'Liberation Serif'],
  ['Courier New', 'Liberation Mono'],
];
const PROPRIETARY_KEY = new Map(PROPRIETARY.map(([f, r]) => [familyKey(f), r]));
const OPEN_KEYS = new Set([
  'carlito',
  'caladea',
  'liberation sans',
  'liberation serif',
  'liberation mono',
]);

describe('criterion 1: families of the file are mapped through the manifest', () => {
  it.each(PROPRIETARY)('%s is shown as %s', (from, to) => {
    const [line] = substituteFonts([from]);
    expect(line).toMatchObject({ from, to, source: 'builtin', reflow: false });
  });

  it('the built-in manifest holds the five families of 02 §6', () => {
    expect(BUILTIN_FONT_MANIFEST.map((e) => [e.family, e.replacement])).toEqual(PROPRIETARY);
  });

  it('matches family names without case or extra spaces, as Word does', () => {
    const [line] = substituteFonts(['  times   NEW roman ']);
    expect(line).toMatchObject({ from: 'times NEW roman', to: 'Liberation Serif' });
  });

  it('uses an open metric-compatible family as it is, and lists nothing for it', () => {
    expect(substituteFonts(['Carlito', 'Liberation Serif', 'Caladea'])).toEqual([]);
  });

  it('maps the families of every corpus file, and never rewrites the document', async () => {
    let lines = 0;
    for (const file of corpusFiles()) {
      const bytes = readFile(file);
      const imported = await importDocx(bytes);
      const families = familiesOf(imported.envelope.doc);
      // Substitution changes no node: the same families come out with an empty manifest.
      const plain = await importDocx(bytes, { fonts: { manifest: [] } });
      expect(familiesOf(plain.envelope.doc), file.name).toEqual(families);
      // Exactly one line per family the document names, apart from the open families.
      const wanted = [...new Set(families.map(familyKey))]
        .filter((k) => k && !OPEN_KEYS.has(k))
        .sort();
      const named = imported.fonts.map((l) => familyKey(l.from)).sort();
      expect(named, file.name).toEqual(wanted);
      for (const line of imported.fonts) {
        lines++;
        const proprietary = PROPRIETARY_KEY.get(familyKey(line.from));
        if (proprietary) {
          expect(line, `${file.name} ${line.from}`).toMatchObject({
            to: proprietary,
            source: 'builtin',
            reflow: false,
          });
        } else {
          expect(line, `${file.name} ${line.from}`).toMatchObject({
            to: DEFAULT_IMPORT_FONT,
            source: 'default',
            reflow: true,
          });
        }
      }
    }
    expect(lines).toBeGreaterThan(0);
  });
});

describe('criterion 2: a family without a metric-compatible substitute uses the default and warns', () => {
  it('uses the default for Aptos and says that the document will reflow', () => {
    const [line] = substituteFonts(['Aptos']);
    expect(line).toEqual({
      from: 'Aptos',
      to: DEFAULT_IMPORT_FONT,
      source: 'default',
      reflow: true,
      message: `Aptos has no metric-compatible substitute; ${DEFAULT_IMPORT_FONT} is used and the document will reflow`,
    });
  });

  it('uses the given default family when one is passed', () => {
    const [line] = substituteFonts(['Aptos'], { defaultFamily: 'Liberation Serif' });
    expect(line).toMatchObject({ to: 'Liberation Serif', reflow: true });
  });

  it('refuses an empty default family', () => {
    expect(() => substituteFonts(['Aptos'], { defaultFamily: '  ' })).toThrow(RangeError);
  });
});

describe('criterion 3: each substituted family is listed once', () => {
  it('lists a family once, in order of first appearance, whatever its spelling', () => {
    const lines = substituteFonts(['Calibri', 'Aptos', 'calibri', ' CALIBRI ', 'Aptos', 'Arial']);
    expect(lines.map((l) => l.from)).toEqual(['Calibri', 'Aptos', 'Arial']);
  });

  it('lists each family of every corpus file once', async () => {
    for (const file of corpusFiles()) {
      const imported = await importDocx(readFile(file));
      const keys = imported.fonts.map((l) => familyKey(l.from));
      expect(new Set(keys).size, file.name).toBe(keys.length);
    }
  });
});

describe('the manifest order decides: the first entry that names a family wins', () => {
  it('a tenant entry placed before the built-in ones takes precedence', () => {
    const tenant: FontManifestEntry = {
      family: 'Calibri',
      replacement: 'Tenant Sans',
      source: 'tenant',
    };
    const [line] = substituteFonts(['Calibri'], { manifest: [tenant, ...BUILTIN_FONT_MANIFEST] });
    expect(line).toMatchObject({ from: 'Calibri', to: 'Tenant Sans', source: 'tenant' });
  });

  it('a tenant entry with the same family name is still listed', () => {
    const manifest: FontManifestEntry[] = [
      { family: 'Calibri', replacement: 'Calibri', source: 'tenant' },
      ...BUILTIN_FONT_MANIFEST,
    ];
    const lines = substituteFonts(['Calibri', 'Arial'], { manifest });
    expect(lines[0]).toMatchObject({ from: 'Calibri', to: 'Calibri', source: 'tenant' });
    expect(lines[1]).toMatchObject({ from: 'Arial', to: 'Liberation Sans', source: 'builtin' });
  });

  it('a manifest without an entry for a family leaves it to the default', () => {
    const [line] = substituteFonts(['Calibri'], { manifest: [] });
    expect(line).toMatchObject({ to: DEFAULT_IMPORT_FONT, source: 'default', reflow: true });
  });
});
