/**
 * EXP-097: runs each candidate on every file of the S11 corpus (78 real Word files) and of the
 * hostile set, one child process per file and candidate, and writes results.json.
 *
 * Truth for the structure counts is read from the raw XML of each file (counts of `w:tbl`,
 * `a:blip`, `w:ins` and `w:del`, `w:hyperlink` in document.xml, `w:comment` in comments.xml and the
 * normal `w:footnote` of footnotes.xml, with mc:Fallback branches removed). Text recall is the
 * share of the words of document.xml (`w:t`, not `w:delText`) that a candidate's text holds, as a
 * multiset.
 *
 * Run: node docs/spikes/exp-097/run-eval.mts --hostile <dir> --tools <dir> --python <python.exe> \
 *        --probe <Probe.dll> --marker <text> [--tools-old <dir>]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryData, readZip } from '../../../packages/export-docx/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const need = (name: string): string => {
  const v = arg(name);
  if (!v) throw new Error(`missing --${name}`);
  return v;
};
const hostileDir = resolve(need('hostile'));
const tools = resolve(need('tools'));
const toolsOld = arg('tools-old') ? resolve(arg('tools-old')!) : null;
const python = need('python');
const probe = resolve(need('probe'));
const marker = need('marker');
const TIMEOUT_MS = 120_000;

const CATEGORIES = ['tables', 'images', 'tracked', 'comments', 'footnotes', 'hyperlinks'] as const;
type Category = (typeof CATEGORIES)[number];
type Counts = Record<Category, number>;

interface Candidate {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}
const candidates: Candidate[] = [
  { id: 'own-importer', command: 'node', args: [join(here, 'runner-own.mts')] },
  {
    id: 'mammoth-1.13.0',
    command: 'node',
    args: [join(here, 'runner-mammoth.mjs')],
    env: { EXP097_TOOLS: tools },
  },
  { id: 'open-xml-sdk-3.5.1', command: 'dotnet', args: [probe] },
  { id: 'python-docx-1.2.0', command: python, args: ['-I', join(here, 'runner-python-docx.py')] },
];
if (toolsOld)
  candidates.push({
    id: 'mammoth-1.10.0',
    command: 'node',
    args: [join(here, 'runner-mammoth.mjs')],
    env: { EXP097_TOOLS: toolsOld },
  });

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function truthOf(path: string): { counts: Counts; text: string } | null {
  try {
    const zip = readZip(new Uint8Array(readFileSync(path)));
    const read = (name: string): string => {
      const e = zip.byName.get(name);
      return e ? new TextDecoder().decode(entryData(zip, e)) : '';
    };
    const doc = read('word/document.xml').replace(/<mc:Fallback[\s>][\s\S]*?<\/mc:Fallback>/g, '');
    const n = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
    const notes = read('word/footnotes.xml');
    const counts: Counts = {
      tables: n(doc, /<w:tbl[\s>]/g),
      images: n(doc, /<a:blip[\s>/]/g),
      tracked: new Set(doc.match(/<w:(?:ins|del) [^>]*w:id="[^"]*"/g)?.map((s) => s.replace(/^[^]*?w:id=/, ''))).size,
      comments: n(read('word/comments.xml'), /<w:comment[\s>]/g),
      footnotes: n(notes, /<w:footnote[\s>]/g) - n(notes, /<w:footnote [^>]*w:type=/g),
      hyperlinks: n(doc, /<w:hyperlink[\s>]/g),
    };
    const paragraphs = doc.split('</w:p>').map((chunk) => {
      let out = '';
      for (const m of chunk.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g))
        out += m[1] !== undefined ? decode(m[1]) : ' ';
      return out;
    });
    return { counts, text: paragraphs.join('\n') };
  } catch {
    return null;
  }
}

const words = (s: string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const w of s.toLowerCase().split(/\s+/))
    if (w) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
};
function recall(truth: string, got: string): { found: number; total: number } {
  const t = words(truth);
  const g = words(got);
  let found = 0;
  let total = 0;
  for (const [w, c] of t) {
    total += c;
    found += Math.min(c, g.get(w) ?? 0);
  }
  return { found, total };
}

interface Run {
  candidate: string;
  file: string;
  ok: boolean;
  ms?: number;
  wallMs: number;
  peakMb?: number;
  error?: string;
  timedOut?: boolean;
  counts?: Counts;
  recall?: { found: number; total: number };
  leaked?: boolean;
}

function runOne(c: Candidate, path: string, truth: ReturnType<typeof truthOf>): Run {
  const name = path.slice(path.lastIndexOf('corpus') >= 0 ? path.lastIndexOf('corpus') + 7 : 0);
  const t0 = performance.now();
  const r = spawnSync(c.command, [...c.args, path], {
    cwd: root,
    env: { ...process.env, ...c.env },
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
  });
  const wallMs = performance.now() - t0;
  const base = { candidate: c.id, file: name, wallMs };
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT')
    return { ...base, ok: false, timedOut: true, error: `no result in ${TIMEOUT_MS} ms` };
  const last = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(last) as Record<string, unknown>;
  } catch {
    return {
      ...base,
      ok: false,
      error: `process ended without a result (exit ${r.status}): ${(r.stderr ?? '').trim().slice(0, 160)}`,
    };
  }
  const out: Run = {
    ...base,
    ok: j['ok'] === true,
    ms: j['ms'] as number,
    peakMb: j['peakMb'] as number,
  };
  if (typeof j['error'] === 'string') out.error = j['error'];
  if (j['counts']) out.counts = j['counts'] as Counts;
  if (typeof j['text'] === 'string' && truth) out.recall = recall(truth.text, j['text']);
  const blob = JSON.stringify(j);
  out.leaked =
    blob.includes(marker) || blob.includes(Buffer.from(marker).toString('base64').slice(0, 16));
  return out;
}

const list = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return list(p);
      return f.endsWith('.docx') ? [p] : [];
    });

const corpusFiles = list(join(root, 'packages/export-docx/corpus'));
const hostileFiles = list(hostileDir);
const results: { corpus: Run[]; hostile: Run[]; truth: Record<string, Counts> } = {
  corpus: [],
  hostile: [],
  truth: {},
};
for (const f of corpusFiles) {
  const truth = truthOf(f);
  if (truth) results.truth[f.slice(f.lastIndexOf('corpus') + 7).replace(/\\/g, '/')] = truth.counts;
  for (const c of candidates) {
    const run = runOne(c, f, truth);
    run.file = run.file.replace(/\\/g, '/');
    results.corpus.push(run);
  }
  process.stderr.write('.');
}
for (const f of hostileFiles)
  for (const c of candidates) {
    const run = runOne(c, f, null);
    run.file = f.slice(f.lastIndexOf('\\') + 1).replace(/\.docx$/, '');
    results.hostile.push(run);
    process.stderr.write('h');
  }
writeFileSync(join(here, 'results.json'), JSON.stringify(results, null, 1));
console.log(`corpus runs ${results.corpus.length}, hostile runs ${results.hostile.length}`);
