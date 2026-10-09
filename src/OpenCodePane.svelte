<script lang="ts">
  import { keyboardScrollable } from './lib/scroll-focus';
  import { onMount, tick, untrack } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { invoke } from '@tauri-apps/api/core';
  import { Button } from '@smykla-skalski/sui';
  import { isSessionNotFoundError } from '@opencode/client';
  import type { FormInfo, PermissionRequest } from '@opencode/client';
  import ActivityStatus from './ActivityStatus.svelte';
  import TaskLocation from './TaskLocation.svelte';
  import type { PostTurnCheck } from './lib/post-turn-checks';
  import JumpToLatest from './JumpToLatest.svelte';
  import Transcript from './Transcript.svelte';
  import {
    buildTranscript,
    checkItems,
    openCodeItems,
    pendingCoordinationItems,
    subagentItems,
    latestRevision,
  } from './lib/transcript';
  import OpenCodeSubagents from './OpenCodeSubagents.svelte';
  import HarnessIcon from './HarnessIcon.svelte';
  import OptionPicker from './OptionPicker.svelte';
  import PathPicker from './PathPicker.svelte';
  import ComposerHint from './ComposerHint.svelte';
  import SkillMenu from './SkillMenu.svelte';
  import {
    matchingSkills,
    insertSkill,
    mergeSkills,
    promptSkill,
    resolveSkillPrompt,
    type SkillChoice,
  } from './lib/skills';
  import { bundledSkills } from './lib/bundled-skills';
  import {
    abandonImplementationTurn,
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
    dispatchAuthorizedDirectShipPrompt,
    directShipClaimPrompt,
    type DirectShipAuthorization,
  } from './lib/issue-shipping';
  import {
    openCodeInboxSettled,
    runOpenCodePromptStart,
    runSerialOpenCodeTurn,
    waitForAuthoritativeOpenCodeSettlement,
  } from './lib/opencode-turns';
  import { openCodeHeaderStatus } from './lib/agent-status';
  import PromptPanel from './PromptPanel.svelte';
  import type { AgentThread } from './lib/acp';
  import type { SpawnReceipt } from './lib/agent-results';
  import type { SubagentControl } from './lib/subagent-control';
  import type { BrowserAttachment } from './lib/browser-pick';
  import { coordinationPrompt, type CoordinationMessage } from './lib/coordination';
  import { openCodeExecutionStatus, openCodeTurnStatus, type ThreadStatus } from './lib/attention';
  import { openCodeContextUsage } from './lib/agent-usage';
  import {
    clipboardFiles,
    fileUri,
    insertClipboardText,
    removeClipboardFile,
    stageClipboardFile,
  } from './lib/attachments';
  import type { SetupReport } from './lib/onboarding';
  import type { OpenCodeClient, SessionInfo, SessionMessageInfo } from './lib/opencode';
  import { mergeMessages, nearBottom } from './lib/timeline';
  import { recallOpenCodeTimeline, rememberOpenCodeTimeline } from './lib/opencode-timeline-cache';
  import { prepareToolFailureDraft, toolFailurePrompt } from './lib/tool-failure';
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
  import {
    holdCapabilityProfileReservation,
    permissionDecisionTitle,
    type CapabilityProfile,
  } from './lib/capability-profiles';

  let {
    client,
    runtimeState,
    directory,
    taskLocation,
    thread,
    setup,
    coordinationMessages = [],
    spawnReceipts = [],
    onopensubagent,
    subagentControl,
    postTurnChecks = [],
    onretrycheck,
    focused,
    focusPrompt,
    picked,
    externalPrompt,
    onexternalresult,
    onpickedconsumed,
    onattachmentsent,
    onpromptfocused,
    oncreated,
    onactivity,
    onhistorychange = () => {},
    onstatus,
    onusage,
    onworkspaceactivity,
    onshipit,
    capabilityProfile = 'build',
    onensureprofile,
    ondecision,
  }: {
    client: OpenCodeClient | null;
    runtimeState: 'starting' | 'connected' | 'error';
    directory: string;
    taskLocation: TaskLocationValue;
    thread: AgentThread | null;
    setup: SetupReport | null;
    coordinationMessages?: CoordinationMessage[];
    spawnReceipts?: SpawnReceipt[];
    onopensubagent?: (receipt: SpawnReceipt) => Promise<void>;
    subagentControl?: SubagentControl;
    postTurnChecks?: PostTurnCheck[];
    onretrycheck: (check: PostTurnCheck) => void;
    focused: boolean;
    focusPrompt: boolean;
    picked?: BrowserAttachment;
    externalPrompt?: { id: string; text: string };
    onexternalresult?: (id: string, failure: string | null) => void;
    onpickedconsumed?: (id: string) => void;
    onattachmentsent?: (ids: string[], thread: string, turn: string) => void;
    onpromptfocused?: () => void;
    oncreated: (thread: AgentThread) => void;
    onactivity: (thread: AgentThread) => void;
    onhistorychange?: () => void;
    onstatus: (thread: AgentThread, status: ThreadStatus, notifyOnDone?: boolean) => void;
    onusage?: (sessionID: string, context: number | undefined) => void;
    onworkspaceactivity?: (
      items: WorkspaceActivityItem[],
      onselect: (item: WorkspaceActivityItem) => Promise<void>,
    ) => void;
    onshipit?: (
      issue: ShipItIssue,
      directory: string,
      threadId: string,
      workerModel?: string,
      requireClaim?: boolean,
    ) => Promise<DirectShipAuthorization | undefined>;
    capabilityProfile?: CapabilityProfile;
    onensureprofile?: (directory: string, profile: CapabilityProfile) => Promise<() => void>;
    ondecision?: (thread: AgentThread, id: string, title: string, outcome: string) => void;
  } = $props();

  let session = $state<SessionInfo | null>(null);
  const promptLocation = $derived(composerTaskLocation(taskLocation, directory, thread?.directory));
  let messages = $state<SessionMessageInfo[]>([]);
  // Off while history (cache, first page, older pages) mounts, so its failed tools stay silent.
  let liveTools = $state(false);
  const transcriptItems = $derived(
    buildTranscript({
      base: openCodeItems(messages, spawnReceipts),
      timed: [...checkItems(postTurnChecks), ...subagentItems(spawnReceipts)],
      trailing: pendingCoordinationItems(
        coordinationMessages.filter(
          (message) =>
            !messages.some(
              (item) => item.type === 'user' && item.text.includes(coordinationPrompt(message)),
            ),
        ),
        'opencode',
      ),
    }),
  );
  let cursor = $state<string | null>(null);
  const pickedCaptureIds = new SvelteMap<string, string>();
  let pendingPermissions = $state<PermissionRequest[]>([]);
  let pendingForms = $state<FormInfo[]>([]);
  let draft = $state('');
  const failureRequests = new SvelteMap<string, string>();
  let skills = $state<SkillChoice[]>(bundledSkills);
  let skillSelected = $state(0);
  $effect(() => {
    if (!onshipit || !activeID || !running) return;
    const path = directory;
    const id = activeID;
    const sourceId = `opencode:${id}`;
    const callback = onshipit;
    const saved = savedShipItIssue(path);
    const ownsPending = hasPendingImplementationTurn(path, sourceId);
    const savedOwner = savedShipItOwner(path);
    const claimedLegacy =
      !savedOwner &&
      !!saved &&
      ownsPending &&
      messages.some((message) => message.type === 'user' && isShipItPrompt(message.text)) &&
      claimLegacyPendingImplementationTurn(path, sourceId);
    if (claimedLegacy) recordShipItOwner(path, sourceId);
    if (saved && ownsPending && (savedOwner === sourceId || claimedLegacy))
      void callback(
        saved,
        path,
        sourceId,
        session?.model ? `${session.model.providerID}:${session.model.id}` : undefined,
      ).catch((cause) => (error = describe(cause)));
  });

  function isShipItPrompt(text: string): boolean {
    return /^\s*\/ship-it(?:\s|$)/im.test(text);
  }

  const skillMenuId = crypto.randomUUID();
  const skillMatches = $derived(matchingSkills(skills, draft));
  $effect(() => {
    const source = client;
    const path = directory;
    const canLoad = setup?.workReady || setup?.planReady;
    if (!source || !path || !canLoad) {
      skills = bundledSkills;
      return;
    }
    let cancelled = false;
    void source.skill.list({ location: { directory: path } }).then(
      (result) => {
        if (!cancelled)
          skills = mergeSkills(
            result.data.map((skill) => ({
              id: skill.id,
              name: skill.name,
              description: skill.description ?? '',
            })),
            bundledSkills,
          );
        return undefined;
      },
      () => {
        if (!cancelled) skills = bundledSkills;
        return undefined;
      },
    );
    return () => {
      cancelled = true;
    };
  });

  function chooseSkill(skill: SkillChoice) {
    draft = insertSkill(draft, skill);
    skillSelected = 0;
    void tick().then(() => prompt.focus());
  }

  function fixToolFailure(
    key: string,
    name: string,
    input: unknown,
    reason: string,
    output: string,
  ) {
    const request = toolFailurePrompt(name, input, reason, output);
    draft = prepareToolFailureDraft(draft, request, failureRequests.get(key));
    failureRequests.set(key, request);
    void tick().then(() => prompt.focus());
  }
  let files = $state<string[]>([]);
  let pendingPaste: Promise<void> = Promise.resolve();
  const clipboardPaths = new SvelteSet<string>();
  const clipboardNames = new SvelteMap<string, string>();
  const inFlightClipboard = new SvelteSet<string>();
  async function pasteFiles(event: ClipboardEvent) {
    const pasted = clipboardFiles(event);
    if (!pasted.length) return;
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
      pasted.map(async (file) => {
        try {
          return { file, path: await stageClipboardFile(file) };
        } catch (cause) {
          error = `Could not paste ${file.name}: ${describe(cause)}`;
          return null;
        }
      }),
    );
    const paths = staged.flatMap((item) => (item ? [item.path] : []));
    if (current !== generation) {
      paths.forEach((path) => void removeClipboardFile(path));
      return;
    }
    for (const item of staged) {
      if (!item) continue;
      clipboardPaths.add(item.path);
      clipboardNames.set(item.path, item.file.name || 'clipboard-image.png');
    }
    files = [...files, ...paths];
  }
  let error = $state('');
  let loading = $state(false);
  let loadingOlder = $state(false);
  let sending = $state(false);
  let configuring = $state(false);
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
  let following = $state(true);
  const spawnRevision = $derived(spawnReceipts.map((receipt) => receipt.updated).join(','));
  $effect(() => {
    if (spawnRevision && following) void follow();
  });
  let stopRequested = false;
  let lastExecutionStatus: ThreadStatus | null = null;
  const busy = $derived(sending || running || configuring);
  const inputReady = $derived(
    !!setup?.workReady || (session?.agent === 'architect' && !!setup?.planReady),
  );
  const visibleStatus = $derived(
    openCodeHeaderStatus({
      runtime: runtimeState,
      waiting: pendingPermissions.length > 0 || pendingForms.length > 0,
      loading,
      running,
      sending,
      inputReady,
    }),
  );
  let openCodeChildReceipts = $state.raw<SpawnReceipt[]>([]);
  const activityChildren = $derived([...spawnReceipts, ...openCodeChildReceipts]);
  const workspaceActivity = $derived(
    workspaceActivityItems({
      tools: messages.flatMap((message) =>
        message.type === 'assistant'
          ? message.content.flatMap((part) =>
              part.type === 'tool'
                ? [
                    {
                      id: `${message.id}:${part.id}`,
                      title: part.name,
                      status: part.state.status,
                      updated: message.time.created,
                    },
                  ]
                : [],
            )
          : [],
      ),
      children: activityChildren,
      decisions: [
        ...pendingPermissions.map((request) => ({
          id: request.id,
          title: `Allow ${request.action}?`,
          detail: 'Agent permission request',
        })),
        ...pendingForms.map((form) => ({
          id: form.id,
          title: form.title,
          detail: 'Agent form request',
        })),
      ],
      checks: postTurnChecks,
    }),
  );
  let workspace: HTMLDivElement;

  async function selectWorkspaceActivity(item: WorkspaceActivityItem) {
    if (item.kind === 'child') {
      const receipt = activityChildren.find((entry) => entry.receiptId === item.sourceId);
      if (receipt?.targetId && receipt.targetDirectory && onopensubagent) {
        await onopensubagent(receipt);
        return;
      }
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
  const contextUsage = $derived(openCodeContextUsage(messages, setup?.models ?? []));
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
    const savedProfile = info.metadata?.sailCapabilityProfile;
    return {
      agent: 'opencode',
      sessionId: info.id,
      directory,
      title: info.title ?? 'OpenCode thread',
      updated: info.time.updated,
      capabilityProfile:
        savedProfile === 'explore' ||
        savedProfile === 'review' ||
        savedProfile === 'build' ||
        savedProfile === 'release'
          ? savedProfile
          : (thread?.capabilityProfile ?? capabilityProfile),
    };
  }

  async function follow() {
    await tick();
    if (scroll && following) scroll.scrollTop = scroll.scrollHeight;
  }

  async function refreshMessages(id: string, current = generation) {
    if (!client) return;
    const source = client;
    const page = await source.message.list({ sessionID: id, limit: 50, order: 'desc' });
    if (current !== generation || id !== activeID) return;
    const first = !messages.length;
    let incoming = [...page.data];
    if (!first) {
      const known = new Set(messages.map((message) => message.id));
      async function collectGap(
        next: string | null,
        accumulated: SessionMessageInfo[],
      ): Promise<{ messages: SessionMessageInfo[]; exhausted: boolean }> {
        if (!next || !accumulated.length)
          return {
            messages: accumulated,
            exhausted: !accumulated.some((message) => known.has(message.id)),
          };
        if (accumulated.some((message) => known.has(message.id)))
          return { messages: accumulated, exhausted: false };
        const older = await source.message.list({ sessionID: id, limit: 50, cursor: next });
        if (current !== generation || id !== activeID)
          return { messages: accumulated, exhausted: false };
        accumulated.push(...older.data);
        if (older.cursor.next === next || !older.data.length)
          return { messages: accumulated, exhausted: true };
        return collectGap(older.cursor.next ?? null, accumulated);
      }
      const collected = await collectGap(page.cursor.next ?? null, incoming);
      if (current !== generation || id !== activeID) return;
      incoming = collected.messages;
      if (collected.exhausted) cursor = null;
    }
    messages = first ? incoming.toReversed() : mergeMessages(messages, incoming);
    onusage?.(id, openCodeContextUsage(messages, setup?.models ?? []));
    if (first) cursor = page.cursor.next ?? null;
    rememberOpenCodeTimeline(directory, id, { messages, cursor });
    onhistorychange();
    await follow();
    if (current === generation && id === activeID) liveTools = true;
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
      const wasLive = liveTools;
      liveTools = false;
      messages = mergeMessages(messages, page.data);
      cursor = page.cursor.next === next ? null : (page.cursor.next ?? null);
      rememberOpenCodeTimeline(directory, id, { messages, cursor });
      onhistorychange();
      if (!underfilled) following = false;
      await tick();
      if (current === generation && id === activeID) liveTools = wasLive;
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
    rememberDraft(activeID);
    const savedDraft = recallComposerDraft(composerDraftKey(directory, 'opencode', id));
    if (activeID)
      rememberOpenCodeTimeline(directory, activeID, {
        messages,
        cursor,
      });
    onhistorychange();
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    for (const path of clipboardPaths)
      if (!inFlightClipboard.has(path)) {
        clipboardPaths.delete(path);
        clipboardNames.delete(path);
        void removeClipboardFile(path);
      }
    for (const path of pickedImages)
      if (!inFlightCaptures.has(path)) {
        pickedImages.delete(path);
        pickedCaptureIds.delete(path);
        void invoke('browser_remove_capture', { path });
      }
    draft = savedDraft?.text ?? '';
    files = [];
    selectedThreadId = id;
    activeID = id;
    lastExecutionStatus = null;
    session = null;
    const cached = id ? recallOpenCodeTimeline(directory, id) : null;
    liveTools = false;
    messages = cached?.messages ?? [];
    cursor = cached?.cursor ?? null;
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
      const auxiliary = Promise.allSettled([
        refreshMessages(id, current),
        refreshRequests(id, current),
      ]);
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
      const failed = (await auxiliary).find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failed && current === generation) error = describe(failed.reason);
    } catch (cause) {
      if (current === generation) error = describe(cause);
    } finally {
      if (current === generation) loading = false;
    }
    if (current === generation && savedDraft) {
      await tick();
      prompt?.setSelectionRange(savedDraft.selectionStart, savedDraft.selectionEnd);
    }
  }

  function rememberDraft(sessionId = activeID, input: HTMLTextAreaElement | undefined = prompt) {
    rememberComposerDraft(composerDraftKey(directory, 'opencode', sessionId), {
      text: input?.value ?? draft,
      selectionStart: input?.selectionStart ?? draft.length,
      selectionEnd: input?.selectionEnd ?? draft.length,
    });
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
    pickedCaptureIds.set(picked.imagePath, picked.id);
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
          const executionStatus = openCodeExecutionStatus(event.type);
          if (executionStatus === 'working') lastExecutionStatus = null;
          else if (executionStatus) lastExecutionStatus = executionStatus;
          if (executionStatus && executionStatus !== 'working') {
            running = false;
            if (session) onstatus(summary(session), executionStatus);
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
      rememberDraft();
      if (activeID) {
        rememberOpenCodeTimeline(directory, activeID, { messages, cursor });
        onhistorychange();
      }
      disposed = true;
      mounted = false;
      ++generation;
      clearTimeout(refreshTimer);
      for (const path of pickedImages)
        if (!inFlightCaptures.has(path)) {
          pickedCaptureIds.delete(path);
          void invoke('browser_remove_capture', { path });
        }
      for (const path of clipboardPaths)
        if (!inFlightClipboard.has(path)) {
          clipboardNames.delete(path);
          void removeClipboardFile(path);
        }
    };
  });

  async function send(externalText?: string) {
    await pendingPaste;
    const external = externalText !== undefined;
    const text = (externalText ?? draft).trim();
    const turnDirectory = directory;
    const current = generation;
    let shipIssue: ShipItIssue | null;
    try {
      shipIssue = await beginShipItRun(
        turnDirectory,
        text,
        promptSkill(skills, text)?.name ?? null,
      );
    } catch (cause) {
      error = describe(cause);
      return;
    }
    if (
      !client ||
      (!text && (external || !files.length)) ||
      !inputReady ||
      sending ||
      configuring ||
      current !== generation ||
      turnDirectory !== directory
    ) {
      if (external) throw new Error('Wait for the current OpenCode turn.');
      return;
    }
    const source = client;
    const paths = external ? [] : [...files];
    for (const path of paths) if (pickedImages.has(path)) inFlightCaptures.add(path);
    for (const path of paths) if (clipboardPaths.has(path)) inFlightClipboard.add(path);
    let accepted = false;
    let settledStatus: ThreadStatus | null = null;
    if (!external) {
      draft = '';
      files = [];
    }
    const queued = running;
    sending = true;
    stopRequested = false;
    lastExecutionStatus = null;
    error = '';
    let releaseProfile: (() => void) | undefined;
    try {
      const savedProfile = session?.metadata?.sailCapabilityProfile;
      const activeProfile: CapabilityProfile =
        savedProfile === 'explore' ||
        savedProfile === 'review' ||
        savedProfile === 'build' ||
        savedProfile === 'release'
          ? savedProfile
          : (thread?.capabilityProfile ?? capabilityProfile);
      releaseProfile = await onensureprofile?.(turnDirectory, activeProfile);
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
          location: { directory: turnDirectory },
          metadata: { saiHarness: true, sailCapabilityProfile: activeProfile },
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
        let directClaim = '';
        let directAuthorization: DirectShipAuthorization | undefined;
        const target = await source.session.get({ sessionID: id });
        if (target.location.directory !== turnDirectory)
          throw new Error('Target session moved to another worktree.');
        const implementingModel = target.model
          ? `${target.model.providerID}:${target.model.id}`
          : undefined;
        if (shipIssue) {
          recordShipItOwner(turnDirectory, `opencode:${id}`);
          directAuthorization = await onshipit?.(
            shipIssue,
            turnDirectory,
            `opencode:${id}`,
            implementingModel,
            true,
          );
          if (!directAuthorization) throw new Error('Direct shipping claim was not acquired.');
          directClaim = directShipClaimPrompt(directAuthorization.claim);
        }
        await invoke('record_turn_snapshot', { path: turnDirectory, thread: `opencode:${id}` });
        const tracking = await beginImplementationTurn(
          turnDirectory,
          implementingModel,
          `opencode:${id}`,
        );
        let response: Awaited<ReturnType<OpenCodeClient['session']['prompt']>>;
        try {
          response = await dispatchAuthorizedDirectShipPrompt(directAuthorization, () =>
            runOpenCodePromptStart(turnDirectory, () =>
              source.session.prompt({
                sessionID: id,
                text: resolveSkillPrompt(skills, text, implementingModel) + directClaim,
                skills: promptSkill(skills, text)?.id
                  ? [{ id: promptSkill(skills, text)!.id! }]
                  : undefined,
                delivery: queued ? 'steer' : undefined,
                files: paths.map((path) => ({
                  uri: fileUri(path),
                  name: clipboardNames.get(path) ?? path.split(/[\\/]/).at(-1),
                })),
              }),
            ),
          );
          const heldRelease = releaseProfile;
          releaseProfile = undefined;
          const completion = waitForAuthoritativeOpenCodeSettlement(
            () => (client ?? source).session.wait({ sessionID: id }),
            () =>
              openCodeInboxSettled(response.id, (pageCursor) =>
                (client ?? source).message.list({
                  sessionID: id,
                  limit: 100,
                  order: 'desc',
                  cursor: pageCursor,
                }),
              ),
            { terminal: isSessionNotFoundError },
          );
          if (heldRelease)
            void holdCapabilityProfileReservation(heldRelease, completion).catch(() => undefined);
        } catch (cause) {
          await recordImplementationModel(turnDirectory, implementingModel, tracking);
          throw cause;
        }
        void source.session
          .wait({ sessionID: id })
          .then(
            () => recordImplementationModel(turnDirectory, implementingModel, tracking),
            () => recordImplementationModel(turnDirectory, implementingModel, tracking),
          )
          .catch((cause) => {
            abandonImplementationTurn(turnDirectory, tracking);
            error = `Could not track implementation model: ${describe(cause)}`;
          });
        return response;
      });
      sending = false;
      const response = await promptRequest;
      const captureIds = paths.flatMap((path) => {
        const captureId = pickedCaptureIds.get(path);
        return captureId ? [captureId] : [];
      });
      if (captureIds.length) onattachmentsent?.(captureIds, `opencode:${id}`, response.id);
      accepted = true;
      for (const path of paths)
        if (pickedImages.delete(path)) {
          pickedCaptureIds.delete(path);
          void invoke('browser_remove_capture', { path });
        }
      for (const path of paths)
        if (clipboardPaths.delete(path)) {
          clipboardNames.delete(path);
          void source.session
            .wait({ sessionID: id })
            .catch(() => undefined)
            .then(() => removeClipboardFile(path))
            .catch(() => undefined)
            .finally(() => inFlightClipboard.delete(path));
        }
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
        settledStatus = openCodeTurnStatus(latest.outcome, stopRequested, lastExecutionStatus);
        onstatus(summary(latest), settledStatus, !stopRequested);
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
          if (session && !settledStatus && !lastExecutionStatus)
            onstatus(summary(session), 'failed');
        }
      }
      if (external) throw cause;
    } finally {
      releaseProfile?.();
      for (const path of paths) inFlightCaptures.delete(path);
      if (!accepted)
        for (const path of paths)
          if (inFlightClipboard.delete(path) && (disposed || current !== generation)) {
            clipboardPaths.delete(path);
            clipboardNames.delete(path);
            void removeClipboardFile(path);
          }
      if (current === generation) sending = false;
      if (disposed || current !== generation)
        for (const path of paths)
          if (pickedImages.delete(path)) {
            pickedCaptureIds.delete(path);
            void invoke('browser_remove_capture', { path });
          }
    }
  }

  async function stop() {
    if (!client || !activeID) return;
    stopRequested = true;
    try {
      await client.session.interrupt({ sessionID: activeID });
    } catch (cause) {
      stopRequested = false;
      error = describe(cause);
      return;
    }
    running = false;
    try {
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
    configuring = true;
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
    } finally {
      configuring = false;
    }
  }

  function attachFiles() {
    filePickerOpen = true;
  }

  function removeFile(path: string) {
    files = files.filter((item) => item !== path);
    if (pickedImages.delete(path)) {
      pickedCaptureIds.delete(path);
      void invoke('browser_remove_capture', { path });
    }
    if (clipboardPaths.delete(path)) void removeClipboardFile(path);
    clipboardNames.delete(path);
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

<div class="agent-workspace opencode-pane" bind:this={workspace}>
  <div class="agent-header">
    <div class="agent-heading">
      <HarnessIcon agent="opencode" /><strong>OpenCode</strong><span
        >{session?.title ?? thread?.title ?? 'New thread'}</span
      >
    </div>
    {#if contextUsage !== undefined}<span class="agent-usage">Context {contextUsage}%</span>{/if}
    <ActivityStatus status={visibleStatus} />
  </div>
  <div class="agent-body">
    <div
      class="agent-conversation conversation"
      role="region"
      bind:this={scroll}
      {@attach keyboardScrollable}
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
      <Transcript
        items={transcriptItems}
        busy={running}
        live={liveTools}
        {coordinationMessages}
        onopen={onopensubagent}
        control={subagentControl}
        {onretrycheck}
        ontoolfix={(tool) =>
          fixToolFailure(tool.id, tool.title, tool.input, tool.error, tool.output)}
      >
        {#snippet tail()}
          <OpenCodeSubagents
            {client}
            parentID={activeID}
            {directory}
            onopen={onopensubagent}
            onchildren={(receipts) => (openCodeChildReceipts = receipts)}
          />
          {#if running}<div class="agent-busy" role="status">
              <ActivityStatus status={visibleStatus} /><Button
                size="sm"
                variant="secondary"
                onclick={stop}>Stop</Button
              >
            </div>{/if}
        {/snippet}
      </Transcript>
      <JumpToLatest
        {following}
        count={transcriptItems.length}
        revision={latestRevision(transcriptItems)}
        onjump={() => {
          following = true;
          scroll.scrollTop = scroll.scrollHeight;
        }}
      />
    </div>
  </div>
  <div class="agent-composer composer-wrap">
    <div class="composer">
      <TaskLocation location={promptLocation} />
      {#if error}<p class="agent-error" role="alert">{error}</p>{/if}
      <PromptPanel
        {pendingPermissions}
        {pendingForms}
        {client}
        sessionID={activeID}
        workspace={thread?.directory ?? directory}
        capabilityProfile={thread?.capabilityProfile ?? capabilityProfile}
        ondecision={(request, decision, policy) => {
          if (thread)
            ondecision?.(
              thread,
              request.id,
              permissionDecisionTitle(
                `Allow ${request.action}?`,
                policy,
                decision === 'reject' ? 'rejected' : 'completed',
              ),
              decision === 'reject' ? 'rejected' : 'completed',
            );
        }}
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
        aria-describedby={`${skillMenuId}-hint`}
        bind:value={draft}
        oninput={(event) => rememberDraft(activeID, event.currentTarget)}
        onselect={(event) => rememberDraft(activeID, event.currentTarget)}
        onpaste={(event) => {
          pendingPaste = Promise.all([pendingPaste, pasteFiles(event)]).then(() => {});
        }}
        onkeydown={keydown}
        rows="3"
        wrap="soft"
        placeholder="Message OpenCode…"
        disabled={!inputReady || loading}></textarea>
      <ComposerHint id={`${skillMenuId}-hint`} />
      <SkillMenu
        id={skillMenuId}
        skills={skillMatches}
        selected={skillSelected}
        choose={chooseSkill}
      />
      {#if files.length}<div class="attachments">
          {#each files as file (file)}<span
              >{clipboardNames.get(file) ?? file.split(/[\\/]/).at(-1)}<button
                aria-label={`Remove ${clipboardNames.get(file) ?? file.split(/[\\/]/).at(-1)}`}
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
            disabled={sending || configuring || (!draft.trim() && !files.length) || !inputReady}
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
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
  .opencode-pane .agent-body {
    position: relative;
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .opencode-pane .agent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-12);
    padding: 14px 24px;
    border-bottom: 1px solid var(--shell-divider);
  }
  .opencode-pane .agent-heading {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: baseline;
    gap: var(--space-12);
  }
  .opencode-pane .agent-heading > span:not(.harness-icon) {
    overflow: hidden;
    opacity: 0.65;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .opencode-pane .agent-usage {
    flex: none;
    font-size: var(--type-12);
    white-space: nowrap;
  }
  .opencode-pane .agent-conversation {
    flex: 1;
    min-height: 0;
    padding-inline: var(--transcript-gutter);
  }
  .opencode-pane .agent-busy {
    display: flex;
    align-items: center;
    gap: var(--space-12);
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
    gap: var(--space-8);
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
    color: var(--sui-danger-ink);
  }
  .opencode-pane .agent-picker-controls,
  .opencode-pane .agent-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-4);
  }
</style>
