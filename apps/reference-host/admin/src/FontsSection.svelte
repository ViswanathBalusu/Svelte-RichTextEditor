<!--
  Fonts of the tenant (UX-079; BE-048; owner decisions 62, 94, 95): the manifest, a font added with
  its licence declaration, and a font removed by its hash. The file is read in the page and sent as
  base64; the service checks it.
-->
<script lang="ts">
  import type { FontManifest, FontUpload } from './api.ts';
  import ConfirmButton from './ConfirmButton.svelte';
  import { attempt, type Ctx } from './ctx.ts';

  let { ctx }: { ctx: Ctx } = $props();
  let manifest = $state<FontManifest | null>(null);
  let file = $state<File | null>(null);
  let licence = $state('');
  let serverUse = $state(false);
  let removeHash = $state('');
  let input = $state<HTMLInputElement | null>(null);

  const MIME: Record<string, FontUpload['mime']> = {
    ttf: 'font/ttf',
    otf: 'font/otf',
    woff2: 'font/woff2',
  };

  async function load(): Promise<void> {
    await attempt(ctx, async () => {
      manifest = await ctx.client.getFonts();
    });
  }
  function base64(bytes: Uint8Array): string {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  }
  async function add(): Promise<void> {
    await attempt(ctx, async () => {
      if (file === null) throw new Error('Choose a font file (.ttf, .otf or .woff2).');
      const mime = MIME[file.name.split('.').pop()?.toLowerCase() ?? ''];
      if (mime === undefined) throw new Error('The file is .ttf, .otf or .woff2.');
      if (licence.trim() === '') throw new Error('The licence declaration is required.');
      const added = await ctx.client.addFont({
        filename: file.name,
        mime,
        content: base64(new Uint8Array(await file.arrayBuffer())),
        licence: licence.trim(),
        serverUse,
      });
      ctx.say(`Font added: ${added.family}, ${added.style}, ${added.sha256}.`);
      file = null;
      licence = '';
      serverUse = false;
      if (input !== null) input.value = '';
      manifest = await ctx.client.getFonts();
    });
  }
  async function remove(): Promise<void> {
    await attempt(ctx, async () => {
      const h = removeHash.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('The hash is 64 hexadecimal digits.');
      await ctx.client.removeFont(h);
      ctx.say('Font removed.');
      removeHash = '';
      manifest = await ctx.client.getFonts();
    });
  }
  void load();
</script>

<h2>Fonts</h2>
<p class="hint">
  A font you add is checked by the service. Without the server-use declaration it is shown on screen
  only and replaced in a PDF. Removing a font makes exports that use it fall back, with a warning.
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
        <th scope="col">Faces (style, SHA-256)</th>
      </tr>
    </thead>
    <tbody>
      {#each manifest.families as f (f.family + f.role)}
        <tr>
          <th scope="row">{f.family}</th>
          <td>{f.role}</td>
          <td>{f.licence}</td>
          <td>
            {#each f.faces as face (face.sha256 + face.style)}
              <div>{face.style}: <code>{face.sha256}</code></div>
            {/each}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<form
  onsubmit={(e) => {
    e.preventDefault();
    void add();
  }}
>
  <fieldset>
    <legend>Add a font</legend>
    <label>
      Font file
      <input
        type="file"
        accept=".ttf,.otf,.woff2"
        bind:this={input}
        onchange={(e) => (file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)}
        required
      />
    </label>
    <label>Licence declaration <input bind:value={licence} maxlength="200" required /></label>
    <label class="row">
      <input type="checkbox" bind:checked={serverUse} /> The licence allows use on a server (in a PDF)
    </label>
    <button type="submit" class="primary">Add font</button>
  </fieldset>
</form>

<form
  onsubmit={(e) => {
    e.preventDefault();
  }}
>
  <fieldset>
    <legend>Remove a font you added</legend>
    <label>SHA-256 of the file <input bind:value={removeHash} maxlength="64" /></label>
    <ConfirmButton label="Remove this font" onconfirm={remove} />
  </fieldset>
</form>
