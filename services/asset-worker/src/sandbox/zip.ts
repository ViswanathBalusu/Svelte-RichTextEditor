/**
 * ZIP archives, and Word files in particular (BE-043 criterion 4; SEC-038 criterion 3; 10 §3.5
 * decompression bombs; groundwork for EXP-099). The archive's directory is read and checked before
 * anything is expanded: the entry count (from the end record alone), every entry's declared sizes
 * and ratio, the total, names (no traversal, no duplicates), methods, encryption, overlapping data
 * (the overlapping-entry bomb), and a contiguous layout with nothing before, between or after the
 * entries (which also refuses ZIP polyglots). Then each entry is inflated without keeping its
 * output, stopping one byte past its declared size, and its length and CRC-32 must match: a
 * directory that lies about sizes cannot make the worker expand more than the limits allow.
 *
 * A Word file is kept unchanged (EXP-108, ADR 0017): it needs `[Content_Types].xml` and
 * `word/document.xml`, no macro parts, and no document type declaration in its content types.
 * Archives inside archives are never expanded; inside a Word file they are allowed only under
 * `word/embeddings/` (embedded objects are preserved opaquely, ADR 0017), anywhere else they fail.
 */
import { crc32 } from 'node:zlib';
import { AssetError } from './errors.ts';
import { scanInflate } from './inflate.ts';
import type { ContentLimits } from './limits.ts';
import type { Processed } from './output.ts';
import { DOCX } from './types.ts';

export interface ZipEntry {
  name: string;
  nameBytes: Uint8Array;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  dataStart: number;
  dataEnd: number;
}

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

const EOCD = 0x06054b50;
const CDH = 0x02014b50;
const LFH = 0x04034b50;
const DD = 0x08074b50;
const ZIP64_LOCATOR = 0x07064b50;

const ARCHIVE_NAME =
  /\.(zip|jar|war|apk|docx|docm|dotx|dotm|xlsx|xlsm|xlsb|pptx|pptm|odt|ods|odp|epub|7z|rar|gz|tgz|bz2|xz|zst|tar|cab|iso)$/i;
const EMBEDDINGS = /^word\/embeddings\//i;
const MACRO_PARTS = /^word\/vba(Project\.bin|Data\.xml)$/i;

/** Whether the first bytes of an entry are those of an archive or a compressed stream. */
export function archiveMagic(head: Uint8Array): boolean {
  const s = (sig: readonly number[]): boolean => sig.every((v, i) => head[i] === v);
  return (
    s([0x50, 0x4b, 0x03, 0x04]) ||
    s([0x50, 0x4b, 0x05, 0x06]) ||
    s([0x1f, 0x8b]) ||
    s([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) ||
    s([0x52, 0x61, 0x72, 0x21]) ||
    s([0x42, 0x5a, 0x68]) ||
    s([0xfd, 0x37, 0x7a, 0x58, 0x5a]) ||
    s([0x28, 0xb5, 0x2f, 0xfd]) ||
    s([0x4d, 0x53, 0x43, 0x46])
  );
}

/** A safe entry name: relative, forward slashes, no `.` or `..` segment, printable. */
function checkName(raw: Uint8Array, utf8: boolean): string {
  let name: string;
  try {
    name = utf8
      ? new TextDecoder('utf-8', { fatal: true }).decode(raw)
      : String.fromCharCode(...raw);
  } catch {
    throw new AssetError('unsafe_content', 'an archive entry name is not valid UTF-8');
  }
  if (!utf8 && /[^\x20-\x7e]/.test(name))
    throw new AssetError('unsafe_content', 'a non-ASCII archive entry name without the UTF-8 flag');
  if (name.length === 0 || name.length > 1024)
    throw new AssetError('unsafe_content', 'an archive entry name of the wrong length');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\:]/.test(name))
    throw new AssetError(
      'unsafe_content',
      'an archive entry name with a control character, backslash or colon',
    );
  if (name.startsWith('/'))
    throw new AssetError('unsafe_content', 'an absolute archive entry name');
  const segments = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..'))
    throw new AssetError('unsafe_content', 'an archive entry name that leaves its folder');
  return name;
}

