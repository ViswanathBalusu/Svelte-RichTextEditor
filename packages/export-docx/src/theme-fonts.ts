/**
 * The font families a package names in its `w:rFonts` elements, theme fonts included (EXP-106).
 *
 * The importer keeps only `w:ascii` in the model (`rFonts` lens in props.ts), and `w:asciiTheme`
 * is carried as preserved residue. A file made by recent Word names its body font only through the
 * theme (`w:asciiTheme="minorHAnsi"`, with `Aptos` in `theme1.xml`), so reading the model alone
 * would never see it. This module reads the elements themselves and resolves the theme references.
 *
 * It only reads: nothing here changes the document or the source map (SR-M12: the document keeps
 * what the file names). Universal: no file system, no network.
 */
import { NS } from './ooxml.ts';
import { type XmlElement, attr, child, elements } from './xml.ts';

/** The Latin typefaces of a theme's font scheme. */
export interface ThemeFonts {
  major?: string;
  minor?: string;
}

/** Reads `a:fontScheme` of a theme part's root (`a:theme`). Absent or empty typefaces are left out. */
export function themeFonts(root: XmlElement): ThemeFonts {
  const out: ThemeFonts = {};
  const scheme = child(child(root, NS.a, 'themeElements') ?? root, NS.a, 'fontScheme');
  if (!scheme) return out;
  for (const slot of ['major', 'minor'] as const) {
    const holder = child(scheme, NS.a, `${slot}Font`);
    const face = holder ? attr(child(holder, NS.a, 'latin') ?? holder, '', 'typeface') : undefined;
    if (face?.trim() && child(holder!, NS.a, 'latin')) out[slot] = face.trim();
  }
  return out;
}

/** The slot a `w:asciiTheme` or `w:hAnsiTheme` value names (`majorHAnsi`, `minorAscii`, ...). */
function slotOf(value: string): 'major' | 'minor' | undefined {
  if (/^major(H?Ansi|Ascii)$/.test(value)) return 'major';
  if (/^minor(H?Ansi|Ascii)$/.test(value)) return 'minor';
  return undefined;
}

/**
 * The Latin families named by every `w:rFonts` under `root`, in document order. For each of
 * `ascii` and `hAnsi`, a theme reference wins over the literal name, as in Word; a theme reference
 * to a slot the theme does not fill gives nothing. East Asian and complex-script slots are not read.
 * Iterative, so that a deeply nested part cannot exhaust the stack.
 */
export function rFontsFamilies(root: XmlElement, theme: ThemeFonts = {}): string[] {
  const out: string[] = [];
  const stack: XmlElement[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    if (el.ns === NS.w && el.local === 'rFonts') {
      for (const [literal, themed] of [
        ['ascii', 'asciiTheme'],
        ['hAnsi', 'hAnsiTheme'],
      ] as const) {
        const ref = attr(el, NS.w, themed);
        const slot = ref === undefined ? undefined : slotOf(ref);
        const family = slot ? theme[slot] : ref === undefined ? attr(el, NS.w, literal) : undefined;
        if (family?.trim()) out.push(family);
      }
    }
    const kids = elements(el);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out;
}
