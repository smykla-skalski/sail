import '@smykla-skalski/sui/styles.css';
import './style.css';
import { mount } from 'svelte';
import {
  getSetting,
  initializeSettings,
  removeSetting,
  setSetting,
  setSettingDurable,
  settingKeys,
} from './lib/settings';
import { migrateOpenCodeSettings } from './lib/opencode-migration';
import { installFrontendDiagnostics, recordDiagnostic } from './lib/diagnostics';
import { installScrollbarVisibility } from './lib/scrollbars';
import { installThemeTransitionGuard } from './lib/theme-transitions';

installFrontendDiagnostics();
installScrollbarVisibility();
installThemeTransitionGuard();

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
    new URLSearchParams(location.search).has('spawn-activity-fixture')
  ) {
    const { default: SpawnActivityFixture } =
      await import('../test/e2e/spawn-activity-fixture.svelte');
    mount(SpawnActivityFixture, { target: document.getElementById('root')! });
  } else if (
    import.meta.env.MODE === 'e2e' &&
    new URLSearchParams(location.search).has('workspace-activity-fixture')
  ) {
    const { default: WorkspaceActivityFixture } =
      await import('../test/e2e/workspace-activity-fixture.svelte');
    mount(WorkspaceActivityFixture, { target: document.getElementById('root')! });
  } else if (
    import.meta.env.MODE === 'e2e' &&
    new URLSearchParams(location.search).has('activity-history-fixture')
  ) {
    const { default: ActivityHistoryFixture } =
      await import('../test/e2e/activity-history-fixture.svelte');
    mount(ActivityHistoryFixture, { target: document.getElementById('root')! });
  } else if (
    import.meta.env.MODE === 'e2e' &&
    new URLSearchParams(location.search).has('worker-dependency-fixture')
  ) {
    const { default: WorkerDependencyFixture } =
      await import('../test/e2e/worker-dependency-fixture.svelte');
    mount(WorkerDependencyFixture, { target: document.getElementById('root')! });
  } else if (
    import.meta.env.MODE === 'e2e' &&
    new URLSearchParams(location.search).has('task-overview-scale-fixture')
  ) {
    const { default: TaskOverviewScaleFixture } =
      await import('../test/e2e/task-overview-scale-fixture.svelte');
    mount(TaskOverviewScaleFixture, { target: document.getElementById('root')! });
  } else if (
    import.meta.env.MODE === 'e2e' &&
    new URLSearchParams(location.search).has('settings-durable-fixture')
  ) {
    await initializeSettings();
    const output = document.createElement('output');
    output.id = 'settings-durable-result';
    try {
      await setSettingDurable('sai-e2e-durable-probe', 'saved');
      output.value = getSetting('sai-e2e-durable-probe') ?? '';
    } catch (cause) {
      output.value = String(cause);
    }
    document.getElementById('root')!.append(output);
  } else if (new URLSearchParams(location.search).get('window') === 'settings') {
    const { default: SettingsWindow } = await import('./SettingsWindow.svelte');
    mount(SettingsWindow, { target: document.getElementById('root')! });
  } else {
    await initializeSettings();
    migrateOpenCodeSettings({
      get: getSetting,
      set: setSetting,
      remove: removeSetting,
      keys: settingKeys,
    });
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
