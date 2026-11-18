/**
 * Installs a third-party extension as a tier 2 entry (UX-060; 13 §7.2; ADR 0393). The result is an
 * entry for the same `extensions` list as a tier 1 extension, so the host's checks, reports and
 * removal apply to it unchanged (UX-050): a bad manifest, a duplicate id or an unsupported API
 * version is reported by `ExtensionHost`, and removing the entry removes the frame.
 *
 * What differs is where the code runs: `activate` does not call the extension. It mounts an iframe
 * with `sandbox="allow-scripts"` (sandbox-frame.ts) and the extension's code runs there, with the
 * document API reachable only through messages and only within the `access` it declared.
 *
 * The manifest of a tier 2 entry adds to the three fields of tier 1 (UX-050):
 * `tier: 2`, `access: { read: 'view', write: 'none' | 'suggest' | 'edit' }` and `entry`, the URL of
 * its code (ADR 0234 B3, ADR 0393). A missing or unknown `access` is a failed activation, never a
 * default: an extension gets no more than it declared, and nothing is declared for it.
 */
import type { ExtensionEntry } from './host.ts';
import type { ExtensionDocumentApi } from './document-api.ts';
import { mountSandboxFrame, type SandboxKey } from './sandbox-frame.ts';
import { parseAccess, type SandboxLogEntry } from './sandbox-protocol.ts';
import { contributePanel } from './contributions.ts';
import type { PaneComponent, PaneRegistry } from '../shell/panes.ts';

/** What the host gives an entry when it activates it (the shell's `ExtensionApi`). */
export interface SandboxedActivationApi {
  /** The extension's own document API; null when the core or the host does not offer one. */
  readonly document: ExtensionDocumentApi | null;
  /** Runs `dispose` when the extension is removed. */
  onRemove(dispose: () => void): void;
}

export interface SandboxedExtensionOptions {
  /** The manifest as the host holds it: `id`, `name`, `apiVersion`, `tier`, `access`, `entry`. */
  readonly manifest: Readonly<Record<string, unknown>>;
  /** The URL of the host's `sandbox-frame.html`. */
  readonly frameUrl: string;
  /** Where the iframe goes: a hidden element for an extension with no panel. Not used with `panel`. */
  readonly container?: () => HTMLElement;
  /**
   * Gives the extension a panel in the pane host (UX-060). The frame is mounted in the pane's body
   * when the pane opens and removed when it closes, so the extension's code runs while its panel is
   * open; the pane is registered with the extension and removed with it. Focus enters the frame
   * when the pane opens, and Ctrl+F6, Alt+F6 and Escape pressed in the frame reach the shell.
   */
  readonly panel?: {
    readonly registry: PaneRegistry;
    readonly id: string;
    /**
     * Loads the pane component, `panes/SandboxPane.svelte`: `() => import('@docedit/ui/panes/SandboxPane.svelte')`
     * with the default export. The host passes it so that this module stays free of Svelte files.
     */
    readonly load: () => Promise<PaneComponent>;
  };
  /** Whether the editor is in suggestion mode now (for `access.write` of `suggest`). */
  readonly suggesting: () => boolean;
  /** Receives each refused or ignored message of the frame. */
  readonly log: (entry: SandboxLogEntry) => void;
  /** Receives a landmark key (F6) or Escape pressed in the frame, for the shell (UX-023). */
  readonly onKey?: (key: SandboxKey) => void;
  /** Called with the frame once it is mounted, for a panel that wants to focus it. */
  readonly onMounted?: (frame: ReturnType<typeof mountSandboxFrame>) => void;
}

export function sandboxedExtension(
  options: SandboxedExtensionOptions,
): ExtensionEntry<SandboxedActivationApi> {
  const { manifest } = options;
  return {
    manifest,
    activate(api) {
      if (manifest['tier'] !== 2) throw new Error('a sandboxed extension declares tier 2');
      const entry = manifest['entry'];
      if (typeof entry !== 'string' || entry.trim() === '')
        throw new Error('a sandboxed extension needs the URL of its code in `entry`');
      const access = parseAccess(manifest['access']);
      if (!access.ok) throw new Error(access.message);
      if (api.document === null)
        throw new Error('the editor does not offer the document API to extensions');
      const name = String(manifest['name'] ?? manifest['id']);
      const documentApi = api.document;
      if (options.panel) {
        const mount = (container: HTMLElement, onKey: (key: SandboxKey) => void): (() => void) => {
          const frame = mountSandboxFrame({
            container,
            frameUrl: options.frameUrl,
            entryUrl: entry.trim(),
            extension: String(manifest['id']),
            title: name,
            api: documentApi,
            access: access.access,
            suggesting: options.suggesting,
            log: options.log,
            onKey,
            // The pane closes and opens again while the extension stays installed.
            keepApi: true,
          });
          options.onMounted?.(frame);
          return () => frame.dispose();
        };
        api.onRemove(
          contributePanel(options.panel.registry, {
            id: options.panel.id,
            label: name,
            load: options.panel.load,
            props: { mount },
          }),
        );
        return;
      }
      if (!options.container) throw new Error('a sandboxed extension needs a container or a panel');
      const frame = mountSandboxFrame({
        container: options.container(),
        frameUrl: options.frameUrl,
        entryUrl: entry.trim(),
        extension: String(manifest['id']),
        title: name,
        api: api.document,
        access: access.access,
        suggesting: options.suggesting,
        log: options.log,
        ...(options.onKey ? { onKey: options.onKey } : {}),
      });
      api.onRemove(() => frame.dispose());
      options.onMounted?.(frame);
    },
  };
}
