<script lang="ts">
  import { onMount } from 'svelte';
  import { emitTo, listen } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { Button } from '@smykla-skalski/sui';
  import OptionPicker from './OptionPicker.svelte';
  import { getSetting } from './lib/settings';
  import type { SetupCheck, SetupReport } from './lib/onboarding';
  import {
    settingsAction,
    settingsRequest,
    settingsState,
    type SettingsAction,
    type SettingsSnapshot,
  } from './lib/settings-window';

  let snapshot = $state<SettingsSnapshot | null>(null);
  let binaryPath = $state('');
  let personalChecks = $state('');
  let personalChecksDirty = $state(false);
  let binaryDirty = $state(false);
  let selectedSection = $state<'general' | 'opencode' | 'agents'>('general');
  let themePickerOpen = $state(false);
  let requestError = $state('');

  function setupRows(report: SetupReport): [string, SetupCheck][] {
    return [
      ['OpenCode location', report.location],
      ['Plan-review plugin', report.plugin],
      ['Architect agent', report.architect],
      ['Plan RPC', report.rpc],
      ['Provider and model', report.model],
      ['Architect model', report.planModel],
    ];
  }

  function setupDetail(label: string, detail: string) {
    const prefix = detail.startsWith(`${label}: `) ? `${label}: ` : `${label} `;
    return detail.startsWith(prefix) ? detail.slice(prefix.length) : detail;
  }

  function send(action: SettingsAction) {
    requestError = '';
    void emitTo('main', settingsAction, action).catch((cause: unknown) => {
      requestError = String(cause);
    });
  }

  function keydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === ',') {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') closeWindow();
  }

  function closeWindow() {
    void getCurrentWindow()
      .close()
      .catch((cause: unknown) => (requestError = String(cause)));
  }

  onMount(() => {
    document.documentElement.dataset.suiTheme =
      getSetting('sai-theme') === 'dark' ? 'dark' : 'light';
    let unlisten: (() => void) | undefined;
    let active = true;
    void (async () => {
      try {
        const stop = await listen<SettingsSnapshot>(settingsState, (event) => {
          snapshot = event.payload;
          document.documentElement.dataset.suiTheme = snapshot.theme;
          if (!binaryDirty) binaryPath = snapshot.binaryPath;
          if (!personalChecksDirty) personalChecks = snapshot.personalPostTurnChecks.join('\n');
        });
        if (!active) stop();
        else {
          unlisten = stop;
          await emitTo('main', settingsRequest);
        }
      } catch (cause) {
        requestError = String(cause);
      }
    })();
    const poll = window.setInterval(() => void emitTo('main', settingsRequest), 2000);
    return () => {
      active = false;
      unlisten?.();
      clearInterval(poll);
    };
  });
</script>

