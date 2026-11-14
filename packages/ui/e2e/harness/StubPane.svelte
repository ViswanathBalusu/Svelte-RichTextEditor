<!--
  A stand-in for a header pane (comments, catch-up), loaded on demand like a real one. It receives
  the core like a real pane; its text is an interface string from the shell's translator.
-->
<script lang="ts">
  import type { CoreApi } from '../../src/core-api.ts';
  import { useShell } from '../../src/context.ts';

  interface Props {
    core: CoreApi;
  }

  let props: Props = $props();
  const shell = useShell();
  const tr = $derived(shell?.strings.current);
  const ready = $derived(Boolean(props.core));
</script>

<div class="de-stub-pane" data-stub-pane data-ready={ready}>{tr?.t('pane.comments') ?? ''}</div>
