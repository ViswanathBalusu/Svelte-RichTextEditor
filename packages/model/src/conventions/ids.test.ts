// Node identifiers at volume (CDM-012; 03 §9). Node.js only: a million identifiers is a lot to ask
// of every browser run, and the universal tests already check the format in each engine.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE_ID_PATTERN, nodeId } from './ids.ts';

afterEach(() => vi.restoreAllMocks());

describe('node identifiers', () => {
  it('draws from the platform CSPRNG', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    nodeId();
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0]![0] as Uint8Array;
    expect(arg.byteLength).toBe(12); // 96 random bits per identifier
  });

  it('makes a million 16-character URL-safe identifiers without a duplicate', () => {
    const re = new RegExp(NODE_ID_PATTERN);
    const seen = new Set<string>();
    for (let i = 0; i < 1_000_000; i++) {
      const id = nodeId();
      if (!re.test(id)) throw new Error(`not a node identifier: ${id}`);
      seen.add(id);
    }
    expect(seen.size).toBe(1_000_000);
  });
});
