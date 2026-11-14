<!--
  A host application with its own Svelte 5, compiled with Svelte's defaults (templates built from
  HTML strings through Svelte's `svelte-trusted-html` policy). Spike S2 puts <doc-editor> next to it.
-->
<script lang="ts">
  let clicks = $state(0);
</script>

<section class="host-app">
  <h2>Host application</h2>
  <button type="button" id="host-button" onclick={() => clicks++}>Host clicks: {clicks}</button>
  {#if clicks > 0}
    <p id="host-clicked">Clicked {clicks} times</p>
  {/if}
</section>
