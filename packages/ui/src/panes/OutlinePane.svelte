<!--
  The navigation pane (UX-020; 13 §2; 02 §5.1 `outline()`): the body's headings as a tree with
  levels (the WAI-ARIA tree pattern), and a search over what this reader holds (ADR 0019) with its
  results in context and their count. Choosing a heading or a result puts the caret there and
  scrolls it into view, through the core. Headings in regions the user cannot edit are listed like
  any other. The outline updates from the core's view without losing the focused heading. Loaded
  on demand (02 §2); heading texts and matches are the document's content.
-->
<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { useShell } from '../context.ts';
  import type { CoreApi, OutlineItem, SearchMatch, SearchResults } from '../core-api.ts';
  import { sourceTranslator } from '../i18n/strings.ts';
  import { live } from '../live.ts';
  import { outlineTree, placeAfter, type TreeNode } from '../shell/outline.ts';

  // The tree is rendered flat; `TreeNode.children` only says whether an item can expand.

  interface Props {
    /** The outline, when the element passes it (phase 1a); else the core's view is read. */
    items?: readonly OutlineItem[];
    core?: CoreApi;
    close?: () => void;
  }

  let props: Props = $props();

  const shell = useShell();
  const fallback = sourceTranslator();
  const tr = $derived(shell?.strings.current ?? fallback);
  const core = untrack(() => props.core ?? shell?.core);
  const outlineView = core ? live(core.outline) : null;
  const items = $derived(props.items ?? outlineView?.current ?? []);
  const id = `${shell?.idPrefix ?? 'de'}-nav`;

  const tree = $derived(outlineTree(items));
  const flat = $derived(tree.flat);
  let collapsed = $state<Record<string, boolean>>({});
  let activeId = $state<string | null>(null);
  let treeEl: HTMLElement | undefined = $state();

  /** The items a reader can reach now: those whose ancestors are all expanded. */
  const visible = $derived(flat.filter((n) => n.ancestors.every((a) => !collapsed[a])));
  const current = $derived(visible.find((n) => n.item.id === activeId) ?? visible[0] ?? null);

  // The author's place survives a change of the outline (UX-020 criterion 2): the focused or chosen
  // heading stays by its identifier; when it is removed, the place moves to the nearest heading before
  // it and, if the tree had focus, focus moves with it instead of falling to the page.
  let listed: readonly string[] = [];
  $effect.pre(() => {
    const ids = flat.map((n) => n.item.id);
    untrack(() => {
      const place = placeAfter(listed, activeId, ids);
      if (place !== activeId) {
        const root = treeEl?.getRootNode() as Document | ShadowRoot | undefined;
        const hadFocus = !!treeEl && !!root?.activeElement && treeEl.contains(root.activeElement);
        activeId = place;
        if (hadFocus && place !== null) void tick().then(() => focusId(place));
      }
      listed = ids;
    });
  });

  function focusId(itemId: string): void {
    treeEl?.querySelector<HTMLElement>(`[data-id="${CSS.escape(itemId)}"]`)?.focus();
  }

  async function focusItem(node: TreeNode | undefined): Promise<void> {
    if (!node) return;
    activeId = node.item.id;
    await tick();
    focusId(node.item.id);
  }

  function choose(node: TreeNode): void {
    activeId = node.item.id;
    core?.selectBlock?.(node.item.id);
  }

  // Focus is the author's place, however it got there (a click, a key, a screen reader's cursor).
  function onTreeFocus(event: FocusEvent): void {
    const item = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-id]');
    if (item?.dataset['id']) activeId = item.dataset['id'];
  }

  function onTreeKeydown(event: KeyboardEvent): void {
    const node = current;
    if (!node) return;
    const i = visible.indexOf(node);
    const rtl = treeEl ? getComputedStyle(treeEl).direction === 'rtl' : false;
    const expandKey = rtl ? 'ArrowLeft' : 'ArrowRight';
    const collapseKey = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (event.key === 'ArrowDown') void focusItem(visible[i + 1]);
    else if (event.key === 'ArrowUp') void focusItem(visible[i - 1]);
    else if (event.key === 'Home') void focusItem(visible[0]);
    else if (event.key === 'End') void focusItem(visible[visible.length - 1]);
    else if (event.key === expandKey) {
      if (node.children.length && collapsed[node.item.id])
        collapsed = { ...collapsed, [node.item.id]: false };
      else if (node.children.length) void focusItem(visible[i + 1]);
    } else if (event.key === collapseKey) {
      if (node.children.length && !collapsed[node.item.id])
        collapsed = { ...collapsed, [node.item.id]: true };
      else {
        const parent = node.ancestors.at(-1);
        void focusItem(visible.find((n) => n.item.id === parent));
      }
    } else if (event.key === 'Enter' || event.key === ' ') choose(node);
    else return;
    event.preventDefault();
  }

  // Search (UX-020 criterion 3).
  let query = $state('');
  let matchCase = $state(false);
  let results = $state.raw<SearchResults | null>(null);
  let searching = $state(false);
  let gone = $state(false);
  let serial = 0;

  async function search(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const text = query.trim();
    if (!core?.search || !text) {
      results = null;
      // An empty search clears the marks the last one left in the document.
      if (core?.search) void core.search('');
      return;
    }
    const mine = ++serial;
    searching = true;
    gone = false;
    try {
      const found = await core.search(text, { matchCase });
      if (mine === serial) results = found;
    } finally {
      if (mine === serial) searching = false;
    }
  }

  // Closing the pane takes the search's marks out of the document.
  onDestroy(() => {
    if (query.trim()) void core?.search?.('');
  });

  function goTo(match: SearchMatch): void {
    gone = !(core?.selectMatch?.(match) ?? false);
  }
