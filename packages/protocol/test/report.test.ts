// The spike report lists every gap and decision of the definition, word for word (SPK-019: "gaps
// between the prose and the generated definitions are listed"), so the list handed to the spec
// cannot drift from the artifacts.
import { describe, expect, it } from 'vitest';
import { DECISIONS } from '../src/definition/decisions.ts';
import { GAPS } from '../src/definition/gaps.ts';
import { readText } from './support.ts';

const report = readText('docs/spikes/2026-11-06-s6-protocol.md');
const cell = (s: string) => s.replace(/\|/g, '\\|');

describe('the S6 report (docs/spikes/2026-11-06-s6-protocol.md)', () => {
  it('has a row for every gap, as the register words it, with its resolution', () => {
    for (const g of GAPS) {
      const seeAlso = g.seeAlso ? ` (${cell(g.seeAlso)})` : '';
      const resolved = g.resolved ? ` **Resolved:** ${cell(g.resolved)}` : '';
      const row = `| ${g.id} | ${cell(g.section)} | ${g.kind} | ${cell(g.text)}${seeAlso}${resolved} |`;
      expect(report.includes(row), g.id).toBe(true);
    }
    expect(report.match(/^\| G\d+ \|/gm)?.length).toBe(GAPS.length);
  });

  it('has a row for every decision, as the register words it, with its status', () => {
    for (const d of DECISIONS) {
      const status = d.status
        ? ` **${d.status === 'confirmed' ? 'Confirmed' : 'Withdrawn'}:** ${cell(d.note ?? '')}`
        : '';
      expect(
        report.includes(`| ${d.id} | ${d.gaps.join(', ')} | ${cell(d.text)}${status} |`),
        d.id,
      ).toBe(true);
    }
    expect(report.match(/^\| D\d+ \|/gm)?.length).toBe(DECISIONS.length);
  });
});
