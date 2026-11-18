<!--
  Command search (UX-011; 13 §2, §4): a field that lists the offered commands whose translated
  label or synonym matches what is typed. The field is a combobox and the results a listbox, with
  the active result named by aria-activedescendant. The count of results is announced in a status
  region, and "No results" when nothing matches. Arrow keys move through the results, Enter runs
  the active one, and Escape or a click outside closes it and returns focus to the text. A result
  the permissions do not allow is listed disabled with its reason, and Enter on it runs nothing
  (UX-004). The search itself is `searchCommands` in commands/search.ts.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { on } from 'svelte/events';
  import { searchCommands, synonymsFromStrings } from '../commands/search.ts';
  import { useShell } from '../context.ts';
  import { live } from '../live.ts';

  interface Props {
    /** Closes the search; `restore` puts focus back in the editing surface. */
    onClose: (restore: boolean) => void;
  }

  let { onClose }: Props = $props();

  const shell = useShell()!;
  const snapshot = live(shell.registry.view);
  const tr = $derived(shell.strings.current);
  const listId = `${shell.idPrefix}-command-search-list`;

  let query = $state('');
  let index = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let panel: HTMLElement | undefined = $state();

  const results = $derived.by(() => {
    void snapshot.current;
    return searchCommands(shell.registry, query, {
      translate: { text: (key: string) => tr.text(key) },
      // Other words for a command, from the locale table (13 §2: labels and synonyms).
      synonyms: synonymsFromStrings(tr),
    });
  });
  const hits = $derived(results.hits);
  const current = $derived(hits.length === 0 ? -1 : Math.min(index, hits.length - 1));

  const status = $derived(
    hits.length > 0
      ? tr.t('search.results', { count: hits.length })
      : results.emptyKey === 'search.none'
        ? tr.t('search.none')
        : '',
  );

  function optionId(i: number): string {
    return `${listId}-${i}`;
  }

  function reasonId(i: number): string {
    return `${listId}-reason-${i}`;
  }

  function move(step: 1 | -1): void {
    if (hits.length === 0) return;
    index = (((current + step) % hits.length) + hits.length) % hits.length;
  }

  /** Runs a result. A result that cannot run now runs nothing and says why (UX-004). */
  function run(i: number): void {
    const hit = hits[i];
    if (!hit) return;
    if (!hit.runnable) {
      if (hit.reasonKey) shell.announceText(tr.text(hit.reasonKey));
      return;
    }
    shell.registry.exec(hit.id);
    onClose(false);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
    else if (event.key === 'Enter') {
      if (current >= 0) run(current);
    } else if (event.key === 'Escape') onClose(true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onInput(): void {
    index = 0;
  }

  // Focus goes into the field when the search opens.
  $effect(() => {
    if (input) void tick().then(() => input?.focus());
  });

  // A pointer press outside the search closes it, as a menu does.
  $effect(() => {
    if (!panel) return;
    const root = panel.getRootNode() as ShadowRoot | Document;
    return on(root, 'pointerdown', (event: Event) => {
      if (panel && event.composedPath().includes(panel)) return;
      onClose(false);
    });
  });
</script>

<div
  bind:this={panel}
  class="de-command-search"
  role="dialog"
  aria-label={tr.t('command.search.label')}
  lang={tr.locale}
  dir={tr.dir}
>
  <label class="de-command-search-field">
    <span class="de-command-search-label">{tr.t('command.search.field')}</span>
    <input
      bind:this={input}
      type="text"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      aria-expanded="true"
      aria-autocomplete="list"
      aria-controls={listId}
      aria-describedby={`${listId}-help`}
      aria-activedescendant={current >= 0 ? optionId(current) : undefined}
      bind:value={query}
      oninput={onInput}
      onkeydown={onKeydown}
    />
  </label>
  <p class="de-hint" id={`${listId}-help`}>{tr.t('command.search.help')}</p>
  <p class="de-hint" role="status" aria-live="polite" data-search-count>{status}</p>
  <ul class="de-command-search-results" role="listbox" id={listId} aria-label={tr.t('search.list')}>
    {#each hits as hit, i (hit.id)}
      <li
        role="option"
        id={optionId(i)}
        class="de-command-search-option"
        data-command-id={hit.id}
        data-runnable={hit.runnable ? '' : undefined}
        aria-selected={i === current}
        aria-disabled={hit.runnable ? undefined : 'true'}
        aria-describedby={hit.reasonKey ? reasonId(i) : undefined}
        onclick={() => run(i)}
        onkeydown={(event) => event.stopPropagation()}
        onpointermove={() => (index = i)}
      >
        <span class="de-command-search-name">{hit.label}</span>
        {#if hit.reasonKey}
          <span class="de-command-search-reason" id={reasonId(i)}>{tr.text(hit.reasonKey)}</span>
        {/if}
      </li>
    {/each}
  </ul>
</div>
