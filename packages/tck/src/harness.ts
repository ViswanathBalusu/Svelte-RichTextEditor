/**
 * The bootstrap contract in port form (PRO-098; 05 §11): a `ContractHarness` for the port contract
 * suite of `@docedit/protocol/contract`, built from a discovery URL and a service credential, for
 * any backend implementation a caller passes in. Every harness call is a public control-plane call:
 * documents, tokens, grants, content and revocations go to the server as a host would send them.
 * The test hooks of the fault-injection profile (held writes, checkpoints, the clock) are not part
 * of the public interfaces, so the cases that need them are skipped with their reason.
 */
import type { CdmEnvelope } from '@docedit/model';
import type { Backend, DocRole } from '@docedit/protocol';
import type { ContractHarness, HarnessFactory } from '@docedit/protocol/contract';
import { isObject } from './assert.ts';
import { discoveryUrl } from './config.ts';
import { Http, ServiceClient, expectStatus } from './rest.ts';

/** Builds the backend under test for a user: the endpoint of 05 §8.1 and a token source. */
export type BackendFactory = (opts: {
  endpoint: string;
  getToken: () => Promise<string>;
}) => Backend;

export interface PortHarnessOptions {
  discovery: string;
  credential: string;
}

export function portHarness(opts: PortHarnessOptions, factory: BackendFactory): HarnessFactory {
  return async (): Promise<ContractHarness> => {
    const http = new Http();
    const url = discoveryUrl(opts.discovery);
    const d = expectStatus(await http.request('GET', url), 200, 'discovery').json;
    if (!isObject(d) || typeof d['rest'] !== 'string')
      throw new Error(`discovery at ${url} has no rest member`);
    const endpoint = url.replace(/\/\.well-known\/dep$/, '');
    const service = new ServiceClient(http, d['rest'], opts.credential);
    const backends: Backend[] = [];
    const denied = new Set<string>();
    return {
      // DEP creates a document without grants (D62), so initial grants are a PATCH and its control
      // commit (07 §9). The harness waits until that commit is the head, so that a case that joins
      // next starts after it, as it would after a creation with grants.
      createDocument: async (content: CdmEnvelope, o) => {
        const id = await service.document(content, o?.grants ?? []);
        if (o?.grants?.length)
          for (let i = 0; i < 100; i++) {
            const head = (await service.call('GET', `/documents/${id}/content`)).json as
              { seq?: number } | undefined;
            if ((head?.seq ?? 0) > 0) break;
            await new Promise((r) => setTimeout(r, 20));
          }
        return id;
      },
      backend: async (user, docs: Readonly<Record<string, DocRole>>) => {
        const b = factory({
          endpoint,
          getToken: async () => {
            if (denied.has(user.sub)) throw new Error('the host issues no token for this user');
            return service.token(user.sub, docs, {
              ...(user.name !== undefined ? { name: user.name } : {}),
              ...(user.groups ? { grp: [...user.groups] } : {}),
            });
          },
        });
        backends.push(b);
        return b;
      },
      setGrants: async (docId, grants) => {
        await service.setGrants(docId, grants);
      },
      replaceContent: async (docId, content) => {
        await service.replaceContent(docId, content);
      },
      setDocumentState: (docId, state) => service.setState(docId, state),
      revokeSessions: async (sub) => {
        // A watermark may have whole seconds, as `iat` does (05 §3.3; D73): tokens minted in the
        // second before it must be older than it to be refused.
        await new Promise((r) => setTimeout(r, 1100));
        await service.revoke(sub);
      },
      denyTokens: (sub) => {
        denied.add(sub);
      },
      dispose: async () => {
        await Promise.all(backends.map((b) => b.close().catch(() => undefined)));
      },
    };
  };
}
