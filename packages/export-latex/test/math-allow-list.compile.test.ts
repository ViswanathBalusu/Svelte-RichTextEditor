/**
 * EXP-049 criterion 5, the part that needs the TeX engine (Podman, export worker sandbox): every
 * entry of the generated math allow-list compiles under the class's math setup. One document holds
 * a paragraph with an inline equation for each allowed command, and a display equation for each
 * allowed environment. The converter runs the gate on each (so the gate must accept it, and no
 * `math_refused` diagnostic may appear), and the compile must finish with a PDF. Skipped when the
 * sandbox cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { ALLOW_LIST } from '../src/math/allow-list.ts';
import { CANDIDATES, environmentSample, sample, type Candidate } from '../src/math/candidates.ts';
import { doc, nid, para, type J } from './docs.ts';
import { convertAndCompile, firstError, keep, sandboxReady } from './harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

const candidateOf = (name: string): Candidate => {
  const c = CANDIDATES.find((x) => x.name === name);
  if (!c) throw new Error(`no candidate named ${name}`);
  return c;
};

describe.skipIf(!ready)(
  'EXP-049 criterion 5: every allow-list entry compiles under the class',
  () => {
    it('compiles one inline equation per allowed command and one display equation per allowed environment, with no refusal', async () => {
      const body: J[] = [];
      for (const name of Object.keys(ALLOW_LIST.commands)) {
        const latex = sample(candidateOf(name));
        body.push(
          para(`${name}: `, {}, [
            { type: 'equation', attrs: { latex } },
            { type: 'text', text: '.' },
          ]),
        );
      }
      for (const env of ALLOW_LIST.environments) {
        body.push({
          type: 'equation_block',
          attrs: { id: nid('env'), latex: environmentSample(env) },
        });
      }
      const c = await convertAndCompile(doc(body), {
        profile: 'preview',
        title: 'exp-049-allow-list',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      const refused = c.bundle.diagnostics.filter((d) => d.code === 'math_refused');
      expect(refused.map((d) => d.blockId)).toEqual([]);
      if (!c.compile.ok || !c.compile.pdf) {
        throw new Error(
          `the compile failed (${keep('exp-049-allow-list', c)}):\n${firstError(c.compile.log)}`,
        );
      }
      expect(c.compile.pdf.byteLength).toBeGreaterThan(1000);
    }, 900_000);
  },
);
