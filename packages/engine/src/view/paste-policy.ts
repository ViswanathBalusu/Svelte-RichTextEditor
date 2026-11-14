/**
 * Reads clipboard HTML into an inert document under Trusted Types (FE-054 criterion 5; 02 §3).
 *
 * `DOMParser.parseFromString` is a Trusted Types sink: under `require-trusted-types-for 'script'` a plain
 * string throws. The view therefore parses through, in order:
 * 1. no policy, where the page has no Trusted Types;
 * 2. the page's `default` policy, where the host has one (ProseMirror's own paste does the same);
 * 3. the project's named policy `docedit-paste`, created on the first paste of HTML.
 * If none of them works (the host allows neither a default policy nor the name), the parse returns
 * null and the paste falls back to the plain text, so a paste never throws in the handler.
 *
 * The named policy passes the markup through unchanged. That is safe only because its result goes
 * nowhere but `DOMParser`: the document it makes runs no script and loads nothing, and the whitelist in
 * ../clipboard-html.ts reads only text and an allowed link target from it. The policy object stays
 * private to this module and is never handed out, so no other code can use it for a live sink.
 */
import type { CdmFragment } from '../cdm-fragment.ts';
import { fragmentFromForeignDocument, picturesFromForeignDocument } from '../clipboard-html.ts';
import type { PastedImage } from '../image-paste.ts';

/** The Trusted Types policy name the paste of HTML needs (published in the integration guide). */
export const PASTE_POLICY_NAME = 'docedit-paste';

interface PolicyLike {
  createHTML(input: string): unknown;
}

interface TrustedTypesLike {
  readonly defaultPolicy?: PolicyLike | null;
  createPolicy(name: string, rules: { createHTML: (s: string) => string }): PolicyLike;
}

/** The named policy once created, or false when the page refused it. */
let pastePolicy: PolicyLike | false | undefined;

function trustedTypes(): TrustedTypesLike | null {
  return (globalThis as { trustedTypes?: TrustedTypesLike }).trustedTypes ?? null;
}

function parse(markup: unknown): Document {
  // A TrustedHTML value is accepted where a string is; the DOM types here know only strings.
  return new DOMParser().parseFromString(markup as string, 'text/html');
}

/**
 * The clipboard HTML as an inert document, or null when the page's policy allows no way to parse it.
 * Never throws.
 */
export function parseClipboardHtml(html: string): Document | null {
  const tt = trustedTypes();
  try {
    if (!tt) return parse(html);
    if (tt.defaultPolicy) return parse(tt.defaultPolicy.createHTML(html));
    if (pastePolicy === undefined) {
      try {
        pastePolicy = tt.createPolicy(PASTE_POLICY_NAME, { createHTML: (s) => s });
      } catch {
        pastePolicy = false;
      }
    }
    // Without the named policy, a plain string still parses where Trusted Types are not enforced.
    return parse(pastePolicy ? pastePolicy.createHTML(html) : html);
  } catch {
    return null;
  }
}

/**
 * The fragment that clipboard HTML holds as the whitelist reads it, or null when it holds no text or
 * could not be parsed (the paste then uses the plain text). Never throws.
 */
export function foreignFragment(html: string, cdm: number): CdmFragment | null {
  return foreignClipboard(html, cdm).fragment;
}

/**
 * The fragment and the `data:` URI pictures that clipboard HTML holds, read from one parse (FE-054).
 * The fragment is null when the HTML holds no text. Never throws.
 */
export function foreignClipboard(
  html: string,
  cdm: number,
): { readonly fragment: CdmFragment | null; readonly pictures: readonly PastedImage[] } {
  const none = { fragment: null, pictures: [] };
  if (html === '') return none;
  const doc = parseClipboardHtml(html);
  if (!doc) return none;
  try {
    return {
      fragment: fragmentFromForeignDocument(doc, cdm),
      pictures: picturesFromForeignDocument(doc),
    };
  } catch {
    return none;
  }
}
