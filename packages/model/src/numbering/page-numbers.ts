/**
 * The number a page shows, from the page setup's start and format (FE-137 criterion 4, lane
 * V-FE-129-141; 03 §4.1 `page_setup`, §7). The counter of each page section starts at the section's
 * `pageNumberStart`; a `null` start means the section continues the number of the one before it,
 * and the caller resolves that. The text uses the shared formats of `formatNumber`, so a page field
 * and a list label that name the same format print the same characters.
 *
 * Pure: no clock, no document, no layout. The typesetter supplies the index of the page in its
 * section; this module never counts pages itself.
 */
import { formatNumber } from './format.ts';

/** The page number formats of the CDM (`page_setup.pageNumberFormat`). */
export type PageNumberFormat =
  'decimal' | 'lowerRoman' | 'upperRoman' | 'lowerLetter' | 'upperLetter';

/**
 * The number of the page at `indexInSection` (0 for the section's first page) when the section
 * starts at `start`. A start of 0 gives 0 on the first page, as the CDM allows (0 to 32767).
 */
export function pageNumberOf(start: number, indexInSection: number): number {
  if (!Number.isInteger(start) || !Number.isInteger(indexInSection) || indexInSection < 0) {
    throw new RangeError('pageNumberOf: start and index must be integers, the index not negative');
  }
  return start + indexInSection;
}

/** The text a page field prints for a page number in the given format (03 §4.4, §7). */
export function pageNumberText(pageNumber: number, format: PageNumberFormat): string {
  return formatNumber(pageNumber, format);
}
