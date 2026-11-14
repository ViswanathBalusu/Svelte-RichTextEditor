/**
 * The KaTeX fonts on the page, under hash aliases (FE-069 criterion 3; 02 §3, §6; FE-061).
 *
 * `@font-face` rules inside a shadow root are ignored, and the page's font set is shared with the
 * host, so KaTeX's own `@font-face` rules are never used. Instead:
 *
 * - Each KaTeX family (`KaTeX_Main`, `KaTeX_Math` and the others) gets one alias,
 *   `de-font-<sha-256>`, where the hash is taken over the SHA-256 hashes of that family's files
 *   (sorted, one per line). The alias therefore names the exact bytes of every face it holds: two
 *   editors with the same KaTeX files share it, and a different KaTeX release gets a different one.
 * - Every file of the family is registered on `document.fonts` with the FontFace API under that
 *   alias, with its own style and weight. A face that is already there (same alias, style and
 *   weight) is not added again.
 * - KaTeX's stylesheet is adopted into the editor's shadow root with its `@font-face` rules removed
 *   and each `KaTeX_*` family name replaced by its alias. Its `font-weight` and `font-style` rules
 *   then pick the right face of the alias, as they did with the family name.
 *
 * One alias per family, rather than one per file as for the backend's manifest (`registerFontFiles`),
 * is the choice taken here: KaTeX's rules change the weight and style of an inherited family (for
 * example `.textbf` sets only `font-weight`), which a per-file alias cannot follow. Recorded in the
 * story's Notes as a proposal.
 *
 * `drawEquation` (`math-display.ts`) adopts the sheet into the root of the container it draws into,
 * once `loadKatexFonts` has run. Where the files are served from is the host's: `baseUrl` is given
 * by the caller and no default location is assumed (FE-069 Notes).
 */
import { sha256Hex } from '@docedit/model';
import { pageFonts, type PageFonts } from './font-loader.ts';
import { fontAlias, type FontFaceLike, type FontFileEntry } from './font-registration.ts';
import { KATEX_FONT_ROWS, katexFontFiles } from './katex-font-manifest.ts';
import { adoptExtraSheet } from './styles.ts';

/** A face as a font set lists it, with the descriptors a duplicate is recognised by. */
interface DescribedFace extends FontFaceLike {
  readonly style?: string;
  readonly weight?: string;
}

/** The family names KaTeX's stylesheet uses, in manifest order, each once. */
export const KATEX_FAMILIES: readonly string[] = [...new Set(KATEX_FONT_ROWS.map((r) => r.family))];

/**
 * The alias of each KaTeX family: `fontAlias` of the SHA-256 of the family's file hashes, sorted and
 * joined by line feeds.
 */
export async function katexFamilyAliases(
  rows: readonly { readonly family: string; readonly hash: string }[] = KATEX_FONT_ROWS,
): Promise<Map<string, string>> {
  const hashes = new Map<string, string[]>();
  for (const row of rows) {
    const list = hashes.get(row.family) ?? [];
    list.push(row.hash);
    hashes.set(row.family, list);
  }
  const aliases = new Map<string, string>();
  for (const [family, list] of hashes)
    aliases.set(family, fontAlias(await sha256Hex([...list].sort().join('\n'))));
  return aliases;
}

