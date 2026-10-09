<script lang="ts">
  import { keyboardScrollable } from './lib/scroll-focus';
  import { onMount, tick, untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { Button } from '@smykla-skalski/sui';
  import ActivityStatus from './ActivityStatus.svelte';
  import ElicitationForm, { type Elicitation } from './ElicitationForm.svelte';
  import TaskLocation from './TaskLocation.svelte';
  import Markdown from './Markdown.svelte';
  import ChatMessage from './ChatMessage.svelte';
  import {
    buildTranscript,
    checkItems,
    hookItems,
    nativeItems,
    pendingCoordinationItems,
    queuedItems,
    shellItems,
    subagentItems,
    type TranscriptTool,
    decisionItems,
    latestRevision,
  } from './lib/transcript';
  import { acpPermissionChoices, acpPermissionDetails } from './lib/permission-card';
  import JumpToLatest from './JumpToLatest.svelte';
  import { sharedActivityHistory } from './lib/activity-history';
  import PermissionCard from './PermissionCard.svelte';
  import Transcript from './Transcript.svelte';
  import type { PostTurnCheck } from './lib/post-turn-checks';
  import { activityForSession, parseHookActivity, type HookActivity } from './lib/hook-activity';
  import { toolInput } from './lib/tool-display';
  import { agentHeaderStatus } from './lib/agent-status';
  import {
    acpToolFailure,
    prepareAcpFailureDraft,
    type AcpToolFailure,
  } from './lib/acp-tool-failure';
  import HarnessIcon from './HarnessIcon.svelte';
  import OptionPicker from './OptionPicker.svelte';
  import ComposerHint from './ComposerHint.svelte';
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
    dispatchAuthorizedDirectShipPrompt,
    directShipClaimPrompt,
    type DirectShipAuthorization,
  } from './lib/issue-shipping';
  import {
    agentQueuePaused,
    queuedAgentMessages,
    saveQueuedAgentMessages,
    setAgentQueuePaused,
    type QueuedAgentMessage,
  } from './lib/agent-queue';
  import {
    acp,
    acpDisconnectAffectsSession,
    acpFinishedPromptStatus,
    acpPromptInterrupted,
    groupAgentEntries,
    liveSessionView,
    loadRecentTranscript,
    restoreEntryTimes,
    saveRecentTranscript,
    sessionState,
    takeLiveTranscript,
    trackLiveTranscript,
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
  import type { SpawnReceipt } from './lib/agent-results';
  import {
    parentTurnStopHint,
    permissionAlreadyAnswered,
    permissionResolution,
    permissionResolutionLabel,
    type PermissionResolution,
    type SubagentControl,
  } from './lib/subagent-control';
  import type { BrowserAttachment } from './lib/browser-pick';
  import {
    clipboardFiles,
    insertClipboardText,
    removeClipboardFile,
    stageClipboardFile,
    stageClipboardImage,
  } from './lib/attachments';
  import { coordinationPrompt, type CoordinationMessage } from './lib/coordination';
  import {
    isShellDraft,
    keepShellRuns,
    shellCommand,
    takeShellRuns,
    withShellContext,
    type ShellResult,
    type ShellRun,
  } from './lib/shell-command';
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
  import {
    capabilityProfileForSession,
    intersectCapabilityProfiles,
    permissionPolicy,
    type CapabilityProfile,
  } from './lib/capability-profiles';
  import { permissionChoiceForPolicy, permissionResolver } from './lib/permission-resolution';
  import { nativePlanUpdate, type NativePlan } from './lib/native-plan';
  import { acpPlans } from './lib/acp-plans';
  import { modeAfterPlan } from './lib/plan-engine';
  import {
    loadNativePlan,
    loadStructuredQuestions,
    saveNativePlan,
    saveStructuredQuestions,
  } from './lib/planning-state';
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
    activityReady?: boolean;
    focused?: boolean;
    focusPrompt?: boolean;
    picked?: BrowserAttachment;
    onpickedconsumed?: (id: string) => void;
    onattachmentsent?: (ids: string[], thread: string, turn: string) => void;
    prefill?: { id: string; text: string };
    onprefillconsumed?: (id: string) => void;
    externalPrompt?: { id: string; text: string; leavePlanMode?: boolean };
    onexternalresult?: (id: string, failure: string | null) => void;
    onpromptfocused?: () => void;
    oncreated: (thread: AgentThread) => void;
    onactivity: (thread: AgentThread) => void;
    onstatus: (thread: AgentThread, status: ThreadStatus, notifyOnDone?: boolean) => void;
    onreplaychange?: (agent: AgentId, sessionId: string | null, replaying: boolean) => void;
    onterminal: (id: string) => void;
    onentrieschange?: (entries: AgentEntry[], sessionId: string | null, ready: boolean) => void;
    onnativeplan?: (plan: NativePlan | null) => void;
    planRevision?: { id: string; feedback: string };
    onplanrevisionresult?: (id: string, failure: string | null) => void;
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
      requireClaim?: boolean,
    ) => Promise<DirectShipAuthorization | undefined>;
    nativeEntries?: AgentEntry[];
    /** The child's adapter advertised a prompt capability, so its composer is enabled. */
    childPrompts?: boolean;
    subagentControl?: SubagentControl;
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
    activityReady = true,
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
    onnativeplan,
    planRevision,
    onplanrevisionresult,
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
    childPrompts = false,
    subagentControl,
    capabilityProfile = 'build',
  }: Props = $props();
  const readOnlyChild = $derived(!!nativeEntries && !childPrompts);
  let mounted = $state(false);
  let permissionInventoryRevision = 0;
  const activeCapabilityProfile = $derived(
    capabilityProfileForSession(thread?.capabilityProfile, capabilityProfile, Boolean(thread)),
  );
  const permissionCapabilityProfile = $derived(
    intersectCapabilityProfiles(thread?.capabilityProfile ?? capabilityProfile, capabilityProfile),
  );
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
  const shellMode = $derived(isShellDraft(draft));
  const skillMatches = $derived(shellMode ? [] : matchingSkills(skills, draft));
  let shellRuns = $state<ShellRun[]>([]);
  const pendingShellRuns = $derived(shellRuns.filter((run) => run.session === activeSessionId));
  $effect(() => {
    if (
      !shellMode &&
      skillQuery(draft) !== null &&
      ready &&
      directory &&
      !activeSessionId &&
      !creatingSession
    )
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
      void callback(saved, path, sourceId, model).catch((cause) => (error = describe(cause)));
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
  let showingNativeChild = false;
  let nativePlan = $state<NativePlan | null>(null);
  let planRequested = $state(false);
  let completedTurn = Promise.resolve();
  let lastPlanRevisionId = '';
  let activePlanRevision: {
    id: string;
    feedback: string;
    sessionId: string | null;
    generation: number;
    acceptingUpdates: boolean;
    revisedPlanSeen: boolean;
    reported: boolean;
  } | null = null;
  $effect(() => {
    // Until activate() switches sessions, entries still belong to the parent being left.
    if (nativeEntries && activeSessionId === thread?.sessionId) entries = nativeEntries;
  });
  $effect(() => {
    const revision = planRevision;
    if (!revision || revision.id === lastPlanRevisionId) return;
    lastPlanRevisionId = revision.id;
    void sendPlanRevision(revision);
  });
  let visibleCount = $state(50);
  let historyLoaded = $state(true);
  let historyLoading = $state(false);
  let historyAttempted = $state(false);
  let showingEarlier = false;
  const visibleEntries = $derived(entries.slice(-visibleCount));
  let seenEntryCount = 0;
  $effect(() => {
    const total = entries.length;
    // Growing the tail window keeps older entries from sliding out while the user reads back.
    if (total > seenEntryCount && seenEntryCount > 0 && !autoFollow)
      visibleCount += total - seenEntryCount;
    seenEntryCount = total;
  });
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
  let answeredNotes = $state<{ identity: string; title: string; outcome: PermissionResolution }[]>(
    [],
  );

  // Requests this surface dropped after "no longer pending", kept until their resolution event
  // says how they were settled. The event and the rejection arrive in either order.
  let settledElsewhere: AgentPermission[] = [];

  function noteAnswered(permission: AgentPermission, outcome: PermissionResolution) {
    const identity = acpPermissionIdentity(permission);
    if (answeredNotes.some((note) => note.identity === identity)) return;
    answeredNotes = [...answeredNotes, { identity, title: permission.title, outcome }];
  }
  let elicitations = $state<Elicitation[]>([]);
  let elicitationDrafts = $state<Record<string, Record<string, unknown>>>({});
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
  let autoFollow = $state(true);
  const spawnRevision = $derived(spawnReceipts.map((receipt) => receipt.updated).join(','));
  $effect(() => {
    if (spawnRevision && autoFollow) void follow();
  });
  let prompt: HTMLTextAreaElement;
  const preparedFailures = new Map<string, string>();
  const name = $derived(agentName);
  const transcriptItems = $derived(
    buildTranscript({
      base: nativeItems(groupAgentEntries(visibleEntries), spawnReceipts, {
        name,
        provider: agent,
        toolOutput: (tool) => tool.content || toolInput(tool.output),
      }),
      timed: [
        ...hookItems(visibleHookActivities),
        ...checkItems(postTurnChecks),
        ...(activeSessionId && !ephemeral
          ? decisionItems($sharedActivityHistory, { agent, directory, sessionId: activeSessionId })
          : []),
        ...subagentItems(spawnReceipts),
        ...shellItems(pendingShellRuns),
      ],
      trailing: [
        ...pendingCoordinationItems(
          coordinationMessages.filter(
            (message) =>
              !entries.some(
                (entry) =>
                  entry.type === 'user' && entry.text.includes(coordinationPrompt(message)),
              ),
          ),
          agent,
        ),
        ...queuedItems(
          queued.map((message) => ({
            author: `You · queued${message.attachments.length || message.images.length ? ` · ${message.attachments.length + message.images.length} attachments` : ''}`,
            text: message.text || 'Attachments',
          })),
          agent,
        ),
      ],
    }),
  );
  let liveTurn = $state(false);
  // The app marks a thread done from the turn-finished event, before this pane's prompt call
  // returns; the header follows that event so both settle in the same frame.
  let turnEnded = $state(false);
  const isBusy = $derived(busy || running || historyLoading || liveTurn);
  // What the user sees: a turn the app already marked finished no longer reads busy, so the
  // header, the working row and the pickers settle together.
  const shownBusy = $derived(isBusy && !turnEnded);
  const visibleStatus = $derived(
    agentHeaderStatus({
      connecting,
      ready,
      waiting: permissions.length > 0,
      sending: busy && !turnEnded,
      hasSession: !!activeSessionId,
      running,
      activityReady,
      historyLoading,
      busy: shownBusy,
    }),
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
    if (ready && !busy && !running && !liveTurn && !historyLoaded && !historyAttempted)
      void loadHistory();
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
  function optionValue(options: AgentConfigOption[], pattern: RegExp): string | undefined {
    return options.find(
      (option) => option.type === 'select' && pattern.test(`${option.id} ${option.name}`),
    )?.currentValue;
  }

  function rememberThreadConfig(options: AgentConfigOption[]) {
    if (!thread) return;
    const model = optionValue(options, /model/i);
    const effort = optionValue(options, /effort|reasoning|thinking/i);
    if (model !== undefined || effort !== undefined)
      onactivity({
        ...thread,
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
      });
  }

  async function restoreClaudeThreadConfig(
    options: AgentConfigOption[],
  ): Promise<AgentConfigOption[]> {
    if (agent !== 'claude' || !thread || !activeSessionId) return options;
    const sessionId = activeSessionId;
    const saved = [
      { pattern: /model/i, value: thread.model },
      { pattern: /effort|reasoning|thinking/i, value: thread.effort },
    ];
    return saved.reduce(async (previous, { pattern, value }) => {
      const restored = await previous;
      const option = restored.find(
        (candidate) =>
          candidate.type === 'select' && pattern.test(`${candidate.id} ${candidate.name}`),
      );
      if (
        !value ||
        !option ||
        option.currentValue === value ||
        !option.options.some((choice) => choice.value === value)
      )
        return restored;
      const result = await acp.setConfig(agent, sessionId, option.id, value);
      return (
        result.configOptions ??
        restored.map((candidate) =>
          candidate.id === option.id
            ? Object.assign({}, candidate, { currentValue: value })
            : candidate,
        )
      );
    }, Promise.resolve(options));
  }
  const planModeOption = $derived(
    configOptions.find(
      (option) =>
        option.type === 'select' && option.options.some((choice) => choice.value === 'plan'),
    ),
  );
  let workingMode = $state<string | null>(null);
  let planReviewPlugin = $state<{ source: string; entry: string } | null>(null);

  $effect(() => {
    const value = planModeOption?.currentValue;
    if (value && value !== 'plan') workingMode = value;
  });

  $effect(() => {
    planReviewPlugin = null;
    if (agent !== 'opencode' || !directory) return;
    const path = directory;
    void (async () => {
      try {
        const found = await invoke<{ source: string; entry: string } | null>(
          'opencode_plan_review_plugin',
          { directory: path },
        );
        if (path === directory) planReviewPlugin = found;
      } catch {
        planReviewPlugin = null;
      }
    })();
  });

  async function leavePlanMode() {
    const id = activeSessionId;
    const option = planModeOption;
    planRequested = false;
    if (!id || !option) return;
    const target = modeAfterPlan(option, workingMode);
    if (!target) return;
    if (settingConfig) await settingConfig;
    const result = await acp.setConfig(agent, id, option.id, target);
    configOptions =
      result.configOptions ??
      configOptions.map((item) =>
        item.id === option.id ? Object.assign({}, item, { currentValue: target }) : item,
      );
  }

  $effect(() => {
    if (shownBusy) {
      pickerOpen = null;
      configPickerOpen = null;
    }
  });

  // A busy agent still accepts typing; a prefill focuses so the reply can be queued.
  async function focusPromptWhenReady(whileBusy = false) {
    await tick();
    if (
      !focusPrompt ||
      !focused ||
      (isBusy && !whileBusy) ||
      activeSessionId !== (thread?.sessionId ?? null)
    )
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
    // Wait for the thread switch: activating a session restores its saved draft over the prefill.
    if (!prefill || prefill.id === lastPrefill || activeSessionId !== (thread?.sessionId ?? null))
      return;
    lastPrefill = prefill.id;
    draft = [draft.trim(), prefill.text].filter(Boolean).join('\n\n');
    onprefillconsumed?.(prefill.id);
    void focusPromptWhenReady(true);
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
    void (request.leavePlanMode ? leavePlanMode() : Promise.resolve())
      .then(() => send(request.text))
      .then(
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
    const previousPlan = nativePlan;
    nativePlan = nativePlanUpdate(agent, update, nativePlan);
    if (
      !replaying &&
      nativePlan !== previousPlan &&
      activePlanRevision?.acceptingUpdates &&
      activePlanRevision.sessionId === activeSessionId
    )
      activePlanRevision.revisedPlanSeen = true;
    if (activeSessionId && nativePlan)
      saveNativePlan({ agent, directory, sessionId: activeSessionId }, nativePlan);
    if (activeSessionId && !replaying)
      acpPlans().observe({ agent, directory, sessionId: activeSessionId }, update);
    onnativeplan?.(nativePlan);
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
    if (
      (scroll.scrollHeight <= scroll.clientHeight || scroll.scrollTop <= 80) &&
      entries.length > visibleCount
    )
      void showEarlier();
  }

  async function loadHistory() {
    const id = activeSessionId;
    if (!id || historyLoading || !ready || busy || running || liveTurn || historyAttempted) return;
    const current = generation;
    historyAttempted = true;
    historyLoading = true;
    setReplaying(true);
    replayEntries = [];
    try {
      const session = await acp.load(agent, directory, id, activeCapabilityProfile);
      if (current !== generation) return;
      if (!configOptions.length && Array.isArray(session.configOptions))
        configOptions = session.configOptions as AgentConfigOption[];
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
      profile: permissionCapabilityProfile,
      workspace: directory,
      title,
      toolCall: tool,
      options,
    });
    const details = acpPermissionDetails(tool);
    const permission: AgentPermission = {
      id: message.id,
      sessionId: activeSessionId!,
      title,
      options,
      policy,
      toolCall: tool,
      toolCallId: details.toolCallId,
      command: details.command,
      files: details.files,
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

  function queueElicitation(message: AgentEvent['message']) {
    const params = message.params;
    const sessionId = activeSessionId;
    if (
      !params ||
      !sessionId ||
      params.sessionId !== sessionId ||
      message.id == null ||
      params.mode !== 'form' ||
      !params.requestedSchema ||
      typeof params.requestedSchema !== 'object' ||
      Array.isArray(params.requestedSchema)
    )
      return;
    const schema = params.requestedSchema as Record<string, unknown>;
    const id = String(message.id);
    if (elicitations.some((item) => String(item.id) === id)) return;
    const properties =
      schema.properties &&
      typeof schema.properties === 'object' &&
      !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {};
    elicitationDrafts[id] ??= Object.fromEntries(
      Object.entries(properties).flatMap(([key, property]) =>
        property.default === undefined ? [] : [[key, property.default]],
      ),
    );
    elicitations = [
      ...elicitations,
      { id: message.id, sessionId, message: String(params.message ?? ''), schema },
    ];
    saveStructuredQuestions({ agent, directory, sessionId }, elicitations);
    if (thread) onstatus(thread, 'waiting');
  }

  async function answerElicitation(
    elicitation: Elicitation,
    action: 'accept' | 'decline' | 'cancel',
  ) {
    const id = String(elicitation.id);
    const schema = elicitation.schema;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : [];
    const content = elicitationDrafts[id] ?? {};
    if (action === 'accept')
      for (const key of required)
        if (content[key] === undefined || content[key] === '') {
          error = `${key} is required.`;
          return;
        }
    try {
      await acp.elicitation(
        agent,
        elicitation.id,
        action,
        action === 'accept' ? content : undefined,
      );
      elicitations = elicitations.filter((item) => String(item.id) !== id);
      delete elicitationDrafts[id];
      if (activeSessionId)
        saveStructuredQuestions({ agent, directory, sessionId: activeSessionId }, elicitations);
      if (thread && !elicitations.length && !permissions.length) onstatus(thread, 'working');
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function activate(id: string | null) {
    rememberTranscript();
    const previousSessionId = activeSessionId;
    // Opening a native child leaves the parent running too, so its transcript keeps updating.
    if (previousSessionId && previousSessionId !== id && !ephemeral && !showingNativeChild)
      trackLiveTranscript(agent, previousSessionId, entries, historyLoaded);
    showingNativeChild = !!nativeEntries;
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
    answeredNotes = [];
    settledElsewhere = [];
    selectedThreadId = id;
    activeSessionId = id;
    nativePlan = id ? loadNativePlan({ agent, directory, sessionId: id }) : null;
    elicitations = id ? loadStructuredQuestions({ agent, directory, sessionId: id }) : [];
    elicitationDrafts = {};
    onnativeplan?.(nativePlan);
    entries = id && thread ? loadRecentTranscript(thread) : [];
    const kept = id && !nativeEntries ? takeLiveTranscript(agent, id) : null;
    const liveView =
      id && !nativeEntries ? liveSessionView(entries, kept, sessionState(agent, id)) : null;
    if (liveView) entries = liveView.entries;
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
    liveTurn = false;
    stopRequested = false;
    activeTurnId = null;
    turnEnded = false;
    error = '';
    ready = false;
    connecting = true;
    if (nativeEntries) {
      entries = nativeEntries;
      historyLoaded = true;
      ready = true;
      connecting = false;
      if (id) {
        // A child has no connection of its own to open, but its pending requests still replay here.
        const waiting = await fencedAcpPermissionInventory(
          () => acp.pendingPermissions(agent, id),
          () => permissionInventoryRevision,
          () => current === generation && activeSessionId === id,
        ).catch(() => null);
        if (waiting && current === generation)
          for (const request of waiting) queuePermission(request);
      }
      return;
    }
    try {
      const info = await acp.connect(agent, activeCapabilityProfile);
      if (current !== generation) return;
      authMethods = (info.authMethods as AgentAuthMethod[] | undefined) ?? [];
      if (id) {
        const capabilities = info.agentCapabilities;
        const canLoad =
          capabilities && typeof capabilities === 'object' && 'loadSession' in capabilities
            ? capabilities.loadSession
            : false;
        if (!canLoad) throw new Error(`${name} does not support restoring threads.`);
        const runtime = (await acp.activity().catch(() => null))?.[agent];
        if (current !== generation) return;
        const runningTurn = runtime?.alive ? runtime.activeTurns[id] : undefined;
        if (liveView && runningTurn !== undefined) {
          liveTurn = true;
          activeTurnId = runningTurn;
          historyLoaded = liveView.complete;
          configOptions = await restoreClaudeThreadConfig(liveView.configOptions);
          rememberThreadConfig(configOptions);
          if (liveView.availableCommands) updateSkills(liveView.availableCommands);
          if (commandUpdates[id]) updateSkills(commandUpdates[id]);
          const latest = (await acp.activity().catch(() => null))?.[agent];
          if (current === generation && latest?.activeTurns[id] !== runningTurn) {
            liveTurn = false;
            activeTurnId = null;
          }
        } else {
          const sessionCapabilities =
            capabilities &&
            typeof capabilities === 'object' &&
            'sessionCapabilities' in capabilities
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
            configOptions = await restoreClaudeThreadConfig(
              (session.configOptions as AgentConfigOption[] | undefined) ?? [],
            );
            rememberThreadConfig(configOptions);
          }
          if (current === generation && Array.isArray(session.availableCommands))
            updateSkills(session.availableCommands);
          if (current === generation && commandUpdates[id]) updateSkills(commandUpdates[id]);
        }
        const waiting = await fencedAcpPermissionInventory(
          () => acp.pendingPermissions(agent, id),
          () => permissionInventoryRevision,
          () => current === generation && activeSessionId === id,
        );
        if (waiting) for (const request of waiting) queuePermission(request);
        const pendingElicitations = await acp.pendingElicitations(agent, id).then(
          (requests) => ({ requests, available: true }),
          () => ({ requests: [], available: false }),
        );
        if (current === generation && activeSessionId === id && pendingElicitations.available) {
          const pendingIDs = new Set(
            pendingElicitations.requests.flatMap((request) =>
              request.method === 'elicitation/create' && request.id != null
                ? [String(request.id)]
                : [],
            ),
          );
          elicitations = elicitations.filter((item) => pendingIDs.has(String(item.id)));
          for (const request of pendingElicitations.requests) queueElicitation(request);
          saveStructuredQuestions({ agent, directory, sessionId: id }, elicitations);
        }
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
        model: optionValue(session.configOptions ?? [], /model/i),
        effort: optionValue(session.configOptions ?? [], /effort|reasoning|thinking/i),
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
      for (const run of shellRuns) if (run.session === null) run.session = session.sessionId;
      if (queued.length) saveQueuedAgentMessages(agent, directory, session.sessionId, queued);
      if (commandUpdates[session.sessionId]) updateSkills(commandUpdates[session.sessionId]);
      selectedThreadId = session.sessionId;
      oncreated(created);
      // The header turns Working with the session, so the app learns of the turn in that flush.
      if (forTurn) onstatus(created, 'working');
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
    if (!ready || !directory || shownBusy) return;
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
    if (!ephemeral) shellRuns = takeShellRuns(`${directory}\0${agent}`);
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
      if (
        message.method === 'sail/disconnected' &&
        acpDisconnectAffectsSession(message, activeSessionId, activeCapabilityProfile)
      ) {
        inFlightSteer?.finish();
        if (activeSessionId) {
          elicitations = [];
          elicitationDrafts = {};
          saveStructuredQuestions({ agent, directory, sessionId: activeSessionId }, []);
        }
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
        if (
          busy &&
          params.sessionId === activeSessionId &&
          typeof params.turnId === 'string' &&
          params.turnId === activeTurnId
        )
          turnEnded = true;
        if (
          liveTurn &&
          params.sessionId === activeSessionId &&
          (typeof params.turnId !== 'string' || params.turnId === activeTurnId)
        ) {
          liveTurn = false;
          activeTurnId = null;
        }
        discardSteeredAttachments(params.sessionId);
        const steer = inFlightSteer;
        if (
          steer?.sessionId === params.sessionId &&
          (!steer.turnId || steer.turnId === params.turnId)
        )
          steer.finish();
      }
      if (message.method === '$/cancel_request') {
        const id = params?.id;
        if (typeof id === 'string' || typeof id === 'number') {
          elicitations = elicitations.filter((item) => String(item.id) !== String(id));
          delete elicitationDrafts[String(id)];
          if (activeSessionId)
            saveStructuredQuestions({ agent, directory, sessionId: activeSessionId }, elicitations);
        }
        return;
      }
      if (!params || params.sessionId !== activeSessionId) return;
      if (message.method === 'sail/permission_resolved') {
        if (
          (typeof params.requestId !== 'string' && typeof params.requestId !== 'number') ||
          typeof params.sessionId !== 'string'
        )
          return;
        permissionInventoryRevision++;
        const shown = permissions;
        const resolvedIdentity = {
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
        };
        permissions = removeResolvedAcpPermission(permissions, resolvedIdentity);
        const outcome = permissionResolution(params);
        for (const gone of shown) if (!permissions.includes(gone)) noteAnswered(gone, outcome);
        const waiting = settledElsewhere;
        settledElsewhere = removeResolvedAcpPermission(waiting, resolvedIdentity);
        for (const gone of waiting)
          if (!settledElsewhere.includes(gone)) noteAnswered(gone, outcome);
        if (thread && running && permissions.length === 0) onstatus(thread, 'working');
      } else if (message.method === 'session/update') {
        const update = params.update;
        if (!update || typeof update !== 'object') return;
        const data = update as Record<string, unknown>;
        if (data.sessionUpdate === 'config_option_update' && Array.isArray(data.configOptions)) {
          configOptions = data.configOptions as AgentConfigOption[];
          if (settingConfig) {
            rememberThreadConfig(configOptions);
          } else
            void restoreClaudeThreadConfig(configOptions)
              .then((restored) => {
                if (activeSessionId !== params.sessionId) return undefined;
                configOptions = restored;
                rememberThreadConfig(restored);
                return undefined;
              })
              .catch((cause) => {
                if (activeSessionId === params.sessionId) error = describe(cause);
              });
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
      } else if (message.method === 'elicitation/create' && message.id != null) {
        queueElicitation(message);
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
      if (activeSessionId && !nativeEntries && !ephemeral)
        trackLiveTranscript(agent, activeSessionId, entries, historyLoaded);
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
      if (ephemeral) shellRuns.filter((run) => run.status === 'running').forEach(stopShell);
      else keepShellRuns(`${directory}\0${agent}`, shellRuns);
    };
  });

  async function send(
    externalText?: string,
    queuedMessage?: QueuedAgentMessage,
    forcePlan = false,
    onPromptDispatch?: () => void,
  ) {
    if (externalText === undefined) await pendingPaste;
    const external = externalText !== undefined;
    const text =
      (externalText ?? draft).trim() ||
      (!external && clipboardAttachments.length ? 'Please review the attachments.' : '');
    const shell = external ? null : shellCommand(text);
    if (shell !== null) {
      if (shell && directory) {
        draft = '';
        void runShell(shell);
      }
      return;
    }
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
      !shownBusy &&
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
    let finishTurn!: () => void;
    completedTurn = new Promise<void>((resolve) => (finishTurn = resolve));
    activeTurnId = turnId;
    turnEnded = false;
    let activityThread = thread;
    let finalStatus: ThreadStatus = 'done';
    let notifyOnDone = true;
    let keepImages = false;
    let phase: 'session' | 'config' | 'snapshot' | 'prompt' = 'session';
    let directClaim = '';
    let directAuthorization: DirectShipAuthorization | undefined;
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
    const shellSession = activeSessionId;
    const sentShell =
      external && !queuedMessage
        ? []
        : shellRuns.filter((run) => run.session === shellSession && run.status !== 'running');
    shellRuns = shellRuns.filter((run) => !sentShell.includes(run));
    const restoreShell = () => {
      const session = deliverySessionId ?? shellSession;
      for (const run of sentShell) run.session = session;
      shellRuns = [...sentShell, ...shellRuns];
    };
    flushUpdates();
    entries = [
      ...entries,
      {
        id: userEntryId,
        type: 'user',
        text: withShellContext(sentShell, text),
        created: Date.now(),
      },
    ];
    void follow();
    try {
      if (!activeSessionId || !activityThread)
        activityThread = await ensureSession(text.slice(0, 60) || 'Attached files', true);
      if (activityThread?.title === 'New thread')
        activityThread = { ...activityThread, title: text.slice(0, 60) || 'Attached files' };
      if (current !== generation && (!disposed || ephemeral)) {
        restoreShell();
        return;
      }
      if (activityThread) onstatus(activityThread, 'working');
      phase = 'config';
      if (settingConfig) await settingConfig;
      if (configFailure) throw new Error(configFailure);
      if (activityThread)
        onactivity({ ...activityThread, model: modelOption?.currentValue || activityThread.model });
      const id = activityThread?.sessionId ?? activeSessionId;
      deliverySessionId = id;
      if (planRequested || forcePlan) {
        if (!id || !planModeOption)
          throw new Error(`${name} does not expose a planning mode for this session.`);
        const result = await acp.setConfig(turnAgent, id, planModeOption.id, 'plan');
        configOptions = result.configOptions ?? configOptions;
      }
      if (shipIssue && id && !ephemeral) {
        recordShipItOwner(turnDirectory, `acp:${turnAgent}:${id}`);
        directAuthorization = await onshipit?.(
          shipIssue,
          turnDirectory,
          `acp:${turnAgent}:${id}`,
          modelOption?.currentValue,
          true,
        );
        if (!directAuthorization) throw new Error('Direct shipping claim was not acquired.');
        directClaim = directShipClaimPrompt(directAuthorization.claim);
      }
      if (stopRequested) {
        finalStatus = 'interrupted';
        notifyOnDone = false;
        if (external && !queuedMessage) throw new Error('Agent turn was cancelled.');
        restoreShell();
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
      const promptText = withShellContext(
        sentShell,
        ephemeral && seedContext && entries.length === 1
          ? `Read-only context from the parent thread:\n${seedContext}\n\nSide question: ${skillText}`
          : skillText + directClaim,
      );
      if (stopRequested) throw new Error('Agent turn was cancelled.');
      phase = 'prompt';
      onPromptDispatch?.();
      if (id && sentImages.length)
        onattachmentsent?.(
          sentImages.map((image) => image.id),
          `acp:${turnAgent}:${id}`,
          turnId,
        );
      let result;
      try {
        result = await dispatchAuthorizedDirectShipPrompt(directAuthorization, () =>
          acp.prompt(
            turnAgent,
            id!,
            withAttachedFiles(promptText, sentClipboard),
            turnId,
            promptImagePaths(sentImages, sentClipboard),
          ),
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
      restoreShell();
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
        if (external && !queuedMessage && phase !== 'prompt')
          entries = entries.filter((entry) => entry.id !== userEntryId);
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
      // Clear busy first so the header and the status bar settle in the same frame.
      if (current === generation) {
        busy = false;
        turnEnded = false;
      }
      if (activityThread) onstatus(activityThread, finalStatus, notifyOnDone);
      finishTurn();
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
    return finalStatus;
  }

  async function sendPlanRevision(revision: { id: string; feedback: string }) {
    const request = {
      ...revision,
      sessionId: activeSessionId,
      generation,
      acceptingUpdates: false,
      revisedPlanSeen: false,
      reported: false,
    };
    activePlanRevision = request;
    try {
      // A native plan is emitted before its prompt settles. A revision is a
      // new ACP prompt, never a steering request into the planning turn.
      await completedTurn;
      if (request.reported) return;
      if (
        disposed ||
        !request.sessionId ||
        activeSessionId !== request.sessionId ||
        generation !== request.generation ||
        !nativePlan
      )
        throw new Error('The native plan is no longer available in this session.');
      const status = await send(revision.feedback, undefined, true, () => {
        request.acceptingUpdates = true;
      });
      if (status !== 'done' || stopRequested) throw new Error('Plan revision was cancelled.');
      if (!request.revisedPlanSeen) throw new Error('The agent did not provide a revised plan.');
      reportPlanRevision(revision.id, null);
    } catch (cause) {
      reportPlanRevision(revision.id, describe(cause));
    } finally {
      if (activePlanRevision?.id === revision.id) activePlanRevision = null;
    }
  }

  function reportPlanRevision(id: string, failure: string | null) {
    if (!activePlanRevision || activePlanRevision.id !== id || activePlanRevision.reported) return;
    activePlanRevision.reported = true;
    onplanrevisionresult?.(id, failure);
  }

  async function runShell(command: string) {
    const run: ShellRun = {
      id: crypto.randomUUID(),
      directory,
      session: activeSessionId,
      command,
      status: 'running',
      code: null,
      output: '',
      created: Date.now(),
    };
    shellRuns = [...shellRuns, run];
    void follow();
    let result: Partial<ShellRun>;
    try {
      result = await invoke<ShellResult>('run_shell_command', { id: run.id, directory, command });
    } catch (cause) {
      result = { status: 'failed', output: describe(cause) };
    }
    const finished = shellRuns.find((item) => item.id === run.id);
    if (finished) Object.assign(finished, result);
    if (!disposed) void follow();
  }

  function stopShell(run: ShellRun) {
    void invoke('cancel_shell_command', { id: run.id }).catch(() => {});
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
    if (activePlanRevision)
      reportPlanRevision(activePlanRevision.id, 'Plan revision was cancelled.');
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
      // Cancelling the session already settles its pending requests in the backend.
      await Promise.all(
        pending.map((permission) =>
          acp
            .permission(
              agent,
              permission.id,
              null,
              permission.sessionId,
              permission.generation,
              permission.fingerprint,
            )
            .catch((cause: unknown) => {
              if (!permissionAlreadyAnswered(cause)) throw cause;
            }),
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
      const policy = livePermissionPolicy(permission);
      const settledOptionId = permissionChoiceForPolicy(policy, permission.options, optionId);
      await permissionResolver.resolve({
        key: `acp:${agent}:${permission.sessionId}:${permission.id}`,
        generation: permission.fingerprint ?? permission.generation ?? permission.sessionId,
        policy,
        optionId: settledOptionId,
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
      noteAnswered(permission, 'answered');
    } catch (cause) {
      if (permissionAlreadyAnswered(cause)) {
        // Settled elsewhere; its resolution event records whether it was answered or cancelled.
        if (permissions.some((item) => acpPermissionIdentity(item) === identity))
          settledElsewhere = [...settledElsewhere, permission].slice(-20);
        permissions = permissions.filter((item) => acpPermissionIdentity(item) !== identity);
        if (thread && lastRequest) onstatus(thread, 'working');
        return;
      }
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

  function livePermissionPolicy(permission: AgentPermission) {
    return permissionPolicy({
      profile: permissionCapabilityProfile,
      workspace: directory,
      title: permission.title,
      toolCall: permission.toolCall ?? {},
      options: permission.options,
    });
  }

  function setConfig(configId: string, value: string) {
    if (!activeSessionId || shownBusy) return;
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
        rememberThreadConfig(configOptions);
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
      await acp.authenticate(agent, methodId, activeCapabilityProfile);
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
      role="region"
      bind:this={scroll}
      {@attach keyboardScrollable}
      onscroll={() => {
        autoFollow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
        if (scroll.scrollTop <= 80 && !historyLoading) void showEarlier();
      }}
      onwheel={(event) => {
        if (event.deltaY < 0 && scroll.scrollTop <= 80 && !historyLoading) void showEarlier();
      }}
      aria-label={`${name} conversation`}
    >
      {#if entries.length === 0 && !connecting && !historyLoading && !liveTurn}
        <div class="agent-welcome">
          <h1>Work with {name}</h1>
          <p>Describe the work. Sail will show messages, tools, and approvals here.</p>
        </div>
      {/if}
      {#if historyLoading}<div class="agent-history-status" role="status">
          Loading history…
        </div>{:else if liveTurn && !historyLoaded && !nativeEntries}<div
          class="agent-history-status agent-history-gap"
          role="note"
        >
          Earlier messages load when this turn ends.
        </div>{/if}
      {#snippet failureTool(item: TranscriptTool)}
        {@const tool = item.raw as AgentTool}
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
      <Transcript
        items={transcriptItems}
        busy={shownBusy}
        {coordinationMessages}
        onopen={onopensubagent}
        control={subagentControl}
        {onterminal}
        {onretrycheck}
        onstopshell={stopShell}
        failure={failureTool}
      >
        {#snippet queuedActions()}
          {#if queuePaused}<Button size="sm" variant="secondary" onclick={retryQueue}
              >Retry queue</Button
            >{/if}
        {/snippet}
        {#snippet tail()}
          {#if nativePlan}<section class="native-plan" aria-label="Native plan">
              <h3>Plan</h3>
              <Markdown source={nativePlan.markdown} />
              {#if nativePlan.tasks.length}<ul>
                  {#each nativePlan.tasks as task (`${task.status}:${task.title}`)}<li>
                      {task.status}: {task.title}
                    </li>{/each}
                </ul>{/if}
            </section>{/if}
          {#if shownBusy}<ChatMessage kind="assistant" author={name} provider={agent}>
              <div class="agent-busy" role="status">
                <ActivityStatus status={visibleStatus} />{#if !nativeEntries}<Button
                    size="sm"
                    variant="secondary"
                    onclick={stop}>Stop</Button
                  >{/if}
              </div>
            </ChatMessage>{/if}
        {/snippet}
      </Transcript>
      <JumpToLatest
        following={autoFollow}
        count={transcriptItems.length}
        revision={latestRevision(transcriptItems)}
        onjump={() => {
          autoFollow = true;
          void follow();
        }}
      />
    </div>
  </div>
  <div class="agent-composer composer-wrap">
    <div class="composer" class:shell-mode={shellMode}>
      <TaskLocation location={promptLocation} />
      {#if shellMode}<p class="composer-shell-hint" role="status">
          Shell mode · Enter runs the command in this worktree
        </p>{/if}
      {#if planReviewPlugin}<p class="agent-warning" role="status">
          The OpenCode plan-review plugin is still enabled ({planReviewPlugin.entry} in
          {planReviewPlugin.source}). OpenCode sees its plan tools next to Sail's sail_plan_* tools.
          Remove the plugin from your OpenCode config; Sail reviews plans for every agent itself.
        </p>{/if}
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
        {@const livePolicy = livePermissionPolicy(permission)}
        <PermissionCard
          title={permission.title}
          policy={livePolicy}
          command={permission.command}
          files={permission.files}
          toolCallId={permission.toolCallId}
          requestId={permission.id}
          sessionId={permission.sessionId}
          agentId={agent}
          choices={acpPermissionChoices(permission.options, livePolicy)}
          onchoose={(choice) => answer(permission, choice.id)}
        />
      {/each}
      {#each answeredNotes as note (note.identity)}
        <p class="agent-permission-answered" role="status" data-answered-id={note.identity}>
          {permissionResolutionLabel(note.outcome)} · {note.title}
        </p>
      {/each}
      {#if nativeEntries}
        <p class="agent-readonly" role="status">
          {#if readOnlyChild}Read-only: the agent doesn't accept messages for subagents yet.
            {parentTurnStopHint}.{:else}This subagent accepts messages.{/if}
        </p>
      {/if}
      {#each elicitations as elicitation (elicitation.id)}
        <ElicitationForm
          {elicitation}
          {agent}
          onanswer={(request, action, content) => {
            if (content) elicitationDrafts[String(request.id)] = content;
            return answerElicitation(request, action);
          }}
        />
      {/each}
      <textarea
        bind:this={prompt}
        data-pane-prompt
        role="combobox"
        aria-autocomplete="list"
        aria-label={`Message ${name}`}
        aria-describedby={`${skillMenuId}-hint`}
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
        placeholder={`Message ${name}… (start with ! to run a shell command)`}
        disabled={!directory || readOnlyChild}></textarea>
      <ComposerHint id={`${skillMenuId}-hint`} />
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
            disabled={!ready || shownBusy || !directory || readOnlyChild}
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
            disabled={!ready || shownBusy || !directory || readOnlyChild}
            loading={!!creatingSession}
            onopen={() => void openPicker('effort')}
            onclose={() => (pickerOpen = null)}
            onchoose={(value) => {
              if (effortOption) void setConfig(effortOption.id, value);
            }}
          />
        </div>
        <div class="agent-actions">
          {#if planModeOption}<Button
              size="sm"
              variant={planRequested ? 'primary' : 'secondary'}
              onclick={() => (planRequested = !planRequested)}
              disabled={!ready || isBusy || readOnlyChild}>Plan</Button
            >{/if}
          <Button
            onclick={() => void send()}
            disabled={shellMode
              ? !shellCommand(draft) || !directory || readOnlyChild
              : !ready || readOnlyChild || (!draft.trim() && !clipboardAttachments.length)}
            >{shellMode ? 'Run ↵' : isBusy ? 'Queue ↗' : 'Send ↗'}</Button
          >
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .agent-permission-answered,
  .agent-readonly {
    margin: 0;
    color: var(--sui-muted);
    font-size: 0.8rem;
  }
  .native-plan {
    margin: 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--shell-divider);
    border-radius: 0.5rem;
  }
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
    border-bottom: 1px solid var(--shell-divider);
  }
  .agent-header div {
    display: flex;
    gap: var(--space-12);
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
    font-size: var(--type-12);
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
    gap: var(--space-4);
    min-width: 0;
  }
  .agent-composer-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-8);
    padding: 0 9px 9px 10px;
  }
  .agent-header .agent-config {
    display: flex;
    gap: var(--space-8);
    flex-wrap: wrap;
    margin-left: auto;
    margin-right: 12px;
  }
  .agent-conversation {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding-inline: var(--transcript-gutter);
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
  .agent-tool-failure {
    margin: 0 0 8px 42px;
    padding: 9px 12px;
    border: 1px solid var(--sui-danger);
    border-radius: var(--radius-8);
    overflow-wrap: anywhere;
  }
  .agent-tool-failure strong {
    color: var(--sui-danger-ink);
  }
  .agent-tool-failure > div,
  .agent-tool-failure details {
    margin: 5px 0;
  }
  .agent-tool-failure span {
    color: var(--sui-muted);
  }
  .agent-tool-failure pre {
    max-height: 180px;
    overflow: auto;
    white-space: pre-wrap;
  }
  .agent-busy {
    display: flex;
    align-items: center;
    gap: var(--space-12);
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
    color: var(--sui-danger-ink);
  }
  .agent-warning {
    margin: 0;
    color: var(--sui-warning-ink);
    font-size: var(--type-12);
  }
</style>
