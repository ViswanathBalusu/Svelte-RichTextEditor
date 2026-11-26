/**
 * The fonts of a manifest that a job may load on the server (EXP-048 criterion 3; owner decision
 * 62): a family the administrator did not mark for server-side use on upload is used on screen only
 * and is replaced in the PDF. The mark is `serverUse` on the manifest's family. It is set by the
 * service for a tenant's own font (true when the administrator set the flag, false when not); the
 * default set carries none, because its licences were checked when the set was built (BE-047), so
 * an absent mark means permitted. Proposed in `docs/adr/` (EXP-048, lane w2); BE-048 sets the mark.
 *
 * Universal: pure, no Node.js or browser API.
 */
import type { FontFamily, FontManifest } from './bundle.ts';

export interface ServerFonts {
  /** The manifest the job may load: the families marked for server use, and every other entry. */
  readonly fonts: FontManifest;
  /** The families left out, in manifest order. */
  readonly excluded: readonly FontFamily[];
}

/** Whether a family may be loaded on the server. */
export const serverUse = (family: Pick<FontFamily, 'serverUse'>): boolean =>
  family.serverUse !== false;

export function serverFonts(fonts: FontManifest): ServerFonts {
  const excluded = fonts.families.filter((f) => !serverUse(f));
  if (excluded.length === 0) return { fonts, excluded };
  return { fonts: { ...fonts, families: fonts.families.filter(serverUse) }, excluded };
}
