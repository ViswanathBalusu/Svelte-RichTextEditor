/**
 * The glyph check (09 §3.2, Missing glyphs; EXP-026): every character the converter typesets is
 * checked against the coverage of the run's face and of the fallback chain, from the font
 * manifest. A miss is an error in a final export, which must not release a PDF, and a warning in a
 * preview. The check runs only when the manifest gives coverage for the faces concerned; the class's
 * `\tracinglostchars` is the second line either way.
 */
import { diag, type Ctx, type FamilyInfo } from '../context.ts';
import { covers, type CodeRange } from './coverage.ts';

/** Characters the class never takes from a font: spaces and the TeX forms of special characters. */
const IGNORED = new Set([0x20, 0xa0, 0xad]);

function faceCoverage(f: FamilyInfo, bold: boolean, italic: boolean): readonly CodeRange[] | null {
  const face = bold
    ? italic
      ? f.family.boldItalic
      : f.family.bold
    : italic
      ? f.family.italic
      : f.family.regular;
  return face.coverage ?? null;
}

export function checkGlyphs(
  ctx: Ctx,
  value: string,
  family: FamilyInfo,
  bold: boolean,
  italic: boolean,
  blockId: string | null,
): void {
  const own = faceCoverage(family, bold, italic);
  if (!own || !ctx.fallbackCoverage) return;
  const reported = new Set<number>();
  for (const ch of value.normalize('NFC')) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || IGNORED.has(cp) || reported.has(cp)) continue;
    if (covers(own, cp)) continue;
    if (ctx.fallbackCoverage.some((r) => covers(r, cp))) continue;
    reported.add(cp);
    const key = `glyph:${blockId ?? ''}:${cp}`;
    if (ctx.warned.has(key)) continue;
    ctx.warned.add(key);
    diag(
      ctx,
      ctx.o.profile === 'final' ? 'error' : 'warning',
      'glyph_missing',
      blockId,
      `no font of the manifest has U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
    );
  }
}
