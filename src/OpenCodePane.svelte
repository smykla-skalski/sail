<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { invoke } from '@tauri-apps/api/core';
  import { Badge, Button } from '@smykla-skalski/sui';
  import type { FormInfo, PermissionRequest } from '@opencode/client';
  import Markdown from './Markdown.svelte';
  import SpawnActivity from './SpawnActivity.svelte';
  import SpawnResponse from './SpawnResponse.svelte';
  import ToolActivity from './ToolActivity.svelte';
  import HarnessIcon from './HarnessIcon.svelte';
  import OptionPicker from './OptionPicker.svelte';
  import PathPicker from './PathPicker.svelte';
  import SkillMenu from './SkillMenu.svelte';
  import { matchingSkills, promptSkill, type SkillChoice } from './lib/skills';
  import { runSerialOpenCodeTurn } from './lib/opencode-turns';
  import PromptPanel from './PromptPanel.svelte';
  import type { AgentThread } from './lib/acp';
  import { withSpawnResponses, type SpawnReceipt } from './lib/agent-results';
  import type { BrowserAttachment } from './lib/browser-pick';
  import {
    coordinationMessageForText,
    coordinationPrompt,
    type CoordinationMessage,
  } from './lib/coordination';
  import type { ThreadStatus } from './lib/attention';
  import { openCodeContextUsage } from './lib/agent-usage';
  import { fileUri } from './lib/attachments';
  import type { SetupReport } from './lib/onboarding';
  import type { OpenCodeClient, SessionInfo, SessionMessageInfo } from './lib/opencode';
  import { mergeMessages, nearBottom } from './lib/timeline';
  import {
    appendToolFailureDraft,
    openCodeErrorDetails,
    reportedHookIdentity,
    toolFailurePrompt,
  } from './lib/tool-failure';

  let {
    client,
    directory,
    thread,
    setup,
    coordinationMessages = [],
    spawnReceipts = [],
    focused,
    focusPrompt,
    picked,
    externalPrompt,
    onexternalresult,
    onpickedconsumed,
    onpromptfocused,
    oncreated,
    onactivity,
    onstatus,
    onusage,
  }: {
    client: OpenCodeClient | null;
    directory: string;
    thread: AgentThread | null;
    setup: SetupReport | null;
    coordinationMessages?: CoordinationMessage[];
    spawnReceipts?: SpawnReceipt[];
    focused: boolean;
    focusPrompt: boolean;
    picked?: BrowserAttachment;
    externalPrompt?: { id: string; text: string };
    onexternalresult?: (id: string, failure: string | null) => void;
    onpickedconsumed?: (id: string) => void;
    onpromptfocused?: () => void;
    oncreated: (thread: AgentThread) => void;
    onactivity: (thread: AgentThread) => void;
    onstatus: (thread: AgentThread, status: ThreadStatus, notifyOnDone?: boolean) => void;
    onusage?: (sessionID: string, context: number | undefined) => void;
  } = $props();

  let session = $state<SessionInfo | null>(null);
  let messages = $state<SessionMessageInfo[]>([]);
  const displayMessages = $derived(
    withSpawnResponses(messages, spawnReceipts, (message) =>
      'time' in message ? message.time.created : undefined,
    ),
  );
  let cursor = $state<string | null>(null);
  let pendingPermissions = $state<PermissionRequest[]>([]);
  let pendingForms = $state<FormInfo[]>([]);
  let draft = $state('');
  let skills = $state<SkillChoice[]>([]);
  let skillSelected = $state(0);
  const skillMenuId = crypto.randomUUID();
  const skillMatches = $derived(matchingSkills(skills, draft));
  $effect(() => {
    const source = client;
    const path = directory;
    const canLoad = setup?.workReady || setup?.planReady;
    if (!source || !path || !canLoad) {
      skills = [];
      return;
    }
    let cancelled = false;
    void source.skill.list({ location: { directory: path } }).then(
      (result) => {
        if (!cancelled)
          skills = result.data.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description ?? '',
          }));
        return undefined;
      },
      () => {
        if (!cancelled) skills = [];
        return undefined;
      },
    );
    return () => {
      cancelled = true;
    };
  });

  function chooseSkill(skill: SkillChoice) {
    draft = `/${skill.name} `;
    skillSelected = 0;
    void tick().then(() => prompt.focus());
  }

  function fixToolFailure(name: string, input: unknown, reason: string, output: string) {
    const request = toolFailurePrompt(name, input, reason, output);
    draft = appendToolFailureDraft(draft, request);
    void tick().then(() => prompt.focus());
  }
  let files = $state<string[]>([]);
  let error = $state('');
  let loading = $state(false);
  let loadingOlder = $state(false);
  let sending = $state(false);
  let running = $state(false);
  let pickerOpen = $state<'agent' | 'model' | 'effort' | null>(null);
  let filePickerOpen = $state(false);
  let selectedAgent = $state('');
  let selectedModel = $state('');
  let selectedVariant = $state('');
  let scroll: HTMLDivElement;
  let prompt: HTMLTextAreaElement;
  let activeID = $state<string | null>(null);
  let selectedThreadId: string | null | undefined;
  let selectedClient: OpenCodeClient | null = null;
  const pickedImages = new SvelteSet<string>();
  const inFlightCaptures = new SvelteSet<string>();
  let generation = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let mounted = $state(false);
  let lastPicked = '';
  let lastExternalPrompt = '';
  let following = true;
  const spawnRevision = $derived(spawnReceipts.map((receipt) => receipt.updated).join(','));
  $effect(() => {
    if (spawnRevision && following) void follow();
  });
  let stopRequested = false;
  const busy = $derived(sending || running);
  const contextUsage = $derived(openCodeContextUsage(messages, setup?.models ?? []));
  const inputReady = $derived(
    !!setup?.workReady || (session?.agent === 'architect' && !!setup?.planReady),
  );
  const chosenModel = $derived(
    setup?.models.find((model) => `${model.providerID}:${model.id}` === selectedModel),
  );
  const agentChoices = $derived(
    (setup?.agents ?? []).map((agent) => ({ value: agent.id, name: agent.name })),
  );
  const modelChoices = $derived(
    (setup?.models ?? []).map((model) => ({
      value: `${model.providerID}:${model.id}`,
      name: `${model.providerID} / ${model.name}`,
    })),
  );
  const effortChoices = $derived(
    (chosenModel?.variants ?? []).map((variant) => ({ value: variant.id, name: variant.id })),
  );

  function describe(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }

  function summary(info: SessionInfo): AgentThread {
    return {
      agent: 'opencode',
      sessionId: info.id,
      directory,
      title: info.title ?? 'OpenCode thread',
      updated: info.time.updated,
    };
  }

  async function follow() {
    await tick();
    if (scroll && following) scroll.scrollTop = scroll.scrollHeight;
  }

  async function refreshMessages(id: string, current = generation) {
    if (!client) return;
    const page = await client.message.list({ sessionID: id, limit: 50, order: 'desc' });
    if (current !== generation || id !== activeID) return;
    const first = !messages.length;
    messages = first ? page.data.toReversed() : mergeMessages(messages, page.data);
    onusage?.(id, openCodeContextUsage(messages, setup?.models ?? []));
    if (first) cursor = page.cursor.next ?? null;
    await follow();
    if (scroll?.scrollHeight <= scroll?.clientHeight && cursor) void loadOlder();
  }

  async function loadOlder() {
    if (!client || !activeID || !cursor || loadingOlder) return;
    const id = activeID;
    const current = generation;
    const next = cursor;
    const height = scroll.scrollHeight;
    const top = scroll.scrollTop;
    const underfilled = height <= scroll.clientHeight;
    let loaded = false;
    loadingOlder = true;
    try {
      const page = await client.message.list({ sessionID: id, limit: 50, cursor: next });
      if (current !== generation || id !== activeID) return;
      messages = mergeMessages(messages, page.data);
      cursor = page.cursor.next === next ? null : (page.cursor.next ?? null);
      if (!underfilled) following = false;
      await tick();
      scroll.scrollTop =
        underfilled && following ? scroll.scrollHeight : top + scroll.scrollHeight - height;
      loaded = true;
    } catch (cause) {
      if (current === generation) error = describe(cause);
    } finally {
      loadingOlder = false;
      if (loaded && scroll.scrollHeight <= scroll.clientHeight && cursor) void loadOlder();
    }
  }

  async function refreshRequests(id: string, current = generation) {
    if (!client) return;
    const [permissions, forms] = await Promise.all([
      client.permission.list({ sessionID: id }),
      client.session.form.list({ sessionID: id }),
    ]);
    if (current !== generation || id !== activeID) return;
    pendingPermissions = permissions;
    pendingForms = forms;
  }

  async function activate(id: string | null) {
    const current = ++generation;
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    for (const path of pickedImages)
      if (!inFlightCaptures.has(path)) {
        pickedImages.delete(path);
        void invoke('browser_remove_capture', { path });
      }
    draft = '';
    files = [];
    selectedThreadId = id;
    activeID = id;
    session = null;
    messages = [];
    cursor = null;
    pendingPermissions = [];
    pendingForms = [];
    error = '';
    loading = false;
    sending = false;
    running = false;
    following = true;
    selectedAgent = setup?.agents.find((agent) => agent.id !== 'architect')?.id ?? '';
    selectedModel = setup?.defaultModel
      ? `${setup.defaultModel.providerID}:${setup.defaultModel.id}`
      : '';
    selectedVariant = setup?.defaultModel?.variant ?? '';
    if (!client || !id) return;
    loading = true;
    try {
      const [info, active] = await Promise.all([
        client.session.get({ sessionID: id }),
        client.session.active(),
      ]);
      if (current !== generation || disposed) return;
      session = info;
      selectedAgent = info.agent ?? selectedAgent;
      selectedModel = info.model ? `${info.model.providerID}:${info.model.id}` : selectedModel;
      selectedVariant = info.model?.variant ?? '';
      running = active[id]?.type === 'running';
      await Promise.all([refreshMessages(id, current), refreshRequests(id, current)]);
    } catch (cause) {
      if (current === generation) error = describe(cause);
    } finally {
      if (current === generation) loading = false;
    }
  }

  $effect(() => {
    const id = thread?.sessionId ?? null;
    const source = client;
    if (!disposed && source && (id !== selectedThreadId || source !== selectedClient)) {
      selectedClient = source;
      void activate(id);
    }
  });

  $effect(() => {
    if (session || !setup) return;
    selectedAgent ||= setup.agents.find((agent) => agent.id !== 'architect')?.id ?? '';
    selectedModel ||= setup.defaultModel
      ? `${setup.defaultModel.providerID}:${setup.defaultModel.id}`
      : '';
    selectedVariant ||= setup.defaultModel?.variant ?? '';
  });

  $effect(() => {
    if (!picked || picked.id === lastPicked) return;
    lastPicked = picked.id;
    pickedImages.add(picked.imagePath);
    files = [...files, picked.imagePath];
    draft = [draft.trim(), picked.text].filter(Boolean).join('\n\n');
    onpickedconsumed?.(picked.id);
  });

  $effect(() => {
    if (focusPrompt && focused && !sending && !loading) {
      void tick().then(() => {
        prompt?.focus();
        onpromptfocused?.();
        return undefined;
      });
    }
  });

  $effect(() => {
    if (
      !externalPrompt ||
      externalPrompt.id === lastExternalPrompt ||
      !client ||
      !inputReady ||
      busy ||
      loading
    )
      return;
    const request = externalPrompt;
    lastExternalPrompt = request.id;
    void send(request.text).then(
      () => onexternalresult?.(request.id, null),
      (cause) => onexternalresult?.(request.id, describe(cause)),
    );
  });

  $effect(() => {
    if (!mounted || !client) return;
    const controller = new AbortController();
    const source = client;
    void (async () => {
      try {
        for await (const event of source.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted || !activeID) continue;
          const id = 'data' in event && 'sessionID' in event.data ? event.data.sessionID : null;
          if (event.type.startsWith('permission.') || event.type.startsWith('form.'))
            void refreshRequests(activeID).catch((cause) => (error = describe(cause)));
          if (id !== activeID) continue;
          if (event.type === 'session.execution.started') running = true;
          if (
            event.type === 'session.execution.succeeded' ||
            event.type === 'session.execution.failed' ||
            event.type === 'session.execution.interrupted'
          ) {
            running = false;
            if (session)
              onstatus(
                summary(session),
                event.type === 'session.execution.failed' ? 'failed' : 'done',
              );
          }
          if (event.type === 'permission.asked' && session) onstatus(summary(session), 'waiting');
          if (!refreshTimer)
            refreshTimer = setTimeout(() => {
              refreshTimer = undefined;
              if (activeID)
                void refreshMessages(activeID).catch((cause) => (error = describe(cause)));
            }, 100);
        }
      } catch (cause) {
        if (!controller.signal.aborted) error = describe(cause);
      }
    })();
    return () => controller.abort();
  });

  onMount(() => {
    disposed = false;
    mounted = true;
    return () => {
      disposed = true;
      mounted = false;
      ++generation;
      clearTimeout(refreshTimer);
      for (const path of pickedImages)
        if (!inFlightCaptures.has(path)) void invoke('browser_remove_capture', { path });
    };
  });

  async function send(externalText?: string) {
    const external = externalText !== undefined;
    const text = (externalText ?? draft).trim();
    if (!client || (!text && (external || !files.length)) || !inputReady || sending) {
      if (external) throw new Error('Wait for the current OpenCode turn.');
      return;
    }
    const source = client;
    const paths = external ? [] : [...files];
    for (const path of paths) if (pickedImages.has(path)) inFlightCaptures.add(path);
    const current = generation;
    let accepted = false;
    if (!external) {
      draft = '';
      files = [];
    }
    const queued = running;
    sending = true;
    stopRequested = false;
    error = '';
    try {
      let id = activeID;
      if (!id) {
        const info = await source.session.create({
          agent: selectedAgent || undefined,
          model: chosenModel
            ? {
                id: chosenModel.id,
                providerID: chosenModel.providerID,
                variant: selectedVariant || undefined,
              }
            : undefined,
          location: { directory },
          metadata: { saiHarness: true },
          title: text ? (text.length > 60 ? `${text.slice(0, 57)}…` : text) : 'New work',
        });
        if (current !== generation || disposed) return;
        id = info.id;
        activeID = id;
        selectedThreadId = id;
        session = info;
        oncreated(summary(info));
      }
      running = true;
      if (session) onstatus(summary(session), 'working');
      const promptRequest = runSerialOpenCodeTurn(id, async () => {
        await invoke('record_turn_snapshot', { path: directory, thread: `opencode:${id}` });
        return source.session.prompt({
          sessionID: id,
          text,
          skills: promptSkill(skills, text)?.id
            ? [{ id: promptSkill(skills, text)!.id! }]
            : undefined,
          delivery: queued ? 'steer' : undefined,
          files: paths.map((path) => ({ uri: fileUri(path), name: path.split(/[\\/]/).at(-1) })),
        });
      });
      sending = false;
      await promptRequest;
      accepted = true;
      for (const path of paths)
        if (pickedImages.delete(path)) void invoke('browser_remove_capture', { path });
      if (queued) {
        await refreshMessages(id, current);
        return;
      }
      await source.session.wait({ sessionID: id });
      if (current === generation && id === activeID) {
        const latest = await source.session.get({ sessionID: id });
        if (current !== generation || id !== activeID || disposed) return;
        session = latest;
        running = false;
        onstatus(summary(latest), latest.outcome === 'failed' ? 'failed' : 'done', !stopRequested);
        await refreshMessages(id, current);
        if (current !== generation || id !== activeID || disposed) return;
        onactivity(summary(latest));
      }
    } catch (cause) {
      if (current === generation) {
        error = describe(cause);
        if (!external && !accepted) {
          draft = [text, draft.trim()].filter(Boolean).join('\n\n');
          files = [...paths, ...files];
        }
        if (!queued) {
          running = false;
          if (session) onstatus(summary(session), 'failed');
        }
      }
      if (external) throw cause;
    } finally {
      for (const path of paths) inFlightCaptures.delete(path);
      if (current === generation) sending = false;
      if (disposed || current !== generation)
        for (const path of paths)
          if (pickedImages.delete(path)) void invoke('browser_remove_capture', { path });
    }
  }

  async function stop() {
    if (!client || !activeID) return;
    stopRequested = true;
    try {
      await client.session.interrupt({ sessionID: activeID });
      running = false;
      await refreshMessages(activeID);
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function chooseConfig(kind: 'agent' | 'model' | 'effort', value: string) {
    if (!client || busy) return;
    const id = activeID;
    const current = generation;
    const previous = { selectedAgent, selectedModel, selectedVariant };
    if (kind === 'agent') selectedAgent = value;
    if (kind === 'model') {
      selectedModel = value;
      selectedVariant = '';
    }
    if (kind === 'effort') selectedVariant = value;
    if (!id) return;
    try {
      if (kind === 'agent') await client.session.switchAgent({ sessionID: id, agent: value });
      else {
        const model = setup?.models.find(
          (item) => `${item.providerID}:${item.id}` === selectedModel,
        );
        if (!model) return;
        await client.session.switchModel({
          sessionID: id,
          model: {
            id: model.id,
            providerID: model.providerID,
            variant: selectedVariant || undefined,
          },
        });
      }
      const info = await client.session.get({ sessionID: id });
      if (current === generation && id === activeID) session = info;
    } catch (cause) {
      if (current !== generation || id !== activeID) return;
      selectedAgent = previous.selectedAgent;
      selectedModel = previous.selectedModel;
      selectedVariant = previous.selectedVariant;
      error = describe(cause);
    }
  }

  function attachFiles() {
    filePickerOpen = true;
  }

  function removeFile(path: string) {
    files = files.filter((item) => item !== path);
    if (pickedImages.delete(path)) void invoke('browser_remove_capture', { path });
  }

  function keydown(event: KeyboardEvent) {
    if (skillMatches.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        skillSelected =
          (skillSelected + (event.key === 'ArrowDown' ? 1 : -1) + skillMatches.length) %
          skillMatches.length;
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        chooseSkill(skillMatches[skillSelected] ?? skillMatches[0]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        draft = '';
        return;
      }
    }
    if (event.key === 'Escape' && busy) {
      event.preventDefault();
      void stop();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  }
</script>

<div class="agent-workspace opencode-pane">
  <div class="agent-header">
    <div class="agent-heading">
      <HarnessIcon agent="opencode" /><strong>OpenCode</strong><span
        >{session?.title ?? thread?.title ?? 'New thread'}</span
      >
    </div>
    {#if contextUsage !== undefined}<span class="agent-usage">Context {contextUsage}%</span>{/if}
    <Badge tone={busy ? 'warning' : inputReady ? 'success' : 'neutral'}
      >{loading ? 'Connecting' : busy ? 'Working' : inputReady ? 'Ready' : 'Offline'}</Badge
    >
  </div>
  <div
    class="agent-conversation conversation"
    bind:this={scroll}
    aria-label="OpenCode conversation"
    onscroll={() => {
      following = nearBottom(scroll);
      if (scroll.scrollTop <= 80) void loadOlder();
    }}
  >
    {#if !messages.length && !loading}<div class="agent-welcome">
        <h1>Work with OpenCode</h1>
        <p>Describe the work. Sail will show messages, tools, and approvals here.</p>
      </div>{/if}
    {#each displayMessages as message (message.id)}
      {#if message.type === 'spawn-response'}
        <SpawnResponse receipt={message.receipt} />
      {:else if message.type === 'user'}
        {@const attribution = coordinationMessageForText(message.text, coordinationMessages)}
        <article class="agent-message message user-message">
          <div class="avatar user-avatar">{attribution ? '↗' : 'You'}</div>
          <div class="message-body">
            <div class="message-author">{attribution ? `From ${attribution.sender}` : 'You'}</div>
            <Markdown
              source={attribution
                ? message.text.replace(coordinationPrompt(attribution), attribution.text)
                : message.text}
            />
            {#if message.files?.length}<div class="message-files">
                {#each message.files as file, index (index)}<span
                    >{file.name ??
                      (file.source.type === 'uri' ? file.source.uri : 'Attachment')}</span
                  >{/each}
              </div>{/if}
          </div>
        </article>
      {:else if message.type === 'assistant'}
        {@const text = message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')}
        <article class="agent-message message assistant-message">
          <div class="avatar agent-avatar">S.</div>
          <div class="message-body">
            <div class="message-author">{message.agent}</div>
            {#if text}<Markdown source={text} />{/if}
            {#each message.content as part, ordinal (ordinal)}
              {#if part.type === 'tool'}
                {@const reason =
                  part.state.status === 'error' ? openCodeErrorDetails(part.state.error) : ''}
                {@const output =
                  part.state.status === 'completed' || part.state.status === 'error'
                    ? (part.state.content ?? [])
                        .map((item) => (item.type === 'text' ? item.text : (item.name ?? item.uri)))
                        .join('\n')
                    : ''}
                <ToolActivity
                  title={part.name}
                  status={part.state.status}
                  input={part.state.input}
                  {output}
                  error={reason}
                  source={part.state.status === 'error'
                    ? (reportedHookIdentity(part.state.metadata) ?? '')
                    : ''}
                  onfix={part.state.status === 'error'
                    ? () => fixToolFailure(part.name, part.state.input, reason, output)
                    : undefined}
                />
              {/if}
            {/each}
            {#if message.retry}<p class="retry-state" role="status">
                Retry {message.retry.attempt}: {message.retry.error.message}
              </p>{/if}
            {#if message.error}<p class="message-error" role="alert">
                {message.error.message}
              </p>{/if}
          </div>
        </article>
      {/if}
    {/each}
    {#each coordinationMessages.filter((message) => !messages.some((item) => item.type === 'user' && item.text.includes(coordinationPrompt(message)))) as message (message.id)}
      <article class="agent-message message user-message">
        <div class="avatar user-avatar">↗</div>
        <div class="message-body">
          <div class="message-author">
            From {message.sender}{message.delivered ? '' : ' · queued'}
          </div>
          <Markdown source={message.text} />
        </div>
      </article>
    {/each}
    <SpawnActivity receipts={spawnReceipts} />
    {#if running}<div class="agent-busy" role="status">
        OpenCode is working… <Button size="sm" variant="secondary" onclick={stop}>Stop</Button>
      </div>{/if}
  </div>
  <div class="agent-composer composer-wrap">
    <div class="composer">
      {#if error}<p class="agent-error" role="alert">{error}</p>{/if}
      <PromptPanel
        {pendingPermissions}
        {pendingForms}
        {client}
        sessionID={activeID}
        onchanged={async () => {
          if (activeID) await refreshRequests(activeID);
        }}
      />
      <textarea
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={skillMatches.length ? skillMenuId : undefined}
        aria-expanded={skillMatches.length > 0}
        aria-activedescendant={skillMatches.length
          ? `${skillMenuId}-option-${Math.min(skillSelected, skillMatches.length - 1)}`
          : undefined}
        bind:this={prompt}
        data-pane-prompt
        aria-label="Message OpenCode"
        bind:value={draft}
        onkeydown={keydown}
        rows="3"
        wrap="soft"
        placeholder="Message OpenCode…"
        disabled={!inputReady || loading}></textarea>
      <SkillMenu
        id={skillMenuId}
        skills={skillMatches}
        selected={skillSelected}
        choose={chooseSkill}
      />
      {#if files.length}<div class="attachments">
          {#each files as file (file)}<span
              >{file.split(/[\\/]/).at(-1)}<button
                aria-label={`Remove ${file.split(/[\\/]/).at(-1)}`}
                onclick={() => removeFile(file)}>×</button
              ></span
            >{/each}
        </div>{/if}
      <div class="agent-composer-footer">
        <div class="agent-picker-controls">
          <OptionPicker
            label="Agent"
            value={selectedAgent}
            options={agentChoices}
            open={pickerOpen === 'agent'}
            disabled={busy || !inputReady}
            onopen={() => (pickerOpen = 'agent')}
            onclose={() => (pickerOpen = null)}
            onchoose={(value) => void chooseConfig('agent', value)}
          />
          <OptionPicker
            label="Model"
            value={selectedModel}
            options={modelChoices}
            open={pickerOpen === 'model'}
            disabled={busy || !inputReady}
            onopen={() => (pickerOpen = 'model')}
            onclose={() => (pickerOpen = null)}
            onchoose={(value) => void chooseConfig('model', value)}
          />
          <OptionPicker
            label="Effort"
            value={selectedVariant}
            options={effortChoices}
            open={pickerOpen === 'effort'}
            disabled={busy || !inputReady}
            onopen={() => (pickerOpen = 'effort')}
            onclose={() => (pickerOpen = null)}
            onchoose={(value) => void chooseConfig('effort', value)}
          />
        </div>
        <div class="agent-actions">
          <Button variant="ghost" size="sm" onclick={attachFiles} disabled={sending || !inputReady}
            >Attach files</Button
          >
          <Button
            onclick={() => void send()}
            disabled={sending || (!draft.trim() && !files.length) || !inputReady}
            >{running ? 'Queue ↗' : 'Send ↗'}</Button
          >
        </div>
      </div>
    </div>
  </div>
</div>
<PathPicker
  open={filePickerOpen}
  title="Attach files"
  mode="files"
  initialPath={directory}
  onselect={(paths) => {
    files = [...new Set([...files, ...paths])];
    filePickerOpen = false;
  }}
  oncancel={() => (filePickerOpen = false)}
/>

<style>
  .opencode-pane {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
  .opencode-pane .agent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
  }
  .opencode-pane .agent-heading {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: baseline;
    gap: 12px;
  }
  .opencode-pane .agent-heading > span:not(.harness-icon) {
    overflow: hidden;
    opacity: 0.65;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .opencode-pane .agent-usage {
    flex: none;
    font-size: 11px;
    white-space: nowrap;
  }
  .opencode-pane .agent-conversation {
    flex: 1;
    min-height: 0;
    padding-inline: 20px;
  }
  .opencode-pane .agent-message {
    width: 100%;
  }
  .opencode-pane .agent-busy {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .opencode-pane .agent-welcome {
    max-width: 650px;
    margin: 15vh auto;
    text-align: center;
  }
  .opencode-pane .agent-composer-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0 9px 9px 10px;
  }
  .opencode-pane .agent-composer {
    position: relative;
    flex: 0 0 auto;
    padding-inline: 20px;
  }
  .opencode-pane .agent-composer textarea {
    width: 100%;
    resize: vertical;
    box-sizing: border-box;
    background: transparent;
    color: inherit;
    border: 0;
    outline: 0;
    padding: 15px 16px;
    font: inherit;
  }
  .opencode-pane .agent-error {
    color: var(--danger, #d66);
  }
  .opencode-pane .agent-picker-controls,
  .opencode-pane .agent-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
  }
</style>
