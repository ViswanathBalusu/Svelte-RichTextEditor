// PRO-098 and PRO-099: one set of port contract tests, the suite of @docedit/protocol/contract,
// against every backend implementation the project ships, each built by a factory: backend-mock in
// process, and backend-dep over a real network, first to the mock backend served over DEP, then to
// the reference service. The suite imports only the port typings and the harness interface; this
// file is the only place that knows the implementations. A case a backend cannot run (a test hook
// the public interfaces do not offer, or a port it lacks) is skipped with its reason.
import { createDepBackend } from '@docedit/backend-dep';
import { MockService } from '@docedit/backend-mock';
import { contractDocument } from '@docedit/protocol/contract';
import {
  coreSmoke,
  portContract,
  type ContractCase,
  type ContractHarness,
  type HarnessFactory,
} from '@docedit/protocol/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { portHarness, type BackendFactory } from '../src/harness.ts';
import { startMock } from './targets/mock-server.ts';
import { startReference, type StartedTarget } from './targets/reference.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const skipTargets = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

/** backend-mock in process: each harness call is the in-memory form of a service-credential call. */
function inProcess(opts: { presence?: boolean } = {}): HarnessFactory {
  return async (): Promise<ContractHarness> => {
    const service = new MockService(opts);
    return {
      createDocument: async (content, o) =>
        service.createDocument(content, o?.grants ? { grants: o.grants } : {}),
      backend: async (user, docs) => service.backend(user, docs),
      setGrants: async (docId, grants) => service.setGrants(docId, grants),
      replaceContent: async (docId, content) => service.replaceContent(docId, content),
      setDocumentState: async (docId, state) => service.setDocumentState(docId, state),
      revokeSessions: async (sub) => service.revokeSessions(sub),
      denyTokens: (sub) => service.denyTokens(sub),
      holdWrites: (docId) => service.holdWrites(docId),
      checkpoint: (docId) => service.checkpoint(docId),
      advanceClock: async (ms) => service.advanceClock(ms),
      dispose: () => service.dispose(),
    };
  };
}

/** backend-dep for a discovery endpoint, with the platform WebSocket and fetch of Node.js. */
const depBackend: BackendFactory = ({ endpoint, getToken }) =>
  createDepBackend({ endpoint, getToken });

function register(cases: readonly ContractCase[], known: Readonly<Record<string, string>> = {}) {
  for (const k of cases)
    it(`${k.id}: ${k.title}`, async (ctx) => {
      try {
        await k.run({ skip: (reason) => ctx.skip(reason) });
        if (known[k.id]) console.log(`${k.id} passes now; remove it from the known failures`);
      } catch (e) {
        if (!known[k.id]) throw e;
        console.log(
          `${k.id}: known failure: ${known[k.id]} (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`,
        );
      }
    }, 60_000);
}

describe('backend-mock in process: the port contract (PRO-098, PRO-099)', () => {
  register(portContract(inProcess(), { sleep }));
  register(coreSmoke(inProcess(), { sleep }));
});

describe('backend-mock without the presence port: its cases are skipped and reported (PRO-098 criterion 4)', () => {
  register(
    portContract(inProcess({ presence: false }), { sleep }).filter((k) => k.port === 'presence'),
  );
});

describe('the mock backend keeps nothing across instances (PRO-099 criterion 4)', () => {
  it('has no documents after it is created again, as after a page reload', () => {
    const first = new MockService();
    const id = first.createDocument(contractDocument());
    expect(first.document(id)).toBeDefined();
    const again = new MockService();
    expect(again.document(id)).toBeUndefined();
  });
});

/** Cases backend-dep cannot pass against the mock over DEP, and why. */
const DEP_ON_MOCK: Readonly<Record<string, string>> = {
  'auth.revoked':
    'after the revocation the reconnected session reports "not connected" on ch.open: a gap of the mock target of the kit (test/targets/mock-server.ts), not of backend-dep, which passes this case against the reference service',
};

describe.skipIf(skipTargets)(
  'backend-dep over DEP to the mock backend: the same suite (PRO-098 criterion 2)',
  () => {
    let target: StartedTarget | null = null;
    beforeAll(async () => {
      target = await startMock();
    }, 60_000);
    afterAll(async () => {
      await target?.stop();
    });
    const factory: HarnessFactory = () =>
      portHarness({ discovery: target!.discovery, credential: target!.credential }, depBackend)();
    register(portContract(factory, { sleep }), DEP_ON_MOCK);
    register(coreSmoke(factory, { sleep }), DEP_ON_MOCK);
  },
);

/** Cases backend-dep cannot pass against the reference service: defects of the service or open gaps. */
export const DEP_ON_REFERENCE: Readonly<Record<string, string>> = {
  'channel.onReset': 'PUT /documents/{id}/content is not offered yet (BE-037)',
  'core.reset': 'PUT /documents/{id}/content is not offered yet (BE-037)',
  'core.conversation': 'the acknowledgement of a commit on the head says rebased: true',
  'channel.submit.ack':
    'the service records the control commit of initial grants when the room starts, after the content read; the case assumes ack.seq = content.seq + 1 (07 §9 does not say when the commit is written)',
  'channel.onAccess':
    'the same: the case takes the first control commit it sees, which is that of the initial grants',
  'core.convergence':
    'the same: the head counts the control commit of the initial grants, which the case does not expect',
};

describe.skipIf(skipTargets)(
  'backend-dep to the reference service: the same suite (PRO-098 criterion 2)',
  () => {
    let target: StartedTarget | null = null;
    beforeAll(async () => {
      target = await startReference();
    }, 60_000);
    afterAll(async () => {
      await target?.stop();
    });
    const factory: HarnessFactory = () =>
      portHarness({ discovery: target!.discovery, credential: target!.credential }, depBackend)();
    register(portContract(factory, { sleep }), DEP_ON_REFERENCE);
    register(coreSmoke(factory, { sleep }), DEP_ON_REFERENCE);
  },
);
