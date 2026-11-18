<!-- The audit viewer (UX-081; 07 §14): filters, one page at a time, "Show more" follows the cursor. -->
<script lang="ts">
  import type { AuditFilters, AuditItem } from './api.ts';
  import { attempt, type Ctx } from './ctx.ts';

  let { ctx }: { ctx: Ctx } = $props();
  let document = $state('');
  let actor = $state('');
  let kind = $state('');
  let from = $state('');
  let to = $state('');
  let items = $state<AuditItem[]>([]);
  let nextCursor = $state<string | null>(null);
  let searched = $state(false);

  function filters(cursor?: string): AuditFilters {
    const f: AuditFilters = { limit: 50 };
    if (document.trim() !== '') f.document = document.trim();
    if (actor.trim() !== '') f.actor = actor.trim();
    if (kind.trim() !== '') f.kind = kind.trim();
    if (from.trim() !== '') f.from = from.trim();
    if (to.trim() !== '') f.to = to.trim();
    if (cursor !== undefined) f.cursor = cursor;
    return f;
  }
  async function search(): Promise<void> {
    await attempt(ctx, async () => {
      const page = await ctx.client.queryAudit(filters());
      items = page.items;
      nextCursor = page.nextCursor;
      searched = true;
      ctx.say(`${page.items.length} events.`);
    });
  }
  async function more(): Promise<void> {
    await attempt(ctx, async () => {
      if (nextCursor === null) return;
      const page = await ctx.client.queryAudit(filters(nextCursor));
      items = [...items, ...page.items];
      nextCursor = page.nextCursor;
    });
  }
  void search();
</script>

<h2>Audit trail</h2>
<form
  onsubmit={(e) => {
    e.preventDefault();
    void search();
  }}
>
  <fieldset>
    <legend>Filters</legend>
    <label>Document id <input bind:value={document} /></label>
    <label>Actor <input bind:value={actor} /></label>
    <label>Event kind <input bind:value={kind} placeholder="quota.changed" /></label>
    <label>From (ISO 8601, with a zone) <input bind:value={from} placeholder="2026-11-01T00:00:00Z" /></label>
    <label>To (ISO 8601, with a zone) <input bind:value={to} /></label>
    <button type="submit" class="primary">Search the audit trail</button>
  </fieldset>
</form>
{#if searched && items.length === 0}
  <p>No event matches.</p>
{:else if items.length > 0}
  <table>
    <caption class="hint">Audit events, newest first</caption>
    <thead>
      <tr>
        <th scope="col">Time (UTC)</th><th scope="col">Kind</th><th scope="col">Actor</th>
        <th scope="col">Document</th><th scope="col">Scopes</th>
      </tr>
    </thead>
    <tbody>
      {#each items as e (e.id)}
        <tr>
          <th scope="row">{e.at}</th>
          <td>{e.kind}</td>
          <td>{e.actor}</td>
          <td>{e.document ?? 'none'}</td>
          <td>{e.scopes.join(', ')}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if nextCursor !== null}<button type="button" onclick={() => void more()}>Show more events</button>{/if}
{/if}
