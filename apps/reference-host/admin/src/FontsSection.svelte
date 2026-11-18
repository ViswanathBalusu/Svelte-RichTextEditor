<!-- The font manifest of the tenant, read only: the published API has no route to add a font. -->
<script lang="ts">
  import type { FontManifest } from './api.ts';
  import { attempt, type Ctx } from './ctx.ts';

  let { ctx }: { ctx: Ctx } = $props();
  let manifest = $state<FontManifest | null>(null);
  async function load(): Promise<void> {
    await attempt(ctx, async () => {
      manifest = await ctx.client.getFonts();
    });
  }
  void load();
</script>

<h2>Fonts</h2>
<p class="hint">
  Read only. The published API lists fonts and their licences; it has no route to add one yet.
</p>
{#if manifest === null}
  <p>Loading the font manifest.</p>
{:else}
  <p>Manifest version {manifest.version}. Default family: {manifest.defaultFamily ?? 'none'}.</p>
  <table>
    <caption class="hint">Font families</caption>
    <thead>
      <tr>
        <th scope="col">Family</th><th scope="col">Role</th><th scope="col">Licence</th>
        <th scope="col">Faces</th>
      </tr>
    </thead>
    <tbody>
      {#each manifest.families as f (f.family + f.role)}
        <tr>
          <th scope="row">{f.family}</th>
          <td>{f.role}</td>
          <td>{f.licence}</td>
          <td>{f.faces.map((x) => x.style).join(', ')}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
