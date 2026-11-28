<!--
  The document list (UX-094): open, rename, delete, and a new document from a template. Laid out
  like a file start screen: a new document first, then the documents shared with the person as
  rows with their role. Plain forms, so the list works with the keyboard and without script; each
  control has a visible label.
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

<section class="card" aria-labelledby="new-heading">
  <h2 id="new-heading">New document</h2>
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
</section>

<h2 id="shared-heading">Shared with {data.person.name}</h2>
{#if data.documents.length === 0}
  <p>No documents are shared with you.</p>
{:else}
  <div class="doc-list">
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
            <td>
              <span class="doc-title">
                <svg class="doc-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M6 3h8l4 4v14H6z" />
                  <path d="M14 3v4h4" />
                  <path d="M9 12h6" />
                  <path d="M9 16h6" />
                </svg>
                <a href="{data.base}/docs/{doc.id}">{doc.title}</a>
              </span>
            </td>
            <td><span class="badge">{roleNames[doc.role] ?? doc.role}</span></td>
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
  </div>
{/if}
