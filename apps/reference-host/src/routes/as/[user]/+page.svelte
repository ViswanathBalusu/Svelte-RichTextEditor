<!--
  The document list (UX-094): open, rename, delete, and a new document from a template. Plain
  forms, so the list works with the keyboard and without script; each control has a visible label.
-->
<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  const roleNames: Record<string, string> = {
    owner: 'Owner',
    editor: 'Editor',
    suggester: 'Suggester',
    commenter: 'Commenter',
    viewer: 'Viewer',
    filler: 'Filler',
  };
</script>

<svelte:head>
  <title>Documents · Reference host</title>
</svelte:head>

<h1>Documents</h1>
{#if form?.problem}
  <p class="notice problem" role="alert">{form.problem}</p>
{:else if form?.done}
  <p class="notice" role="status">{form.done}</p>
{/if}

{#if data.documents.length === 0}
  <p>No documents are shared with you.</p>
{:else}
  <table>
    <caption class="visually-hidden">Documents shared with {data.person.name}</caption>
    <thead>
      <tr>
        <th scope="col">Title</th>
        <th scope="col">Your role</th>
        <th scope="col">Actions</th>
      </tr>
    </thead>
    <tbody>
      {#each data.documents as doc (doc.id)}
        <tr data-document={doc.id} data-external-id={doc.externalId}>
          <td><a href="{data.base}/docs/{doc.id}">{doc.title}</a></td>
          <td>{roleNames[doc.role] ?? doc.role}</td>
          <td>
            {#if doc.role === 'owner'}
              <div class="row-actions">
                <form class="inline-form" method="POST" action="?/rename">
                  <input type="hidden" name="id" value={doc.id} />
                  <label for="title-{doc.id}" class="visually-hidden">New title for {doc.title}</label>
                  <input id="title-{doc.id}" name="title" value={doc.title} maxlength="1000" required />
                  <button type="submit">Rename</button>
                </form>
                <form method="POST" action="?/delete">
                  <input type="hidden" name="id" value={doc.id} />
                  <button class="danger" type="submit" aria-label="Delete {doc.title}">Delete</button>
                </form>
              </div>
            {:else}
              <span class="muted">Only the owner can rename or delete</span>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<h2>New document</h2>
<form class="inline-form" method="POST" action="?/create">
  <label for="new-title">Title</label>
  <input id="new-title" name="title" required maxlength="1000" />
  <label for="new-template">Template</label>
  <select id="new-template" name="template">
    {#each data.templates as t (t.key)}
      <option value={t.key}>{t.title}</option>
    {/each}
  </select>
  <button class="primary" type="submit">Create and open</button>
</form>
