import '@smykla-skalski/sui/styles.css';
import './style.css';
import { mount } from 'svelte';
import { initializeSettings } from './lib/settings';
import { installFrontendDiagnostics, recordDiagnostic } from './lib/diagnostics';

installFrontendDiagnostics();

async function start() {
  if (import.meta.env.MODE === 'e2e') await import('@wdio/tauri-plugin');
  if (
    import.meta.env.MODE === 'e2e' &&
    new URLSearchParams(location.search).has('diagram-fixture')
  ) {
    const { default: DiagramFixture } = await import('../test/e2e/diagram-fixture.svelte');
    mount(DiagramFixture, { target: document.getElementById('root')! });
  } else if (
    import.meta.env.MODE === 'e2e' &&
    new URLSearchParams(location.search).has('tool-failure-fixture')
  ) {
    const { default: ToolFailureFixture } = await import('../test/e2e/tool-failure-fixture.svelte');
    mount(ToolFailureFixture, { target: document.getElementById('root')! });
  } else if (
    import.meta.env.MODE === 'e2e' &&
    new URLSearchParams(location.search).has('spawn-activity-fixture')
  ) {
    const { default: SpawnActivityFixture } =
      await import('../test/e2e/spawn-activity-fixture.svelte');
    mount(SpawnActivityFixture, { target: document.getElementById('root')! });
  } else if (new URLSearchParams(location.search).get('window') === 'settings') {
    const { default: SettingsWindow } = await import('./SettingsWindow.svelte');
    mount(SettingsWindow, { target: document.getElementById('root')! });
  } else {
    await initializeSettings();
    const { default: App } = await import('./App.svelte');
    mount(App, { target: document.getElementById('root')! });
  }
}

void start().catch((cause: unknown) => {
  recordDiagnostic('frontend_start_failed', {
    errorName: cause instanceof Error ? cause.name : typeof cause,
  });
  throw cause;
});
