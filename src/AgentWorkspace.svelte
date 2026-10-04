<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { Badge, Button } from '@smykla-skalski/sui';
  import Markdown from './Markdown.svelte';
  import SpawnActivity from './SpawnActivity.svelte';
  import PostTurnChecks from './PostTurnChecks.svelte';
  import type { PostTurnCheck } from './lib/post-turn-checks';
  import SpawnResponse from './SpawnResponse.svelte';
  import ToolActivity from './ToolActivity.svelte';
  import { toolInput } from './lib/tool-display';
  import {
    acpToolFailure,
    prepareAcpFailureDraft,
    type AcpToolFailure,
  } from './lib/acp-tool-failure';
  import HarnessIcon from './HarnessIcon.svelte';
  import OptionPicker from './OptionPicker.svelte';
  import SkillMenu from './SkillMenu.svelte';
  import {
    matchingSkills,
    mergeSkills,
    resolveSkillPrompt,
    skillQuery,
    type SkillChoice,
  } from './lib/skills';
  import { bundledSkills } from './lib/bundled-skills';
  import {
    beginImplementationTurn,
    beginShipItRun,
    recordImplementationModel,
  } from './lib/implementation-models';
  import {
    agentQueuePaused,
    queuedAgentMessages,
    saveQueuedAgentMessages,
    setAgentQueuePaused,
    type QueuedAgentMessage,
  } from './lib/agent-queue';
  import {
    acp,
    groupAgentEntries,
    loadRecentTranscript,
    restoreEntryTimes,
    saveRecentTranscript,
    updateEntriesBatch,
    updateEntriesInPlace,
    type AgentEntry,
    type AgentTool,
    type AgentEvent,
    type AgentConfigOption,
    type AgentAuthMethod,
    type AgentId,
    type AgentPermission,
    type AgentThread,
  } from './lib/acp';
  import type { ThreadStatus } from './lib/attention';
  import type { AgentUsage } from './lib/agent-usage';
  import { withSpawnResponses, type SpawnReceipt } from './lib/agent-results';
  import type { BrowserAttachment } from './lib/browser-pick';
  import {
    clipboardFiles,
    insertClipboardText,
    removeClipboardFile,
    stageClipboardFile,
    stageClipboardImage,
  } from './lib/attachments';
  import {
    coordinationMessageForText,
    coordinationPrompt,
    type CoordinationMessage,
  } from './lib/coordination';
  import {
    isFailedStatus,
    notificationStats,
    splitTaskNotifications,
  } from './lib/task-notification';
  import { splitKlaudiushMessage, type KlaudiushRule } from './lib/klaudiush';
  import { getSetting, removeSetting, setSetting } from './lib/settings';
  import { recordDiagnostic, type DiagnosticEvent } from './lib/diagnostics';

  interface Props {
    agent: AgentId;
    agentName: string;
    directory: string;
    thread: AgentThread | null;
    usage?: AgentUsage;
    running: boolean;
    focused?: boolean;
    focusPrompt?: boolean;
    picked?: BrowserAttachment;
    onpickedconsumed?: (id: string) => void;
    prefill?: { id: string; text: string };
    onprefillconsumed?: (id: string) => void;
    externalPrompt?: { id: string; text: string };
    onexternalresult?: (id: string, failure: string | null) => void;
    onpromptfocused?: () => void;
    oncreated: (thread: AgentThread) => void;
    onactivity: (thread: AgentThread) => void;
    onstatus: (thread: AgentThread, status: ThreadStatus, notifyOnDone?: boolean) => void;
    onreplaychange?: (agent: AgentId, sessionId: string | null, replaying: boolean) => void;
    onterminal: (id: string) => void;
    onentrieschange?: (entries: AgentEntry[], sessionId: string | null, ready: boolean) => void;
    ephemeral?: boolean;
    seedContext?: string;
    coordinationMessages?: CoordinationMessage[];
    spawnReceipts?: SpawnReceipt[];
    postTurnChecks?: PostTurnCheck[];
    onretrycheck?: (check: PostTurnCheck) => void;
  }
  let {
    agent,
    agentName,
    directory,
    thread,
    usage,
    running,
    focused = true,
    focusPrompt = false,
    picked,
    onpickedconsumed,
    prefill,
    onprefillconsumed,
    externalPrompt,
    onexternalresult,
    onpromptfocused,
    oncreated,
    onactivity,
    onstatus,
    onreplaychange,
    onterminal,
    onentrieschange,
    ephemeral = false,
    seedContext = '',
    coordinationMessages = [],
    spawnReceipts = [],
    postTurnChecks = [],
    onretrycheck = () => {},
  }: Props = $props();
  let mounted = $state(false);
  let ready = $state(false);
  let busy = $state(false);
  let connecting = $state(false);
  let sessionWarmupAttempted = $state(false);
  function failedDraftKey() {
    return `sai-agent-failed-draft:${encodeURIComponent(directory)}:${agent}`;
  }
  let draft = $state('');
  let recoveredDraft = false;
  let recoveryEligible = false;
  let skills = $state<SkillChoice[]>(bundledSkills);
  const commandUpdates: Record<string, unknown[]> = {};
  let skillSelected = $state(0);
  const skillMenuId = crypto.randomUUID();
  const skillMatches = $derived(matchingSkills(skills, draft));
  $effect(() => {
    if (skillQuery(draft) !== null && ready && directory && !activeSessionId && !creatingSession)
      void ensureSession('New thread').catch((cause) => {
        error = describe(cause);
      });
  });
  let queued = $state<QueuedAgentMessage[]>([]);
  let queuePaused = $state(false);
  let steering = $state(false);
  function diagnostic(event: DiagnosticEvent, sessionId = activeSessionId, turnId = activeTurnId) {
    recordDiagnostic(event, {
      agent,
      sessionId,
      turnId,
      queueLength: queued.length,
    });
  }
  $effect(() => {
    if (isBusy || !ready || queuePaused || steering || !queued.length) return;
    const [next, ...remaining] = queued;
    queued = remaining;
    diagnostic('queue_dispatch_started');
    if (activeSessionId) saveQueuedAgentMessages(agent, directory, activeSessionId, queued);
    void send(next.text, next);
  });

  function updateSkills(value: unknown[]) {
    skills = mergeSkills(
      value
        .filter(
          (item): item is { name: string; description?: string } =>
            typeof item === 'object' &&
            item !== null &&
            'name' in item &&
            typeof item.name === 'string' &&
            (!('description' in item) || typeof item.description === 'string'),
        )
        .map((item) => ({
          name: item.name.replace(/^\//, ''),
          description: item.description ?? '',
        }))
        .filter((item) => item.name !== 'model' && item.name !== 'effort'),
      bundledSkills,
    );
  }

  function chooseSkill(skill: SkillChoice) {
    draft = `/${skill.name} `;
    skillSelected = 0;
    void tick().then(() => prompt.focus());
  }
  let images = $state<BrowserAttachment[]>([]);
  let clipboardAttachments = $state<{ path: string; name: string; image: boolean }[]>([]);
  let pendingPaste: Promise<void> = Promise.resolve();
  let lastPicked = '';
  let lastPrefill = '';
  let lastExternalPrompt = '';

  function removeImage(image: BrowserAttachment) {
    images = images.filter((item) => item.id !== image.id);
    draft = draft.replace(image.text, '').trim();
    void invoke('browser_remove_capture', { path: image.imagePath });
  }
  function removeClipboardAttachment(attachment: { path: string; image: boolean }) {
    clipboardAttachments = clipboardAttachments.filter((item) => item.path !== attachment.path);
    if (attachment.image) void invoke('browser_remove_capture', { path: attachment.path });
    else void removeClipboardFile(attachment.path);
  }

  async function pasteFiles(event: ClipboardEvent) {
    const files = clipboardFiles(event);
    if (!files.length) return;
    event.preventDefault();
    const pastedText = event.clipboardData?.getData('text/plain') ?? '';
    if (pastedText && event.target instanceof HTMLTextAreaElement) {
      const input = event.target;
      const caret = input.selectionStart + pastedText.length;
      draft = insertClipboardText(draft, pastedText, input.selectionStart, input.selectionEnd);
      void tick().then(() => input.setSelectionRange(caret, caret));
    }
    const current = generation;
    const staged = await Promise.all(
      files.map(async (file) => {
        const image = file.type.startsWith('image/');
        try {
          const path = image ? await stageClipboardImage(file) : await stageClipboardFile(file);
          return { path, name: file.name || 'image.png', image, failure: null };
        } catch (cause) {
          return { path: null, name: file.name, image, failure: describe(cause) };
        }
      }),
    );
    const stagedAttachments: { path: string; name: string; image: boolean }[] = [];
    for (const item of staged) {
      if (item.failure) error = `Could not paste ${item.name}: ${item.failure}`;
      else if (item.path) {
        if (current !== generation) {
          if (item.image) void invoke('browser_remove_capture', { path: item.path });
          else void removeClipboardFile(item.path);
        } else stagedAttachments.push({ path: item.path, name: item.name, image: item.image });
      }
    }
    clipboardAttachments = [...clipboardAttachments, ...stagedAttachments];
  }
  let error = $state('');
  let entries = $state.raw<AgentEntry[]>([]);
  let visibleCount = $state(50);
  let historyLoaded = $state(true);
  let historyLoading = $state(false);
  let historyAttempted = $state(false);
  let showingEarlier = false;
  const visibleEntries = $derived(entries.slice(-visibleCount));
  const displayEntries = $derived(
    withSpawnResponses(groupAgentEntries(visibleEntries), spawnReceipts, (entry) => entry.created),
  );
  const toolFailed = (tool: AgentTool) => /fail|error|reject/i.test(tool.status);
  const toolRunning = (tool: AgentTool) => /^(pending|in_progress|stopping)$/i.test(tool.status);
  let replaying = false;
  function setReplaying(value: boolean) {
    if (replaying === value) return;
    replaying = value;
    onreplaychange?.(agent, activeSessionId, value);
  }
  let replayEntries: AgentEntry[] = [];
  let pendingUpdates: Record<string, unknown>[] = [];
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const snapshot = entries;
    const available = ready;
    untrack(() => onentrieschange?.(snapshot, activeSessionId, available));
  });
  let permissions = $state<AgentPermission[]>([]);
  let configOptions = $state<AgentConfigOption[]>([]);
  let pickerOpen = $state<'model' | 'effort' | null>(null);
  let configPickerOpen = $state<string | null>(null);
  let creatingSession = $state<Promise<AgentThread> | null>(null);
  const claimedSessionCreations = new WeakSet<Promise<AgentThread>>();
  let settingConfig = $state<Promise<void> | null>(null);
  let configFailure = $state('');
  let authMethods = $state<AgentAuthMethod[]>([]);
  let authNeeded = $state(false);
  let authenticating = $state(false);
  let activeSessionId: string | null = null;
  let disposed = false;
  let stopRequested = false;
  let activeTurnId: string | null = null;
  let selectedThreadId: string | null = null;
  let generation = 0;
  let scroll: HTMLDivElement;
  let autoFollow = true;
  const spawnRevision = $derived(spawnReceipts.map((receipt) => receipt.updated).join(','));
  $effect(() => {
    if (spawnRevision && autoFollow) void follow();
  });
  let prompt: HTMLTextAreaElement;
  const preparedFailures = new Map<string, string>();
  const name = $derived(agentName);
  const isBusy = $derived(busy || running || historyLoading);

  $effect(() => {
    if (ready && !busy && !running && !historyLoaded && !historyAttempted) void loadHistory();
  });

  $effect(() => {
    if (ready && !thread && !activeSessionId && !sessionWarmupAttempted && !ephemeral) {
      sessionWarmupAttempted = true;
      const current = generation;
      void ensureSession('New thread').catch((cause) => {
        if (current !== generation || disposed) return;
        error = describe(cause);
        authNeeded = /auth|login|sign.?in/i.test(error);
      });
    }
  });
  const modelOption = $derived(
    configOptions.find(
      (option) => /model/i.test(`${option.id} ${option.name}`) && option.type === 'select',
    ),
  );
  const effortOption = $derived(
    configOptions.find(
      (option) =>
        /effort|reasoning|thinking/i.test(`${option.id} ${option.name}`) &&
        option.type === 'select',
    ),
  );

  $effect(() => {
    if (isBusy) {
      pickerOpen = null;
      configPickerOpen = null;
    }
  });

  async function focusPromptWhenReady() {
    await tick();
    if (!focusPrompt || !focused || isBusy || activeSessionId !== (thread?.sessionId ?? null))
      return;
    prompt.focus();
    onpromptfocused?.();
  }

  $effect(() => {
    if (focusPrompt && focused && !isBusy) void focusPromptWhenReady();
  });

  $effect(() => {
    if (!picked || picked.id === lastPicked) return;
    lastPicked = picked.id;
    images = [...images, picked];
    draft = [draft.trim(), picked.text].filter(Boolean).join('\n\n');
    onpickedconsumed?.(picked.id);
    void focusPromptWhenReady();
  });

  $effect(() => {
    if (!prefill || prefill.id === lastPrefill) return;
    lastPrefill = prefill.id;
    draft = [draft.trim(), prefill.text].filter(Boolean).join('\n\n');
    onprefillconsumed?.(prefill.id);
    void focusPromptWhenReady();
  });

  $effect(() => {
    if (!externalPrompt || externalPrompt.id === lastExternalPrompt) return;
    if (!ready) {
      if (mounted && !connecting && error) {
        lastExternalPrompt = externalPrompt.id;
        onexternalresult?.(externalPrompt.id, error);
      }
      return;
    }
    const request = externalPrompt;
    lastExternalPrompt = request.id;
    void send(request.text).then(
      () => onexternalresult?.(request.id, null),
      (cause) => onexternalresult?.(request.id, describe(cause)),
    );
  });

  function describe(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }

  function prepareFailure(tool: AgentTool, failure: AcpToolFailure) {
    draft = prepareAcpFailureDraft(
      draft,
      preparedFailures,
      `${activeSessionId}:${tool.id}`,
      failure,
    );
    void tick().then(() => prompt.focus());
  }

  function flushUpdates() {
    clearTimeout(updateTimer);
    updateTimer = undefined;
    if (!pendingUpdates.length) return;
    const next = updateEntriesBatch(entries, pendingUpdates, Date.now());
    pendingUpdates = [];
    entries = next;
    if (autoFollow) void follow();
  }

  function applyUpdate(update: Record<string, unknown>) {
    if (replaying) {
      updateEntriesInPlace(replayEntries, update);
      return;
    }
    pendingUpdates.push(update);
    if (!updateTimer) updateTimer = setTimeout(flushUpdates, 50);
  }

  function rememberTranscript() {
    if (!activeSessionId || ephemeral) return;
    flushUpdates();
    saveRecentTranscript(
      {
        agent,
        directory,
        sessionId: activeSessionId,
        title: thread?.title ?? '',
        updated: Date.now(),
      },
      entries,
    );
  }

  async function showEarlier() {
    if (showingEarlier || entries.length <= visibleCount) return;
    showingEarlier = true;
    const height = scroll.scrollHeight;
    const top = scroll.scrollTop;
    const current = generation;
    visibleCount += 50;
    await tick();
    if (current !== generation) {
      showingEarlier = false;
      return;
    }
    scroll.scrollTop = top + scroll.scrollHeight - height;
    showingEarlier = false;
    if (scroll.scrollHeight <= scroll.clientHeight && entries.length > visibleCount)
      void showEarlier();
  }

  async function loadHistory() {
    const id = activeSessionId;
    if (!id || historyLoading || !ready || busy || running || historyAttempted) return;
    const current = generation;
    historyAttempted = true;
    historyLoading = true;
    setReplaying(true);
    replayEntries = [];
    try {
      await acp.load(agent, directory, id);
      if (current !== generation) return;
      entries = restoreEntryTimes(replayEntries, entries);
      visibleCount = 50;
      historyLoaded = true;
      rememberTranscript();
      void follow();
      await tick();
      if (
        current === generation &&
        scroll.scrollHeight <= scroll.clientHeight &&
        entries.length > visibleCount
      )
        void showEarlier();
    } catch (cause) {
      if (current === generation) error = describe(cause);
    } finally {
      if (current === generation) {
        setReplaying(false);
        replayEntries = [];
        historyLoading = false;
      }
    }
  }

  function markTools(status: string, from: readonly string[]) {
    flushUpdates();
    entries = entries.map((entry) =>
      entry.type === 'tool' && from.includes(entry.status)
        ? Object.assign({}, entry, { status })
        : entry,
    );
  }

  async function follow() {
    await tick();
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  function queuePermission(message: AgentEvent['message']) {
    const params = message.params;
    if (!params || params.sessionId !== activeSessionId || message.id == null) return;
    if (permissions.some((permission) => String(permission.id) === String(message.id))) return;
    const tool = params.toolCall;
    const title =
      tool && typeof tool === 'object' && 'title' in tool && typeof tool.title === 'string'
        ? tool.title
        : 'Allow agent action?';
    const options = Array.isArray(params.options)
      ? params.options.filter(
          (option): option is AgentPermission['options'][number] =>
            typeof option === 'object' &&
            option !== null &&
            typeof option.optionId === 'string' &&
            typeof option.name === 'string' &&
            typeof option.kind === 'string',
        )
      : [];
    permissions = [...permissions, { id: message.id, sessionId: activeSessionId!, title, options }];
    if (thread) onstatus(thread, 'waiting');
  }

  async function activate(id: string | null) {
    rememberTranscript();
    const previousSessionId = activeSessionId;
    if (id && id !== previousSessionId) recoveryEligible = false;
    const previousQueue = queued;
    const wasPaused = queuePaused;
    const current = ++generation;
    clearTimeout(updateTimer);
    updateTimer = undefined;
    pendingUpdates = [];
    setReplaying(false);
    replayEntries = [];
    permissions = [];
    selectedThreadId = id;
    activeSessionId = id;
    entries = id && thread ? loadRecentTranscript(thread) : [];
    visibleCount = 50;
    historyLoaded = !id;
    historyLoading = false;
    historyAttempted = false;
    configOptions = [];
    skills = bundledSkills;
    queued =
      id && id === previousSessionId
        ? previousQueue
        : id
          ? queuedAgentMessages(agent, directory, id)
          : [];
    queuePaused =
      id && id === previousSessionId
        ? wasPaused
        : id
          ? agentQueuePaused(agent, directory, id)
          : false;
    pickerOpen = null;
    creatingSession = null;
    sessionWarmupAttempted = false;
    settingConfig = null;
    configFailure = '';
    authNeeded = false;
    busy = false;
    stopRequested = false;
    activeTurnId = null;
    error = '';
    ready = false;
    connecting = true;
    try {
      const info = await acp.connect(agent);
      if (current !== generation) return;
      authMethods = (info.authMethods as AgentAuthMethod[] | undefined) ?? [];
      if (id) {
        const capabilities = info.agentCapabilities;
        const canLoad =
          capabilities && typeof capabilities === 'object' && 'loadSession' in capabilities
            ? capabilities.loadSession
            : false;
        if (!canLoad) throw new Error(`${name} does not support restoring threads.`);
        const sessionCapabilities =
          capabilities && typeof capabilities === 'object' && 'sessionCapabilities' in capabilities
            ? capabilities.sessionCapabilities
            : null;
        const canResume =
          sessionCapabilities &&
          typeof sessionCapabilities === 'object' &&
          'resume' in sessionCapabilities;
        if (!canResume) {
          setReplaying(true);
          replayEntries = [];
        }
        const session = canResume
          ? await acp.resume(agent, directory, id)
          : await acp.load(agent, directory, id);
        if (current === generation && !canResume) {
          entries = replayEntries;
          setReplaying(false);
          replayEntries = [];
          historyLoaded = true;
          rememberTranscript();
        }
        if (current === generation) {
          configOptions = (session.configOptions as AgentConfigOption[] | undefined) ?? [];
          const selectedModel = configOptions.find(
            (option) => option.type === 'select' && /model/i.test(`${option.id} ${option.name}`),
          )?.currentValue;
          if (thread && selectedModel) onactivity({ ...thread, model: selectedModel });
        }
        if (current === generation && Array.isArray(session.availableCommands))
          updateSkills(session.availableCommands);
        if (current === generation && commandUpdates[id]) updateSkills(commandUpdates[id]);
        const waiting = await acp.pendingPermissions(agent, id);
        if (current === generation) for (const request of waiting) queuePermission(request);
      }
      if (current === generation) ready = true;
    } catch (cause) {
      if (current === generation) {
        error = describe(cause);
        setReplaying(false);
        authNeeded = /auth|login|sign.?in/i.test(error);
        if (thread) onstatus(thread, 'failed');
      }
    } finally {
      if (current === generation) connecting = false;
    }
    if (current === generation) {
      await follow();
      if (scroll.scrollHeight <= scroll.clientHeight && entries.length > visibleCount)
        void showEarlier();
    }
  }

  $effect(() => {
    const id = thread?.sessionId ?? null;
    if (mounted && selectedThreadId !== id) void activate(id);
  });

  async function ensureSession(title: string, forTurn = false): Promise<AgentThread> {
    if (activeSessionId) {
      return thread ?? { agent, sessionId: activeSessionId, directory, title, updated: Date.now() };
    }
    if (creatingSession) {
      if (forTurn) claimedSessionCreations.add(creatingSession);
      return creatingSession;
    }
    const current = generation;
    const sessionAgent = agent;
    const sessionDirectory = directory;
    let task!: Promise<AgentThread>;
    task = (async () => {
      const session = await acp.create(sessionAgent, sessionDirectory);
      const created: AgentThread = {
        agent: sessionAgent,
        model: session.configOptions?.find(
          (option) => option.type === 'select' && /model/i.test(`${option.id} ${option.name}`),
        )?.currentValue,
        sessionId: session.sessionId,
        directory: sessionDirectory,
        title,
        updated: Date.now(),
      };
      if (current !== generation) {
        if (ephemeral) await acp.cancel(sessionAgent, session.sessionId, null).catch(() => {});
        if (!disposed || !claimedSessionCreations.has(task))
          throw new Error('Agent pane closed while creating the thread.');
        await invoke('validate_repository', { path: sessionDirectory });
        if (queued.length)
          saveQueuedAgentMessages(sessionAgent, sessionDirectory, session.sessionId, queued);
        onactivity(created);
        return created;
      }
      configOptions = session.configOptions ?? [];
      if (Array.isArray(session.availableCommands)) updateSkills(session.availableCommands);
      activeSessionId = session.sessionId;
      if (queued.length) saveQueuedAgentMessages(agent, directory, session.sessionId, queued);
      if (commandUpdates[session.sessionId]) updateSkills(commandUpdates[session.sessionId]);
      selectedThreadId = session.sessionId;
      oncreated(created);
      return created;
    })();
    creatingSession = task;
    if (forTurn) claimedSessionCreations.add(task);
    try {
      return await task;
    } finally {
      claimedSessionCreations.delete(task);
      if (creatingSession === task) creatingSession = null;
    }
  }

  async function openPicker(kind: 'model' | 'effort') {
    if (!ready || !directory || isBusy) return;
    configPickerOpen = null;
    pickerOpen = kind;
    if (activeSessionId) return;
    try {
      await ensureSession('New thread');
    } catch (cause) {
      error = describe(cause);
      authNeeded = /auth|login|sign.?in/i.test(error);
    }
  }

  onMount(() => {
    recoveryEligible = !thread && !ephemeral;
    if (recoveryEligible) {
      const recovered = getSetting(failedDraftKey());
      if (recovered !== null) {
        removeSetting(failedDraftKey());
        draft = recovered;
        recoveredDraft = true;
      }
    }
    window.addEventListener('sai-agent-failed-draft', restoreFailedDraft);
    let unlisten: (() => void) | undefined;
    void listen<AgentEvent>('acp-event', ({ payload }) => {
      if (disposed || payload.agent !== agent) return;
      const { message } = payload;
      if (message.method === 'sail/disconnected') {
        inFlightSteer?.finish();
        ready = false;
        busy = false;
        if (thread) onstatus(thread, 'failed');
        error = `${name} stopped. Reopen the thread to reconnect.`;
        return;
      }
      const params = message.params;
      if (message.method === 'session/update' && typeof params?.sessionId === 'string') {
        const update = params.update;
        if (
          update &&
          typeof update === 'object' &&
          'sessionUpdate' in update &&
          update.sessionUpdate === 'available_commands_update' &&
          'availableCommands' in update &&
          Array.isArray(update.availableCommands)
        )
          commandUpdates[params.sessionId] = update.availableCommands;
      }
      if (message.method === 'sail/prompt_finished' && typeof params?.sessionId === 'string') {
        discardSteeredAttachments(params.sessionId);
        const steer = inFlightSteer;
        if (
          steer?.sessionId === params.sessionId &&
          (!steer.turnId || steer.turnId === params.turnId)
        )
          steer.finish();
      }
      if (!params || params.sessionId !== activeSessionId) return;
      if (message.method === 'sail/permission_resolved') {
        permissions = permissions.filter(
          (permission) => String(permission.id) !== String(params.requestId),
        );
        if (thread && running && permissions.length === 0) onstatus(thread, 'working');
      } else if (message.method === 'session/update') {
        const update = params.update;
        if (!update || typeof update !== 'object') return;
        const data = update as Record<string, unknown>;
        if (data.sessionUpdate === 'config_option_update' && Array.isArray(data.configOptions)) {
          configOptions = data.configOptions as AgentConfigOption[];
          const selectedModel = configOptions.find(
            (option) => option.type === 'select' && /model/i.test(`${option.id} ${option.name}`),
          )?.currentValue;
          if (thread && selectedModel) onactivity({ ...thread, model: selectedModel });
        }
        if (
          data.sessionUpdate === 'available_commands_update' &&
          Array.isArray(data.availableCommands)
        )
          updateSkills(data.availableCommands);
        if (data.sessionUpdate !== 'user_message_chunk' || replaying) applyUpdate(data);
        if (
          data.sessionUpdate === 'tool_call_update' &&
          (data.status === 'completed' || data.status === 'failed')
        )
          void steerQueued();
      } else if (message.method === 'session/request_permission' && message.id != null) {
        queuePermission(message);
      }
    })
      .then((unsubscribe) => {
        if (disposed) unsubscribe();
        else unlisten = unsubscribe;
        if (!disposed) {
          selectedThreadId = thread?.sessionId ?? null;
          mounted = true;
          void activate(selectedThreadId);
        }
        return undefined;
      })
      .catch((cause) => {
        if (!disposed) error = `Could not subscribe to agent events: ${describe(cause)}`;
      });
    return () => {
      disposed = true;
      window.removeEventListener('sai-agent-failed-draft', restoreFailedDraft);
      if (recoveredDraft && !busy) {
        const pending = getSetting(failedDraftKey());
        if (draft.trim())
          setSetting(failedDraftKey(), [pending, draft].filter(Boolean).join('\n\n'));
      }
      setReplaying(false);
      rememberTranscript();
      generation++;
      clearTimeout(updateTimer);
      unlisten?.();
      if (ephemeral && activeSessionId) {
        void acp.cancel(agent, activeSessionId, activeTurnId).catch(() => {});
        for (const permission of permissions)
          void acp.permission(agent, permission.id, null).catch(() => {});
      }
      images.forEach((image) => void invoke('browser_remove_capture', { path: image.imagePath }));
      clipboardAttachments.forEach((attachment) => removeClipboardAttachment(attachment));
    };
  });

  async function send(externalText?: string, queuedMessage?: QueuedAgentMessage) {
    if (externalText === undefined) await pendingPaste;
    const external = externalText !== undefined;
    const text =
      (externalText ?? draft).trim() ||
      (!external && clipboardAttachments.length ? 'Please review the attachments.' : '');
    try {
      beginShipItRun(directory, text);
    } catch (cause) {
      error = describe(cause);
      return;
    }
    const command = text.toLowerCase();
    if (
      !external &&
      !clipboardAttachments.length &&
      !isBusy &&
      ready &&
      directory &&
      (command === '/model' || command === '/effort')
    ) {
      draft = '';
      await openPicker(command.slice(1) as 'model' | 'effort');
      return;
    }
    if (!external && isBusy && (text || clipboardAttachments.length)) {
      queued = [...queued, { text, images: [...images], attachments: [...clipboardAttachments] }];
      diagnostic('message_queued');
      if (activeSessionId) saveQueuedAgentMessages(agent, directory, activeSessionId, queued);
      draft = '';
      images = [];
      clipboardAttachments = [];
      return;
    }
    if ((!text && (external || !clipboardAttachments.length)) || !ready || isBusy || !directory) {
      if (external) throw new Error('Wait for the current agent turn.');
      return;
    }
    const sentImages = queuedMessage?.images ?? (external ? [] : [...images]);
    const sentClipboard = queuedMessage?.attachments ?? (external ? [] : [...clipboardAttachments]);
    const turnAgent = agent;
    const turnDirectory = directory;
    recoveryEligible = false;
    const current = generation;
    const turnId = crypto.randomUUID();
    activeTurnId = turnId;
    let activityThread = thread;
    let finalStatus: ThreadStatus = 'done';
    let notifyOnDone = true;
    let keepImages = false;
    let phase: 'session' | 'config' | 'snapshot' | 'prompt' = 'session';
    let deliverySessionId = activeSessionId;
    busy = true;
    if (activityThread) onstatus(activityThread, 'working');
    stopRequested = false;
    error = '';
    if (!external) {
      draft = '';
      images = [];
      clipboardAttachments = [];
    }
    const userEntryId = crypto.randomUUID();
    flushUpdates();
    entries = [...entries, { id: userEntryId, type: 'user', text, created: Date.now() }];
    void follow();
    try {
      if (!activeSessionId || !activityThread)
        activityThread = await ensureSession(text.slice(0, 60) || 'Attached files', true);
      if (activityThread?.title === 'New thread')
        activityThread = { ...activityThread, title: text.slice(0, 60) || 'Attached files' };
      if (current !== generation && (!disposed || ephemeral)) return;
      if (activityThread) onstatus(activityThread, 'working');
      phase = 'config';
      if (settingConfig) await settingConfig;
      if (configFailure) throw new Error(configFailure);
      if (activityThread)
        onactivity({ ...activityThread, model: modelOption?.currentValue || activityThread.model });
      const id = activityThread?.sessionId ?? activeSessionId;
      deliverySessionId = id;
      if (stopRequested) {
        notifyOnDone = false;
        if (external && !queuedMessage) throw new Error('Agent turn was cancelled.');
        if (current === generation) {
          entries = entries.filter((entry) => entry.id !== userEntryId);
          draft = [text, draft.trim()].filter(Boolean).join('\n\n');
          images = [...sentImages, ...images];
          clipboardAttachments = [...sentClipboard, ...clipboardAttachments];
          keepImages = true;
        }
        return;
      }
      if (!ephemeral) {
        phase = 'snapshot';
        await invoke('record_turn_snapshot', {
          path: turnDirectory,
          thread: `acp:${turnAgent}:${id}`,
        });
      }
      const skillText = resolveSkillPrompt(skills, text, modelOption?.currentValue || undefined);
      const implementationModel = modelOption?.currentValue;
      const tracking = await beginImplementationTurn(turnDirectory, implementationModel);
      const promptText =
        ephemeral && seedContext && entries.length === 1
          ? `Read-only context from the parent thread:\n${seedContext}\n\nSide question: ${skillText}`
          : skillText;
      phase = 'prompt';
      let result;
      try {
        result = await acp.prompt(
          turnAgent,
          id!,
          withAttachedFiles(promptText, sentClipboard),
          turnId,
          promptImagePaths(sentImages, sentClipboard),
        );
        await recordImplementationModel(turnDirectory, implementationModel, tracking);
      } catch (cause) {
        await recordImplementationModel(turnDirectory, implementationModel, tracking);
        throw cause;
      }
      if (recoveredDraft && result.stopReason !== 'cancelled' && !stopRequested)
        recoveredDraft = false;
      if (result.stopReason === 'cancelled' || stopRequested) notifyOnDone = false;
      if (external && !queuedMessage && !notifyOnDone) throw new Error('Agent turn was cancelled.');
      if (current === generation && stopRequested)
        markTools(result.stopReason === 'cancelled' ? 'cancelled' : 'status unconfirmed', [
          'pending',
          'in_progress',
          'stopping',
        ]);
      if (activityThread) onactivity({ ...activityThread, updated: Date.now() });
    } catch (cause) {
      finalStatus = 'failed';
      if (!deliverySessionId && current !== generation && disposed && !ephemeral && !external) {
        const recovered =
          sentImages.length || sentClipboard.length
            ? `${text}\n\nAttachments need to be added again before sending.`
            : text;
        setSetting(failedDraftKey(), recovered);
        window.dispatchEvent(
          new CustomEvent('sai-agent-failed-draft', {
            detail: { key: failedDraftKey(), text: recovered },
          }),
        );
      }
      const following = deliverySessionId
        ? queuedAgentMessages(turnAgent, turnDirectory, deliverySessionId)
        : [];
      const steer =
        deliverySessionId && inFlightSteer?.sessionId === deliverySessionId ? inFlightSteer : null;
      const retryQueued =
        !!deliverySessionId &&
        (queuedMessage !== undefined ||
          following.length > 0 ||
          steer !== null ||
          (current !== generation && disposed));
      if (retryQueued && deliverySessionId) {
        if (recoveredDraft) {
          recoveredDraft = false;
        }
        const retry = { text, images: sentImages, attachments: sentClipboard };
        if (steer) steer.requeued = true;
        const messages = [retry, ...(steer ? [steer.message] : []), ...following];
        saveQueuedAgentMessages(turnAgent, turnDirectory, deliverySessionId, messages);
        setAgentQueuePaused(turnAgent, turnDirectory, deliverySessionId, true);
        recordDiagnostic('queue_paused', {
          agent: turnAgent,
          sessionId: deliverySessionId,
          turnId,
          queueLength: messages.length,
        });
        keepImages = true;
        if (current === generation && activeSessionId === deliverySessionId) {
          queued = messages;
          queuePaused = true;
        }
      }
      if (current === generation) {
        recordDiagnostic('turn_failed', {
          agent: turnAgent,
          sessionId: deliverySessionId,
          turnId,
          queueLength: queued.length,
          errorName: cause instanceof Error ? cause.name : typeof cause,
          phase,
        });
        error = describe(cause);
        authNeeded = /auth|login|sign.?in/i.test(error);
        if (retryQueued) {
          entries = entries.filter((entry) => entry.id !== userEntryId);
        } else if (!external || queuedMessage) {
          entries = entries.filter((entry) => entry.id !== userEntryId);
          draft = [text, draft.trim()].filter(Boolean).join('\n\n');
          images = [...sentImages, ...images];
          clipboardAttachments = [...sentClipboard, ...clipboardAttachments];
          keepImages = true;
        }
        if (stopRequested) markTools('status unconfirmed', ['stopping']);
      }
      if (external && !queuedMessage) throw cause;
    } finally {
      if (inFlightSteer?.sessionId === deliverySessionId && inFlightSteer.turnId === turnId)
        inFlightSteer.finish();
      if (current === generation) rememberTranscript();
      if (!keepImages) discardAttachments(sentImages, sentClipboard);
      if (deliverySessionId) discardSteeredAttachments(deliverySessionId);
      if (activeTurnId === turnId) activeTurnId = null;
      if (activityThread) onstatus(activityThread, finalStatus, notifyOnDone);
      if (current === generation) busy = false;
      if (
        current === generation &&
        !external &&
        finalStatus === 'done' &&
        deliverySessionId &&
        deliverySessionId === activeSessionId &&
        queuePaused
      ) {
        queuePaused = false;
        setAgentQueuePaused(turnAgent, turnDirectory, deliverySessionId, false);
      }
    }
  }

  function withAttachedFiles(text: string, attachments: QueuedAgentMessage['attachments']) {
    const filePaths = attachments.filter((item) => !item.image).map((item) => item.path);
    return filePaths.length
      ? `${text}\n\nAttached files (read these paths):\n${filePaths.join('\n')}`
      : text;
  }

  function promptImagePaths(
    sentImages: BrowserAttachment[],
    attachments: QueuedAgentMessage['attachments'],
  ) {
    return [
      ...sentImages.map((item) => item.imagePath),
      ...attachments.filter((item) => item.image).map((item) => item.path),
    ];
  }

  function discardAttachments(
    sentImages: BrowserAttachment[],
    attachments: QueuedAgentMessage['attachments'],
  ) {
    sentImages.forEach((image) => void invoke('browser_remove_capture', { path: image.imagePath }));
    attachments.forEach((attachment) => {
      if (attachment.image) void invoke('browser_remove_capture', { path: attachment.path });
      else void removeClipboardFile(attachment.path);
    });
  }

  const steeredAttachments = new SvelteMap<string, QueuedAgentMessage[]>();
  let inFlightSteer: {
    sessionId: string;
    turnId: string | null;
    message: QueuedAgentMessage;
    requeued: boolean;
    finish: () => void;
  } | null = null;
  let steerBlockedTurn: string | null = null;

  function discardSteeredAttachments(sessionId: string) {
    for (const message of steeredAttachments.get(sessionId) ?? [])
      discardAttachments(message.images, message.attachments);
    steeredAttachments.delete(sessionId);
  }

  function toolsStillRunning() {
    flushUpdates();
    const turnStart = entries.findLastIndex((entry) => entry.type === 'user');
    return entries
      .slice(turnStart + 1)
      .some(
        (entry) =>
          entry.type === 'tool' && (entry.status === 'pending' || entry.status === 'in_progress'),
      );
  }

  async function steerQueued() {
    const sessionId = activeSessionId;
    const turnKey = activeTurnId ?? sessionId;
    if (steering || !isBusy || stopRequested || queuePaused || !queued.length) return;
    if (!sessionId || steerBlockedTurn === turnKey || toolsStillRunning()) return;
    const turnAgent = agent;
    const turnDirectory = directory;
    const current = generation;
    const [next, ...remaining] = queued;
    const entryId = crypto.randomUUID();
    flushUpdates();
    entries = [...entries, { id: entryId, type: 'user', text: next.text, created: Date.now() }];
    rememberTranscript();
    queued = remaining;
    saveQueuedAgentMessages(turnAgent, turnDirectory, sessionId, queued);
    let finish!: () => void;
    const completed = new Promise<{ outcome: 'finished' }>((resolve) => {
      finish = () => resolve({ outcome: 'finished' });
    });
    const steer = { sessionId, turnId: activeTurnId, message: next, requeued: false, finish };
    inFlightSteer = steer;
    steering = true;
    const request = acp
      .steer(
        turnAgent,
        sessionId,
        withAttachedFiles(
          resolveSkillPrompt(skills, next.text, modelOption?.currentValue || undefined),
          next.attachments,
        ),
        promptImagePaths(next.images, next.attachments),
      )
      .catch(() => ({ outcome: 'failed' as const }));
    const { outcome } = await Promise.race([request, completed]);
    inFlightSteer = null;
    const delivered = outcome === 'injected' || outcome === 'startedNewTurn';
    const sameSession = activeSessionId === sessionId;
    if (delivered) {
      steeredAttachments.set(sessionId, [...(steeredAttachments.get(sessionId) ?? []), next]);
      if (current === generation && sameSession) void follow();
    } else {
      steerBlockedTurn = turnKey;
      if (current === generation && sameSession) {
        flushUpdates();
        entries = entries.filter((entry) => entry.id !== entryId);
        rememberTranscript();
      } else if (!ephemeral) {
        const origin = {
          agent: turnAgent,
          directory: turnDirectory,
          sessionId,
          title: '',
          updated: Date.now(),
        };
        saveRecentTranscript(
          origin,
          loadRecentTranscript(origin).filter((entry) => entry.id !== entryId),
        );
      }
    }
    if (steer.requeued === delivered) {
      const stored = queuedAgentMessages(turnAgent, turnDirectory, sessionId);
      const restored = delivered ? stored.filter((message) => message !== next) : [next, ...stored];
      saveQueuedAgentMessages(turnAgent, turnDirectory, sessionId, restored);
      if (sameSession) queued = restored;
    }
    steering = false;
    if (delivered && current === generation && sameSession) void steerQueued();
  }

  function retryQueue() {
    if (!activeSessionId || !ready || isBusy || !queued.length) return;
    queuePaused = false;
    setAgentQueuePaused(agent, directory, activeSessionId, false);
  }

  async function stop() {
    stopRequested = true;
    diagnostic('stop_requested');
    if (!activeSessionId) return;
    const current = generation;
    const sessionId = activeSessionId;
    const pending = permissions;
    try {
      await acp.cancel(agent, sessionId, activeTurnId);
      await Promise.all(pending.map((permission) => acp.permission(agent, permission.id, null)));
      if (current !== generation || activeSessionId !== sessionId) return;
      permissions = [];
      markTools('stopping', ['pending', 'in_progress']);
    } catch (cause) {
      if (current === generation && activeSessionId === sessionId) error = describe(cause);
    }
  }

  async function answer(permission: AgentPermission, optionId: string) {
    const lastRequest = permissions.length === 1 && permissions[0]?.id === permission.id;
    if (thread && lastRequest) onstatus(thread, 'working');
    try {
      await acp.permission(agent, permission.id, optionId);
      permissions = permissions.filter((item) => item.id !== permission.id);
    } catch (cause) {
      error = describe(cause);
      if (thread && lastRequest) {
        const pending = await acp.pendingPermissions(agent, permission.sessionId).catch(() => []);
        if (pending.some((message) => message.id === permission.id)) onstatus(thread, 'waiting');
      }
    }
  }

  function setConfig(configId: string, value: string) {
    if (!activeSessionId || isBusy) return;
    configFailure = '';
    const sessionId = activeSessionId;
    const previous = settingConfig;
    const task = (async () => {
      if (previous) await previous;
      try {
        const result = await acp.setConfig(agent, sessionId, configId, value);
        if (activeSessionId !== sessionId) return;
        configFailure = '';
        error = '';
        configOptions =
          result.configOptions ??
          configOptions.map((option) =>
            option.id === configId ? Object.assign({}, option, { currentValue: value }) : option,
          );
        const selectedModel = configOptions.find(
          (option) => option.type === 'select' && /model/i.test(`${option.id} ${option.name}`),
        )?.currentValue;
        if (thread && selectedModel) onactivity({ ...thread, model: selectedModel });
      } catch (cause) {
        if (activeSessionId !== sessionId) return;
        configFailure = describe(cause);
        error = configFailure;
      }
    })();
    settingConfig = task;
    void task.finally(() => {
      if (settingConfig === task) settingConfig = null;
    });
  }

  function restoreFailedDraft(event: Event) {
    const detail = (event as CustomEvent<{ key: string; text: string }>).detail;
    if (
      disposed ||
      !recoveryEligible ||
      busy ||
      detail.key !== failedDraftKey() ||
      getSetting(detail.key) !== detail.text
    )
      return;
    removeSetting(detail.key);
    draft = [draft.trim(), detail.text].filter(Boolean).join('\n\n');
    recoveredDraft = true;
  }

  async function authenticate(methodId: string) {
    authenticating = true;
    error = '';
    try {
      await acp.authenticate(agent, methodId);
      authNeeded = false;
      if (activeSessionId) await activate(activeSessionId);
      else if (pickerOpen) await ensureSession('New thread');
      else {
        ready = true;
        sessionWarmupAttempted = false;
      }
    } catch (cause) {
      error = describe(cause);
    } finally {
      authenticating = false;
    }
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
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  function keydownWorkspace(event: KeyboardEvent) {
    if (
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      !isBusy ||
      !focused ||
      document.querySelector('dialog[open]')
    )
      return;
    event.preventDefault();
    diagnostic('escape_cancel');
    void stop();
  }
</script>

<svelte:window onkeydown={keydownWorkspace} />
<div class="agent-workspace">
  <div class="agent-header">
    <div class="agent-heading">
      <HarnessIcon {agent} /><strong>{name}</strong><span>{thread?.title ?? 'New thread'}</span>
    </div>
    {#if usage?.context !== undefined}<span class="agent-usage">Context {usage.context}%</span>{/if}
    {#each usage?.rates ?? [] as rate (rate.label)}<span class="agent-usage"
        >{rate.label} {rate.remaining}% left</span
      >{/each}
    <div class="agent-config">
      {#each configOptions.filter((option) => option.type === 'select' && Array.isArray(option.options) && option.id !== modelOption?.id && option.id !== effortOption?.id) as option (option.id)}
        <OptionPicker
          label={option.name}
          value={option.currentValue}
          options={option.options ?? []}
          open={configPickerOpen === option.id}
          disabled={isBusy}
          onopen={() => {
            pickerOpen = null;
            configPickerOpen = option.id;
          }}
          onclose={() => (configPickerOpen = null)}
          onchoose={(value) => void setConfig(option.id, value)}
        />
      {/each}
    </div>
    <Badge tone={isBusy ? 'warning' : ready ? 'success' : 'neutral'}
      >{connecting ? 'Connecting' : isBusy ? 'Working' : ready ? 'Ready' : 'Offline'}</Badge
    >
  </div>
  <div
    class="agent-conversation conversation"
    bind:this={scroll}
    onscroll={() => {
      autoFollow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
      if (scroll.scrollTop <= 80 && !historyLoading) void showEarlier();
    }}
    aria-label={`${name} conversation`}
  >
    {#if entries.length === 0 && !connecting && !historyLoading}
      <div class="agent-welcome">
        <h1>Work with {name}</h1>
        <p>Describe the work. Sail will show messages, tools, and approvals here.</p>
      </div>
    {/if}
    {#if historyLoading}<div class="agent-history-status" role="status">Loading history…</div>{/if}
    {#snippet hookNotice(rules: KlaudiushRule[])}
      <div class="agent-hook-notice">
        <strong>Action blocked by hook</strong>
        <ul>
          {#each rules as rule (rule.code)}
            <li><code>{rule.code}</code> {rule.reason}</li>
          {/each}
        </ul>
      </div>
    {/snippet}
    {#snippet toolRow(tool: AgentTool, revealed: boolean)}
      <ToolActivity
        title={tool.title}
        status={tool.status}
        input={tool.input}
        output={tool.content || toolInput(tool.output)}
        expanded={revealed}
      >
        {#each tool.terminalIds as terminalId (terminalId)}
          <button onclick={() => onterminal(terminalId)}>Open terminal</button>
        {/each}
      </ToolActivity>
    {/snippet}
    {#snippet failureCard(tool: AgentTool)}
      {@const failure = acpToolFailure(tool)}
      {#if failure}
        {@const label =
          failure.kind === 'post-hook'
            ? 'Post-action hook failed'
            : failure.kind === 'hook'
              ? 'Action blocked by hook'
              : 'Tool failure'}
        <div class="agent-tool-failure" role="group" aria-label={label}>
          <strong>{label}</strong>
          <div><span>Action:</span> <code>{failure.action}</code></div>
          {#if failure.rule}<div><span>Rule or hook:</span> <code>{failure.rule}</code></div>{/if}
          <div><span>Reason:</span> {failure.reason}</div>
          {#if failure.output}<details>
              <summary>Failure output</summary>
              <pre>{failure.output}</pre>
            </details>{/if}
          <Button size="sm" variant="secondary" onclick={() => prepareFailure(tool, failure)}
            >Fix with agent</Button
          >
        </div>
      {/if}
    {/snippet}
    {#each displayEntries as entry (entry.id)}
      {#if entry.type === 'spawn-response'}
        <SpawnResponse receipt={entry.receipt} />
      {:else if entry.type === 'tool-group'}
        {#each entry.tools.filter(toolFailed) as tool (tool.id)}{@render failureCard(tool)}{/each}
        {#if isBusy && (entry.id === displayEntries.at(-1)?.id || entry.tools.some(toolRunning))}
          {#if entry.tools.length > 1}
            <details class="agent-tool-group">
              <summary>
                {entry.tools.length - 1} earlier {entry.tools.length === 2 ? 'action' : 'actions'}
                {#if entry.tools.slice(0, -1).some(toolRunning)}<span>Running</span>{/if}
                {#if entry.tools.slice(0, -1).some(toolFailed)}<span class="agent-tool-error"
                    >Failed</span
                  >{/if}
              </summary>
              <div class="agent-tool-list">
                {#each entry.tools.slice(0, -1) as tool (tool.id)}
                  {@render toolRow(tool, true)}
                {/each}
              </div>
            </details>
          {/if}
          {@const latest = entry.tools.at(-1)}
          {#if latest}
            <div class="agent-tool-current" class:running={toolRunning(latest)}>
              <span class="agent-tool-current-label">Latest action</span>
              {@render toolRow(latest, false)}
            </div>
          {/if}
        {:else}
          <details class="agent-tool-group">
            <summary>
              <span>{entry.tools.length} {entry.tools.length === 1 ? 'action' : 'actions'}</span>
              <span class="agent-tool-group-last">{entry.tools.at(-1)?.title}</span>
              {#if entry.tools.at(-1)?.status !== 'completed' && !toolFailed(entry.tools.at(-1)!)}<span
                  >{entry.tools.at(-1)?.status.replaceAll('_', ' ')}</span
                >{/if}
              {#if entry.tools.slice(0, -1).some(toolRunning)}<span>Running</span>{/if}
              {#if entry.tools.some(toolFailed)}<span class="agent-tool-error">Failed</span>{/if}
            </summary>
            <div class="agent-tool-list">
              {#each entry.tools as tool (tool.id)}
                {@render toolRow(tool, true)}
              {/each}
            </div>
          </details>
        {/if}
      {:else}
        {@const segments =
          entry.type === 'user'
            ? splitTaskNotifications(entry.text)
            : [{ type: 'text' as const, text: entry.text }]}
        {#each segments as segment, index (index)}
          {#if segment.type === 'notification'}
            {@const note = segment.notification}
            <div
              class="agent-subagent-card"
              class:stopped={note.status !== 'completed'}
              aria-label={`Subagent ${note.status}`}
              role="group"
            >
              <span class="agent-tool-status" class:failed={isFailedStatus(note.status)}
                >{note.status.replaceAll('_', ' ')}</span
              >
              <span class="agent-subagent-summary">{note.summary}</span>
              {#each notificationStats(note) as stat (stat)}<span class="agent-subagent-stat"
                  >{stat}</span
                >{/each}
            </div>
          {:else}
            {@const text = segment.text}
            {@const hookMessage = entry.type === 'assistant' ? splitKlaudiushMessage(text) : null}
            {@const attribution =
              entry.type === 'user'
                ? coordinationMessageForText(text, coordinationMessages)
                : undefined}
            <article
              class:user-message={entry.type === 'user'}
              class:assistant-message={entry.type !== 'user'}
              class:thought={entry.type === 'thought'}
              class="agent-message message"
              data-created={entry.created}
              tabindex="-1"
            >
              <div
                class:agent-avatar={entry.type !== 'user'}
                class:user-avatar={entry.type === 'user'}
                class="avatar"
              >
                {attribution ? '↗' : entry.type === 'user' ? 'You' : 'S.'}
              </div>
              <div class="message-body">
                <div class="message-author">
                  {entry.type === 'user'
                    ? attribution
                      ? `From ${attribution.sender}`
                      : 'You'
                    : entry.type === 'thought'
                      ? `${name} · thinking`
                      : name}
                </div>
                {#if hookMessage}
                  {@render hookNotice(hookMessage.rules)}
                  <details class="agent-hook-details">
                    <summary>Full hook notice</summary>
                    <Markdown source={hookMessage.notice} />
                  </details>
                  {#if hookMessage.remainder}<Markdown source={hookMessage.remainder} />{/if}
                {:else}
                  <Markdown
                    source={attribution
                      ? text.replace(coordinationPrompt(attribution), attribution.text)
                      : text}
                  />
                {/if}
              </div>
            </article>
          {/if}
        {/each}
      {/if}
    {/each}
    {#each coordinationMessages.filter((message) => !entries.some((entry) => entry.type === 'user' && entry.text.includes(coordinationPrompt(message)))) as message (message.id)}
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
    <PostTurnChecks checks={postTurnChecks} onretry={onretrycheck} />
    <SpawnActivity receipts={spawnReceipts} />
    {#if queued.length}<div class="queued-messages" role="status" aria-label="Queued messages">
        {#each queued as message, index (index)}
          <article class="agent-message message user-message queued-message">
            <div class="avatar user-avatar">You</div>
            <div class="message-body">
              <div class="message-author">
                You · queued{message.attachments.length || message.images.length
                  ? ` · ${message.attachments.length + message.images.length} attachments`
                  : ''}
              </div>
              <Markdown source={message.text || 'Attachments'} />
            </div>
          </article>
        {/each}
        {#if queuePaused}<Button size="sm" variant="secondary" onclick={retryQueue}
            >Retry queue</Button
          >{/if}
      </div>{/if}
    {#if isBusy}<div class="agent-busy" role="status">
        {name} is working… <Button size="sm" variant="secondary" onclick={stop}>Stop</Button>
      </div>{/if}
  </div>
  <div class="agent-composer composer-wrap">
    <div class="composer">
      {#if error}<p class="agent-error" role="alert">
          {error} <button onclick={() => void activate(activeSessionId)}>Retry</button>
        </p>{/if}
      {#if authNeeded}
        <div class="agent-auth" role="group" aria-label="Agent sign in">
          {#each authMethods.filter((method) => method.type !== 'terminal') as method (method.id)}
            <Button
              size="sm"
              onclick={() => authenticate(method.id)}
              disabled={authenticating}
              loading={authenticating}>Sign in with {method.name}</Button
            >
          {:else}
            <span>Sign in with {name}, then choose Retry.</span>
          {/each}
        </div>
      {/if}
      {#each permissions as permission (String(permission.id))}
        <div
          class="agent-permission"
          role="group"
          aria-label="Agent permission request"
          data-request-id={permission.id}
          data-session-id={permission.sessionId}
          data-agent-id={agent}
          tabindex="-1"
        >
          <strong>{permission.title}</strong>
          <div>
            {#each permission.options as option (option.optionId)}<Button
                size="sm"
                variant={option.kind.startsWith('allow') ? 'primary' : 'secondary'}
                onclick={() => answer(permission, option.optionId)}>{option.name}</Button
              >{/each}
          </div>
        </div>
      {/each}
      <textarea
        bind:this={prompt}
        data-pane-prompt
        role="combobox"
        aria-autocomplete="list"
        aria-label={`Message ${name}`}
        aria-haspopup="listbox"
        aria-controls={skillMatches.length ? skillMenuId : undefined}
        aria-expanded={skillMatches.length > 0}
        aria-activedescendant={skillMatches.length
          ? `${skillMenuId}-option-${Math.min(skillSelected, skillMatches.length - 1)}`
          : undefined}
        bind:value={draft}
        onpaste={(event) => {
          pendingPaste = Promise.all([pendingPaste, pasteFiles(event)]).then(() => {});
        }}
        onkeydown={keydown}
        rows="3"
        placeholder={`Message ${name}…`}
        disabled={!directory}></textarea>
      <SkillMenu
        id={skillMenuId}
        skills={skillMatches}
        selected={skillSelected}
        choose={chooseSkill}
      />
      {#if images.length}<div class="attachments">
          {#each images as image (image.id)}<span
              >📷 {image.imagePath.split(/[\\/]/).at(-1)}
              <button aria-label="Remove picked element" onclick={() => removeImage(image)}
                >×</button
              ></span
            >{/each}
        </div>{/if}
      {#if clipboardAttachments.length}<div class="attachments">
          {#each clipboardAttachments as attachment (attachment.path)}<span
              >{attachment.image ? '📷' : '📎'}
              {attachment.name}
              <button
                aria-label={`Remove ${attachment.name}`}
                onclick={() => removeClipboardAttachment(attachment)}>×</button
              ></span
            >{/each}
        </div>{/if}
      <div class="agent-composer-footer">
        <div class="agent-picker-controls">
          <OptionPicker
            label="Model"
            value={modelOption?.currentValue}
            options={modelOption?.options ?? []}
            open={pickerOpen === 'model'}
            disabled={!ready || isBusy || !directory}
            loading={!!creatingSession}
            onopen={() => void openPicker('model')}
            onclose={() => (pickerOpen = null)}
            onchoose={(value) => {
              if (modelOption) void setConfig(modelOption.id, value);
            }}
          />
          <OptionPicker
            label="Effort"
            value={effortOption?.currentValue}
            options={effortOption?.options ?? []}
            open={pickerOpen === 'effort'}
            disabled={!ready || isBusy || !directory}
            loading={!!creatingSession}
            onopen={() => void openPicker('effort')}
            onclose={() => (pickerOpen = null)}
            onchoose={(value) => {
              if (effortOption) void setConfig(effortOption.id, value);
            }}
          />
        </div>
        <div class="agent-actions">
          <Button
            onclick={() => void send()}
            disabled={!ready || (!draft.trim() && !clipboardAttachments.length)}
            >{isBusy ? 'Queue ↗' : 'Send ↗'}</Button
          >
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .agent-workspace {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }
  .agent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
  }
  .agent-header div {
    display: flex;
    gap: 12px;
    align-items: baseline;
  }
  .agent-header .agent-heading {
    min-width: 0;
    flex: 1;
  }
  .agent-heading strong {
    flex: none;
  }
  .agent-header .agent-usage {
    flex: none;
    font-size: 11px;
    white-space: nowrap;
  }
  .agent-header span {
    opacity: 0.65;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-picker-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .agent-composer-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0 9px 9px 10px;
  }
  .agent-header .agent-config {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-left: auto;
    margin-right: 12px;
  }
  .agent-conversation {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding-inline: 20px;
  }
  .agent-history-status {
    display: block;
    margin: 12px auto 20px;
  }
  .agent-welcome {
    max-width: 650px;
    margin: 15vh auto;
    text-align: center;
  }
  .agent-message {
    width: 100%;
  }
  .agent-message.thought {
    opacity: 0.65;
  }
  .agent-tool-group,
  .agent-tool-current {
    margin: 0 0 8px 42px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .agent-hook-notice {
    margin: 0 0 8px 42px;
    padding: 9px 12px;
    border: 1px solid var(--danger, #d66);
    border-radius: 8px;
  }
  .agent-tool-failure {
    margin: 0 0 8px 42px;
    padding: 9px 12px;
    border: 1px solid var(--danger, #d66);
    border-radius: 8px;
    overflow-wrap: anywhere;
  }
  .agent-tool-failure strong {
    color: var(--danger, #d66);
  }
  .agent-tool-failure > div,
  .agent-tool-failure details {
    margin: 5px 0;
  }
  .agent-tool-failure span {
    color: var(--text-muted, #888);
  }
  .agent-tool-failure pre {
    max-height: 180px;
    overflow: auto;
    white-space: pre-wrap;
  }
  .message-body .agent-hook-notice {
    margin-left: 0;
  }
  .agent-hook-notice strong {
    color: var(--danger, #d66);
  }
  .agent-hook-notice ul {
    margin: 5px 0 0;
    padding-left: 20px;
  }
  .agent-hook-notice code {
    margin-right: 4px;
  }
  .agent-hook-details {
    margin-bottom: 8px;
    color: var(--text-muted, #888);
  }
  .agent-tool-group > summary {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    color: var(--text-muted, #888);
  }
  .agent-tool-group-last {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-tool-group > summary {
    cursor: pointer;
  }
  .agent-tool-group > summary::before {
    content: '▸';
    flex: 0 0 auto;
  }
  .agent-tool-group[open] > summary::before {
    transform: rotate(90deg);
  }
  .agent-tool-list {
    padding: 0 12px 10px;
  }
  .agent-tool-status,
  .agent-tool-current-label {
    color: var(--text-muted, #888);
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .agent-tool-status.failed,
  .agent-tool-error {
    color: var(--danger, #d66);
  }
  .agent-subagent-card {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    margin: 0 0 8px 42px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .agent-subagent-card.stopped {
    border-style: dashed;
  }
  .agent-subagent-summary {
    flex: 1 1 auto;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .agent-subagent-stat {
    color: var(--text-muted, #888);
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .agent-tool-current {
    padding: 7px 12px;
  }
  .agent-tool-current.running {
    border-color: var(--accent, var(--border));
  }
  .agent-tool-current-label {
    display: block;
    margin-bottom: 2px;
  }
  .queued-message {
    opacity: 0.6;
  }
  .agent-busy {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .agent-composer {
    position: relative;
    flex: 0 0 auto;
    padding-inline: 20px;
  }
  .agent-composer textarea {
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
  .agent-actions {
    display: flex;
    align-items: center;
  }
  .agent-error {
    color: var(--danger, #d66);
  }
  .agent-permission {
    margin-bottom: 10px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .agent-permission div {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
</style>