/** Reads and checks the directory of a ZIP archive; nothing is expanded. */
export function readZipDirectory(b: Uint8Array, limits: ContentLimits): ZipEntry[] {
  if (b.length < 22) throw new AssetError('malformed', 'the archive is too short');
  // The end record carries no comment (Word writes none), so it is the last 22 bytes. A comment
  // would be a place for a payload after the archive; it is refused.
  const e = b.length - 22;
  if (u32(b, e) !== EOCD)
    throw new AssetError('unsafe_content', 'the archive does not end with its end record');
  if (u16(b, e + 20) !== 0) throw new AssetError('unsafe_content', 'an archive with a comment');
  if (e >= 20 && u32(b, e - 20) === ZIP64_LOCATOR)
    throw new AssetError('unsupported_content', 'ZIP64 archives are not supported');
  if (u16(b, e + 4) !== 0 || u16(b, e + 6) !== 0)
    throw new AssetError('unsupported_content', 'multi-volume archives are not supported');
  const count = u16(b, e + 10);
  if (u16(b, e + 8) !== count)
    throw new AssetError('malformed', 'the archive entry counts disagree');
  if (count === 0xffff)
    throw new AssetError('unsupported_content', 'ZIP64 archives are not supported');
  // The entry limit is checked on the end record alone, before the directory is read.
  if (count > limits.zipMaxEntries)
    throw new AssetError(
      'archive_limit',
      `${count} archive entries is beyond the limit of ${limits.zipMaxEntries}`,
    );
  if (count === 0) throw new AssetError('malformed', 'an empty archive');
  const cdSize = u32(b, e + 12);
  const cdOffset = u32(b, e + 16);
  if (cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new AssetError('unsupported_content', 'ZIP64 archives are not supported');
  if (cdOffset + cdSize !== e)
    throw new AssetError('malformed', 'the archive directory does not end at the end record');
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  let o = cdOffset;
  for (let i = 0; i < count; i++) {
    if (o + 46 > e || u32(b, o) !== CDH)
      throw new AssetError('malformed', 'a damaged archive directory');
    const flags = u16(b, o + 8);
    const method = u16(b, o + 10);
    const crc = u32(b, o + 16);
    const compressedSize = u32(b, o + 20);
    const size = u32(b, o + 24);
    const nameLen = u16(b, o + 28);
    const extraLen = u16(b, o + 30);
    const commentLen = u16(b, o + 32);
    const disk = u16(b, o + 34);
    const localOffset = u32(b, o + 42);
    const next = o + 46 + nameLen + extraLen + commentLen;
    if (next > e) throw new AssetError('malformed', 'a damaged archive directory');
    if (flags & 0x41) throw new AssetError('unsafe_content', 'an encrypted archive entry');
    if (method !== 0 && method !== 8)
      throw new AssetError(
        'unsupported_content',
        `the archive compression method ${method} is not supported`,
      );
    if (disk !== 0)
      throw new AssetError('unsupported_content', 'multi-volume archives are not supported');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff)
      throw new AssetError('unsupported_content', 'ZIP64 archives are not supported');
    const nameBytes = b.subarray(o + 46, o + 46 + nameLen);
    const name = checkName(nameBytes, (flags & 0x800) !== 0);
    const key = name.toLowerCase();
    if (names.has(key))
      throw new AssetError('unsafe_content', 'two archive entries with the same name');
    names.add(key);
    if (method === 0 && compressedSize !== size)
      throw new AssetError('malformed', 'a stored archive entry whose sizes differ');
    if (size > limits.zipMaxEntryBytes)
      throw new AssetError(
        'archive_limit',
        `an archive entry of ${size} bytes is beyond the limit of ${limits.zipMaxEntryBytes}`,
      );
    if (size > limits.zipRatioFloorBytes && size > compressedSize * limits.zipMaxRatio)
      throw new AssetError(
        'archive_limit',
        `an archive entry is compressed more than ${limits.zipMaxRatio} to 1`,
      );
    total += size;
    if (total > limits.zipMaxTotalBytes)
      throw new AssetError(
        'archive_limit',
        `the archive expands to more than ${limits.zipMaxTotalBytes} bytes`,
      );
    entries.push({
      name,
      nameBytes,
      method,
      flags,
      crc,
      compressedSize,
      size,
      localOffset,
      dataStart: 0,
      dataEnd: 0,
    });
    o = next;
  }
  if (o !== e)
    throw new AssetError('malformed', 'bytes between the archive directory and its end record');
  // Each local header matches its directory entry, and the entries lie end to end from byte 0.
  const byOffset = [...entries].sort((a, c) => a.localOffset - c.localOffset);
  let expected = 0;
  for (const en of byOffset) {
    if (en.localOffset < expected) throw new AssetError('archive_limit', 'archive entries overlap');
    if (en.localOffset > expected)
      throw new AssetError('unsafe_content', 'bytes before or between archive entries');
    const lo = en.localOffset;
    if (lo + 30 > cdOffset || u32(b, lo) !== LFH)
      throw new AssetError('malformed', 'a damaged archive entry header');
    const lNameLen = u16(b, lo + 26);
    const lExtraLen = u16(b, lo + 28);
    if (u16(b, lo + 8) !== en.method)
      throw new AssetError('malformed', 'an archive entry header disagrees with the directory');
    const lName = b.subarray(lo + 30, lo + 30 + lNameLen);
    if (lName.length !== en.nameBytes.length || !lName.every((v, i) => v === en.nameBytes[i]))
      throw new AssetError(
        'unsafe_content',
        'an archive entry header names another file than the directory',
      );
    en.dataStart = lo + 30 + lNameLen + lExtraLen;
    en.dataEnd = en.dataStart + en.compressedSize;
    if (en.dataEnd > cdOffset)
      throw new AssetError('malformed', 'an archive entry runs into the directory');
    expected = en.dataEnd;
    // A data descriptor follows: 12 bytes, or 16 with its optional signature.
    if (en.flags & 0x08) expected += expected + 4 <= cdOffset && u32(b, expected) === DD ? 16 : 12;
  }
  if (expected !== cdOffset)
    throw new AssetError(
      'unsafe_content',
      'bytes between the last archive entry and the directory',
    );
  return entries;
}

