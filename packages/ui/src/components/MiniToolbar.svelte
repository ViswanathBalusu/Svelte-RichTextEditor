<!--
  The mini toolbar (UX-010; 13 §2, §4): a small row of the common formatting commands, generated
  from the registry by miniToolbarItems, shown near a non-empty selection that the user may change.
  The parent decides when it shows (a selection, not dismissed, no other overlay open) and gives
  the point it sits at. Its buttons do not take the pointer's press, so the selection and the
  editing surface keep focus and no text input is intercepted. A command the permissions do not
  allow is listed disabled with its reason (UX-004); it runs nothing.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { miniToolbarItems } from '../commands/mini-toolbar.ts';
  import type { CommandView } from '../commands/types.ts';
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import Icon from './Icon.svelte';

  interface Props {
    /** Where the toolbar sits, in viewport coordinates (above the selection's start). */
    anchor: { x: number; y: number };
  }

  let { anchor }: Props = $props();

  const shell = useShell()!;
  const snapshot = live(shell.registry.view);
  const tr = $derived(shell.strings.current);
  const items: CommandView[] = $derived(miniToolbarItems(snapshot.current.commands, false));

  // The toolbar is shown in the top layer, so `fixed` is measured against the viewport even inside
  // the element's `contain: content` host. Without the Popover API it is placed against its
  // containing block, which containment moves: the offset is measured once and taken out.
  let offset = $state({ x: 0, y: 0 });
  const ABOVE_GAP = 44;

  function show(node: HTMLElement) {
    const popover = node as HTMLElement & { showPopover?: () => void; hidePopover?: () => void };
    if (typeof popover.showPopover === 'function') popover.showPopover();
    else node.removeAttribute('popover');
    void tick().then(() => {
      const a = untrack(() => anchor);
      const rtl = getComputedStyle(node).direction === 'rtl';
      const at = node.getBoundingClientRect();
      const intendedX = Math.max(0, a.x);
      const intendedY = Math.max(0, a.y - ABOVE_GAP);
      const dx = rtl ? at.right - (innerWidth - intendedX) : at.left - intendedX;
      const dy = at.top - intendedY;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) offset = { x: rtl ? -dx : dx, y: dy };
    });
    return () => {
      try {
        popover.hidePopover?.();
      } catch {
        // Already hidden.
      }
    };
  }

  function run(item: CommandView): void {
    const result = shell.registry.exec(item.id);
    if (!result.ran && !item.enabled && item.reasonKey) shell.announceText(tr.text(item.reasonKey));
  }
</script>

{#if items.length > 0}
  <div
    {@attach show}
    class="de-mini-toolbar"
    popover="manual"
    role="toolbar"
    aria-label={tr.t('toolbar.mini.label')}
    data-mini-toolbar
    lang={tr.locale}
    dir={tr.dir}
    style:inset-inline-start={`${Math.max(0, anchor.x) - offset.x}px`}
    style:inset-block-start={`${Math.max(0, anchor.y - ABOVE_GAP) - offset.y}px`}
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
        <Icon name={item.entry.icon} />{tr.text(item.entry.label)}
      </button>
    {/each}
  </div>
{/if}
