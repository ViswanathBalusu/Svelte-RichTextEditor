/**
 * A strict, bounded XML parser for SVG uploads (BE-043 criterion 5; SEC-006 criterion 4; 10 §3.5
 * "document type declarations are rejected"). It accepts elements, attributes, text, comments,
 * processing instructions and CDATA; it refuses any document type declaration and any entity other
 * than the five predefined ones and character references, so neither external entities nor entity
 * expansion bombs can exist. Elements, depth, attributes and kept text are counted against limits.
 * Namespaces are resolved: elements outside the SVG namespace are dropped with their content, and
 * of prefixed attributes only `xlink:href` is kept (as `href`).
 */
import { AssetError } from './errors.ts';
import type { ContentLimits } from './limits.ts';

export const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export interface XmlElement {
  /** Local name, in the SVG namespace. */
  name: string;
  attrs: Map<string, string>;
  children: XmlElement[];
  /** Text content, kept only for `style` elements. */
  text: string;
}

export interface ParsedXml {
  root: XmlElement;
  /** Count of elements dropped because they were outside the SVG namespace. */
  foreign: number;
}

const NAME = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const MAX_ATTRS = 256;
const MAX_KEPT_TEXT = 1024 * 1024;

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&([^;&\s]{0,32});/g, (_m, ent: string) => {
    switch (ent) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
    }
    const m = /^#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}))$/.exec(ent);
    if (m) {
      const cp = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2]!, 10);
      if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
        throw new AssetError('malformed', 'a character reference out of range');
      return String.fromCodePoint(cp);
    }
    throw new AssetError('unsafe_content', 'an entity reference other than the predefined ones');
  });
}

interface Frame {
  el: XmlElement | null;
  qname: string;
  ns: Map<string, string>;
}

