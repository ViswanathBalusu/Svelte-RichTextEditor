/**
 * EXP-097: mammoth on one file. Prints one JSON line: ok, time, peak resident memory, counts of
 * what the HTML holds, and the raw text. mammoth is not a dependency of the repository: it is
 * installed in a scratch directory named by EXP097_TOOLS (npm install mammoth@<version>).
 *
 * Options are the defaults, with one style map entry so that comments are written (they are
 * dropped otherwise).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const tools = process.env.EXP097_TOOLS;
if (!tools) throw new Error('set EXP097_TOOLS to the directory that holds node_modules/mammoth');
const mammoth = createRequire(join(tools, 'package.json'))('mammoth');
const file = process.argv[2];
const buffer = readFileSync(file);
const count = (s, re) => (s.match(re) ?? []).length;
const t0 = performance.now();
let line;
try {
  const html = await mammoth.convertToHtml(
    { buffer },
    { styleMap: ['comment-reference => sup'] },
  );
  const raw = await mammoth.extractRawText({ buffer });
  const h = html.value;
  line = {
    ok: true,
    ms: performance.now() - t0,
    peakMb: process.resourceUsage().maxRSS / 1024,
    counts: {
      tables: count(h, /<table[\s>]/g),
      images: count(h, /<img[\s>]/g),
      tracked: 0,
      comments: count(h, /<dt id="comment-/g),
      footnotes: count(h, /<li id="footnote-/g),
      hyperlinks: count(h, /<a href=/g),
    },
    messages: html.messages.length,
    // A linked picture is written as a data URI: the part of it that follows the type.
    imageData: [...h.matchAll(/<img[^>]*src="data:[^;]*;base64,([^"]{0,400})/g)].map((m) => m[1]),
    text: raw.value,
  };
} catch (e) {
  line = {
    ok: false,
    ms: performance.now() - t0,
    peakMb: process.resourceUsage().maxRSS / 1024,
    error: `${e.name}: ${e.message}`.slice(0, 200),
  };
}
console.log(JSON.stringify(line));
