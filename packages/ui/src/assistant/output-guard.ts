/**
 * What the assistant's output may insert (UX-048 criteria 2 to 5; 13 §6.2; 10 §3.1).
 *
 * `guardOutput` turns the model's text into segments that the editor may insert. It creates no side
 * effect: a link is not followed, an image is not loaded, and no action is run. Criterion 2 (side
 * effects wait for the user's approval) is the caller's, once an action queue exists (not built).
 *
 * - A link passes only when its target appears among the links of the source text and its scheme is
 *   `http`, `https` or `mailto`, or it is an in-document reference (`#...`) that also appears in the
 *   source. Any other link is shown as plain text with a `link-blocked` notice.
 * - An image is inserted only when its source is the identifier of an asset already attached to the
 *   document. Any other image, including an address or a data URI, is dropped with an
 *   `image-blocked` notice.
 * - Everything else is text, kept exactly as the model wrote it. LaTeX control sequences and maths
 *   delimiters are text and create no node (the export treats them as escaped text, 13 §6.2).
 * - Links are recognised in two forms: `[label](target)` and a bare `http(s)://` or `mailto:` address.
 *   Trailing punctuation is not part of a bare address. Other markup is not interpreted (ADR 0136).
 */

export type OutputSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string }
  | { readonly kind: 'image'; readonly asset: string };

export interface GuardNotice {
  readonly code: 'link-blocked' | 'image-blocked';
  /** The target the model asked for, shown to the author. */
  readonly target: string;
}

export interface GuardOptions {
  /** The text the request was built from: the only place a link may come from. */
  readonly sourceText: string;
  /** Identifiers of the assets already attached to the document. */
  readonly attachedAssets: readonly string[];
}

export interface GuardResult {
  readonly segments: readonly OutputSegment[];
  readonly notices: readonly GuardNotice[];
}

const SCHEME = /^(?:https?:|mailto:)/i;
const TRAILING = /[.,;:!?)\]]+$/;

/**
 * One pattern for both link forms, so that scanning left to right never reads a bare address
 * inside a `[label](target)` link twice. Groups: 1 and 2 are an image's alt and source, 3 and 4 a
 * markdown link's label and target, 5 a bare address.
 */
const TOKEN =
  /!\[([^\]]*)\]\(([^)\s]*)\)|\[([^\]]*)\]\(([^)\s]*)\)|(https?:\/\/[^\s<>()]+|mailto:[^\s<>()]+)/gi;

interface Token {
  readonly start: number;
  readonly end: number;
  readonly image?: { readonly alt: string; readonly src: string };
  readonly link?: { readonly label: string; readonly href: string };
}

function tokens(text: string): Token[] {
  const found: Token[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    if (m[2] !== undefined) {
      found.push({ start, end: start + m[0].length, image: { alt: m[1] ?? '', src: m[2] } });
    } else if (m[4] !== undefined) {
      found.push({ start, end: start + m[0].length, link: { label: m[3] ?? '', href: m[4] } });
    } else if (m[5] !== undefined) {
      const href = m[5].replace(TRAILING, '');
      found.push({ start, end: start + href.length, link: { label: href, href } });
    }
  }
  return found;
}

/** The link targets that appear in a source text. */
function sourceLinks(text: string): Set<string> {
  const links = new Set<string>();
  for (const t of tokens(text)) if (t.link) links.add(t.link.href);
  return links;
}

function linkAllowed(href: string, inSource: Set<string>): boolean {
  if (!inSource.has(href)) return false;
  return SCHEME.test(href) || href.startsWith('#');
}

export function guardOutput(output: string, options: GuardOptions): GuardResult {
  const inSource = sourceLinks(options.sourceText);
  const assets = new Set(options.attachedAssets);
  const segments: OutputSegment[] = [];
  const notices: GuardNotice[] = [];
  let cursor = 0;

  const text = (value: string): void => {
    if (value.length === 0) return;
    const last = segments[segments.length - 1];
    if (last?.kind === 'text')
      segments[segments.length - 1] = { kind: 'text', text: last.text + value };
    else segments.push({ kind: 'text', text: value });
  };

  for (const t of tokens(output)) {
    text(output.slice(cursor, t.start));
    cursor = t.end;
    if (t.image) {
      if (assets.has(t.image.src)) segments.push({ kind: 'image', asset: t.image.src });
      else notices.push({ code: 'image-blocked', target: t.image.src });
    } else if (t.link) {
      if (linkAllowed(t.link.href, inSource)) {
        segments.push({ kind: 'link', text: t.link.label, href: t.link.href });
      } else {
        const shown =
          t.link.label === t.link.href || t.link.label.length === 0
            ? t.link.href
            : `${t.link.label} (${t.link.href})`;
        text(shown);
        notices.push({ code: 'link-blocked', target: t.link.href });
      }
    }
  }
  text(output.slice(cursor));
  return { segments, notices };
}