/** Parses SVG text; the root must be `svg` in the SVG namespace (or with no namespace declared). */
export function parseSvgXml(text: string, limits: ContentLimits): ParsedXml {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let elements = 0;
  let foreign = 0;
  let keptText = 0;
  let root: XmlElement | null = null;
  const stack: Frame[] = [];
  const fail = (msg: string): never => {
    throw new AssetError('malformed', msg);
  };
  const readName = (): string => {
    NAME.lastIndex = i;
    const m = NAME.exec(text);
    if (!m) fail('an XML name was expected');
    i += m![0].length;
    return m![0];
  };
  const skipSpace = (): void => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const chunk = lt < 0 ? text.slice(i) : text.slice(i, lt);
    if (chunk.length > 0) {
      if (stack.length === 0) {
        if (chunk.trim() !== '') fail('text outside the root element');
      } else {
        const top = stack[stack.length - 1]!;
        if (top.el && top.el.name === 'style') {
          keptText += chunk.length;
          if (keptText > MAX_KEPT_TEXT)
            throw new AssetError('drawing_limit', 'the style sheets are larger than 1 MiB');
          top.el.text += decodeEntities(chunk);
        } else decodeEntities(chunk); // validates entities even where text is not kept
      }
    }
    if (lt < 0) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) fail('a comment is not closed');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end < 0) fail('a CDATA section is not closed');
      const top = stack[stack.length - 1];
      if (!top) fail('CDATA outside the root element');
      if (top!.el && top!.el.name === 'style') {
        keptText += end - i;
        if (keptText > MAX_KEPT_TEXT)
          throw new AssetError('drawing_limit', 'the style sheets are larger than 1 MiB');
        top!.el.text += text.slice(i + 9, end);
      }
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', i))
      throw new AssetError('unsafe_content', 'a document type declaration');
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) fail('a processing instruction is not closed');
      i = end + 2;
      continue;
    }
    if (text.startsWith('</', i)) {
      i += 2;
      const qname = readName();
      skipSpace();
      if (text[i] !== '>') fail('a closing tag is not closed');
      i++;
      const top = stack.pop();
      if (!top || top.qname !== qname) fail('mismatched closing tag');
      if (stack.length === 0) {
        skipSpace();
        // Only comments, processing instructions and white space may follow the root.
        while (i < text.length) {
          if (text.startsWith('<!--', i)) {
            const end = text.indexOf('-->', i + 4);
            if (end < 0) fail('a comment is not closed');
            i = end + 3;
          } else if (text.startsWith('<?', i)) {
            const end = text.indexOf('?>', i + 2);
            if (end < 0) fail('a processing instruction is not closed');
            i = end + 2;
          } else if (/\s/.test(text[i]!)) i++;
          else fail('content after the root element');
        }
        return { root: root!, foreign };
      }
      continue;
    }
    // A start tag.
    if (stack.length === 0 && root) fail('a second root element');
    i++;
    const qname = readName();
    const rawAttrs: [string, string][] = [];
    for (;;) {
      const before = i;
      skipSpace();
      if (text.startsWith('/>', i) || text[i] === '>') break;
      if (i === before) fail('attributes must be separated by white space');
      const an = readName();
      skipSpace();
      if (text[i] !== '=') fail('an attribute without a value');
      i++;
      skipSpace();
      const q = text[i];
      if (q !== '"' && q !== "'") fail('an attribute value without quotes');
      const end = text.indexOf(q!, i + 1);
      if (end < 0) fail('an attribute value is not closed');
      const raw = text.slice(i + 1, end);
      if (raw.includes('<')) fail('a "<" in an attribute value');
      if (raw.length > limits.svgMaxBytes) fail('an attribute value is too long');
      i = end + 1;
      if (rawAttrs.some(([n]) => n === an)) fail('a repeated attribute');
      rawAttrs.push([an, decodeEntities(raw).replace(/[\t\n\r]/g, ' ')]);
      if (rawAttrs.length > MAX_ATTRS)
        throw new AssetError('drawing_limit', `more than ${MAX_ATTRS} attributes on an element`);
    }
    const selfClosing = text.startsWith('/>', i);
    i += selfClosing ? 2 : 1;
    if (++elements > limits.svgMaxElements)
      throw new AssetError('drawing_limit', `more than ${limits.svgMaxElements} elements`);
    if (stack.length + 1 > limits.svgMaxDepth)
      throw new AssetError('drawing_limit', `elements nested deeper than ${limits.svgMaxDepth}`);
    // Namespaces in scope.
    const parent = stack[stack.length - 1];
    const ns = new Map(parent?.ns ?? []);
    for (const [an, av] of rawAttrs) {
      if (an === 'xmlns') ns.set('', av);
      else if (an.startsWith('xmlns:')) ns.set(an.slice(6), av);
    }
    const colon = qname.indexOf(':');
    const prefix = colon < 0 ? '' : qname.slice(0, colon);
    const local = colon < 0 ? qname : qname.slice(colon + 1);
    const elNs = ns.get(prefix) ?? (prefix === '' ? SVG_NS : undefined);
    if (prefix !== '' && elNs === undefined)
      fail(`the prefix ${prefix.slice(0, 20)} is not declared`);
    const inSvg = elNs === SVG_NS && (!parent || parent.el !== null);
    let el: XmlElement | null = null;
    if (inSvg) {
      const attrs = new Map<string, string>();
      for (const [an, av] of rawAttrs) {
        if (an === 'xmlns' || an.startsWith('xmlns:')) continue;
        const c = an.indexOf(':');
        if (c < 0) {
          attrs.set(an, av);
          continue;
        }
        const ans = ns.get(an.slice(0, c));
        const al = an.slice(c + 1);
        if (an.slice(0, c) === 'xml') {
          if (ns.has('xml') && ns.get('xml') !== XML_NS) fail('the xml prefix is rebound');
          continue;
        }
        if (ans === undefined) fail(`the prefix ${an.slice(0, c).slice(0, 20)} is not declared`);
        if (ans === XLINK_NS && al === 'href') {
          if (!attrs.has('href')) attrs.set('href', av);
        } else if (ans === SVG_NS) attrs.set(al, av);
        // Attributes of other namespaces (editor metadata) are dropped.
      }
      el = { name: local, attrs, children: [], text: '' };
      if (parent?.el) parent.el.children.push(el);
      else if (!parent) {
        if (local !== 'svg') fail('the root element is not svg');
        root = el;
      }
    } else {
      if (!parent) fail('the root element is not in the SVG namespace');
      foreign++;
    }
    if (!selfClosing) stack.push({ el, qname, ns });
    else if (stack.length === 0) {
      skipSpace();
      if (i < text.length && text.slice(i).trim() !== '') {
        // Allow trailing comments and processing instructions only.
        const rest = text.slice(i).replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|\s+/g, '');
        if (rest !== '') fail('content after the root element');
      }
      return { root: root!, foreign };
    }
  }
  return fail('the root element is not closed');
}
