<!--
  The page behind an invitation link (UX-099, UX-106). Two plain forms that work with the keyboard
  and a screen reader and without script: ask for a passcode, then enter it. The field takes a
  pasted code (no paste handler, `autocomplete="one-time-code"`), and results are announced in a
  status region. Nothing needs a pointer and nothing needs drawing.

  Once the passcode is accepted the page mounts `<doc-editor mode="fill">` on the document. The
  token is not on the page: the element asks the host's token endpoint for it, with the session
  cookie that the passcode started and that script cannot read. Finishing and declining are the
  embedding API's `completeFilling()` and `decline(reason)`; the buttons are the host's own.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { attachEditor, type EditorLike } from '../../../lib/glue/page-glue.ts';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const asked = $derived(form?.asked === true);

  interface FillEditor extends EditorLike {
    config: Record<string, unknown>;
    completeFilling(): Promise<
      { ok: true; result: unknown } | { ok: false; failures: ReadonlyArray<{ key: string }> }
    >;
    decline(reason: string): Promise<unknown>;
  }

  let editor: HTMLElement | undefined = $state();
  let status = $state('Loading the document');
  let problem: string | null = $state(null);
  let busy = $state(false);
  let ended: 'completed' | 'declined' | null = $state(null);
  let notice: string | null = $state(null);
  let declining = $state(false);
  let reason = $state('');
  let confirmation: HTMLElement | undefined = $state();
  let reasonField: HTMLTextAreaElement | undefined = $state();

  const ELEMENT_MODULE = '/element/doc-editor.js';
  const over = $derived(ended ?? data.finished);

  onMount(() => {
    if (!data.doc) return;
    let detach = () => {};
    let stopped = false;
    void (async () => {
      await import(/* @vite-ignore */ ELEMENT_MODULE);
      await customElements.whenDefined('doc-editor');
      if (stopped || !editor) return;
      const el = editor as unknown as FillEditor;
      if (data.viewerUrl) el.config = { pdfViewerUrl: data.viewerUrl };
      detach = attachEditor(el, {
        api: data.api,
        docId: data.doc!,
        onSignInNeeded: () => {
          problem = 'Your session ended. Open the link in your e-mail again and enter a new passcode.';
        },
        onAccessLost: () => {
          problem = 'Your part of this document has ended, or the link is no longer valid.';
        },
        onError: (d) => {
          problem = d.message;
        },
        onStatus: (d) => {
          status = `${d.connection}, ${d.sync}`;
        },
      });
    })();
    // The part may end from the editor's own guided bar, or elsewhere: the host's record says so
    // once the service has reported it by webhook.
    const timer = setInterval(() => {
      void fetch(`${data.api}/state`, { cache: 'no-store', credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((s: { finished: 'completed' | 'declined' | null } | null) => {
          if (s?.finished && !ended) void end(s.finished);
        })
        .catch(() => {});
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
      detach();
    };
  });

  /** Finishes: the element checks the fields first and, when all are valid, calls the service. */
  async function finish() {
    if (!editor || busy) return;
    busy = true;
    problem = null;
    notice = null;
    try {
      const outcome = await (editor as unknown as FillEditor).completeFilling();
      if (outcome.ok) {
        await end('completed');
      } else {
        notice =
          outcome.failures.length === 1
            ? 'One field needs your attention. The editor has moved to it.'
            : `${outcome.failures.length} fields need your attention. The editor has moved to the first.`;
      }
    } catch (e) {
      problem = e instanceof Error ? e.message : 'Finishing did not work. Try again.';
    } finally {
      busy = false;
    }
  }

  async function startDecline() {
    declining = true;
    await tick();
    reasonField?.focus();
  }

  async function decline(event: SubmitEvent) {
    event.preventDefault();
    if (!editor || busy) return;
    if (reason.trim() === '') {
      problem = 'Say why you do not want to sign. The sender is told.';
      reasonField?.focus();
      return;
    }
    busy = true;
    problem = null;
    try {
      await (editor as unknown as FillEditor).decline(reason.trim());
      await end('declined');
    } catch (e) {
      problem = e instanceof Error ? e.message : 'Declining did not work. Try again.';
    } finally {
      busy = false;
    }
  }

  /** The editor goes, the confirmation takes the focus, and the screen reader says it. */
  async function end(how: 'completed' | 'declined') {
    ended = how;
    await tick();
    confirmation?.focus();
  }
</script>

<svelte:head>
  <title>Complete a document · Reference host</title>
  <meta name="referrer" content="same-origin" />
</svelte:head>

{#if !data.known}
  <h1>This link is no longer valid</h1>
  <p>Ask the person who sent it for a new one. Each reminder carries a new link.</p>
{:else if over}
  <h1>{data.title}</h1>
  <div
    bind:this={confirmation}
    tabindex="-1"
    role="status"
    data-testid="fill-confirmation"
    class="notice"
  >
    {#if over === 'completed'}
      <h2>Thank you, {data.name}</h2>
      <p>
        Your part of this document is done. The next person, if there is one, is asked by e-mail
        now. This link no longer lets anyone edit the document.
      </p>
    {:else}
      <h2>You declined</h2>
      <p>
        The sender is told that you did not want to sign, with your reason. This link no longer
        lets anyone edit the document.
      </p>
    {/if}
  </div>
{:else if data.doc}
  <h1>Complete: {data.title}</h1>
  <p>Hello {data.name}. Fill in your fields, then choose Finish.</p>
  <p class="muted">{data.statement}</p>
  <p class="muted" data-testid="host-status" aria-live="polite">Editor: {status}</p>

  <div aria-live="polite" role="status">
    {#if notice}<p class="notice" data-testid="fill-notice">{notice}</p>{/if}
  </div>
  {#if problem}
    <p class="notice problem" role="alert" data-testid="host-problem">{problem}</p>
  {/if}

  <doc-editor bind:this={editor} endpoint={data.endpoint} mode="fill" toolbar="compact" locale="en-GB"
  ></doc-editor>

  <div class="row-actions">
    <button type="button" class="primary" data-testid="host-finish" onclick={finish} disabled={busy}
      >Finish</button
    >
    {#if !declining}
      <button type="button" onclick={startDecline} disabled={busy}>I do not want to sign</button>
    {/if}
  </div>

  {#if declining}
    <form onsubmit={decline} aria-labelledby="decline-heading">
      <h2 id="decline-heading">Decline to sign</h2>
      <div class="field">
        <label for="decline-reason">Why do you not want to sign? The sender is told.</label>
        <textarea id="decline-reason" bind:this={reasonField} bind:value={reason} rows="3" aria-required="true"
        ></textarea>
      </div>
      <button type="submit" disabled={busy}>Decline</button>
      <button type="button" onclick={() => (declining = false)}>Keep filling</button>
    </form>
  {/if}
{:else}
  <h1>Complete: {data.title}</h1>
  <p>Hello {data.name}.</p>
  <p class="muted">{data.statement}</p>

  <div aria-live="polite" role="status">
    {#if form?.asked && !form.problem}
      <p class="notice">
        A passcode was sent to the address the sender gave for you. It lapses in ten minutes.
      </p>
    {/if}
  </div>
  {#if form?.problem}
    <p class="notice problem" role="alert">{form.problem}</p>
  {/if}

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
