/**
 * Small building blocks of the direct DOCX writer (EXP-090): elements as escaped strings, text
 * that XML 1.0 can carry, the root namespace declarations every story part shares, and the
 * pixel size of a picture for pictures that come without one.
 */
import { NS } from './ooxml.ts';
import { escapeAttr, escapeText } from './xml.ts';

export type AttrValue = string | number | boolean | null | undefined;

/** An element: `<name a="v">children</name>`, or `<name a="v"/>` without children. Values are escaped; null and undefined attributes are left out. */
export function el(
  name: string,
  attrs: Record<string, AttrValue> = {},
  ...children: string[]
): string {
  let a = '';
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    // Attribute values get the XML 1.0 rule too (EXP-090, criterion 4): a style name is one of them.
    a += ` ${k}="${escapeAttr(xmlSafe(v === true ? '1' : String(v)).text)}"`;
  }
  const inner = children.join('');
  return inner ? `<${name}${a}>${inner}</${name}>` : `<${name}${a}/>`;
}

// XML 1.0 allows tab, line feed, carriage return and U+0020 to U+D7FF, U+E000 to U+FFFD and the
// supplementary planes; everything else (C0 controls, lone surrogates, U+FFFE, U+FFFF) is replaced.
const NOT_XML =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Text with every character XML 1.0 cannot carry replaced by U+FFFD, and whether any was. */
export function xmlSafe(s: string): { text: string; replaced: boolean } {
  NOT_XML.lastIndex = 0;
  if (!NOT_XML.test(s)) return { text: s, replaced: false };
  NOT_XML.lastIndex = 0;
  return { text: s.replace(NOT_XML, '�'), replaced: true };
}

/** A `w:t` (or `w:delText`, `w:instrText`) element, with `xml:space` where spaces would be lost. */
export function textElement(tag: string, text: string): string {
  const space = /^\s|\s$|\s\s/.test(text) ? ' xml:space="preserve"' : '';
  return `<${tag}${space}>${escapeText(xmlSafe(text).text)}</${tag}>`;
}

/** The namespaces every story part (document, headers, footers, footnotes) declares at its root. */
export const ROOT_NAMESPACES: ReadonlyArray<[string, string]> = [
  ['w', NS.w],
  ['r', NS.r],
  ['wp', NS.wp],
  ['a', NS.a],
  ['pic', NS.pic],
  ['v', NS.v],
  ['o', NS.o],
  ['w10', 'urn:schemas-microsoft-com:office:word'],
  ['w14', NS.w14],
  ['mc', NS.mc],
];

/** The root declarations as attributes, with the 2010 extensions marked ignorable. */
export const ROOT_DECLARATIONS = `${ROOT_NAMESPACES.map(([p, u]) => ` xmlns:${p}="${u}"`).join('')} mc:Ignorable="w14"`;

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/** The pixel size of a PNG, GIF, BMP or JPEG picture, or null for any other kind. */
export function pixelSize(bytes: Uint8Array): { width: number; height: number } | null {
  const u32 = (o: number): number =>
    ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0;
  const u16be = (o: number): number => (bytes[o]! << 8) | bytes[o + 1]!;
  const u16le = (o: number): number => bytes[o]! | (bytes[o + 1]! << 8);
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e)
    return { width: u32(16), height: u32(20) };
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return { width: u16le(6), height: u16le(8) };
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d)
    return { width: Math.abs(u32le(bytes, 18)), height: Math.abs(u32le(bytes, 22)) };
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) return null;
      const marker = bytes[o + 1]!;
      const len = u16be(o + 2);
      // Start-of-frame markers, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { width: u16be(o + 7), height: u16be(o + 5) };
      if (len < 2) return null;
      o += 2 + len;
    }
  }
  return null;
}

function u32le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24) | 0;
}

/** Twips for a pixel length at 96 dots per inch. */
export const pxToTwips = (px: number): number => Math.max(1, Math.min(31680, Math.round(px * 15)));
