<!--
  The styles pane (UX-022; 13 §2, §12; 07 §5.3, §7): the document's paragraph, character and table
  styles with their names and kinds; the style of each kind in effect at the caret is marked in
  words. Choosing a style applies it to the selection through the registry (`format.applyStyle`), so
  the permissions apply as for typing: a user who may edit only a region can apply an existing style
  there, and a user who may only suggest records a suggestion. Creating, changing and deleting a
  style are the structure's (07 §7): without that right the controls are disabled and the pane says
  why, and a style that a region the user cannot edit uses, or an approved region uses, cannot be
  changed, and the pane names that region. Style and region names are the document's content.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { useShell } from '../context.ts';
  import type { StyleEditOp, StyleSummary } from '../core-api.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { live } from '../live.ts';
  import {
    nameProblem,
    parentChoices,
    styleBlock,
    USER_REASONS,
    type StyleBlock,
  } from '../shell/style-edit.ts';

  const shell = useShell()!;
  const core = shell.core;
  const tr = $derived(shell.strings.current);
  const selection = live(core.selection);
  const styles = core.styles ? live(core.styles) : null;
  const regionsView = core.regions ? live(core.regions) : null;
  const snapshot = live(shell.registry.view);

  const KINDS: ReadonlyArray<{ kind: StyleSummary['kind']; key: StringKey }> = [
    { kind: 'paragraph', key: 'styles.kind.paragraph' },
    { kind: 'character', key: 'styles.kind.character' },
    { kind: 'table', key: 'styles.kind.table' },
  ];

  const apply = $derived(
    snapshot.current.commands.find((c) => c.id === 'format.applyStyle' && c.offered) ?? null,
  );
  const list = $derived(styles?.current ?? []);
  const id = `${shell.idPrefix}-styles`;

  /** The style of the kind in effect at the caret or in the selection (UX-022 criterion 1). */
  function isCurrent(style: StyleSummary): boolean {
    const s = selection.current;
    if (style.kind === 'character') return s.charStyleId === style.id;
    if (style.kind === 'table') return s.tableStyleId === style.id;
    return s.styleId !== null && s.styleId !== undefined
      ? s.styleId === style.id
      : s.style === style.name;
  }

  function choose(style: StyleSummary): void {
    const result = shell.registry.exec('format.applyStyle', { style: style.id, kind: style.kind });
    if (!result.ran && apply && !apply.enabled && apply.reasonKey)
      shell.announceText(tr.text(apply.reasonKey));
  }

  // --- Creating, changing and deleting (criteria 2 and 3) ---------------------------------------

  const offersEdit = $derived(
    core.styleEdit !== undefined &&
      (core.commandNames?.includes('createStyle') ?? false) &&
      (core.commandNames?.includes('changeStyle') ?? false) &&
      (core.commandNames?.includes('deleteStyle') ?? false),
  );

  /** What stops the edit now, from the core's answer and the region states. */
  function blockOf(op: StyleEditOp, styleId?: string): StyleBlock | null {
    // Reading the views makes the answer follow the document, the access and the regions.
    void list;
    void selection.current;
    return styleBlock(core.styleEdit?.(op, styleId), op, regionsView?.current ?? []);
  }

  function regionNames(ids: readonly string[]): string {
    const all = regionsView?.current ?? [];
    return ids.map((r) => all.find((x) => x.id === r)?.title ?? tr.t('permissions.hiddenRegion')).join(', ');
  }

  function whyText(block: StyleBlock): string {
    const key = `styles.why.${block.reason}` as StringKey;
    return tr.t(key, { count: block.regions.length, regions: regionNames(block.regions) });
  }

  const createBlock = $derived(offersEdit ? blockOf('create') : null);
  /** A reason that holds for every style is shown once, where the controls are (criterion 2). */
  const userBlock = $derived(createBlock && USER_REASONS.has(createBlock.reason) ? createBlock : null);

  /** The last thing the user tried and what stopped it, or what it did; read out as a status. */
  let note = $state('');

  function say(text: string): void {
    note = text;
    shell.announceText(text);
  }

  type Form =
    | { mode: 'new'; name: string; kind: StyleSummary['kind']; basedOn: string }
    | { mode: 'change'; styleId: string; name: string; basedOn: string };
  let form = $state<Form | null>(null);

  async function openForm(next: Form): Promise<void> {
    form = next;
    await tick();
    root?.querySelector<HTMLElement>(`[data-form] input`)?.focus();
  }

  let root: HTMLElement | undefined = $state();

  function startNew(): void {
    const block = blockOf('create');
    if (block) return say(whyText(block));
    note = '';
    void openForm({ mode: 'new', name: '', kind: 'paragraph', basedOn: '' });
  }

  function startChange(style: StyleSummary): void {
    const block = blockOf('change', style.id);
    if (block) return say(whyText(block));
    note = '';
    void openForm({ mode: 'change', styleId: style.id, name: style.name, basedOn: style.basedOn ?? '' });
  }

  function remove(style: StyleSummary): void {
    const block = blockOf('delete', style.id);
    if (block) return say(whyText(block));
    const done = core.runNamed?.('deleteStyle', { id: style.id }) ?? false;
    say(tr.t(done ? 'styles.delete.done' : 'styles.edit.failed'));
  }

  function save(event: SubmitEvent): void {
    event.preventDefault();
    const f = form;
    if (!f) return;
    if (f.mode === 'new') {
      const block = blockOf('create');
      if (block) return say(whyText(block));
      const problem = nameProblem(list, f.kind, f.name, null);
      if (problem) return say(tr.t(`styles.why.${problem}`));
      const done =
        core.runNamed?.('createStyle', {
          name: f.name,
          kind: f.kind,
          ...(f.basedOn ? { basedOn: f.basedOn } : {}),
        }) ?? false;
      if (done) form = null;
      say(tr.t(done ? 'styles.new.done' : 'styles.edit.failed'));
      return;
    }
    const block = blockOf('change', f.styleId);
    if (block) return say(whyText(block));
    const own = list.find((s) => s.id === f.styleId);
    const problem = own ? nameProblem(list, own.kind, f.name, own.id) : null;
    if (problem) return say(tr.t(`styles.why.${problem}`));
    const parent = f.basedOn === '' ? null : f.basedOn;
    const done =
      core.runNamed?.('changeStyle', { id: f.styleId, name: f.name, basedOn: parent }) ?? false;
    if (done) form = null;
    // The core refuses a built-in style, and a parent that is not of the kind or would make a loop.
    say(
      tr.t(
        done
          ? 'styles.change.done'
          : parent !== (own?.basedOn ?? null)
            ? 'styles.why.bad-based-on'
            : 'styles.why.built-in',
      ),
    );
  }

  const formParents = $derived.by(() => {
    const f = form;
    if (f === null) return [];
    if (f.mode === 'new') return parentChoices(list, f.kind, null);
    return parentChoices(list, list.find((s) => s.id === f.styleId)?.kind ?? '', f.styleId);
  });
