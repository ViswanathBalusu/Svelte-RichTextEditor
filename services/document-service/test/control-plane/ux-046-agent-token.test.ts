// UX-046 criterion 6 and ADR 0234 A (05 §3.2.1): an assistant agent is registered with a service
// credential (`POST /agents`), its token is minted by the service (`POST /tokens` with `agent`),
// and the server learns that a connection is the assistant's only from the verified token, never
// from the client. The introducing commit of a suggestion names the agent and its registered name.
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import type { StoredCommit } from '@docedit/authority';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeJws } from '../../src/control-plane/jwt.ts';
import type { DocRef } from '../../src/storage/types.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const INTRO = 'pIntro0000000001';
const SUGGESTION = 'sgAgent000000001';

function inside(doc: unknown, id: string): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === id) at = pos + 1;
      return at < 0;
    });
  return at;
}

describe('the assistant agent: registration, token and attribution (UX-046 criterion 6)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('memory', { realDataPlane: true });
  });
  afterAll(async () => {
    await h?.close();
  });

  const register = async (name: string, docs?: string[]) => {
    const r = await h.call('POST', '/v1/agents', {
      token: h.apiKey,
      body: { name, ...(docs ? { docs } : {}) },
    });
    expect(r.status, r.text).toBe(201);
    return r.json as { id: string; name: string };
  };
  const mint = (agent: string | undefined, docs: Record<string, string>, sub = 'person-1') =>
    h.call('POST', '/v1/tokens', {
      token: h.apiKey,
      body: { sub, docs, ...(agent !== undefined ? { agent } : {}) },
    });

  it('registers an agent for a service credential only', async () => {
    const doc = await h.createDocument();
    const agent = await register('Model X');
    expect(agent.name).toBe('Model X');
    expect(agent.id.length).toBeGreaterThan(0);
    const user = h.userToken({ [doc]: 'owner' });
    expect(
      (await h.call('POST', '/v1/agents', { token: user, body: { name: 'Mine' } })).status,
    ).toBe(403);
  });

  it('mints an agent token whose verified connection carries the agent and is capped', async () => {
    const doc = await h.createDocument();
    const agent = await register('Model X');
    const minted = await mint(agent.id, { [doc]: 'editor' });
    expect(minted.status, minted.text).toBe(200);
    const token = (minted.json as { token: string }).token;
    const jws = decodeJws(token);
    expect(jws.header['typ']).toBe('dep-agent+jwt');
    expect(jws.payload['agt']).toBe(agent.id);
    expect(jws.payload['act']).toEqual({ sub: agent.id });

    const identity = await h.service.tokens.verifyUser(token);
    expect(identity.connection.agent).toBe(agent.id);
    expect(identity.agent).toEqual({ id: agent.id, name: 'Model X' });
    // The person is the subject; the role is the person's, the cap is the authority's (access.ts).
    expect(identity.sub).toBe('person-1');
    expect(identity.connection.role).toBe('editor');
  });

  it('an agent token is no service credential, and a user token never becomes an agent', async () => {
    const doc = await h.createDocument();
    const agent = await register('Model X');
    const token = ((await mint(agent.id, { [doc]: 'editor' })).json as { token: string }).token;
    await expect(h.service.tokens.verifyService(token)).rejects.toThrow();
    // A plain user token that claims an agent in its payload is still a user token.
    const forged = h.userToken({ [doc]: 'editor' }, { agt: agent.id, act: { sub: agent.id } });
    const identity = await h.service.tokens.verifyUser(forged);
    expect(identity.connection.agent).toBeUndefined();
    expect(identity.agent).toBeUndefined();
  });

  it('refuses an unknown agent, a document the agent may not act on, and a disabled agent', async () => {
    const doc = await h.createDocument();
    const other = await h.createDocument();
    expect((await mint('agt_unknown', { [doc]: 'editor' })).status).toBe(400);
    const narrow = await register('Narrow', [doc]);
    expect((await mint(narrow.id, { [doc]: 'editor' })).status).toBe(200);
    expect((await mint(narrow.id, { [other]: 'editor' })).status).toBe(400);

    const token = ((await mint(narrow.id, { [doc]: 'editor' })).json as { token: string }).token;
    await h.service.tokens.verifyUser(token);
    // A disabled agent loses access at once (05 §3.2.1).
    await h.service.tokens.agents.disable(h.tenant, narrow.id);
    await expect(h.service.tokens.verifyUser(token)).rejects.toThrow();
    expect((await mint(narrow.id, { [doc]: 'editor' })).status).toBe(400);
  });

  it('names the agent and its model on the introducing commit of a suggestion', async () => {
    const doc = await h.createDocument({ content: documentWithRegions(), title: 'Agent' });
    const agent = await register('Model X');
    const ref: DocRef = { tenant: h.tenant, doc };
    const epoch = await h.parts.ownership.claim(ref, 'ux-046-node');
    const head = await h.parts.logs.head(ref);
    const perms = await h.parts.grants.current(ref);
    const pos = inside(documentWithRegions()['doc'], INTRO);
    const commit: StoredCommit = {
      seq: head.seq + 1,
      id: uuid7(),
      kind: 'steps',
      steps: [
        {
          stepType: 'replace',
          from: pos,
          to: pos,
          slice: { content: [{ type: 'text', text: 'ai' }] },
        },
      ] as StoredCommit['steps'],
      user: 'u-test',
      session: 'session-test',
      agent: agent.id,
      time: h.now(),
      origin: 'assistant',
      scopes: ['body'],
      revision: perms.revision,
      cdm: 1,
      engine: 'pm-steps/1',
      retired: [],
      claimed: [SUGGESTION],
    };
    const r = await h.parts.logs.append(ref, {
      epoch,
      revision: perms.revision,
      fromSeq: head.seq + 1,
      commits: [commit],
    });
    expect(r.status).toBe('ok');
    const viewer = h.userToken({ [doc]: 'viewer' }, { sub: 'u-viewer' });
    const got = await h.call('GET', `/v1/documents/${doc}/suggestions/${SUGGESTION}/introduction`, {
      token: viewer,
    });
    expect(got.status, got.text).toBe(200);
    expect(got.json).toMatchObject({
      origin: 'assistant',
      agent: agent.id,
      agentName: 'Model X',
    });
  });
});