</script>

<nav class="de-outline" aria-label={tr.t('outline.label')}>
  {#if core?.search}
    <form class="de-search" role="search" aria-label={tr.t('search.label')} onsubmit={search}>
      <label class="de-field" for={`${id}-query`}>{tr.t('search.field')}</label>
      <div class="de-search-row">
        <input
          id={`${id}-query`}
          class="de-input"
          type="search"
          data-search
          autocomplete="off"
          bind:value={query}
        />
        <button type="submit" class="de-button">{tr.t('search.run')}</button>
      </div>
      <label class="de-check">
        <input type="checkbox" bind:checked={matchCase} />
        <span>{tr.t('search.matchCase')}</span>
      </label>
    </form>
    <p class="de-hint" role="status" data-status="search">
      {#if results && !searching}
        {results.total === 0
          ? tr.t('search.none')
          : tr.t('search.results', { count: results.total })}
      {/if}
    </p>
    {#if results && results.matches.length > 0}
      <ol class="de-list" aria-label={tr.t('search.list')}>
        {#each results.matches as match (match.index)}
          <li>
            <button type="button" class="de-list-button" onclick={() => goTo(match)}>
              <span data-content
                >{match.before}<mark class="de-match">{match.text}</mark>{match.after}</span
              >
            </button>
          </li>
        {/each}
      </ol>
    {/if}
    {#if gone}
      <p class="de-error" role="status">{tr.t('search.gone')}</p>
    {/if}
  {/if}
  {#if items.length === 0}
    <p class="de-outline-empty">{tr.t('outline.empty')}</p>
  {:else}
    <!-- A flat tree: levels, positions and expansion are attributes (WAI-ARIA 1.2 tree), so each
         item's name is its own heading and not its children's. -->
    <ul
      bind:this={treeEl}
      class="de-tree"
      role="tree"
      aria-label={tr.t('outline.label')}
      onkeydown={onTreeKeydown}
      onfocusin={onTreeFocus}
    >
      {#each visible as node (node.item.id)}
        <!-- The tree pattern: the keys are handled once, on the tree, for the focused item. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          role="treeitem"
          class="de-tree-item"
          data-id={node.item.id}
          data-level={node.item.level}
          data-depth={node.depth}
          aria-level={node.depth + 1}
          aria-setsize={node.setSize}
          aria-posinset={node.position}
          aria-expanded={node.children.length ? !collapsed[node.item.id] : undefined}
          aria-selected={current?.item.id === node.item.id}
          tabindex={current?.item.id === node.item.id ? 0 : -1}
          style:padding-inline-start={`${node.depth * 1.1}em`}
          onclick={() => choose(node)}
        >
          <span class="de-tree-label" data-content>{node.item.text}</span>
        </li>
      {/each}
    </ul>
  {/if}
</nav>
