/**
 * Parts of the editing core that load on first use (FND-008; 13 §9).
 *
 * The core's calls are synchronous (`editRole`, `sendChecklist`, the rule evaluation a view asks
 * for), so a part cannot be awaited where it is used. A part is therefore loaded before the code
 * that needs it can run:
 *
 * - the element loads the parts a document or a configuration needs before it mounts the editor
 *   (`partsFor`: a document with rules, a workflow port);
 * - a pane or dialog that edits roles, sources, fields or rules loads its part with the pane
 *   (`loadParts`, called by the service's `prepare`);
 * - a part a call reaches without being loaded is a defect: the call throws `PartNotLoadedError`
 *   and says which part. Nothing answers as if the part were empty, except the rule evaluation of a
 *   document whose rules arrived after it opened (field-rules.ts), which loads the part and tells the
 *   views when it is there.
 *
 * Tests that call these paths directly load the part first (`loadParts`).
 */

import type * as Authoring from './authoring.ts';
import type * as ExtensionPart from './extension-part.ts';
import type * as FormsPart from './forms-part.ts';
import type * as RulesPart from './rules-part.ts';

/** The names of the parts. */
export type PartName = 'authoring' | 'extension' | 'forms' | 'rules';

export class PartNotLoadedError extends Error {
  readonly part: PartName;
  constructor(part: PartName) {
    super(`the "${part}" part of the editing core is not loaded; load it first (loadParts)`);
    this.name = 'PartNotLoadedError';
    this.part = part;
  }
}

/** One lazily loaded module, loaded once. */
export class Part<T> {
  readonly name: PartName;
  readonly #loader: () => Promise<T>;
  #value: T | null = null;
  #pending: Promise<T> | null = null;

  constructor(name: PartName, loader: () => Promise<T>) {
    this.name = name;
    this.#loader = loader;
  }

  /** The module when it is loaded, else null. */
  peek(): T | null {
    return this.#value;
  }

  /** The module, which must be loaded: a call that cannot wait must have had it loaded first. */
  get(): T {
    if (this.#value === null) throw new PartNotLoadedError(this.name);
    return this.#value;
  }

  /** Loads the module (once). A failed load is tried again by the next call. */
  load(): Promise<T> {
    if (this.#value !== null) return Promise.resolve(this.#value);
    this.#pending ??= this.#loader().then(
      (value) => {
        this.#value = value;
        return value;
      },
      (error: unknown) => {
        this.#pending = null;
        throw error;
      },
    );
    return this.#pending;
  }
}

/**
 * The roles, sources and fields panes' changes (`authoring.ts`): grammar checks and the invariants
 * of the document's definitions.
 */
export const authoringPart = new Part<typeof Authoring>(
  'authoring',
  () => import('./authoring.ts'),
);

/** The document API of a host extension (xtension-part.ts). */
export const extensionPart = new Part<typeof ExtensionPart>(
  'extension',
  () => import('./extension-part.ts'),
);

/**
 * The entries a person types into form fields and the checks behind them (forms-part.ts). The web
 * view loads the drawing of the fields next to it (`loadFormViews` of view/web.ts).
 */
export const formsPart = new Part<typeof FormsPart>('forms', () => import('./forms-part.ts'));

/** The rules language: evaluation while filling, the rule builder, the pre-send checks. */
export const rulesPart = new Part<typeof RulesPart>('rules', () => import('./rules-part.ts'));

const PARTS: Readonly<Record<PartName, Part<unknown>>> = {
  authoring: authoringPart,
  extension: extensionPart,
  forms: formsPart,
  rules: rulesPart,
};

/** Loads the parts named; resolves when every one is there. */
export async function loadParts(names: readonly PartName[]): Promise<void> {
  await Promise.all(names.map((name) => PARTS[name].load()));
}

/** Whether `name` is the name of a part. */
export function isPartName(name: string): name is PartName {
  return Object.hasOwn(PARTS, name);
}

/** What `partsFor` reads of a document. */
export interface PartsInput {
  /** The document as JSON (`{ type: 'doc', content: [definitions, body, ...] }`). */
  readonly doc?: unknown;
  /** Whether the host passes a workflow port (the send dialog's checks compile the rules). */
  readonly workflow?: boolean;
}

/**
 * The parts a document and a configuration need from the first moment: the rules part for a
 * document that holds a `rule_def` in its definitions, and for a host that has a workflow; the
 * forms part for a document that holds a form field or a field of the document's own (a mirror,
 * a number or a reference), and for a host that has a workflow. The element loads these before it
 * mounts the editor, so that nothing a person sees is drawn without them. The rules are read from
 * the first child of the root, where the definitions are; the fields from the whole document, once.
 */
export function partsFor(input: PartsInput): PartName[] {
  const out: PartName[] = [];
  const doc = input.doc as { content?: unknown } | null | undefined;
  const first = Array.isArray(doc?.content)
    ? (doc.content[0] as { content?: unknown } | undefined)
    : undefined;
  const defs: unknown[] = Array.isArray(first?.content) ? first.content : [];
  // The entries and the drawing of form fields, and of the mirrors and computed fields beside them.
  if (input.workflow === true || holdsField(doc)) out.push('forms');
  if (
    input.workflow === true ||
    defs.some((d) => (d as { type?: unknown } | null)?.type === 'rule_def')
  )
    out.push('rules');
  return out;
}

/** Whether a node of the document as JSON is a `form_field` or a `field`, or holds one. */
function holdsField(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop() as { type?: unknown; content?: unknown } | null | undefined;
    if (node === null || typeof node !== 'object') continue;
    if (node.type === 'form_field' || node.type === 'field') return true;
    if (Array.isArray(node.content)) pending.push(...(node.content as unknown[]));
  }
  return false;
}
