<!--
  The ribbon toolbar (`toolbar="ribbon"`; ADR 0490; 13 §3, §4): tabs for the task areas (Home, Insert,
  Layout, References, Review, View), each showing its commands in labelled groups. It is the full
  toolbar's pattern with another arrangement: the WAI-ARIA tabs pattern (arrow keys, Home and End
  between tabs, which select their tab; Tab into the commands, which are one toolbar with one tab
  stop and roving focus), and the same registry entries. A contextual group (table, picture, header
  and footer, field) has a tab of its own only while the selection is in or on that object; it
  appears and goes without moving focus. Nothing is hidden in a menu: a group that does not fit
  wraps to another row. The look and the grouping are this product's own and provisional (13 §3, §13).

  The ribbon, its icons and its strings load on demand, so the first interactive editor does not carry
  them (13 §9). Its rules are at the end of shell.css, scoped to .de-ribbon.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import type { CommandView } from '../commands/types.ts';
  import { useShell } from '../context.ts';
  import '../i18n/late/ribbonToolbar.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { RIBBON_ICONS, ribbonIconName } from '../icons/ribbon-icons.ts';
  import { live } from '../live.ts';
    import { ribbonCommands, ribbonSmall, ribbonTabs } from '../shell/ribbon-groups.ts';
  import { nextIndex } from '../shell/toolbar-layout.ts';
  import PickerMenu from './PickerMenu.svelte';
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

  const TAB_KEYS: Readonly<Record<string, StringKey>> = {
    home: 'ribbon.tab.home',
    insert: 'ribbon.tab.insert',
    layout: 'ribbon.tab.layout',
    references: 'ribbon.tab.references',
    review: 'ribbon.tab.review',
    view: 'ribbon.tab.view',
  };

  const GROUP_KEYS: Readonly<Record<string, StringKey>> = {
    edit: 'ribbon.group.edit',
    styles: 'ribbon.group.styles',
    font: 'ribbon.group.font',
    paragraph: 'ribbon.group.paragraph',
    copyFormat: 'ribbon.group.copyFormat',
    insert: 'ribbon.group.insert',
    tables: 'ribbon.group.tables',
    fields: 'ribbon.group.fields',
    regions: 'ribbon.group.regions',
    headerFooter: 'ribbon.group.headerFooter',
    document: 'ribbon.group.document',
    notes: 'ribbon.group.notes',
    captions: 'ribbon.group.captions',
    citations: 'ribbon.group.citations',
    comments: 'ribbon.group.comments',
    tracking: 'ribbon.group.tracking',
    proofing: 'ribbon.group.proofing',
    workflow: 'ribbon.group.workflow',
    protection: 'ribbon.group.protection',
    views: 'ribbon.group.views',
    zoom: 'ribbon.group.zoom',
    panes: 'ribbon.group.panes',
  };

  const tabs = $derived(
    ribbonTabs(ribbonCommands(snapshot.current.commands, selection.current.contexts)),
  );

  let chosen = $state<string | null>(null);
  /** The selected tab: the one chosen while it exists, else the first (Home). */
  const active = $derived(tabs.find((t) => t.id === chosen) ?? tabs[0] ?? null);

  let tablist: HTMLElement | undefined = $state();

  /** The name of a registry group, as the full layout names it. */
  function groupName(name: string): string {
    const key = `group.${name}`;
    return tr.has(key) ? tr.text(key) : tr.t('group.other');
  }

  function tabLabel(tab: { id: string; ownGroup: boolean }): string {
    const key = tab.ownGroup ? undefined : TAB_KEYS[tab.id];
    return key ? tr.t(key) : groupName(tab.id);
  }

  function captionOf(tab: { ownGroup: boolean }, group: string): string {
    const key = tab.ownGroup ? undefined : GROUP_KEYS[group];
    return key ? tr.t(key) : groupName(group);
  }

  const panelGroups = $derived(
    active
      ? active.groups.map((g) => ({
          key: g.key,
          label: captionOf(active, g.key),
          commands: g.commands,
        }))
      : [],
  );
  const panelItems = $derived<readonly CommandView[]>(panelGroups.flatMap((g) => g.commands));
  const ribbon = $derived({
    groups: panelGroups,
    icon: ribbonIconName,
    drawings: RIBBON_ICONS,
    small: ribbonSmall,
    picker: PickerMenu,
  });

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
          {ribbon}
          label={tr.t('toolbar.group.label', { group: tabLabel(active) })}
          standalone={false}
        />
      {/key}
    </div>
  {/if}
</div>
