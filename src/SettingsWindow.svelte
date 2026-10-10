<script lang="ts">
  import { onMount } from 'svelte';
  import { emitTo, listen } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { Button } from '@smykla-skalski/sui';
  import { invoke } from '@tauri-apps/api/core';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import OptionPicker from './OptionPicker.svelte';
  import { getSetting } from './lib/settings';
  import {
    parseThemePreference,
    resolveTheme,
    systemDarkQuery,
    themeSettingKey,
    watchSystemDark,
    type ThemePreference,
  } from './lib/theme';
  import { openExternalLink } from './lib/external-link';
  import type { ValidationChoice } from './lib/cross-validation';
  import {
    evaluateModelRouting,
    modelRouteRoles,
    type ModelRoute,
    type ModelRouteRole,
  } from './lib/model-routing';
  import { shipRiskLevels, type ShipRisk } from './lib/ship-risk-policy';
  import {
    defaultShipArchiveDelay,
    parseShipArchiveDelay,
    shipArchiveDelays,
  } from './lib/ship-archive';
  import {
    settingsAction,
    settingsRequest,
    settingsState,
    type SettingsAction,
    type SettingsSnapshot,
  } from './lib/settings-window';
  import {
    defaultNotificationPrefs,
    notificationPreferenceLabels,
    notificationPreferences,
    notificationTypeLabels,
    notificationTypes,
    type NotificationPreference,
  } from './lib/notification-prefs';
  import {
    createSerialExecutor,
    exportMemories,
    memoryKinds,
    parseMemoryTags,
    type MemoryAgentInstallPreview,
    type MemoryAgentStatus,
    type MemoryImportCandidate,
    type MemoryKind,
    type MemoryMode,
    type MemoryProviderKind,
    type MemoryProviderStatus,
    type MemoryRecord,
    type MemorySearchResult,
    type MemoryStatus,
  } from './lib/shared-memory';

  let snapshot = $state<SettingsSnapshot | null>(null);
  const openCodeAgent = $derived(snapshot?.agents.find((agent) => agent.id === 'opencode'));
  const notificationsOn = $derived(
    notificationTypes.some(
      (type) => (snapshot?.notificationPrefs[type] ?? defaultNotificationPrefs[type]) !== 'never',
    ),
  );
  let binaryPath = $state('');
  let personalChecks = $state('');
  let personalChecksDirty = $state(false);
  let binaryDirty = $state(false);
  let selectedSection = $state<'general' | 'opencode' | 'agents' | 'context' | 'memory'>('general');
  let validationAgent = $state('');
  let validationModel = $state('');
  let routingRole = $state<ModelRouteRole>('implementation');
  let routingRisk = $state<ShipRisk>('medium');
  let routingProvider = $state<ModelRoute['provider']>('codex');
  let routingModel = $state('');
  let routingVariant = $state('');
  let themePickerOpen = $state(false);
  let requestError = $state('');
  type HookEntry = {
    provider: string;
    source: string;
    event: string;
    identity: string;
    state: string;
  };
  type HookError = { provider: string; source: string; message: string };
  type HookIntegration = {
    provider: string;
    scope: string;
    file: string;
    commands: string[];
    events: string[];
    trustImpact: string;
    state: 'enabled' | 'trust-required' | 'disconnected' | 'failing';
    detail: string;
    enabled: boolean;
  };
  let hookReport = $state<{ entries: HookEntry[]; errors: HookError[] } | null>(null);
  let hookError = $state('');
  let hookLoading = $state(false);
  let hookDirectory = '';
  let hookIntegration = $state<HookIntegration | null>(null);
  let integrationDirectory = '';
  let integrationRequest = 0;
  let integrationLoading = $state(false);
  let integrationError = $state('');
  let memoryStatus = $state<MemoryStatus | null>(null);
  let memoryRecords = $state<MemoryRecord[]>([]);
  let memoryAgents = $state<MemoryAgentStatus[]>([]);
  let memoryImportCandidates = $state<MemoryImportCandidate[]>([]);
  let memoryImportLoading = $state(false);
  let memoryImportError = $state('');
  let memoryImportMessage = $state('');
  let memoryQuery = $state('');
  let memoryContent = $state('');
  let memoryKind = $state<MemoryKind>('other');
  let memoryTags = $state('');
  let memoryLoading = $state(false);
  let memoryStorageError = $state('');
  let memoryAgentError = $state('');
  let memoryConfigError = $state('');
  let memoryRequest = 0;
  let memoryDirectory = '';
  let pendingForget = $state('');
  let agentPreview = $state<{
    action: 'install' | 'uninstall';
    result: MemoryAgentInstallPreview;
  } | null>(null);
  let previewRequest = 0;
  let memoryModeRequest = 0;
  const serializeMemoryMode = createSerialExecutor();
  let memoryProviderStatus = $state<MemoryProviderStatus | null>(null);
  let memoryProviderKind = $state<MemoryProviderKind>('local');
  let memoryProviderEndpoint = $state('');
  let memoryProviderApiKey = $state('');
  let memoryProviderMessage = $state('');
  let memoryProviderError = $state('');
  let memoryProviderLoading = $state(false);
  let pendingProviderResolution = $state(false);
  type ContextProviderStatus = {
    state: 'not-configured' | 'invalid' | 'unavailable' | 'approval-required' | 'approved';
    id: string | null;
    command: string | null;
    executable: string | null;
    executableSha256: string | null;
    capabilities: string[];
    fingerprint: string | null;
    revision: string | null;
    reason: string | null;
  };
  let contextStatus = $state<ContextProviderStatus | null>(null);
  let contextDirectory = '';
  let contextRequest = 0;
  let contextLoading = $state(false);
  let contextBusy = $state(false);
  let contextExecutable = $state('');
  let contextError = $state('');
  let contextMessage = $state('');

  async function refreshContext(directory: string) {
    const request = ++contextRequest;
    if (contextDirectory !== directory) {
      contextStatus = null;
      contextExecutable = '';
      contextMessage = '';
      contextError = '';
    }
    contextDirectory = directory;
    if (!directory) return;
    contextLoading = true;
    try {
      const status = await invoke<ContextProviderStatus>('context_provider_status', { directory });
      if (request === contextRequest && contextDirectory === directory) {
        contextStatus = status;
        contextExecutable = status.executable ?? contextExecutable;
        contextError = '';
      }
    } catch (cause) {
      if (request === contextRequest && contextDirectory === directory)
        contextError = `Provider status: ${String(cause)}`;
    } finally {
      if (request === contextRequest && contextDirectory === directory) contextLoading = false;
    }
  }

  async function chooseContextExecutable() {
    try {
      const path = await openDialog({
        directory: false,
        multiple: false,
        title: 'Choose provider executable',
      });
      if (typeof path === 'string') contextExecutable = path;
    } catch (cause) {
      contextError = `Choose executable: ${String(cause)}`;
    }
  }

  async function registerContextExecutable() {
    const directory = snapshot?.directory;
    const command = contextStatus?.command;
    const executable = contextExecutable.trim();
    if (!directory || !command || !executable || executable === contextStatus?.executable) return;
    contextBusy = true;
    contextError = '';
    contextMessage = '';
    try {
      await invoke('context_register_provider', { command, executable });
      if (snapshot?.directory === directory) {
        await refreshContext(directory);
        contextMessage = 'Executable selected. Review its identity before approval.';
      }
    } catch (cause) {
      if (snapshot?.directory === directory) contextError = `Select executable: ${String(cause)}`;
    } finally {
      contextBusy = false;
    }
  }

  async function approveContextProvider() {
    const directory = snapshot?.directory;
    const expectedFingerprint = contextStatus?.fingerprint;
    if (!directory || contextStatus?.state !== 'approval-required' || !expectedFingerprint) return;
    contextBusy = true;
    contextError = '';
    contextMessage = '';
    try {
      await invoke('context_approve_provider', { directory, expectedFingerprint });
      if (snapshot?.directory === directory) {
        await refreshContext(directory);
        contextMessage = 'Provider approved for this project. Connection is not available yet.';
      }
    } catch (cause) {
      if (snapshot?.directory === directory) {
        await refreshContext(directory);
        contextError = `Approval: ${String(cause)}`;
      }
    } finally {
      contextBusy = false;
    }
  }

  async function revokeContextProvider() {
    const directory = snapshot?.directory;
    if (!directory || contextStatus?.state !== 'approved') return;
    contextBusy = true;
    contextError = '';
    contextMessage = '';
    try {
      await invoke('context_revoke_provider', { directory });
      if (snapshot?.directory === directory) {
        await refreshContext(directory);
        contextMessage = 'Provider approval revoked for this project.';
      }
    } catch (cause) {
      if (snapshot?.directory === directory) contextError = `Revoke approval: ${String(cause)}`;
    } finally {
      contextBusy = false;
    }
  }

  async function refreshMemory(directory: string, query = memoryQuery.trim()) {
    const request = ++memoryRequest;
    if (memoryDirectory !== directory) {
      memoryStatus = null;
      memoryRecords = [];
      memoryImportCandidates = [];
      memoryImportError = '';
      memoryImportMessage = '';
      memoryQuery = '';
      pendingForget = '';
      agentPreview = null;
      previewRequest += 1;
      memoryProviderStatus = null;
      memoryProviderKind = 'local';
      memoryProviderEndpoint = '';
      memoryProviderApiKey = '';
      memoryProviderMessage = '';
      memoryProviderError = '';
      pendingProviderResolution = false;
      query = '';
    }
    memoryDirectory = directory;
    memoryLoading = true;
    memoryStorageError = '';
    memoryAgentError = '';
    try {
      const status = await invoke<MemoryStatus>('memory_status', { directory });
      const records = status.enabled
        ? query
          ? (
              await invoke<MemorySearchResult[]>('memory_search', {
                directory,
                query,
                limit: 100,
              })
            ).map((result) => result.memory)
          : await invoke<MemoryRecord[]>('memory_list', { directory, includeForgotten: false })
        : [];
      if (request === memoryRequest && memoryDirectory === directory) {
        memoryStatus = status;
        memoryRecords = records;
      }
    } catch (cause) {
      if (request === memoryRequest && memoryDirectory === directory)
        memoryStorageError = `Storage: ${String(cause)}`;
    } finally {
      if (request === memoryRequest && memoryDirectory === directory) memoryLoading = false;
    }
    if (memoryStatus?.enabled && request === memoryRequest) {
      try {
        const candidates = await invoke<MemoryImportCandidate[]>('preview_memory_import', {
          directory,
        });
        if (request === memoryRequest && memoryDirectory === directory) {
          memoryImportCandidates = candidates;
          memoryImportError = '';
        }
      } catch (cause) {
        if (request === memoryRequest && memoryDirectory === directory)
          memoryImportError = `Import: ${String(cause)}`;
      }
    }
    try {
      const agents = await invoke<MemoryAgentStatus[]>('memory_agent_status');
      if (request === memoryRequest && memoryDirectory === directory) memoryAgents = agents;
    } catch (cause) {
      if (request === memoryRequest && memoryDirectory === directory)
        memoryAgentError = `Agents: ${String(cause)}`;
    }
    try {
      memoryProviderError = '';
      const providerStatus = await invoke<MemoryProviderStatus>('memory_provider_status', {
        directory,
      });
      if (request === memoryRequest && memoryDirectory === directory) {
        memoryProviderStatus = providerStatus;
        memoryProviderKind = providerStatus.provider;
        memoryProviderEndpoint = providerStatus.endpoint ?? '';
      }
    } catch (cause) {
      if (request === memoryRequest && memoryDirectory === directory)
        memoryProviderError = `Provider: ${String(cause)}`;
    }
  }

  function memoryProviderInput() {
    return {
      provider: memoryProviderKind,
      endpoint:
        memoryProviderKind === 'mem0SelfHosted' || memoryProviderKind === 'agentMemory'
          ? memoryProviderEndpoint.trim()
          : null,
      apiKey: memoryProviderKind === 'local' ? null : memoryProviderApiKey.trim(),
    };
  }

  async function verifyMemoryProvider() {
    const directory = snapshot?.directory;
    if (!directory || memoryProviderKind === 'local') return;
    memoryProviderLoading = true;
    memoryProviderError = '';
    memoryProviderMessage = '';
    try {
      await invoke<MemoryProviderStatus>('verify_memory_provider', {
        directory,
        input: memoryProviderInput(),
      });
      memoryProviderMessage = 'Connection verified. Enable it to backfill existing memories.';
    } catch (cause) {
      memoryProviderError = `Provider: ${String(cause)}`;
    } finally {
      memoryProviderLoading = false;
    }
  }

  async function saveMemoryProvider() {
    const directory = snapshot?.directory;
    if (!directory) return;
    memoryProviderLoading = true;
    memoryProviderError = '';
    memoryProviderMessage = '';
    try {
      memoryProviderStatus = await invoke<MemoryProviderStatus>('set_memory_provider', {
        directory,
        input: memoryProviderInput(),
      });
      memoryProviderApiKey = '';
      pendingProviderResolution = false;
      memoryProviderKind = memoryProviderStatus.provider;
      memoryProviderEndpoint = memoryProviderStatus.endpoint ?? '';
      memoryProviderMessage =
        memoryProviderStatus.provider === 'local'
          ? 'Local search is active. Canonical project memories were preserved; any active provider credential was removed.'
          : `${memoryProviderStatus.provider === 'agentMemory' ? 'AgentMemory' : 'Mem0'} is active and existing memories are synchronized.`;
    } catch (cause) {
      memoryProviderError = `Provider: ${String(cause)}`;
    } finally {
      memoryProviderLoading = false;
    }
  }

  async function resolvePendingMemoryProvider() {
    const directory = snapshot?.directory;
    if (!directory || memoryProviderKind !== 'agentMemory') return;
    memoryProviderLoading = true;
    memoryProviderError = '';
    memoryProviderMessage = '';
    try {
      await invoke('resolve_memory_provider_pending', {
        directory,
        input: memoryProviderInput(),
        acknowledgeUnknown: true,
      });
      pendingProviderResolution = false;
      memoryProviderMessage =
        'Pending write cleared after a complete remote scan. Enable AgentMemory again to retry synchronization.';
      memoryProviderStatus = await invoke<MemoryProviderStatus>('memory_provider_status', {
        directory,
      });
    } catch (cause) {
      memoryProviderError = `Provider: ${String(cause)}`;
    } finally {
      memoryProviderLoading = false;
    }
  }

  async function rememberMemory() {
    const directory = snapshot?.directory;
    const content = memoryContent.trim();
    if (!directory || !content) return;
    memoryStorageError = '';
    try {
      await invoke<MemoryRecord>('memory_remember', {
        directory,
        input: { content, kind: memoryKind, tags: parseMemoryTags(memoryTags) },
      });
      memoryContent = '';
      memoryTags = '';
      await refreshMemory(directory);
    } catch (cause) {
      memoryStorageError = `Storage: ${String(cause)}`;
    }
  }

  async function setMemoryMode(mode: MemoryMode) {
    const directory = snapshot?.directory;
    if (!directory) return;
    const request = ++memoryModeRequest;
    memoryStorageError = '';
    try {
      await serializeMemoryMode(async () => {
        const projectKey = await invoke<string>('memory_project_key', { directory });
        await invoke('save_setting', {
          key: `sai-memory-mode:${projectKey}`,
          value: mode === 'off' ? null : mode,
        });
      });
      if (request === memoryModeRequest && snapshot?.directory === directory) {
        agentPreview = null;
        previewRequest += 1;
        await refreshMemory(directory);
      }
    } catch (cause) {
      if (request === memoryModeRequest) memoryStorageError = `Storage: ${String(cause)}`;
    }
  }

  async function forgetMemory(id: string) {
    const directory = snapshot?.directory;
    if (!directory) return;
    memoryStorageError = '';
    try {
      await invoke('memory_forget', { directory, id });
      pendingForget = '';
      await refreshMemory(directory);
    } catch (cause) {
      memoryStorageError = `Storage: ${String(cause)}`;
    }
  }

  async function downloadMemoryExport() {
    const directory = snapshot?.directory;
    if (!directory || !memoryStatus?.enabled) return;
    memoryStorageError = '';
    try {
      const records = await invoke<MemoryRecord[]>('memory_list', {
        directory,
        includeForgotten: false,
      });
      const blob = new Blob([exportMemories(records)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `sail-memory-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      memoryStorageError = `Storage: ${String(cause)}`;
    }
  }

  async function importAgentMemories() {
    const directory = snapshot?.directory;
    const ids = memoryImportCandidates.map((candidate) => candidate.id);
    if (!directory || !ids.length || memoryImportLoading) return;
    memoryImportLoading = true;
    memoryImportError = '';
    memoryImportMessage = '';
    try {
      const imported = await invoke<MemoryRecord[]>('import_agent_memories', {
        directory,
        ids,
      });
      if (snapshot?.directory !== directory) return;
      memoryImportMessage = `Imported ${imported.length} ${imported.length === 1 ? 'memory' : 'memories'} from Claude Code.`;
      await refreshMemory(directory);
    } catch (cause) {
      if (snapshot?.directory === directory) memoryImportError = `Import: ${String(cause)}`;
    } finally {
      memoryImportLoading = false;
    }
  }

  async function previewAgentChange(
    agent: MemoryAgentStatus['id'],
    action: 'install' | 'uninstall',
  ) {
    const request = ++previewRequest;
    memoryConfigError = '';
    agentPreview = null;
    try {
      const result = await invoke<MemoryAgentInstallPreview>(
        action === 'install' ? 'preview_memory_agent_install' : 'preview_memory_agent_uninstall',
        { agent },
      );
      if (request === previewRequest) agentPreview = { action, result };
    } catch (cause) {
      if (request === previewRequest) memoryConfigError = `Configuration: ${String(cause)}`;
    }
  }

  async function changeAgentInstall(
    command: 'install_memory_agent' | 'uninstall_memory_agent',
    agent: MemoryAgentStatus['id'],
  ) {
    memoryConfigError = '';
    try {
      await invoke(command, { agent });
      agentPreview = null;
      previewRequest += 1;
      if (snapshot?.directory) await refreshMemory(snapshot.directory);
    } catch (cause) {
      memoryConfigError = `Configuration: ${String(cause)}`;
    }
  }

  async function inspectIntegration(directory: string) {
    const request = ++integrationRequest;
    integrationDirectory = directory;
    hookIntegration = null;
    integrationError = '';
    if (!directory) {
      integrationLoading = false;
      return;
    }
    integrationLoading = true;
    try {
      const result = await invoke<HookIntegration>('inspect_hook_integration', {
        worktree: directory,
      });
      if (request === integrationRequest && integrationDirectory === directory)
        hookIntegration = result;
    } catch (cause) {
      if (request === integrationRequest && integrationDirectory === directory)
        integrationError = String(cause);
    } finally {
      if (request === integrationRequest && integrationDirectory === directory)
        integrationLoading = false;
    }
  }

  async function changeIntegration(command: 'enable_hook_integration' | 'remove_hook_integration') {
    const directory = snapshot?.directory;
    if (!directory || integrationDirectory !== directory) return;
    const request = ++integrationRequest;
    integrationLoading = true;
    integrationError = '';
    try {
      const result = await invoke<HookIntegration>(command, {
        worktree: directory,
      });
      if (request !== integrationRequest || snapshot?.directory !== directory) return;
      hookIntegration = result;
      await inspectHooks(directory);
    } catch (cause) {
      if (request === integrationRequest && snapshot?.directory === directory)
        integrationError = String(cause);
    } finally {
      if (request === integrationRequest && snapshot?.directory === directory)
        integrationLoading = false;
    }
  }

  async function inspectHooks(directory: string) {
    hookDirectory = directory;
    hookReport = null;
    hookError = '';
    if (!directory) return;
    hookLoading = true;
    try {
      const report = await invoke<{ entries: HookEntry[]; errors: HookError[] }>(
        'inspect_agent_hooks',
        { worktree: directory },
      );
      if (hookDirectory === directory) hookReport = report;
    } catch (cause) {
      if (hookDirectory === directory) hookError = String(cause);
    } finally {
      if (hookDirectory === directory) hookLoading = false;
    }
  }

  function send(action: SettingsAction) {
    requestError = '';
    void emitTo('main', settingsAction, action).catch((cause: unknown) => {
      requestError = String(cause);
    });
  }

  function addValidationChoice() {
    const agent = validationAgent.trim();
    const model = validationModel.trim();
    if (!snapshot || !agent || !model) return;
    if (
      snapshot.crossValidation.choices.some((item) => item.agent === agent && item.model === model)
    )
      return;
    send({
      type: 'cross-validation',
      value: {
        ...snapshot.crossValidation,
        choices: [...snapshot.crossValidation.choices, { agent, model }],
      },
    });
    validationModel = '';
  }

  function removeValidationChoice(choice: ValidationChoice) {
    if (!snapshot) return;
    send({
      type: 'cross-validation',
      value: {
        ...snapshot.crossValidation,
        choices: snapshot.crossValidation.choices.filter(
          (item) => item.agent !== choice.agent || item.model !== choice.model,
        ),
      },
    });
  }

  function validationReason(choice: ValidationChoice): string | null {
    if (!snapshot) return 'Checking availability';
    const agent = snapshot.agents.find((item) => item.id === choice.agent);
    if (!agent?.available) return agent?.reason || 'Agent is unavailable';
    return null;
  }

  function saveRoute() {
    if (!snapshot || !routingModel.trim()) return;
    const route: ModelRoute = {
      role: routingRole,
      risk: routingRisk,
      provider: routingProvider,
      model: routingModel.trim(),
      ...(routingVariant.trim() ? { variant: routingVariant.trim() } : {}),
    };
    send({
      type: 'model-routing',
      value: {
        ...snapshot.modelRouting,
        routes: [
          ...snapshot.modelRouting.routes.filter(
            (item) => item.role !== route.role || item.risk !== route.risk,
          ),
          route,
        ],
      },
    });
  }

  function removeRoute(route: ModelRoute) {
    if (!snapshot) return;
    send({
      type: 'model-routing',
      value: {
        ...snapshot.modelRouting,
        routes: snapshot.modelRouting.routes.filter(
          (item) => item.role !== route.role || item.risk !== route.risk,
        ),
      },
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

  let themePreference = $state<ThemePreference>(parseThemePreference(getSetting(themeSettingKey)));
  let systemDark = $state(globalThis.matchMedia?.(systemDarkQuery).matches ?? false);

  $effect(() => {
    document.documentElement.dataset.suiTheme = resolveTheme(themePreference, systemDark);
  });

  onMount(() => {
    const stopSystemTheme = watchSystemDark((value) => (systemDark = value));
    let unlisten: (() => void) | undefined;
    let active = true;
    void (async () => {
      try {
        const stop = await listen<SettingsSnapshot>(settingsState, (event) => {
          snapshot = event.payload;
          if (selectedSection === 'agents') {
            if (snapshot.directory !== hookDirectory) void inspectHooks(snapshot.directory);
            if (snapshot.directory !== integrationDirectory)
              void inspectIntegration(snapshot.directory);
          }
          if (selectedSection === 'memory' && snapshot.directory !== memoryDirectory)
            void refreshMemory(snapshot.directory);
          if (selectedSection === 'context' && snapshot.directory !== contextDirectory)
            void refreshContext(snapshot.directory);
          themePreference = snapshot.theme;
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
      stopSystemTheme();
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
        onclick={() => {
          selectedSection = 'agents';
          if (snapshot?.directory) {
            if (snapshot.directory !== hookDirectory) void inspectHooks(snapshot.directory);
            if (snapshot.directory !== integrationDirectory)
              void inspectIntegration(snapshot.directory);
          }
        }}>Agents</button
      >
      <button
        class:active={selectedSection === 'memory'}
        aria-current={selectedSection === 'memory' ? 'page' : undefined}
        onclick={() => {
          selectedSection = 'memory';
          if (snapshot?.directory) void refreshMemory(snapshot.directory);
        }}>Memory</button
      >
      <button
        class:active={selectedSection === 'context'}
        aria-current={selectedSection === 'context' ? 'page' : undefined}
        onclick={() => {
          selectedSection = 'context';
          if (snapshot?.directory) void refreshContext(snapshot.directory);
        }}>Context</button
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
              { value: 'system', name: 'System' },
              { value: 'light', name: 'Light' },
              { value: 'dark', name: 'Dark' },
            ]}
            open={themePickerOpen}
            onopen={() => (themePickerOpen = true)}
            onclose={() => (themePickerOpen = false)}
            onchoose={(value) => send({ type: 'theme', value: parseThemePreference(value) })}
          />
        </section>
        <section class="settings-card">
          <h2>Clipboard</h2>
          <label class="attention-setting">
            <input
              type="checkbox"
              checked={snapshot.autoCopyEnabled}
              onchange={(event) => send({ type: 'auto-copy', value: event.currentTarget.checked })}
            />
            Copy selected text automatically
          </label>
          <p>Selecting text outside inputs copies it and announces "Copied".</p>
        </section>
      {:else}<p role="status">Loading settings…</p>{/if}
    {:else if selectedSection === 'opencode'}
      <h1>OpenCode</h1>
      <section class="settings-card">
        <h2>Binary</h2>
        {#if openCodeAgent?.available}<p class="runtime-binary" title={openCodeAgent.binaryPath}>
            Available: {openCodeAgent.binaryPath}
          </p>{:else if openCodeAgent}<p class="runtime-diagnostic" role="alert">
            {openCodeAgent.reason ?? 'OpenCode is unavailable.'}
          </p>{:else}<p class="runtime-binary">Status: Loading</p>{/if}
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
          disabled={!snapshot}
          onclick={() => {
            send({ type: 'binary', value: binaryPath });
            binaryDirty = false;
          }}>Save and check</Button
        >
      </section>
    {:else if selectedSection === 'agents'}
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
        <h2>Ship It cross-validation</h2>
        <p>
          Select the agents and exact models allowed to review and test changes. Model IDs must
          match the agent's model selector.
        </p>
        <label class="attention-setting">
          <input
            type="checkbox"
            checked={snapshot?.crossValidation.strictDifferentModel ?? false}
            onchange={(event) =>
              snapshot &&
              send({
                type: 'cross-validation',
                value: {
                  ...snapshot.crossValidation,
                  strictDifferentModel: event.currentTarget.checked,
                },
              })}
          />
          Require a model different from every implementation model
        </label>
        {#each snapshot?.crossValidation.choices ?? [] as choice (`${choice.agent}:${choice.model}`)}
          <p class="runtime-binary">
            <strong>{choice.agent} · {choice.model}</strong>
            {#if validationReason(choice)}<span role="status">
                — {validationReason(choice)}</span
              >{:else}<span> — agent available; model verified at gate</span>{/if}
            <Button size="sm" onclick={() => removeValidationChoice(choice)}>Remove</Button>
          </p>
        {:else}<p role="status">
            No cross-validation models selected. Gates use the implementation agent and model.
          </p>{/each}
        <label for="validation-agent">Agent</label>
        <select id="validation-agent" bind:value={validationAgent}>
          <option value="">Select an agent</option>
          {#each snapshot?.agents ?? [] as agent (agent.id)}<option value={agent.id}
              >{agent.name}</option
            >{/each}
        </select>
        <label for="validation-model">Model ID</label>
        <input
          id="validation-model"
          type="text"
          bind:value={validationModel}
          placeholder={validationAgent === 'opencode' ? 'provider/model' : 'Exact model ID'}
        />
        <Button
          size="sm"
          disabled={!validationAgent || !validationModel.trim()}
          onclick={addValidationChoice}>Add model</Button
        >
      </section>
      <section class="settings-card">
        <h2>Model routing</h2>
        <p>
          Assign exact agent models by work role and task risk. Exact routes reject aliases such as
          <code>default</code>, <code>latest</code>, or <code>sonnet</code> at launch.
        </p>
        {#each snapshot?.modelRouting.routes ?? [] as route (`${route.role}:${route.risk}`)}
          <p class="runtime-binary">
            <strong>{route.role} · {route.risk}</strong> — {route.provider} / {route.model}{route.variant
              ? ` · ${route.variant}`
              : ''}
            <Button size="sm" onclick={() => removeRoute(route)}>Remove</Button>
          </p>
        {:else}<p role="status">No explicit model routes configured.</p>{/each}
        <label for="routing-role">Role</label>
        <select id="routing-role" bind:value={routingRole}>
          {#each modelRouteRoles as role (role)}<option value={role}>{role}</option>{/each}
        </select>
        <label for="routing-risk">Task risk</label>
        <select id="routing-risk" bind:value={routingRisk}>
          {#each shipRiskLevels as risk (risk)}<option value={risk}>{risk}</option>{/each}
        </select>
        <label for="routing-provider">Provider</label>
        <select id="routing-provider" bind:value={routingProvider}>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
        </select>
        <label for="routing-model">Exact model ID</label>
        <input id="routing-model" bind:value={routingModel} placeholder="Exact model ID" />
        <label for="routing-variant">Variant</label>
        <input
          id="routing-variant"
          bind:value={routingVariant}
          placeholder="Optional effort/variant"
        />
        <Button size="sm" disabled={!routingModel.trim()} onclick={saveRoute}>Save route</Button>
        <p class="runtime-binary">
          Accepted-task corpus: {snapshot
            ? evaluateModelRouting(snapshot.modelRouting).accepted
            : 0}/{snapshot ? evaluateModelRouting(snapshot.modelRouting).acceptedTotal : 0} routed · failure
          corpus: {snapshot
            ? evaluateModelRouting(snapshot.modelRouting).failuresPrevented
            : 0}/{snapshot ? evaluateModelRouting(snapshot.modelRouting).failureTotal : 0} prevented
        </p>
        <p>Require independent review for:</p>
        {#each shipRiskLevels as risk (risk)}
          <label class="attention-setting">
            <input
              type="checkbox"
              checked={snapshot?.modelRouting.independentReviewRisks.includes(risk) ?? false}
              onchange={(event) =>
                snapshot &&
                send({
                  type: 'model-routing',
                  value: {
                    ...snapshot.modelRouting,
                    independentReviewRisks: event.currentTarget.checked
                      ? [...new Set([...snapshot.modelRouting.independentReviewRisks, risk])]
                      : snapshot.modelRouting.independentReviewRisks.filter(
                          (candidate) => candidate !== risk,
                        ),
                  },
                })}
            />
            {risk}
          </label>
        {/each}
      </section>
      <section class="settings-card">
        <h2>Ship merging</h2>
        <p>
          Repository instructions that say who merges take precedence over this setting. With "You",
          Ship workers stop at a mergeable pull request. A change applies to workers launched
          afterwards.
        </p>
        <label for="ship-merge-owner">Who merges Ship PRs</label>
        <select
          id="ship-merge-owner"
          value={snapshot?.mergeOwner ?? 'you'}
          onchange={(event) =>
            send({
              type: 'merge-owner',
              value: event.currentTarget.value === 'agent' ? 'agent' : 'you',
            })}
        >
          <option value="you">You</option>
          <option value="agent">Agent, per repository release policy</option>
        </select>
      </section>
      <section class="settings-card">
        <h2>Ship archive</h2>
        <p>
          Archive a Ship run after all its issues are merged or closed and its claims are released.
          Archiving only hides the run: checkpoints, evidence, branches and worktrees stay, and the
          Archived filter brings it back.
        </p>
        <label for="ship-archive-delay">Archive finished runs</label>
        <select
          id="ship-archive-delay"
          value={snapshot?.shipArchiveDelay ?? defaultShipArchiveDelay}
          onchange={(event) =>
            send({
              type: 'ship-archive-delay',
              value: parseShipArchiveDelay(event.currentTarget.value),
            })}
        >
          {#each shipArchiveDelays as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </section>
      <section class="settings-card">
        <h2>Context handoff</h2>
        <p>
          Ask Ship workers to checkpoint ten percentage points before this limit, then offer a
          fresh-thread handoff at the limit.
        </p>
        <label for="context-handoff-threshold">Context threshold (%)</label>
        <input
          id="context-handoff-threshold"
          type="number"
          min="60"
          max="95"
          step="1"
          value={snapshot?.contextHandoffThreshold ?? 85}
          onchange={(event) =>
            send({
              type: 'context-handoff-threshold',
              value: Number(event.currentTarget.value),
            })}
        />
      </section>
      <section class="settings-card hook-inspector">
        <h2>Runtime hook integration</h2>
        <p>
          Optional Claude project hooks send live outcomes to this Sail process. Codex and OpenCode
          remain configuration-only because they do not expose this integration here.
        </p>
        {#if integrationError}<p class="runtime-diagnostic" role="alert">{integrationError}</p>{/if}
        {#if hookIntegration}
          <p class="runtime-binary" data-integration-state={hookIntegration.state}>
            <strong>{hookIntegration.provider}: {hookIntegration.state}</strong> — {hookIntegration.detail}
          </p>
          <dl class="integration-preview">
            <dt>Scope</dt>
            <dd>{hookIntegration.scope}</dd>
            <dt>File</dt>
            <dd><code>{hookIntegration.file}</code></dd>
            <dt>Events</dt>
            <dd>{hookIntegration.events.join(', ')}</dd>
            <dt>Command</dt>
            <dd><code>{hookIntegration.commands.join('\n')}</code></dd>
            <dt>Trust impact</dt>
            <dd>{hookIntegration.trustImpact}</dd>
          </dl>
          {#if hookIntegration.enabled}
            <Button
              size="sm"
              variant="secondary"
              disabled={integrationLoading}
              onclick={() => void changeIntegration('remove_hook_integration')}
              >Remove Sail integration</Button
            >
          {:else}
            <Button
              size="sm"
              disabled={integrationLoading || hookIntegration.state === 'failing'}
              onclick={() => void changeIntegration('enable_hook_integration')}
              >Enable reviewed integration</Button
            >
          {/if}
          <Button
            size="sm"
            variant="secondary"
            disabled={integrationLoading}
            onclick={() => snapshot?.directory && void inspectIntegration(snapshot.directory)}
            >Refresh integration health</Button
          >
        {:else}
          <Button
            size="sm"
            disabled={!snapshot?.directory || integrationLoading}
            onclick={() => snapshot?.directory && void inspectIntegration(snapshot.directory)}
            >{integrationLoading ? 'Loading preview…' : 'Preview integration'}</Button
          >
        {/if}
      </section>
      <section class="settings-card hook-inspector">
        <h2>Configured hooks and plugins</h2>
        <p class="runtime-binary" title={snapshot?.directory ?? ''}>
          {snapshot?.directory || 'Select a worktree to inspect its configuration.'}
        </p>
        <Button
          size="sm"
          disabled={!snapshot?.directory || hookLoading}
          onclick={() => void inspectHooks(snapshot!.directory)}
          >{hookLoading ? 'Inspecting…' : 'Refresh'}</Button
        >
        {#if hookError}<p class="runtime-diagnostic" role="alert">{hookError}</p>{/if}
        {#each hookReport?.errors ?? [] as item, index (`${item.source}:${index}`)}<p
            class="runtime-diagnostic"
            role="alert"
          >
            <strong>{item.provider}</strong> · {item.source}: {item.message}
          </p>{/each}
        {#if hookReport && !hookReport.entries.length}<p>
            No configured hooks or plugins found.
          </p>{/if}
        {#if hookReport?.entries.length}<ul>
            {#each hookReport.entries as item, index (`${item.source}:${item.event}:${index}`)}<li>
                <strong>{item.provider} · {item.event}</strong><br />
                <code>{item.identity}</code><br />
                <small>{item.source} · {item.state}</small>
              </li>{/each}
          </ul>{/if}
        <p class="runtime-binary">
          Read-only file discovery. Check native controls for effective trust and enabled state:
        </p>
        <p class="runtime-binary">
          <a
            href="https://code.claude.com/docs/en/hooks"
            onclick={(event) => openExternalLink(event, 'https://code.claude.com/docs/en/hooks')}
            >Claude /hooks</a
          >
          ·
          <a
            href="https://learn.chatgpt.com/docs/hooks"
            onclick={(event) => openExternalLink(event, 'https://learn.chatgpt.com/docs/hooks')}
            >Codex hooks</a
          >
          ·
          <a
            href="https://opencode.ai/v2/docs/plugins"
            onclick={(event) => openExternalLink(event, 'https://opencode.ai/v2/docs/plugins')}
            >OpenCode plugins</a
          >
        </p>
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
          Allow agents to create worktrees and start threads
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
        {#each notificationTypes as type (type)}
          <label class="attention-setting notification-pref">
            <span>{notificationTypeLabels[type]}</span>
            <select
              data-notification-type={type}
              value={snapshot?.notificationPrefs[type] ?? defaultNotificationPrefs[type]}
              onchange={(event) =>
                send({
                  type: 'notification-pref',
                  notification: type,
                  value: event.currentTarget.value as NotificationPreference,
                })}
            >
              {#each notificationPreferences as preference (preference)}
                <option value={preference}>{notificationPreferenceLabels[preference]}</option>
              {/each}
            </select>
          </label>
        {/each}
        <label class="attention-setting">
          <input
            type="checkbox"
            checked={snapshot?.notificationSound ?? true}
            disabled={!notificationsOn}
            onchange={(event) =>
              send({ type: 'notification-sound', value: event.currentTarget.checked })}
          />
          Notification sound
        </label>
      </section>
    {:else if selectedSection === 'context'}
      <h1>Context provider</h1>
      <section class="settings-card">
        <h2>Project approval</h2>
        <p class="runtime-binary" title={snapshot?.directory ?? ''}>
          {snapshot?.directory || 'Select a project to review its context provider.'}
        </p>
        {#if contextError}<p class="runtime-diagnostic" role="alert">{contextError}</p>{/if}
        {#if contextMessage}<p class="runtime-binary" role="status">{contextMessage}</p>{/if}
        <Button
          size="sm"
          variant="secondary"
          disabled={!snapshot?.directory || contextLoading || contextBusy}
          onclick={() => snapshot?.directory && void refreshContext(snapshot.directory)}
          >Refresh</Button
        >
        {#if !snapshot?.directory}
          <p role="status">No project selected.</p>
        {:else if contextLoading && !contextStatus}
          <p role="status">Checking committed context configuration…</p>
        {:else if contextStatus?.state === 'not-configured'}
          <p role="status">This project has no committed context provider selection.</p>
        {:else if contextStatus?.state === 'invalid'}
          <p class="runtime-diagnostic" role="alert">
            {contextStatus.reason || 'The committed context configuration is invalid.'}
          </p>
        {:else if contextStatus}
          <dl class="integration-preview context-provider-details">
            <dt>Provider</dt>
            <dd>{contextStatus.id}</dd>
            <dt>Registry command</dt>
            <dd><code>{contextStatus.command}</code></dd>
            <dt>Executable</dt>
            <dd><code>{contextStatus.executable ?? 'Not selected'}</code></dd>
            <dt>SHA-256</dt>
            <dd><code>{contextStatus.executableSha256 ?? 'Unavailable'}</code></dd>
            <dt>Capabilities</dt>
            <dd>{contextStatus.capabilities.join(', ')}</dd>
            <dt>Committed revision</dt>
            <dd><code>{contextStatus.revision}</code></dd>
            <dt>Approval</dt>
            <dd>{contextStatus.state === 'approved' ? 'Approved' : 'Approval required'}</dd>
          </dl>
          {#if contextStatus.reason}<p class="runtime-diagnostic" role="status">
              {contextStatus.reason}
            </p>{/if}
          <p>
            Approval records your choice. Sail does not start the provider or add it to agents yet.
          </p>
          <label for="context-executable">Provider executable</label>
          <input
            id="context-executable"
            type="text"
            bind:value={contextExecutable}
            placeholder="Absolute path to executable"
            disabled={contextBusy}
          />
          <p>
            Selecting an executable replaces this registry command for every project and revokes
            their approvals.
          </p>
          <div class="context-provider-actions">
            <Button
              size="sm"
              variant="secondary"
              disabled={contextBusy}
              onclick={chooseContextExecutable}>Browse…</Button
            >
            <Button
              size="sm"
              variant="secondary"
              disabled={contextBusy ||
                !contextExecutable.trim() ||
                contextExecutable.trim() === contextStatus.executable}
              onclick={registerContextExecutable}>Select executable</Button
            >
            {#if contextStatus.state === 'approval-required' && contextStatus.fingerprint}
              <Button size="sm" disabled={contextBusy} onclick={approveContextProvider}
                >Approve for this project</Button
              >
            {:else if contextStatus.state === 'approved'}
              <Button
                size="sm"
                variant="secondary"
                disabled={contextBusy}
                onclick={revokeContextProvider}>Revoke approval</Button
              >
            {/if}
          </div>
        {/if}
      </section>
    {:else}
      <h1>Memory</h1>
      <section class="settings-card">
        <h2>Shared memory mode</h2>
        <p>
          Memory is off by default. Sail only shares this project's memory between agents opened in
          Sail. System-wide also makes it available when supported agents run elsewhere.
        </p>
        <p class="runtime-binary">
          Mode changes apply to new or reconnected agent sessions. Reopen an existing live session
          to add or remove its memory tools.
        </p>
        <label for="memory-mode">Availability</label>
        <select
          id="memory-mode"
          value={memoryStatus?.mode ?? 'off'}
          onchange={(event) => void setMemoryMode(event.currentTarget.value as MemoryMode)}
        >
          <option value="off">Off</option>
          <option value="sail">Sail only</option>
          <option value="system">System-wide</option>
        </select>
        {#if (memoryStatus?.mode ?? 'off') === 'off'}
          <p class="memory-empty" role="status">
            Shared memory is off. Enabling it does not create a memory until you or an agent saves
            one.
          </p>
        {:else if memoryStatus}
          <p class="runtime-binary">
            {memoryStatus.count} active {memoryStatus.count === 1 ? 'memory' : 'memories'} ·
            {memoryStatus.forgottenCount} forgotten
          </p>
        {/if}
      </section>

      <section class="settings-card">
        <h2>Search provider</h2>
        <p>
          Local project memory remains canonical. Mem0 or AgentMemory adds external search; an
          outage falls back to local search and never blocks memory writes.
        </p>
        {#if memoryProviderError}<p class="runtime-diagnostic" role="alert">
            {memoryProviderError}
          </p>{/if}
        {#if memoryProviderMessage}<p class="runtime-binary" role="status">
            {memoryProviderMessage}
          </p>{/if}
        {#if memoryProviderStatus?.notice && memoryProviderKind === memoryProviderStatus.provider}<p
            class="runtime-diagnostic"
            role="status"
          >
            {memoryProviderStatus.notice}
          </p>{/if}
        {#if memoryProviderStatus?.syncError && memoryProviderKind === memoryProviderStatus.provider}<p
            class="runtime-diagnostic"
            role="alert"
          >
            Last provider sync failed: {memoryProviderStatus.syncError} Local search remains active.
          </p>{/if}
        {#if memoryProviderKind === 'agentMemory' && (memoryProviderError.includes('unknown outcome') || (memoryProviderStatus?.provider === 'agentMemory' && memoryProviderStatus.syncError?.includes('unknown outcome')))}
          <Button
            size="sm"
            variant="secondary"
            disabled={memoryProviderLoading}
            onclick={() => (pendingProviderResolution = true)}>Resolve pending write</Button
          >
        {/if}
        {#if pendingProviderResolution && memoryProviderKind === 'agentMemory'}
          <p class="runtime-diagnostic" role="alert">
            AgentMemory has no idempotency key. Check its records for this project before clearing
            the pending write. A delayed earlier write can appear later; retrying then can create a
            duplicate. Sail will scan this endpoint again before clearing.
          </p>
          <Button
            size="sm"
            disabled={memoryProviderLoading}
            onclick={() => void resolvePendingMemoryProvider()}
            >I checked; clear pending write</Button
          >
          <Button
            size="sm"
            variant="secondary"
            disabled={memoryProviderLoading}
            onclick={() => (pendingProviderResolution = false)}>Cancel</Button
          >
        {/if}
        <label for="memory-provider">Provider</label>
        <select
          id="memory-provider"
          bind:value={memoryProviderKind}
          disabled={!snapshot?.directory || memoryProviderLoading}
          onchange={() => {
            memoryProviderMessage = '';
            memoryProviderError = '';
            pendingProviderResolution = false;
          }}
        >
          <option value="local">Local search</option>
          <option value="mem0Hosted">Mem0 hosted</option>
          <option value="mem0SelfHosted">Mem0 self-hosted</option>
          <option value="agentMemory">AgentMemory (local-first)</option>
        </select>
        {#if memoryProviderKind === 'mem0SelfHosted' || memoryProviderKind === 'agentMemory'}
          <label for="memory-provider-endpoint">Endpoint</label>
          <input
            id="memory-provider-endpoint"
            type="url"
            placeholder={memoryProviderKind === 'agentMemory'
              ? 'http://127.0.0.1:8000'
              : 'https://mem0.example.com'}
            bind:value={memoryProviderEndpoint}
            oninput={() => (pendingProviderResolution = false)}
            disabled={memoryProviderLoading}
          />
          <p class="runtime-binary">HTTPS is required except for localhost development servers.</p>
        {/if}
        {#if memoryProviderKind !== 'local'}
          <label for="memory-provider-api-key"
            >{memoryProviderKind === 'agentMemory' ? 'Access token (optional)' : 'API key'}</label
          >
          <input
            id="memory-provider-api-key"
            type="password"
            autocomplete="off"
            bind:value={memoryProviderApiKey}
            disabled={memoryProviderLoading}
          />
          <p class="runtime-binary">
            {memoryProviderKind === 'agentMemory'
              ? 'Leave blank to reuse a saved token for this endpoint, or connect anonymously if none is saved. Tokens stay in the OS credential store, never in Sail settings, exports, logs, or agent configuration.'
              : 'The key is stored in the OS credential store, never in Sail settings, exports, logs, or agent configuration.'}
          </p>
          <Button
            size="sm"
            variant="secondary"
            disabled={!memoryStatus?.enabled ||
              (memoryProviderKind !== 'agentMemory' && !memoryProviderApiKey.trim()) ||
              ((memoryProviderKind === 'mem0SelfHosted' || memoryProviderKind === 'agentMemory') &&
                !memoryProviderEndpoint.trim()) ||
              memoryProviderLoading}
            onclick={() => void verifyMemoryProvider()}>Verify connection</Button
          >
        {/if}
        <Button
          size="sm"
          disabled={!snapshot?.directory ||
            memoryProviderLoading ||
            (memoryProviderKind !== 'local' &&
              (!memoryStatus?.enabled ||
                (memoryProviderKind !== 'agentMemory' && !memoryProviderApiKey.trim()) ||
                ((memoryProviderKind === 'mem0SelfHosted' ||
                  memoryProviderKind === 'agentMemory') &&
                  !memoryProviderEndpoint.trim())))}
          onclick={() => void saveMemoryProvider()}
          >{memoryProviderKind === 'local'
            ? 'Use local search'
            : memoryProviderKind === 'agentMemory'
              ? 'Enable AgentMemory'
              : 'Enable Mem0'}</Button
        >
        {#if !memoryStatus?.enabled && memoryProviderKind !== 'local'}
          <p class="memory-empty" role="status">
            Enable shared memory before connecting a search provider.
          </p>
        {/if}
      </section>

      {#if memoryStatus?.mode === 'system'}
        <section class="settings-card">
          <h2>Coding agents</h2>
          <p>Install shared memory independently in each detected agent.</p>
          {#if memoryAgentError}<p class="runtime-diagnostic" role="alert">
              {memoryAgentError}
            </p>{/if}
          {#if memoryConfigError}<p class="runtime-diagnostic" role="alert">
              {memoryConfigError}
            </p>{/if}
          <div class="memory-agent-list">
            {#each memoryAgents as agent (agent.id)}
              <article class="memory-agent" data-agent={agent.id}>
                <div>
                  <strong>{agent.name}</strong>
                  <span class:healthy={agent.healthy}>
                    {agent.installed
                      ? agent.healthy
                        ? 'Installed and healthy'
                        : 'Installed with a problem'
                      : agent.detected
                        ? 'Available to install'
                        : 'Not detected'}
                  </span>
                  <small>{agent.detail}</small>
                </div>
                {#if agent.installed}
                  <Button
                    size="sm"
                    variant="secondary"
                    onclick={() => void previewAgentChange(agent.id, 'uninstall')}
                    >Preview uninstall</Button
                  >
                {:else}
                  <Button
                    size="sm"
                    disabled={!agent.detected}
                    onclick={() => void previewAgentChange(agent.id, 'install')}
                    >Preview install</Button
                  >
                {/if}
              </article>
            {:else}
              <p role="status">
                {memoryLoading ? 'Checking agents…' : 'No supported agents found.'}
              </p>
            {/each}
          </div>
          {#if agentPreview}
            <div class="memory-install-preview">
              <h3>Review configuration change</h3>
              <p><code>{agentPreview.result.path}</code></p>
              <p class="runtime-binary">
                The preview shows only Sail's shared-memory entry. Other configuration, including
                credentials, is omitted.
              </p>
              <div class="memory-config-comparison">
                <div>
                  <strong>Before</strong>
                  <pre>{agentPreview.result.before || '(empty)'}</pre>
                </div>
                <div>
                  <strong>After</strong>
                  <pre>{agentPreview.result.after}</pre>
                </div>
              </div>
              <Button
                size="sm"
                disabled={!agentPreview.result.changed}
                onclick={() =>
                  agentPreview &&
                  void changeAgentInstall(
                    agentPreview.action === 'install'
                      ? 'install_memory_agent'
                      : 'uninstall_memory_agent',
                    agentPreview.result.agent,
                  )}
                >{agentPreview.result.changed
                  ? `${agentPreview.action === 'install' ? 'Install' : 'Uninstall'} reviewed change`
                  : 'No change needed'}</Button
              >
              <Button
                size="sm"
                variant="secondary"
                onclick={() => {
                  previewRequest += 1;
                  agentPreview = null;
                }}>Cancel</Button
              >
            </div>
          {/if}
        </section>
      {/if}

      <section class="settings-card">
        <h2>Import agent memories</h2>
        <p>
          Sail finds Claude Code's local auto-memory for this Git project. Codex and OpenCode
          currently provide instruction files, not a separate auto-memory source. Sail never imports
          instructions or transcripts.
        </p>
        {#if memoryImportError}<p class="runtime-diagnostic" role="alert">
            {memoryImportError}
          </p>{/if}
        {#if memoryImportMessage}<p class="runtime-binary" role="status">
            {memoryImportMessage}
          </p>{/if}
        {#if !memoryStatus?.enabled}
          <p class="memory-empty" role="status">Enable shared memory to import agent memories.</p>
        {:else if memoryLoading}
          <p class="memory-empty" role="status">Checking local agent memories…</p>
        {:else if !memoryImportCandidates.length}
          <p class="memory-empty" role="status">
            No new Claude Code memories found for this project.
          </p>
        {:else}
          <Button
            size="sm"
            disabled={memoryImportLoading}
            onclick={() => void importAgentMemories()}>Import all</Button
          >
        {/if}
      </section>

      <section class="settings-card">
        <h2>Project memories</h2>
        <p class="runtime-binary" title={snapshot?.directory ?? ''}>
          {snapshot?.directory || 'Select a project to manage its memory.'}
        </p>
        {#if memoryStorageError}<p class="runtime-diagnostic" role="alert">
            {memoryStorageError}
          </p>{/if}
        <Button
          size="sm"
          variant="secondary"
          disabled={!snapshot?.directory || memoryLoading}
          onclick={() => snapshot?.directory && void refreshMemory(snapshot.directory)}
          >Refresh</Button
        >
        <form
          class="memory-search"
          onsubmit={(event) => {
            event.preventDefault();
            if (snapshot?.directory) void refreshMemory(snapshot.directory);
          }}
        >
          <label for="memory-search">Search memories</label>
          <div>
            <input id="memory-search" type="search" bind:value={memoryQuery} />
            <Button size="sm" type="submit" disabled={!snapshot?.directory || memoryLoading}
              >Search</Button
            >
            {#if memoryQuery}
              <Button
                size="sm"
                variant="secondary"
                onclick={() => {
                  memoryQuery = '';
                  if (snapshot?.directory) void refreshMemory(snapshot.directory, '');
                }}>Clear</Button
              >
            {/if}
          </div>
        </form>
        {#if memoryLoading}
          <p role="status">Loading memories…</p>
        {:else if !memoryRecords.length}
          <p class="memory-empty" role="status">
            {memoryQuery
              ? 'No memories match this search.'
              : 'No memories yet. Add a project decision, constraint, discovery, preference, or handoff.'}
          </p>
        {:else}
          <ul class="memory-record-list">
            {#each memoryRecords as record (record.id)}
              <li>
                <div class="memory-record-meta">
                  <strong>{record.kind}</strong>
                  <time datetime={new Date(record.updatedAt).toISOString()}
                    >{new Date(record.updatedAt).toLocaleString()}</time
                  >
                </div>
                <p>{record.content}</p>
                {#if record.tags.length}<p class="memory-tags">{record.tags.join(' · ')}</p>{/if}
                {#if pendingForget === record.id}
                  <div class="memory-forget-confirm" role="group" aria-label="Confirm forget">
                    <span>Forget this memory?</span>
                    <Button size="sm" onclick={() => void forgetMemory(record.id)}>Forget</Button>
                    <Button size="sm" variant="secondary" onclick={() => (pendingForget = '')}
                      >Cancel</Button
                    >
                  </div>
                {:else}
                  <Button size="sm" variant="secondary" onclick={() => (pendingForget = record.id)}
                    >Forget</Button
                  >
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        <Button
          size="sm"
          variant="secondary"
          disabled={!memoryStatus?.enabled || !memoryStatus.count}
          onclick={() => void downloadMemoryExport()}>Export all memories</Button
        >
      </section>

      <section class="settings-card">
        <h2>Add memory</h2>
        <label for="memory-content">What should agents remember?</label>
        <textarea id="memory-content" rows="4" bind:value={memoryContent}></textarea>
        <label for="memory-kind">Kind</label>
        <select id="memory-kind" bind:value={memoryKind}>
          {#each memoryKinds as kind (kind)}<option value={kind}>{kind}</option>{/each}
        </select>
        <label for="memory-tags">Tags, separated by commas</label>
        <input id="memory-tags" bind:value={memoryTags} />
        <Button
          size="sm"
          disabled={!snapshot?.directory || !memoryContent.trim() || !memoryStatus?.enabled}
          onclick={() => void rememberMemory()}>Remember</Button
        >
      </section>
    {/if}
  </main>
</div>
