/**
 * The adoption step of the signing ceremony (FRW-045; 12 §8.1 step 2, §11), as plain functions
 * without the DOM. A participant adopts a signature, and separately initials, by one of three modes:
 * typed (the default; it needs no pointer), drawn, or an uploaded image. The image that results goes
 * to the asset worker like any upload; the value written at signing is `{ asset, mode }`.
 *
 * The typed name is shown as text for assistive technology (`typedPreview`); the canvas that draws
 * it is a picture of that text and is hidden from them.
 */
import type { SignatureKind, SignatureMode } from '../core-api.ts';
import '../i18n/late/dialogs.ts';

/** The modes in the order they are offered; the first is the default and needs no pointer. */
export const SIGNATURE_MODES: readonly SignatureMode[] = ['typed', 'drawn', 'uploaded'];

export const DEFAULT_SIGNATURE_MODE: SignatureMode = 'typed';

/** The image types the upload accepts; the asset worker validates and re-encodes (FRW-045 criterion 2). */
export const UPLOAD_ACCEPT = 'image/png,image/jpeg';

/** What the participant has entered so far in the step. */
export interface AdoptionDraft {
  readonly mode: SignatureMode;
  /** The typed name or initials. */
  readonly typed: string;
  /** Whether something has been drawn. */
  readonly drawn: boolean;
  /** The file chosen for upload, if any. */
  readonly file: { readonly name: string; readonly type: string } | null;
}

export const EMPTY_DRAFT: AdoptionDraft = {
  mode: DEFAULT_SIGNATURE_MODE,
  typed: '',
  drawn: false,
  file: null,
};

/** The typed text as it is shown and drawn: trimmed, with runs of white space made one space. */
export function typedPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Why the draft cannot be adopted yet, as a key of the shell's string table; null when it can. */
export function draftProblem(
  draft: AdoptionDraft,
): 'signature.problem.typed' | 'signature.problem.drawn' | 'signature.problem.file' | null {
  switch (draft.mode) {
    case 'typed':
      return typedPreview(draft.typed) === '' ? 'signature.problem.typed' : null;
    case 'drawn':
      return draft.drawn ? null : 'signature.problem.drawn';
    case 'uploaded':
      return draft.file !== null && UPLOAD_ACCEPT.split(',').includes(draft.file.type)
        ? null
        : 'signature.problem.file';
  }
}

/** The initials of a name: the first letter of each word, in capitals, at most four. */
export function initialsOf(name: string): string {
  const words = typedPreview(name)
    .split(' ')
    .filter((w) => w !== '');
  return words
    .slice(0, 4)
    .map((w) => [...w][0] ?? '')
    .join('')
    .toLocaleUpperCase();
}

/** The other kind: the step adopts signature and initials separately and offers the switch. */
export function otherKind(kind: SignatureKind): SignatureKind {
  return kind === 'signature' ? 'initials' : 'signature';
}

/** The file name an adopted image is uploaded under. */
export function adoptionFilename(kind: SignatureKind, mode: SignatureMode, type: string): string {
  const ext = type === 'image/jpeg' ? 'jpg' : 'png';
  return `${kind}-${mode}.${ext}`;
}
