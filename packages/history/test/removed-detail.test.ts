// A comparison over a commit whose payload was removed (08 §13; HIS-040 criterion 2; HIS-032
// criterion 4): the comparison refuses with a fixed reason and never leaves the commit's changes out.
// A control commit with no steps is not a removed payload and still compares.
import type { LogCommit } from '@docedit/authority';
import { NOTHING_HIDDEN } from '@docedit/authority';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type CompareSource, compare, compareSteps } from '../src/compare.ts';
import { LogBuilder, schema, typeAt } from './fixtures.ts';

function logOf(n: number): LogBuilder {
  const b = new LogBuilder();
  for (let i = 0; i < n; i++)
    b.add((d) => typeAt(d, 'pEnd00000000001Z', 0, `x${i}`), { user: i % 2 ? 'bob' : 'carol' });
  return b;
}

/** The commits as the service hands them over when the payload of `removed` was removed. */
function withRemoved(commits: readonly LogCommit[], removed: readonly number[]): LogCommit[] {
  return commits.map((c) => (removed.includes(c.seq) ? ({ ...c, steps: [] } as LogCommit) : c));
}

function sourceOf(
  b: LogBuilder,
  commits: (after: number, to: number) => LogCommit[],
): CompareSource {
  return {
    schema,
    incarnation: 'inc-removed',
    content: (seq) => b.docs[seq],
    commits,
  };
}

const GATE = { min: 0, head: 6 };

describe('a comparison over a removed payload refuses cleanly (HIS-040 criterion 2)', () => {
  it('refuses the steps comparison, naming the commit whose detail was removed', () => {
    const b = logOf(6);
    const r = compareSteps({
      schema,
      from: { seq: 0, doc: b.docs[0]! },
      commits: withRemoved(b.commits(0, 6), [3]),
      hidden: NOTHING_HIDDEN,
    });
    expect(r).toMatchObject({ ok: false, code: 'not_found' });
    expect(r.ok ? '' : r.reason).toContain('commit 3');
    expect(r.ok ? '' : r.reason).toContain('removed');
  });

  it('refuses the comparison entry point too, with no comparison returned', () => {
    const b = logOf(6);
    const src = sourceOf(b, (after, to) => withRemoved(b.commits(after, to), [4]));
    const r = compare({ fromSeq: 0, toSeq: 6 }, src, { gate: GATE, hidden: NOTHING_HIDDEN });
    expect(r).toMatchObject({ ok: false, code: 'not_found' });
    expect('comparison' in r).toBe(false);
  });

  it('still compares a control commit that has no steps, because it is not a removed payload', () => {
    const b = logOf(4);
    const commits = b
      .commits(0, 4)
      .map((c) => (c.seq === 2 ? ({ ...c, kind: 'control', steps: [] } as LogCommit) : c));
    const r = compareSteps({
      schema,
      from: { seq: 0, doc: b.docs[0]! },
      commits,
      hidden: NOTHING_HIDDEN,
    });
    expect(r.ok).toBe(true);
  });

  it('refuses for any removed commit inside the range, and compares the untouched range (property)', () => {
    const b = logOf(8);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (removedSeq) => {
        const full = b.commits(0, 8);
        const refused = compareSteps({
          schema,
          from: { seq: 0, doc: b.docs[0]! },
          commits: withRemoved(full, [removedSeq]),
          hidden: NOTHING_HIDDEN,
        });
        expect(refused).toMatchObject({ ok: false, code: 'not_found' });
        const intact = compareSteps({
          schema,
          from: { seq: 0, doc: b.docs[0]! },
          commits: full,
          hidden: NOTHING_HIDDEN,
        });
        expect(intact.ok).toBe(true);
      }),
      { numRuns: 40 },
    );
  });
});
