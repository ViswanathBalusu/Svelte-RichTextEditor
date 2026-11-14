<!--
  The comment box (UX-028; UX-031): the dialog the comment command (`review.comment`) opens for the
  selection it was run on. The author types the first comment; `@` and a name fragment ask the
  host's `searchPrincipals` (the picker of `shell/mention-picker.ts`), and choosing a result puts a
  mention in the text, which is posted as a node holding the principal only. Without a
  `searchPrincipals`, no mention is offered and plain comments still work.

  Posting runs `createCommentThread` (`shell/comment-create.ts`) on the anchor the command took, the
  scopes it covers and the document's thread count, then asks the core's `threads.create`. That is a
  control-plane request: nothing here commits. On any refusal, ours or the service's, the typed text
  stays in the box and the reason is shown.
-->
<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { useShell } from '../context.ts';
  import type { CommentAnchor, ThreadOutcome, ThreadsService } from '../core-api.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { bodyParts, placeMention, type PlacedMention } from '../shell/comment-composer.ts';
  import {
    createCommentThread,
    serverRefusal,
    type CreateRefusal,
  } from '../shell/comment-create.ts';
  import { createMentionPicker, type PickerState } from '../shell/mention-picker.ts';
  import Dialog from './Dialog.svelte';

  interface Props {
    threads: ThreadsService;
    /** What the command was run on: taken when it ran, so moving focus here does not change it. */
    anchor: CommentAnchor;
    onPosted: () => void;
    onClose: () => void;
  }

  let { threads, anchor, onPosted, onClose }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-comment`;

  const picker = createMentionPicker({
    docId: shell.docId ?? '',
    searchPrincipals: shell.searchPrincipals,
  });

  const REFUSALS: Readonly<Record<CreateRefusal | 'failed', StringKey>> = {
    noComment: 'comment.refused.noComment',
    badRange: 'comment.refused.target',
    emptyBlock: 'comment.refused.target',
    emptyBody: 'comment.refused.emptyBody',
    threadLimit: 'comment.refused.threadLimit',
    permissionsChanged: 'comment.refused.permissionsChanged',
    baseSeqOutOfWindow: 'comment.refused.baseSeqOutOfWindow',
    failed: 'comment.refused.failed',
  };

  let text = $state('');
  let mentions = $state.raw<PlacedMention[]>([]);
  let list = $state.raw<PickerState>(picker.state());
  let refusal = $state<CreateRefusal | 'failed' | null>(null);
  let sending = $state(false);
  let field: HTMLTextAreaElement | undefined = $state();
  let gone = false;
  onDestroy(() => (gone = true));

  const describedBy = $derived(
    [picker.offered ? `${id}-hint` : '', refusal ? `${id}-error` : ''].filter(Boolean).join(' ') ||
      undefined,
  );

  async function lookUp(): Promise<void> {
    if (!field || !picker.offered) return;
    const shown = await picker.update(field.value, field.selectionStart);
    if (gone) return;
    list = picker.state();
    if (shown) shell.announce('comment.mention.results', { count: list.results.length });
  }

  function choose(index?: number): void {
    if (!field) return;
    const picked = list.results[index ?? list.active ?? -1];
    const chosen = picker.choose(field.value, field.selectionStart, index);
    list = picker.state();
    if (!chosen || !picked) return;
    const placed = placeMention(chosen.parts, picked.name);
    if (!placed) return;
    text = placed.text;
    mentions = [...mentions, placed.mention];
    shell.announce('comment.mention.added', { name: picked.name });
    void tick().then(() => {
      field?.focus();
      field?.setSelectionRange(placed.caret, placed.caret);
    });
  }

  function closeList(): void {
    picker.close();
    list = picker.state();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!list.open) return;
    const any = list.results.length > 0;
    if (event.key === 'ArrowDown' && any) picker.move(1);
    else if (event.key === 'ArrowUp' && any) picker.move(-1);
    else if ((event.key === 'Enter' || event.key === 'Tab') && any && !event.shiftKey) {
      event.preventDefault();
      choose();
      return;
    } else if (event.key === 'Escape') picker.close();
    else return;
    // The list's keys stay in the field: Escape closes the list, not the dialog.
    event.preventDefault();
    event.stopPropagation();
    list = picker.state();
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (sending) return;
    closeList();
    const result = createCommentThread({
      selection: anchor.selection,
      scopes: anchor.scopes,
      threadCount: threads.count(),
      draft: text,
    });
    if (!result.ok) {
      refusal = result.reason;
      return;
    }
    refusal = null;
    sending = true;
    let outcome: ThreadOutcome;
    try {
      outcome = await threads.create({ target: result.target, body: bodyParts(text, mentions) });
    } catch {
      outcome = { ok: false, code: 'failed' };
    }
    if (gone) return;
    sending = false;
    if (!outcome.ok) {
      refusal = serverRefusal(outcome.code);
      return;
    }
    onPosted();
  }
</script>

<Dialog name="comment" title={tr.t('dialog.comment.title')} {onClose}>
  <form class="de-form" onsubmit={submit} novalidate>
    <label class="de-field" for={`${id}-body`}>{tr.t('dialog.comment.field')}</label>
    <textarea
      id={`${id}-body`}
      class="de-input"
      rows="4"
      data-autofocus
      bind:this={field}
      bind:value={text}
      aria-autocomplete={picker.offered ? 'list' : undefined}
      aria-controls={picker.offered ? `${id}-mentions` : undefined}
      aria-activedescendant={list.open && list.active !== null
        ? `${id}-mention-${list.active}`
        : undefined}
      aria-describedby={describedBy}
      aria-invalid={refusal === 'emptyBody' ? 'true' : undefined}
      oninput={() => void lookUp()}
      onkeydown={onKeydown}
      onblur={closeList}
    ></textarea>
    {#if picker.offered}
      <p class="de-hint" id={`${id}-hint`}>{tr.t('dialog.comment.mentionHint')}</p>
      <ul
        id={`${id}-mentions`}
        class="de-listbox"
        role="listbox"
        aria-label={tr.t('dialog.comment.mentions')}
        hidden={!list.open || list.results.length === 0}
      >
        {#each list.results as p, i (p.principal)}
          <!-- The keys are handled by the field, which owns the list. -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id={`${id}-mention-${i}`}
            role="option"
            class="de-option"
            aria-selected={i === list.active}
            data-principal={p.principal}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => choose(i)}
          >
            <span data-content>{p.name}</span>
            <span class="de-hint"
              >{p.principal.startsWith('group:')
                ? tr.t('principal.group')
                : tr.t('principal.user')}</span
            >
          </li>
        {/each}
      </ul>
      {#if list.open && list.results.length === 0}
        <p class="de-hint" role="status">{tr.t('dialog.comment.mentionNone')}</p>
      {/if}
    {/if}
    {#if refusal}
      <p class="de-error" id={`${id}-error`} role="alert">{tr.t(REFUSALS[refusal])}</p>
    {/if}
    <div class="de-dialog-actions">
      <button type="submit" class="de-button de-button-primary" disabled={sending}
        >{tr.t('dialog.comment.post')}</button
      >
      <button type="button" class="de-button" onclick={() => onClose()}
        >{tr.t('dialog.cancel')}</button
      >
    </div>
  </form>
</Dialog>