/**
 * Expands every entry without keeping it, checking its size and CRC-32. Returns the first bytes
 * of each entry: `head(e)` of them (at least 8, for the archive check).
 */
export async function verifyZip(
  b: Uint8Array,
  entries: readonly ZipEntry[],
  head: (e: ZipEntry) => number,
): Promise<Map<ZipEntry, Uint8Array>> {
  const heads = new Map<ZipEntry, Uint8Array>();
  for (const en of entries) {
    const data = b.subarray(en.dataStart, en.dataEnd);
    const want = Math.max(8, head(en));
    if (en.method === 0) {
      if (crc32(data) !== en.crc)
        throw new AssetError('malformed', 'an archive entry fails its CRC');
      heads.set(en, data.subarray(0, want));
      continue;
    }
    const scan = await scanInflate(data, { raw: true, cap: en.size, crc: true, head: want });
    if (scan.over)
      throw new AssetError(
        'archive_limit',
        'an archive entry expands to more than its directory says',
      );
    if (!scan.complete || scan.length !== en.size)
      throw new AssetError('malformed', 'an archive entry does not expand to its declared size');
    if (scan.crc !== en.crc) throw new AssetError('malformed', 'an archive entry fails its CRC');
    heads.set(en, scan.head);
  }
  return heads;
}

const TYPES_MAX = 1024 * 1024;

/** Checks a Word file and keeps it unchanged as the asset. */
export async function processDocx(b: Uint8Array, limits: ContentLimits): Promise<Processed> {
  const entries = readZipDirectory(b, limits);
  const find = (n: string): ZipEntry | undefined => entries.find((e) => e.name.toLowerCase() === n);
  const types = find('[content_types].xml');
  if (!types || !find('word/document.xml'))
    throw new AssetError('type_mismatch', 'the archive is not a Word document');
  if (types.size > TYPES_MAX)
    throw new AssetError('archive_limit', 'the content types part is larger than 1 MiB');
  for (const e of entries) {
    if (MACRO_PARTS.test(e.name))
      throw new AssetError('unsafe_content', 'a macro-enabled Word file');
    if (ARCHIVE_NAME.test(e.name) && !EMBEDDINGS.test(e.name))
      throw new AssetError(
        'nested_archive',
        'an archive inside the Word file outside word/embeddings/',
      );
  }
  const heads = await verifyZip(b, entries, (e) => (e === types ? types.size : 8));
  for (const e of entries)
    if (!EMBEDDINGS.test(e.name) && archiveMagic(heads.get(e)!))
      throw new AssetError(
        'nested_archive',
        'an archive inside the Word file outside word/embeddings/',
      );
  const typesXml = new TextDecoder('utf-8').decode(heads.get(types)!);
  if (/<!DOCTYPE|<!ENTITY/i.test(typesXml))
    throw new AssetError('unsafe_content', 'a document type declaration in the Word file');
  if (/macroEnabled/i.test(typesXml))
    throw new AssetError('unsafe_content', 'a macro-enabled Word file');
  return { detected: DOCX, keepOriginal: true, outputs: [], notes: [`entries:${entries.length}`] };
}
