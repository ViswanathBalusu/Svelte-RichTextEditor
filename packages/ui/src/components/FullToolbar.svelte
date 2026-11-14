<!--
  The full toolbar (UX-007; 13 §3, §4): commands grouped by task, one group shown at a time,
  chosen by tabs (the WAI-ARIA tabs pattern: arrow keys, Home and End between tabs, which select
  their group; Tab into the group's commands, which are one toolbar). Each command appears in the
  one group its registry entry names, from the same entry as in the compact layout. A contextual
  group (table, picture, header and footer, field) has its tab only while the selection is in or
  on that object; it appears and goes without moving focus. The grouping and its look are this
  product's own, and provisional (13 §3, §13).
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';
  import { toolbarCommands, toolbarGroups } from '../shell/toolbar-groups.ts';
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
  const id = `${shell.idPrefix}-tabs`;

  const groups = $derived(
    toolbarGroups(toolbarCommands(snapshot.current.commands, selection.current.contexts)),
  );

  let chosen = $state<string | null>(null);
  /** The selected group: the one chosen while it exists, else the first task group. */
  const active = $derived(groups.find((g) => g.name === chosen) ?? groups[0] ?? null);

  let tablist: HTMLElement | undefined = $state();

  function groupLabel(name: string): string {
    const key = `group.${name}`;
    return tr.has(key) ? tr.text(key) : tr.t('group.other');
  }

  function tabId(name: string): string {
    return `${id}-tab-${name.replace(/\W/g, '-')}`;
  }

  function rtl(): boolean {
    return tablist ? getComputedStyle(tablist).direction === 'rtl' : false;
  }

  async function select(index: number): Promise<void> {
    const group = groups[index];
    if (!group) return;
    chosen = group.name;
    await tick();
    tablist?.querySelector<HTMLElement>(`#${tabId(group.name)}`)?.focus();
  }

  function onKeydown(event: KeyboardEvent): void {
    const index = active ? groups.indexOf(active) : 0;
    const forward = rtl() ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl() ? 'ArrowRight' : 'ArrowLeft';
    if (event.key === forward) void select(nextIndex(index, groups.length, 1));
    else if (event.key === backward) void select(nextIndex(index, groups.length, -1));
    else if (event.key === 'Home') void select(0);
    else if (event.key === 'End') void select(groups.length - 1);
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
  class="de-toolbar-full"
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
    {#each groups as group (group.name)}
      <button
        type="button"
        class="de-tab"
        role="tab"
        id={tabId(group.name)}
        data-group={group.name}
        data-contextual={group.contextual ? '' : undefined}
        aria-selected={group === active}
        aria-controls={`${id}-panel`}
        tabindex={group === active ? 0 : -1}
        onclick={() => (chosen = group.name)}>{groupLabel(group.name)}</button
      >
    {/each}
  </div>
  {#if active}
    <div
      class="de-tabpanel"
      role="tabpanel"
      id={`${id}-panel`}
      aria-labelledby={tabId(active.name)}
      data-group={active.name}
    >
      {#key active.name}
        <Toolbar
          {onEscape}
          items={active.commands}
          label={tr.t('toolbar.group.label', { group: groupLabel(active.name) })}
          standalone={false}
        />
      {/key}
    </div>
  {/if}
</div>
