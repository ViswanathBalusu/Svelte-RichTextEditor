/**
 * The ZIP container of a DOCX package (ECMA-376 Part 2 and the PKWARE APPNOTE, the subset Office
 * writes): stored and deflated entries, data descriptors on read, no encryption, no Zip64.
 *
 * Unchanged entries are copied raw: their compressed bytes, CRC and sizes go into the new archive
 * untouched, so an unedited part is byte-identical without being decompressed and compressed again
 * (ADR 0017, R0). Only DEFLATE itself is borrowed (fflate, MIT); the container code is small enough
 * to own, and owning it keeps the package free of streams, Blob and workers (FND-004).
 */
import { Inflate, deflateSync } from 'fflate';
import { utf8 } from '@docedit/model';
import { decodeUtf8 } from './utf8.ts';

export class ZipError extends Error {
  override name = 'ZipError';
}

/** Limits checked before any entry is expanded (EXP-099). The values are prototype defaults. */
export interface ZipLimits {
  maxEntries: number;
  /** Sum of the declared uncompressed sizes. */
  maxTotalSize: number;
  /** Declared uncompressed size divided by compressed size, per entry. */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxTotalSize: 512 * 1024 * 1024,
  maxRatio: 1_000,
};

export interface ZipEntry {
  name: string;
  nameBytes: Uint8Array;
  versionMadeBy: number;
  versionNeeded: number;
  flags: number;
  method: number;
  modTime: number;
  modDate: number;
  crc32: number;
  compressedSize: number;
  size: number;
  internalAttrs: number;
  externalAttrs: number;
  /** Extra field of the local header, kept for raw copies. */
  localExtra: Uint8Array;
  comment: Uint8Array;
  /** Offset of the compressed data in the archive. */
  dataOffset: number;
}

export interface ZipArchive {
  bytes: Uint8Array;
  entries: ZipEntry[];
  byName: Map<string, ZipEntry>;
  comment: Uint8Array;
}

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

let crcTable: Uint32Array | undefined;

/** CRC-32 (ISO 3309), as ZIP uses it. */
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * True when an entry name would leave the package: an absolute name, a drive letter, a backslash, or a
 * `..` segment (SEC-039 criterion 6). The importer reads only the parts it knows, so such a name is
 * refused with the file rather than ignored.
 */
export function escapesPackage(name: string): boolean {
  if (name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)) return true;
  return name.split('/').some((segment) => segment === '..');
}

/** Reads the central directory. Nothing is decompressed here. */
export function readZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipArchive {
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not a ZIP archive: no end of central directory record');
  const count = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  const commentLength = u16(bytes, eocd + 20);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff)
    throw new ZipError('Zip64 archives are not supported');
  if (count > limits.maxEntries)
    throw new ZipError(`${count} entries, more than the limit of ${limits.maxEntries}`);
  if (cdOffset + cdSize > eocd) throw new ZipError('central directory runs past its end record');

  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  let total = 0;
  let off = cdOffset;
  for (let n = 0; n < count; n++) {
    if (off + 46 > bytes.length || u32(bytes, off) !== 0x02014b50)
      throw new ZipError(`central directory entry ${n} is damaged`);
    const flags = u16(bytes, off + 8);
    const method = u16(bytes, off + 10);
    const nameLength = u16(bytes, off + 28);
    const extraLength = u16(bytes, off + 30);
    const entryCommentLength = u16(bytes, off + 32);
    const localOffset = u32(bytes, off + 42);
    const nameBytes = bytes.slice(off + 46, off + 46 + nameLength);
    const name = decodeUtf8(nameBytes);
    const compressedSize = u32(bytes, off + 20);
    const size = u32(bytes, off + 24);
    if (escapesPackage(name)) throw new ZipError(`entry ${name} names a path outside the package`);
    if (flags & 1) throw new ZipError(`entry ${name} is encrypted`);
    if (method !== 0 && method !== 8)
      throw new ZipError(`entry ${name} uses compression method ${method}`);
    if (byName.has(name)) throw new ZipError(`entry ${name} appears twice`);
    total += size;
    if (total > limits.maxTotalSize)
      throw new ZipError(`uncompressed size exceeds the limit of ${limits.maxTotalSize} bytes`);
    if (method === 8 && size > 1024 && size / Math.max(1, compressedSize) > limits.maxRatio)
      throw new ZipError(`entry ${name} has a compression ratio above ${limits.maxRatio}`);
    if (localOffset + 30 > bytes.length || u32(bytes, localOffset) !== 0x04034b50)
      throw new ZipError(`local header of ${name} is damaged`);
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > bytes.length)
      throw new ZipError(`data of ${name} runs past the end of the archive`);
    const entry: ZipEntry = {
      name,
      nameBytes,
      versionMadeBy: u16(bytes, off + 4),
      versionNeeded: u16(bytes, off + 6),
      flags,
      method,
      modTime: u16(bytes, off + 12),
      modDate: u16(bytes, off + 14),
      crc32: u32(bytes, off + 16),
      compressedSize,
      size,
      internalAttrs: u16(bytes, off + 36),
      externalAttrs: u32(bytes, off + 38),
      localExtra: bytes.slice(
        localOffset + 30 + localNameLength,
        localOffset + 30 + localNameLength + localExtraLength,
      ),
      comment: bytes.slice(
        off + 46 + nameLength + extraLength,
        off + 46 + nameLength + extraLength + entryCommentLength,
      ),
      dataOffset,
    };
    entries.push(entry);
    byName.set(name, entry);
    off += 46 + nameLength + extraLength + entryCommentLength;
  }
  return { bytes, entries, byName, comment: bytes.slice(eocd + 22, eocd + 22 + commentLength) };
}

