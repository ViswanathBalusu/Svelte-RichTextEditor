/**
 * Compile diagnostics (09 §9.2; EXP-064, EXP-065; SEC-036 criterion 4).
 *
 * The compile log is worker output and therefore hostile: the text of a document can imitate log
 * lines. The parser here has hard bounds (bytes, lines, line length, entries, time), reads only
 * lines of fixed shapes that start at the beginning of a physical line, never treats the lines of
 * a box dump or a runaway argument as messages, and finds the block of an entry only from the line
 * number TeX reports, through `map.json`, never from anything the message says. Two settings make
 * that sound: `--file-line-error` (compile.sh), so that every error starts with `./main.tex:<n>:`,
 * and `max_print_line` set so high that TeX never wraps a line (sandbox.ts), so that document text,
 * which TeX prints only after other text on a line, never begins one.
 *
 * Entries are `{ severity, code, blockId, message }`. The message is the catalogue's sentence for
 * the code, optionally followed by a detail cut to plain characters: no markup can pass.
 */
import type { Diagnostic, SourceMap } from '@docedit/export-latex';

export type Severity = Diagnostic['severity'];

/** The catalogue of codes the worker reports (EXP-065 criterion 4). Stable: codes never change. */
export const CODES = {
  tex_error: { severity: 'error', message: 'The typesetter stopped with an error.' },
  tex_undefined: { severity: 'error', message: 'The typesetter met a command it does not know.' },
  tex_fatal: { severity: 'error', message: 'The compile stopped and produced no PDF.' },
  latex_error: { severity: 'error', message: 'LaTeX reported an error.' },
  class_error: { severity: 'error', message: 'The house class refused part of the document.' },
  package_error: { severity: 'error', message: 'A package of the house class reported an error.' },
  missing_glyph: { severity: 'error', message: 'No font of the document has this character.' },
  font_file_missing: {
    severity: 'error',
    message: 'A font of the manifest is not in the worker font directory.',
  },
  font_file_mismatch: {
    severity: 'error',
    message: 'A font file does not hash to the name the manifest gives it.',
  },
  overfull_line: { severity: 'warning', message: 'A line is wider than its column.' },
  references_changed: {
    severity: 'warning',
    message: 'Page references changed in the last pass; page numbers may be stale.',
  },
  undefined_reference: { severity: 'warning', message: 'A reference has no target.' },
  font_substituted: { severity: 'warning', message: 'A font shape was replaced by another.' },
  package_warning: { severity: 'info', message: 'A package of the house class gave a warning.' },
  log_truncated: {
    severity: 'warning',
    message: 'The output was truncated at a limit of the parser; later messages are not listed.',
  },
  limit_time: { severity: 'error', message: 'The compile passed its time limit.' },
  limit_memory: { severity: 'error', message: 'The compile passed its memory limit.' },
  limit_output: { severity: 'error', message: 'The compile passed its output size limit.' },
  limit_pages: { severity: 'error', message: 'The document passed the page limit.' },
  limit_workdir: { severity: 'error', message: 'The compile filled its working directory.' },
  limit_processes: { severity: 'error', message: 'The compile passed its process limit.' },
  layout_invalid: {
    severity: 'warning',
    message: 'The layout report was invalid and is not used.',
  },
  references_not_converged: {
    severity: 'warning',
    message: 'Page references did not settle within the pass limit; page numbers may be wrong.',
  },
  preview_one_pass: {
    severity: 'info',
    message:
      'A preview runs one pass: page numbers in the table of contents and in references may be stale.',
  },
  pdf_standard_substituted: {
    severity: 'warning',
    message: 'The PDF declares PDF/A-4f instead of PDF/A-4, because tagged PDF embeds files.',
  },
  option_ignored: {
    severity: 'info',
    message: 'An export option this worker does not know was ignored.',
  },
  option_unsupported: { severity: 'error', message: 'An export option is not supported yet.' },
  option_invalid: {
    severity: 'error',
    message: 'An export option has a value outside its schema.',
  },
  suggestions_unsupported: {
    severity: 'error',
    message: 'Documents with unresolved suggestions cannot be exported yet.',
  },
  view_unsupported: {
    severity: 'error',
    message: 'Exports of a view with hidden regions or values are not available yet.',
  },
  bundle_refused: {
    severity: 'error',
    message: 'The bundle did not come from the converter and was not compiled.',
  },
} as const satisfies Record<string, { severity: Severity; message: string }>;

export type Code = keyof typeof CODES;

