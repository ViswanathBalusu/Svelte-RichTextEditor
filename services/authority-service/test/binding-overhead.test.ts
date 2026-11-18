// PRO-102 criterion 2: the overhead of `applyCommit` over the recommended binding (ADR 0314,
// decision 3; HTTP/1.1 is the accepted first form), measured against the target of 04 §12 (well
// under a millisecond of CPU for a typical commit). The prototype is the service's own HTTP
// binding on an ephemeral port. The client and the server share this process, so the CPU figure
// holds both sides and is an upper bound for the service alone.
//
// The test asserts that the two paths agree. It prints the figures and asserts no time: a timing
// bound would fail on a loaded machine, and the figures are recorded in the story's Notes with
// where they were taken.
import { documentHash, type JsonEnvelope } from '@docedit/model';
import { IDS, contractDocument, posIn } from '@docedit/protocol/contract';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningServer, listen } from '../src/http.ts';
import { AuthorityService, type ApplyCommitRequest } from '../src/service.ts';

const DOC = 'doc-binding-overhead';
const T0 = 1_700_000_000_000;
const WARM_UP = 50;
const CALLS = 300;

const uuid = (n: number): string => `0192f0c4-7b1e-7c3a-9a54-${String(n).padStart(12, '0')}`;

describe('applyCommit over the HTTP binding (PRO-102 criterion 2)', () => {
  let running: RunningServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('measures the call overhead of the binding next to the in-process call', async () => {
    const service = new AuthorityService();
    const env = contractDocument() as unknown as JsonEnvelope;
    const contentHash = await documentHash(env);
    const opened = await service.open({
      doc: DOC,
      checkpointRef: { seq: 0, chainHead: null, contentHash, content: env },
      commits: [],
      stateId: contentHash,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const { stateId } = opened;
    const at = posIn(contractDocument().doc, IDS.intro, 0);

    // A typical commit: one paragraph insert by an editor. Each call starts from the opened state,
    // which a call does not change (it answers a new `stateId`), so every call does the same work.
    const body = (n: number): ApplyCommitRequest => ({
      commit: {
        id: uuid(n),
        base: 0,
        steps: [
          {
            stepType: 'replace',
            from: at,
            to: at,
            slice: { content: [{ type: 'text', text: 'Hi ' }] },
          },
        ],
        author: { sub: 'eddie', session: 's-eddie', role: 'editor' },
        time: T0,
      },
      permissions: { revision: 0, grants: [] },
    });

    running = await listen({ service });
    const url = `${running.url}/v1/authority/states/${stateId}/commits`;
    const overHttp = async (n: number): Promise<unknown> => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body(n)),
      });
      return res.json();
    };

    // Agreement: the same commit gives the same answer by both paths.
    const direct = await service.applyCommit(stateId, body(1));
    const wire = (await overHttp(1)) as { rejected?: unknown; stateId?: string; seq?: number };
    expect(direct.ok && direct.accepted).toBe(true);
    expect(wire.rejected).toBeUndefined();
    if (direct.ok && direct.accepted) {
      expect(wire.stateId).toBe(direct.stateId);
      expect(wire.seq).toBe(direct.seq);
    }

    const measure = async (
      call: (n: number) => Promise<unknown>,
    ): Promise<{ wallMs: number; cpuMs: number }> => {
      for (let i = 0; i < WARM_UP; i += 1) await call(i + 10);
      const cpu0 = process.cpuUsage();
      const t0 = performance.now();
      for (let i = 0; i < CALLS; i += 1) await call(i + 1000);
      const wall = performance.now() - t0;
      const cpu = process.cpuUsage(cpu0);
      return { wallMs: wall / CALLS, cpuMs: (cpu.user + cpu.system) / 1000 / CALLS };
    };

    const a = await measure((n) => service.applyCommit(stateId, body(n)));
    const b = await measure(overHttp);
    const f = (x: number): string => x.toFixed(3);
    console.log(
      `PRO-102 applyCommit, ${CALLS} calls after ${WARM_UP} warm-up, per call: ` +
        `in-process wall ${f(a.wallMs)} ms, cpu ${f(a.cpuMs)} ms; ` +
        `over HTTP/1.1 loopback wall ${f(b.wallMs)} ms, cpu ${f(b.cpuMs)} ms (client and server in one process); ` +
        `overhead of the binding wall ${f(b.wallMs - a.wallMs)} ms, cpu ${f(b.cpuMs - a.cpuMs)} ms; ` +
        `node ${process.version} ${process.platform}-${process.arch}`,
    );
    expect(Number.isFinite(b.cpuMs)).toBe(true);
  }, 120_000);
});