<svelte:head><title>Sail Settings</title></svelte:head>
<svelte:window onkeydown={keydown} />
<div class="settings-window">
  <aside class="settings-navigation" aria-label="Settings sections">
    <div class="settings-brand"><span class="brand-mark">S.</span><strong>Settings</strong></div>
    <nav>
      <button
        class:active={selectedSection === 'general'}
        aria-current={selectedSection === 'general' ? 'page' : undefined}
        onclick={() => (selectedSection = 'general')}>General</button
      >
      <button
        class:active={selectedSection === 'opencode'}
        aria-current={selectedSection === 'opencode' ? 'page' : undefined}
        onclick={() => (selectedSection = 'opencode')}>OpenCode</button
      >
      <button
        class:active={selectedSection === 'agents'}
        aria-current={selectedSection === 'agents' ? 'page' : undefined}
        onclick={() => (selectedSection = 'agents')}>Agents</button
      >
    </nav>
  </aside>
  <main class="settings-content">
    <button class="settings-close" aria-label="Close settings" onclick={closeWindow}>×</button>
    {#if requestError}<p class="notice error" role="alert">{requestError}</p>{/if}
    {#if selectedSection === 'general'}
      <h1>General</h1>
      {#if snapshot}
        <section class="settings-card">
          <h2>Appearance</h2>
          <OptionPicker
            label="Theme"
            value={snapshot.theme}
            options={[
              { value: 'light', name: 'Light' },
              { value: 'dark', name: 'Dark' },
            ]}
            open={themePickerOpen}
            onopen={() => (themePickerOpen = true)}
            onclose={() => (themePickerOpen = false)}
            onchoose={(value) => send({ type: 'theme', value: value as 'light' | 'dark' })}
          />
        </section>
      {:else}<p role="status">Loading settings…</p>{/if}
    {:else if selectedSection === 'opencode'}
      <h1>OpenCode</h1>
      <section class="settings-card">
        <h2>Runtime</h2>
        <p class="runtime-binary">Status: {snapshot?.runtimeState ?? 'Loading'}</p>
        {#if snapshot?.activeBinary}<p class="runtime-binary" title={snapshot.activeBinary}>
            Detected: {snapshot.activeBinary}
          </p>{/if}
        {#if snapshot?.runtimeError}<p class="runtime-diagnostic" role="alert">
            {snapshot.runtimeError}
          </p>{/if}
        <label for="opencode-bin">Binary path</label>
        <input
          id="opencode-bin"
          type="text"
          bind:value={binaryPath}
          oninput={() => (binaryDirty = true)}
          placeholder="Automatic detection"
        />
        <Button
          size="sm"
          disabled={!snapshot || snapshot.busy}
          onclick={() => {
            send({ type: 'binary', value: binaryPath });
            binaryDirty = false;
          }}>Save and reconnect</Button
        >
      </section>
      {#if snapshot?.directory}
        <section class="settings-card repository-diagnostics">
          <h2>Repository diagnostics</h2>
          <p class="runtime-binary" title={snapshot.directory}>{snapshot.directory}</p>
          {#if snapshot.setupLoading}<p role="status">Checking repository…</p>{/if}
          {#if snapshot.setupError}<p class="runtime-diagnostic" role="alert">
              {snapshot.setupError}
            </p>{/if}
          {#if snapshot.setup}<ul>
              {#each setupRows(snapshot.setup) as [label, item] (label)}<li>
                  <strong>{label}:</strong>
                  {setupDetail(label, item.detail)}
                </li>{/each}
            </ul>{/if}
          {#if snapshot.setup?.plugin.state === 'action'}<p>
              Install the tested plugin in OpenCode: <code
                >opencode plugin add
                github:smykla-skalski/opencode-plugin-plan-review#fdc575ba5ffccc6420ad5b3b68372f99f70290f5</code
              >
            </p>{/if}
          {#if snapshot.setup?.model.state === 'action' || snapshot.setup?.planModel.state === 'action'}<p
            >
              In OpenCode, run <code>/connect</code> to connect a provider and <code>/models</code> to
              enable a model.
            </p>{/if}
          {#if snapshot.setup?.architect.state === 'action' && snapshot.setup?.plugin.state === 'ready'}<p
            >
              Configure an Architect agent in OpenCode.
            </p>{/if}
          {#if snapshot.setup && !snapshot.setup.planReady}<p>
              Sail checks again automatically after setup changes.
            </p>{/if}
          <Button
            size="sm"
            disabled={snapshot.busy || snapshot.setupLoading}
            onclick={() => send({ type: 'restart-setup' })}>Restart and check</Button
          >
        </section>
      {/if}
    {:else}
      <h1>Agents</h1>
      <section class="settings-card">
        <h2>Detected agents</h2>
        {#if snapshot?.agentsError}<p class="runtime-diagnostic" role="alert">
            {snapshot.agentsError}
          </p>{/if}
        {#each snapshot?.agents ?? [] as agent (agent.id)}<p class="runtime-binary">
            <strong>{agent.name}</strong>: {agent.binaryPath ?? agent.reason ?? 'Unavailable'}
          </p>{/each}
        <Button size="sm" onclick={() => send({ type: 'detect-agents' })}>Detect again</Button>
      </section>
      <section class="settings-card">
        <h2>Agent coordination</h2>
        <label class="attention-setting">
          <input
            type="checkbox"
            checked={snapshot?.agentWorktreesEnabled ?? true}
            onchange={(event) =>
              send({ type: 'agent-worktrees', value: event.currentTarget.checked })}
          />
          Create worktrees and start threads with approval
        </label>
        <label class="attention-setting">
          <input
            type="checkbox"
            checked={snapshot?.agentTerminalsEnabled ?? false}
            onchange={(event) =>
              send({ type: 'agent-terminals', value: event.currentTarget.checked })}
          />
          Allow agents to run commands in owned terminals
        </label>
        <label class="attention-setting">
          <input
            type="checkbox"
            checked={snapshot?.agentStatusEnabled ?? true}
            onchange={(event) => send({ type: 'agent-status', value: event.currentTarget.checked })}
          />
          Update worktree status comments
        </label>
        <label class="attention-setting">
          <input
            type="checkbox"
            checked={snapshot?.agentThreadListEnabled ?? true}
            onchange={(event) =>
              send({ type: 'agent-thread-list', value: event.currentTarget.checked })}
          />
          List project threads
        </label>
        <label class="attention-setting">
          <input
            type="checkbox"
            checked={snapshot?.agentMessagesEnabled ?? true}
            onchange={(event) =>
              send({ type: 'agent-messages', value: event.currentTarget.checked })}
          />
          Message project threads
        </label>
      </section>
      <section class="settings-card">
        <h2>Post-turn checks</h2>
        <p>
          One shell command per line. Runs in the active worktree after each completed agent turn.
        </p>
        <label for="personal-post-turn-checks">Personal commands</label>
        <textarea
          id="personal-post-turn-checks"
          rows="5"
          bind:value={personalChecks}
          oninput={() => (personalChecksDirty = true)}
          placeholder="mise run test"></textarea>
        <Button
          size="sm"
          onclick={() => {
            send({
              type: 'personal-post-turn-checks',
              value: personalChecks
                .split('\n')
                .map((item) => item.trim())
                .filter(Boolean),
            });
            personalChecksDirty = false;
          }}>Save checks</Button
        >
      </section>
      <section class="settings-card">
        <h2>Notifications</h2>
        <label class="attention-setting">
          <input
            type="checkbox"
            checked={snapshot?.notificationsEnabled ?? true}
            onchange={(event) =>
              send({ type: 'notifications', value: event.currentTarget.checked })}
          />
          OS notifications
        </label>
        <label class="attention-setting">
          <input
            type="checkbox"
            checked={snapshot?.notificationSound ?? true}
            disabled={!snapshot?.notificationsEnabled}
            onchange={(event) =>
              send({ type: 'notification-sound', value: event.currentTarget.checked })}
          />
          Notification sound
        </label>
      </section>
    {/if}
  </main>
</div>
