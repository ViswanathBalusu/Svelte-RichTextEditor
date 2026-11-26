<!--
  The page behind an invitation link (UX-099). Two plain forms that work with the keyboard and a
  screen reader and without script: ask for a passcode, then enter it. The field takes a pasted
  code (no paste handler, `autocomplete="one-time-code"`), and results are announced in a status
  region. Nothing needs a pointer and nothing needs drawing.
-->
<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const asked = $derived(form?.asked === true);
</script>

<svelte:head>
  <title>Complete a document · Reference host</title>
  <meta name="referrer" content="no-referrer" />
</svelte:head>

{#if !data.known}
  <h1>This link is no longer valid</h1>
  <p>Ask the person who sent it for a new one. Each reminder carries a new link.</p>
{:else}
  <h1>Complete: {data.title}</h1>
  <p>Hello {data.name}.</p>
  <p class="muted">{data.statement}</p>

  <div aria-live="polite" role="status">
    {#if form?.verified}
      <p class="notice">
        You are verified. The host has made the token for your part of the document. The view in
        which you fill and sign it is not built in this demo yet.
      </p>
    {:else if form?.asked && !form.problem}
      <p class="notice">
        A passcode was sent to the address the sender gave for you. It lapses in ten minutes.
      </p>
    {/if}
  </div>
  {#if form?.problem}
    <p class="notice problem" role="alert">{form.problem}</p>
  {/if}

  {#if !form?.verified}
    <form method="POST" action="?/ask" aria-labelledby="ask-heading">
      <h2 id="ask-heading">Step 1: ask for a passcode</h2>
      <button type="submit">{asked ? 'Send a new passcode' : 'Send me a passcode'}</button>
    </form>

    <form method="POST" action="?/verify" aria-labelledby="enter-heading">
      <h2 id="enter-heading">Step 2: enter the passcode</h2>
      <div class="field">
        <label for="passcode">Passcode (six digits; you can paste it)</label>
        <input
          id="passcode"
          name="passcode"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="12"
          required
        />
      </div>
      <button type="submit">Check the passcode</button>
    </form>
  {/if}
{/if}
