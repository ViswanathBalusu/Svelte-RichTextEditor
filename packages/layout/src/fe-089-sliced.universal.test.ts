/**
 * FE-089, criterion 1, on the real event loop: a long document is paginated in time slices, and
 * tasks queued on the event loop (messages, standing in for input events) run between the slices,
 * before the pagination ends. Runs in Node.js, Chromium, Firefox and WebKit (`*.universal.test.ts`);
 * the clock is `performance.now` and the host's turn is a timer. No DOM is used: the event loop is
 * reached through `MessageChannel` and `setTimeout`, which all four have.
 */
import { describe, expect, it } from 'vitest';
import { paginateInSlices, type PaginationDriver } from './paginate-driver.ts';
import { paginate, type PageItem, type ParagraphItem } from './paginate.ts';
import type { ParagraphFragment } from './tree.ts';

function para(id: string, lines: number): ParagraphItem {
  const ls = Array.from({ length: lines }, (_, i) => ({
    from: i * 10,
    to: i * 10 + 10,
    x: 0,
    y: i * 10,
    width: 50,
    height: 10,
  }));
  const fragment: ParagraphFragment = {
    kind: 'paragraph',
    blockId: id,
    from: 0,
    to: lines * 10,
    x: 0,
    y: 0,
    width: 100,
    height: lines * 10,
    lines: ls,
  };
  return {
    kind: 'paragraph',
    fragment,
    spaceBefore: 0,
    spaceAfter: 0,
    keepNext: false,
    keepLines: false,
    pageBreakBefore: false,
    widowControl: true,
  };
}

interface Port {
  onmessage: ((event: unknown) => void) | null;
  postMessage(message: unknown): void;
}
type ChannelCtor = new () => { port1: Port; port2: Port };

describe('pagination in time slices on the event loop (FE-089 criterion 1)', () => {
  it('handles queued tasks between slices, before the pagination ends', async () => {
    const items: PageItem[] = Array.from({ length: 6000 }, (_, i) => para(`p${i}`, 4));
    const first = { width: 80, height: 100, margins: { top: 0, right: 0, bottom: 0, left: 0 } };
    const Channel = (globalThis as unknown as { MessageChannel: ChannelCtor }).MessageChannel;
    const channel = new Channel();
    let driver: PaginationDriver | null = null;
    let during = 0;
    let handled = 0;
    channel.port1.onmessage = () => {
      handled++;
      if (driver !== null && !driver.done) during++;
    };
    const result = await paginateInSlices(
      items,
      first,
      {},
      {
        now: () => performance.now(),
        sliceMs: 1,
        yieldToHost: () =>
          new Promise<void>((resolve) => {
            // One message per turn that the host is given, then the timer that ends the turn.
            channel.port2.postMessage(0);
            setTimeout(resolve, 0);
          }),
      },
      (d) => {
        driver = d;
      },
    );
    channel.port1.onmessage = null;
    expect(driver!.slices).toBeGreaterThan(1);
    // The messages were handled while the pagination was still running.
    expect(during).toBeGreaterThan(0);
    expect(handled).toBeGreaterThan(0);
    expect(result.pages.length).toBe(paginate(items, first).pages.length);
  }, 60_000);
});

declare const performance: { now(): number };
declare function setTimeout(run: () => void, ms: number): unknown;
