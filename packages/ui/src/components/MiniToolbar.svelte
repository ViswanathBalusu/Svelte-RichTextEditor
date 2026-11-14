<!--
  The mini toolbar (UX-010; 13 §2, §4): a small row of the common formatting commands, generated
  from the registry by miniToolbarItems, shown near a non-empty selection that the user may change.
  The parent decides when it shows (a selection, not dismissed, no other overlay open) and gives
  the point it sits at. Its buttons do not take the pointer's press, so the selection and the
  editing surface keep focus and no text input is intercepted. A command the permissions do not
  allow is listed disabled with its reason (UX-004); it runs nothing.
-->
<script lang="ts">
  import { miniToolbarItems } from '../commands/mini-toolbar.ts';
  import type { CommandView } from '../commands/types.ts';
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';

  interface Props {
    /** Where the toolbar sits, in viewport coordinates (above the selection's start). */
    anchor: { x: number; y: number };
  }

  let { anchor }: Props = $props();

  const shell = useShell()!;
  const snapshot = live(shell.registry.view);
  const tr = $derived(shell.strings.current);
  const items: CommandView[] = $derived(miniToolbarItems(snapshot.current.commands, false));

  function run(item: CommandView): void {
    const result = shell.registry.exec(item.id);
    if (!result.ran && !item.enabled && item.reasonKey) shell.announceText(tr.text(item.reasonKey));
  }
</script>

{#if items.length > 0}
  <div
    class="de-mini-toolbar"
    role="toolbar"
    aria-label={tr.t('toolbar.mini.label')}
    data-mini-toolbar
    lang={tr.locale}
    dir={tr.dir}
    style:inset-inline-start={`${Math.max(0, anchor.x)}px`}
    style:inset-block-start={`${Math.max(0, anchor.y - 44)}px`}
    onmousedown={(event) => event.preventDefault()}
  >
    {#each items as item (item.id)}
      <button
        type="button"
        class="de-mini-toolbar-button"
        tabindex="-1"
        data-command-id={item.id}
        aria-pressed={item.active === null ? undefined : item.active}
        aria-disabled={item.enabled ? undefined : 'true'}
        title={tr.text(item.entry.label)}
        aria-label={tr.text(item.entry.label)}
        onclick={() => run(item)}
      >
        {tr.text(item.entry.label)}
      </button>
    {/each}
  </div>
{/if}
