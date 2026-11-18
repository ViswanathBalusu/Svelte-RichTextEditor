<!-- Quotas of the tenant (UX-078): the seven dimensions of 06 §12. A blank field is left as it is. -->
<script lang="ts">
  import { parseQuota, QUOTA_NAMES, type QuotaName, type QuotaSettings } from './api.ts';
  import { attempt, type Ctx } from './ctx.ts';

  let { ctx }: { ctx: Ctx } = $props();
  const LABELS: Record<QuotaName, string> = {
    connections: 'Connections',
    openDocuments: 'Open documents',
    commitRate: 'Commit rate',
    roomCpuBudget: 'Room CPU budget',
    storage: 'Storage',
    exportConcurrency: 'Export concurrency',
    exportMinutes: 'Export minutes',
  };
  let current = $state<QuotaSettings | null>(null);
  let etag = $state<string | null>(null);
  let fields = $state<Record<QuotaName, string>>(blank());

  function blank(): Record<QuotaName, string> {
    return Object.fromEntries(QUOTA_NAMES.map((n) => [n, ''])) as Record<QuotaName, string>;
  }
  async function load(): Promise<void> {
    await attempt(ctx, async () => {
      const r = await ctx.client.getQuotas();
      current = r.value;
      etag = r.etag;
      fields = blank();
    });
  }
  async function save(): Promise<void> {
    await attempt(ctx, async () => {
      const change: Partial<QuotaSettings> = {};
      for (const n of QUOTA_NAMES) {
        const p = parseQuota(fields[n]);
        if (!p.ok) throw new Error(`${LABELS[n]} must be a whole number of 0 or more.`);
        if (p.value !== null) change[n] = p.value;
      }
      if (Object.keys(change).length === 0) throw new Error('Enter at least one value to change.');
      if (etag === null) throw new Error('The quotas were not read yet.');
      const r = await ctx.client.setQuotas(change, etag);
      current = r.value;
      etag = r.etag;
      fields = blank();
      ctx.say('Quotas saved.');
    });
  }
  void load();
</script>

<h2>Quotas</h2>
<p class="hint">
  Whole numbers, 0 or more. A blank field keeps the present value. Usage figures are not in the
  published administration API yet.
</p>
<form
  onsubmit={(e) => {
    e.preventDefault();
    void save();
  }}
>
  <table>
    <caption class="hint">Present values and new values</caption>
    <thead>
      <tr><th scope="col">Quota</th><th scope="col">Now</th><th scope="col">New value</th></tr>
    </thead>
    <tbody>
      {#each QUOTA_NAMES as n (n)}
        <tr>
          <th scope="row">{LABELS[n]}</th>
          <td>{current === null ? '' : (current[n] ?? 'not set')}</td>
          <td>
            <input
              id={`quota-${n}`}
              aria-label={`New ${LABELS[n]}`}
              inputmode="numeric"
              bind:value={fields[n]}
            />
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  <button type="submit" class="primary">Save quotas</button>
</form>
