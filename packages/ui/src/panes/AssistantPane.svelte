<!--
  The assistant pane (UX-045; 13 §3, §6.2, §12). The author asks for a draft, a rewrite of the
  selection, a summary or an answer to a question, and the answer is shown here. Nothing in the
  document changes until the author approves the insertion, and then the core puts the result in as
  suggestions, never as a direct edit (UX-046). Where the core refuses, nothing is applied and the
  author is told. A running request can be cancelled and then applies
  nothing. A failure says what happened and offers a retry. The author's access decides which
  requests are available: a view-only author may ask questions and for summaries, and a draft or a
  rewrite is marked unavailable with its reason. Progress and completion are announced in a live
  region. The pane exists only while an assistant port is attached, and loads on demand (UX-070).
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { useShell } from '../context.ts';
  import type { Capability } from '../core-api.ts';
  import { createAssistantController } from '../assistant/controller.ts';
  import {
    announcement,
    assistantAsk,
    errorMessageKey,
    insertionAllowed,
    retryOffered,
    type AssistantKind,
  } from '../assistant/request-lifecycle.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { live } from '../live.ts';

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const api = untrack(() => shell.core.assistant!);
  const access = shell.core.access ? live(shell.core.access) : null;
  const id = `de-assistant-${Math.random().toString(36).slice(2, 8)}`;

  const caps = (): readonly Capability[] => access?.current.caps ?? [];

  let version = $state(0);
  const controller = createAssistantController({
    api,
    caps: () => untrack(caps),
    onChange: () => {
      version++;
    },
  });
  onDestroy(() => controller.dispose());

  const view = $derived.by(() => {
    void version;
    return controller.view();
  });
  const run = $derived(view.state);
  let prompt = $state('');

  const KINDS: readonly AssistantKind[] = ['draft', 'rewrite', 'summary', 'question'];
  const running = $derived(run.phase === 'running');
  const mayInsert = $derived(insertionAllowed(access?.current.caps ?? []));
  const offers = $derived(
    KINDS.map((kind) => ({ kind, offer: assistantAsk(kind, access?.current.caps ?? []) })),
  );
  const t = (key: string): string => tr.t(key as StringKey);
  const message = $derived.by(() => {
    const key = announcement(run);
    if (key) return t(key);
    if (view.inserted) return t('assistant.inserted');
    return run.phase === 'cancelled' ? t('assistant.cancelled') : '';
  });

  function ask(kind: AssistantKind): void {
    const offer = assistantAsk(kind, caps());
    if (!offer.enabled || running) return;
    controller.ask(kind, prompt);
  }
</script>

<section class="de-assistant" aria-label={tr.t('assistant.label')} data-assistant>
  <label class="de-field" for={`${id}-prompt`}>{tr.t('assistant.prompt')}</label>
  <textarea
    id={`${id}-prompt`}
    class="de-input"
    rows="4"
    aria-describedby={`${id}-hint`}
    bind:value={prompt}
  ></textarea>
  <p class="de-hint" id={`${id}-hint`}>{tr.t('assistant.prompt.hint')}</p>

  <div class="de-actions" role="group" aria-label={tr.t('assistant.label')}>
    {#each offers as { kind, offer } (kind)}
      <button
        type="button"
        class="de-button"
        data-ask={kind}
        aria-disabled={offer.enabled && !running ? undefined : 'true'}
        aria-describedby={offer.enabled ? undefined : `${id}-why-${kind}`}
        onclick={() => ask(kind)}>{t(`assistant.${kind}`)}</button
      >
    {/each}
  </div>
  {#each offers as { kind, offer } (kind)}
    {#if !offer.enabled}
      <p class="de-hint" id={`${id}-why-${kind}`} data-refused={kind}>
        {t(`assistant.refused.${offer.reason}`)}
      </p>
    {/if}
  {/each}

  <p class="de-visually-hidden" role="status" data-assistant-live>{message}</p>

  {#if run.phase === 'running'}
    <p class="de-hint" data-assistant-state="running">{tr.t('assistant.progress')}</p>
    <div class="de-actions">
      <button type="button" class="de-button" data-assistant-cancel onclick={() => controller.cancel()}
        >{tr.t('assistant.cancel')}</button
      >
    </div>
  {:else if run.phase === 'shown'}
    <h3 class="de-checker-kind">{tr.t('assistant.response')}</h3>
    <div
      class="de-assistant-response"
      data-assistant-state="shown"
      data-content
      role="region"
      tabindex="-1"
      aria-label={tr.t('assistant.response')}
    >
      {run.text}
    </div>
    {#if view.insertRefused !== null}
      <p class="de-error" data-assistant-insert-refused role="alert">
        {tr.t('assistant.insert.refused')}
      </p>
    {/if}
    <div class="de-actions">
      {#if api.insert}
        <button
          type="button"
          class="de-button"
          data-assistant-insert
          aria-disabled={mayInsert ? undefined : 'true'}
          aria-describedby={mayInsert ? undefined : `${id}-why-insert`}
          onclick={() => mayInsert && controller.approve()}>{tr.t('assistant.insert')}</button
        >
      {/if}
      <button type="button" class="de-button" onclick={() => controller.dismiss()}
        >{tr.t('assistant.dismiss')}</button
      >
    </div>
    {#if api.insert && !mayInsert}
      <p class="de-hint" id={`${id}-why-insert`}>{tr.t('assistant.refused.no-change')}</p>
    {/if}
  {:else if run.phase === 'failed'}
    <p class="de-error" data-assistant-state="failed" data-failure={run.failure}>
      {t(errorMessageKey(run.failure))}
    </p>
    {#if retryOffered(run)}
      <div class="de-actions">
        <button type="button" class="de-button" data-assistant-retry onclick={() => controller.retry()}
          >{tr.t('assistant.retry')}</button
        >
      </div>
    {/if}
  {:else if view.inserted}
    <p class="de-hint" data-assistant-state="inserted">{tr.t('assistant.inserted')}</p>
  {:else if run.phase === 'cancelled'}
    <p class="de-hint" data-assistant-state="cancelled">{tr.t('assistant.cancelled')}</p>
  {/if}
</section>
