<!-- Webhook subscriptions: create, change, rotate the secret, test, replay, delete (UX-079; 05 §7). -->
<script lang="ts">
  import type { WebhookView } from './api.ts';
  import ConfirmButton from './ConfirmButton.svelte';
  import { attempt, type Ctx } from './ctx.ts';

  let { ctx }: { ctx: Ctx } = $props();
  let hooks = $state<WebhookView[]>([]);
  let nextCursor = $state<string | null>(null);
  let url = $state('');
  let events = $state('dep.document.changed.v1');
  let shownSecret = $state<{ id: string; secret: string } | null>(null);
  let replayId = $state<Record<string, string>>({});

  const eventList = (text: string): string[] =>
    text
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  async function reload(): Promise<void> {
    const page = await ctx.client.listWebhooks();
    hooks = page.items;
    nextCursor = page.nextCursor;
  }
  async function create(): Promise<void> {
    await attempt(ctx, async () => {
      const w = await ctx.client.createWebhook(url.trim(), eventList(events));
      if (w.secret !== undefined) shownSecret = { id: w.id, secret: w.secret };
      ctx.say('Webhook created. Copy its secret now: it is shown once.');
      url = '';
      await reload();
    });
  }
  async function change(w: WebhookView, change: { rotate?: true; retire?: true }): Promise<void> {
    await attempt(ctx, async () => {
      const r = await ctx.client.updateWebhook(w.id, change);
      if (r.secret !== undefined) shownSecret = { id: r.id, secret: r.secret };
      ctx.say(change.rotate ? 'Secret rotated. Copy the new secret now.' : 'Old secret retired.');
      await reload();
    });
  }
  async function ping(w: WebhookView): Promise<void> {
    await attempt(ctx, async () => {
      const d = await ctx.client.pingWebhook(w.id);
      ctx.say(`Test delivery ${d} sent to ${w.url}.`);
    });
  }
  async function replay(w: WebhookView): Promise<void> {
    await attempt(ctx, async () => {
      const id = (replayId[w.id] ?? '').trim();
      if (id === '') throw new Error('Enter the delivery id to replay.');
      const d = await ctx.client.replayWebhookDelivery(w.id, id);
      ctx.say(`Delivery ${id} replayed as ${d}.`);
    });
  }
  async function remove(w: WebhookView): Promise<void> {
    await attempt(ctx, async () => {
      await ctx.client.deleteWebhook(w.id);
      ctx.say(`Webhook ${w.url} deleted.`);
      await reload();
    });
  }
  async function more(): Promise<void> {
    await attempt(ctx, async () => {
      if (nextCursor === null) return;
      const page = await ctx.client.listWebhooks(nextCursor);
      hooks = [...hooks, ...page.items];
      nextCursor = page.nextCursor;
    });
  }
  async function load(): Promise<void> {
    await attempt(ctx, reload);
  }
  void load();
</script>

<h2>Webhooks</h2>
{#if shownSecret !== null}
  <div role="group" aria-label="New secret" class="msg">
    Secret for {shownSecret.id}: <code>{shownSecret.secret}</code>
    <button type="button" onclick={() => (shownSecret = null)}>Hide the secret</button>
  </div>
{/if}
{#if hooks.length === 0}
  <p>No webhook is registered.</p>
{:else}
  <ul>
    {#each hooks as w (w.id)}
      <li>
        <p>
          <strong><code>{w.url}</code></strong><br />
          Events: {w.events.join(', ') || 'none'}. Active secrets: {w.activeSecrets}.
        </p>
        <div class="row">
          <button type="button" onclick={() => void ping(w)}>Send test to {w.url}</button>
          {#if w.activeSecrets < 2}
            <button type="button" onclick={() => void change(w, { rotate: true })}>
              Rotate secret of {w.url}
            </button>
          {:else}
            <button type="button" onclick={() => void change(w, { retire: true })}>
              Retire old secret of {w.url}
            </button>
          {/if}
          <ConfirmButton label={`Delete webhook ${w.url}`} onconfirm={() => remove(w)} />
        </div>
        <form
          class="row"
          onsubmit={(e) => {
            e.preventDefault();
            void replay(w);
          }}
        >
          <label>
            Delivery id to replay for {w.url}
            <input bind:value={replayId[w.id]} />
          </label>
          <button type="submit">Replay</button>
        </form>
      </li>
    {/each}
  </ul>
  {#if nextCursor !== null}<button type="button" onclick={() => void more()}>Show more webhooks</button>{/if}
{/if}
<form
  onsubmit={(e) => {
    e.preventDefault();
    void create();
  }}
>
  <fieldset>
    <legend>Add a webhook</legend>
    <label>Address (https) <input type="url" bind:value={url} required /></label>
    <label>Events (separated by spaces or commas) <input bind:value={events} /></label>
    <button type="submit" class="primary">Create webhook</button>
  </fieldset>
</form>
