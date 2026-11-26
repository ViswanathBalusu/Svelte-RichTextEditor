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

/**
 * The message the element shows in the editor area when a document cannot be opened (PRO-039;
 * decision 45): a title, a message and one action. `{seconds}` is replaced with a number.
 */
export interface FailureStrings {
  noAccessTitle: string;
  noAccessMessage: string;
  updateTitle: string;
  updateMessage: string;
  waitTitle: string;
  /** With the wait the server asked for. */
  waitMessage: string;
  /** Without one. */
  waitMessageUnknown: string;
  quotaTitle: string;
  quotaMessage: string;
  quotaMessageUnknown: string;
  /** The quota message when the refusal names the kind of quota; {kind} is a phrase of quotaKinds. */
  quotaKindMessage: string;
  quotaKindMessageUnknown: string;
  /** The words for each kind of quota the service names (06 §12; owner decision 110). */
  quotaKinds: Readonly<Record<string, string>>;
  otherTitle: string;
  otherMessage: string;
  /** The action that asks for the document again. */
  retry: string;
  /** The action of an update: the page is loaded again, with the new component. */
  reloadPage: string;
}

export interface Strings {
  pdf: PdfViewerStrings;
  failure: FailureStrings;
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
  failure: {
    noAccessTitle: 'You do not have access to this document',
    noAccessMessage: 'Ask the owner of the document to share it with you.',
    updateTitle: 'The editor needs to be updated',
    updateMessage:
      'This document needs a newer version of the editor than the one on this page. Update the component, then load the page again.',
    waitTitle: 'The service is busy',
    waitMessage: 'Too many requests were sent. You can try again in {seconds} seconds.',
    waitMessageUnknown: 'Too many requests were sent. Wait a little, then try again.',
    quotaTitle: 'The quota is used up',
    quotaMessage:
      'The quota of this workspace is used up. You can try again in {seconds} seconds, or ask the administrator to raise it.',
    quotaMessageUnknown:
      'The quota of this workspace is used up. Ask the administrator to raise it.',
    quotaKindMessage:
      'The {kind} quota of this workspace is used up. You can try again in {seconds} seconds, or ask the administrator to raise it.',
    quotaKindMessageUnknown:
      'The {kind} quota of this workspace is used up. Ask the administrator to raise it.',
    quotaKinds: {
      connections: 'connections',
      openDocuments: 'open documents',
      commitRate: 'saves per minute',
      roomCpuBudget: 'editing processing time',
      storage: 'storage',
      exportConcurrency: 'simultaneous exports',
      exportMinutes: 'export minutes',
    },
    otherTitle: 'The document could not be opened',
    otherMessage: 'Something went wrong while opening the document.',
    retry: 'Try again',
    reloadPage: 'Load the page again',
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