const unquoted = (family: string): string => family.replace(/^["']|["']$/g, '');

/** A weight descriptor in its numeric form, so that `bold` and `700` compare equal. */
const numericWeight = (weight: string | undefined): string =>
  weight === undefined || weight === 'normal' ? '400' : weight === 'bold' ? '700' : weight;

/**
 * Registers each entry on the font set under its family's alias, with the entry's style and weight.
 * A face the set already holds under the same alias, style and weight is not added again; the host's
 * faces are never read by family name and never removed.
 *
 * @returns the faces added by this call.
 * @throws {Error} when an entry's family has no alias.
 */
export function registerKatexFaces(
  entries: readonly FontFileEntry[],
  aliases: ReadonlyMap<string, string>,
  target: PageFonts,
): FontFaceLike[] {
  const added: FontFaceLike[] = [];
  for (const entry of entries) {
    const alias = aliases.get(entry.family);
    if (alias === undefined) throw new Error(`no alias for the KaTeX family ${entry.family}`);
    let held = false;
    for (const face of target.set as Iterable<DescribedFace>) {
      if (
        unquoted(face.family) === alias &&
        (face.style ?? 'normal') === entry.style &&
        numericWeight(face.weight) === numericWeight(entry.weight)
      ) {
        held = true;
        break;
      }
    }
    if (held) continue;
    const face = target.make(alias, entry.url, entry.style, entry.weight);
    target.set.add(face);
    added.push(face);
  }
  return added;
}

/**
 * KaTeX's stylesheet for the shadow root: every `@font-face` rule removed and every `KaTeX_*` family
 * name replaced by its alias, quoted.
 *
 * @throws {Error} when the sheet names a KaTeX family that has no alias, so that no glyph is left on
 *   a family that no face provides.
 */
export function katexSheetText(css: string, aliases: ReadonlyMap<string, string>): string {
  const withoutFaces = css.replace(/@font-face\s*\{[^}]*\}/g, '');
  return withoutFaces.replace(/KaTeX_[A-Za-z0-9]+/g, (family) => {
    const alias = aliases.get(family);
    if (alias === undefined) throw new Error(`no alias for the KaTeX family ${family}`);
    return `"${alias}"`;
  });
}

/** What `loadKatexFonts` set up: the alias of each family and the sheet text for a shadow root. */
export interface KatexFonts {
  readonly aliases: ReadonlyMap<string, string>;
  readonly sheet: string;
  /** The faces this page holds for the KaTeX files (added now or by an earlier call). */
  readonly faces: readonly FontFaceLike[];
}

let prepared: KatexFonts | null = null;
let pending: Promise<KatexFonts | null> | null = null;
const adopted = new WeakSet<ShadowRoot>();

/**
 * Registers the KaTeX files, served from `baseUrl` (the host's directory, ending in `/`), on the
 * page under their family aliases, and prepares the sheet `drawEquation` adopts. A second call, from
 * this editor or another on the page, adds no face. Resolves to null where there is no page.
 */
export function loadKatexFonts(
  baseUrl: string,
  target: PageFonts | null = pageFonts(),
): Promise<KatexFonts | null> {
  if (!target) return Promise.resolve(null);
  const run = async (): Promise<KatexFonts> => {
    const [aliases, { default: css }] = await Promise.all([
      katexFamilyAliases(),
      import('katex/dist/katex.min.css?inline'),
    ]);
    registerKatexFaces(katexFontFiles(baseUrl), aliases, target);
    const values = new Set(aliases.values());
    const faces = Array.from(target.set).filter((f) => values.has(unquoted(f.family)));
    const result: KatexFonts = { aliases, sheet: katexSheetText(css, aliases), faces };
    prepared = result;
    return result;
  };
  // Serialised, so that two calls in one task do not both register the faces.
  const next = (pending ?? Promise.resolve(null)).catch(() => null).then(run);
  pending = next;
  return next;
}

/** The KaTeX fonts as loaded so far, or null before `loadKatexFonts` has resolved. */
export function katexFonts(): KatexFonts | null {
  return prepared;
}

/**
 * Adopts the aliased KaTeX sheet into the shadow root that holds `node`, once per root. Does nothing
 * before `loadKatexFonts` has resolved, or when `node` is not in a shadow root.
 *
 * @returns true when the root holds the sheet after the call.
 */
export function adoptKatexSheet(node: Node): boolean {
  const root = node.getRootNode();
  const Shadow = (globalThis as { ShadowRoot?: typeof ShadowRoot }).ShadowRoot;
  if (!prepared || Shadow === undefined || !(root instanceof Shadow)) return false;
  if (adopted.has(root)) return true;
  if (adoptExtraSheet(root, prepared.sheet) === 'none') return false;
  adopted.add(root);
  return true;
}
