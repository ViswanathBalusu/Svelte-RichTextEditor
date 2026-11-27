<!--
  The ribbon toolbar (`toolbar="ribbon"`; ADR 0490; 13 §3, §4): tabs for the task areas (Home, Insert,
  Layout, References, Review, View), each showing its commands in labelled groups. It is the full
  toolbar's pattern with another arrangement: the WAI-ARIA tabs pattern (arrow keys, Home and End
  between tabs, which select their tab; Tab into the commands, which are one toolbar with one tab
  stop and roving focus), and the same registry entries. A contextual group (table, picture, header
  and footer, field) has a tab of its own only while the selection is in or on that object; it
  appears and goes without moving focus. Nothing is hidden in a menu: a group that does not fit
  wraps to another row. The look and the grouping are this product's own and provisional (13 §3, §13).
-->
<script lang="ts">
  import { tick } from 'svelte';
  import type { CommandView } from '../commands/types.ts';
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import { ribbonTabs } from '../shell/ribbon-groups.ts';
  import { toolbarCommands } from '../shell/toolbar-groups.ts';
  import { nextIndex } from '../shell/toolbar-layout.ts';
  import Toolbar from './Toolbar.svelte';

  interface Props {
    onEscape: () => void;
  }

  let { onEscape }: Props = $props();

  const shell = useShell()!;
  const snapshot = live(shell.registry.view);
  const selection = live(shell.core.selection);
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-ribbon`;

  const tabs = $derived(
    ribbonTabs(toolbarCommands(snapshot.current.commands, selection.current.contexts)),
  );

  let chosen = $state<string | null>(null);
  /** The selected tab: the one chosen while it exists, else the first (Home). */
  const active = $derived(tabs.find((t) => t.id === chosen) ?? tabs[0] ?? null);

  let tablist: HTMLElement | undefined = $state();

  function groupName(name: string): string {
    const key = `group.${name}`;
    return tr.has(key) ? tr.text(key) : tr.t('group.other');
  }

  function tabLabel(tab: { id: string; ownGroup: boolean }): string {
    if (tab.ownGroup) return groupName(tab.id);
    const key = `ribbon.tab.${tab.id}`;
    return tr.has(key) ? tr.text(key) : tr.t('group.other');
  }

  function captionOf(tab: { ownGroup: boolean }, key: string): string {
    if (tab.ownGroup) return groupName(key);
    const own = `ribbon.group.${key}`;
    return tr.has(own) ? tr.text(own) : groupName(key);
  }

  const panelGroups = $derived(
    active
      ? active.groups.map((g) => ({ key: g.key, label: captionOf(active, g.key), commands: g.commands }))
      : [],
  );
  const panelItems = $derived<readonly CommandView[]>(panelGroups.flatMap((g) => g.commands));

  function tabId(name: string): string {
    return `${id}-tab-${name.replace(/\W/g, '-')}`;
  }

  function rtl(): boolean {
    return tablist ? getComputedStyle(tablist).direction === 'rtl' : false;
  }

  async function select(index: number): Promise<void> {
    const tab = tabs[index];
    if (!tab) return;
    chosen = tab.id;
    await tick();
    tablist?.querySelector<HTMLElement>(`#${tabId(tab.id)}`)?.focus();
  }

  function onKeydown(event: KeyboardEvent): void {
    const index = active ? tabs.indexOf(active) : 0;
    const forward = rtl() ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl() ? 'ArrowRight' : 'ArrowLeft';
    if (event.key === forward) void select(nextIndex(index, tabs.length, 1));
    else if (event.key === backward) void select(nextIndex(index, tabs.length, -1));
    else if (event.key === 'Home') void select(0);
    else if (event.key === 'End') void select(tabs.length - 1);
    else if (event.key === 'Escape') onEscape();
    else return;
    event.preventDefault();
  }

  /** Tabs keep the editor's selection, like every toolbar control (02 §3). */
  function keepSelection(event: MouseEvent): void {
    event.preventDefault();
  }
</script>

<div
  part="toolbar"
  class="de-toolbar-full de-ribbon"
  role="region"
  aria-label={tr.t('toolbar.label')}
  data-landmark="toolbar"
  lang={tr.locale}
>
  <div
    bind:this={tablist}
    class="de-tabs"
    role="tablist"
    aria-label={tr.t('toolbar.tabs.label')}
    tabindex="-1"
    onkeydown={onKeydown}
    onmousedown={keepSelection}
  >
    {#each tabs as tab (tab.id)}
      <button
        type="button"
        class="de-tab"
        role="tab"
        id={tabId(tab.id)}
        data-group={tab.id}
        data-contextual={tab.contextual ? '' : undefined}
        aria-selected={tab === active}
        aria-controls={`${id}-panel`}
        tabindex={tab === active ? 0 : -1}
        onclick={() => (chosen = tab.id)}>{tabLabel(tab)}</button
      >
    {/each}
  </div>
  {#if active}
    <div
      class="de-tabpanel"
      role="tabpanel"
      id={`${id}-panel`}
      aria-labelledby={tabId(active.id)}
      data-group={active.id}
    >
      {#key active.id}
        <Toolbar
          {onEscape}
          items={panelItems}
          groups={panelGroups}
          label={tr.t('toolbar.group.label', { group: tabLabel(active) })}
          standalone={false}
        />
      {/key}
    </div>
  {/if}
</div>
