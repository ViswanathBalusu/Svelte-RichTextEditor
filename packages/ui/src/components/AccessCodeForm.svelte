<!--
  The access code input of a participant (FRW-039; 12 §6.1, §7): until the participant has proved
  they know the code the host gave them, their fields stay read-only. The bar shows this form in
  place of the fill progress.

  - A visible label names the input, and a hint says what it is for; both are tied to the input.
  - Paste is not blocked: the input is an ordinary text field with no `onpaste` handler, and
    spelling and capitalisation helpers are off so that the code reaches the server as typed.
  - A wrong code, too many attempts and a failure are told in a live region that is in the page
    from the start, so a screen reader announces the text when it arrives; the input is marked
    invalid and described by it.
  - Everything works from the keyboard: Enter in the input submits, Tab reaches the button.
  - The code is held in this component's own state only while it is being typed and submitted; it
    is cleared on success and never written to any attribute, log or event.
-->
<script lang="ts">
  import '../i18n/late/fillBar.ts';
  import { onDestroy } from 'svelte';
  import { useShell } from '../context.ts';
  import type { AccessCodeOutcome, AccessCodeService } from '../core-api.ts';

  interface Props {
    service: AccessCodeService;
  }

  let { service }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const id = `${shell.idPrefix}-access-code`;

  let code = $state('');
  let sending = $state(false);
  let refusal = $state<Exclude<AccessCodeOutcome, { ok: true }> | null>(null);
  let gone = false;
  onDestroy(() => (gone = true));

  const seconds = $derived(
    refusal?.reason === 'rate_limited'
      ? Math.max(1, Math.ceil((refusal.retryAfterMs ?? 1000) / 1000))
      : 0,
  );
  const message = $derived(
    refusal === null
      ? ''
      : refusal.reason === 'wrong'
        ? tr.t('accessCode.wrong')
        : refusal.reason === 'rate_limited'
          ? tr.t('accessCode.rateLimited', { count: seconds })
          : tr.t('accessCode.failed'),
  );

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (sending) return;
    const typed = code.trim();
    if (typed === '') {
      refusal = { ok: false, reason: 'wrong' };
      return;
    }
    refusal = null;
    sending = true;
    let outcome: AccessCodeOutcome;
    try {
      outcome = await service.submit(typed);
    } catch {
      outcome = { ok: false, reason: 'failed' };
    }
    if (gone) return;
    sending = false;
    if (outcome.ok) {
      code = '';
      shell.announce('accessCode.accepted');
    } else refusal = outcome;
  }
</script>

<form class="de-access-code" onsubmit={submit} novalidate data-status="access-code">
  <label class="de-field" for={`${id}-input`}>{tr.t('accessCode.label')}</label>
  <input
    id={`${id}-input`}
    class="de-input"
    type="text"
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    bind:value={code}
    aria-describedby={`${id}-hint ${id}-error`}
    aria-invalid={refusal ? 'true' : undefined}
    aria-required="true"
  />
  <button type="submit" class="de-action" disabled={sending} aria-busy={sending ? 'true' : undefined}
    >{tr.t('accessCode.submit')}</button
  >
  <span class="de-hint" id={`${id}-hint`}>{tr.t('accessCode.hint')}</span>
  <!-- In the page from the start, so that the text is announced when it arrives. -->
  <span class="de-error" id={`${id}-error`} role="alert" data-status="access-code-error"
    >{message}</span
  >
</form>
