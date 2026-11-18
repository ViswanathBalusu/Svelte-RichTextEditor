// PRO-106 criterion 4: each of the three history calls has its request and response written in
// the interface definition (05 §10.1), and what is written is what the service does: the route
// exists, the documented request fields are read, and the documented answer keys are in the answer.
import { documentHash, type JsonEnvelope } from '@docedit/model';
import { contractDocument } from '@docedit/protocol/contract';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningServer, listen } from '../src/http.ts';
import { AuthorityService } from '../src/service.ts';

const spec = readFileSync(
  resolve(import.meta.dirname, '../../../docs/spec/05-protocol.md'),
  'utf8',
);
const section = spec.slice(
  spec.indexOf('### 10.1 The history calls'),
  spec.indexOf('## 11. Conformance'),
);

const REQUESTER = { sub: 'olivia', session: 's-olivia', role: 'owner' };
const PERMISSIONS = { revision: 0, grants: [] };

describe('the history calls in the interface definition (PRO-106 criterion 4)', () => {
  let running: RunningServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('writes the route, the request and the answer of each call', async () => {
    const service = new AuthorityService();
    const env = contractDocument() as unknown as JsonEnvelope;
    const contentHash = await documentHash(env);
    const opened = await service.open({
      doc: 'doc-interface',
      checkpointRef: { seq: 0, chainHead: null, contentHash, content: env, createdBy: 'olivia' },
      commits: [],
      stateId: contentHash,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    running = await listen({ service });
    const post = async (call: string, body: Record<string, unknown>) => {
      const res = await fetch(`${running!.url}/v1/authority/states/${opened.stateId}/${call}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requester: REQUESTER, permissions: PERMISSIONS, ...body }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    const calls: Array<{
      call: string;
      request: Record<string, unknown>;
      answer: string[];
      fields: string[];
    }> = [
      {
        call: 'restore-steps',
        request: { toSeq: 0, dryRun: true },
        answer: ['kind', 'toSeq', 'headSeq', 'preconditions', 'unchanged', 'reidentified'],
        fields: ['toSeq', 'region', 'dryRun', 'retired', 'idSalt'],
      },
      {
        call: 'diff',
        request: { fromSeq: 0, toSeq: 0, granularity: 'word' },
        answer: ['comparison'],
        fields: ['fromSeq', 'toSeq', 'region', 'granularity'],
      },
      {
        call: 'attribution',
        request: { seq: 0 },
        answer: ['seq', 'blocks'],
        fields: ['seq', 'region', 'blocks'],
      },
    ];
    for (const c of calls) {
      expect(section, `${c.call}: the route is written`).toContain(
        `POST /v1/authority/states/{stateId}/${c.call}`,
      );
      for (const field of c.fields)
        expect(section, `${c.call}: request field ${field}`).toContain(`\`${field}\``);
      const r = await post(c.call, c.request);
      expect(r.status, `${c.call} answers ${JSON.stringify(r.body)}`).toBe(200);
      for (const key of c.answer) {
        expect(Object.keys(r.body), `${c.call}: answer key ${key}`).toContain(key);
        expect(section, `${c.call}: answer key ${key} is written`).toMatch(
          new RegExp(`\\b${key}\\b`),
        );
      }
    }
    // The common request fields and the shape of a refusal are written too.
    for (const word of ['requester', 'permissions', 'gate', 'now', 'refused', 'unknown_state'])
      expect(section).toMatch(new RegExp(`\\b${word}\\b`));
  });
});
