<!-- Retention of the tenant and of one document, and legal holds (UX-080; 08 §11). -->
<script lang="ts">
  import type { Hold, RetentionPolicy, RetentionView } from './api.ts';
  import { attempt, type Ctx } from './ctx.ts';

  let { ctx }: { ctx: Ctx } = $props();

  let tenant = $state<RetentionPolicy>({ mode: 'keep_all' });
  let tenantEtag = $state<string | null>(null);
  let tenantMode = $state<'keep_all' | 'thin_payloads'>('keep_all');
  let tenantDays = $state('');

  let docId = $state('');
  let docView = $state<RetentionView | null>(null);
  let docEtag = $state<string | null>(null);
  let docMode = $state<'keep_all' | 'thin_payloads'>('keep_all');
  let docDays = $state('');

  let holds = $state<Hold[]>([]);
  let nextCursor = $state<string | null>(null);
  let holdDoc = $state('');
  let holdReason = $state('');

  function policyOf(mode: 'keep_all' | 'thin_payloads', days: string): RetentionPolicy {
    if (mode === 'keep_all') return { mode };
    if (!/^\d{1,9}$/.test(days.trim()) || Number(days) < 1)
      throw new Error('Thin payloads needs a number of days, 1 or more.');
    return { mode, afterDays: Number(days) };
  }
  function describe(p: RetentionPolicy): string {
    return p.mode === 'keep_all' ? 'Keep everything' : `Thin payloads after ${p.afterDays} days`;
  }
  async function load(): Promise<void> {
    await attempt(ctx, async () => {
      const r = await ctx.client.getRetention();
      tenant = r.value;
      tenantEtag = r.etag;
      tenantMode = r.value.mode;
      tenantDays = r.value.afterDays === undefined ? '' : String(r.value.afterDays);
      const page = await ctx.client.listHolds();
      holds = page.items;
      nextCursor = page.nextCursor;
    });
  }
  async function saveTenant(): Promise<void> {
    await attempt(ctx, async () => {
      if (tenantEtag === null) throw new Error('The policy was not read yet.');
      const r = await ctx.client.setRetention(policyOf(tenantMode, tenantDays), tenantEtag);
      tenant = r.value;
      tenantEtag = r.etag;
      ctx.say('Tenant retention saved.');
    });
  }
  async function loadDoc(): Promise<void> {
    await attempt(ctx, async () => {
      const r = await ctx.client.getDocumentRetention(docId.trim());
      docView = r.value;
      docEtag = r.etag;
      docMode = r.value.effective.mode;
      docDays = r.value.effective.afterDays === undefined ? '' : String(r.value.effective.afterDays);
    });
  }
  async function saveDoc(): Promise<void> {
    await attempt(ctx, async () => {
      if (docEtag === null) throw new Error('Read the document policy first.');
      const r = await ctx.client.setDocumentRetention(
        docId.trim(),
        policyOf(docMode, docDays),
        docEtag,
      );
      docView = r.value;
      docEtag = r.etag;
      ctx.say('Document retention saved.');
    });
  }
  async function place(): Promise<void> {
    await attempt(ctx, async () => {
      await ctx.client.placeHold(holdDoc.trim(), holdReason);
      ctx.say('Legal hold placed.');
      holdDoc = '';
      holdReason = '';
      const page = await ctx.client.listHolds();
      holds = page.items;
      nextCursor = page.nextCursor;
    });
  }
  async function more(): Promise<void> {
    await attempt(ctx, async () => {
      if (nextCursor === null) return;
      const page = await ctx.client.listHolds(nextCursor);
      holds = [...holds, ...page.items];
      nextCursor = page.nextCursor;
    });
  }
  void load();
</script>

<h2>Retention and legal holds</h2>

<h3>Tenant policy</h3>
<p>Now: <strong>{describe(tenant)}</strong></p>
<form
  onsubmit={(e) => {
    e.preventDefault();
    void saveTenant();
  }}
>
  <label>
    Mode
    <select bind:value={tenantMode}>
      <option value="keep_all">Keep everything</option>
      <option value="thin_payloads">Thin payloads</option>
    </select>
  </label>
  {#if tenantMode === 'thin_payloads'}
    <label>Days before thinning <input inputmode="numeric" bind:value={tenantDays} /></label>
  {/if}
  <button type="submit" class="primary">Save tenant policy</button>
</form>

<h3>One document</h3>
<form
  onsubmit={(e) => {
    e.preventDefault();
    void loadDoc();
  }}
>
  <label>Document id <input bind:value={docId} required /></label>
  <button type="submit">Show policy</button>
</form>
{#if docView !== null}
  <p>
    Effective: <strong>{describe(docView.effective)}</strong> (from the {docView.source} policy).
  </p>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void saveDoc();
    }}
  >
    <label>
      Mode for this document
      <select bind:value={docMode}>
        <option value="keep_all">Keep everything</option>
        <option value="thin_payloads">Thin payloads</option>
      </select>
    </label>
    {#if docMode === 'thin_payloads'}
      <label>Days before thinning <input inputmode="numeric" bind:value={docDays} /></label>
    {/if}
    <button type="submit" class="primary">Save document policy</button>
  </form>
{/if}

<h3>Legal holds</h3>
{#if holds.length === 0}
  <p>No document is under hold.</p>
{:else}
  <table>
    <caption class="hint">Documents under legal hold</caption>
    <thead>
      <tr>
        <th scope="col">Document</th><th scope="col">Reason</th><th scope="col">Placed by</th>
        <th scope="col">Placed at</th>
      </tr>
    </thead>
    <tbody>
      {#each holds as h (h.id)}
        <tr>
          <th scope="row"><code>{h.document}</code></th>
          <td>{h.reason}</td>
          <td>{h.placedBy}</td>
          <td>{h.placedAt}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if nextCursor !== null}<button type="button" onclick={() => void more()}>Show more holds</button>{/if}
{/if}
<form
  onsubmit={(e) => {
    e.preventDefault();
    void place();
  }}
>
  <fieldset>
    <legend>Place a hold</legend>
    <label>Document id <input bind:value={holdDoc} required /></label>
    <label>Reason (1 to 500 characters) <input bind:value={holdReason} maxlength="500" required /></label>
    <button type="submit" class="primary">Place hold</button>
  </fieldset>
</form>
<p class="hint">The published API has no route to release a hold.</p>
