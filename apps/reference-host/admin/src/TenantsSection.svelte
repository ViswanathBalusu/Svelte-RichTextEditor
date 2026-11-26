<!--
  The tenants of the service (UX-076, UX-089): an operator function. It is offered only when an
  operator credential was given at the connection; a tenant administrator has none. Suspending a
  tenant needs a second press.
-->
<script lang="ts">
  import type { TenantView } from './api.ts';
  import ConfirmButton from './ConfirmButton.svelte';
  import { attempt, type Ctx } from './ctx.ts';

  let { ctx }: { ctx: Ctx } = $props();
  let tenants = $state<TenantView[]>([]);
  let nextCursor = $state<string | null>(null);
  let newName = $state('');
  let renames = $state<Record<string, string>>({});

  async function load(): Promise<void> {
    await attempt(ctx, async () => {
      const page = await ctx.client.listTenants();
      tenants = page.items;
      nextCursor = page.nextCursor;
    });
  }
  async function more(): Promise<void> {
    await attempt(ctx, async () => {
      if (nextCursor === null) return;
      const page = await ctx.client.listTenants(nextCursor);
      tenants = [...tenants, ...page.items];
      nextCursor = page.nextCursor;
    });
  }
  async function create(): Promise<void> {
    await attempt(ctx, async () => {
      const made = await ctx.client.createTenant(newName.trim());
      ctx.say(`Tenant registered: ${made.name}.`);
      newName = '';
      await load();
    });
  }
  async function change(
    t: TenantView,
    update: { name?: string; state?: 'active' | 'suspended' },
    message: string,
  ): Promise<void> {
    await attempt(ctx, async () => {
      const current = await ctx.client.getTenant(t.id);
      if (current.etag === null) throw new Error('The tenant has no version to change.');
      await ctx.client.updateTenant(t.id, update, current.etag);
      ctx.say(message);
      renames[t.id] = '';
      await load();
    });
  }
  void load();
</script>

<h2>Tenants</h2>
<p class="hint">
  For an operator. A suspended tenant cannot be used until it is resumed. Both changes are audited.
</p>
{#if tenants.length === 0}
  <p>No tenant is registered.</p>
{:else}
  <table>
    <caption class="hint">Tenants of the service</caption>
    <thead>
      <tr>
        <th scope="col">Name</th><th scope="col">Identifier</th><th scope="col">State</th>
        <th scope="col">Registered</th><th scope="col">Rename</th>
        <th scope="col">Suspend or resume</th>
      </tr>
    </thead>
    <tbody>
      {#each tenants as t (t.id)}
        <tr>
          <th scope="row">{t.name}</th>
          <td><code>{t.id}</code></td>
          <td>{t.state === 'active' ? 'Active' : 'Suspended'}</td>
          <td>{t.createdAt}</td>
          <td>
            <form
              class="row"
              onsubmit={(e) => {
                e.preventDefault();
                void change(t, { name: (renames[t.id] ?? '').trim() }, 'Tenant renamed.');
              }}
            >
              <input
                aria-label={`New name for ${t.name}`}
                value={renames[t.id] ?? ''}
                oninput={(e) => (renames[t.id] = e.currentTarget.value)}
                required
              />
              <button type="submit">Rename</button>
            </form>
          </td>
          <td>
            {#if t.state === 'active'}
              <ConfirmButton
                label={`Suspend ${t.name}`}
                onconfirm={() => change(t, { state: 'suspended' }, 'Tenant suspended.')}
              />
            {:else}
              <button
                type="button"
                onclick={() => void change(t, { state: 'active' }, 'Tenant resumed.')}
                >Resume {t.name}</button
              >
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if nextCursor !== null}
    <button type="button" onclick={() => void more()}>Show more tenants</button>
  {/if}
{/if}
<form
  onsubmit={(e) => {
    e.preventDefault();
    void create();
  }}
>
  <fieldset>
    <legend>Register a tenant</legend>
    <label>Name <input bind:value={newName} required /></label>
    <button type="submit" class="primary">Register tenant</button>
  </fieldset>
</form>
