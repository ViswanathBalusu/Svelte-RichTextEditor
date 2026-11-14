/**
 * Interface strings of the element's own pieces, kept out of the code that shows them (13 §8;
 * FE-071). One table per locale; English is the default. Replaceable strings for hosts are UX's
 * (13 §8) and will feed this table.
 */
export interface PdfViewerStrings {
  /** Accessible name of the viewer frame. */
  title: string;
  toolbar: string;
  previous: string;
  next: string;
  zoomIn: string;
  zoomOut: string;
  /** `{page}` and `{pages}` are replaced with numbers. */
  pageOf: string;
  /** `{percent}` is replaced with a number. */
  zoom: string;
  loading: string;
  failed: string;
  pageFailed: string;
}

export interface Strings {
  pdf: PdfViewerStrings;
}

export const EN: Strings = {
  pdf: {
    title: 'Typeset PDF',
    toolbar: 'Pages',
    previous: 'Previous page',
    next: 'Next page',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    pageOf: 'Page {page} of {pages}',
    zoom: '{percent} %',
    loading: 'Loading the PDF',
    failed: 'The PDF could not be opened.',
    pageFailed: 'This page could not be drawn.',
  },
};

/** Fills `{name}` placeholders. */
export function format(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) =>
    name in values ? String(values[name]) : all,
  );
}
