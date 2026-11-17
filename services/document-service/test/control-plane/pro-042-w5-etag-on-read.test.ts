// PRO-042 criterion 1 (05 section 6.1): every response that returns a mutable resource carries an
// `ETag`, for each kind the criterion names: document, grants, region state, thread, comment and
// webhook. Over real HTTP, through the request pipeline and the router, with in-memory storage.
// Test values only.
//
// For each kind the tag that was read is then used: an update with it succeeds and answers with a
// different tag, and a second read shows the tag of that answer. Two kinds have no route of their
// own to read them, and the test says what stands in:
// - a region's state is read in `GET /documents/{id}/regions`, and its update takes the tag of the
//   grants (`GET /documents/{id}/grants`), whose revision the state belongs to;
// - no route reads a comment (05 section 6.2 has none), so the tag is the one of the response that
//   returned the comment: the `POST` that wrote it, then each `PATCH`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemorySubscriptionStore,
  WebhookSubscriptions,
} from '../../src/control-plane/webhook-subscriptions.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const BODY_BLOCK = 'pEnd000000000001';
const STRONG_TAG = /^"[^"]+"$/;

describe('every mutable resource is read with an ETag (PRO-042 criterion 1)', () => {
  let h: Harness;
  let doc: string;

  beforeAll(async () => {
    h = await startHarness('memory', {
      parts: {
        webhooks: new WebhookSubscriptions({
          store: new MemorySubscriptionStore(),
          now: () => Date.now(),
        }),
      },
    });
    doc = await h.createDocument({ content: documentWithRegions() });
  });

  afterAll(async () => {
    await h?.close();
  });

  const tagOf = (r: { headers: Headers }): string => {
    const tag = r.headers.get('etag');
    expect(tag).toMatch(STRONG_TAG);
    return tag as string;
  };
  const editor = (sub: string) => h.userToken({ [doc]: 'editor' }, { sub });

  it('a document', async () => {
    const url = `/v1/documents/${doc}`;
    const read = await h.call('GET', url, { token: h.apiKey });
    expect(read.status).toBe(200);
    const tag = tagOf(read);
    const updated = await h.call('PATCH', url, {
      token: h.apiKey,
      headers: { 'If-Match': tag },
      body: { properties: { matter: 'PRO-042' } },
    });
    expect(updated.status, updated.text).toBe(200);
    expect(tagOf(updated)).not.toBe(tag);
    expect(tagOf(await h.call('GET', url, { token: h.apiKey }))).toBe(tagOf(updated));
  });

  it('the grants of a document, and a region state with them', async () => {
    const grantsUrl = `/v1/documents/${doc}/grants`;
    const regionsUrl = `/v1/documents/${doc}/regions`;
    const grants = await h.call('GET', grantsUrl, { token: h.apiKey });
    expect(grants.status).toBe(200);
    const grantsTag = tagOf(grants);

    // The region states are read in the region list, which carries its own tag.
    const regions = await h.call('GET', regionsUrl, { token: h.apiKey });
    expect(regions.status).toBe(200);
    const listTag = tagOf(regions);
    const region = (regions.json.items as Array<{ id: string; state: string }>)[0]!;
    expect(region.state).toBe('draft');

    // The state is updated with the tag of the grants; the answer carries the new one.
    const stateUrl = `/v1/documents/${doc}/regions/${region.id}/state`;
    const set = await h.call('PUT', stateUrl, {
      token: h.apiKey,
      headers: { 'If-Match': grantsTag },
      body: { state: 'in_review' },
    });
    expect(set.status, set.text).toBe(200);
    const next = tagOf(set);
    expect(next).not.toBe(grantsTag);

    // Both reads show the change: the grants carry the tag of the answer, the list a new tag.
    expect(tagOf(await h.call('GET', grantsUrl, { token: h.apiKey }))).toBe(next);
    const after = await h.call('GET', regionsUrl, { token: h.apiKey });
    expect(tagOf(after)).not.toBe(listTag);
    expect(
      (after.json.items as Array<{ id: string; state: string }>).find((r) => r.id === region.id)
        ?.state,
    ).toBe('in_review');

    // The tag that was read before the change is stale now.
    const stale = await h.call('PUT', stateUrl, {
      token: h.apiKey,
      headers: { 'If-Match': grantsTag },
      body: { state: 'draft' },
    });
    expect(stale.status).toBe(412);
  });

  it('a thread, and a comment in the responses that return it', async () => {
    const created = await h.call('POST', `/v1/documents/${doc}/threads`, {
      token: editor('ed-1'),
      body: { target: { block: BODY_BLOCK }, comment: { text: 'Is this still right?' } },
    });
    expect(created.status, created.text).toBe(201);
    const url = `/v1/threads/${created.json.id as string}`;

    const read = await h.call('GET', url, { token: editor('ed-2') });
    expect(read.status).toBe(200);
    const tag = tagOf(read);
    expect(tag).toBe(tagOf(created));
    const resolved = await h.call('PATCH', url, {
      token: editor('ed-2'),
      headers: { 'If-Match': tag },
      body: { state: 'resolved' },
    });
    expect(resolved.status, resolved.text).toBe(200);
    expect(tagOf(resolved)).not.toBe(tag);
    expect(tagOf(await h.call('GET', url, { token: editor('ed-2') }))).toBe(tagOf(resolved));

    const comment = await h.call('POST', `${url}/comments`, {
      token: editor('ed-1'),
      body: { text: 'A reply.' },
    });
    expect(comment.status, comment.text).toBe(201);
    const commentTag = tagOf(comment);
    const commentUrl = `/v1/comments/${comment.json.id as string}`;
    const edited = await h.call('PATCH', commentUrl, {
      token: editor('ed-1'),
      headers: { 'If-Match': commentTag },
      body: { text: 'A reply, edited.' },
    });
    expect(edited.status, edited.text).toBe(200);
    expect(tagOf(edited)).not.toBe(commentTag);
    const stale = await h.call('PATCH', commentUrl, {
      token: editor('ed-1'),
      headers: { 'If-Match': commentTag },
      body: { text: 'Too late.' },
    });
    expect(stale.status).toBe(412);
  });

  it('a webhook subscription', async () => {
    const created = await h.call('POST', '/v1/webhooks', {
      token: h.apiKey,
      body: { url: 'https://hooks.example.test/pro-042', events: ['dep.document.changed.v1'] },
    });
    expect(created.status, created.text).toBe(201);
    const url = `/v1/webhooks/${created.json.id as string}`;
    const read = await h.call('GET', url, { token: h.apiKey });
    expect(read.status).toBe(200);
    const tag = tagOf(read);
    const updated = await h.call('PATCH', url, {
      token: h.apiKey,
      headers: { 'If-Match': tag },
      body: { events: ['dep.document.changed.v1', 'dep.thread.resolved.v1'] },
    });
    expect(updated.status, updated.text).toBe(200);
    expect(tagOf(updated)).not.toBe(tag);
    expect(tagOf(await h.call('GET', url, { token: h.apiKey }))).toBe(tagOf(updated));
  });
});
