// Erasing a person leaves the hash chain verifiable (08 §2, §13; HIS-038 criterion 3). The chain
// covers the surrogate identifier of each commit, and the erasure deletes the mapping from a host
// `sub` to that surrogate, which is not an input to the verifier. So the same bundle verifies
// before and after the erasure, and the erasure itself changes no byte of the bundle.
import { cdmSchema } from '@docedit/model/prosemirror';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type LogBundle, verifyBundle } from '../src/chain.ts';
import { shownAuthor } from '../src/erasure.ts';
import { bundleOf } from './bundle.ts';
import { CANARY, LogBuilder, typeAt } from './fixtures.ts';

const schema = cdmSchema();
const SURROGATE = 'u-7f3a';

function surrogateLog(): LogBuilder {
  const b = new LogBuilder();
  for (let i = 0; i < 6; i++)
    b.add((d) => typeAt(d, i % 2 ? 'pSecret00000001B' : 'pIntro0000000001', 0, `${CANARY}${i} `), {
      user: i % 2 ? 'u-1' : SURROGATE,
      ...(i === 3 ? { agent: 'agent-7' } : {}),
    });
  return b;
}

async function bundleFor(): Promise<LogBundle> {
  const b = surrogateLog();
  return bundleOf(b.log, [
    { seq: 0, doc: b.docs[0]! },
    { seq: 3, doc: b.docs[3]! },
  ]);
}

describe('the chain after an erasure (HIS-038 criterion 3)', () => {
  it('still verifies, and the erasure does not change the bundle', async () => {
    const bundle = await bundleFor();
    const before = JSON.stringify(bundle);
    const first = await verifyBundle(bundle, { schema });
    expect(first).toMatchObject({ status: 'intact', head: 6, problems: [] });

    // The erasure removes the mapping row and the display name; history keeps the surrogate, which
    // is now shown as an unknown person on the read side.
    const erased = new Set([SURROGATE]);
    for (const c of bundle.commits) {
      shownAuthor({ user: c.meta.user, ...(c.meta.agent ? { agent: c.meta.agent } : {}) }, erased);
    }

    const after = await verifyBundle(bundle, { schema });
    expect(after).toEqual(first);
    expect(JSON.stringify(bundle)).toBe(before);
  });

  it('verifies the same whichever surrogates are erased (property)', async () => {
    const bundle = await bundleFor();
    const baseline = await verifyBundle(bundle, { schema });
    await fc.assert(
      fc.asyncProperty(fc.subarray([SURROGATE, 'u-1']), async (erased) => {
        const set = new Set(erased);
        for (const c of bundle.commits) {
          shownAuthor({ user: c.meta.user }, set);
        }
        expect(await verifyBundle(bundle, { schema })).toEqual(baseline);
      }),
      { numRuns: 20 },
    );
  });
});
