/**
 * Pasting a picture (FE-053 criteria 1, 2 and 4; 02 §5.2; 03 §4.4; 10 §3.1).
 *
 * - The picture is handed to the assets port, which uploads it to quarantine and validates and
 *   re-encodes it (10 §3.1). The port answers with the asset identifier and the display size in
 *   twips. The engine never stores the bytes in the document: the `image` node holds the asset
 *   identifier and the two sizes, and nothing else (criterion 2).
 * - The scope is checked before anything is uploaded (criterion 4): a position the user cannot
 *   change uploads nothing and inserts nothing. The check is repeated when the upload completes,
 *   because the document may have changed while it ran; a refusal then leaves the document as it
 *   was (the uploaded asset is not removed here, see the story notes).
 * - A failed upload, or a rejection by the asset service, inserts nothing and returns its reason,
 *   so that the shell can remove a placeholder and say why (criterion 3 is the shell's).
 * - Which picture types the asset service accepts is its own rule (10 §3.1); this module does not
 *   list them. SVG is never drawn live (FE-067); this module only refers to the asset.
 *
 * The core's `pasteFromClipboard` runs this for picture files on the clipboard (clipboard.ts
 * `chooseClipboard`), with the assets port that `attach` or the configuration gives it; the element
 * adapts the backend's port (packages/element/src/assets.ts).
 */
import type { QuotaKind } from '@docedit/protocol';
import type { EditorState, Transaction } from 'prosemirror-state';

/** The largest size of a picture side in twips, as the `image` node allows (I7). */
export const IMAGE_SIZE_MAX_TWIPS = 31680;

/** A picture taken from the clipboard. */
export interface PastedImage {
  readonly name: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}

/** What the assets port returns for an accepted picture. */
export interface StoredImage {
  readonly asset: string;
  readonly widthTwips: number;
  readonly heightTwips: number;
}

export type UploadOutcome =
  | { readonly ok: true; readonly image: StoredImage }
  | { readonly ok: false; readonly message: string; readonly quota?: QuotaKind };

/** The assets port (10 §3.1): the upload and its validation are the asset service's. */
export interface AssetsPort {
  upload(image: PastedImage): Promise<UploadOutcome>;
}

/** The editing state the paste reads and changes. */
export interface PasteHost {
  state(): EditorState;
  dispatch(tr: Transaction): void;
}

export type ImagePasteResult =
  | { readonly ok: true; readonly asset: string }
  | {
      readonly ok: false;
      readonly reason: 'read-only' | 'upload-failed' | 'invalid-size';
      readonly message?: string;
      /** The quota the service named when it refused the upload (UX-078 criterion 3). */
      readonly quota?: QuotaKind;
    };

const isSize = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= IMAGE_SIZE_MAX_TWIPS;

/**
 * Uploads `image` through the port and, when the upload succeeds and the position is still
 * writable, inserts an `image` node at the selection. Nothing is uploaded when `writable` refuses
 * the selection at the start.
 */
export async function pasteImage(
  host: PasteHost,
  image: PastedImage,
  port: AssetsPort,
  options: { readonly writable: (pos: number) => boolean },
): Promise<ImagePasteResult> {
  if (!options.writable(host.state().selection.from)) return { ok: false, reason: 'read-only' };
  const outcome = await port.upload(image);
  if (!outcome.ok) {
    return {
      ok: false,
      reason: 'upload-failed',
      message: outcome.message,
      ...(outcome.quota === undefined ? {} : { quota: outcome.quota }),
    };
  }
  const { asset, widthTwips, heightTwips } = outcome.image;
  if (!isSize(widthTwips) || !isSize(heightTwips)) {
    return { ok: false, reason: 'invalid-size' };
  }
  const state = host.state();
  if (!options.writable(state.selection.from)) return { ok: false, reason: 'read-only' };
  const type = state.schema.nodes['image'];
  if (!type) throw new Error('the schema has no image node');
  const node = type.create({ asset, width: widthTwips, height: heightTwips });
  host.dispatch(state.tr.replaceSelectionWith(node, false));
  // The editing core's guard may still filter the change out (an invariant, a lock): nothing then.
  if (host.state().doc === state.doc) return { ok: false, reason: 'read-only' };
  return { ok: true, asset };
}
