<!--
  A toolbar row (UX-006; 13 §3, §4): the compact toolbar, or the commands of one group of the full
  layout (UX-007). Generated from the command registry, nothing hard-coded. It is one tab stop;
  the arrow keys, Home and End move between controls (the WAI-ARIA toolbar pattern), Escape
  returns to the editing surface. Disabled commands stay focusable with `aria-disabled` and say
  why. Commands that do not fit go to a "More" menu, in order.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { on } from 'svelte/events';
  import { ariaShortcuts, isApplePlatform } from '../commands/keys.ts';
  import type { CommandView } from '../commands/types.ts';
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import Icon from './Icon.svelte';
  import { boundKeys } from '../shortcuts/table.ts';
  import { useSuspension } from '../shell/suspension.ts';
  import type { IconDrawing } from '../icons/icons.ts';
  import { toolbarCommands } from '../shell/toolbar-groups.ts';
  import { fittingItems, nextIndex } from '../shell/toolbar-layout.ts';
  import type PickerMenu from './PickerMenu.svelte';

  interface Props {
    /** Called on Escape: focus goes back to the editing surface. */
    onEscape: () => void;
    /** The commands to show; by default the compact layout's, for the current selection. */
    items?: readonly CommandView[] | undefined;
    /** Accessible name; by default the compact toolbar's. */
    label?: string | undefined;
    /** True for the compact toolbar: it carries the `toolbar` part and is a landmark (UX-023). */
    standalone?: boolean;
    /**
     * The ribbon layout (ADR 0490): the commands of `items`, in the same order, in labelled groups,
     * each with an icon over its label. Nothing overflows into a menu there; the groups wrap onto
     * another row instead.
     */
    ribbon?: RibbonProps | undefined;
  }

  interface RibbonProps {
    groups: ReadonlyArray<{ key: string; label: string; commands: readonly CommandView[] }>;
    icon: (item: CommandView) => string | undefined;
    drawings: Readonly<Record<string, IconDrawing>>;
    /** True for a command drawn small: its icon alone, the label kept as text for assistive technology. */
    small: (item: CommandView) => boolean;
    /** The menu button of a command that is chosen from a list; the ribbon loads it, the first load does not carry it. */
    picker: typeof PickerMenu;
  }

  let { onEscape, items: given, label, standalone = true, ribbon }: Props = $props();
  const groups = $derived(ribbon?.groups);
  const suspended = useSuspension();

  const shell = useShell()!;
  const snapshot = live(shell.registry.view);
  const selection = live(shell.core.selection);
  const tr = $derived(shell.strings.current);
  const apple = isApplePlatform();
  const id = `${shell.idPrefix}-${Math.random().toString(36).slice(2, 6)}`;

  const items: readonly CommandView[] = $derived(
    given ?? toolbarCommands(snapshot.current.commands, selection.current.contexts),
  );

  let toolbar: HTMLElement | undefined = $state();
  let moreButton: HTMLButtonElement | undefined = $state();
  let menu: HTMLElement | undefined = $state();
  const buttons = new Map<string, HTMLElement>();
  const widths = new Map<string, number>();

  let visibleCount = $state(Number.POSITIVE_INFINITY);
  let roving = $state(0);
  let menuOpen = $state(false);
  let menuIndex = $state(0);

  const shown = $derived(items.slice(0, Math.min(visibleCount, items.length)));
  const overflow = $derived(items.slice(shown.length));
  /** The controls in the toolbar's tab sequence: visible commands, then "More" when needed. */
  const controlCount = $derived(shown.length + (overflow.length > 0 ? 1 : 0));
  const current = $derived(Math.max(0, Math.min(roving, controlCount - 1)));

  function widthKey(item: CommandView): string {
    return `${item.id}|${tr.text(item.entry.label)}`;
  }

  function outerWidth(el: HTMLElement): number {
    const style = getComputedStyle(el);
    return el.getBoundingClientRect().width + (parseFloat(style.marginInlineStart) || 0);
  }

  /** Measures what is visible and decides how many commands fit (UX-006, criterion 5). */
  function layout(): void {
    if (!toolbar || groups) return;
    const list = untrack(() => items);
    const count = untrack(() => visibleCount);
    list.forEach((item, i) => {
      const el = buttons.get(item.id);
      if (el && i < count) {
        const w = outerWidth(el);
        if (w > 0) widths.set(widthKey(item), w);
      }
    });
    if (moreButton && !moreButton.hidden) {
      // The button's own width. Its start margin is `auto`, which the browser resolves to all the
      // room that is left, so `outerWidth` would count that room as part of the button: each pass
      // would then reserve more, show fewer commands and leave more room, until the row was nearly
      // empty with the rest of the commands in the menu.
      const w = moreButton.getBoundingClientRect().width;
      if (w > 0) widths.set('|more', w);
    }
    const known = list.map((item) => widths.get(widthKey(item)) ?? 0);
    if (known.some((w) => !(w > 0))) {
      // Something has not been measured yet: show everything and measure in the next frame.
      if (count < list.length) {
        visibleCount = Number.POSITIVE_INFINITY;
        requestAnimationFrame(layout);
      }
      return;
    }
    const style = getComputedStyle(toolbar);
    const available =
      toolbar.clientWidth -
      (parseFloat(style.paddingInlineStart) || 0) -
      (parseFloat(style.paddingInlineEnd) || 0);
    const gap = parseFloat(style.columnGap) || 0;
    const more = widths.get('|more') ?? Math.max(...known);
    const fit = fittingItems(known, available, gap, more);
    const next = fit >= list.length ? Number.POSITIVE_INFINITY : fit;
    if (next !== count) {
      visibleCount = next;
      // The "More" button may have just appeared: measure it and settle in the next frame.
      requestAnimationFrame(layout);
    }
  }

  $effect(() => {
    // Lay out again when the commands or their labels change (a new locale, a new command).
    void items.map(widthKey).join();
    void toolbar;
    layout();
  });

  $effect(() => {
    // Not observed while the shell is suspended (FE-005); laid out again when it resumes.
    if (!toolbar || suspended()) return;
    const observer = new ResizeObserver(() => layout());
    observer.observe(toolbar);
    return () => observer.disconnect();
  });

  function controlAt(index: number): HTMLElement | undefined {
    if (index < shown.length) return buttons.get(shown[index]!.id);
    return moreButton;
  }

  function focusControl(index: number): void {
    roving = index;
    controlAt(index)?.focus();
  }

  function rtl(): boolean {
    return toolbar ? getComputedStyle(toolbar).direction === 'rtl' : false;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (menuOpen) return;
    const forward = rtl() ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl() ? 'ArrowRight' : 'ArrowLeft';
    if (event.key === forward) focusControl(nextIndex(current, controlCount, 1));
    else if (event.key === backward) focusControl(nextIndex(current, controlCount, -1));
    else if (event.key === 'Home') focusControl(0);
    else if (event.key === 'End') focusControl(controlCount - 1);
    else if (event.key === 'Escape') onEscape();
    else if (event.key === 'ArrowDown' && event.target === moreButton) void openMenu();
    else return;
    event.preventDefault();
  }

  function onFocusin(event: FocusEvent): void {
    const target = event.target as HTMLElement;
    if (target === moreButton) roving = shown.length;
    else {
      const i = shown.findIndex((c) => buttons.get(c.id) === target);
      if (i >= 0) roving = i;
    }
  }

  /** Toolbar controls keep the editor's selection: no focus change on mouse down (02 §3). */
  function keepSelection(event: MouseEvent): void {
    event.preventDefault();
  }

  async function openMenu(): Promise<void> {
    menuOpen = true;
    menuIndex = 0;
    await tick();
    fitMenu();
    focusMenuItem(0);
  }

  /**
   * The element clips what leaves its box (`contain: content`), and the menu is as long as the
   * commands that do not fit the row, so a long list must scroll inside the room the editor has:
   * from the top of the menu to the bottom of the editor, less a small margin. Without this the
   * last items cannot be reached with a pointer.
   */
  function fitMenu(): void {
    if (!menu) return;
    const root = menu.getRootNode();
    const box = (root instanceof ShadowRoot ? root.host : (menu.closest('.de-shell') ?? menu))
      .getBoundingClientRect();
    const room = box.bottom - menu.getBoundingClientRect().top - 8;
    const minimum = 6 * 16;
    menu.style.maxBlockSize = `${Math.max(minimum, Math.floor(room))}px`;
    menu.style.overflowY = 'auto';
  }

  function closeMenu(returnFocus: boolean): void {
    menuOpen = false;
    if (returnFocus) moreButton?.focus();
  }

  function menuItems(): HTMLElement[] {
    return menu ? [...menu.querySelectorAll<HTMLElement>('[data-menu-item]')] : [];
  }

  function focusMenuItem(index: number): void {
    const list = menuItems();
    if (list.length === 0) return;
    menuIndex = ((index % list.length) + list.length) % list.length;
    list[menuIndex]?.focus();
  }

  function onMenuKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') focusMenuItem(menuIndex + 1);
    else if (event.key === 'ArrowUp') focusMenuItem(menuIndex - 1);
    else if (event.key === 'Home') focusMenuItem(0);
    else if (event.key === 'End') focusMenuItem(overflow.length - 1);
    else if (event.key === 'Escape') closeMenu(true);
    else if (event.key === 'Tab') {
      closeMenu(false);
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function run(item: CommandView): void {
    const result = shell.registry.exec(item.id);
    if (!result.ran && !item.enabled && item.reasonKey) shell.announceText(tr.text(item.reasonKey));
  }

  function runFromMenu(item: CommandView): void {
    const result = shell.registry.exec(item.id);
    // A command that ran moves focus where it belongs (usually the editing surface).
    if (result.ran) closeMenu(false);
    else if (item.enabled) closeMenu(true);
  }

  $effect(() => {
    if (!menuOpen || !toolbar) return;
    const root = toolbar.getRootNode() as Document | ShadowRoot;
    return on(root, 'pointerdown', (event: Event) => {
      const path = event.composedPath();
      if ((menu && path.includes(menu)) || (moreButton && path.includes(moreButton))) return;
      closeMenu(false);
    });
  });

  function remember(item: CommandView) {
    return (node: HTMLElement) => {
      buttons.set(item.id, node);
      return () => {
        if (buttons.get(item.id) === node) buttons.delete(item.id);
      };
    };
  }

  function reasonId(item: CommandView): string {
    return `${id}-reason-${item.id.replace(/\W/g, '-')}`;
  }

  /** The spike's command name, kept on `data-command` for the element's existing tests. */
  function aliasOf(item: CommandView): string {
    return item.entry.aliases?.[0] ?? item.id;
  }

  function shortcuts(item: CommandView): string | undefined {
    return ariaShortcuts(boundKeys(item.id, item.entry.keys), apple);
  }

  /** The place of a command in `items`, which the roving tab stop and the focus use. */
  const indexOf = $derived(new Map(items.map((item, i) => [item.id, i] as const)));
</script>

{#snippet tool(item: CommandView, i: number)}
  {#if ribbon && item.entry.picker}
    {@const Picker = ribbon.picker}
    <Picker
      {item}
      icon={ribbon.icon(item)}
      drawings={ribbon.drawings}
      tabindex={i === current ? 0 : -1}
      register={remember(item)}
    />
  {:else}
  <button
    type="button"
    class="de-tool"
    class:de-tool-small={ribbon?.small(item)}
    class:de-group-start={!groups && i > 0 && items[i - 1]!.entry.group !== item.entry.group}
    data-command={aliasOf(item)}
    data-command-id={item.id}
    data-group={item.entry.group}
    hidden={i >= shown.length}
    tabindex={i === current ? 0 : -1}
    aria-pressed={item.active === null ? undefined : item.active}
    aria-disabled={item.enabled ? undefined : 'true'}
    aria-describedby={item.enabled ? undefined : reasonId(item)}
    aria-keyshortcuts={shortcuts(item)}
    title={item.enabled || !item.reasonKey
      ? ribbon?.small(item)
        ? tr.text(item.entry.label)
        : undefined
      : tr.text(item.reasonKey)}
    onclick={() => run(item)}
    {@attach remember(item)}
    >{#if ribbon}<Icon name={ribbon.icon(item)} extra={ribbon.drawings} /><span
        class="de-tool-label"
        class:de-visually-hidden={ribbon.small(item)}>{tr.text(item.entry.label)}</span
      >{:else}<Icon name={item.entry.icon} />{tr.text(item.entry.label)}{/if}</button
  >
  {/if}
{/snippet}

<div
  bind:this={toolbar}
  part={standalone ? 'toolbar' : undefined}
  class="de-toolbar"
  class:de-toolbar-panel={!standalone}
  role="toolbar"
  tabindex="-1"
  aria-label={label ?? tr.t('toolbar.label')}
  aria-orientation="horizontal"
  data-landmark={standalone ? 'toolbar' : undefined}
  lang={tr.locale}
  onmousedown={keepSelection}
  onkeydown={onKeydown}
  onfocusin={onFocusin}
>
  {#if groups}
    {#each groups as group (group.key)}
      <div class="de-ribbon-group" role="group" aria-label={group.label} data-ribbon-group={group.key}>
        <div class="de-ribbon-tools">
          {#each group.commands as item (item.id)}
            {@render tool(item, indexOf.get(item.id) ?? 0)}
          {/each}
        </div>
        <span class="de-ribbon-caption" aria-hidden="true">{group.label}</span>
      </div>
    {/each}
  {:else}
    {#each items as item, i (item.id)}
      {@render tool(item, i)}
    {/each}
  {/if}
  <button
    bind:this={moreButton}
    type="button"
    class="de-tool de-more"
    data-command-id="toolbar.more"
    hidden={overflow.length === 0}
    tabindex={current === shown.length ? 0 : -1}
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    aria-controls={menuOpen ? `${id}-toolbar-menu` : undefined}
    onclick={() => (menuOpen ? closeMenu(true) : void openMenu())}
    ><!-- The name starts with the visible word (WCAG 2.5.3), then the count. -->{tr.t(
      'toolbar.more',
    )}<span class="de-visually-hidden"
      >{tr.t('toolbar.more.label', {
        count: overflow.length,
      })}</span
    ></button
  >
  {#if menuOpen && overflow.length > 0}
    <div
      bind:this={menu}
      id={`${id}-toolbar-menu`}
      class="de-menu"
      role="menu"
      tabindex="-1"
      aria-label={tr.t('toolbar.menu.label')}
      onkeydown={onMenuKeydown}
    >
      {#each overflow as item, i (item.id)}
        <button
          type="button"
          class="de-menu-item"
          data-menu-item
          data-command-id={item.id}
          role={item.active === null ? 'menuitem' : 'menuitemcheckbox'}
          tabindex={i === menuIndex ? 0 : -1}
          aria-checked={item.active === null ? undefined : item.active}
          aria-disabled={item.enabled ? undefined : 'true'}
          aria-describedby={item.enabled ? undefined : reasonId(item)}
          aria-keyshortcuts={shortcuts(item)}
          onclick={() => runFromMenu(item)}><Icon name={item.entry.icon} />{tr.text(item.entry.label)}</button
        >
      {/each}
    </div>
  {/if}
  <div hidden>
    {#each items as item (item.id)}
      {#if !item.enabled && item.reasonKey}
        <span id={reasonId(item)}>{tr.text(item.reasonKey)}</span>
      {/if}
    {/each}
  </div>
</div>
