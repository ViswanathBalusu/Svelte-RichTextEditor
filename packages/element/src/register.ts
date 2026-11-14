/**
 * Registration of the element (02 §2; FE-001). Importing the module registers `doc-editor` unless
 * the name is taken; the class is also exported, so a host can register it under another name or
 * in a scoped custom element registry.
 */
import { DocEditorElement } from './doc-editor.ts';
import { emit } from './events.ts';

export const DEFAULT_TAG = 'doc-editor';

interface Registry {
  define(name: string, constructor: CustomElementConstructor): void;
  get(name: string): CustomElementConstructor | undefined;
  getName?(constructor: CustomElementConstructor): string | null;
}

type Versioned = CustomElementConstructor & { version?: unknown; release?: unknown };

function describe(c: Versioned): string {
  const version = typeof c.version === 'string' ? c.version : 'unknown';
  const release = typeof c.release === 'string' ? c.release : 'unknown';
  return `embedding API ${version}, release ${release}`;
}

/** Whether `other` is this same element: this class, or one with the same API version and release. */
function isSame(other: Versioned): boolean {
  if (other === DocEditorElement) return true;
  let c: unknown = other;
  while (typeof c === 'function') {
    if (c === DocEditorElement) return true;
    c = Object.getPrototypeOf(c);
  }
  return other.version === DocEditorElement.version && other.release === DocEditorElement.release;
}

export type DefineResult = 'defined' | 'same' | 'other';

/** The page's global event target, or undefined where there is none (Node.js). An existence check. */
function globalEventTarget(): EventTarget | undefined {
  return 'dispatchEvent' in globalThis ? (globalThis as unknown as EventTarget) : undefined;
}

/** The page's registry, or undefined where there is no DOM (an existence check, no read). */
function globalRegistry(): Registry | undefined {
  return 'customElements' in globalThis ? customElements : undefined;
}

/**
 * Registers the element under `name` in `registry` (the global registry by default).
 *
 * - The name is free: the element is defined and `'defined'` returned.
 * - The name holds this element (this class, a subclass, or a class with the same embedding API
 *   version and release): nothing happens, `'same'`.
 * - The name holds anything else: one warning names both versions, the existing definition stays,
 *   `'other'`. The host then registers this version under another name.
 *
 * A registry accepts a constructor once; when the class already has a name in `registry`, a
 * subclass is defined instead, which behaves the same.
 */
export function defineDocEditor(
  name: string = DEFAULT_TAG,
  target?: Registry,
  events?: EventTarget,
): DefineResult {
  const registry = target ?? globalRegistry();
  if (!registry) return 'other';
  const existing = registry.get(name) as Versioned | undefined;
  if (existing) {
    if (isSame(existing)) return 'same';
    console.warn(
      `<${name}>: another version is already registered (${describe(existing)}); ` +
        `this module (${describe(DocEditorElement)}) left it in place. ` +
        `Register this version under another name with defineDocEditor('<name>').`,
    );
    // SEC-009 criterion 3: the collision is also reported as `de-error`. No element of this version
    // exists yet to carry the event, so it goes to the page's global event target. It is not fatal:
    // the other version keeps running and the host can register this one under another name.
    const message =
      `<${name}>: another version is already registered (${describe(existing)}); ` +
      `this module (${describe(DocEditorElement)}) left it in place.`;
    // Where the page has no event target (Node.js), there is nothing to report to.
    const sink = events ?? globalEventTarget();
    if (sink) emit(sink, 'de-error', { code: 'internal', message, fatal: false });
    return 'other';
  }
  const named = typeof registry.getName === 'function' ? registry.getName(DocEditorElement) : null;
  if (named === null) {
    try {
      registry.define(name, DocEditorElement);
      return 'defined';
    } catch (e) {
      // Without getName(), a second name for the class shows up here.
      if (!(e instanceof DOMException && e.name === 'NotSupportedError')) throw e;
    }
  }
  registry.define(name, class extends DocEditorElement {});
  return 'defined';
}