/** The compressed bytes of an entry, as stored. */
export function rawData(zip: ZipArchive, entry: ZipEntry): Uint8Array {
  return zip.bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
}

/** Input is fed to the inflater in slices this long, so a lying header is caught early (EXP-099). */
const INFLATE_SLICE = 64 * 1024;

/**
 * Inflates a raw deflate entry in slices and stops as soon as the output passes the declared
 * size, so a header that lies about the size is refused before the entry is fully expanded.
 */
function inflateBounded(entry: ZipEntry, raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(entry.size);
  let written = 0;
  const inflater = new Inflate((chunk) => {
    if (written + chunk.length > entry.size)
      throw new ZipError(
        `entry ${entry.name} inflates to more than its declared ${entry.size} bytes`,
      );
    out.set(chunk, written);
    written += chunk.length;
  });
  try {
    if (raw.length === 0) inflater.push(raw, true);
    for (let off = 0; off < raw.length; off += INFLATE_SLICE) {
      const end = Math.min(raw.length, off + INFLATE_SLICE);
      inflater.push(raw.subarray(off, end), end === raw.length);
    }
  } catch (e) {
    if (e instanceof ZipError) throw e;
    throw new ZipError(`entry ${entry.name} does not inflate: ${(e as Error).message}`);
  }
  return out.subarray(0, written);
}

/** The uncompressed bytes of an entry, checked against its declared size and CRC. */
export function entryData(zip: ZipArchive, entry: ZipEntry): Uint8Array {
  const raw = rawData(zip, entry);
  let data: Uint8Array;
  if (entry.method === 0) data = raw.slice();
  else data = inflateBounded(entry, raw);
  if (data.length !== entry.size)
    throw new ZipError(`entry ${entry.name} inflates to ${data.length} bytes, not ${entry.size}`);
  if (crc32(data) !== entry.crc32) throw new ZipError(`entry ${entry.name} fails its CRC check`);
  return data;
}

export function readEntry(zip: ZipArchive, name: string): Uint8Array | undefined {
  const e = zip.byName.get(name);
  return e ? entryData(zip, e) : undefined;
}

/** An entry for {@link writeZip}: either a raw copy of an existing entry or new data. */
export type ZipWriteEntry =
  | { name: string; copyOf: ZipEntry; from: ZipArchive }
  | { name: string; data: Uint8Array; like?: ZipEntry; store?: boolean };

/** DOS date of 1980-01-01, for new entries that replace nothing. */
const DOS_EPOCH_DATE = (0 << 9) | (1 << 5) | 1;

/**
 * Writes an archive. Raw copies keep the original compressed bytes, CRC, sizes, times and
 * attributes; their data-descriptor flag is cleared because the sizes go in the local header.
 */
