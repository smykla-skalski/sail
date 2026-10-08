<script lang="ts">
  import { onMount } from 'svelte';
  import { emitTo, listen } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { Button } from '@smykla-skalski/sui';
  import { invoke } from '@tauri-apps/api/core';
  import OptionPicker from './OptionPicker.svelte';
  import { getSetting } from './lib/settings';
  import { openExternalLink } from './lib/external-link';
  import type { SetupCheck, SetupReport } from './lib/onboarding';
  import type { ValidationChoice } from './lib/cross-validation';
  import {
    evaluateModelRouting,
    modelRouteRoles,
    type ModelRoute,
    type ModelRouteRole,
  } from './lib/model-routing';
  import { shipRiskLevels, type ShipRisk } from './lib/ship-risk-policy';
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
    if (choice.agent === 'opencode') {
      if (snapshot.runtimeState !== 'connected')
        return snapshot.runtimeError || 'OpenCode is disconnected';
      if (
        !snapshot.setup?.models.some((model) => `${model.providerID}:${model.id}` === choice.model)
      )
        return 'Model is not enabled or its provider is disconnected in this worktree';
      return null;
    }
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

  onMount(() => {
    document.documentElement.dataset.suiTheme =
      getSetting('sai-theme') === 'dark' ? 'dark' : 'light';
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
        onclick={() => {
          selectedSection = 'agents';
          if (snapshot?.directory) {
            if (snapshot.directory !== hookDirectory) void inspectHooks(snapshot.directory);
            if (snapshot.directory !== integrationDirectory)
              void inspectIntegration(snapshot.directory);
          }
        }}>Agents</button
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
        <h2>Ship It cross-validation</h2>
        <p>
          Select the agents and exact models allowed to review and test changes. Claude and Codex
          model IDs must match their model selector.
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
          <option value="opencode">OpenCode</option>
        </select>
        <label for="validation-model">Model ID</label>
        <input
          id="validation-model"
          type="text"
          bind:value={validationModel}
          list="validation-models"
          placeholder={validationAgent === 'opencode' ? 'provider:model' : 'Exact model ID'}
        />
        <datalist id="validation-models">
          {#if validationAgent === 'opencode'}
            {#each snapshot?.setup?.models ?? [] as model (`${model.providerID}:${model.id}`)}
              <option value={`${model.providerID}:${model.id}`}>{model.name}</option>
            {/each}
          {/if}
        </datalist>
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
