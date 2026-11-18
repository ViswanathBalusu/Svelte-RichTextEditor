<!-- Public keys that verify the host's tokens (UX-077; 05 §3). Only public keys are accepted. -->
<script lang="ts">
  import type { TenantKey } from './api.ts';
  import ConfirmButton from './ConfirmButton.svelte';
  import { attempt, type Ctx } from './ctx.ts';

  let { ctx }: { ctx: Ctx } = $props();
  let keys = $state<TenantKey[]>([]);
  let kid = $state('');
  let use = $state<'user' | 'service'>('user');
  let alg = $state<'ES256' | 'EdDSA' | 'RS256'>('ES256');
  let issuer = $state('');
  let jwk = $state('');

  async function load(): Promise<void> {
    await attempt(ctx, async () => {
      keys = await ctx.client.listKeys();
    });
  }
  async function register(): Promise<void> {
    await attempt(ctx, async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(jwk);
      } catch {
        throw new Error('The key is not valid JSON.');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('The key must be a JSON object (a JWK).');
      const id = kid.trim();
      await ctx.client.registerKey({
        kid: id,
        use,
        alg,
        jwk: parsed as Record<string, unknown>,
        ...(issuer.trim() === '' ? {} : { issuer: issuer.trim() }),
      });
      ctx.say(`Key ${id} registered.`);
      kid = '';
      jwk = '';
      issuer = '';
      keys = await ctx.client.listKeys();
    });
  }
  async function remove(k: string): Promise<void> {
    await attempt(ctx, async () => {
      await ctx.client.removeKey(k);
      ctx.say(`Key ${k} removed. Tokens signed by it are refused now.`);
      keys = await ctx.client.listKeys();
    });
  }
  void load();
</script>

<h2>Token keys</h2>
<p class="hint">
  Add the new key before you remove the old one: tokens from both verify during the overlap. A
  removed key's tokens are refused at once.
</p>
{#if keys.length === 0}
  <p>No key is registered.</p>
{:else}
  <table>
    <caption class="hint">Registered public keys</caption>
    <thead>
      <tr>
        <th scope="col">Key id</th><th scope="col">Use</th><th scope="col">Algorithm</th>
        <th scope="col">Thumbprint</th><th scope="col">Issuer</th><th scope="col">Action</th>
      </tr>
    </thead>
    <tbody>
      {#each keys as k (k.kid)}
        <tr>
          <th scope="row">{k.kid}</th>
          <td>{k.use}</td>
          <td>{k.alg}</td>
          <td><code>{k.thumbprint}</code></td>
          <td>{k.issuer ?? 'none'}</td>
          <td><ConfirmButton label={`Remove key ${k.kid}`} onconfirm={() => remove(k.kid)} /></td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
<form
  onsubmit={(e) => {
    e.preventDefault();
    void register();
  }}
>
  <fieldset>
    <legend>Register a public key</legend>
    <label>Key id <input bind:value={kid} required /></label>
    <label>
      Use
      <select bind:value={use}>
        <option value="user">user</option>
        <option value="service">service</option>
      </select>
    </label>
    <label>
      Algorithm
      <select bind:value={alg}>
        <option>ES256</option>
        <option>EdDSA</option>
        <option>RS256</option>
      </select>
    </label>
    <label>Issuer (optional) <input bind:value={issuer} /></label>
    <label>Public key (JWK) <textarea rows="5" bind:value={jwk} required></textarea></label>
    <button type="submit" class="primary">Register key</button>
  </fieldset>
</form>
