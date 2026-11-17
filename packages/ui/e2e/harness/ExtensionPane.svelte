<!--
  The extension panel the harness contributes (UX-052). It is loaded on demand, when the panel is
  first opened. Its text is the extension's own, not an interface string of the host.

  Its colours read the public `--de-` properties (criterion 5). The page runs under the strict
  policy, which refuses a style attribute and a style element, so the panel sets them through the
  CSS object model, as an extension of tier 1 would.
-->
<script lang="ts">
  import type { CoreApi } from '../../src/core-api.ts';

  interface Props {
    core: CoreApi;
  }

  let props: Props = $props();
  const ready = $derived(Boolean(props.core));

  function useProperties(node: HTMLElement) {
    node.style.setProperty('color', 'var(--de-text)');
    node.style.setProperty('background-color', 'var(--de-surface)');
  }
</script>

<div class="de-extension-pane" data-extension-pane data-ready={ready} {@attach useProperties}>
  <p>Notes from the extension.</p>
  <button type="button">Extension action</button>
</div>
