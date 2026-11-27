<!--
  One icon of a command (UX-063). Drawn from path data into an `<svg>` the shell makes, never from
  host markup. It is hidden from assistive technology: the control's name comes from its label,
  never from the icon (13 §8). Nothing is drawn for a name without a drawing.

  The ribbon layout (ADR 0490) shows an icon over every label: it gives `extra`, its own drawings,
  and then a name that the host's set lacks falls back to the built-in set and to `extra`, so a host
  that gave no set still gets icons there.
-->
<script lang="ts">
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import { DEFAULT_VIEW_BOX, builtInIcons, noIcons, type IconDrawing } from '../icons/icons.ts';

  interface Props {
    /** The command's icon name (`CommandEntry.icon`). */
    name: string | undefined;
    /** The ribbon's own drawings; when given, icons are drawn whether or not the host gave a set. */
    extra?: Readonly<Record<string, IconDrawing>> | undefined;
  }

  let { name, extra }: Props = $props();

  const shell = useShell();
  const set = shell?.icons ? live(shell.icons) : null;
  const drawing = $derived.by(() => {
    const own = (set?.current ?? noIcons()).resolve(name);
    if (own || !extra) return own;
    return (
      builtInIcons().resolve(name) ??
      (name !== undefined && Object.hasOwn(extra, name) ? extra[name]! : null)
    );
  });
</script>

{#if drawing}
  <svg
    class="de-icon"
    class:de-icon-fill={drawing.fill === true}
    class:de-icon-mirror={drawing.mirrorInRtl === true}
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
