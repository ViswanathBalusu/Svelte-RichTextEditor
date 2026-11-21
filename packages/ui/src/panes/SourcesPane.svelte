<!--
  The sources pane (UX-103; 13 §3; 07 §4, §5.3; CDM-052): the sources the document cites, each with
  where it is cited. An author with `structure` adds, corrects and deletes sources and imports them
  from a BibTeX or CSL-JSON file; each change is a commit to the source definition, made by the
  core. A source that is still cited is not deleted, and the pane shows the places that cite it. A
  user without `structure` sees the list and can cite a source where they may change the text, and
  gets no control that changes a definition. Titles, names and excerpts are the document's content.
-->
<script lang="ts">
  import '../i18n/late/sourcesPane.ts';
  import { useShell } from '../context.ts';
  import type { SourceChangeResult, SourceSummary } from '../core-api.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { live } from '../live.ts';
  import { parseBibtex, parseCslJson } from '../shell/source-import.ts';
  import {
    EMPTY_DRAFT,
    FORM_KINDS,
    draftOf,
    importFormat,
    planImport,
    sourceLine,
    valuesOf,
    type ImportPlan,
    type SourceDraft,
  } from '../shell/sources.ts';

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const service = shell.core.sources!;
  const sources = live(service.list);
  const canChange = live(service.canChange);
  const revision = shell.core.revision ? live(shell.core.revision) : null;
  const id = `${shell.idPrefix}-sources`;

  const FIELDS: ReadonlyArray<{ name: keyof SourceDraft; key: StringKey; hint?: StringKey }> = [
    { name: 'title', key: 'sources.field.title' },
    { name: 'authors', key: 'sources.field.authors', hint: 'sources.hint.authors' },
    { name: 'issued', key: 'sources.field.issued', hint: 'sources.hint.issued' },
    { name: 'containerTitle', key: 'sources.field.container' },
    { name: 'doi', key: 'sources.field.doi' },
    { name: 'url', key: 'sources.field.url' },
  ];

  /** `null`: no form. `''`: a new source. Otherwise the identifier of the source being changed. */
  let editing: string | null = $state(null);
  let draft: SourceDraft = $state({ ...EMPTY_DRAFT });
  let bad: readonly string[] = $state([]);
  let formError: StringKey | null = $state(null);
  /** The source whose deletion was refused because it is cited. */
  let refusedDelete: string | null = $state(null);
  let report: ImportPlan | null = $state(null);
  let created = $state(0);
  let fileInput: HTMLInputElement | undefined = $state();

  const list = $derived(sources.current);
  const mayCite = $derived.by(() => {
    void revision?.current;
    return service.canCite();
  });
  const kinds = $derived(
    FORM_KINDS.includes(draft.kind as (typeof FORM_KINDS)[number])
      ? [...FORM_KINDS]
      : [draft.kind, ...FORM_KINDS],
  );

  const REASON: Record<string, StringKey> = {
    'read-only': 'sources.error.readOnly',
    duplicate: 'sources.error.duplicate',
    'not-defined': 'sources.error.gone',
    'no-change': 'sources.error.noChange',
    invalid: 'sources.error.invalid',
    cited: 'sources.error.cited',
  };

  function startAdd(): void {
    editing = '';
    draft = { ...EMPTY_DRAFT };
    bad = [];
    formError = null;
  }

  function startEdit(source: SourceSummary): void {
    editing = source.id;
    draft = draftOf(source);
    bad = [];
    formError = null;
  }

  function cancel(): void {
    editing = null;
    bad = [];
    formError = null;
  }

  function save(event: SubmitEvent): void {
    event.preventDefault();
    const adding = editing === '';
    const key = draft.id.trim();
    const values = valuesOf(draft);
    const result: SourceChangeResult = adding
      ? service.add(key, values)
      : service.update(editing!, values);
    if (result.ok) {
      shell.announce(adding ? 'announce.sources.added' : 'announce.sources.changed');
      editing = null;
      bad = [];
      formError = null;
      return;
    }
    bad = result.fields ?? (result.reason === 'duplicate' ? ['id'] : []);
    formError = REASON[result.reason] ?? 'sources.error.readOnly';
    shell.announce(formError);
  }

  function remove(source: SourceSummary): void {
    const result = service.remove(source.id);
    if (result.ok) {
      refusedDelete = null;
      shell.announce('announce.sources.deleted');
      return;
    }
    if (result.reason === 'cited') {
      refusedDelete = source.id;
      shell.announce('sources.error.cited');
    } else shell.announce(REASON[result.reason] ?? 'sources.error.readOnly');
  }

  function cite(source: SourceSummary): void {
    shell.announce(service.cite(source.id) ? 'announce.sources.cited' : 'sources.error.cite');
  }

  async function importFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const content = await file.text();
    input.value = '';
    const format = importFormat(file.name, content);
    const parsed = format === 'csl' ? parseCslJson(content) : parseBibtex(content);
    const plan = planImport(
      parsed,
      format,
      service.list.get().map((s) => s.id),
      (key, values) => service.check(key, values),
    );
    let made = 0;
    const refused = [...plan.refused];
    for (const source of plan.add) {
      const result = service.add(source.id, source.values);
      if (result.ok) made += 1;
      else
        refused.push({
          key: source.id,
          at: source.at,
          reason: result.reason === 'duplicate' ? 'exists' : 'invalid',
          ...(result.fields ? { fields: result.fields } : {}),
        });
    }
    created = made;
    report = { add: plan.add, refused, problems: plan.problems };
    shell.announce('announce.sources.imported', { count: made });
  }
