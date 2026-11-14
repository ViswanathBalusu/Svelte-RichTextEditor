/** The host application's entry (spike S2): its own copy of Svelte 5, default compile options. */
import { mount } from 'svelte';
import HostApp from './HostApp.svelte';

const status: { mounted: boolean; error: string | null } = { mounted: false, error: null };
Object.assign(globalThis, { __host: status });
try {
  mount(HostApp, { target: document.getElementById('host-app')! });
  status.mounted = true;
} catch (e) {
  status.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
