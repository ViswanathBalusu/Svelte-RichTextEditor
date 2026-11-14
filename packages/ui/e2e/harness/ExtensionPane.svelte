<!--
  The extension panel the harness contributes (UX-052). It is loaded on demand, when the panel is
  first opened. Its text is the extension's own, not an interface string of the host.
-->
<script lang="ts">
  import type { CoreApi } from '../../src/core-api.ts';

  interface Props {
    core: CoreApi;
  }

  let props: Props = $props();
  const ready = $derived(Boolean(props.core));
</script>

<div class="de-extension-pane" data-extension-pane data-ready={ready}>
  <p>Notes from the extension.</p>
  <button type="button">Extension action</button>
</div>
