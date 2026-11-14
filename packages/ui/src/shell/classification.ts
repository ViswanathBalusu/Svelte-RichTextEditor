/**
 * What the status bar shows of the document's classification label (UX-085, criterion 2; 13 §3).
 * The label is content the tenant set, so its name is shown as written, in text. The status bar
 * never shows it by colour alone, and a blank or missing name shows nothing.
 *
 * This module decides which name is shown. The words around it (`status.classification`) are the
 * component's and come from the string table.
 */
import type { ClassificationLabel } from '../core-api.ts';

/**
 * The name to show for a label: trimmed, with runs of white space made single spaces. Null when
 * there is no label, or its name is blank, so that an empty label never shows an empty marking.
 */
export function classificationName(label: ClassificationLabel | null | undefined): string | null {
  if (!label || typeof label.name !== 'string') return null;
  const name = label.name.replace(/\s+/g, ' ').trim();
  return name.length > 0 ? name : null;
}