</script>

<section class="de-styles" aria-label={tr.t('styles.label')} bind:this={root}>
  {#if list.length === 0}
    <p>{tr.t('styles.empty')}</p>
  {/if}
  {#each KINDS as { kind, key } (kind)}
    {@const group = list.filter((s) => s.kind === kind)}
    {#if group.length > 0}
      <h3 class="de-subhead" id={`${id}-${kind}`}>{tr.t(key)}</h3>
      <ul class="de-list" aria-labelledby={`${id}-${kind}`}>
        {#each group as style (style.id)}
          {@const here = isCurrent(style)}
          <li data-style={style.id} data-current={here ? '' : undefined}>
            <button
              type="button"
              class="de-list-button"
              aria-current={here ? 'true' : undefined}
              aria-disabled={apply?.enabled ? undefined : 'true'}
              aria-describedby={here ? `${id}-current` : undefined}
              onclick={() => choose(style)}
            >
              <span data-content>{style.name}</span>
              {#if here}
                <span class="de-badge">{tr.t('styles.current')}</span>
              {/if}
            </button>
            {#if offersEdit}
              <span class="de-style-actions">
                <button
                  type="button"
                  class="de-button"
                  data-style-action="change"
                  aria-label={tr.t('styles.change', { name: style.name })}
                  aria-disabled={userBlock ? 'true' : undefined}
                  aria-describedby={userBlock ? `${id}-why` : undefined}
                  onclick={() => startChange(style)}>{tr.t('styles.change.action')}</button
                >
                <button
                  type="button"
                  class="de-button"
                  data-style-action="delete"
                  aria-label={tr.t('styles.delete', { name: style.name })}
                  aria-disabled={userBlock ? 'true' : undefined}
                  aria-describedby={userBlock ? `${id}-why` : undefined}
                  onclick={() => remove(style)}>{tr.t('styles.delete.action')}</button
                >
              </span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/each}
  <span id={`${id}-current`} hidden>{tr.t('styles.current')}</span>

  {#if offersEdit}
    <h3 class="de-subhead" id={`${id}-manage`}>{tr.t('styles.manage')}</h3>
    <button
      type="button"
      class="de-button"
      data-style-action="new"
      aria-disabled={userBlock ? 'true' : undefined}
      aria-describedby={userBlock ? `${id}-why` : undefined}
      onclick={startNew}>{tr.t('styles.new')}</button
    >
    {#if userBlock}
      <p class="de-hint" id={`${id}-why`} data-styles="why">{whyText(userBlock)}</p>
    {/if}
    {#if form}
      <form class="de-style-form" data-form onsubmit={save} aria-labelledby={`${id}-manage`}>
        {#if form.mode === 'change'}
          {@const wanted = form.styleId}
          <p class="de-hint">
            {tr.t('styles.change.label', { name: list.find((s) => s.id === wanted)?.name ?? '' })}
          </p>
        {/if}
        <label class="de-field" for={`${id}-name`}>{tr.t('styles.new.name')}</label>
        <input
          id={`${id}-name`}
          class="de-input"
          type="text"
          autocomplete="off"
          bind:value={form.name}
        />
        {#if form.mode === 'new'}
          <label class="de-field" for={`${id}-kind`}>{tr.t('styles.new.kind')}</label>
          <select id={`${id}-kind`} class="de-input" bind:value={form.kind}>
            {#each KINDS as { kind, key } (kind)}
              <option value={kind}>{tr.t(key)}</option>
            {/each}
          </select>
        {/if}
        <label class="de-field" for={`${id}-parent`}>{tr.t('styles.new.basedOn')}</label>
        <select id={`${id}-parent`} class="de-input" bind:value={form.basedOn}>
          <option value="">{tr.t('styles.new.noParent')}</option>
          {#each formParents as parent (parent.id)}
            <option value={parent.id}>{parent.name}</option>
          {/each}
        </select>
        <div class="de-search-row">
          <button type="submit" class="de-button de-button-primary"
            >{tr.t(form.mode === 'new' ? 'styles.new.save' : 'styles.change.save')}</button
          >
          <button type="button" class="de-button" onclick={() => (form = null)}
            >{tr.t('styles.new.cancel')}</button
          >
        </div>
      </form>
    {/if}
    <p class="de-hint" role="status" data-styles="note">{note}</p>
  {/if}
</section>
