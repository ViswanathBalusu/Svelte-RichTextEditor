<!-- Allowed origins of the tenant (UX-077; 05 §4). -->
<script lang="ts">
  import ConfirmButton from './ConfirmButton.svelte';
  import { attempt, type Ctx } from './ctx.ts';

  let { ctx }: { ctx: Ctx } = $props();
  let origins = $state<string[]>([]);
  let origin = $state('');

  async function load(): Promise<void> {
    await attempt(ctx, async () => {
      origins = await ctx.client.listOrigins();
    });
  }
  async function add(): Promise<void> {
    await attempt(ctx, async () => {
      const o = origin.trim();
      await ctx.client.addOrigin(o);
      ctx.say(`Origin ${o} added.`);
      origin = '';
      origins = await ctx.client.listOrigins();
    });
  }
  async function remove(o: string): Promise<void> {
    await attempt(ctx, async () => {
      await ctx.client.removeOrigin(o);
      ctx.say(`Origin ${o} removed.`);
      origins = await ctx.client.listOrigins();
    });
  }
  void load();
</script>

<h2>Allowed origins</h2>
<p class="hint">Pages from these origins may connect. Write scheme, host and port only.</p>
{#if origins.length === 0}
  <p>No origin is allowed.</p>
{:else}
  <ul>
    {#each origins as o (o)}
      <li>
        <code>{o}</code>
        <ConfirmButton label={`Remove origin ${o}`} onconfirm={() => remove(o)} />
      </li>
    {/each}
  </ul>
{/if}
<form
  onsubmit={(e) => {
    e.preventDefault();
    void add();
  }}
>
  <label>
    New origin
    <input bind:value={origin} placeholder="https://app.example.com" required />
  </label>
  <button type="submit" class="primary">Add origin</button>
</form>
