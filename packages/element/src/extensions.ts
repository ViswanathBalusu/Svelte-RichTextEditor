/**
 * The type of the `extensions` property (05 §8.1; 13 §7; PRO-082 criterion 4). The property holds
 * the host's own extensions, the ones that run in the page with the host's trust (13 §7.2, tier 1).
 * Sandboxed extensions of other parties are not set here.
 *
 * ```ts
 * const hello: HostExtension = {
 *   manifest: { id: 'acme.hello', name: 'Hello', apiVersion: '1' },
 *   activate(api) {
 *     api.registerCommand({ id: 'acme.hello', label: 'acme.hello', group: 'view', ... });
 *   },
 * };
 * element.extensions = [hello];
 * ```
 *
 * The array is read when the element loads and again at each change. Each entry is checked on its
 * own (UX-050): one with a bad manifest, a duplicate `id`, an `apiVersion` the editor does not
 * support or an `activate` that throws is reported in a `de-error` event with `fatal: false` and
 * skipped, and the others still load. A key of the manifest that is not listed here is ignored
 * (PRO-005). The property is typed here and read defensively at run time, because the host's value
 * is data from outside.
 */
import type { CommandEntry, ExtensionDocumentApi } from '@docedit/ui';

/** What the editor reads of a manifest. The spec lists no other field (UX-049 is open). */
export interface HostExtensionManifest {
  /** Lower-case, dot-separated identifier of at most 64 characters, unique among the extensions. */
  readonly id: string;
  /** The name people see. Trimmed; it may not be empty. */
  readonly name: string;
  /** The API version the extension was written for, as a string. The editor supports `'1'`. */
  readonly apiVersion: string;
  /** Any other key is ignored. */
  readonly [key: string]: unknown;
}

/** What `activate` is given. Everything it registers is removed with the extension. */
export interface HostExtensionApi {
  /** Adds a command to the editor's one registry: toolbars, menus, `exec` and `queryCommand`. */
  registerCommand(entry: CommandEntry): void;
  /** The range-based document API, or `null` when the host or the core does not offer it (UX-053). */
  readonly document: ExtensionDocumentApi | null;
  /** Runs `dispose` when the extension is removed. */
  onRemove(dispose: () => void): void;
  /**
   * Adds a side panel (UX-052). `mount` draws the panel's elements into `container` when the panel
   * is opened and may return the function that removes them; a throw from it is reported as a
   * `de-error` with `fatal: false`. The panel is held to the accessibility requirements of the
   * built-in panes and can read the public `--de-` properties. Removed with the extension.
   */
  registerPanel(panel: {
    id: string;
    label: string;
    mount: (container: HTMLElement) => unknown;
  }): void;
  /** Opens a panel by its identifier; resolves false when it is not offered. */
  openPanel(id: string): Promise<boolean>;
  /**
   * Adds a status-bar item at the `start` or `end` of the bar (UX-052). `label` is the text
   * alternative a screen reader announces. Removed with the extension.
   */
  addStatusItem(item: { id: string; position: 'start' | 'end'; text: string; label: string }): void;
  /**
   * Adds a client import or export filter (UX-055). An import filter reads the bytes of a file of one of
   * its extensions and returns a CDM fragment, which the editor inserts in place of the selection
   * through the guards of typing; an export filter receives a copy of the document and returns the
   * bytes of a file. A filter that throws is reported and leaves the document unchanged. Removed with
   * the extension.
   */
  registerFilter(filter: HostFilter): void;
}

/** A client filter of an extension (UX-055). */
export type HostFilter =
  | {
      readonly kind: 'import';
      readonly id: string;
      readonly label: string;
      /** File name extensions the filter reads, without dots. */
      readonly extensions: readonly string[];
      readonly run: (input: {
        readonly bytes: Uint8Array;
        readonly name: string;
      }) => unknown | Promise<unknown>;
    }
  | {
      readonly kind: 'export';
      readonly id: string;
      readonly label: string;
      readonly mimeType: string;
      /** The file name extension, without the dot. */
      readonly extension: string;
      readonly run: (content: unknown) => Uint8Array | Promise<Uint8Array>;
    };

/** One element of the `extensions` array. */
export interface HostExtension {
  readonly manifest: HostExtensionManifest;
  /** Called once when the extension is registered. A throw is reported and the extension is skipped. */
  readonly activate: (api: HostExtensionApi) => void;
}