/** Characters a detail may keep: letters, digits, spaces and plain punctuation, no markup. */
const PLAIN = /[^\p{L}\p{N} .,:;()'+\-=/%_]/gu;

/** A detail as plain text: no markup characters, no control characters, at most 160 characters. */
export function plain(detail: string): string {
  return detail.normalize('NFC').replace(PLAIN, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** A diagnostic of the catalogue, with an optional plain detail. */
export function diagnostic(code: Code, blockId: string | null = null, detail?: string): Diagnostic {
  const c = CODES[code];
  const d = detail ? plain(detail) : '';
  return { severity: c.severity, code, blockId, message: d ? `${c.message} ${d}` : c.message };
}

export interface LogLimits {
  /** Bytes of the log read; the rest is not parsed (`log_truncated`). */
  maxBytes: number;
  /** Lines read. */
  maxLines: number;
  /** Characters of one line that are looked at; longer lines are cut before matching. */
  maxLineChars: number;
  /** Entries returned, not counting the final `log_truncated`. */
  maxEntries: number;
  /** Time spent parsing, ms. */
  maxMs: number;
}

/** Settings, not measurements (ADR 0045). */
export const LOG_LIMITS: LogLimits = {
  maxBytes: 16 * 1024 * 1024,
  maxLines: 500_000,
  maxLineChars: 2048,
  maxEntries: 200,
  maxMs: 2000,
};

export interface ParsedLog {
  entries: Diagnostic[];
  /** A limit of the parser was reached. */
  truncated: boolean;
  /** Size of the log as received, bytes. */
  bytes: number;
  /** Lines read. */
  lines: number;
}

/** The block of a line of main.tex, through map.json; null for the preamble and styles.tex. */
export function blockOfLine(map: SourceMap | null, line: number): string | null {
  if (!map || !Number.isSafeInteger(line) || line < 1) return null;
  const ranges = map.lines;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (line < r.from) hi = mid - 1;
    else if (line > r.to) lo = mid + 1;
    else return r.block === null ? null : (map.blocks[r.block] ?? null);
  }
  return null;
}

/** The block a block number of the class names, or null when the converter never issued it. */
function blockOfNumber(map: SourceMap | null, n: number): string | null {
  if (!map || !Number.isSafeInteger(n) || n < 1 || n >= map.blocks.length) return null;
  return map.blocks[n] ?? null;
}

const OVERFULL =
  /^(Over|Under)full \\[hv]box \((?:badness \d+|(\d{1,6}(?:\.\d{1,6})?)pt too (?:wide|high))\)(?: in paragraph at lines (\d{1,9})--\d{1,9}| in alignment at lines (\d{1,9})--\d{1,9}| detected at line (\d{1,9})| has occurred while \\output is active)/;
/**
 * An error in file-line form: `./main.tex:12: ...`, `./main.toc:1: ...`, or a package's own file
 * (`/usr/local/texlive/.../fontspec.sty:120: ...`). Only lines of main.tex map to blocks.
 */
const FILE_LINE = /^(\.\/[A-Za-z0-9_.-]{1,64}|\/[A-Za-z0-9_./-]{1,400}):(\d{1,9}): (.*)$/;
const MISSING = /^Missing character: There is no .{1,8} \(U\+([0-9A-F]{4,6})\)/u;
const CLASS_MISSING = /^docedit: missing U\+([0-9A-F]{4,6}) in block (\d{1,9})$/;
const RUNAWAY = /^Runaway (argument|definition|preamble|text)\?$/;

/**
 * Parses a compile log within `limits`. Never throws: anything it does not recognise is skipped.
 * `map` is the converter's map.json (trusted); null maps nothing.
 */
export function parseLog(
  input: string | Uint8Array,
  map: SourceMap | null,
  limits: LogLimits = LOG_LIMITS,
): ParsedLog {
  const started = performance.now();
  let truncated = false;
  let text: string;
  let bytes: number;
  if (typeof input === 'string') {
    bytes = Buffer.byteLength(input, 'utf8');
    text = input.length > limits.maxBytes ? input.slice(0, limits.maxBytes) : input;
    if (input.length > limits.maxBytes) truncated = true;
  } else {
    bytes = input.length;
    if (input.length > limits.maxBytes) truncated = true;
    text = new TextDecoder('utf-8', { fatal: false }).decode(
      input.length > limits.maxBytes ? input.subarray(0, limits.maxBytes) : input,
    );
  }
  const entries: Diagnostic[] = [];
  const seen = new Set<string>();
  let full = false;
  const add = (d: Diagnostic): void => {
    if (full) return;
    const key = `${d.code}\u0000${d.blockId ?? ''}\u0000${d.message}`;
    if (seen.has(key)) return;
    if (entries.length >= limits.maxEntries) {
      full = true;
      truncated = true;
      return;
    }
    seen.add(key);
    entries.push(d);
  };
  // Missing characters reported without a line wait for the next error line that has one.
  let unplaced: Diagnostic[] = [];
  let skipping: 'none' | 'box' | 'one' = 'none';
  let lines = 0;
  let pos = 0;
  while (pos < text.length && !full) {
    if (lines >= limits.maxLines) {
      truncated = true;
      break;
    }
    if (lines % 1024 === 0 && performance.now() - started > limits.maxMs) {
      truncated = true;
      break;
    }
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    let line = text.slice(pos, Math.min(end, pos + limits.maxLineChars));
    pos = end + 1;
    lines++;
    if (line.endsWith('\r')) line = line.slice(0, -1);

    if (skipping === 'one') {
      skipping = 'none';
      continue;
    }
    if (skipping === 'box') {
      // A box dump ends at the first empty line; everything in it may be document text.
      if (line.trim() === '') skipping = 'none';
      continue;
    }
    let m = OVERFULL.exec(line);
    if (m) {
      if (m[1] === 'Over') {
        const at = Number(m[3] ?? m[4] ?? m[5] ?? 0);
        add(diagnostic('overfull_line', blockOfLine(map, at), m[2] ? `${m[2]} pt too wide.` : ''));
      }
      skipping = 'box';
      continue;
    }
    if (RUNAWAY.test(line)) {
      // The next line is the runaway text itself.
      skipping = 'one';
      continue;
    }
    m = FILE_LINE.exec(line);
    if (m) {
      const block = m[1] === './main.tex' ? blockOfLine(map, Number(m[2])) : null;
      const msg = m[3]!;
      for (const u of unplaced) add({ ...u, blockId: u.blockId ?? block });
      unplaced = [];
      let mm: RegExpExecArray | null;
      if (/==> Fatal error occurred/.test(msg)) add(diagnostic('tex_fatal', block));
      else if (/^Undefined control sequence/.test(msg)) add(diagnostic('tex_undefined', block));
      else if ((mm = /^LaTeX Error: (.*)$/.exec(msg))) add(diagnostic('latex_error', block, mm[1]));
      else if ((mm = /^Class docedit Error: (.*)$/.exec(msg)))
        add(diagnostic('class_error', block, mm[1]));
      else if ((mm = /^Package ([A-Za-z0-9-]{1,40}) Error: (.*)$/.exec(msg)))
        add(diagnostic('package_error', block, `${mm[1]}: ${mm[2]}`));
      else if (/^docedit: page limit exceeded/.test(msg))
        add(diagnostic('limit_pages', null, plainNumber(msg)));
      else if ((mm = /^docedit: (.*)$/.exec(msg))) add(diagnostic('class_error', block, mm[1]));
      else if ((mm = MISSING.exec(msg))) add(diagnostic('missing_glyph', block, `U+${mm[1]}`));
      else add(diagnostic('tex_error', block, msg));
      continue;
    }
    if ((m = MISSING.exec(line))) {
      unplaced.push(diagnostic('missing_glyph', null, `U+${m[1]}`));
      if (unplaced.length > limits.maxEntries) {
        for (const u of unplaced) add(u);
        unplaced = [];
      }
      continue;
    }
    if ((m = CLASS_MISSING.exec(line))) {
      add(diagnostic('missing_glyph', blockOfNumber(map, Number(m[2])), `U+${m[1]}`));
      continue;
    }
    if (/^! /.test(line)) {
      if (/^! docedit: page limit exceeded/.test(line))
        add(diagnostic('limit_pages', null, plainNumber(line)));
      else add(diagnostic('tex_error', null, line.slice(2)));
      continue;
    }
    if (
      /^LaTeX Warning: (Label\(s\) may have changed|There were undefined references)/.test(line)
    ) {
      add(diagnostic('references_changed'));
      continue;
    }
    if (
      (m =
        /^LaTeX Warning: Reference `[^']{0,200}' on page \d+ undefined on input line (\d{1,9})/.exec(
          line,
        ))
    ) {
      add(diagnostic('undefined_reference', blockOfLine(map, Number(m[1]))));
      continue;
    }
    if (/^LaTeX Font Warning: /.test(line)) {
      add(diagnostic('font_substituted'));
      continue;
    }
    if (
      (m = /^Package ([A-Za-z0-9-]{1,40}) Warning: .*?(?:on input line (\d{1,9}))?\.?$/.exec(line))
    ) {
      add(diagnostic('package_warning', m[2] ? blockOfLine(map, Number(m[2])) : null, m[1]));
      continue;
    }
    if (/No space left on device/.test(line)) {
      add(diagnostic('limit_workdir'));
      continue;
    }
  }
  for (const u of unplaced) add(u);
  if (truncated) entries.push(diagnostic('log_truncated'));
  return { entries, truncated, bytes, lines };
}

function plainNumber(text: string): string {
  const n = /\((\d{1,6}) pages\)/.exec(text);
  return n ? `The limit is ${n[1]} pages.` : '';
}
