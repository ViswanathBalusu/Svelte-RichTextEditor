/**
 * Source maps (version 3) of a built bundle: where they are and which original source a position
 * of the generated code comes from. Used to attribute bundled code to its package (SEC-051) and a
 * finding of the origin check to the package that wrote it (SEC-054).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SourceMap {
  version: number;
  sources: string[];
  sourceRoot?: string;
  mappings: string;
  sections?: unknown;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Map([...B64].map((c, i) => [c, i]));

/** One segment of a mapping: generated column, source index, original line, original column. */
export type Segment = [number, number, number, number];

/** Decodes the `mappings` string into segments per generated line (0-based). */
export function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let source = 0;
  let line = 0;
  let column = 0;
  for (const text of mappings.split(';')) {
    const segments: Segment[] = [];
    let generated = 0;
    for (const seg of text.split(',')) {
      if (!seg) continue;
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of seg) {
        const d = DIGIT.get(ch);
        if (d === undefined) throw new Error(`source map: invalid character "${ch}" in mappings`);
        value += (d & 31) * 2 ** shift;
        if (d & 32) shift += 5;
        else {
          const magnitude = Math.floor(value / 2);
          fields.push(value % 2 === 1 ? -magnitude : magnitude);
          value = 0;
          shift = 0;
        }
      }
      generated += fields[0] ?? 0;
      if (fields.length >= 4) {
        source += fields[1]!;
        line += fields[2]!;
        column += fields[3]!;
        segments.push([generated, source, line, column]);
      }
    }
    segments.sort((a, b) => a[0] - b[0]);
    lines.push(segments);
  }
  return lines;
}

/** The source index of the code at a generated position, or null where nothing is mapped. */
export function sourceAt(lines: readonly Segment[][], line: number, column: number): number | null {
  const segments = lines[line];
  if (!segments?.length) return null;
  let lo = 0;
  let hi = segments.length - 1;
  let found: Segment | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid]!;
    if (s[0] <= column) {
      found = s;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found ? found[1] : null;
}

export interface LoadedMap {
  /** The map file, or null for an inline map. */
  file: string | null;
  map: SourceMap;
  /** Each source as an absolute path. */
  paths: string[];
}

/** Finds the source map of a generated file: its `sourceMappingURL` comment, else `<file>.map`. */
export function loadSourceMap(generatedFile: string, text: string): LoadedMap | null {
  const comments = [...text.matchAll(/(?:\/\/|\/\*)[#@]\s*sourceMappingURL=([^\s*]+)/g)];
  const url = comments.at(-1)?.[1];
  let file: string | null = null;
  let raw: string | null = null;
  if (url?.startsWith('data:')) {
    const m = /^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/.exec(url);
    if (m) raw = m[1] ? Buffer.from(m[2]!, 'base64').toString('utf8') : decodeURIComponent(m[2]!);
  } else {
    const candidate = url
      ? join(dirname(generatedFile), decodeURIComponent(url))
      : `${generatedFile}.map`;
    if (existsSync(candidate)) {
      file = candidate;
      raw = readFileSync(candidate, 'utf8');
    }
  }
  if (raw === null) return null;
  const map = JSON.parse(raw) as SourceMap;
  if (map.version !== 3 || !Array.isArray(map.sources) || typeof map.mappings !== 'string')
    throw new Error(
      `${file ?? generatedFile}: not a version 3 source map with sources and mappings`,
    );
  if (map.sections)
    throw new Error(`${file ?? generatedFile}: index maps (sections) are not supported`);
  const base = join(dirname(file ?? generatedFile), map.sourceRoot ?? '');
  const paths = map.sources.map((s) => {
    const clean = s.replace(/[?#].*$/, '');
    return clean.startsWith('file:') ? fileURLToPath(clean) : resolve(base, clean);
  });
  return { file, map, paths };
}
