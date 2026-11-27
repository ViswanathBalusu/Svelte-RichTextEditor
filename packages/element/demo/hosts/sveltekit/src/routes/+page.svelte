<!--
  The SvelteKit host (FE-124 criterion 1): a route of a SvelteKit application, built with Vite and
  routed on the client. It loads the element's bundle on demand, then renders a <doc-editor> that
  Svelte gives its document and backend, next to a button of the host's own.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { startHost, type HostFixtures } from '../../../fixtures.ts';

  // Raw state: the status object is shared with `globalThis.__host` and must not be proxied.
  let host = $state.raw<HostFixtures | null>(null);
  let clicks = $state(0);

  onMount(() => {
    void startHost('sveltekit', 'svelte 5 with the SvelteKit router').then((started) => {
      host = started;
    });
  });

  $effect(() => {
    if (host) host.status.rendered = true;
  });
</script>

<main>
  <button type="button" id="host-button" onclick={() => clicks++}>Host clicks: {clicks}</button>
  {#if clicks > 0}
    <p id="host-clicked">Clicked {clicks} times</p>
  {/if}
  {#if host}
    <doc-editor data-test="host" doc-id={host.docId} backend={host.backend}
    ></doc-editor>
  {/if}
</main>
