<!--
  The accessibility checker pane (UX-066, UX-067; 13 §8). It lists the issues the checker finds in
  the document the core holds, grouped by kind, each with its block identifier and a short
  explanation. Choosing an issue moves the caret to its block through the core. An issue in a part
  this reader may not change is marked as not fixable here, with who can fix it. The list follows
  the core's revision and access, so a fix removes its issue and the count is announced. The
  checker changes nothing (UX-066 criterion 6). Loaded on demand (UX-070).
-->
<script lang="ts">
  import '../i18n/late/checkerPane.ts';
  import { onDestroy, untrack } from 'svelte';
  import { useShell } from '../context.ts';
  import type { CoreApi } from '../core-api.ts';
  import { type Translator, sourceTranslator } from '../i18n/strings.ts';
  import { live } from '../live.ts';
  import type { CheckKind } from '../shell/accessibility-check.ts';
  import {
    runAccessibilityCheck,
    type AccessibilityResult,
    type ListedIssue,
  } from '../shell/accessibility-run.ts';
  import { browserIdle, quietScheduler } from '../shell/quiet-scheduler.ts';

  interface Props {
    core?: CoreApi;
    close?: () => void;
  }

  let props: Props = $props();

  const shell = useShell();
  const fallback = sourceTranslator();
  const tr: Translator = $derived(shell?.strings.current ?? fallback);
  const core = untrack(() => props.core ?? shell?.core);
  // The views the check reads; each is read in the derivation so that a change re-runs it.
  const revision = core?.revision ? live(core.revision) : null;
  const access = core?.permissions ? live(core.permissions) : null;
  const regions = core?.regions ? live(core.regions) : null;

  /** Principals are shown by their identifier until the directory names them. */
  const nameOf = (principal: string): string => principal.replace(/^user:/, '');

  /** How long the document stays quiet before the list is worked out again (UX-066 criterion 5). */
  const QUIET_MS = 250;
  const scheduler = quietScheduler({ quietMs: QUIET_MS, whenIdle: browserIdle() });
  onDestroy(() => scheduler.cancel());

  function compute(): AccessibilityResult | null {
    return core ? runAccessibilityCheck(core, tr, nameOf) : null;
  }

  // The first list is made when the pane opens. After that the list follows the document, but not
  // inside a keystroke: the check reads the whole document, so a change asks for a run once the
  // document has been quiet, and a burst of changes costs one run.
  let result = $state.raw<AccessibilityResult | null>(untrack(compute));
  let opened = false;
  $effect(() => {
    void revision?.current;
    void access?.current;
    void regions?.current;
    void tr;
    if (!opened) {
      opened = true;
      return;
    }
    scheduler.request(() => {
      result = untrack(compute);
    });
  });

  /** The issues of each kind that has any, in the checker's order. */
  const groups = $derived(
    (result?.report.groups ?? []).map((group) => ({
      kind: group.kind,
      items: result!.issues.filter((item) => item.issue.kind === group.kind),
    })),
  );

  let selected = $state<string | null>(null);

  function kindLabel(kind: CheckKind): string {
    switch (kind) {
      case 'alt-text':
        return tr.t('checker.kind.alt-text');
      case 'heading-order':
        return tr.t('checker.kind.heading-order');
      case 'table-header':
        return tr.t('checker.kind.table-header');
      case 'link-text':
        return tr.t('checker.kind.link-text');
      case 'contrast':
        return tr.t('checker.kind.contrast');
    }
  }

  function explain(item: ListedIssue): string {
    const d = item.issue.detail;
    switch (item.issue.kind) {
      case 'alt-text':
        return tr.t('checker.explain.alt-text');
      case 'heading-order':
        return tr.t('checker.explain.heading-order', {
          from: String(d['from'] ?? ''),
          to: String(d['to'] ?? ''),
        });
      case 'table-header':
        return tr.t('checker.explain.table-header');
      case 'link-text':
        return d['reason'] === 'empty'
          ? tr.t('checker.explain.link-text.empty')
          : tr.t('checker.explain.link-text.generic');
      case 'contrast':
        return tr.t('checker.explain.contrast', {
          ratio: Number(d['ratio'] ?? 0).toFixed(2),
        });
    }
  }

  function go(item: ListedIssue): void {
    selected = item.issue.blockId;
    core?.selectBlock?.(item.issue.blockId);
  }
</script>

<section class="de-checker" aria-label={tr.t('pane.checker')} data-checker>
  {#if !result}
    <p class="de-hint" data-status="unavailable">{tr.t('checker.unavailable')}</p>
  {:else}
    <p class="de-hint" role="status" data-status="count">
      {result.report.count === 0
        ? tr.t('checker.none')
        : tr.t('checker.count', { count: result.report.count })}
    </p>
    {#each groups as group (group.kind)}
      <h3 class="de-checker-kind" data-kind={group.kind}>
        {kindLabel(group.kind)} ({group.items.length})
      </h3>
      <ul class="de-list" aria-label={kindLabel(group.kind)}>
        {#each group.items as item, i (i)}
          <li class="de-checker-item" data-kind={item.issue.kind} data-block={item.issue.blockId}>
            <span class="de-checker-where">{tr.t('checker.block', { id: item.issue.blockId })}</span>
            <span class="de-checker-why" data-content>{explain(item)}</span>
            <button
              type="button"
              class="de-list-button"
              aria-current={selected === item.issue.blockId ? 'true' : undefined}
              onclick={() => go(item)}>{tr.t('checker.go')}</button
            >
            {#if item.fix.fixable}
              <span class="de-hint" data-fixable="true">{tr.t('checker.fixable')}</span>
            {:else}
              <span class="de-hint" data-fixable="false"
                >{item.fix.who
                  ? tr.t('checker.locked.who', { who: item.fix.who })
                  : tr.t('checker.locked')}</span
              >
            {/if}
          </li>
        {/each}
      </ul>
    {/each}
  {/if}
</section>
