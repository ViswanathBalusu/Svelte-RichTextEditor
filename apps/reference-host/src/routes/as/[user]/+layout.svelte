<!--
  Who the pages act as, with the places of the host (the document list and the templates) and a way
  back to the start page. The place the visitor is in is marked with `aria-current` and a bar under
  its name, not by colour alone.
-->
<script lang="ts">
  import { page } from '$app/state';
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();

  const initials = $derived(
    data.person.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]!.toUpperCase())
      .join(''),
  );
  const path = $derived(page.url.pathname.replace(/\/+$/, ''));
  const inTemplates = $derived(path === `${data.base}/templates`);
  const inDocuments = $derived(!inTemplates);
</script>

<nav class="subnav" aria-label="Session">
  <a href="{data.base}/" aria-current={inDocuments ? 'page' : undefined}>Documents</a>
  <a href="{data.base}/templates" aria-current={inTemplates ? 'page' : undefined}>Templates</a>
  <span class="subnav-space"></span>
  <span class="acting">
    <span class="avatar" aria-hidden="true">{initials}</span>
    <span>Acting as <strong data-testid="acting-as">{data.person.name}</strong></span>
  </span>
  <form method="POST" action="{data.base}/signout">
    <button type="submit">Choose another person</button>
  </form>
</nav>
{@render children()}
