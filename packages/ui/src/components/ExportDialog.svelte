<!--
  Export with progress and diagnostics (UX-101; 09 §9.1, §9.2; EXP-004, EXP-005, EXP-065). The
  author chooses a target the deployment announces and the options of EXP-005, follows the job's
  state from its `export.*` events, may cancel it, opens the result, and goes from a diagnostic to
  the block it names. Severities are words, never colour alone. When the export leaves out parts
  hidden from the reader, the dialog says so (ADR 0019; UX-104 criterion 4). Completion, failure
  and cancellation are announced in the shell's live region.

  The client export filters of extensions (UX-055; 13 §7.1) are listed after the deployment's
  targets, each with its own label. Under `no-export` (13 §5 output restrictions) they are shown
  disabled with the reason. A chosen filter receives a copy of the document as the reader holds it
  (`CoreApi.getContent`) and its file is offered to save; a filter that throws is reported and
  the document is unchanged.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import type {
    ExportDiagnostic,
    ExportJobView,
    ExportOptions,
    ExportService,
    ExportTarget,
  } from '../core-api.ts';
  import { useShell } from '../context.ts';
  import { toBlob, type FilterRegistry } from '../extensions/filters.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { live } from '../live.ts';
  import Dialog from './Dialog.svelte';

  interface Props {
    exports?: ExportService | undefined;
    /** Client export filters of extensions (UX-055). */
    filters?: FilterRegistry | undefined;
    onClose: () => void;
  }

  let { exports, filters, onClose }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-export`;
  // svelte-ignore state_referenced_locally
  const targets = exports ? live(exports.targets) : { current: [] as readonly ExportTarget[] };
  // svelte-ignore state_referenced_locally
  const projected = exports?.projected ? live(exports.projected) : null;

  // Client filters, only when the core can give them the document.
  const permissions = shell.core.permissions ? live(shell.core.permissions) : null;
  const restrictions = $derived(permissions?.current?.restrictions ?? []);
  const filterChoices = $derived(
    filters && shell.core.getContent ? filters.choices('export', restrictions) : [],
  );
  let filterId = $state<string | null>(null);
  const chosenFilter = $derived(
    filterId ??
      (targets.current.length === 0 ? (filterChoices.find((c) => c.enabled)?.id ?? null) : null),
  );
  const filterEnabled = $derived(filterChoices.find((c) => c.id === chosenFilter)?.enabled ?? false);
  // Under `no-export` the deployment's targets are refused too (UX-040 criterion 1): the service
  // refuses the job, so the dialog shows the same disabled controls and reason as for filters.
  const noExport = $derived(restrictions.includes('no-export'));

  let target = $state<ExportTarget | null>(null);
  const chosen = $derived(chosenFilter ? null : (target ?? targets.current[0] ?? null));
  let profile = $state<NonNullable<ExportOptions['profile']>>('preview');
  let tagging = $state<NonNullable<ExportOptions['tagging']>>('on');
  let fields = $state<NonNullable<ExportOptions['fields']>>('flatten');
  // The options that have no value of their own: left empty, the request omits them and the
  // service applies the schema's defaults (EXP-005 criterion 4).
  let standard = $state<'' | NonNullable<ExportOptions['pdfStandard']>>('');
  let locale = $state('');
  let timeZone = $state('');

  let job = $state.raw<ExportJobView | null>(null);
  let failedToStart = $state(false);
  let stop: (() => void) | null = null;
  let announced: string | null = null;
  let gone = $state<string | null>(null);
  let moved = $state<string | null>(null);
  // The preflight's warnings for a request the author has not confirmed yet (EXP-003).
  let pending = $state.raw<{
    target: ExportTarget;
    options: ExportOptions;
    warnings: readonly ExportDiagnostic[];
  } | null>(null);

  const running = $derived(
    job !== null && (job.state === 'queued' || job.state === 'converting' || job.state === 'compiling'),
  );

  // The file a client filter wrote, as an object URL to save; released when replaced or closed.
  let saved = $state.raw<{ name: string; url: string } | null>(null);
  let writing = $state(false);
  let filterFailed = $state(false);
  let filterRefused = $state(false);
  let closed = false;

  function release(): void {
    if (saved) URL.revokeObjectURL(saved.url);
    saved = null;
  }

  onDestroy(() => {
    closed = true;
    stop?.();
    release();
  });

  async function runFilter(filterIdToRun: string): Promise<void> {
    if (!filters || !shell.core.getContent) return;
    release();
    filterFailed = false;
    filterRefused = false;
    writing = true;
    let outcome: Awaited<ReturnType<FilterRegistry['runExport']>>;
    try {
      // A copy: whatever the filter does with it, the document the core holds is unchanged.
      const content: unknown = structuredClone(shell.core.getContent());
      outcome = await filters.runExport(filterIdToRun, content, restrictions);
    } catch (error) {
      outcome = { ok: false, reason: 'failed', error };
    }
    writing = false;
    if (closed) return;
    if (outcome.ok) {
      saved = { name: outcome.name, url: URL.createObjectURL(toBlob(outcome)) };
      shell.announce('announce.export.completed');
    } else if (outcome.reason === 'no-export') {
      filterRefused = true;
    } else {
      filterFailed = true;
      shell.announce('announce.export.failed');
    }
  }

  function follow(jobId: string): void {
    stop?.();
    if (!exports) return;
    const view = exports.job(jobId);
    const update = () => {
      job = view.get();
      const state = job?.state;
      if (!state || state === announced) return;
      if (state === 'completed' || state === 'failed' || state === 'cancelled') {
        announced = state;
        shell.announce(`announce.export.${state}` as StringKey);
      }
    };
    stop = view.subscribe(update);
    update();
  }

  async function start(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (noExport) return;
    if (chosenFilter) {
      if (filterEnabled) await runFilter(chosenFilter);
      return;
    }
    if (!chosen || !exports || pending) return;
    failedToStart = false;
    gone = null;
    moved = null;
    let options: ExportOptions =
      chosen === 'pdf' ? { profile, tagging, fields } : chosen === 'tex' ? { fields } : {};
    if (chosen === 'pdf' || chosen === 'tex') {
      const tag = locale.trim();
      const zone = timeZone.trim();
      options = {
        ...options,
        ...(chosen === 'pdf' && standard ? { pdfStandard: standard } : {}),
        ...(tag ? { locale: tag } : {}),
        ...(zone ? { timeZone: zone } : {}),
      };
    }
    // The preflight runs before any job is created (EXP-003 criterion 3). With warnings the author
    // chooses to continue or not; a preflight that fails does not stop the export, since the job
    // reports the same things.
    if (exports.preflight) {
      let warnings: readonly ExportDiagnostic[];
      try {
        warnings = await exports.preflight(chosen);
      } catch {
        warnings = [];
      }
      if (closed) return;
      if (warnings.length > 0) {
        pending = { target: chosen, options, warnings };
        return;
      }
    }
    await begin(chosen, options);
  }

  async function begin(to: ExportTarget, options: ExportOptions): Promise<void> {
    if (!exports) return;
    announced = null;
    try {
      const { jobId } = await exports.request(to, options);
      follow(jobId);
    } catch {
      failedToStart = true;
    }
  }

  /** The author read the preflight's warnings and exports anyway. */
  async function proceed(): Promise<void> {
    const held = pending;
    pending = null;
    if (held) await begin(held.target, held.options);
  }

  function cancel(): void {
    if (job) void exports?.cancel(job.id);
  }

  // The PDF preview pane exists when the core has a viewer and follows the newest PDF (EXP-001).
  // svelte-ignore state_referenced_locally
  const canPreview = shell.core.pdf !== undefined && exports?.latestPdf !== undefined;

  /** Closes this dialog and shows the finished PDF in the PDF preview pane (EXP-001). */
  function showInPane(): void {
    onClose();
    if (!shell.panes.isOpen('pdf')) shell.panes.toggle('pdf');
  }

  function severityKey(d: ExportDiagnostic): StringKey {
    return d.severity === 'error'
      ? 'export.severity.error'
      : d.severity === 'warning'
        ? 'export.severity.warning'
        : 'export.severity.info';
  }

  /** True when the core says the diagnostic's block changed after the exported `seq` (EXP-065). */
  function changedSince(d: ExportDiagnostic): boolean {
    if (!d.blockId || !job) return false;
    return shell.core.blockChangedSince?.(d.blockId, job.seq) === true;
  }

  function goTo(d: ExportDiagnostic): void {
    if (!d.blockId) return;
    gone = null;
    moved = null;
    if (!shell.core.selectBlock?.(d.blockId)) {
      gone = d.blockId;
      return;
    }
    // The editor has moved. When the block changed after the exported commit, the dialog stays
    // open and says so, because the problem may no longer be there (EXP-065 criterion 3).
    if (changedSince(d)) moved = d.blockId;
    else onClose();
  }

  const TARGETS: Readonly<Record<ExportTarget, StringKey>> = {
    pdf: 'export.target.pdf',
    tex: 'export.target.tex',
    docx: 'export.target.docx',
    cdm: 'export.target.cdm',
    html: 'export.target.html',
    md: 'export.target.md',
  };
</script>

<Dialog name="export" title={tr.t('dialog.export.title')} {onClose}>
  {#if projected?.current}
    <p class="de-hint" data-export="hidden">{tr.t('dialog.export.hidden')}</p>
  {/if}
  <form class="de-form" onsubmit={start}>
    <fieldset class="de-fieldset" disabled={running || writing || pending !== null}>
      <legend>{tr.t('dialog.export.target')}</legend>
      {#each targets.current as t, i (t)}
        <label class="de-check">
          <input
            type="radio"
            name={`${id}-target`}
            value={t}
            checked={t === chosen}
            disabled={noExport}
            aria-describedby={noExport ? `${id}-no-export` : undefined}
            data-autofocus={i === 0 ? '' : undefined}
            onchange={() => {
              target = t;
              filterId = null;
            }}
          />
          <span>{tr.t(TARGETS[t])}</span>
        </label>
      {/each}
      {#each filterChoices as c, i (c.id)}
        <label class="de-check">
          <input
            type="radio"
            name={`${id}-target`}
            value={c.id}
            data-filter={c.id}
            checked={c.id === chosenFilter}
            disabled={!c.enabled}
            aria-describedby={c.enabled ? undefined : `${id}-no-export`}
            data-autofocus={i === 0 && targets.current.length === 0 ? '' : undefined}
            onchange={() => (filterId = c.id)}
          />
          <span data-content>{c.label}</span>
        </label>
      {/each}
      {#if noExport || filterChoices.some((c) => !c.enabled)}
        <p class="de-hint" id={`${id}-no-export`} data-export="no-export">
          {tr.t('export.filter.noExport')}
        </p>
      {/if}
    </fieldset>
    {#if chosen === 'pdf'}
      <fieldset class="de-fieldset" disabled={running}>
        <legend>{tr.t('dialog.export.profile')}</legend>
        {#each ['preview', 'final'] as const as p (p)}
          <label class="de-check">
            <input type="radio" name={`${id}-profile`} value={p} bind:group={profile} />
            <span>{tr.t(`export.profile.${p}`)}</span>
          </label>
        {/each}
      </fieldset>
      <label class="de-field" for={`${id}-tagging`}>{tr.t('dialog.export.tagging')}</label>
      <select id={`${id}-tagging`} class="de-input" bind:value={tagging} disabled={running}>
        {#each ['on', 'draft', 'off'] as const as t (t)}
          <option value={t}>{tr.t(`export.tagging.${t}`)}</option>
        {/each}
      </select>
    {/if}
    {#if chosen === 'pdf' || chosen === 'tex'}
      <label class="de-field" for={`${id}-fields`}>{tr.t('dialog.export.fields')}</label>
      <select id={`${id}-fields`} class="de-input" bind:value={fields} disabled={running}>
        {#each ['flatten', 'blank'] as const as f (f)}
          <option value={f}>{tr.t(`export.fields.${f}`)}</option>
        {/each}
      </select>
    {/if}
    {#if chosen === 'pdf'}
      <label class="de-field" for={`${id}-standard`}>{tr.t('dialog.export.standard')}</label>
      <select id={`${id}-standard`} class="de-input" bind:value={standard} disabled={running}>
        <option value="">{tr.t('export.standard.default')}</option>
        {#each ['ua-2', 'a-4'] as const as s (s)}
          <option value={s}>{tr.t(`export.standard.${s}`)}</option>
        {/each}
      </select>
    {/if}
    {#if chosen === 'pdf' || chosen === 'tex'}
      <label class="de-field" for={`${id}-locale`}>{tr.t('dialog.export.locale')}</label>
      <input
        id={`${id}-locale`}
        class="de-input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        bind:value={locale}
        disabled={running}
      />
      <label class="de-field" for={`${id}-time-zone`}>{tr.t('dialog.export.timeZone')}</label>
      <input
        id={`${id}-time-zone`}
        class="de-input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        bind:value={timeZone}
        disabled={running}
      />
    {/if}
    <div class="de-dialog-actions">
      {#if running}
        <button type="button" class="de-button" onclick={cancel}>{tr.t('dialog.export.cancel')}</button>
      {:else}
        <button
          type="submit"
          class="de-button de-button-primary"
          disabled={noExport ||
            pending !== null ||
            (chosenFilter ? !filterEnabled || writing : !chosen)}
          >{job || saved ? tr.t('dialog.export.again') : tr.t('dialog.export.start')}</button
        >
      {/if}
    </div>
  </form>
  {#if pending}
    <section class="de-export-preflight" data-export="preflight" aria-labelledby={`${id}-preflight`}>
      <h3 class="de-subhead" id={`${id}-preflight`}>{tr.t('export.preflight.title')}</h3>
      <p class="de-hint" role="status">{tr.t('export.preflight.hint')}</p>
      <ul class="de-list" aria-label={tr.t('export.preflight.title')}>
        {#each pending.warnings as d, i (i)}
          <li data-severity={d.severity}>
            <button
              type="button"
              class="de-list-button"
              disabled={!d.blockId}
              onclick={() => goTo(d)}
            >
              <span class="de-severity" data-severity={d.severity}>{tr.t(severityKey(d))}</span>
              <span data-content>{d.message}</span>
            </button>
          </li>
        {/each}
      </ul>
      {#if gone}
        <p class="de-error" role="status">{tr.t('export.diagnostic.gone')}</p>
      {/if}
      <div class="de-dialog-actions">
        <button type="button" class="de-button" onclick={() => (pending = null)}
          >{tr.t('export.preflight.cancel')}</button
        >
        <button type="button" class="de-button de-button-primary" onclick={proceed}
          >{tr.t('export.preflight.continue')}</button
        >
      </div>
    </section>
  {/if}
  {#if failedToStart}
    <p class="de-error" role="alert">{tr.t('export.failed.start')}</p>
  {/if}
  {#if saved}
    <p>
      <a class="de-link" href={saved.url} download={saved.name} data-export="file"
        >{tr.t('export.filter.save', { name: saved.name })}</a
      >
    </p>
  {/if}
  {#if filterFailed}
    <p class="de-error" role="alert" data-export="filter-failed">{tr.t('export.filter.failed')}</p>
  {/if}
  {#if filterRefused}
    <p class="de-error" role="alert">{tr.t('export.filter.noExport')}</p>
  {/if}
  {#if job}
    <section class="de-export-job" data-state={job.state} aria-labelledby={`${id}-state`}>
      <p class="de-export-state" id={`${id}-state`}>
        <span class="de-state-mark" data-state={job.state} aria-hidden="true"></span>
        <span data-status="export">{tr.t(`export.state.${job.state}`)}</span>
      </p>
      {#if running}
        <progress
          class="de-progress"
          max="100"
          value={job.progress ?? undefined}
          aria-label={tr.t('export.progress')}
        ></progress>
      {/if}
      {#if job.state === 'completed' && job.result}
        <p>
          <a class="de-link" href={job.result.url} target="_blank" rel="noopener noreferrer"
            >{tr.t('export.open')}</a
          >
        </p>
        {#if job.target === 'pdf' && canPreview}
          <p>
            <button type="button" class="de-button" data-export="show-in-pane" onclick={showInPane}
              >{tr.t('export.showInPane')}</button
            >
          </p>
        {/if}
        {#if job.result.pages !== null}
          <p data-export="pages">{tr.t('export.pages', { count: job.result.pages })}</p>
        {/if}
        {#if job.result.converged !== null}
          <p data-export="converged">
            {job.result.converged ? tr.t('export.converged') : tr.t('export.notConverged')}
          </p>
        {/if}
      {/if}
      {#if job.state === 'failed' && job.error}
        <p class="de-error" data-content>{job.error.message}</p>
      {/if}
      {#if job.state === 'completed' || job.state === 'failed'}
        <h3 class="de-subhead">{tr.t('export.diagnostics')}</h3>
        {#if job.diagnostics.length === 0}
          <p>{tr.t('export.diagnostics.none')}</p>
        {:else}
          <ul class="de-list" aria-label={tr.t('export.diagnostics')}>
            {#each job.diagnostics as d, i (i)}
              <li data-severity={d.severity}>
                <button
                  type="button"
                  class="de-list-button"
                  disabled={!d.blockId}
                  onclick={() => goTo(d)}
                >
                  <span class="de-severity" data-severity={d.severity}>{tr.t(severityKey(d))}</span>
                  <span data-content>{d.message}</span>
                  {#if changedSince(d)}
                    <span class="de-hint" data-export="changed"
                      >{tr.t('export.diagnostic.changed')}</span
                    >
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
          {#if gone}
            <p class="de-error" role="status">{tr.t('export.diagnostic.gone')}</p>
          {/if}
          {#if moved}
            <p class="de-hint" role="status" data-export="moved">
              {tr.t('export.diagnostic.moved')}
            </p>
          {/if}
        {/if}
      {/if}
    </section>
  {/if}
</Dialog>