</script>

<section class="de-sources" aria-label={tr.t('sources.label')}>
  {#if !canChange.current}
    <p class="de-hint" data-sources="read-only">{tr.t('sources.readOnly')}</p>
  {/if}

  {#if list.length === 0}
    <p data-sources="empty">{tr.t('sources.empty')}</p>
  {:else}
    <ul class="de-list de-sources-list">
      {#each list as source (source.id)}
        {@const line = sourceLine(source)}
        <li class="de-sources-item" data-source={source.id}>
          <p class="de-sources-title" data-content>{line.title || source.id}</p>
          <p class="de-hint">
            <span data-content>{[line.who, line.when].filter(Boolean).join(', ')}</span>
            <span class="de-badge" data-content>{source.id}</span>
          </p>
          <p class="de-hint" data-sources="count">
            {source.citedAt.length === 0
              ? tr.t('sources.notCited')
              : tr.t('sources.citedCount', { count: source.citedAt.length })}
          </p>
          {#if refusedDelete === source.id && source.citedAt.length > 0}
            <div data-sources="cited" role="group" aria-labelledby={`${id}-cited-${source.id}`}>
              <p class="de-error" id={`${id}-cited-${source.id}`}>{tr.t('sources.error.cited')}</p>
              <ol class="de-list">
                {#each source.citedAt as place, i (i)}
                  <li data-content>{place.excerpt || tr.t('sources.citedNoText')}</li>
                {/each}
              </ol>
            </div>
          {/if}
          <div class="de-actions">
            <button
              type="button"
              class="de-button"
              aria-disabled={mayCite ? undefined : 'true'}
              aria-label={tr.t('sources.cite.name', { source: line.title || source.id })}
              onclick={() => cite(source)}>{tr.t('sources.cite')}</button
            >
            {#if canChange.current}
              <button
                type="button"
                class="de-button"
                aria-label={tr.t('sources.edit.name', { source: line.title || source.id })}
                onclick={() => startEdit(source)}>{tr.t('sources.edit')}</button
              >
              <button
                type="button"
                class="de-button"
                aria-label={tr.t('sources.delete.name', { source: line.title || source.id })}
                onclick={() => remove(source)}>{tr.t('sources.delete')}</button
              >
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if canChange.current}
    {#if editing === null}
      <div class="de-actions">
        <button type="button" class="de-button" data-sources="add" onclick={startAdd}
          >{tr.t('sources.add')}</button
        >
        <button
          type="button"
          class="de-button"
          data-sources="import"
          onclick={() => fileInput?.click()}>{tr.t('sources.import')}</button
        >
        <input
          bind:this={fileInput}
          type="file"
          hidden
          accept=".bib,.bibtex,.json,application/json,text/plain"
          aria-label={tr.t('sources.import')}
          onchange={(e) => void importFile(e)}
        />
      </div>
    {:else}
      <form class="de-form" novalidate onsubmit={save} aria-labelledby={`${id}-form`}>
        <h3 class="de-subhead" id={`${id}-form`}>
          {editing === '' ? tr.t('sources.add') : tr.t('sources.edit')}
        </h3>
        {#if editing === ''}
          <label class="de-field" for={`${id}-id`}>{tr.t('sources.field.id')}</label>
          <input
            id={`${id}-id`}
            class="de-input"
            name="id"
            autocomplete="off"
            spellcheck="false"
            bind:value={draft.id}
            aria-invalid={bad.includes('id') ? 'true' : undefined}
            aria-describedby={`${id}-id-hint`}
            {@attach (node) => node.focus()}
          />
          <p class="de-hint" id={`${id}-id-hint`}>{tr.t('sources.hint.id')}</p>
        {/if}
        <label class="de-field" for={`${id}-kind`}>{tr.t('sources.field.kind')}</label>
        <select id={`${id}-kind`} class="de-input" name="kind" bind:value={draft.kind}>
          {#each kinds as kind (kind)}
            <option value={kind}>{kind}</option>
          {/each}
        </select>
        {#each FIELDS as field (field.name)}
          <label class="de-field" for={`${id}-${field.name}`}>{tr.t(field.key)}</label>
          <input
            id={`${id}-${field.name}`}
            class="de-input"
            name={field.name}
            autocomplete="off"
            bind:value={draft[field.name]}
            aria-invalid={bad.includes(field.name) ? 'true' : undefined}
            aria-describedby={field.hint ? `${id}-${field.name}-hint` : undefined}
          />
          {#if field.hint}
            <p class="de-hint" id={`${id}-${field.name}-hint`}>{tr.t(field.hint)}</p>
          {/if}
        {/each}
        {#if formError}
          <p class="de-error" data-sources="error">{tr.t(formError)}</p>
        {/if}
        <div class="de-actions">
          <button type="submit" class="de-button de-button-primary">{tr.t('sources.save')}</button>
          <button type="button" class="de-button" onclick={cancel}>{tr.t('sources.cancel')}</button>
        </div>
      </form>
    {/if}

    {#if report}
      <div data-sources="report" role="group" aria-labelledby={`${id}-report`}>
        <h3 class="de-subhead" id={`${id}-report`}>{tr.t('sources.import.result')}</h3>
        <p data-sources="created">{tr.t('sources.import.created', { count: created })}</p>
        {#if report.refused.length + report.problems.length > 0}
          <ul class="de-list">
            {#each report.refused as item (`${item.at}-${item.key}`)}
              <li data-refused={item.reason}>
                <span data-content>{item.key}</span>:
                {#if item.reason === 'duplicate'}
                  {tr.t('sources.import.duplicate', { at: item.at })}
                {:else if item.reason === 'exists'}
                  {tr.t('sources.import.exists')}
                {:else}
                  {tr.t('sources.import.invalid', { fields: (item.fields ?? []).join(', ') })}
                {/if}
              </li>
            {/each}
            {#each report.problems as problem, i (i)}
              <li data-refused="problem">
                {tr.t('sources.import.problem', { at: problem.at })}
                <span data-content>{problem.message}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  {/if}
</section>