export function writeZip(
  entries: ZipWriteEntry[],
  comment: Uint8Array = new Uint8Array(),
): Uint8Array {
  interface Prepared {
    nameBytes: Uint8Array;
    versionMadeBy: number;
    versionNeeded: number;
    flags: number;
    method: number;
    modTime: number;
    modDate: number;
    crc32: number;
    compressedSize: number;
    size: number;
    internalAttrs: number;
    externalAttrs: number;
    localExtra: Uint8Array;
    comment: Uint8Array;
    data: Uint8Array;
  }
  const prepared: Prepared[] = entries.map((e) => {
    if ('copyOf' in e) {
      const c = e.copyOf;
      return {
        nameBytes: e.name === c.name ? c.nameBytes : utf8(e.name),
        versionMadeBy: c.versionMadeBy,
        versionNeeded: c.versionNeeded,
        flags: c.flags & ~8,
        method: c.method,
        modTime: c.modTime,
        modDate: c.modDate,
        crc32: c.crc32,
        compressedSize: c.compressedSize,
        size: c.size,
        internalAttrs: c.internalAttrs,
        externalAttrs: c.externalAttrs,
        localExtra: c.localExtra,
        comment: c.comment,
        data: rawData(e.from, c),
      };
    }
    const like = e.like;
    const store = e.store === true;
    const compressed = store ? e.data : deflateSync(e.data, { level: 6 });
    const nameBytes = like ? like.nameBytes : utf8(e.name);
    const nonAscii = !like && nameBytes.some((b) => b > 0x7f);
    return {
      nameBytes,
      versionMadeBy: like?.versionMadeBy ?? 20,
      versionNeeded: 20,
      flags: (like ? like.flags & ~8 & ~1 : 0) | (nonAscii ? 0x800 : 0),
      method: store ? 0 : 8,
      modTime: like?.modTime ?? 0,
      modDate: like?.modDate ?? DOS_EPOCH_DATE,
      crc32: crc32(e.data),
      compressedSize: compressed.length,
      size: e.data.length,
      internalAttrs: like?.internalAttrs ?? 0,
      externalAttrs: like?.externalAttrs ?? 0,
      localExtra: new Uint8Array(),
      comment: new Uint8Array(),
      data: compressed,
    };
  });

  let total = 22 + comment.length;
  for (const p of prepared)
    total +=
      30 +
      p.nameBytes.length +
      p.localExtra.length +
      p.data.length +
      46 +
      p.nameBytes.length +
      p.comment.length;
  const out = new Uint8Array(total);
  let pos = 0;
  const w16 = (v: number): void => {
    out[pos++] = v & 0xff;
    out[pos++] = (v >>> 8) & 0xff;
  };
  const w32 = (v: number): void => {
    out[pos++] = v & 0xff;
    out[pos++] = (v >>> 8) & 0xff;
    out[pos++] = (v >>> 16) & 0xff;
    out[pos++] = (v >>> 24) & 0xff;
  };
  const wb = (b: Uint8Array): void => {
    out.set(b, pos);
    pos += b.length;
  };
  const offsets: number[] = [];
  for (const p of prepared) {
    offsets.push(pos);
    w32(0x04034b50);
    w16(p.versionNeeded);
    w16(p.flags);
    w16(p.method);
    w16(p.modTime);
    w16(p.modDate);
    w32(p.crc32);
    w32(p.compressedSize);
    w32(p.size);
    w16(p.nameBytes.length);
    w16(p.localExtra.length);
    wb(p.nameBytes);
    wb(p.localExtra);
    wb(p.data);
  }
  const cdStart = pos;
  prepared.forEach((p, i) => {
    w32(0x02014b50);
    w16(p.versionMadeBy);
    w16(p.versionNeeded);
    w16(p.flags);
    w16(p.method);
    w16(p.modTime);
    w16(p.modDate);
    w32(p.crc32);
    w32(p.compressedSize);
    w32(p.size);
    w16(p.nameBytes.length);
    w16(0);
    w16(p.comment.length);
    w16(0);
    w16(p.internalAttrs);
    w32(p.externalAttrs);
    w32(offsets[i]!);
    wb(p.nameBytes);
    wb(p.comment);
  });
  const cdSize = pos - cdStart;
  w32(0x06054b50);
  w16(0);
  w16(0);
  w16(prepared.length);
  w16(prepared.length);
  w32(cdSize);
  w32(cdStart);
  w16(comment.length);
  wb(comment);
  return out;
}
