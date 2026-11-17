/**
 * Register host extensions (UX-050; 13 §7.1, §7.2; 05 §8.1 `extensions`).
 *
 * - `ExtensionHost.sync` takes the array the host set on the element. Each entry is validated
 *   on its own: an entry with a bad manifest, a duplicate identifier, an API version the editor
 *   does not support or an `activate` that throws is reported and skipped, and the others still
 *   load. Every report has `fatal: false` (the `de-error` event, 05 §8.1).
 * - An extension is identified by `manifest.id`. Setting the array again keeps an extension that
 *   is still listed with the same `activate` function, so its contributions do not flicker. An
 *   extension that is no longer listed, or whose `activate` changed, is deactivated first, and
 *   everything it tracked is disposed in reverse order.
 * - Contributions are registered through the API that `createApi` builds for each extension. Each
 *   disposer the extension hands to `track` runs when the extension is removed, so a removal leaves
 *   no contribution behind (criterion 3).
 * - Tier 1 extensions run in the page with the host's trust (13 §7.2). Errors are isolated only as
 *   far as activation and removal go: a handler that throws later is the contribution's concern
 *   and is reported by the caller that dispatches it (ADR 0136).
 * - The supported API versions are a required option. The spec gives no version list, and UX-049
 *   (the API spike) is not decided. The host passes what it supports (ADR 0136, proposed).
 */

/** The fields of a manifest the editor reads. The spec gives no other field (UX-049 is open). */
export interface ExtensionManifest {
  /** Lower-case identifier, unique among the extensions the host sets. */
  readonly id: string;
  /** The name shown to people, trimmed and not empty. */
  readonly name: string;
  /** The API version the extension was written for, as a string. */
  readonly apiVersion: string;
}

export type ExtensionReason =
  | 'invalid-manifest'
  | 'duplicate-id'
  | 'unsupported-api-version'
  | 'activation-failed'
  | 'removal-failed'
  | 'handler-failed';

export interface ExtensionReport {
  /** The manifest identifier when it is valid, else the position in the array (`#1`, `#2`...). */
  readonly extension: string;
  readonly reason: ExtensionReason;
  readonly message: string;
  /** Always false: an extension problem never stops the editor. */
  readonly fatal: false;
}

export interface ExtensionHostOptions<A> {
  /** The API versions this editor supports, for example `['1']`. Required; no default. */
  readonly apiVersions: readonly string[];
  /**
   * Builds the API one extension receives. `track` keeps a disposer that runs when the extension is
   * removed. The API must not expose the editor's internal state (13 §7.1).
   */
  readonly createApi: (id: string, track: (dispose: () => void) => void) => A;
  /** Receives each problem. A throw from here is ignored: reporting never stops the host. */
  readonly onError: (report: ExtensionReport) => void;
}

/** An entry as the host passes it: the manifest and the activation are checked at run time. */
export interface ExtensionEntry<A> {
  readonly manifest: unknown;
  readonly activate: (api: A) => void;
}

const ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const ID_LIMIT = 64;

/**
 * Checks one entry without running it. The reason is a message for the report, not a key; the
 * labels of reports are the caller's to translate.
 */
export function checkManifest(
  raw: unknown,
  position: number,
):
  | {
      readonly ok: true;
      readonly manifest: ExtensionManifest;
    }
  | { readonly ok: false; readonly label: string; readonly message: string } {
  const label = `#${position}`;
  if (typeof raw !== 'object' || raw === null)
    return { ok: false, label, message: 'the manifest is missing' };
  const m = raw as Record<string, unknown>;
  const id = m['id'];
  if (typeof id !== 'string' || id.length > ID_LIMIT || !ID_PATTERN.test(id))
    return {
      ok: false,
      label,
      message: 'the identifier must be lower case and at most 64 characters',
    };
  const named = typeof m['name'] === 'string' ? m['name'].trim() : '';
  if (named.length === 0) return { ok: false, label: id, message: 'the name is empty' };
  const apiVersion = m['apiVersion'];
  if (typeof apiVersion !== 'string' || apiVersion.trim().length === 0)
    return { ok: false, label: id, message: 'the API version is missing' };
  return { ok: true, manifest: { id, name: named, apiVersion: apiVersion.trim() } };
}

interface Active<A> {
  readonly activate: (api: A) => void;
  readonly disposers: Array<() => void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ExtensionHost<A> {
  readonly #options: ExtensionHostOptions<A>;
  readonly #active = new Map<string, Active<A>>();

  constructor(options: ExtensionHostOptions<A>) {
    this.#options = options;
  }

  /** The identifiers of the extensions now active, in activation order. */
  active(): string[] {
    return [...this.#active.keys()];
  }

  /** Brings the active set in line with `entries`. Never throws. */
  sync(entries: readonly unknown[]): void {
    const wanted = new Map<string, ExtensionEntry<A> & { readonly manifest: ExtensionManifest }>();
    entries.forEach((raw, index) => {
      const entry = raw as Partial<ExtensionEntry<A>> | null | undefined;
      const checked = checkManifest(entry?.manifest, index + 1);
      if (!checked.ok) return this.#report(checked.label, 'invalid-manifest', checked.message);
      const { manifest } = checked;
      if (typeof entry?.activate !== 'function')
        return this.#report(manifest.id, 'invalid-manifest', 'the activate function is missing');
      if (wanted.has(manifest.id))
        return this.#report(manifest.id, 'duplicate-id', 'another extension has this identifier');
      if (!this.#options.apiVersions.includes(manifest.apiVersion))
        return this.#report(
          manifest.id,
          'unsupported-api-version',
          `API version ${manifest.apiVersion} is not supported`,
        );
      wanted.set(manifest.id, { manifest, activate: entry.activate as (api: A) => void });
    });

    for (const [id, active] of [...this.#active]) {
      const next = wanted.get(id);
      if (next && next.activate === active.activate) continue;
      this.#deactivate(id, active);
    }

    for (const [id, next] of wanted) {
      if (this.#active.has(id)) continue;
      this.#activate(id, next.activate);
    }
  }

  /** Deactivates every extension. The host calls this when the element is removed. */
  dispose(): void {
    for (const [id, active] of [...this.#active]) this.#deactivate(id, active);
  }

  #activate(id: string, activate: (api: A) => void): void {
    const disposers: Array<() => void> = [];
    const track = (dispose: () => void): void => {
      disposers.push(dispose);
    };
    try {
      const api = this.#options.createApi(id, track);
      activate(api);
      this.#active.set(id, { activate, disposers });
    } catch (error) {
      this.#runDisposers(id, disposers, 'activation-failed');
      this.#report(id, 'activation-failed', describe(error));
    }
  }

  #deactivate(id: string, active: Active<A>): void {
    this.#active.delete(id);
    this.#runDisposers(id, active.disposers, 'removal-failed');
  }

  #runDisposers(id: string, disposers: Array<() => void>, reason: ExtensionReason): void {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch (error) {
        this.#report(id, reason, describe(error));
      }
    }
  }

  #report(extension: string, reason: ExtensionReason, message: string): void {
    try {
      this.#options.onError({ extension, reason, message, fatal: false });
    } catch {
      // Reporting never stops the host (see ExtensionHostOptions.onError).
    }
  }
}
