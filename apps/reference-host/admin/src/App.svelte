<!--
  The administration console (UX-089; 13 §10). One page: a connection form, then a section for
  each part of the administration API. It uses the published API only (src/api.ts). The service
  credential is held in memory for the life of the page and is never stored or put in a URL.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { AdminApiError, AdminClient } from './api.ts';
  import AuditSection from './AuditSection.svelte';
  import type { Ctx } from './ctx.ts';
  import FontsSection from './FontsSection.svelte';
  import KeysSection from './KeysSection.svelte';
  import OriginsSection from './OriginsSection.svelte';
  import QuotasSection from './QuotasSection.svelte';
  import RetentionSection from './RetentionSection.svelte';
  import WebhooksSection from './WebhooksSection.svelte';

  type SectionId = 'quotas' | 'origins' | 'keys' | 'retention' | 'webhooks' | 'fonts' | 'audit';
  const SECTIONS: { id: SectionId; label: string }[] = [
    { id: 'quotas', label: 'Quotas' },
    { id: 'origins', label: 'Origins' },
    { id: 'keys', label: 'Token keys' },
    { id: 'retention', label: 'Retention and holds' },
    { id: 'webhooks', label: 'Webhooks' },
    { id: 'fonts', label: 'Fonts' },
    { id: 'audit', label: 'Audit trail' },
  ];

  let endpoint = $state('');
  let credential = $state('');
  let actor = $state('');
  let ctx = $state<Ctx | null>(null);
  let refused = $state<string | null>(null);
  let connecting = $state(false);
  let section = $state<SectionId>('quotas');
  let status = $state('');
  let problem = $state('');
  let content = $state<HTMLElement | null>(null);

  async function connect(): Promise<void> {
    problem = '';
    status = '';
    refused = null;
    ctx = null;
    connecting = true;
    try {
      const client = new AdminClient({
        endpoint: endpoint.trim(),
        credential: credential.trim(),
        ...(actor.trim() === '' ? {} : { actor: actor.trim() }),
      });
      const access = await client.checkAccess();
      if (!access.ok) {
        refused =
          access.code === 'forbidden' || access.code === 'unauthenticated'
            ? 'You do not have administration rights. This console needs a tenant service credential; a user token is not enough.'
            : `The administration API did not answer: ${access.message}`;
        return;
      }
      ctx = {
        client,
        say: (m) => {
          problem = '';
          status = m;
        },
        fail: (e) => {
          status = '';
          problem = e instanceof AdminApiError ? `${e.message} (${e.code})` : String((e as Error).message ?? e);
        },
      };
      credential = '';
    } finally {
      connecting = false;
    }
  }
  async function show(id: SectionId): Promise<void> {
    section = id;
    status = '';
    problem = '';
    await tick();
    content?.focus();
  }
</script>

<a class="skip" href="#content">Skip to the content</a>
<header class="top">
  <h1>Administration console</h1>
  <p class="hint">Uses only the published administration API. Demo build.</p>
</header>
<main>
  {#if ctx === null}
    <h2>Connect</h2>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        void connect();
      }}
    >
      <label>
        Service endpoint (the `rest` address of discovery)
        <input type="url" bind:value={endpoint} placeholder="https://docs.example.com/v1" required />
      </label>
      <label>
        Service credential
        <input type="password" autocomplete="off" bind:value={credential} required />
      </label>
      <label>Your name for the audit trail (optional) <input bind:value={actor} autocomplete="off" /></label>
      <button type="submit" class="primary" disabled={connecting}>Open the console</button>
    </form>
    {#if refused !== null}
      <p class="msg error" role="alert">{refused}</p>
    {/if}
  {:else}
    <nav aria-label="Administration sections">
      <ul>
        {#each SECTIONS as s (s.id)}
          <li>
            <button
              type="button"
              aria-current={section === s.id ? 'page' : undefined}
              onclick={() => void show(s.id)}>{s.label}</button
            >
          </li>
        {/each}
      </ul>
    </nav>
    <p class="msg" role="status">{status}</p>
    <p class="msg error" role="alert">{problem}</p>
    <div id="content" tabindex="-1" bind:this={content}>
      {#if section === 'quotas'}<QuotasSection {ctx} />
      {:else if section === 'origins'}<OriginsSection {ctx} />
      {:else if section === 'keys'}<KeysSection {ctx} />
      {:else if section === 'retention'}<RetentionSection {ctx} />
      {:else if section === 'webhooks'}<WebhooksSection {ctx} />
      {:else if section === 'fonts'}<FontsSection {ctx} />
      {:else}<AuditSection {ctx} />
      {/if}
    </div>
  {/if}
</main>
