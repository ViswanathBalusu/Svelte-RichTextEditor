/**
 * An old version drawn in the web view (HIS-010): the read-only state of `../version-view.ts` in an
 * `EditorCore`, which can be mounted. The view never takes input that changes the document: the
 * mode is `view`, and no channel is attached.
 *
 * A comparison (HIS-013) is drawn over the newer version: insertions and formatting changes with the
 * classes of suggestion marks, deletions on demand, and a change bar on every changed block.
 */
import { type ComparisonChange, comparisonSpecs, positionOf } from '../comparison-markup.ts';
import type { VersionCoreOptions, VersionInput } from '../version-view.ts';
import { VersionDocument, versionCoreConfig } from '../version-view.ts';
import { EditorCore, viewsOf } from './web.ts';

export class VersionView extends VersionDocument {
  #changes: readonly ComparisonChange[] | null = null;
  #showDeleted = false;

  static open(input: VersionInput, options: VersionCoreOptions = {}): VersionView {
    return new VersionView(input, new EditorCore(versionCoreConfig(input, options)));
  }

  /** Draws the version in `target`; returns the function that removes the drawing. */
  mount(target: HTMLElement): () => void {
    const unmount = (this.core as EditorCore).mountBody(target);
    this.#draw();
    return unmount;
  }

  /** Draws `changes` (the `changes` of a comparison whose newer version is this one). */
  showComparison(changes: readonly ComparisonChange[]): void {
    this.#changes = changes;
    this.#draw();
  }

  /** Shows or hides the deleted text; hidden, nothing is added and the layout does not move. */
  showDeletions(on: boolean): void {
    this.#showDeleted = on;
    this.#draw();
  }

  /** Removes the comparison from the drawing. */
  clearComparison(): void {
    this.#changes = null;
    this.#draw();
  }

  /**
   * Moves focus to the block of change `index` and scrolls it into view (08 §6: previous and next
   * navigation). A read-only surface takes no caret, so the block element itself takes focus
   * (`tabindex="-1"`), which a screen reader reads. False when the change has no place in this
   * version (a removed block) or the view is not mounted.
   */
  focusChange(index: number): boolean {
    const change = this.#changes?.[index];
    const id = change?.blockId ?? change?.fieldId;
    const view = viewsOf(this.core as EditorCore).view;
    if (id === undefined || !view) return false;
    const pos = positionOf(view.state.doc, id);
    if (pos === null) return false;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return false;
    dom.tabIndex = -1;
    dom.focus();
    dom.scrollIntoView({ block: 'nearest' });
    return true;
  }
  /**
   * The identifiers of the text blocks the user has selected in this version, in document order
   * (HIS-015: "who wrote this" for a passage). A caret with no range selects nothing.
   */
  selectedBlocks(): string[] {
    const view = viewsOf(this.core as EditorCore).view;
    if (!view) return [];
    const { from, to } = view.state.selection;
    if (from === to) return [];
    const ids: string[] = [];
    view.state.doc.nodesBetween(from, to, (node) => {
      const id: unknown = node.attrs['id'];
      if (node.isTextblock && typeof id === 'string') ids.push(id);
      return true;
    });
    return ids;
  }

  #draw(): void {
    const core = this.core as EditorCore;
    const view = viewsOf(core).view;
    if (!view) return;
    core.setComparison(
      this.#changes === null
        ? null
        : comparisonSpecs(view.state.doc, this.#changes, { showDeleted: this.#showDeleted }),
    );
  }
}

/** The `make` of a `VersionOpener` for the web view. */
export function makeWebVersion(input: VersionInput, options: VersionCoreOptions): VersionView {
  return VersionView.open(input, options);
}
