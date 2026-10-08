<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { Button } from '@smykla-skalski/sui';
  import ActivityStatus from './ActivityStatus.svelte';
  import TaskLocation from './TaskLocation.svelte';
  import Markdown from './Markdown.svelte';
  import ChatMessage from './ChatMessage.svelte';
  import SpawnActivity from './SpawnActivity.svelte';
  import PostTurnChecks from './PostTurnChecks.svelte';
  import type { PostTurnCheck } from './lib/post-turn-checks';
  import SpawnResponse from './SpawnResponse.svelte';
  import ToolActivity from './ToolActivity.svelte';
  import HookActivityCard from './HookActivity.svelte';
  import { activityForSession, parseHookActivity, type HookActivity } from './lib/hook-activity';
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
    insertSkill,
    mergeSkills,
    promptSkill,
    resolveSkillPrompt,
    skillQuery,
    type SkillChoice,
  } from './lib/skills';
  import { bundledSkills } from './lib/bundled-skills';
  import { trackImplementationSteer } from './lib/implementation-steering';
  import {
    beginImplementationTurn,
    beginShipItRun,
    claimLegacyPendingImplementationTurn,
    hasPendingImplementationTurn,
    recordImplementationModel,
    recordShipItOwner,
    savedShipItIssue,
    savedShipItOwner,
    type ShipItIssue,
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
    acpFinishedPromptStatus,
    acpPromptInterrupted,
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
  import {
    composerDraftKey,
    recallComposerDraft,
    rememberComposerDraft,
  } from './lib/composer-drafts';
  import {
    composerTaskLocation,
    type TaskLocation as TaskLocationValue,
  } from './lib/task-location';
  import { workspaceActivityItems, type WorkspaceActivityItem } from './lib/workspace-activity';
  import { permissionPolicy, type CapabilityProfile } from './lib/capability-profiles';
  import { permissionResolver } from './lib/permission-resolution';
  import {
    acpPermissionIdentity,
    enqueueAcpPermission,
    fencedAcpPermissionInventory,
    reconcileRejectedAcpPermission,
    removeResolvedAcpPermission,
  } from './lib/acp-permissions';

  interface Props {
    agent: AgentId;
    agentName: string;
    directory: string;
    taskLocation: TaskLocationValue;
    thread: AgentThread | null;
    usage?: AgentUsage;
    running: boolean;
    focused?: boolean;
    focusPrompt?: boolean;
    picked?: BrowserAttachment;
    onpickedconsumed?: (id: string) => void;
    onattachmentsent?: (ids: string[], thread: string, turn: string) => void;
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
    ondecision?: (thread: AgentThread, permission: AgentPermission, optionId: string) => void;
    ephemeral?: boolean;
    seedContext?: string;
    coordinationMessages?: CoordinationMessage[];
    spawnReceipts?: SpawnReceipt[];
    onopensubagent?: (receipt: SpawnReceipt) => Promise<void>;
    postTurnChecks?: PostTurnCheck[];
    onretrycheck?: (check: PostTurnCheck) => void;
    onworkspaceactivity?: (
      items: WorkspaceActivityItem[],
      onselect: (item: WorkspaceActivityItem) => Promise<void>,
    ) => void;
    onshipit?: (
      issue: ShipItIssue,
      directory: string,
      threadId: string,
      workerModel?: string,
    ) => Promise<void>;
    nativeEntries?: AgentEntry[];
    capabilityProfile?: CapabilityProfile;
  }
  let {
    agent,
    agentName,
    directory,
    taskLocation,
    thread,
    usage,
    running,
    focused = true,
    focusPrompt = false,
    picked,
    onpickedconsumed,
    onattachmentsent,
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
    ondecision,
    ephemeral = false,
    seedContext = '',
    coordinationMessages = [],
    spawnReceipts = [],
    onopensubagent,
    postTurnChecks = [],
    onretrycheck = () => {},
    onworkspaceactivity,
    onshipit,
    nativeEntries,
    capabilityProfile = 'build',
  }: Props = $props();
  let mounted = $state(false);
  let permissionInventoryRevision = 0;
  const activeCapabilityProfile = $derived(thread?.capabilityProfile ?? capabilityProfile);
  let hookActivities = $state<HookActivity[]>([]);
  function mergeHookActivities(items: HookActivity[]) {
    const merged = new SvelteMap(hookActivities.map((item) => [item.id, item]));
    for (const item of items) merged.set(item.id, item);
    hookActivities = [...merged.values()]
      .toSorted((left, right) => left.created - right.created)
      .slice(-500);
  }
  const promptLocation = $derived(composerTaskLocation(taskLocation, directory, thread?.directory));
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
  $effect(() => {
    if (ephemeral || !activeSessionId || !onshipit || (!busy && !running)) return;
    const path = directory;
    const sessionId = activeSessionId;
    const sourceId = `acp:${agent}:${sessionId}`;
    const callback = onshipit;
    const model = modelOption?.currentValue;
    const saved = savedShipItIssue(path);
    const ownsPending = hasPendingImplementationTurn(path, sourceId);
    const savedOwner = savedShipItOwner(path);
    const claimedLegacy =
      !savedOwner &&
      !!saved &&
      ownsPending &&
      entries.some((entry) => entry.type === 'user' && isShipItPrompt(entry.text)) &&
      claimLegacyPendingImplementationTurn(path, sourceId);
    if (claimedLegacy) recordShipItOwner(path, sourceId);
    if (saved && ownsPending && (savedOwner === sourceId || claimedLegacy))
      void callback(saved, path, sourceId, model);
  });

  function isShipItPrompt(text: string): boolean {
    return /^\s*\/ship-it(?:\s|$)/im.test(text);
  }

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
    draft = insertSkill(draft, skill);
    skillSelected = 0;
    void tick().then(() => prompt.focus());
  }
  let images = $state<BrowserAttachment[]>([]);
  let clipboardAttachments = $state<{ path: string; name: string; image: boolean }[]>([]);
  let clipboardImagePreviews = $state<
    { path: string; name: string; url: string; left: number; top: number; offset: number }[]
  >([]);
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
    const preview = clipboardImagePreviews.find((item) => item.path === attachment.path);
    if (preview) URL.revokeObjectURL(preview.url);
    clipboardImagePreviews = clipboardImagePreviews.filter((item) => item.path !== attachment.path);
    if (attachment.image) void invoke('browser_remove_capture', { path: attachment.path });
    else void removeClipboardFile(attachment.path);
  }

  function clearClipboardImagePreviews() {
    clipboardImagePreviews.forEach((preview) => URL.revokeObjectURL(preview.url));
    clipboardImagePreviews = [];
  }

  function previewPosition(input: HTMLTextAreaElement, offset: number) {
    const styles = getComputedStyle(input);
    const mirror = document.createElement('div');
    const marker = document.createElement('span');
    for (const property of [
      'boxSizing',
      'width',
      'fontFamily',
      'fontSize',
      'fontWeight',
      'fontStyle',
      'letterSpacing',
      'lineHeight',
      'textTransform',
      'textIndent',
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'borderTopWidth',
      'borderRightWidth',
      'borderBottomWidth',
      'borderLeftWidth',
    ] as const)
      mirror.style[property] = styles[property];
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.overflow = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.overflowWrap = 'break-word';
    mirror.style.top = '0';
    mirror.style.left = '-9999px';
    mirror.textContent = input.value.slice(0, offset);
    marker.textContent = '\u200b';
    mirror.append(marker);
    document.body.append(mirror);
    const left = input.offsetLeft + marker.offsetLeft - input.scrollLeft;
    const top = input.offsetTop + marker.offsetTop - input.scrollTop;
    mirror.remove();
    return { left, top };
  }

  async function pasteFiles(event: ClipboardEvent) {
    const files = clipboardFiles(event);
    if (!files.length) return;
    event.preventDefault();
    const pastedText = event.clipboardData?.getData('text/plain') ?? '';
    const input = event.target instanceof HTMLTextAreaElement ? event.target : null;
    const insertionOffset = input ? input.selectionStart + pastedText.length : draft.length;
    if (pastedText && input) {
      const caret = insertionOffset;
      draft = insertClipboardText(draft, pastedText, input.selectionStart, input.selectionEnd);
      void tick().then(() => input.setSelectionRange(caret, caret));
    }
    const current = generation;
    const staged = await Promise.all(
      files.map(async (file) => {
        const image = file.type.startsWith('image/');
        try {
          const path = image ? await stageClipboardImage(file) : await stageClipboardFile(file);
          return { path, name: file.name || 'image.png', image, file, failure: null };
        } catch (cause) {
          return { path: null, name: file.name, image, file, failure: describe(cause) };
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
    if (input)
      void tick().then(() => {
        for (const item of staged) {
          if (item.failure || !item.path || !item.image) continue;
          const position = previewPosition(input, insertionOffset);
          clipboardImagePreviews = [
            ...clipboardImagePreviews,
            {
              path: item.path,
              name: item.name,
              url: URL.createObjectURL(item.file),
              left: position.left,
              top: position.top,
              offset: insertionOffset,
            },
          ];
        }
        return undefined;
      });
  }
  let error = $state('');
  let entries = $state.raw<AgentEntry[]>([]);
  $effect(() => {
    if (nativeEntries) entries = nativeEntries;
  });
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
  let activeSessionId = $state<string | null>(null);
  const visibleHookActivities = $derived(activityForSession(hookActivities, activeSessionId));
  $effect(() => {
    const sessionId = activeSessionId;
    if (!mounted || !sessionId) return;
    void invoke<unknown[]>('list_hook_activity', { sessionId })
      .then((items) =>
        mergeHookActivities(items.map(parseHookActivity).filter((item) => item !== null)),
      )
      .catch(() => undefined);
  });
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
  const visibleStatus = $derived(
    connecting
      ? 'connecting'
      : !ready
        ? 'offline'
        : permissions.length
          ? 'waiting'
          : isBusy
            ? 'working'
            : 'ready',
  );
  const workspaceActivity = $derived(
    workspaceActivityItems({
      tools: entries
        .filter((entry): entry is AgentTool => entry.type === 'tool')
        .map((tool) => ({
          id: tool.id,
          title: tool.title,
          status: tool.status,
          updated: tool.created,
        })),
      children: spawnReceipts,
      decisions: permissions.map((permission) => ({
        id: String(permission.id),
        title: permission.title,
        detail: 'Agent permission request',
      })),
      checks: postTurnChecks,
    }),
  );
  let workspace: HTMLDivElement;

  async function selectWorkspaceActivity(item: WorkspaceActivityItem) {
    if (item.kind === 'child') {
      const receipt = spawnReceipts.find((entry) => entry.receiptId === item.sourceId);
      if (receipt?.targetId && receipt.targetDirectory && onopensubagent) {
        await onopensubagent(receipt);
        return;
      }
    }
    if (item.kind === 'tool') {
      const index = entries.findIndex(
        (entry) => entry.type === 'tool' && entry.id === item.sourceId,
      );
      if (index >= 0 && index < entries.length - visibleCount)
        visibleCount = entries.length - index;
    }
    await tick();
    const attribute =
      item.kind === 'tool'
        ? 'data-tool-id'
        : item.kind === 'child'
          ? 'data-spawn-id'
          : item.kind === 'decision'
            ? 'data-request-id'
            : 'data-check-id';
    const target = workspace.querySelector<HTMLElement>(
      `[${attribute}="${CSS.escape(item.sourceId)}"]`,
    );
    if (!target) throw new Error('The activity source is unavailable.');
    for (let parent = target?.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    target?.scrollIntoView({ block: 'center' });
    (target instanceof HTMLDetailsElement ? target.querySelector('summary') : target)?.focus();
  }

  $effect(() => {
    const items = workspaceActivity;
    untrack(() => onworkspaceactivity?.(items, selectWorkspaceActivity));
  });

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
      await acp.load(agent, directory, id, activeCapabilityProfile);
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
    const policy = permissionPolicy({
      profile: activeCapabilityProfile,
      workspace: directory,
      title,
      toolCall: tool,
      options,
    });
    const permission: AgentPermission = {
      id: message.id,
      sessionId: activeSessionId!,
      title,
      options,
      policy,
      generation:
        typeof params.sailPermissionGeneration === 'number'
          ? params.sailPermissionGeneration
          : undefined,
      fingerprint:
        typeof params.sailPermissionFingerprint === 'string'
          ? params.sailPermissionFingerprint
          : undefined,
    };
    permissions = enqueueAcpPermission(permissions, permission);
    if (thread) onstatus(thread, 'waiting');
  }

  async function activate(id: string | null) {
    rememberTranscript();
    const previousSessionId = activeSessionId;
    rememberDraft(previousSessionId);
    const savedDraft = recallComposerDraft(composerDraftKey(directory, agent, id));
    draft = savedDraft?.text ?? '';
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
    if (nativeEntries) {
      entries = nativeEntries;
      historyLoaded = true;
      ready = true;
      connecting = false;
      return;
    }
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
        const restoresSubagents =
          sessionCapabilities &&
          typeof sessionCapabilities === 'object' &&
          'subagents' in sessionCapabilities;
        if (restoresSubagents || !canResume) {
          setReplaying(true);
          replayEntries = [];
        }
        const session =
          restoresSubagents || !canResume
            ? await acp.load(agent, directory, id, activeCapabilityProfile)
            : await acp.resume(agent, directory, id, activeCapabilityProfile);
        if (current === generation && (restoresSubagents || !canResume)) {
          entries = restoreEntryTimes(replayEntries, entries);
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
        const waiting = await fencedAcpPermissionInventory(
          () => acp.pendingPermissions(agent, id),
          () => permissionInventoryRevision,
          () => current === generation && activeSessionId === id,
        );
        if (waiting) for (const request of waiting) queuePermission(request);
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
      await tick();
      if (savedDraft && prompt)
        prompt.setSelectionRange(savedDraft.selectionStart, savedDraft.selectionEnd);
      await follow();
      if (scroll.scrollHeight <= scroll.clientHeight && entries.length > visibleCount)
        void showEarlier();
    }
  }

  function rememberDraft(
    sessionId = activeSessionId,
    input: HTMLTextAreaElement | undefined = prompt,
  ) {
    rememberComposerDraft(composerDraftKey(directory, agent, sessionId), {
      text: input?.value ?? draft,
      selectionStart: input?.selectionStart ?? draft.length,
      selectionEnd: input?.selectionEnd ?? draft.length,
    });
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
      const session = await acp.create(sessionAgent, sessionDirectory, activeCapabilityProfile);
      const created: AgentThread = {
        agent: sessionAgent,
        model: session.configOptions?.find(
          (option) => option.type === 'select' && /model/i.test(`${option.id} ${option.name}`),
        )?.currentValue,
        sessionId: session.sessionId,
        directory: sessionDirectory,
        title,
        updated: Date.now(),
        capabilityProfile: activeCapabilityProfile,
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
    let unlistenHookActivity: (() => void) | undefined;
    void listen<unknown>('sail:hook-activity', ({ payload }) => {
      const activity = parseHookActivity(payload);
      if (activity) mergeHookActivities([activity]);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenHookActivity = unlisten;
      return undefined;
    });
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
        if (
          (typeof params.requestId !== 'string' && typeof params.requestId !== 'number') ||
          typeof params.sessionId !== 'string'
        )
          return;
        permissionInventoryRevision++;
        permissions = removeResolvedAcpPermission(permissions, {
          id: params.requestId,
          sessionId: params.sessionId,
          generation:
            typeof params.sailPermissionGeneration === 'number'
              ? params.sailPermissionGeneration
              : undefined,
          fingerprint:
            typeof params.sailPermissionFingerprint === 'string'
              ? params.sailPermissionFingerprint
              : undefined,
        });
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
      unlistenHookActivity?.();
      rememberDraft();
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
          void acp
            .permission(
              agent,
              permission.id,
              null,
              permission.sessionId,
              permission.generation,
              permission.fingerprint,
            )
            .catch(() => {});
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
    let shipIssue: ShipItIssue | null;
    try {
      shipIssue = await beginShipItRun(directory, text, promptSkill(skills, text)?.name ?? null);
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
      clearClipboardImagePreviews();
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
      clearClipboardImagePreviews();
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
      if (shipIssue && id && !ephemeral) {
        recordShipItOwner(turnDirectory, `acp:${turnAgent}:${id}`);
        await onshipit?.(
          shipIssue,
          turnDirectory,
          `acp:${turnAgent}:${id}`,
          modelOption?.currentValue,
        );
      }
      if (stopRequested) {
        finalStatus = 'interrupted';
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
      const tracking = await beginImplementationTurn(
        turnDirectory,
        implementationModel,
        `acp:${turnAgent}:${id}`,
      );
      const promptText =
        ephemeral && seedContext && entries.length === 1
          ? `Read-only context from the parent thread:\n${seedContext}\n\nSide question: ${skillText}`
          : skillText;
      phase = 'prompt';
      if (id && sentImages.length)
        onattachmentsent?.(
          sentImages.map((image) => image.id),
          `acp:${turnAgent}:${id}`,
          turnId,
        );
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
      if (recoveredDraft && !acpPromptInterrupted(result) && !stopRequested) recoveredDraft = false;
      if (acpPromptInterrupted(result)) finalStatus = 'interrupted';
      if (acpPromptInterrupted(result) || stopRequested) notifyOnDone = false;
      if (external && !queuedMessage && finalStatus === 'interrupted')
        throw new Error('Agent turn was cancelled.');
      if (current === generation && stopRequested)
        markTools(acpPromptInterrupted(result) ? 'cancelled' : 'status unconfirmed', [
          'pending',
          'in_progress',
          'stopping',
        ]);
      if (activityThread) onactivity({ ...activityThread, updated: Date.now() });
    } catch (cause) {
      const backendStatus =
        phase === 'prompt' && deliverySessionId
          ? await acpFinishedPromptStatus(turnAgent, deliverySessionId, turnId)
          : null;
      const interrupted =
        backendStatus === 'interrupted' ||
        (backendStatus !== 'failed' && (finalStatus === 'interrupted' || stopRequested));
      finalStatus = interrupted ? 'interrupted' : 'failed';
      if (interrupted) notifyOnDone = false;
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
    const steerModel = modelOption?.currentValue || thread?.model;
    const [next, ...remaining] = queued;
    steering = true;
    let tracked;
    try {
      tracked = await trackImplementationSteer(
        turnDirectory,
        steerModel,
        turnAgent,
        sessionId,
        activeTurnId,
        () =>
          acp.steer(
            turnAgent,
            sessionId,
            withAttachedFiles(resolveSkillPrompt(skills, next.text, steerModel), next.attachments),
            promptImagePaths(next.images, next.attachments),
          ),
      );
    } catch (cause) {
      steering = false;
      error = describe(cause);
      return;
    }
    void tracked.completed.catch((cause) => {
      error = describe(cause);
    });
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
    const request = tracked.response.catch(() => ({ outcome: 'failed' as const }));
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
    if (!activeSessionId) {
      return;
    }
    const current = generation;
    const sessionId = activeSessionId;
    const pending = permissions;
    let cancelSent = false;
    try {
      await acp.cancel(agent, sessionId, activeTurnId);
      cancelSent = true;
      await Promise.all(
        pending.map((permission) =>
          acp.permission(
            agent,
            permission.id,
            null,
            permission.sessionId,
            permission.generation,
            permission.fingerprint,
          ),
        ),
      );
      if (current !== generation || activeSessionId !== sessionId) return;
      permissions = [];
      markTools('stopping', ['pending', 'in_progress']);
    } catch (cause) {
      if (current === generation && activeSessionId === sessionId) {
        if (!cancelSent) stopRequested = false;
        error = describe(cause);
      }
    }
  }

  async function answer(permission: AgentPermission, optionId: string) {
    const identity = acpPermissionIdentity(permission);
    const lastRequest =
      permissions.length === 1 && acpPermissionIdentity(permissions[0]!) === identity;
    if (thread && lastRequest) onstatus(thread, 'working');
    try {
      await permissionResolver.resolve({
        key: `acp:${agent}:${permission.sessionId}:${permission.id}`,
        generation: permission.fingerprint ?? permission.generation ?? permission.sessionId,
        policy:
          permission.policy ??
          permissionPolicy({
            profile: activeCapabilityProfile,
            workspace: directory,
            title: permission.title,
            toolCall: {},
            options: permission.options,
          }),
        optionId,
        respond: (selectedOptionId: string | null) =>
          acp.permission(
            agent,
            permission.id,
            selectedOptionId,
            permission.sessionId,
            permission.generation,
            permission.fingerprint,
          ),
        record: (selectedOptionId: string | null) => {
          if (selectedOptionId === null) return;
          if (thread) ondecision?.(thread, permission, selectedOptionId);
        },
      });
      permissions = permissions.filter((item) => acpPermissionIdentity(item) !== identity);
    } catch (cause) {
      error = describe(cause);
      const pending = await acp.pendingPermissions(agent, permission.sessionId).catch(() => null);
      const pendingIdentities = pending?.flatMap((message) => {
        const sessionId = message.params?.sessionId;
        return (typeof message.id === 'string' || typeof message.id === 'number') &&
          typeof sessionId === 'string'
          ? [
              {
                id: message.id,
                sessionId,
                generation:
                  typeof message.params?.sailPermissionGeneration === 'number'
                    ? message.params.sailPermissionGeneration
                    : undefined,
                fingerprint:
                  typeof message.params?.sailPermissionFingerprint === 'string'
                    ? message.params.sailPermissionFingerprint
                    : undefined,
              },
            ]
          : [];
      });
      const remainsPending = pendingIdentities?.some(
        (candidate) => acpPermissionIdentity(candidate) === identity,
      );
      if (thread && lastRequest && remainsPending) onstatus(thread, 'waiting');
      if (pendingIdentities)
        permissions = reconcileRejectedAcpPermission(permissions, permission, pendingIdentities);
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
<div class="agent-workspace" bind:this={workspace}>
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
    <ActivityStatus status={visibleStatus} />
  </div>
  <div class="agent-body">
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
      {#if historyLoading}<div class="agent-history-status" role="status">
          Loading history…
        </div>{/if}
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
          activityId={tool.id}
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
            <div><span>Provider:</span> {name}</div>
            {#if failure.event}<div><span>Event:</span> {failure.event}</div>{/if}
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
                  {#if entry.tools.slice(0, -1).some(toolRunning)}<ActivityStatus
                      status="working"
                      compact
                    />{/if}
                  {#if entry.tools.slice(0, -1).some(toolFailed)}<ActivityStatus
                      status="failed"
                      compact
                    />{/if}
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
                {#if entry.tools.at(-1)?.status !== 'completed' && !toolFailed(entry.tools.at(-1)!)}<ActivityStatus
                    status={entry.tools.at(-1)?.status}
                    compact
                  />{/if}
                {#if entry.tools.slice(0, -1).some(toolRunning)}<ActivityStatus
                    status="working"
                    compact
                  />{/if}
                {#if entry.tools.some(toolFailed)}<ActivityStatus status="failed" compact />{/if}
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
                <ActivityStatus
                  status={isFailedStatus(note.status) ? 'failed' : note.status}
                  compact
                />
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
              <ChatMessage
                kind={entry.type}
                created={entry.created}
                author={entry.type === 'user'
                  ? attribution
                    ? `From ${attribution.sender}`
                    : 'You'
                  : entry.type === 'thought'
                    ? `${name} · thinking`
                    : name}
              >
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
              </ChatMessage>
            {/if}
          {/each}
        {/if}
      {/each}
      {#each coordinationMessages.filter((message) => !entries.some((entry) => entry.type === 'user' && entry.text.includes(coordinationPrompt(message)))) as message (message.id)}
        <ChatMessage
          kind="user"
          author={`From ${message.sender}${message.delivered ? '' : ' · queued'}`}
        >
          <Markdown source={message.text} />
        </ChatMessage>
      {/each}
      {#each visibleHookActivities as activity (activity.id)}
        <HookActivityCard {activity} />
      {/each}
      <PostTurnChecks checks={postTurnChecks} onretry={onretrycheck} />
      <SpawnActivity receipts={spawnReceipts} onopen={onopensubagent} />
      {#if queued.length}<div class="queued-messages" role="status" aria-label="Queued messages">
          {#each queued as message, index (index)}
            <ChatMessage
              kind="user"
              author={`You · queued${message.attachments.length || message.images.length ? ` · ${message.attachments.length + message.images.length} attachments` : ''}`}
            >
              <Markdown source={message.text || 'Attachments'} />
            </ChatMessage>
          {/each}
          {#if queuePaused}<Button size="sm" variant="secondary" onclick={retryQueue}
              >Retry queue</Button
            >{/if}
        </div>{/if}
      {#if isBusy}<ChatMessage kind="assistant" author={name}>
          <div class="agent-busy" role="status">
            <ActivityStatus status={visibleStatus} /><Button
              size="sm"
              variant="secondary"
              onclick={stop}>Stop</Button
            >
          </div>
        </ChatMessage>{/if}
    </div>
  </div>
  <div class="agent-composer composer-wrap">
    <div class="composer">
      <TaskLocation location={promptLocation} />
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
      {#each permissions as permission (acpPermissionIdentity(permission))}
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
          {#if permission.policy}<small
              >{permission.policy.profile} · {permission.policy.risk} risk · policy {permission
                .policy.policyRevision}: {permission.policy.reason}</small
            >{/if}
          <div>
            {#each permission.options as option (option.optionId)}{#if permission.policy?.recommendation !== 'deny' || !option.kind.startsWith('allow')}<Button
                  size="sm"
                  variant={option.kind.startsWith('allow') ? 'primary' : 'secondary'}
                  onclick={() => answer(permission, option.optionId)}>{option.name}</Button
                >{/if}{/each}
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
        oninput={(event) => rememberDraft(activeSessionId, event.currentTarget)}
        onselect={(event) => rememberDraft(activeSessionId, event.currentTarget)}
        onpaste={(event) => {
          pendingPaste = Promise.all([pendingPaste, pasteFiles(event)]).then(() => {});
        }}
        onkeydown={keydown}
        rows="3"
        placeholder={`Message ${name}…`}
        disabled={!directory || !!nativeEntries}></textarea>
      {#each clipboardImagePreviews as preview (preview.path)}
        <figure
          class="clipboard-image-preview"
          style={`left: ${preview.left}px; top: ${preview.top}px`}
          data-caret-offset={preview.offset}
          aria-label={`Pasted ${preview.name}`}
        >
          <img src={preview.url} alt="" />
          <button
            aria-label={`Remove ${preview.name}`}
            onclick={() => removeClipboardAttachment({ path: preview.path, image: true })}>×</button
          >
        </figure>
      {/each}
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
      {#if clipboardAttachments.some((attachment) => !attachment.image)}<div class="attachments">
          {#each clipboardAttachments.filter((attachment) => !attachment.image) as attachment (attachment.path)}<span
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
            disabled={!ready || isBusy || !directory || !!nativeEntries}
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
            disabled={!ready || isBusy || !directory || !!nativeEntries}
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
            disabled={!ready || !!nativeEntries || (!draft.trim() && !clipboardAttachments.length)}
            >{isBusy ? 'Queue ↗' : 'Send ↗'}</Button
          >
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .agent-workspace {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }
  .agent-body {
    position: relative;
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
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
  .agent-hook-notice {
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
  .agent-tool-current-label {
    color: var(--text-muted, #888);
    font-size: 0.75rem;
    white-space: nowrap;
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
  .queued-messages :global(.agent-message) {
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
  .clipboard-image-preview {
    position: absolute;
    z-index: 1;
    display: flex;
    width: 108px;
    height: 72px;
    margin: 0;
    overflow: hidden;
    border: 1px solid var(--sui-border);
    border-radius: 7px;
    background: var(--sui-surface);
    box-shadow: 0 3px 10px #0003;
  }
  .clipboard-image-preview img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .clipboard-image-preview button {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    color: var(--sui-foreground);
    background: #0009;
    line-height: 1;
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
