// SYN-003 criterion 6 (lane U-SYN-001-018): the limits announced in `welcome` are the limits the
// room enforces. The test reads `maxStepsPerCommit` and `maxCommitBytes` from the welcome a real
// WebSocket client receives, then submits commits at and just over those announced values through
// the data plane (MemoryStore). The values are set away from the defaults so that a room which
// kept its own constants would fail.
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('welcome limits are the room limits (SYN-003 criterion 6)', () => {
  it('refuses one step over the welcome maxStepsPerCommit and accepts exactly that many', async () => {
    const p = await startPlane({
      settings: { limits: { maxStepsPerCommit: 4, maxCommitBytes: 2000 } },
    });
    planes.push(p);
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    const welcome = a.log.find((m) => m.t === 'welcome')!.d!['limits'] as {
      maxStepsPerCommit: number;
      maxCommitBytes: number;
    };
    expect(welcome).toMatchObject({ maxStepsPerCommit: 4, maxCommitBytes: 2000 });

    const over = await a.submit(1, {
      base: 0,
      steps: Array.from({ length: welcome.maxStepsPerCommit + 1 }, () => insertText(intro(), 'x')),
    });
    expect(over.d).toMatchObject({ code: 'too_large', action: 'drop' });

    const exact = await a.submit(1, {
      base: 0,
      steps: Array.from({ length: welcome.maxStepsPerCommit }, () => insertText(intro(), 'x')),
    });
    expect(exact.t).toBe('sync.ack');
    expect(exact.d).toMatchObject({ seq: 1 });
  });

  it('refuses a commit over the welcome maxCommitBytes and accepts a small one', async () => {
    const p = await startPlane({
      settings: { limits: { maxStepsPerCommit: 4, maxCommitBytes: 2000 } },
    });
    planes.push(p);
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    const welcome = a.log.find((m) => m.t === 'welcome')!.d!['limits'] as {
      maxCommitBytes: number;
    };
    expect(welcome.maxCommitBytes).toBe(2000);

    const big = await a.submit(1, {
      base: 0,
      steps: [insertText(intro(), 'x'.repeat(welcome.maxCommitBytes + 1000))],
    });
    expect(big.d).toMatchObject({ code: 'too_large', action: 'drop' });

    const small = await a.submit(1, { base: 0, steps: [insertText(intro(), 'y')] });
    expect(small.t).toBe('sync.ack');
    expect(small.d).toMatchObject({ seq: 1 });
  });
});
