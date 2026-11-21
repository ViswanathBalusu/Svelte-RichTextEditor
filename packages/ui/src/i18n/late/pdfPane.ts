/**
 * The strings of the `pdfPane` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_PDF_PANE = {
  // The PDF preview pane (EXP-001). The job's state and page count use the export strings above.
  'pdf.empty': 'No PDF has been made in this session yet.',
  'pdf.make': 'Make a preview',
  'pdf.refresh': 'Make a new preview',
  'pdf.loading': 'Loading the PDF',
  'pdf.failed.start': 'The preview could not be started.',
  'pdf.failed.view': 'The PDF could not be shown. Make a new preview to try again.',
} as const satisfies StringTable;

registerSource(EN_GB_PDF_PANE);
