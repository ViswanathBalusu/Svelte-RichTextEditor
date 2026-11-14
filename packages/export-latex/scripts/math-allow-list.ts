/**
 * Generates src/math/allow-list.ts from src/math/candidates.ts (09 §6.3; EXP-049): a candidate is
 * kept when KaTeX parses its sample in strict mode, so the list is the intersection of what the
 * class's math setup provides (the candidates) and what KaTeX supports. The file records the
 * KaTeX version and a fingerprint of its content; `math-gate.test.ts` fails when the file differs
 * from what this script computes.
 *
 *   node packages/export-latex/scripts/math-allow-list.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { renderAllowList } from '../src/math/allow-list-source.ts';

const target = fileURLToPath(new URL('../src/math/allow-list.ts', import.meta.url));
const config = (await prettier.resolveConfig(target)) ?? {};
const text = await prettier.format(await renderAllowList(), { ...config, filepath: target });
writeFileSync(target, text);
console.log(`wrote ${target}`);
