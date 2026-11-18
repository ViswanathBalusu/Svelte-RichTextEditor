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
}

/** One element of the `extensions` array. */
export interface HostExtension {
  readonly manifest: HostExtensionManifest;
  /** Called once when the extension is registered. A throw is reported and the extension is skipped. */
  readonly activate: (api: HostExtensionApi) => void;
}
