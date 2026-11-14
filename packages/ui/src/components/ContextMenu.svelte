<!--
  The context menu (UX-008; 13 §4; 02 §3 overlays): generated from the registry, with the commands
  whose entries name the target it opened on (text, or a table, picture, header or footer, field
  or comment the selection is in). It opens at the pointer, or at the caret from the keyboard
  (Shift+F10 or the context-menu key). Arrow keys, Home and End move, Enter and Space run, Escape
  and Tab close; focus goes back to the editing surface. A command the permissions do not allow is
  listed disabled, with its reason (UX-004).

  It lives in the shadow root and is shown in the top layer with the Popover API where the browser
  has it, so no containment of the host clips it.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { on } from 'svelte/events';
  import { ariaShortcuts, isApplePlatform } from '../commands/keys.ts';
  import type { CommandView, ContextTarget } from '../commands/types.ts';
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import { boundKeys } from '../shortcuts/table.ts';
  import { contextMenuGroups, placeMenu } from '../shell/toolbar-groups.ts';

  interface Props {
    /** Where it opened, in viewport coordinates. */
    point: { x: number; y: number };
    targets: readonly ContextTarget[];
    /** Closes the menu; `restore` puts focus back in the editing surface. */
    onClose: (restore: boolean) => void;
  }

  let { point, targets, onClose }: Props = $props();

  const shell = useShell()!;
  const snapshot = live(shell.registry.view);
  const tr = $derived(shell.strings.current);
  const apple = isApplePlatform();
  const id = `${shell.idPrefix}-context-menu`;

  const groups = $derived(contextMenuGroups(snapshot.current.commands, targets));
  const items: CommandView[] = $derived(groups.flatMap((g) => g.commands));

  let menu: HTMLElement | undefined = $state();
  let index = $state(0);
  let placement = $state({ inlineStart: 0, blockStart: 0 });

  function itemsIn(): HTMLElement[] {
    return menu ? [...menu.querySelectorAll<HTMLElement>('[data-menu-item]')] : [];
  }

  function focusItem(i: number): void {
    const list = itemsIn();
    if (list.length === 0) return;
    index = ((i % list.length) + list.length) % list.length;
    list[index]?.focus();
  }

  function show(node: HTMLElement) {
    const popover = node as HTMLElement & { showPopover?: () => void; hidePopover?: () => void };
    // Without the Popover API the UA stylesheet hides every [popover] element that is not open,
    // so the attribute is removed and the menu is shown by its own CSS (FE-020 criterion 2).
    if (typeof popover.showPopover === 'function') popover.showPopover();
    else node.removeAttribute('popover');
    const rect = node.getBoundingClientRect();
    const rtl = getComputedStyle(node).direction === 'rtl';
    const p = untrack(() => point);
    const intended = placeMenu(
      p,
      { width: rect.width, height: rect.height },
      { width: innerWidth, height: innerHeight },
      rtl,
    );
    placement = intended;
    void tick().then(() => {
      // A `fixed` menu without the top layer is placed against its containing block, which an
      // ancestor with a transform, filter or containment can move. The offset is measured once
      // and taken out, so the menu stays where placeMenu put it (FE-020 criterion 2).
      const at = node.getBoundingClientRect();
      const dx = rtl ? at.right - (innerWidth - intended.inlineStart) : at.left - intended.inlineStart;
      const dy = at.top - intended.blockStart;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        placement = {
          inlineStart: Math.round(intended.inlineStart + (rtl ? dx : -dx)),
          blockStart: Math.round(intended.blockStart - dy),
        };
      }
      focusItem(0);
    });
    return () => {
      try {
        popover.hidePopover?.();
      } catch {
        // Already hidden.
      }
    };
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') focusItem(index + 1);
    else if (event.key === 'ArrowUp') focusItem(index - 1);
    else if (event.key === 'Home') focusItem(0);
    else if (event.key === 'End') focusItem(items.length - 1);
    else if (event.key === 'Escape') onClose(true);
    else if (event.key === 'Tab') onClose(true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function run(item: CommandView): void {
    const result = shell.registry.exec(item.id);
    if (!result.ran && !item.enabled) {
      if (item.reasonKey) shell.announceText(tr.text(item.reasonKey));
      return;
    }
    onClose(false);
  }

  $effect(() => {
    if (!menu) return;
    const root = menu.getRootNode() as ShadowRoot | Document;
    return on(root, 'pointerdown', (event: Event) => {
      if (menu && event.composedPath().includes(menu)) return;
      onClose(false);
    });
  });

  function reasonId(item: CommandView): string {
    return `${id}-reason-${item.id.replace(/\W/g, '-')}`;
  }
</script>

<div
  bind:this={menu}
  {@attach show}
  {id}
  class="de-menu de-context-menu"
  popover="manual"
  role="menu"
  tabindex="-1"
  aria-label={tr.t('menu.context.label')}
  lang={tr.locale}
  dir={tr.dir}
  style:inset-inline-start={`${placement.inlineStart}px`}
  style:inset-block-start={`${placement.blockStart}px`}
  onkeydown={onKeydown}
>
  {#each groups as group, g (group.name)}
    {#if g > 0}
      <div class="de-menu-separator" role="separator"></div>
    {/if}
    {#each group.commands as item (item.id)}
      <button
        type="button"
        class="de-menu-item"
        data-menu-item
        data-command-id={item.id}
        role={item.active === null ? 'menuitem' : 'menuitemcheckbox'}
        tabindex={items.indexOf(item) === index ? 0 : -1}
        aria-checked={item.active === null ? undefined : item.active}
        aria-disabled={item.enabled ? undefined : 'true'}
        aria-describedby={item.enabled ? undefined : reasonId(item)}
        aria-keyshortcuts={ariaShortcuts(boundKeys(item.id, item.entry.keys), apple)}
        onclick={() => run(item)}>{tr.text(item.entry.label)}</button
      >
    {/each}
  {/each}
  <div hidden>
    {#each items as item (item.id)}
      {#if !item.enabled && item.reasonKey}
        <span id={reasonId(item)}>{tr.text(item.reasonKey)}</span>
      {/if}
    {/each}
  </div>
</div>
