/**
 * FRW-026 criteria 1 and 6 against the real document service (in-process, on an ephemeral port,
 * memory storage) through the real REST client of the backend (`RestClient`, `createWorkflowRest`)
 * and the element's `participantsService`:
 *
 *  - criterion 6: a host writes the workflow with its service credential (a service JWT), and the
 *    editor's list shows the participants without the owner entering them, on the next read;
 *  - criterion 1: the owner adds a participant through the editor's service, and the workflow
 *    resource the service holds has it, with roles, kind, order, `sub` and `name`;
 *  - a participant who may not manage the document cannot write, and the service refuses once the
 *    workflow is no longer a draft.
 *
 * The pane that draws the list is in packages/ui/e2e/frw-026-participants.spec.ts (real browsers).
 */
import { DocumentCore } from '@docedit/engine/headless';
import type { EditorCore } from '@docedit/engine';
import type { Platform } from '@docedit/backend-dep';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RestClient } from '../../backend-dep/src/rest.ts';
import { createWorkflowRest } from '../../backend-dep/src/workflow.ts';
import { participantsService } from '../src/participants.ts';
import {
  startHarness,
  type Harness,
} from '../../../services/document-service/test/control-plane/support.ts';
import type { MemoryWorkflowResourceStore } from '../../../services/document-service/src/workflow/workflow-resource.ts';
import { fieldsDocument, participantAccess } from '../../engine/test/frw-fields-fixture.ts';

const schedule = (run: () => void): void => queueMicrotask(run);

let h: Harness;
beforeAll(async () => {
  h = await startHarness('memory');
});
afterAll(async () => {
  await h?.close();
});

/** The workflow port of a caller with this token, over the service's own REST routes. */
function portFor(token: string) {
  const client = new RestClient(
    `${h.base}/v1`,
    {
      fetch: (url: string, init: unknown) => fetch(url, init as RequestInit),
    } as unknown as Platform,
    { token: async () => token, renew: async () => token },
  );
  const rest = createWorkflowRest({ rest: async () => client });
  return { ...rest, onChange: () => () => undefined };
}

function editorFor(token: string, docId: string, caps: 'manage' | 'view') {
  const core = new DocumentCore({ doc: fieldsDocument(), schedule });
  core.setAccess(
    (caps === 'manage'
      ? {
          ...participantAccess([]),
          docRole: 'owner',
          caps: ['view', 'comment', 'edit', 'structure', 'manage'],
          fill: undefined,
        }
      : participantAccess([])) as never,
  );
  const port = portFor(token);
  const service = participantsService(core as unknown as EditorCore, () => ({ port, docId }));
  return { service, port };
}

describe('the participants list over the real service (FRW-026)', () => {
  it('shows people the host wrote with its service credential, without the owner entering them (criterion 6)', async () => {
    const doc = await h.createDocument();
    const owner = h.userToken({ [doc]: 'owner' });
    const editor = editorFor(owner, doc, 'manage');
    await editor.service.prepare?.();
    expect(editor.service.participants.get()).toEqual([]);
    expect(editor.service.state.get()).toBe('draft');

    // The host writes the workflow with its service credential: creation is a PUT with If-Match "0".
    const written = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
      token: h.serviceJwt(),
      headers: { 'if-match': '"0"' },
      body: {
        id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c9d',
        doc,
        state: 'draft',
        rev: 0,
        participants: [
          {
            id: 'h1',
            roles: ['role_tenant'],
            kind: 'filler',
            order: 1,
            sub: 'host-user-7',
            name: 'Ada',
          },
          { id: 'h2', roles: ['role_landlord'], kind: 'signer', order: 2, sub: 'host-user-8' },
        ],
      },
    });
    expect(written.status, written.text).toBeLessThan(300);

    await editor.service.prepare?.();
    expect(
      editor.service.participants.get().map((p) => [p.id, p.name, p.sub, p.roles, p.kind, p.order]),
    ).toEqual([
      ['h1', 'Ada', 'host-user-7', ['role_tenant'], 'filler', 1],
      ['h2', null, 'host-user-8', ['role_landlord'], 'signer', 2],
    ]);
    editor.service.dispose();
  });

  it('saves a participant the owner adds in the workflow resource of the service (criterion 1)', async () => {
    const doc = await h.createDocument();
    const owner = h.userToken({ [doc]: 'owner' });
    const editor = editorFor(owner, doc, 'manage');
    await editor.service.prepare?.();
    expect(editor.service.canEdit.get()).toBe(true);

    expect(
      await editor.service.save({
        name: 'Jane Doe',
        sub: 'u-jane',
        roles: ['role_tenant', 'role_landlord'],
        kind: 'signer',
        order: 1,
      }),
    ).toEqual({ ok: true });
    expect(
      await editor.service.save({
        name: 'Second',
        sub: '',
        roles: ['role_landlord'],
        kind: 'approver',
        order: 2,
      }),
    ).toEqual({ ok: true });

    const stored = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
    expect(stored.status).toBe(200);
    expect(stored.json.state).toBe('draft');
    expect(stored.json.participants).toEqual([
      {
        id: 'p1',
        name: 'Jane Doe',
        sub: 'u-jane',
        roles: ['role_tenant', 'role_landlord'],
        kind: 'signer',
        order: 1,
      },
      { id: 'p2', name: 'Second', roles: ['role_landlord'], kind: 'approver', order: 2 },
    ]);
    expect(JSON.stringify(stored.json)).not.toMatch(/mail|phone|telephone/i);

    // A second editor opened later reads the same list.
    const later = editorFor(owner, doc, 'manage');
    await later.service.prepare?.();
    expect(later.service.participants.get().map((p) => p.id)).toEqual(['p1', 'p2']);
    editor.service.dispose();
    later.service.dispose();
  });

  it('is refused by the service for a caller without manage, and once the workflow is sent', async () => {
    const doc = await h.createDocument();
    const owner = h.userToken({ [doc]: 'owner' });
    const viewerToken = h.userToken({ [doc]: 'viewer' });
    const ownerEditor = editorFor(owner, doc, 'manage');
    await ownerEditor.service.prepare?.();
    await ownerEditor.service.save({
      name: 'A',
      sub: 'a',
      roles: ['role_tenant'],
      kind: 'filler',
      order: 1,
    });

    // An editor that wrongly offers the form to a viewer: the service says no, and nothing changes.
    const viewer = editorFor(viewerToken, doc, 'manage');
    await viewer.service.prepare?.();
    expect(
      await viewer.service.save({
        name: 'B',
        sub: 'b',
        roles: ['role_tenant'],
        kind: 'filler',
        order: 2,
      }),
    ).toEqual({ ok: false, reason: 'forbidden' });
    const unchanged = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
    expect(unchanged.json.participants).toHaveLength(1);

    // The workflow is sent behind the editor's back: the service refuses the write, and the editor reads again.
    (h.parts.workflows as MemoryWorkflowResourceStore).setForTest(h.tenant, doc, {
      state: 'in_progress',
      sentSeq: 640,
      sentHash: 'sha256:9c1f',
    });
    const after = await ownerEditor.service.save({
      name: 'C',
      sub: 'c',
      roles: ['role_tenant'],
      kind: 'filler',
      order: 3,
    });
    expect(after).toEqual({ ok: false, reason: 'not_draft' });
    expect(ownerEditor.service.canEdit.get()).toBe(false);
    const kept = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
    expect(kept.json.participants).toHaveLength(1);
    ownerEditor.service.dispose();
    viewer.service.dispose();
  });
});
