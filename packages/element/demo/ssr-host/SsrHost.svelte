<!--
  A host page that is rendered on a server and then hydrated (FE-124 criterion 3). It imports the
  element's entry point at its top, so the server render runs that module where there is no DOM,
  which must not throw. The `<doc-editor>` tag is plain markup on the server: the element is
  upgraded in the browser, and the host gives it its backend after hydration.
-->
<script lang="ts">
  import '@docedit/element';

  let clicks = $state(0);
</script>

<section class="host-app">
  <h1>Server-rendered host</h1>
  <button type="button" id="host-button" onclick={() => clicks++}>Host clicks: {clicks}</button>
  <doc-editor id="ssr-editor"></doc-editor>
</section>
