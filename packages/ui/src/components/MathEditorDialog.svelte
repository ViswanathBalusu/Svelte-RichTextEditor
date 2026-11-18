<!--
  The math editor (FE-070; 02 §2, §3): a dialog with the visual equation field and, below it, the
  equation's LaTeX source as text. Either one edits the same source. The visual field is a
  third-party piece that registers global custom elements, so the service loads it on demand; when
  it cannot be loaded the source field still works.

  - Confirming sets the source as one commit and waits for the document service's answer.
  - A source over a limit (I7; 09 §6.3) shows the reason and cannot be confirmed.
  - A source the service rejects (the math gate, I8) is not applied: the reason is shown beside the
    equation and the person's input stays for correction.
  - Where the person may not change the equation, the dialog opens read-only.
  - Every control is a tab stop, Escape closes without a change (also from inside the visual field),
    and focus goes back to where it was, which is the equation's own editing surface.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { EquationOutcome, EquationRef, MathEditorService, MathFieldHandle } from '../core-api.ts';
  import { useShell } from '../context.ts';
  import Dialog from './Dialog.svelte';

  interface Props {
    editor: MathEditorService;
    equation: EquationRef;
    /** Called when the service has accepted the source. */
    onApplied: () => void;
    /** Called when the service rejected it, for the shell's announcement. */
    onRejected?: () => void;
    onClose: () => void;
  }

  let { editor, equation, onApplied, onRejected, onClose }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-math`;

  // The dialog is opened on one equation: what it was then is what it edits.
  const start = untrack(() => equation);
  // svelte-ignore state_referenced_locally
  const access = editor.access(start.pos);
  const readOnly = !access.canEdit;

  let latex = $state(start.latex);
  let busy = $state(false);
  let outcome = $state.raw<Extract<EquationOutcome, { ok: false }> | null>(null);
  let fieldState = $state<'loading' | 'ready' | 'failed'>('loading');
  let field: MathFieldHandle | null = null;

  const limit = $derived(editor.check(latex));
  const changed = $derived(latex !== start.latex);

  // One message, in the interface's language, for what stops the person.
  const problem = $derived.by((): string | null => {
    if (readOnly)
      return tr.t(access.reason === 'suggestion' ? 'dialog.math.suggestion' : 'dialog.math.readOnly');
    if (limit === 'too-long') return tr.t('dialog.math.tooLong', { max: editor.limits.length });
    if (limit === 'too-deep') return tr.t('dialog.math.tooDeep', { max: editor.limits.depth });
    if (outcome?.reason === 'rejected') return tr.t('dialog.math.rejected');
    if (outcome?.reason === 'too-long')
      return tr.t('dialog.math.tooLong', { max: editor.limits.length });
    if (outcome?.reason === 'too-deep')
      return tr.t('dialog.math.tooDeep', { max: editor.limits.depth });
    if (outcome?.reason === 'suggestion') return tr.t('dialog.math.suggestion');
    if (outcome) return tr.t('dialog.math.refused');
    return null;
  });
  const why = $derived(
    outcome?.reason === 'rejected' && outcome.message
      ? tr.t('dialog.math.rejectedWhy', { reason: outcome.message })
      : null,
  );

  // The visual field is loaded when the dialog opens, and removed when it closes.
  function mountField(host: HTMLElement) {
    let gone = false;
    editor
      .mount(host, {
        latex: untrack(() => latex),
        readOnly,
        label: tr.t('dialog.math.visual'),
        onInput: (value) => {
          latex = value;
          outcome = null;
        },
        onEscape: () => onClose(),
      })
      .then(
        (handle) => {
          if (gone) {
            handle.destroy();
            return;
          }
          field = handle;
          fieldState = 'ready';
        },
        () => {
          if (!gone) fieldState = 'failed';
        },
      );
    return () => {
      gone = true;
      field?.destroy();
      field = null;
    };
  }

  // The source field changes the visual field too, never the other way round while it types.
  $effect(() => {
    const value = latex;
    if (field && field.value !== value) field.setValue(value);
  });

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (readOnly || busy || limit !== null) return;
    busy = true;
    outcome = null;
    const answer = await editor.confirm(start.pos, latex);
    busy = false;
    if (answer.ok) onApplied();
    else {
      outcome = answer;
      if (answer.reason === 'rejected') onRejected?.();
    }
  }
</script>

<Dialog name="math" title={tr.t('dialog.math.title')} {onClose}>
  <form class="de-form de-math-editor" onsubmit={submit} novalidate>
    <div
      class="de-math-field"
      data-state={fieldState}
      data-display={start.display ? 'true' : 'false'}
      {@attach mountField}
    ></div>
    {#if fieldState === 'loading'}
      <p class="de-hint" role="status">{tr.t('dialog.math.loading')}</p>
    {:else if fieldState === 'failed'}
      <p class="de-hint" role="status">{tr.t('dialog.math.unavailable')}</p>
    {/if}
    <label class="de-field" for={`${id}-source`}>{tr.t('dialog.math.source')}</label>
    <textarea
      id={`${id}-source`}
      class="de-input de-math-source"
      rows="3"
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      dir="ltr"
      data-autofocus
      readonly={readOnly}
      bind:value={latex}
      oninput={() => (outcome = null)}
      aria-invalid={problem !== null && !readOnly ? 'true' : undefined}
      aria-describedby={`${id}-hint ${id}-problem`}
    ></textarea>
    <p class="de-hint" id={`${id}-hint`}>{tr.t('dialog.math.hint')}</p>
    <div id={`${id}-problem`} role="alert">
      {#if problem}
        <p class="de-error">{problem}</p>
      {/if}
      {#if why}
        <p class="de-error de-math-reason">{why}</p>
      {/if}
    </div>
    <div class="de-dialog-actions">
      {#if !readOnly}
        <button
          type="submit"
          class="de-button de-button-primary"
          disabled={busy || limit !== null || !changed}
          aria-busy={busy ? 'true' : undefined}
          >{tr.t(busy ? 'dialog.math.applying' : 'dialog.math.apply')}</button
        >
      {/if}
      <button type="button" class="de-button" onclick={() => onClose()}
        >{tr.t(readOnly ? 'dialog.close' : 'dialog.cancel')}</button
      >
    </div>
  </form>
</Dialog>
