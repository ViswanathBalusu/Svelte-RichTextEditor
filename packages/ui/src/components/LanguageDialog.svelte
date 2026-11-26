<!--
  Choose the language of the selected text (UX-018 criterion 3; 02 §11): a BCP 47 tag, checked as
  it is typed, with the language's name in the interface's language beside it, or the document's
  own language. Applying runs the core's `setLanguage` through the registry's guards, so the
  permissions apply as for typing.
-->
<script lang="ts">
  import '../i18n/late/dialogs.ts';
  import { useShell } from '../context.ts';
  import { languageName } from '../shell/status.ts';
  import { live } from '../live.ts';
  import Dialog from './Dialog.svelte';
  import DictionarySection from './DictionarySection.svelte';

  interface Props {
    /** The tag at the selection, or null for the document's default. */
    initial: string | null;
    onApply: (lang: string | null) => void;
    onClose: () => void;
  }

  let { initial, onApply, onClose }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-language`;

  // The custom dictionaries of the language (UX-042), only while the proofing port supports them.
  const proofing = shell.core.proofing ? live(shell.core.proofing) : null;
  const documentLang = shell.core.language ? live(shell.core.language) : null;

  // svelte-ignore state_referenced_locally
  let tag = $state(initial ?? '');
  // svelte-ignore state_referenced_locally
  let useDefault = $state(initial === null);

  function canonical(value: string): string | null {
    try {
      return Intl.getCanonicalLocales(value.trim())[0] ?? null;
    } catch {
      return null;
    }
  }

  const parsed = $derived(useDefault ? null : canonical(tag));
  const invalid = $derived(!useDefault && tag.trim() !== '' && parsed === null);
  const name = $derived(parsed ? languageName(parsed, tr.locale) : '');

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (useDefault) onApply(null);
    else if (parsed) onApply(parsed);
  }
</script>

<Dialog name="language" title={tr.t('dialog.language.title')} {onClose}>
  <form class="de-form" onsubmit={submit}>
    <label class="de-check">
      <input type="checkbox" bind:checked={useDefault} />
      <span>{tr.t('dialog.language.default')}</span>
    </label>
    <label class="de-field" for={`${id}-tag`}>{tr.t('dialog.language.field')}</label>
    <input
      id={`${id}-tag`}
      class="de-input"
      type="text"
      autocomplete="off"
      spellcheck="false"
      data-autofocus
      disabled={useDefault}
      bind:value={tag}
      aria-invalid={invalid ? 'true' : undefined}
      aria-describedby={invalid ? `${id}-hint ${id}-error` : `${id}-hint`}
    />
    <p class="de-hint" id={`${id}-hint`}>{tr.t('dialog.language.hint')}</p>
    {#if invalid}
      <p class="de-error" id={`${id}-error`}>{tr.t('dialog.language.invalid')}</p>
    {:else if name}
      <p class="de-hint" aria-live="polite">{tr.t('dialog.language.preview', { name })}</p>
    {/if}
    <div class="de-dialog-actions">
      <button type="submit" class="de-button de-button-primary" disabled={!useDefault && !parsed}
        >{tr.t('dialog.apply')}</button
      >
      <button type="button" class="de-button" onclick={() => onClose()}
        >{tr.t('dialog.cancel')}</button
      >
    </div>
  </form>
  {#if shell.core.dictionary && proofing?.current.dictionary && (parsed ?? initial ?? documentLang?.current)}
    <DictionarySection lang={(parsed ?? initial ?? documentLang?.current)!} />
  {/if}
</Dialog>
