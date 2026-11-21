<!--
  The PDF preview pane (EXP-001; 13 §3; 09 §9.1, §9.3 rule 7; 06 §10). It shows the newest PDF this
  session asked for: the job's state while it runs, then the pages. The pages are drawn by the
  core's viewer in a sandboxed frame of another origin (FE-071); this pane never fetches or parses
  the file, it hands the viewer a place and the job's signed URL.

  The pane can ask for a quick preview itself. Opened with nothing to show, it asks for one, because
  someone is looking now. A preview this pane asked for that has not finished is cancelled when the
  pane closes, so nothing is typeset for a pane nobody looks at (06 §10; EXP-008). An export started
  from the export dialog is never cancelled here.

  A one-pass preview may show page numbers that are out of date; the job says so (`converged`) and
  the pane repeats it in words (09 §8).
-->
<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import type { ExportJobView } from '../core-api.ts';
  import { useShell } from '../context.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { live } from '../live.ts';

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const exports = shell.core.exports;
  const pdf = shell.core.pdf;
  const latestView = exports?.latestPdf;
  const latest = latestView ? live(latestView) : null;

  const isRunning = (j: ExportJobView | null): boolean =>
    j !== null && (j.state === 'queued' || j.state === 'converting' || j.state === 'compiling');

  const job = $derived(latest?.current ?? null);
  const running = $derived(isRunning(job));

  let pagesEl: HTMLElement | undefined = $state();
  /** What the viewer shows now: the job and its page count as the viewer read it. */
  let shown = $state.raw<{ job: string; pages: number } | null>(null);
  let opening = $state(false);
  let viewFailed = $state(false);
  let asking = $state(false);
  let startFailed = $state(false);

  // Plain variables: they steer the effects below and must not make them run again.
  let viewer: { destroy(): void } | null = null;
  let openedFor: string | null = null;
  let own: string | null = null;
  let announced: string | null = null;
  let turn = 0;
  let closed = false;

  async function show(id: string, url: string, target: HTMLElement): Promise<void> {
    if (!pdf) return;
    openedFor = id;
    const mine = ++turn;
    viewer?.destroy();
    viewer = null;
    shown = null;
    viewFailed = false;
    opening = true;
    try {
      const opened = await pdf.open(target, { url });
      if (closed || mine !== turn) {
        opened.viewer.destroy();
        return;
      }
      viewer = opened.viewer;
      shown = { job: id, pages: opened.pages };
    } catch {
      if (!closed && mine === turn) viewFailed = true;
    } finally {
      if (mine === turn) opening = false;
    }
  }

  // A completed PDF is opened once, when its job and the place for its pages are both there.
  $effect(() => {
    const j = job;
    const target = pagesEl;
    if (!j || !target || j.state !== 'completed' || !j.result) return;
    if (openedFor === j.id) return;
    const url = j.result.url;
    untrack(() => void show(j.id, url, target));
  });

  // The end of a preview this pane asked for is said in the live region, as the dialog does for its own.
  $effect(() => {
    const j = job;
    if (!j || j.id !== own || isRunning(j) || announced === j.id) return;
    announced = j.id;
    untrack(() => shell.announce(`announce.export.${j.state}` as StringKey));
  });

  async function preview(): Promise<void> {
    if (!exports || asking) return;
    startFailed = false;
    asking = true;
    try {
      const { jobId } = await exports.request('pdf', { profile: 'preview' });
      own = jobId;
    } catch {
      if (!closed) startFailed = true;
    } finally {
      asking = false;
    }
  }

  function cancel(): void {
    if (job && running) void exports?.cancel(job.id).catch(() => {});
  }

  onMount(() => {
    // Nothing to show yet: the reader opened the preview, so one is made (06 §10).
    if (latestView && latestView.get() === null) void preview();
  });

  onDestroy(() => {
    closed = true;
    viewer?.destroy();
    viewer = null;
    // A preview of this pane that nobody will look at is not typeset (EXP-008 criterion 4).
    const last = latestView?.get() ?? null;
    if (own !== null && last !== null && last.id === own && isRunning(last))
      void exports?.cancel(own).catch(() => {});
  });
</script>

<section class="de-pdf-pane" aria-label={tr.t('pane.pdf')} data-state={job?.state ?? 'none'}>
  {#if job}
    <p class="de-export-state">
      <span class="de-state-mark" data-state={job.state} aria-hidden="true"></span>
      <span data-status="pdf">{tr.t(`export.state.${job.state}`)}</span>
    </p>
    {#if running}
      <progress
        class="de-progress"
        max="100"
        value={job.progress ?? undefined}
        aria-label={tr.t('export.progress')}
      ></progress>
    {/if}
    {#if job.state === 'failed' && job.error}
      <p class="de-error" data-content>{job.error.message}</p>
    {/if}
  {:else if !asking && !startFailed}
    <p class="de-hint" data-pdf="empty">{tr.t('pdf.empty')}</p>
  {/if}
  {#if startFailed}
    <p class="de-error" role="alert" data-pdf="start-failed">{tr.t('pdf.failed.start')}</p>
  {/if}
  {#if opening}
    <p class="de-hint" role="status" data-pdf="loading">{tr.t('pdf.loading')}</p>
  {/if}
  {#if viewFailed}
    <p class="de-error" role="alert" data-pdf="view-failed">{tr.t('pdf.failed.view')}</p>
  {/if}
  {#if shown && job && shown.job === job.id}
    <p data-pdf="pages">{tr.t('export.pages', { count: shown.pages })}</p>
    {#if job.result?.converged === false}
      <p class="de-hint" data-pdf="stale">{tr.t('export.notConverged')}</p>
    {/if}
  {/if}
  <div class="de-actions">
    {#if running}
      <button type="button" class="de-button" onclick={cancel}
        >{tr.t('dialog.export.cancel')}</button
      >
    {:else}
      <button type="button" class="de-button" disabled={asking} onclick={() => void preview()}
        >{job ? tr.t('pdf.refresh') : tr.t('pdf.make')}</button
      >
    {/if}
  </div>
  <!-- The viewer's frame goes here; the pane keeps the place while a newer PDF is on its way. -->
  <div class="de-pdf-pane-pages" bind:this={pagesEl}></div>
</section>
