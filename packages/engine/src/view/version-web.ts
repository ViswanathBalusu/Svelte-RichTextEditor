/**
 * An old version drawn in the web view (HIS-010): the read-only state of `../version-view.ts` in an
 * `EditorCore`, which can be mounted. The view never takes input that changes the document: the
 * mode is `view`, and no channel is attached.
 */
import type { VersionCoreOptions, VersionInput } from '../version-view.ts';
import { VersionDocument, versionCoreConfig } from '../version-view.ts';
import { EditorCore } from './web.ts';

export class VersionView extends VersionDocument {
  static open(input: VersionInput, options: VersionCoreOptions = {}): VersionView {
    return new VersionView(input, new EditorCore(versionCoreConfig(input, options)));
  }

  /** Draws the version in `target`; returns the function that removes the drawing. */
  mount(target: HTMLElement): () => void {
    return (this.core as EditorCore).mountBody(target);
  }
}

/** The `make` of a `VersionOpener` for the web view. */
export function makeWebVersion(input: VersionInput, options: VersionCoreOptions): VersionView {
  return VersionView.open(input, options);
}
