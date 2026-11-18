<!--
  The mark beside text an assistant wrote for a person (HIS-017). It is always drawn, whether or
  not the host turned command icons on, because it is one of the two things that tell assistant text
  from a person's own writing: the words carry the meaning and the mark makes it easy to see, so
  neither relies on colour. The host may replace the drawing under the name `assistant`. It is hidden
  from assistive technology; the words beside it are read.
-->
<script lang="ts">
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import { BUILT_IN_ICONS, DEFAULT_VIEW_BOX, noIcons } from '../icons/icons.ts';

  const shell = useShell();
  const set = shell?.icons ? live(shell.icons) : null;
  const drawing = $derived(
    (set?.current ?? noIcons()).resolve('assistant') ?? BUILT_IN_ICONS['assistant']!,
  );
</script>

<svg
  class="de-icon"
  class:de-icon-fill={drawing.fill === true}
  viewBox={drawing.viewBox ?? DEFAULT_VIEW_BOX}
  aria-hidden="true"
  focusable="false"
  data-icon="assistant"
>
  {#each drawing.paths as d (d)}
    <path {d} />
  {/each}
</svg>
