<!--
  Save state and connection state (UX-016; 02 §2.2; PRODUCT principle 4). Both are words, with a
  shape beside the save state; neither relies on colour. The core's status view is the source; the
  element raises `de-status` from the same view (FE-007).
-->
<script lang="ts">
  import type { ConnectionState, ReadView, StatusSummary, SyncState } from '../core-api.ts';
  import { useShell } from '../context.ts';
  import type { StringKey } from '../i18n/en-GB.ts';
  import { live } from '../live.ts';

  interface Props {
    status: ReadView<StatusSummary>;
  }

  let { status }: Props = $props();

  const shell = useShell()!;
  const tr = $derived(shell.strings.current);
  const state = $derived(live(status));

  const SYNC: Record<SyncState, StringKey> = {
    saved: 'save.saved',
    saving: 'save.saving',
    unsaved: 'save.unsaved',
    readonly: 'save.readonly',
  };

  const CONNECTION: Record<ConnectionState, StringKey> = {
    online: 'connection.online',
    reconnecting: 'connection.reconnecting',
    offline: 'connection.offline',
  };

  const sync = $derived(state.current.sync);
  const connection = $derived(state.current.connection);
</script>

<div
  class="de-save"
  role="group"
  aria-label={tr.t('save.label')}
  data-sync={sync}
  data-connection={connection}
>
  <span class="de-save-sync">
    <span class="de-save-mark" data-state={sync} aria-hidden="true"></span>
    <span data-status="sync">{tr.t(SYNC[sync] ?? 'save.saved')}</span>
  </span>
  <span class="de-save-connection" data-state={connection}>
    <span class="de-connection-mark" data-state={connection} aria-hidden="true"></span>
    <span data-status="connection">{tr.t(CONNECTION[connection] ?? 'connection.online')}</span>
  </span>
</div>
