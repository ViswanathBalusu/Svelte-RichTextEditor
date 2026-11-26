<!--
  The custom dictionaries of a language (UX-042 criterion 3; 13 §6.1; owner decision 34): the
  person's own words and the tenant's shared words, with a way to add a word to either and to remove
  a word that the person may remove. It is part of the language dialog and is drawn only while the
  proofing port supports dictionaries, so a port without them leaves no control. The port stores the
  words and honours them in later checks; a shared word is the administrator's, so the port may
  refuse a person who is not one, and the dialog says so.
-->
<script lang="ts">
  import '../i18n/late/dialogs.ts';
  import { useShell } from '../context.ts';
  import type { DictionaryEntryView, DictionaryScope } from '../core-api.ts';
  import type { StringKey } from '../i18n/en-GB.ts';

  interface Props {
    /** The language whose dictionaries are shown, a BCP 47 tag. */
    lang: string;
  }

  let { lang }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const service = shell.core.dictionary!;
  const id = `${shell.idPrefix}-dictionary`;

  const SCOPE_OPTIONS: Record<DictionaryScope, StringKey> = {
    user: 'dialog.dictionary.scope.user',
    tenant: 'dialog.dictionary.scope.tenant',
  };
  const SCOPE_OWNER: Record<DictionaryScope, StringKey> = {
    user: 'dialog.dictionary.entry.user',
    tenant: 'dialog.dictionary.entry.tenant',
  };

  let entries = $state.raw<readonly DictionaryEntryView[] | null>(null);
  let word = $state('');
  let scope = $state<DictionaryScope>('user');
  let failed = $state(false);
  let busy = $state(false);

  async function load(): Promise<void> {
    entries = await service.words(lang);
  }

  $effect(() => {
    void lang;
    void load();
  });

  async function change(run: () => Promise<boolean>): Promise<boolean> {
    busy = true;
    failed = false;
    try {
      const done = await run();
      failed = !done;
      await load();
      return done;
    } finally {
      busy = false;
    }
  }

  async function add(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const text = word.trim();
    if (text === '' || busy) return;
    if (await change(() => service.add(text, lang, scope))) word = '';
  }
</script>

<section class="de-dictionary" aria-labelledby={`${id}-title`} data-dictionary>
  <h3 id={`${id}-title`}>{tr.t('dialog.dictionary.title', { lang })}</h3>
  {#if entries === null}
    <p class="de-hint">{tr.t('dialog.dictionary.unavailable')}</p>
  {:else if entries.length === 0}
    <p class="de-hint">{tr.t('dialog.dictionary.none')}</p>
  {:else}
    <ul class="de-list">
      {#each entries as entry (`${entry.scope}:${entry.word}`)}
        <li data-entry={entry.word} data-scope={entry.scope}>
          <span>{entry.word}</span>
          <span class="de-hint">({tr.t(SCOPE_OWNER[entry.scope])})</span>
          {#if entry.removable}
            <button
              type="button"
              class="de-button"
              disabled={busy}
              onclick={() => change(() => service.remove(entry.word, lang, entry.scope))}
              >{tr.t('dialog.dictionary.remove', { word: entry.word })}</button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  <form class="de-form" onsubmit={add}>
    <label class="de-field" for={`${id}-word`}>{tr.t('dialog.dictionary.word')}</label>
    <input
      id={`${id}-word`}
      class="de-input"
      type="text"
      autocomplete="off"
      spellcheck="false"
      bind:value={word}
    />
    <label class="de-field" for={`${id}-scope`}>{tr.t('dialog.dictionary.scope')}</label>
    <select id={`${id}-scope`} class="de-input" bind:value={scope}>
      {#each ['user', 'tenant'] as const as option (option)}
        <option value={option}>{tr.t(SCOPE_OPTIONS[option])}</option>
      {/each}
    </select>
    <button type="submit" class="de-button" disabled={busy || word.trim() === ''}
      >{tr.t('dialog.dictionary.add')}</button
    >
    {#if failed}
      <p class="de-error" role="alert">{tr.t('dialog.dictionary.failed')}</p>
    {/if}
  </form>
</section>
