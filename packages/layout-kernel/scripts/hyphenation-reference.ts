/**
 * Records how TeX hyphenates a list of words, for the kernel's tests (WASM-009).
 *
 *   node scripts/hyphenation-reference.ts
 *
 * It runs `lualatex` (TeX Live, found on the path; the house class is a LuaLaTeX class, and LuaTeX
 * reads the UTF-8 pattern files that the kernel loads, where pdfTeX reads older 8-bit ones) over a document that calls `\showhyphens` for
 * each word under babel's language, and reads the hyphens from the log. The language data is the
 * one the house class uses (babel with the hyph-utf8 patterns, as `docedit.cls` loads it), so the
 * result is what the PDF will do with the same word. The output is `test/hyphenation-reference.json`.
 * Run it again when the word lists or the TeX Live release change; the tests only read the file.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The manifest tag, babel's name for it, and the words. */
export const LISTS: ReadonlyArray<{
  tag: string;
  babel: string;
  ini: string;
  words: readonly string[];
}> = [
  {
    tag: 'en-us',
    babel: 'american',
    ini: 'en-US',
    words: [
      'hyphenation',
      'algorithm',
      'typography',
      'computer',
      'dictionary',
      'extensive',
      'international',
      'programming',
      'development',
      'responsibility',
      'associate',
      'project',
      'table',
      'paragraph',
      'rendering',
      'document',
      'collaboration',
      'architecture',
    ],
  },
  {
    tag: 'en-gb',
    babel: 'british',
    ini: 'en-GB',
    words: [
      'hyphenation',
      'algorithm',
      'typography',
      'computer',
      'dictionary',
      'extensive',
      'international',
      'programming',
      'development',
      'responsibility',
      'aluminium',
      'colourful',
      'paragraph',
      'rendering',
      'document',
      'collaboration',
      'architecture',
      'organisation',
    ],
  },
  {
    tag: 'de-1996',
    babel: 'ngerman',
    ini: 'de',
    words: [
      'Silbentrennung',
      'Bibliothek',
      'Wörterbuch',
      'Rechtschreibung',
      'Informationsverarbeitung',
      'Straße',
      'Entwicklung',
      'Dokument',
      'Zusammenarbeit',
      'Computer',
      'Verantwortung',
      'Möglichkeit',
      'Textverarbeitung',
      'Absatzformatierung',
      'Seitenumbruch',
      'Schriftart',
    ],
  },
  {
    tag: 'fr',
    babel: 'french',
    ini: 'fr',
    words: [
      'hyphénation',
      'ordinateur',
      'développement',
      'communication',
      'bibliothèque',
      'dictionnaire',
      'programmation',
      'typographie',
      'responsabilité',
      'international',
      'paragraphe',
      'document',
      'collaboration',
      'architecture',
      'traitement',
      'impression',
    ],
  },
  {
    tag: 'es',
    babel: 'spanish',
    ini: 'es',
    words: [
      'separación',
      'ordenador',
      'desarrollo',
      'comunicación',
      'biblioteca',
      'diccionario',
      'programación',
      'tipografía',
      'responsabilidad',
      'internacional',
      'párrafo',
      'documento',
      'colaboración',
      'arquitectura',
      'procesamiento',
      'impresión',
    ],
  },
  {
    tag: 'it',
    babel: 'italian',
    ini: 'it',
    words: [
      'sillabazione',
      'calcolatore',
      'sviluppo',
      'comunicazione',
      'biblioteca',
      'dizionario',
      'programmazione',
      'tipografia',
      'responsabilità',
      'internazionale',
      'paragrafo',
      'documento',
      'collaborazione',
      'architettura',
      'elaborazione',
      'stampa',
    ],
  },
];

export interface Recorded {
  readonly languages: Record<string, Array<{ word: string; hyphenated: string }>>;
  /** \lefthyphenmin and \righthyphenmin that babel sets for the language, under the class's loading. */
  readonly minimums: Record<string, { left: number; right: number }>;
}

export function record(): Recorded {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-hyph-'));
  try {
    // As the class does (docedit.cls, DEbabel and DEdeflang): babel through its ini files, shorthands off.
    const provide =
      LISTS.map(
        (l, i) => `\\babelprovide[import=${l.ini}${i === 0 ? ', main' : ''}]{${l.babel}}`,
      ).join('\n') + '\n';
    const body = LISTS.map(
      (l) =>
        `\\begin{otherlanguage}{${l.babel}}\n` +
        `\\typeout{MINS ${l.tag} \\the\\lefthyphenmin\\space\\the\\righthyphenmin}\n` +
        l.words.map((w) => `\\showhyphens{${w}}`).join('\n') +
        `\n\\end{otherlanguage}`,
    ).join('\n');
    writeFileSync(
      join(dir, 'ref.tex'),
      `\\documentclass{article}\n\\usepackage[shorthands=off]{babel}\n${provide}\\begin{document}\n${body}\n\\end{document}\n`,
    );
    const run = spawnSync('lualatex', ['-interaction=nonstopmode', '-halt-on-error', 'ref.tex'], {
      cwd: dir,
      encoding: 'utf8',
    });
    if (run.error) throw run.error;
    const log = readFileSync(join(dir, 'ref.log'), 'utf8');
    const shown = [...log.matchAll(/^\[\] \\TU\/lmr\/m\/n\/10 (\S+)$/gm)].map((m) => m[1]!);
    const all = LISTS.flatMap((l) => l.words.map((w) => ({ tag: l.tag, word: w })));
    if (shown.length !== all.length)
      throw new Error(`TeX showed ${shown.length} words, ${all.length} were asked`);
    const out: Record<string, Array<{ word: string; hyphenated: string }>> = {};
    all.forEach(({ tag, word }, i) => {
      const hyphenated = shown[i]!;
      if (hyphenated.replace(/-/g, '') !== word)
        throw new Error(`${tag}: TeX showed ${hyphenated} for ${word}`);
      (out[tag] ??= []).push({ word, hyphenated });
    });
    const minimums: Recorded['minimums'] = {};
    for (const m of log.matchAll(/^MINS (\S+) (\d+) (\d+)$/gm))
      minimums[m[1]!] = { left: Number(m[2]), right: Number(m[3]) };
    if (Object.keys(minimums).length !== LISTS.length)
      throw new Error('the minimums of some language were not shown');
    return { languages: out, minimums };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const version = spawnSync('lualatex', ['--version'], { encoding: 'utf8' }).stdout.split(
    /\r?\n/,
  )[0];
  const file = resolve(import.meta.dirname, '../test/hyphenation-reference.json');
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      {
        $comment:
          'How TeX hyphenates each word: lualatex under babel, loaded through its ini files as docedit.cls does, with the hyph-utf8 patterns, read from \\showhyphens in the log (Latin Modern, TU encoding). Written by scripts/hyphenation-reference.ts; the kernel must give the same hyphens for the same patterns and minimums (WASM-009).',
        tool: version,
        ...record(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log('written', file);
}
