// PRO-036 criteria 1, 3, 4 and 6 on a live socket (lane w5; 05 section 5.6; ADR 0019): the real
// data plane stands behind the routes, a channel is open on the document, and the notifications the
// routes send reach it as `event` messages. A thread or a comment in a region the reader cannot see
// is not sent to that reader's channel, while an owner's channel gets it. A user without a role in
// the document has no channel to send to. Memory and PostgreSQL. Test values only.
import { NOTHING_HIDDEN, type Visibility } from '@docedit/authority';
import { afterEach, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import { DepClient } from '../data-plane/client.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const LEGAL = 'rLegal0000000001';
const LEGAL_BLOCK = 'pLegal0000000001';
const BODY_BLOCK = 'pEnd000000000001';
const comment = { text: 'Is this still right?' };

const visibility: Visibility = (conn) =>
  conn.role === 'owner'
    ? NOTHING_HIDDEN
    : { regions: new Set([LEGAL]), values: new Set(), titles: false };

const clients: DepClient[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const h of harnesses.splice(0)) await h.close();
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`notifications reach the open channels (${storage})`, async () => {
    const skip = await skipReason(storage);

    async function setup() {
      const h = await startHarness(storage, {
        views: { ...FULL_VIEWS, visibility },
        realDataPlane: true,
        config: { testMode: true, environment: 'test' },
      });
      harnesses.push(h);
      const doc = await h.createDocument({ content: documentWithRegions() });
      const listen = async (role: string, sub: string) => {
        const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
        clients.push(c);
        expect((await c.hello(h.userToken({ [doc]: role }, { sub }))).t).toBe('welcome');
        expect((await c.open(1, doc)).t).toBe('ch.opened');
        return c;
      };
      const eventOf = async (c: DepClient, type: string) =>
        (await c.take((m) => m.t === 'event' && m.d?.type === type, 3000, type)).d as {
          resource: string;
          data: Record<string, unknown>;
        };
      return { h, doc, listen, eventOf };
    }

    it.skipIf(skip)(
      'delivers thread and comment events with the thread or comment as resource to an editor, and version.created and version.restored (criteria 1, 3 and 4)',
      async () => {
        const { h, doc, listen, eventOf } = await setup();
        const editor = await listen('editor', 'ed-live');
        const owner = h.userToken({ [doc]: 'owner' }, { sub: 'ow-live' });

        const made = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token: owner,
          body: { target: { block: BODY_BLOCK }, comment },
        });
        expect(made.status, made.text).toBe(201);
        const tid = made.json.id as string;
        const created = await eventOf(editor, 'thread.created');
        expect(created).toMatchObject({
          resource: `/threads/${tid}`,
          data: { state: 'open', block: BODY_BLOCK },
        });
        expect(typeof created.data['seq']).toBe('number');

        const reply = await h.call('POST', `/v1/threads/${tid}/comments`, {
          token: owner,
          body: { text: 'A reply' },
        });
        expect((await eventOf(editor, 'comment.created')).resource).toBe(
          `/comments/${reply.json.id}`,
        );

        const resolved = await h.call('PATCH', `/v1/threads/${tid}`, {
          token: owner,
          body: { state: 'resolved' },
          headers: { 'If-Match': made.headers.get('etag')! },
        });
        expect(resolved.status, resolved.text).toBe(200);
        expect((await eventOf(editor, 'thread.resolved')).resource).toBe(`/threads/${tid}`);

        // A named version is announced, and so is a restore (the restore also resets the channel).
        const version = await h.call('POST', `/v1/documents/${doc}/versions`, {
          token: h.apiKey,
          body: { seq: 0, name: 'First' },
        });
        expect(version.status, version.text).toBe(201);
        const named = await eventOf(editor, 'version.created');
        expect(named.data['seq']).toBe(0);

        const put = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          body: documentWithRegions(),
          headers: {
            'If-Match': (
              await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })
            ).headers.get('etag')!,
          },
        });
        expect(put.status, put.text).toBe(204);
        const restore = await h.call('POST', `/v1/documents/${doc}/restore`, {
          token: owner,
          body: { toSeq: 0 },
        });
        expect(restore.status, restore.text).toBe(200);
        const restored = await eventOf(editor, 'version.restored');
        expect(restored.data).toMatchObject({ seq: restore.json.seq, toSeq: 0 });
      },
    );

    it.skipIf(skip)(
      'does not send the events of a thread in a region to a reader who cannot see it, and does to an owner (criterion 6)',
      async () => {
        const { h, doc, listen, eventOf } = await setup();
        const editor = await listen('editor', 'ed-hide');
        const ownerChannel = await listen('owner', 'ow-hide');
        const owner = h.userToken({ [doc]: 'owner' }, { sub: 'ow-hide' });
        const isEvent = (c: DepClient, type: string) =>
          c.log.filter((m) => m.t === 'event' && m.d?.type === type).length;

        const hidden = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token: owner,
          body: { target: { block: LEGAL_BLOCK }, comment },
        });
        expect(hidden.status, hidden.text).toBe(201);
        const reply = await h.call('POST', `/v1/threads/${hidden.json.id}/comments`, {
          token: owner,
          body: { text: 'Hidden reply' },
        });
        expect(reply.status, reply.text).toBe(201);
        // A thread in the open body follows, as the marker that the editor's channel is live.
        const visible = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token: owner,
          body: { target: { block: BODY_BLOCK }, comment },
        });
        expect(visible.status, visible.text).toBe(201);

        // The owner's channel hears of all three.
        const visibleEvent = (m: { t: string; d?: { resource?: string } }) =>
          m.t === 'event' && m.d?.resource === `/threads/${visible.json.id}`;
        await ownerChannel.take(visibleEvent, 3000, 'the visible thread');
        await eventOf(ownerChannel, 'comment.created');
        expect(isEvent(ownerChannel, 'thread.created')).toBe(2);
        // The editor's channel hears of the visible thread only, and of no comment.
        await editor.take(visibleEvent, 3000, 'the visible thread');
        expect(isEvent(editor, 'thread.created')).toBe(1);
        expect(isEvent(editor, 'comment.created')).toBe(0);
        const heard = editor.log.filter((m) => m.t === 'event' && m.d?.type === 'thread.created');
        expect(heard[0]!.d!.resource).toBe(`/threads/${visible.json.id}`);
      },
    );

    it.skipIf(skip)('has no channel for a user without a role in the document', async () => {
      const { h, doc } = await setup();
      const stranger = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(stranger);
      const other = await h.createDocument({ content: documentWithRegions() });
      expect((await stranger.hello(h.userToken({ [other]: 'owner' }, { sub: 'nobody' }))).t).toBe(
        'welcome',
      );
      const r = await stranger.open(1, doc);
      expect(r.t).toBe('ch.rejected');
      expect(r.d?.code).toBe('forbidden');
    });
  });
}
