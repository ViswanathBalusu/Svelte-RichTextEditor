<!--
  A destructive action in two steps, without a dialog: the first press asks, the second does it.
  The label names the thing, so that a list of them is not a list of "Remove" buttons.
-->
<script lang="ts">
  let { label, onconfirm }: { label: string; onconfirm: () => void | Promise<void> } = $props();
  let asking = $state(false);
</script>

{#if asking}
  <span class="row" role="group" aria-label={label}>
    <button
      type="button"
      class="danger"
      onclick={() => {
        asking = false;
        void onconfirm();
      }}>Confirm: {label}</button
    >
    <button type="button" onclick={() => (asking = false)}>Cancel</button>
  </span>
{:else}
  <button type="button" class="danger" onclick={() => (asking = true)}>{label}</button>
{/if}
