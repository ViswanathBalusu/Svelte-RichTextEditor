<!--
  One icon of a command (UX-063). Drawn from path data into an `<svg>` the shell makes, never from
  host markup. It is hidden from assistive technology: the control's name comes from its label,
  never from the icon (13 §8). Nothing is drawn for a name without a drawing.
-->
<script lang="ts">
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import { DEFAULT_VIEW_BOX, noIcons } from '../icons/icons.ts';

  interface Props {
    /** The command's icon name (`CommandEntry.icon`). */
    name: string | undefined;
  }

  let { name }: Props = $props();

  const shell = useShell();
  const set = shell?.icons ? live(shell.icons) : null;
  const drawing = $derived((set?.current ?? noIcons()).resolve(name));
</script>

{#if drawing}
  <svg
    class="de-icon"
    class:de-icon-fill={drawing.fill === true}
    viewBox={drawing.viewBox ?? DEFAULT_VIEW_BOX}
    aria-hidden="true"
    focusable="false"
    data-icon={name}
  >
    {#each drawing.paths as d (d)}
      <path {d} />
    {/each}
  </svg>
{/if}
