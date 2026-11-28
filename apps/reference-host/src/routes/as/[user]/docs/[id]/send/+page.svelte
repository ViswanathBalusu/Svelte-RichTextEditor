<!--
  Send for completion (UX-099): one labelled group for each role placeholder, with the person's
  name, e-mail address, kind and order. Plain forms, so the page works with the keyboard and
  without script. After the send it lists who was invited and offers the sealed PDF and the
  evidence bundle once they have come back.
-->
<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
</script>

<svelte:head>
  <title>Send for completion · Reference host</title>
</svelte:head>

<h1>Send for completion: {data.doc.title}</h1>
<p><a href="{data.base}/docs/{data.doc.id}">Back to the document</a></p>
<p class="muted">{data.statement}</p>

{#if form?.problem}
  <p class="notice problem" role="alert">{form.problem}</p>
{/if}
{#if form?.done}
  <p class="notice" role="status">{form.done}</p>
{/if}

{#if data.sent}
  <h2 id="sent-heading">Sent</h2>
  <p>State: <strong>{data.sent.state}</strong>. Sent at {data.sent.sentAt}.</p>
  <table aria-labelledby="sent-heading">
    <thead>
      <tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Kind</th><th scope="col">Order</th><th scope="col">Part</th></tr>
    </thead>
    <tbody>
      {#each data.sent.participants as p (p.id)}
        <tr data-participant={p.id}><th scope="row">{p.name}</th><td>{p.roles.join(', ')}</td><td>{p.kind}</td><td>{p.order}</td><td data-testid="part-{p.id}">{p.finished ?? 'open'}</td></tr>
      {/each}
    </tbody>
  </table>
  {#if data.sent.results}
    <h2>The finished document</h2>
    <ul>
      <li><a href="{data.base}/docs/{data.doc.id}/send/download/sealed-pdf">The sealed PDF</a></li>
      <li><a href="{data.base}/docs/{data.doc.id}/send/download/evidence">The evidence bundle</a></li>
    </ul>
  {:else}
    <p class="muted">The sealed PDF and the evidence bundle appear here when the document is finalised.</p>
  {/if}
{:else}
  {#if !data.mailConfigured}
    <p class="notice problem" role="note">
      This host has no mail sink configured, so the invitations cannot be sent.
    </p>
  {/if}
  <form method="POST" action="?/send" aria-labelledby="who-heading">
    <h2 id="who-heading">Who fills each role</h2>
    {#each data.roles as role, i (role)}
      <fieldset>
        <legend>Role: {role}</legend>
        <input type="hidden" name="role" value={role} />
        <div class="field">
          <label for="name-{i}">Name</label>
          <input id="name-{i}" name="name" required maxlength="200" autocomplete="off" />
        </div>
        <div class="field">
          <label for="email-{i}">E-mail address</label>
          <input id="email-{i}" name="email" type="email" required autocomplete="off" />
        </div>
        <div class="field">
          <label for="kind-{i}">Kind</label>
          <select id="kind-{i}" name="kind">
            {#each data.kinds as k (k)}
              <option value={k}>{k}</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label for="order-{i}">Order (the same number means at the same time)</label>
          <input id="order-{i}" name="order" type="number" min="1" step="1" value={i + 1} required />
        </div>
      </fieldset>
    {/each}
    <button type="submit">Send for completion</button>
  </form>
{/if}
