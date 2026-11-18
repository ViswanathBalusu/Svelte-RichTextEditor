<!-- Who the pages act as, with a way back to the start page. -->
<script lang="ts">
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();
</script>

<nav class="row-actions" aria-label="Session">
  <span>Acting as <strong data-testid="acting-as">{data.person.name}</strong></span>
  <a href="{data.base}/">Documents</a>
  <a href="{data.base}/templates">Templates</a>
  <form method="POST" action="{data.base}/signout">
    <button type="submit">Choose another person</button>
  </form>
</nav>
{@render children()}
