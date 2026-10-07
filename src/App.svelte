<script lang="ts">
  class ValidationCandidateUnavailable extends Error {
    constructor(message: string, cause?: unknown) {
      super(cause === undefined ? message : `${message}: ${describe(cause)}`, { cause });
    }
  }

  import { onMount, tick } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { emitTo, listen } from '@tauri-apps/api/event';
  import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { isPermissionNotFoundError, isSessionNotFoundError } from '@opencode/client';
  import type { FormInfo, PermissionRequest } from '@opencode/client';
  import type { ModelRef } from '@opencode/client';
  import type { BrowserAttachment } from './lib/browser-pick';
  import { Button } from '@smykla-skalski/sui';
  import ActivityStatus from './ActivityStatus.svelte';
  import TaskLocation from './TaskLocation.svelte';
  import WorkspaceActivity from './WorkspaceActivity.svelte';
  import { workspaceActivityItems, type WorkspaceActivityItem } from './lib/workspace-activity';
  import {
    loadActivityHistory,
    recentActivityEvents,
    saveActivityHistory,
    type ActivityHistoryEvent,
    type ActivityHistoryInput,
  } from './lib/activity-history';
  import Markdown from './Markdown.svelte';
  import SpawnActivity from './SpawnActivity.svelte';
  import SpawnResponse from './SpawnResponse.svelte';
  import ToolActivity from './ToolActivity.svelte';
  import ChatMessage from './ChatMessage.svelte';
  import OpenCodeSubagents from './OpenCodeSubagents.svelte';
  import PlanPanel from './PlanPanel.svelte';
  import ShipPanel from './ShipPanel.svelte';
  import {
    appendShipEvent,
    gateSnapshot,
    loadShipRuns,
    parseShipReport,
    refreshedIssueState,
    refreshedPullRequest,
    shipGatesSettled,
    shipTaskThreadsSettled,
    reconciledShipGates,
    persistShipRefresh,
    settleShipRefresh,
    type ShippingPullRequest,
    shipOwner,
    shipCheckpointOwner,
    authorizeShipCheckpointThread,
    validateGateVerdict,
  } from './lib/ship-progress';
  import type { PublishedGraph } from './lib/issue-graph';
  import {
    adoptDirectShipRun as createDirectShipRun,
    createShipRun,
    isDirectShipRun,
    readyShipIssues,
    resolvedWorkerModel,
    shippingWorkerSettled,
    shippingSetupAction,
    type ShipIssue,
    type ShipRun,
  } from './lib/issue-shipping';
  import type { ShipItIssue } from './lib/implementation-models';
  import {
    initialTaskCheckpoint,
    prepareTaskCheckpointUpdate,
    reconcileTaskCheckpoint,
  } from './lib/task-checkpoint.ts';
  import DiffPanel from './DiffPanel.svelte';
  import PromptPanel from './PromptPanel.svelte';
  import ProjectSidebar from './ProjectSidebar.svelte';
  import TaskOverview from './TaskOverview.svelte';
  import type { GitHubIssue, PullRequestCheck } from './ProjectSidebar.svelte';
  import AgentWorkspace from './AgentWorkspace.svelte';
  import AgentStatusBar from './AgentStatusBar.svelte';
  import {
    composerTaskLocation,
    resolveTaskLocation,
    type TaskLocation as TaskLocationValue,
  } from './lib/task-location';
  import PostTurnChecks from './PostTurnChecks.svelte';
  import {
    checkKey,
    personalChecks,
    upsertCheck,
    type PostTurnCheck,
  } from './lib/post-turn-checks';
  import HarnessIcon from './HarnessIcon.svelte';
  import OptionPicker from './OptionPicker.svelte';
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
  import { parseValidationSettings, validationSettingsKey } from './lib/cross-validation';
  import {
    hasUnresolvedModelAlias,
    selectValidationChoice,
    type ValidationChoice,
  } from './lib/cross-validation';
  import {
    abandonImplementationTurn,
    activeImplementationModels,
    beginImplementationTurn,
    beginShipItRun,
    claimLegacyPendingImplementationTurn,
    hasPendingImplementationTurn,
    implementationAttributionUncertain,
    implementationModels,
    recordShipItOwner,
    recoverImplementationModels,
    savedShipItIssue,
    savedShipItOwner,
    settledImplementationAttribution,
    recordImplementationModel,
  } from './lib/implementation-models';
  import { runSerialOpenCodeTurn } from './lib/opencode-turns';
  import {
    prepareToolFailureDraft,
    openCodeErrorDetails,
    reportedHookIdentity,
    toolFailurePrompt,
  } from './lib/tool-failure';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import type { Confirmation } from './ConfirmDialog.svelte';
  import PathPicker from './PathPicker.svelte';
  import PaneTree from './PaneTree.svelte';
  import InboxPanel from './InboxPanel.svelte';
  import {
    failedCheckOutcome,
    inboxLocations,
    inboxTurnMessageIndex,
    isInboxOutcome,
    loadInboxOutcomes,
    loadInboxSeen,
    markInboxOutcomeRead,
    maxInboxSeen,
    openCodeRequestTime,
    recordInboxOutcome,
    sortInbox,
    type InboxItem,
    type InboxCheck,
    type InboxOutcome,
  } from './lib/inbox';
  import {
    locationName,
    searchCommandPalette,
    type PaletteEntry,
    type PaletteOpenCodeSession,
    type PaletteStep,
  } from './lib/command-palette';
  import {
    loadRecentNativeThreads,
    loadRecentThreadKeys,
    migrateRecentThreadKeys,
    nextRecentIndex,
    retainRecentThreads,
    threadKey,
    touchRecentThread,
  } from './lib/recent-threads';
  import {
    groupSidebarThreads,
    listSidebarOpenCodeThreads,
    sidebarThreadStatus,
  } from './lib/sidebar-agents';
  import {
    loadAttention,
    markAttentionRead,
    preserveAttentionOnCheckOpen,
    reconcileAttention,
    updateAttention,
    type AttentionMap,
    type ThreadStatus,
  } from './lib/attention';
  import {
    adjacentPaneId,
    closePane,
    leaves,
    loadPaneLayouts,
    mainPane,
    minPaneSpan,
    migratePaneDirectory,
    newBrowserTab,
    splitPane,
    terminalRuntimeId,
    updatePane,
    type BrowserTab,
    type Pane,
    type SideChat,
  } from './lib/panes';
  import {
    acp,
    forgetRecentTranscript,
    loadAgentThreads,
    loadInterruptedAgentTurns,
    loadRecentTranscript,
    saveAgentThreads,
    updateEntriesInPlace,
    type AgentEntry,
    type AgentAvailability,
    type AgentEvent,
    type AgentId,
    type AgentThread,
    type InterruptedAgentTurn,
  } from './lib/acp';
  import {
    compatibleOpenCodeVersion,
    connect,
    OPENCODE_VERSION,
    type OpenCodeClient,
    type RuntimeInfo,
    type SessionInfo,
    type SessionMessageInfo,
  } from './lib/opencode';
  import { recordDiagnostic } from './lib/diagnostics';
  import { getPlan, type PlanSnapshot } from './lib/plan';
  import { mergeMessages, nearBottom } from './lib/timeline';
  import {
    cachedOpenCodeTimelines,
    forgetOpenCodeTimeline,
    recallOpenCodeTimeline,
    rememberOpenCodeTimeline,
  } from './lib/opencode-timeline-cache';
  import {
    clipboardFiles,
    fileUri,
    insertClipboardText,
    removeClipboardFile,
    stageClipboardFile,
  } from './lib/attachments';
  import { copyCompletedSelection } from './lib/auto-copy';
  import {
    coordinationKey,
    coordinationMessageForText,
    coordinationPrompt,
    enqueueCoordinationMessage,
    loadCoordinationMessages,
    projectWorktreeInfo,
    type CoordinationMessage,
    type RegisteredWorktree,
  } from './lib/coordination';
  import {
    acpReceiptState,
    activeSubagentsForSource,
    loadSpawnReceipts,
    receiptForSource,
    receiptNeedsRefresh,
    receiptIsSettled,
    receiptSourceId,
    saveBoundedReceipt,
    spawnReceiptsForSource,
    withSpawnResponses,
    type SpawnReceipt,
    type SpawnState,
  } from './lib/agent-results';
  import {
    disconnectNativeSubagents,
    finalizeNativeSubagentRestore,
    nativeSubagentId,
    nativeSubagentReceipts,
    nativeSubagentThreads as threadsForNativeSubagents,
    setNativeSubagentWaiting,
    updateNativeSubagents,
    type NativeSubagentStore,
  } from './lib/native-subagents';
  import {
    getSetting,
    removeSetting,
    setSetting,
    setSettingDurable,
    settingsError,
  } from './lib/settings';
  import {
    commandsForDirectory,
    loadSavedCommands,
    selectedRepository,
    type SavedCommand,
  } from './lib/saved-commands';
  import { annotateDiffs, repoPath, selectedDiffFile, type WorkingDiffInfo } from './lib/diff';
  import type { DiffComment } from './lib/diff-comments';
  import {
    browserReviewPreviews,
    retainCaptureMetadata,
    selectReviewPreview,
    type ReviewCapture,
    type ReviewPreview,
  } from './lib/review-evidence';
  import { inspectRepository, type SetupReport } from './lib/onboarding';
  import {
    acpUsage,
    openCodeContextUsage,
    type AgentUsage,
    type RateWindow,
  } from './lib/agent-usage';
  import { buildAgentStatusItems } from './lib/agent-status';
  import {
    settingsAction,
    settingsRequest,
    settingsState,
    type SettingsAction,
    type SettingsSnapshot,
  } from './lib/settings-window';
  import {
    addWorktree,
    assignRepository,
    loadProjectCatalog,
    removeRepository,
    removeWorktree,
    worktreeAt,
    replaceRepositoryPath,
    setWorktreePullRequest,
    setWorktreeSetupStatus,
    setWorktreeStatus,
    type ProjectCatalog,
    type ProjectWorktree,
    type WorktreeCreation,
  } from './lib/projects';

  let dark = $state(getSetting('sai-theme') === 'dark');
  const savedAgentThreads = loadAgentThreads();
  const startupInterruptedTurns = loadInterruptedAgentTurns(
    getSetting('sai-interrupted-agent-turns'),
  );
  const savedNativeThreads = loadRecentNativeThreads(getSetting('sai-recent-native-threads'));
  const savedDirectory =
    getSetting('sai-directory') ??
    savedAgentThreads[0]?.directory ??
    savedNativeThreads[0]?.directory ??
    '';
  let directory = $state(savedDirectory);
  let projectCatalog = $state<ProjectCatalog>(
    loadProjectCatalog(getSetting('sai-project-catalog'), savedDirectory),
  );
  let taskLocation = $state<TaskLocationValue>(resolveTaskLocation(savedDirectory, '', null));
  let taskLocationGeneration = 0;
  $effect(() => {
    const path = directory;
    const repository = coordinationProject(path) ?? '';
    const generation = ++taskLocationGeneration;
    taskLocation = resolveTaskLocation(path, repository, null);
    if (!path || !repository || !isTauri()) return;
    void invoke<RegisteredWorktree[]>('registered_worktrees', {
      repository,
      paths: [path],
    })
      .then((registered) => {
        if (generation !== taskLocationGeneration || path !== directory) return taskLocation;
        taskLocation = resolveTaskLocation(
          path,
          repository,
          registered.find((item) => item.path === path)?.branch,
        );
        return taskLocation;
      })
      .catch(() => {
        if (generation === taskLocationGeneration && path === directory)
          taskLocation = resolveTaskLocation(path, repository, null);
        return taskLocation;
      });
  });
  let shipRuns = $state<ShipRun[]>(loadShipRuns(getSetting('sai-ship-runs')));
  let shippingBusy = $state(false);
  const activeShipLaunches = new SvelteSet<string>();
  let acpRecoveryReady = false;
  let worktreeCreations = $state<WorktreeCreation[]>([]);
  let worktreeDeletions = $state<Record<string, string>>({});
  type WorktreeCreationRequest = {
    repository: string;
    name: string;
    destinationParent: string | null;
    baseRef: string | null;
    agent: string | null;
    issue: GitHubIssue | null;
    initialDirectory: string;
    initialSelection: number;
  };
  const worktreeCreationRequests = new SvelteMap<string, WorktreeCreationRequest>();
  type CreatedWorktree = { path: string; branch: string; base: string; setup: string };
  type PendingWorktreeStart = {
    repository: string;
    created: CreatedWorktree;
    agent: string | null;
    issuePrompt: string | null;
  };
  const pendingWorktreeStarts = new SvelteMap<string, PendingWorktreeStart>();
  const runningWorktreeSetups = new SvelteSet<string>();
  let savedCommands = $state<SavedCommand[]>(loadSavedCommands(getSetting('sai-saved-commands')));
  let pendingCommands = $state<Record<string, string>>({});
  let browserAccessDisabled = $state(
    getSetting(`sai-browser-disabled:${savedDirectory}`) === 'true',
  );
  const openCodeBrowserServers = new SvelteSet<string>();
  type BrowserMcpConfig = { command: string; args: string[]; env: Record<string, string> };
  type BrowserAccessRequest = { id: string; sessionId: string; directory: string; origin?: string };
  type CoordinationRequest = {
    id: string;
    sessionId: string;
    sourceAgent: string | null;
    directory: string;
    name:
      | 'worktree_create'
      | 'agent_spawn'
      | 'validation_gate'
      | 'ship_progress'
      | 'task_checkpoint_read'
      | 'task_checkpoint_update'
      | 'agent_status'
      | 'agent_wait'
      | 'agent_result'
      | 'terminal_list'
      | 'terminal_read'
      | 'terminal_wait'
      | 'terminal_create'
      | 'terminal_write'
      | 'terminal_stop'
      | 'worktree_list'
      | 'worktree_info'
      | 'worktree_status'
      | 'project_threads'
      | 'thread_message';
    arguments: Record<string, unknown>;
    expiresAt: number;
  };
  type CoordinationThread = {
    id: string;
    directory: string;
    title: string;
    agent: string;
  };
  type CoordinationSource =
    | { kind: 'acp'; agent: string; model?: string; title: string }
    | { kind: 'opencode'; agent: string; model?: ModelRef; title: string };
  let browserApprovalQueue: Promise<unknown> = Promise.resolve();
  let agentSpawnQueue: Promise<unknown> = Promise.resolve();
  let worktreeApprovalDialog: HTMLDialogElement;
  let worktreeApproval = $state<{
    agent: string;
    title: string;
    name: string;
    project: string;
    prompt: string;
    provider?: string;
    existingPath?: string;
  } | null>(null);
  let resolveWorktreeApproval: ((allowed: boolean) => void) | null = null;
  let worktreeApprovalTimer: ReturnType<typeof setTimeout> | undefined;
  let coordinationMessages = $state<CoordinationMessage[]>(
    loadCoordinationMessages(getSetting('sai-coordination-messages')),
  );
  const initialSpawnReceipts = loadSpawnReceipts(getSetting('sai-agent-spawn-receipts'));
  let spawnReceipts = $state<SpawnReceipt[]>(initialSpawnReceipts);
  const spawnOutput = new SvelteMap<string, string>();
  const activeSpawnTargets = new SvelteMap<string, string>();
  for (const receipt of initialSpawnReceipts) {
    if (
      receipt.targetId &&
      receipt.turnId &&
      (receipt.state === 'working' || receipt.state === 'waiting')
    )
      activeSpawnTargets.set(receipt.targetId, receipt.receiptId);
  }
  const activeSpawnRequests = new SvelteSet<string>();
  const coordinationDeliveries = new SvelteMap<string, Promise<void>>();
  const coordinationAttempts = new SvelteMap<string, number>();
  type WorktreeConfig = {
    setup: string;
    run: string;
    archive: string;
    copy: string[];
    postTurnChecks: string[];
  };
  let postTurnResults = $state<PostTurnCheck[]>([]);
  const pendingPostTurnChecks = new SvelteSet<string>();
  let personalPostTurnChecks = $state(personalChecks(getSetting('sai-post-turn-personal')));
  type TurnSnapshot = { id: string; kind: 'turn' | 'undo'; created: number };
  let selectedWorktreeConfig = $state<WorktreeConfig | null>(null);
  let configGeneration = 0;
  const terminalExitWaiters = new SvelteMap<string, (code: number) => void>();
  const coordinationSetupWaiters = new SvelteMap<string, (code: number) => void>();
  function finishCoordinationSetup(id: string, code: number) {
    const finish = coordinationSetupWaiters.get(id);
    coordinationSetupWaiters.delete(id);
    finish?.(code);
  }
  $effect(() => {
    const path = directory;
    const generation = ++configGeneration;
    selectedWorktreeConfig = null;
    if (!path || !isTauri()) return;
    void invoke<WorktreeConfig | null>('worktree_config', { worktree: path })
      .then((config) => {
        if (generation === configGeneration) selectedWorktreeConfig = config;
        return config;
      })
      .catch((cause) => {
        if (generation === configGeneration) error = describe(cause);
        return null;
      });
  });
  let agentTerminals = $state<
    {
      agent: string;
      sessionId: string;
      terminalId: string;
      command: string;
      directory: string;
    }[]
  >([]);
  let agentTerminalsDialog: HTMLDialogElement;
  let snapshotsDialog: HTMLDialogElement;
  let snapshots = $state<TurnSnapshot[]>([]);
  let snapshotsThread = $state('');
  let snapshotsPath = $state('');
  let snapshotsLoading = $state(false);
  let snapshotsError = $state('');
  let snapshotsRestoring = $state(false);
  let snapshotsGeneration = 0;
  let commandsDialog: HTMLDialogElement;
  let commandName = $state('');
  let commandText = $state('');
  let commandScope = $state<'global' | 'project'>('global');
  let commandScopePickerOpen = $state(false);
  let confirmation = $state<Confirmation | null>(null);
  let confirmationResolver: ((confirmed: boolean) => void) | null = null;
  let confirmationQueue = Promise.resolve();
  let pathPicker = $state<{
    initialPath?: string;
    selection: number;
    sessionID: string | null;
    directory: string;
  } | null>(null);

  function confirmInApp(title: string, message: string, confirmLabel: string): Promise<boolean> {
    const pending = confirmationQueue.then(
      () =>
        new Promise<boolean>((resolve) => {
          confirmationResolver = resolve;
          confirmation = { id: crypto.randomUUID(), title, message, confirmLabel };
        }),
    );
    confirmationQueue = pending.then(() => undefined);
    return pending;
  }

  function answerConfirmation(confirmed: boolean) {
    const resolve = confirmationResolver;
    confirmationResolver = null;
    confirmation = null;
    resolve?.(confirmed);
  }
  let editingCommand = $state<string | null>(null);
  let binaryPath = $state(getSetting('sai-opencode-bin') ?? '');
  let appliedBinaryPath = getSetting('sai-opencode-bin') ?? '';
  let activeBinary = $state('');
  let agentAvailability = $state<AgentAvailability[]>([]);
  let agentDetectionError = $state('');
  let agentThreads = $state<AgentThread[]>(savedAgentThreads);
  let nativeSubagents = $state<NativeSubagentStore>({});
  let nativeChildThreads = $derived(threadsForNativeSubagents(nativeSubagents));
  let nativeChildReceipts = $derived(nativeSubagentReceipts(nativeSubagents));
  let visibleSpawnReceipts = $derived([...spawnReceipts, ...nativeChildReceipts]);

  function isShipItPrompt(text: string): boolean {
    return /^\s*\/ship-it(?:\s|$)/im.test(text);
  }

  $effect(() => {
    for (const thread of agentThreads) {
      const sourceId = `acp:${thread.agent}:${thread.sessionId}`;
      const { directory: path, model, agent, sessionId } = thread;
      const issue = savedShipItIssue(path);
      const ownsPending = hasPendingImplementationTurn(path, sourceId);
      const savedOwner = savedShipItOwner(path);
      const claimedLegacy =
        !savedOwner &&
        !!issue &&
        ownsPending &&
        loadRecentTranscript(thread).some(
          (entry) => entry.type === 'user' && isShipItPrompt(entry.text),
        ) &&
        claimLegacyPendingImplementationTurn(path, sourceId);
      if (claimedLegacy) recordShipItOwner(path, sourceId);
      if (!ownsPending || (savedOwner !== sourceId && !claimedLegacy)) continue;
      if (issue) void adoptDirectShipRun(issue, path, `acp:${agent}:${sessionId}`, model);
    }
  });
  let agentUsage = $state<Record<string, AgentUsage>>({});
  let agentRates = $state<Record<string, RateWindow[]>>({});
  let replayingAgentSessions = $state<Record<string, number>>({});
  $effect(() => {
    const resets = Object.values(agentRates)
      .flat()
      .flatMap((rate) => (rate.resetsAt === undefined ? [] : [rate.resetsAt]));
    if (resets.length === 0) return;
    const delay = Math.max(0, Math.min(Math.min(...resets) - Date.now(), 2_147_483_647));
    const timer = setTimeout(() => {
      agentRates = Object.fromEntries(
        Object.entries(agentRates).map(([agent, rates]) => [
          agent,
          rates.filter((rate) => rate.resetsAt === undefined || rate.resetsAt > Date.now()),
        ]),
      );
    }, delay);
    return () => clearTimeout(timer);
  });
  let openCodeUsage = $state<Record<string, number>>({});
  let nativeThreads = $state<AgentThread[]>(savedNativeThreads);
  let sidebarOpenCodeThreads = $state<AgentThread[]>(savedNativeThreads);
  let hiddenSidebarThreadKeys = $state<string[]>(loadHiddenSidebarThreadKeys());
  function loadHiddenSidebarThreadKeys(): string[] {
    try {
      const value: unknown = JSON.parse(getSetting('sai-hidden-sidebar-threads') ?? '[]');
      return Array.isArray(value)
        ? value.filter((key): key is string => typeof key === 'string')
        : [];
    } catch {
      return [];
    }
  }
  function removeSidebarThread(thread: AgentThread) {
    const key = threadKey(thread);
    if (!hiddenSidebarThreadKeys.includes(key)) {
      hiddenSidebarThreadKeys = [...hiddenSidebarThreadKeys, key];
      setSetting('sai-hidden-sidebar-threads', JSON.stringify(hiddenSidebarThreadKeys));
    }
  }
  function showSidebarThread(thread: AgentThread) {
    const key = threadKey(thread);
    if (!hiddenSidebarThreadKeys.includes(key)) return;
    hiddenSidebarThreadKeys = hiddenSidebarThreadKeys.filter((item) => item !== key);
    setSetting('sai-hidden-sidebar-threads', JSON.stringify(hiddenSidebarThreadKeys));
  }
  let sidebarOpenCodeOutcomes = $state<Record<string, ThreadStatus>>({});
  let threadAttention = $state<AttentionMap>(loadAttention(getSetting('sai-thread-attention')));
  let acpActivityReady = $state(false);
  let nativeActivityReady = $state(false);
  let nativeUnavailableDirectories = $state<string[]>([]);
  let sidebarThreads = $derived(
    groupSidebarThreads(
      [...agentThreads, ...nativeChildThreads, ...sidebarOpenCodeThreads].filter(
        (thread) => !hiddenSidebarThreadKeys.includes(threadKey(thread)),
      ),
    ),
  );
  let taskOverviewStatuses = $derived(
    Object.fromEntries(
      Object.values(sidebarThreads)
        .flat()
        .map((thread) => [
          threadKey(thread),
          sidebarThreadStatus(
            thread,
            threadAttention,
            sidebarOpenCodeOutcomes,
            acpActivityReady,
            nativeActivityReady,
            nativeUnavailableDirectories,
            visibleSpawnReceipts,
          ),
        ]),
    ),
  );
  let taskOverviewAgentNames = $derived(
    Object.fromEntries([
      ['opencode', 'OpenCode'],
      ...agentAvailability.map((agent) => [agent.id, agent.name]),
    ]),
  );
  let agentStatusThreads = $derived([...agentThreads, ...sidebarOpenCodeThreads]);
  let agentStatusStatuses = $derived(
    Object.fromEntries(
      agentStatusThreads.map((thread) => [
        threadKey(thread),
        sidebarThreadStatus(
          thread,
          threadAttention,
          sidebarOpenCodeOutcomes,
          acpActivityReady,
          nativeActivityReady,
          nativeUnavailableDirectories,
          visibleSpawnReceipts,
        ),
      ]),
    ),
  );
  let agentStatusItems = $derived(
    buildAgentStatusItems({
      threads: agentStatusThreads,
      statuses: agentStatusStatuses,
      attention: threadAttention,
      agentNames: taskOverviewAgentNames,
      usage: agentUsage,
      openCodeUsage,
      rates: agentRates,
    }),
  );
  let sidebarDirectoryKey = $derived(
    JSON.stringify([
      ...new Set([
        ...projectCatalog.repositories,
        ...Object.values(projectCatalog.worktrees).flatMap((worktrees) =>
          worktrees.map((worktree) => worktree.path),
        ),
      ]),
    ]),
  );
  let attentionRevision = 0;
  let notificationsEnabled = $state(getSetting('sai-notifications-enabled') !== 'false');
  let crossValidation = $state(parseValidationSettings(getSetting(validationSettingsKey)));
  let notificationSound = $state(getSetting('sai-notification-sound') !== 'false');
  let agentWorktreesEnabled = $state(getSetting('sai-agent-worktrees-enabled') !== 'false');
  let agentTerminalsEnabled = $state(getSetting('sai-agent-terminals-enabled') === 'true');
  let agentStatusEnabled = $state(getSetting('sai-agent-status-enabled') !== 'false');
  let agentThreadListEnabled = $state(getSetting('sai-agent-thread-list-enabled') !== 'false');
  let agentMessagesEnabled = $state(getSetting('sai-agent-messages-enabled') !== 'false');
  let inboxItems = $state<InboxItem[]>([]);
  let inboxOutcomes = $state<InboxOutcome[]>(loadInboxOutcomes(getSetting('sai-inbox-outcomes')));
  let durableActivityHistory = $state<ActivityHistoryEvent[]>(
    loadActivityHistory(getSetting('sai-activity-history')),
  );
  let openCodeTimelineRevision = $state(0);
  let inboxLoading = $state(false);
  let inboxError = $state('');
  let inboxDialog: HTMLDialogElement;
  let inboxRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let inboxGeneration = 0;
  const inboxSeen = loadInboxSeen(getSetting('sai-inbox-seen'));
  let recentThreadKeys = $state<string[]>(
    loadRecentThreadKeys(getSetting('sai-recent-agent-threads'), [
      ...savedAgentThreads,
      ...savedNativeThreads,
    ]),
  );
  let recentCycleKeys: string[] | null = null;
  let recentCycleIndex = -1;
  let recentJumpGeneration = 0;
  let paletteQuery = $state('');
  let paletteIndex = $state(0);
  let paletteStep = $state<PaletteStep>({ kind: 'projects' });
  let paletteOpenCodeSessions = $state<PaletteOpenCodeSession[]>([]);
  let paletteLoading = $state(false);
  let paletteBusy = $state(false);
  let paletteError = $state('');
  let paletteSessionGeneration = 0;
  let paletteSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let paletteWorktreeRequest = $state<{
    id: string;
    path: string;
    fromPalette: boolean;
  } | null>(null);
  let promptFocusPane = $state<string | null>(null);
  let paletteDialog: HTMLDialogElement;
  let paletteInput: HTMLInputElement;
  let palettePreviousFocus: HTMLElement | null = null;
  let restorePaletteFocus = true;
  let runningAgentThreads = $state<Record<string, boolean>>(
    Object.fromEntries(
      startupInterruptedTurns.map((turn) => [
        JSON.stringify([turn.agent, turn.directory, turn.sessionId]),
        true,
      ]),
    ),
  );
  const savedPaneLayouts = loadPaneLayouts(getSetting('sai-pane-layouts'));
  let paneLayouts = $state<Record<string, Pane>>(savedPaneLayouts);
  let sideChat = $state<SideChat | null>(null);
  let focusedPane = $state(leaves(savedPaneLayouts[savedDirectory] ?? mainPane())[0]?.id ?? 'main');
  let paneLayout = $derived(paneLayouts[directory] ?? mainPane());
  let focusedLeaf = $derived(leaves(paneLayout).find((pane) => pane.id === focusedPane));
  let agentChangesOpen = $state(false);
  let changesPanes = $state<string[]>([]);
  const initialMainPane = leaves(savedPaneLayouts[savedDirectory] ?? mainPane()).find(
    (leaf) => leaf.id === 'main',
  );
  let acpAgent = $state<AgentId | null>(initialMainPane?.agent ?? null);
  let acpThread = $state<AgentThread | null>(initialMainPane?.thread ?? null);
  let runtimeState = $state<'starting' | 'connected' | 'error'>('starting');
  const paletteRepository = $derived('repository' in paletteStep ? paletteStep.repository : '');
  const paletteLocation = $derived('directory' in paletteStep ? paletteStep.directory : '');
  const paletteAgentID = $derived('agent' in paletteStep ? paletteStep.agent : '');
  const paletteEntries = $derived(
    searchCommandPalette({
      step: paletteStep,
      query: paletteQuery,
      catalog: projectCatalog,
      currentDirectory: directory,
      agents: agentAvailability,
      threads: [...agentThreads, ...sidebarOpenCodeThreads],
      openCodeAvailable: runtimeState === 'connected',
      openCodeSessions: paletteOpenCodeSessions,
      commands: savedCommands,
      runningThreadKeys: [
        ...Object.keys(runningAgentThreads),
        ...sidebarOpenCodeThreads
          .filter((thread) => activeSessionIDs.includes(thread.sessionId))
          .map(threadKey),
      ],
    }),
  );
  let runtimeError = $state('');
  let workReady = $state(false);
  let planReady = $state(false);
  let paneAgents = $derived<AgentAvailability[]>([
    ...agentAvailability,
    {
      id: 'opencode',
      name: 'OpenCode',
      binaryPath: activeBinary || null,
      available: runtimeState === 'connected' && workReady,
      reason:
        runtimeState === 'connected'
          ? 'Complete OpenCode setup in this worktree'
          : 'OpenCode unavailable',
    },
  ]);
  let selectedAgentID = $state('');
  let selectedModelKey = $state('');
  let selectedVariant = $state('');
  let composerPickerOpen = $state<'agent' | 'model' | 'effort' | null>(null);

  $effect(() => {
    if (running || sending || switching) composerPickerOpen = null;
  });
  let newSessionMode = $state<'work' | null>(null);
  let attachedFiles = $state<string[]>([]);
  let pendingPaste: Promise<void> = Promise.resolve();
  const clipboardAttachmentPaths = new SvelteSet<string>();
  const clipboardAttachmentNames = new SvelteMap<string, string>();
  let pickedAttachments = $state<Record<string, BrowserAttachment>>({});
  let reviewCaptures = $state<(ReviewCapture & { directory: string })[]>([]);
  let mainDiffEvidenceUpdated = $state(Date.now());
  let diffComments = $state<Record<string, DiffComment[]>>({});
  let pendingAgentBatches = $state<Record<string, { id: string; text: string }>>({});
  let issuePrefills = $state<Record<string, { id: string; text: string }>>({});
  let agentEntrySnapshots = $state.raw<
    Record<string, { sessionId: string | null; entries: AgentEntry[]; ready: boolean }>
  >({});
  $effect(() => {
    const active = new Set(
      leaves(paneLayout)
        .filter((leaf) => leaf.agent && leaf.agent !== 'opencode')
        .map((leaf) => leaf.id),
    );
    const retained = Object.entries(agentEntrySnapshots).filter(([id]) => active.has(id));
    if (retained.length !== Object.keys(agentEntrySnapshots).length)
      agentEntrySnapshots = Object.fromEntries(retained);
  });
  let pendingOpenCodeStart = $state<{ path: string; text: string | null } | null>(null);
  const batchWaiters = new SvelteMap<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  const pickedImageText = new SvelteMap<string, string>();
  const pickedCaptureIds = new SvelteMap<string, string>();
  const inFlightCaptures = new SvelteSet<string>();
  let setup = $state<SetupReport | null>(null);
  let setupError = $state('');
  let setupLoading = $state(false);
  let openingSettings = false;
  let settingsCreation: Promise<void> | null = null;
  let closingMain = false;
  const setupRestarted = new SvelteSet<string>();
  let lastSetupProbe = 0;
  let setupProbeCount = 0;
  let sessions = $state<SessionInfo[]>([]);
  let selectedSession = $state<SessionInfo | null>(null);
  let editingSessionID = $state<string | null>(null);
  let editedTitle = $state('');
  let renameSessionDialog: HTMLDialogElement;
  let activeSessionIDs = $state<string[]>([]);
  let sessionID = $state<string | null>(null);
  let mainPickerDirectory = $state<string | null>(
    getSetting(`sai-main-pane-empty:${savedDirectory}`) === 'true' ? savedDirectory : null,
  );
  let showMainPicker = $derived.by(() => {
    const panes = leaves(paneLayout);
    const main = panes[0];
    return (
      mainPickerDirectory === directory &&
      panes.length === 1 &&
      main?.id === 'main' &&
      !main.agent &&
      !main.thread &&
      !main.kind &&
      !acpAgent &&
      !sessionID &&
      !newSessionMode
    );
  });
  let mainShipFallback = $derived(
    showMainPicker || !!leaves(paneLayout).find((pane) => pane.id === 'main')?.kind,
  );
  $effect(() => {
    const side = sideChat;
    if (!side) return;
    const parent = leaves(paneLayout).find((leaf) => leaf.id === side.parentId);
    if (!parent) {
      sideChat = null;
      return;
    }
    if (side.source.kind === 'opencode') {
      if (side.parentId !== 'main' || acpAgent || sessionID !== side.source.sessionID)
        sideChat = null;
      return;
    }
    const agent = side.parentId === 'main' ? acpAgent : parent.agent;
    const thread = side.parentId === 'main' ? acpThread : parent.thread;
    if (
      agent !== side.source.agent ||
      (side.parentThreadId && thread?.sessionId !== side.parentThreadId)
    ) {
      sideChat = null;
      return;
    }
    if (!side.parentThreadId && thread) sideChat = { ...side, parentThreadId: thread.sessionId };
  });
  let messages = $state<SessionMessageInfo[]>([]);
  let olderMessageCursor = $state<string | null>(null);
  let loadingOlder = $state(false);
  let restoringTimelineSelection: number | null = null;
  let liveText = $state<Record<string, Record<number, string>>>({});
  let pendingTextDeltas: Record<string, Record<number, string[]>> = {};
  let textTimer: ReturnType<typeof setTimeout> | undefined;
  let timelineSession = '';
  let timelineRefresh = 0;
  let followChat = true;
  let followFrame = 0;
  let messageTimers = new SvelteMap<
    string,
    { timer: ReturnType<typeof setTimeout>; settled: boolean }
  >();
  let messageGeneration = new SvelteMap<string, number>();
  let snapshot = $state<PlanSnapshot>({ plan: null, questions: null });
  let diffs = $state<WorkingDiffInfo[]>([]);
  let diffLoading = $state(false);
  let diffError = $state('');
  let selectedFilePath = $state<string | null>(null);
  type SideTab = 'plan' | 'changes' | 'history' | 'ship';
  let sideTab = $state<SideTab>('plan');
  let detailsOpen = $state(true);
  let diffRefresh = 0;
  let diffRevision = '';
  let diffRevisionPath = '';
  let draft = $state('');
  const failureRequests = new SvelteMap<string, string>();
  let mainPrompt = $state<HTMLTextAreaElement | undefined>();
  let skills = $state<SkillChoice[]>(bundledSkills);
  let skillSelected = $state(0);
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
    void tick().then(() =>
      document.querySelector<HTMLTextAreaElement>('.chat-area .composer textarea')?.focus(),
    );
  }
  let mobileView = $state<'sessions' | 'chat' | 'details'>('chat');
  let workspaceView = $state<'workspace' | 'overview'>(
    getSetting('sai-workspace-view') === 'overview' ? 'overview' : 'workspace',
  );
  let sidebarVisible = $state(true);
  let mobileLayout = $state(window.matchMedia('(max-width: 850px)').matches);
  const viewStates = new SvelteMap<
    string,
    {
      draft: string;
      scrollTop: number;
      follow: boolean;
      messageCount: number;
      anchorID: string | null;
      anchorOffset: number;
      sideTab: SideTab;
      selectedFilePath: string | null;
      selectionStart: number;
      selectionEnd: number;
      sideScroll: Partial<Record<SideTab, number[]>>;
    }
  >();
  let sending = $state(false);
  let switching = $state(false);
  let running = $state(false);
  let activity = $state('Thinking');
  let activityTool = '';
  const savedDetailsWidth = Number(getSetting('sai-details-width'));
  let detailsWidth = $state(
    Number.isFinite(savedDetailsWidth) && savedDetailsWidth >= 320 ? savedDetailsWidth : 420,
  );
  let workspaceWidth = $state(0);
  let appShellElement = $state<HTMLDivElement>();
  let resizeStart: { x: number; width: number } | null = null;
  let error = $state('');
  let chatScroll = $state<HTMLDivElement>();
  let sidebarElement: HTMLElement;
  let sidebarToggleElement: HTMLButtonElement;
  let topbarElement = $state<HTMLElement>();
  let topbarHeight = $state(80);
  let chatArea: HTMLElement;
  let detailsArea = $state<HTMLElement>();

  $effect(() => {
    const query = window.matchMedia('(max-width: 850px)');
    const update = () => (mobileLayout = query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  });

  $effect(() => {
    if (!appShellElement) return;
    const element = appShellElement;
    const update = () => (workspaceWidth = element.clientWidth - sidebarElement.clientWidth);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(sidebarElement);
    update();
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!topbarElement) return;
    const element = topbarElement;
    const observer = new ResizeObserver(() => (topbarHeight = element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  });

  async function showMobileView(view: 'sessions' | 'chat' | 'details') {
    if (view === 'sessions') sidebarVisible = true;
    saveViewState();
    if (view === 'details') {
      const pane =
        focusedPane === 'main' ? null : leaves(paneLayout).find((item) => item.id === focusedPane);
      if (pane?.agent) {
        if (!changesPanes.includes(focusedPane)) changesPanes = [...changesPanes, focusedPane];
      } else if (mainShipFallback || (!sessionID && !acpAgent)) {
        showShipRuns();
      }
    }
    if (acpAgent && focusedPane === 'main') {
      agentChangesOpen = view === 'details';
      if (agentChangesOpen && activeSideTab === 'changes') void refreshAgentDiff();
    }
    if (view === 'details') detailsOpen = true;
    mobileView = view;
    await tick();
    if (window.matchMedia('(max-width: 850px)').matches) {
      const target =
        view === 'sessions'
          ? sidebarElement
          : view === 'chat'
            ? focusedPane === 'main'
              ? chatArea
              : document.querySelector<HTMLElement>('.pane-leaf.focused .agent-workspace textarea')
            : focusedPane === 'main'
              ? detailsArea
              : document.querySelector<HTMLElement>(
                  '.pane-leaf.focused .native-details button.active',
                );
      target?.focus();
    }
  }

  async function switchSideTab(tab: SideTab) {
    saveViewState();
    sideTab = tab;
    await tick();
    restoreSideScroll(viewStates.get(viewKey())?.sideScroll[activeSideTab as SideTab]);
    if (tab === 'changes') {
      if (acpAgent) void refreshAgentDiff();
      else void refreshDiff();
    }
  }

  async function toggleChanges() {
    if (focusedPane !== 'main') {
      const pane = leaves(paneLayout).find((item) => item.id === focusedPane);
      if (!pane?.agent) {
        showShipRuns();
        return;
      }
      changesPanes = changesPanes.includes(focusedPane)
        ? changesPanes.filter((id) => id !== focusedPane)
        : [...changesPanes, focusedPane];
      return;
    }
    if (mainShipFallback) {
      toggleShipRuns();
      return;
    }
    if (acpAgent) {
      if (agentChangesOpen && activeSideTab === 'ship') {
        sideTab = 'changes';
        void refreshAgentDiff();
        return;
      }
      agentChangesOpen = !agentChangesOpen;
      if (window.matchMedia('(max-width: 850px)').matches)
        mobileView = agentChangesOpen ? 'details' : 'chat';
      if (agentChangesOpen) void refreshAgentDiff();
      return;
    }
    if (!sessionID) {
      toggleShipRuns();
      return;
    }
    const narrow = window.matchMedia('(max-width: 850px)').matches;
    const visible = detailsOpen && (!narrow || mobileView === 'details');
    saveViewState();
    if (visible) {
      detailsOpen = false;
      if (narrow) mobileView = 'chat';
      await tick();
      if (narrow) chatArea?.focus();
      return;
    }
    detailsOpen = true;
    sideTab = 'changes';
    if (narrow) mobileView = 'details';
    await tick();
    restoreSideScroll(viewStates.get(viewKey())?.sideScroll.changes);
    if (narrow) detailsArea?.focus();
    void refreshDiff();
  }

  async function refreshAgentDiff(quiet = false) {
    if (!directory) return;
    const path = directory;
    const generation = ++diffRefresh;
    try {
      const revision = await invoke<string>('working_tree_revision', { path });
      if (generation !== diffRefresh || path !== directory) return;
      if (quiet && diffRevisionPath === path && diffRevision === revision) return;
      diffLoading = true;
      const next = await invoke<WorkingDiffInfo[]>('working_tree_diff', { path });
      if (generation !== diffRefresh || path !== directory) return;
      diffRevisionPath = path;
      diffRevision = revision;
      diffs = next;
      mainDiffEvidenceUpdated = Date.now();
      diffError = '';
      selectedFilePath = selectedDiffFile(next, selectedFilePath, path);
    } catch (cause) {
      if (generation === diffRefresh) diffError = describe(cause);
    } finally {
      if (generation === diffRefresh) diffLoading = false;
    }
  }

  function restoreSideScroll(positions?: number[]) {
    const scrollable = detailsArea?.querySelectorAll<HTMLElement>(
      '.side-view:not(.inactive) :is(.panel-scroll, .diff-files, .patch-scroll, .history-list)',
    );
    scrollable?.forEach((element, index) => (element.scrollTop = positions?.[index] ?? 0));
  }

  function viewKey(path = directory, id = sessionID) {
    return `${path}\0${id ?? 'new'}`;
  }

  function saveViewState() {
    if (!directory || acpAgent) return;
    const previous = viewStates.get(viewKey());
    const narrow = window.matchMedia('(max-width: 850px)').matches;
    const chatVisible = !narrow || mobileView === 'chat';
    const detailsVisible = !narrow || mobileView === 'details';
    const currentChatScroll = chatScroll;
    const anchor = chatVisible
      ? [...(currentChatScroll?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(
          (element) =>
            currentChatScroll &&
            element.getBoundingClientRect().bottom > currentChatScroll.getBoundingClientRect().top,
        )
      : null;
    const scrollable = detailsArea?.querySelectorAll<HTMLElement>(
      '.side-view:not(.inactive) :is(.panel-scroll, .diff-files, .patch-scroll, .history-list)',
    );
    viewStates.set(viewKey(), {
      draft: draftWithoutPickedImages(draft),
      scrollTop: chatVisible ? (chatScroll?.scrollTop ?? 0) : (previous?.scrollTop ?? 0),
      follow: chatVisible ? followChat : (previous?.follow ?? true),
      messageCount: chatVisible ? messages.length : (previous?.messageCount ?? 0),
      anchorID: chatVisible ? (anchor?.dataset.messageId ?? null) : (previous?.anchorID ?? null),
      anchorOffset:
        chatVisible && anchor && chatScroll
          ? anchor.getBoundingClientRect().top - chatScroll.getBoundingClientRect().top
          : (previous?.anchorOffset ?? 0),
      sideTab,
      selectedFilePath,
      selectionStart: mainPrompt?.selectionStart ?? draft.length,
      selectionEnd: mainPrompt?.selectionEnd ?? draft.length,
      sideScroll: detailsVisible
        ? {
            ...previous?.sideScroll,
            [activeSideTab]: [...(scrollable ?? [])].map((element) => element.scrollTop),
          }
        : (previous?.sideScroll ?? {}),
    });
  }

  async function restoreViewState() {
    const saved = viewStates.get(viewKey());
    draft = saved?.draft ?? '';
    if (saved && client && sessionID) {
      const id = sessionID;
      const current = selection;
      await restoreOlderMessages(client, id, current, saved.messageCount, saved.anchorID);
      if (current !== selection || id !== sessionID) return;
    }
    await tick();
    if (saved && mainPrompt) mainPrompt.setSelectionRange(saved.selectionStart, saved.selectionEnd);
    if (saved && chatScroll) {
      cancelAnimationFrame(followFrame);
      followChat = saved.follow;
      const anchor = saved.anchorID
        ? [...chatScroll.querySelectorAll<HTMLElement>('[data-message-id]')].find(
            (element) => element.dataset.messageId === saved.anchorID,
          )
        : null;
      chatScroll.scrollTop = saved.follow
        ? chatScroll.scrollHeight
        : anchor
          ? chatScroll.scrollTop +
            anchor.getBoundingClientRect().top -
            chatScroll.getBoundingClientRect().top -
            saved.anchorOffset
          : saved.scrollTop;
    }
    if (saved && detailsArea) restoreSideScroll(saved.sideScroll[activeSideTab as SideTab]);
  }

  async function restoreOlderMessages(
    source: OpenCodeClient,
    id: string,
    current: number,
    count: number,
    anchorID: string | null,
  ): Promise<void> {
    if (
      (anchorID ? messages.some((message) => message.id === anchorID) : messages.length >= count) ||
      !olderMessageCursor
    )
      return;
    const cursor = olderMessageCursor;
    const page = await source.message.list({ sessionID: id, limit: 50, cursor });
    if (current !== selection || id !== sessionID) return;
    messages = mergeMessages(messages, page.data);
    olderMessageCursor = page.cursor.next === cursor ? null : (page.cursor.next ?? null);
    cacheCurrentTimeline();
    await restoreOlderMessages(source, id, current, count, anchorID);
  }
  let client = $state<OpenCodeClient | null>(null);
  let eventController: AbortController | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let diffTimer: ReturnType<typeof setTimeout> | undefined;
  let diffPollTimer: ReturnType<typeof setInterval> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  let connecting = $state(false);
  let disposed = false;
  let hasConnected = false;
  let pendingPermissions = $state<PermissionRequest[]>([]);
  let pendingForms = $state<FormInfo[]>([]);
  let selection = 0;
  const paneSelections = new SvelteMap<string, number>();
  let nativeActivityGeneration = 0;
  let sidebarInventoryGeneration = 0;
  let sidebarInventoryTimer: ReturnType<typeof setTimeout> | undefined;
  let projectLoadGeneration = 0;
  let sessionRefresh = 0;
  let promptRefresh = 0;

  let currentSession = $derived(
    sessions.find((session) => session.id === sessionID) ??
      (selectedSession?.id === sessionID ? selectedSession : undefined),
  );
  const mainPromptLocation = $derived(
    composerTaskLocation(taskLocation, directory, currentSession?.location.directory),
  );
  let actionAgentThread = $derived(
    focusedPane === 'main'
      ? acpThread
      : focusedLeaf?.agent && focusedLeaf.agent !== 'opencode'
        ? focusedLeaf.thread
        : null,
  );
  let actionOpenCodeSession = $derived(
    focusedPane === 'main'
      ? acpAgent
        ? null
        : currentSession
      : focusedLeaf?.agent === 'opencode' && focusedLeaf.thread
        ? { id: focusedLeaf.thread.sessionId, title: focusedLeaf.thread.title }
        : null,
  );
  let focusedConversationTitle = $derived(
    focusedPane !== 'main'
      ? (focusedLeaf?.thread?.title ??
          (focusedLeaf?.agent ? `New ${focusedLeaf.agent} thread` : 'Workspace'))
      : acpAgent
        ? (acpThread?.title ?? `New ${acpAgent} thread`)
        : (currentSession?.title ?? (newSessionMode === 'work' ? 'New work' : 'New session')),
  );
  let chatMessages = $derived(
    messages.filter((message) => message.type === 'user' || message.type === 'assistant'),
  );
  const mainSpawnActivity = $derived(
    spawnReceiptsForSource(spawnReceipts, sessionID ? `opencode:${sessionID}` : null, directory),
  );
  const mainPostTurnChecks = $derived(
    postTurnResults.filter(
      (check) => check.directory === directory && check.thread === `opencode:${sessionID}`,
    ),
  );
  const mainWorkspaceActivity = $derived(
    workspaceActivityItems({
      tools: chatMessages.flatMap((message) =>
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
      children: mainSpawnActivity,
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
      checks: mainPostTurnChecks,
    }),
  );
  let mainAgentWorkspaceActivity = $state<WorkspaceActivityItem[]>([]);
  let selectMainAgentWorkspaceActivity = $state<(item: WorkspaceActivityItem) => Promise<void>>(
    async () => {
      throw new Error('The activity source is unavailable.');
    },
  );
  const activityHistory = $derived.by(() => {
    const openCodeTimelines = openCodeTimelineRevision >= 0 ? cachedOpenCodeTimelines() : [];
    const input: ActivityHistoryInput[] = [...durableActivityHistory];
    for (const thread of [...agentThreads, ...nativeThreads, ...sidebarOpenCodeThreads]) {
      input.push({
        workspace: thread.directory,
        kind: 'parent',
        source: thread.agent,
        sourceId: thread.sessionId,
        title: thread.title,
        outcome:
          threadAttention[threadKey(thread)]?.status ??
          sidebarOpenCodeOutcomes[threadKey(thread)] ??
          'unknown',
        at: thread.updated,
        agent: thread.agent,
        sessionId: thread.sessionId,
      });
    }
    for (const receipt of visibleSpawnReceipts) {
      input.push({
        workspace: receipt.sourceDirectory,
        kind: 'subagent',
        source: receipt.provider,
        sourceId: receipt.receiptId,
        title: receipt.prompt ?? `${receipt.provider} subagent`,
        outcome: receipt.state,
        at: receipt.updated,
        agent: receipt.provider,
        sessionId: receipt.targetId ?? undefined,
      });
    }
    if (sessionID) {
      for (const message of chatMessages) {
        if (message.type !== 'assistant') continue;
        for (const part of message.content) {
          if (part.type !== 'tool') continue;
          input.push({
            workspace: directory,
            kind: 'tool',
            source: message.agent,
            sourceId: `${message.id}:${part.id}`,
            title: part.name,
            outcome: part.state.status,
            at: message.time.created,
            agent: 'opencode',
            sessionId: sessionID,
          });
        }
      }
    }
    for (const timeline of openCodeTimelines) {
      for (const message of timeline.messages) {
        if (message.type !== 'assistant') continue;
        for (const part of message.content) {
          if (part.type !== 'tool') continue;
          input.push({
            workspace: timeline.directory,
            kind: 'tool',
            source: message.agent,
            sourceId: `${message.id}:${part.id}`,
            title: part.name,
            outcome: part.state.status,
            at: message.time.created,
            agent: 'opencode',
            sessionId: timeline.sessionID,
          });
        }
      }
    }
    const cachedThreads = new Map(
      [...agentThreads, ...nativeThreads]
        .filter((thread) => thread.agent !== 'opencode')
        .map((thread) => [threadKey(thread), thread]),
    );
    for (const thread of cachedThreads.values()) {
      for (const entry of loadRecentTranscript(thread)) {
        if (entry.type !== 'tool' || !Number.isFinite(entry.created)) continue;
        input.push({
          workspace: thread.directory,
          kind: 'tool',
          source: thread.agent,
          sourceId: entry.id,
          title: entry.title,
          outcome: entry.status,
          at: entry.created!,
          agent: thread.agent,
          sessionId: thread.sessionId,
        });
      }
    }
    for (const [paneId, entrySnapshot] of Object.entries(agentEntrySnapshots)) {
      const pane = paneId === 'main' ? null : leaves(paneLayout).find((leaf) => leaf.id === paneId);
      const agent = paneId === 'main' ? acpAgent : pane?.agent;
      const thread = paneId === 'main' ? acpThread : pane?.thread;
      if (!agent || !thread) continue;
      for (const entry of entrySnapshot.entries.slice(-50)) {
        if (entry.type !== 'tool' || !Number.isFinite(entry.created)) continue;
        input.push({
          workspace: thread.directory,
          kind: 'tool',
          source: agent,
          sourceId: entry.id,
          title: entry.title,
          outcome: entry.status,
          at: entry.created!,
          agent,
          sessionId: thread.sessionId,
        });
      }
    }
    for (const item of inboxItems) {
      if (isInboxOutcome(item)) continue;
      input.push({
        workspace: item.directory,
        kind: 'decision',
        source: item.agent,
        sourceId: String(item.requestId ?? item.key),
        title: item.text,
        outcome: 'waiting',
        at: item.receivedAt,
        agent: item.agentId ?? (item.kind === 'opencode-permission' ? 'opencode' : undefined),
        sessionId: item.sessionId,
      });
    }
    for (const check of postTurnResults) {
      const [provider, agent, session] = check.thread.split(':');
      input.push({
        workspace: check.directory,
        kind: 'check',
        source: check.source,
        sourceId: check.id,
        title: check.command,
        outcome:
          check.status === 'running'
            ? 'working'
            : check.status === 'passed'
              ? 'completed'
              : check.status === 'canceled'
                ? 'interrupted'
                : 'failed',
        at: check.updated,
        agent: provider === 'opencode' ? 'opencode' : agent,
        sessionId: provider === 'opencode' ? agent : session,
      });
    }
    return recentActivityEvents(input);
  });
  const currentActivityHistory = $derived(
    activityHistory.filter((event) => event.workspace === directory),
  );
  $effect(() => {
    const saved = saveActivityHistory(activityHistory);
    if (saved === saveActivityHistory(durableActivityHistory)) return;
    durableActivityHistory = activityHistory;
    setSetting('sai-activity-history', saved);
  });
  $effect(() => {
    if (!sessionID || !running) return;
    const path = directory;
    const id = sessionID;
    const sourceId = `opencode:${id}`;
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
      void adoptDirectShipRun(saved, path, sourceId);
  });
  const displayChatMessages = $derived(
    withSpawnResponses(
      chatMessages,
      spawnReceiptsForSource(spawnReceipts, sessionID ? `opencode:${sessionID}` : null, directory),
      (message) => message.time.created,
    ),
  );
  $effect(() => {
    if (!sessionID || timelineSession !== sessionID || !setup) return;
    const context = openCodeContextUsage(messages, setup.models);
    const key = `${directory}:${sessionID}`;
    if (context === openCodeUsage[key]) return;
    const next = { ...openCodeUsage };
    if (context === undefined) delete next[key];
    else next[key] = context;
    openCodeUsage = next;
  });
  let liveOnly = $derived(
    Object.entries(liveText).filter(([id]) => !messages.some((message) => message.id === id)),
  );
  let canSend = $derived(
    runtimeState === 'connected' &&
      !connecting &&
      !!client &&
      !!directory &&
      (workReady || (currentSession?.agent === 'architect' && planReady)) &&
      (!!draft.trim() || attachedFiles.length > 0) &&
      !sending &&
      !switching,
  );
  let inputReady = $derived(workReady || (currentSession?.agent === 'architect' && planReady));
  let maxDetailsWidth = $derived(Math.max(320, workspaceWidth - 308));
  let visibleDetailsWidth = $derived(Math.min(detailsWidth, maxDetailsWidth));

  function planExpandedKey() {
    return `sai-plan-expanded:${encodeURIComponent(directory)}:${sessionID}`;
  }

  $effect(() => {
    const plan = snapshot.plan;
    if (
      !sessionID ||
      plan?.sessionID !== sessionID ||
      plan.version !== 1 ||
      running ||
      workspaceWidth === 0 ||
      getSetting(planExpandedKey())
    )
      return;
    detailsOpen = true;
    detailsWidth = Math.min(maxDetailsWidth, Math.round(workspaceWidth * 0.65));
    setSetting('sai-details-width', String(detailsWidth));
    setSetting(planExpandedKey(), '1');
  });

  function setDetailsWidth(width: number) {
    detailsWidth = Math.min(maxDetailsWidth, Math.max(320, Math.round(width)));
    setSetting('sai-details-width', String(detailsWidth));
    if (sessionID) setSetting(planExpandedKey(), '1');
  }

  function startDetailsResize(event: PointerEvent) {
    if (event.button !== 0) return;
    resizeStart = {
      x: event.clientX,
      width: detailsArea?.getBoundingClientRect().width ?? detailsWidth,
    };
    if (event.currentTarget instanceof HTMLElement)
      event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDetailsResize(event: PointerEvent) {
    if (!resizeStart) return;
    detailsWidth = Math.min(
      maxDetailsWidth,
      Math.max(320, Math.round(resizeStart.width + resizeStart.x - event.clientX)),
    );
  }

  function endDetailsResize() {
    if (!resizeStart) return;
    resizeStart = null;
    setSetting('sai-details-width', String(detailsWidth));
    if (sessionID) setSetting(planExpandedKey(), '1');
  }

  function keydownDetailsResize(event: KeyboardEvent) {
    const step = event.shiftKey ? 50 : 20;
    const width =
      event.key === 'ArrowLeft'
        ? visibleDetailsWidth + step
        : event.key === 'ArrowRight'
          ? visibleDetailsWidth - step
          : event.key === 'Home'
            ? 320
            : event.key === 'End'
              ? maxDetailsWidth
              : null;
    if (width === null) return;
    event.preventDefault();
    setDetailsWidth(width);
  }

  function modelKey(model: ModelRef) {
    return `${model.providerID}:${model.id}`;
  }

  let chosenModel = $derived(setup?.models.find((model) => modelKey(model) === selectedModelKey));
  let agentChoices = $derived(
    (setup?.agents ?? []).map((agent) => ({ value: agent.id, name: agent.name })),
  );
  let modelChoices = $derived(
    (setup?.models ?? []).map((model) => ({
      value: modelKey(model),
      name: `${model.providerID} / ${model.name}`,
    })),
  );
  let effortChoices = $derived(
    (chosenModel?.variants ?? []).map((variant) => ({ value: variant.id, name: variant.id })),
  );
  let showPlanPanel = $derived(!!snapshot.plan || !!snapshot.questions);
  let activeSideTab = $derived(
    sideTab === 'ship'
      ? 'ship'
      : acpAgent && sideTab !== 'history'
        ? 'changes'
        : showPlanPanel && sideTab === 'plan'
          ? 'plan'
          : sideTab === 'history'
            ? 'history'
            : 'changes',
  );
  let mainDetailsVisible = $derived(
    workspaceView === 'workspace' &&
      !mainShipFallback &&
      !!(sessionID || acpAgent || activeSideTab === 'ship') &&
      (acpAgent ? agentChangesOpen : detailsOpen),
  );
  let shipFallbackVisible = $derived(
    workspaceView === 'workspace' &&
      mainShipFallback &&
      detailsOpen &&
      activeSideTab === 'ship' &&
      (!mobileLayout || mobileView === 'details'),
  );

  function showShipRuns() {
    focusMainPane();
    sideTab = 'ship';
    detailsOpen = true;
    if (acpAgent) agentChangesOpen = true;
    if (window.matchMedia('(max-width: 850px)').matches) mobileView = 'details';
  }

  function toggleShipRuns() {
    const visible = detailsOpen && activeSideTab === 'ship';
    detailsOpen = !visible;
    sideTab = 'ship';
    if (window.matchMedia('(max-width: 850px)').matches) mobileView = visible ? 'chat' : 'details';
  }

  function closeShipRuns() {
    detailsOpen = false;
    agentChangesOpen = false;
    sideTab = 'changes';
    if (window.matchMedia('(max-width: 850px)').matches) mobileView = 'chat';
  }
  let diffAnnotations = $derived(annotateDiffs(diffs, snapshot.plan, directory));

  function setTheme(value: boolean) {
    dark = value;
    document.documentElement.dataset.suiTheme = value ? 'dark' : 'light';
    setSetting('sai-theme', value ? 'dark' : 'light');
  }

  function settingsSnapshot(): SettingsSnapshot {
    return {
      theme: dark ? 'dark' : 'light',
      binaryPath,
      activeBinary,
      runtimeState,
      runtimeError,
      directory,
      setup,
      setupLoading,
      setupError,
      busy: connecting || running || sending,
      agents: agentAvailability,
      agentsError: agentDetectionError,
      crossValidation,
      notificationsEnabled,
      notificationSound,
      personalPostTurnChecks,
      agentWorktreesEnabled,
      agentTerminalsEnabled,
      agentStatusEnabled,
      agentThreadListEnabled,
      agentMessagesEnabled,
    };
  }

  async function sendSettingsState() {
    try {
      await emitTo('settings', settingsState, settingsSnapshot());
    } catch (cause) {
      error = `Could not sync settings: ${describe(cause)}`;
    }
  }

  async function detectAgents() {
    agentDetectionError = '';
    try {
      agentAvailability = await acp.agents();
    } catch (cause) {
      agentDetectionError = `Could not detect agents: ${describe(cause)}`;
    }
    await sendSettingsState();
  }

  async function openSettings() {
    if (openingSettings || closingMain) return;
    openingSettings = true;
    try {
      const existing = await WebviewWindow.getByLabel('settings');
      if (closingMain) return;
      if (existing) {
        await existing.show();
        await existing.setFocus();
        await sendSettingsState();
        return;
      }
      const created = new WebviewWindow('settings', {
        url: 'index.html?window=settings',
        title: 'Sail Settings',
        width: 760,
        height: 620,
        minWidth: 520,
        minHeight: 420,
        center: true,
      });
      settingsCreation = new Promise<void>((resolve, reject) => {
        void created.once('tauri://created', () => resolve());
        void created.once('tauri://error', (event) => reject(event.payload));
      });
      await settingsCreation;
      if (closingMain) await created.close();
      else await created.setFocus();
    } catch (cause) {
      error = `Could not open settings: ${describe(cause)}`;
    } finally {
      settingsCreation = null;
      openingSettings = false;
    }
  }

  onMount(() => {
    let unlistenAgentEvents: (() => void) | undefined;
    let unlistenBrowserAccess: (() => void) | undefined;
    let unlistenCoordination: (() => void) | undefined;
    let unlistenTerminalExit: (() => void) | undefined;
    const coordinationRetry = setInterval(() => {
      if (isTauri()) retryCoordinationDeliveries();
    }, 10_000);
    if (isTauri()) setTimeout(retryCoordinationDeliveries, 2_000);
    let unlistenAgentTerminals: (() => void) | undefined;
    let unlistenNotificationClick: (() => void) | undefined;
    setTheme(dark);
    let stopSettingsRequest: (() => void) | undefined;
    let stopSettingsAction: (() => void) | undefined;
    let stopCloseRequest: (() => void) | undefined;
    let stopPaneClose: (() => void) | undefined;
    let stopWorktreeClose: (() => void) | undefined;
    if (isTauri()) {
      void listen<BrowserAccessRequest>('browser:access-request', ({ payload }) => {
        const previousApproval = browserApprovalQueue;
        browserApprovalQueue = (async () => {
          try {
            await previousApproval;
          } catch {
            error = 'A previous browser approval could not be completed.';
          }
          let allow = false;
          try {
            allow = await confirmInApp(
              'Agent browser access',
              payload.origin
                ? `Allow agent thread ${payload.sessionId} to use ${payload.origin} in the browser pane?`
                : `Allow agent thread ${payload.sessionId} to control the browser pane in ${payload.directory}?`,
              'Allow',
            );
          } catch (cause) {
            error = describe(cause);
          } finally {
            await invoke('browser_access_reply', { id: payload.id, allow });
          }
          return allow;
        })();
      }).then((unlisten) => (unlistenBrowserAccess = unlisten));
      void listen<CoordinationRequest>('agent:coordination-request', ({ payload }) => {
        void handleCoordinationRequest(payload);
      }).then((unlisten) => (unlistenCoordination = unlisten));
      void listen<{ id: string; code: number }>('terminal:exit', ({ payload }) => {
        finishCoordinationSetup(payload.id, payload.code);
      }).then((unlisten) => (unlistenTerminalExit = unlisten));
      void listen('pane:close', () => {
        if (!document.querySelector('dialog[open]')) closeCurrentPane();
      }).then((unlisten) => (stopPaneClose = unlisten));
      void listen('worktree:close', () => {
        if (!document.querySelector('dialog[open]')) closeCurrentWorktree();
      }).then((unlisten) => (stopWorktreeClose = unlisten));
      void getCurrentWindow()
        .onCloseRequested((event) => {
          event.preventDefault();
          if (closingMain) return;
          closingMain = true;
          void (async () => {
            try {
              const agentActivity = await acp.activity();
              if (Object.values(agentActivity).some((agent) => agent.active.length > 0)) {
                if (
                  !(await confirmInApp(
                    'Close and resume agents?',
                    'Running commands stop when Sail closes. Agent work continues when Sail reopens.',
                    'Close Sail',
                  ))
                ) {
                  closingMain = false;
                  return;
                }
                await acp.prepareRestart();
              }
              await settingsCreation?.catch(() => undefined);
              const settings = await WebviewWindow.getByLabel('settings');
              if (settings) await settings.destroy();
              await getCurrentWindow().destroy();
            } catch (cause) {
              closingMain = false;
              error = `Could not close Sail: ${describe(cause)}`;
            }
          })();
        })
        .then((unlisten) => (stopCloseRequest = unlisten));
      void listen(settingsRequest, () => void sendSettingsState()).then(
        (unlisten) => (stopSettingsRequest = unlisten),
      );
      void listen<SettingsAction>(settingsAction, (event) => {
        const action = event.payload;
        if (action.type === 'theme') setTheme(action.value === 'dark');
        else if (action.type === 'binary') {
          binaryPath = action.value;
          void retryRuntime();
        } else if (action.type === 'notifications') {
          notificationsEnabled = action.value;
          setSetting('sai-notifications-enabled', String(action.value));
        } else if (action.type === 'notification-sound') {
          notificationSound = action.value;
          setSetting('sai-notification-sound', String(action.value));
        } else if (action.type === 'personal-post-turn-checks') {
          personalPostTurnChecks = action.value;
          setSetting('sai-post-turn-personal', JSON.stringify(action.value));
        } else if (action.type === 'agent-worktrees') {
          agentWorktreesEnabled = action.value;
          setSetting('sai-agent-worktrees-enabled', String(action.value));
        } else if (action.type === 'agent-terminals') {
          agentTerminalsEnabled = action.value;
          setSetting('sai-agent-terminals-enabled', String(action.value));
        } else if (action.type === 'agent-status') {
          agentStatusEnabled = action.value;
          setSetting('sai-agent-status-enabled', String(action.value));
        } else if (action.type === 'agent-thread-list') {
          agentThreadListEnabled = action.value;
          setSetting('sai-agent-thread-list-enabled', String(action.value));
        } else if (action.type === 'agent-messages') {
          agentMessagesEnabled = action.value;
          setSetting('sai-agent-messages-enabled', String(action.value));
        } else if (action.type === 'detect-agents') void detectAgents();
        else if (action.type === 'cross-validation') {
          crossValidation = action.value;
          setSetting(validationSettingsKey, JSON.stringify(action.value));
        } else if (action.type === 'restart-setup') void restartSetup();
        void sendSettingsState();
      }).then((unlisten) => (stopSettingsAction = unlisten));
    }
    if (isTauri()) {
      void invoke<PostTurnCheck[]>('list_post_turn_checks').then(
        (checks) => {
          const currentKeys = new Set(postTurnResults.map(checkKey));
          postTurnResults = [
            ...checks.filter((stored) => !currentKeys.has(checkKey(stored))),
            ...postTurnResults,
          ];
          return undefined;
        },
        (cause) => (error = describe(cause)),
      );
      void detectAgents();
    }
    if (isTauri()) {
      void listen<(typeof agentTerminals)[number]>('acp-terminal-created', ({ payload }) => {
        agentTerminals = [...agentTerminals, payload];
      }).then((unlisten) => (unlistenAgentTerminals = unlisten));
      void listen<AgentEvent>('acp-event', ({ payload }) => handleAgentEvent(payload)).then(
        (unlisten) => {
          if (disposed) unlisten();
          else {
            unlistenAgentEvents = unlisten;
            void recoverInterruptedAgentTurns()
              .then(() => restoreAgentActivity())
              .finally(() => {
                acpRecoveryReady = true;
                void tickShippingRuns();
              });
            scheduleInboxRefresh();
          }
          return undefined;
        },
      );
      void listen<string>('sail-notification-click', ({ payload }) => {
        void jumpToRecentThread(payload);
      }).then((unlisten) => {
        if (disposed) unlisten();
        else unlistenNotificationClick = unlisten;
        return undefined;
      });
      updateAttentionBadge();
    }
    void initialize();
    const shippingTimer = setInterval(() => void tickShippingRuns(), 15_000);
    void tickShippingRuns();
    healthTimer = setInterval(() => void checkRuntime(), 5000);
    const sidebarRefreshTimer = setInterval(() => {
      if (client) void refreshSidebarOpenCodeThreads(client, JSON.parse(sidebarDirectoryKey));
    }, 30_000);
    diffPollTimer = setInterval(() => {
      const visible = !window.matchMedia('(max-width: 850px)').matches || mobileView === 'details';
      if (acpAgent && agentChangesOpen && activeSideTab === 'changes' && visible && !diffLoading) {
        void refreshAgentDiff(true);
        return;
      }
      if (
        !acpAgent &&
        detailsOpen &&
        activeSideTab === 'changes' &&
        sessionID &&
        visible &&
        !diffLoading
      )
        void refreshDiff(sessionID, selection, true);
    }, 3000);
    return () => {
      stopSettingsRequest?.();
      stopSettingsAction?.();
      stopCloseRequest?.();
      stopPaneClose?.();
      stopWorktreeClose?.();
      disposed = true;
      finishWorktreeApproval(false);
      clearInterval(coordinationRetry);
      clearInterval(shippingTimer);
      eventController?.abort();
      clearTimeout(refreshTimer);
      clearTimeout(diffTimer);
      clearTimeout(recoveryTimer);
      clearTimeout(inboxRefreshTimer);
      clearInterval(healthTimer);
      clearInterval(sidebarRefreshTimer);
      clearTimeout(sidebarInventoryTimer);
      clearInterval(diffPollTimer);
      discardLiveText();
      unlistenAgentEvents?.();
      unlistenBrowserAccess?.();
      unlistenCoordination?.();
      unlistenTerminalExit?.();
      unlistenAgentTerminals?.();
      unlistenNotificationClick?.();
      cancelAnimationFrame(followFrame);
      for (const pending of messageTimers.values()) clearTimeout(pending.timer);
    };
  });

  async function initialize() {
    if (!isTauri()) {
      runtimeState = 'error';
      runtimeError = 'Open the desktop app with mise run dev to start OpenCode.';
      return;
    }
    await recoverRuntime();
  }

  async function ensureOpenCodeBrowser(path: string) {
    if (!client || openCodeBrowserServers.has(path)) return;
    const config = await invoke<BrowserMcpConfig>('browser_mcp_config', { directory: path });
    await client.mcp.add({
      server: 'sail-browser',
      location: { directory: path },
      config: {
        type: 'local',
        command: [config.command, ...config.args],
        environment: config.env,
        codemode: false,
      },
    });
    openCodeBrowserServers.add(path);
  }

  function toggleAgentBrowserAccess() {
    if (!directory) return;
    browserAccessDisabled = !browserAccessDisabled;
    setSetting(`sai-browser-disabled:${directory}`, String(browserAccessDisabled));
    void invoke('browser_project_access', {
      directory,
      enabled: !browserAccessDisabled,
    }).catch((cause) => (error = describe(cause)));
  }

  async function activateRuntime(info: RuntimeInfo) {
    const nextClient = connect(info);
    const server = await nextClient.server.info({ signal: AbortSignal.timeout(5000) });
    if (!compatibleOpenCodeVersion(server.version))
      throw new Error(
        `OpenCode v${OPENCODE_VERSION} is required (found ${server.version}). Upgrade or choose a compatible binary in settings.`,
      );
    if (disposed) return;
    clearTimeout(recoveryTimer);
    eventController?.abort();
    client = nextClient;
    nativeActivityReady = false;
    openCodeBrowserServers.clear();
    activeBinary = info.binaryPath;
    runtimeState = 'connected';
    runtimeError = '';
    hasConnected = true;
    if (directory)
      await ensureOpenCodeBrowser(directory).catch((cause) => (error = describe(cause)));
    await resync().catch((cause) => {
      error = describe(cause);
    });
    await reconcileOpenCodeSpawnReceipts();
    scheduleInboxRefresh();
    eventController = new AbortController();
    connecting = false;
    void watchEvents(nextClient, eventController.signal);
  }

  async function recoverRuntime() {
    if (connecting || disposed) return;
    connecting = true;
    eventController?.abort();
    ++nativeActivityGeneration;
    nativeActivityReady = false;
    clearTimeout(recoveryTimer);
    runtimeState = 'starting';
    runtimeError = '';
    try {
      const info = await invoke<RuntimeInfo>('start_runtime', {
        binaryPath: appliedBinaryPath || null,
        restart: false,
      });
      await activateRuntime(info);
    } catch (cause) {
      if (disposed) return;
      client = null;
      scheduleInboxRefresh();
      runtimeState = 'error';
      runtimeError = describe(cause);
      if (hasConnected) recoveryTimer = setTimeout(() => void recoverRuntime(), 5000);
    } finally {
      connecting = false;
    }
  }

  async function retryRuntime() {
    if (connecting || disposed) return;
    connecting = true;
    clearTimeout(recoveryTimer);
    const candidate = binaryPath.trim();
    try {
      const info = await invoke<RuntimeInfo>('start_runtime', {
        binaryPath: candidate || null,
        restart: true,
      });
      await activateRuntime(info);
      appliedBinaryPath = candidate;
      setSetting('sai-opencode-bin', candidate);
    } catch (cause) {
      runtimeError = `${describe(cause)}${runtimeState === 'connected' ? ' The current OpenCode connection remains active.' : ''}`;
      if (runtimeState !== 'connected' && hasConnected)
        recoveryTimer = setTimeout(() => void recoverRuntime(), 5000);
    } finally {
      connecting = false;
    }
  }

  async function checkRuntime() {
    if (connecting || runtimeState !== 'connected' || !client) return;
    if (!directory || planReady || setupLoading) return;
    const now = Date.now();
    if (now - lastSetupProbe < (setupProbeCount < 12 ? 5000 : 30000)) return;
    lastSetupProbe = now;
    setupProbeCount++;
    const path = directory;
    await refreshSetup(path);
    if (
      path !== directory ||
      !setup?.pluginConfigured ||
      setup.plugin.state === 'ready' ||
      setupRestarted.has(path) ||
      sending ||
      running
    )
      return;
    try {
      const active = await client.session.active();
      if (path !== directory || Object.values(active).some((session) => session.type === 'running'))
        return;
      if ((await restartSetup()) && path === directory) setupRestarted.add(path);
    } catch (cause) {
      if (path === directory) setupError = describe(cause);
    }
  }

  async function resync() {
    if (!client || !directory) return;
    discardLiveText();
    const current = selection;
    await refreshSetup(directory);
    if (current !== selection) return;
    const path = directory;
    await refreshSessions();
    if (current !== selection || path !== directory) return;
    await reconcileNativeActivity();
    if (current !== selection || path !== directory) return;
    if (!workReady && !planReady) return;
    if (
      acpAgent ||
      getSetting(`sai-main-pane-empty:${path}`) === 'true' ||
      leaves(paneLayout).some((pane) => pane.id === 'main' && !!pane.kind)
    )
      return;
    const saved = getSetting(`sai-session:${path}`);
    const initial = sessionID ?? saved ?? sessions[0]?.id;
    if (initial && initial !== sessionID) {
      if (!(await restoreSession(initial))) {
        if (current !== selection || path !== directory) return;
        removeSetting(`sai-session:${path}`);
        if (sessions[0]) await selectSession(sessions[0].id, true);
      }
    } else if (initial) {
      await refreshSession(initial);
    }
    const active = await client.session.active();
    if (path !== directory) return;
    running = !!sessionID && active[sessionID]?.type === 'running';
  }

  function saveProjectCatalog(next: ProjectCatalog) {
    projectCatalog = next;
    setSetting('sai-project-catalog', JSON.stringify(next));
    scheduleInboxRefresh();
  }

  async function saveShipRuns(): Promise<void> {
    const value = JSON.stringify(shipRuns);
    await setSettingDurable('sai-ship-runs', value);
  }

  async function updateShipIssue(
    run: ShipRun,
    issue: ShipIssue,
    changes: Partial<ShipIssue>,
    durable = true,
  ): Promise<void> {
    const current = run.issues.find((item) => item.id === issue.id);
    if (!current) return;
    const previous = Object.fromEntries(
      Object.keys(changes).map((key) => [key, current[key as keyof ShipIssue]]),
    ) as Partial<ShipIssue>;
    if (changes.state && changes.state !== current.state)
      changes.events = appendShipEvent(current.events, changes.state, changes.error ?? undefined);
    Object.assign(current, changes);
    if (!durable) return;
    try {
      await saveShipRuns();
    } catch (cause) {
      Object.assign(current, previous);
      setSetting('sai-ship-runs', JSON.stringify(shipRuns));
      throw cause;
    }
  }

  async function startShippingRun(
    graph: PublishedGraph,
    provider: ShipRun['provider'],
    limit: number,
    source: string,
  ): Promise<void> {
    const repository = coordinationProject(directory) ?? directory;
    const remote = graph.issues[0]?.repository ?? '';
    if (!repository || !remote) throw new Error('Select a published repository issue graph.');
    const checkoutRemote = await invoke<string>('shipping_target_repository', { repository });
    if (checkoutRemote.toLowerCase() !== remote.toLowerCase())
      throw new Error(`Select a ${remote} checkout to ship this issue graph.`);
    if (shipRuns.some((run) => run.repository === repository && run.source === source))
      throw new Error('This plan already has a shipping run.');
    const run = createShipRun(
      graph,
      repository,
      remote,
      source,
      provider,
      limit,
      crypto.randomUUID(),
      Date.now(),
    );
    if (
      shipRuns.some((existing) =>
        existing.issues.some((item) => run.issues.some((issue) => issue.url === item.url)),
      )
    )
      throw new Error('An issue in this plan already has a shipping run.');
    shipRuns.push(run);
    try {
      await saveShipRuns();
    } catch (cause) {
      shipRuns = shipRuns.filter((item) => item.id !== run.id);
      setSetting('sai-ship-runs', JSON.stringify(shipRuns));
      throw cause;
    }
    showShipRuns();
    void tickShippingRuns();
  }

  async function adoptDirectShipRun(
    issue: ShipItIssue,
    path: string,
    threadId: string,
    knownWorkerModel?: string,
  ): Promise<void> {
    const provider: ShipRun['provider'] = threadId.startsWith('opencode:')
      ? 'opencode'
      : threadId.startsWith('acp:claude:')
        ? 'claude'
        : 'codex';
    const [, agent, sessionId] = /^acp:([^:]+):(.+)$/.exec(threadId) ?? [];
    const workerModel =
      knownWorkerModel ??
      agentThreads.find(
        (thread) =>
          thread.agent === agent && thread.sessionId === sessionId && thread.directory === path,
      )?.model;
    const previous = shipRuns;
    const previousIssue = previous
      .flatMap((run) => run.issues)
      .find((item) => item.path === path && item.threadId === threadId);
    const project = worktreeAt(projectCatalog, path)?.repository ?? path;
    const directRunId = crypto.randomUUID();
    const adopted = createDirectShipRun(previous, {
      id: directRunId,
      project,
      directory: path,
      repository: issue.repository,
      number: issue.number,
      provider,
      threadId,
      workerModel,
      approvedAt: Date.now(),
    });
    if (adopted === shipRuns) return;
    shipRuns = adopted;
    try {
      await saveShipRuns();
    } catch (cause) {
      shipRuns = previousIssue
        ? shipRuns.map((run) => ({
            ...run,
            issues: run.issues.map((item) =>
              item.path === path && item.threadId === threadId && item.workerModel === workerModel
                ? { ...item, workerModel: previousIssue.workerModel }
                : item,
            ),
          }))
        : shipRuns.filter((run) => run.id !== directRunId);
      throw cause;
    }
    showShipRuns();
  }

  async function launchShipIssue(run: ShipRun, issue: ShipIssue): Promise<void> {
    const receiptId = crypto.randomUUID();
    await updateShipIssue(run, issue, { state: 'starting', receiptId });
    try {
      const created = await invoke<CreatedWorktree>('create_shipping_worktree', {
        repository: run.repository,
        name: issue.branch,
      });
      await updateShipIssue(run, issue, { path: created.path, branch: created.branch });
      saveProjectCatalog(addWorktree(projectCatalog, run.repository, created));
      if (shippingSetupAction(issue, created.setup) === 'run') {
        await updateShipIssue(run, issue, { setupStarted: true });
        await invoke('run_shipping_setup', { path: created.path });
        await updateShipIssue(run, issue, { setupCompleted: true });
      }
      if (run.provider === 'opencode') {
        if (!client || runtimeState !== 'connected') throw new Error('OpenCode is unavailable.');
        const report = await inspectRepository(client, created.path);
        if (!report.workReady) throw new Error('Complete OpenCode setup in this worktree.');
      } else {
        const available = (await acp.agents()).find((agent) => agent.id === run.provider);
        if (!available?.available)
          throw new Error(available?.reason ?? `${run.provider} is unavailable.`);
        await acp.connect(run.provider);
      }
      const inlineGates = !crossValidation.choices.length && !crossValidation.strictDifferentModel;
      const gateExecution = inlineGates
        ? 'Run the Code Adversary, Findings Adversary, and Test Adversary in this Ship It session with the implementation agent and model. Do not call validation_gate or require agent coordination.'
        : 'Run each adversarial review pass and manual test in a fresh subagent session. If a gate session cannot launch, pause and report the reason in this thread.';
      const gateReporting = inlineGates
        ? 'After every completed adversary pass, use ship_progress with its gate (code-adversary, findings-adversary, or test-adversary), actual verdict, and reason when blocked or failed.'
        : 'Validation sessions report their own gate verdicts through ship_progress; do not report them from this implementation session.';
      const prompt = `/ship-it ${issue.url}\n\nSail already created this issue worktree from the latest default branch. Stay here; skip branch creation and cleanup. Read the canonical task checkpoint before resuming. Resolve the issue, then replace its initial objective and acceptance criteria with the concrete task contract. Update the checkpoint after every phase, blocker, revision change, and next-action change. ${gateExecution} Use ship_progress to report each stage (implementing, reviewing, testing, pull_request, ci, and merging), with status running or blocked and a reason when blocked. ${gateReporting}`;
      saveSpawnReceipt({
        receiptId,
        accessKey: crypto.randomUUID(),
        requestId: `ship:${run.id}:${issue.id}`,
        project: run.repository,
        sourceId: `ship:${run.id}`,
        sourceDirectory: run.repository,
        targetId: null,
        turnId: null,
        targetDirectory: created.path,
        worktreeId: created.path,
        provider: run.provider,
        prompt,
        state: 'starting',
        created: Date.now(),
        updated: Date.now(),
        result: null,
        error: null,
      });
      await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
      const started = await startCoordinatedThread(
        created,
        run.provider === 'opencode'
          ? { kind: 'opencode', agent: 'OpenCode', title: issue.title }
          : { kind: 'acp', agent: run.provider, title: issue.title },
        prompt,
        receiptId,
      );
      await updateShipIssue(run, issue, { state: 'working', threadId: started.threadId });
    } catch (cause) {
      const receipt = spawnReceipts.find((item) => item.receiptId === receiptId);
      if (receipt && !receipt.turnId) {
        updateSpawnReceipt(receiptId, { state: 'failed', error: describe(cause) });
        await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
      }
      await updateShipIssue(run, issue, { state: 'failed', error: describe(cause) });
    }
  }

  function scheduleShipLaunch(run: ShipRun, issue: ShipIssue): void {
    const key = `${run.id}:${issue.id}`;
    if (activeShipLaunches.has(key)) return;
    activeShipLaunches.add(key);
    void launchShipIssue(run, issue)
      .catch((cause) => (error = describe(cause)))
      .finally(() => activeShipLaunches.delete(key));
  }

  async function refreshShippingDependency(run: ShipRun, dependency: string): Promise<void> {
    try {
      const closed = await invoke<boolean>('shipping_dependency_closed', {
        repository: run.repository,
        reference: dependency,
      });
      run.externalClosed[dependency] = closed;
      delete run.dependencyErrors?.[dependency];
    } catch (cause) {
      error = describe(cause);
      run.externalClosed[dependency] = false;
      run.dependencyErrors ??= {};
      run.dependencyErrors[dependency] = describe(cause);
    }
  }

  const shippingPullRequests = new SvelteMap<string, ShippingPullRequest | null>();

  async function refreshShippingPullRequest(run: ShipRun, issue: ShipIssue): Promise<void> {
    try {
      const pr = await invoke<ShippingPullRequest | null>('shipping_pull_request', {
        repository: run.repository,
        branch: issue.branch,
      });
      if (pr) shippingPullRequests.set(`${run.id}:${issue.id}`, pr);
      await updateShipIssue(run, issue, refreshedPullRequest(issue, pr), false);
    } catch (cause) {
      await updateShipIssue(run, issue, { refreshError: describe(cause) }, false);
    }
  }

  async function directShipWorkerState(issue: ShipIssue): Promise<SpawnState> {
    if (!issue.threadId || !issue.path) return 'unavailable';
    if (issue.threadId.startsWith('opencode:')) {
      if (!client) return 'unavailable';
      const sessionId = issue.threadId.slice('opencode:'.length);
      try {
        const [session, active, inbox, permissions, forms] = await Promise.all([
          client.session.get({ sessionID: sessionId }),
          client.session.active(),
          client.session.inbox.list({ sessionID: sessionId }),
          client.permission.request.list({ location: { directory: issue.path } }),
          client.form.list({ location: { directory: issue.path } }),
        ]);
        if (session.location.directory !== issue.path) return 'unavailable';
        if (
          permissions.data.some((item) => item.sessionID === sessionId) ||
          forms.data.some((item) => item.sessionID === sessionId)
        )
          return 'waiting';
        if (active[sessionId]?.type === 'running') return 'working';
        if (session.outcome === 'succeeded') return 'completed';
        if (session.outcome === 'failed') return 'failed';
        if (session.outcome) return 'interrupted';
        return inbox.length ? 'queued' : 'completed';
      } catch {
        return 'unavailable';
      }
    }
    const match = /^acp:([^:]+):(.+)$/.exec(issue.threadId);
    if (!match) return 'unavailable';
    const [, agent, sessionId] = match;
    try {
      const [agentActivity, interrupted] = await Promise.all([
        acp.activity(),
        acp.interruptedTurns(),
      ]);
      const state = agentActivity[agent];
      if (state?.waiting.includes(sessionId)) return 'waiting';
      if (state?.active.includes(sessionId)) return 'working';
      if (interrupted.some((turn) => turn.agent === agent && turn.sessionId === sessionId))
        return 'interrupted';
      if (state?.finished[sessionId]?.status === 'failed') return 'failed';
      if (state?.finished[sessionId] || state?.sessions.includes(sessionId)) return 'completed';
      return 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  function missingRepositoryPath(cause: unknown): boolean {
    return describe(cause) === 'Repository path does not exist. Choose an existing directory.';
  }

  async function refreshShippingIssue(
    run: ShipRun,
    issue: ShipIssue,
    refreshCompleted = false,
  ): Promise<void> {
    const update = (changes: Partial<ShipIssue>) => updateShipIssue(run, issue, changes, false);
    if (
      !refreshCompleted &&
      issue.state === 'merged' &&
      issue.workerSettled &&
      !issue.path &&
      issue.refreshedAt &&
      issue.checks !== undefined
    )
      return;
    const worker = spawnReceipts.find((item) => item.receiptId === issue.receiptId);
    const path = issue.path ?? worker?.targetDirectory;
    if (path) {
      const models = implementationModels(path);
      const modelUncertain = implementationAttributionUncertain(path);
      const workerModel = resolvedWorkerModel({ ...issue, models });
      if (
        JSON.stringify(models) !== JSON.stringify(issue.models) ||
        modelUncertain !== issue.modelUncertain ||
        workerModel !== issue.workerModel
      )
        await update({ models, modelUncertain, workerModel });
    }
    issue.gates = reconciledShipGates(issue, spawnReceipts);
    await Promise.all(
      (issue.gates ?? []).map(async (gate) => {
        const receipt = spawnReceipts.find((item) => item.receiptId === gate.id);
        if (receipt && !shippingWorkerSettled(receipt.state)) await currentSpawnReceipt(receipt);
      }),
    );
    issue.gates = reconciledShipGates(issue, spawnReceipts);
    if (isDirectShipRun(run)) {
      const workerState = await directShipWorkerState(issue);
      if (workerState !== issue.workerState) await update({ workerState });
      const project = issue.path ? worktreeAt(projectCatalog, issue.path)?.repository : undefined;
      if (project && run.repository !== project) run.repository = project;
      let registered: RegisteredWorktree[];
      try {
        registered = await invoke<RegisteredWorktree[]>('registered_worktrees', {
          repository: run.repository,
          paths: issue.path ? [issue.path] : [],
        });
      } catch (cause) {
        if (missingRepositoryPath(cause)) {
          await update({
            workerState: 'unavailable',
            worktreeUnavailable: true,
            refreshError: null,
            refreshedAt: Date.now(),
          });
          return;
        }
        throw cause;
      }
      const worktree = registered.find((item) => item.path === issue.path);
      if (issue.path && !worktree && !issue.worktreeUnavailable)
        await update({ worktreeUnavailable: true });
      else if (worktree && issue.worktreeUnavailable) await update({ worktreeUnavailable: false });
      if (worktree?.branch && worktree.branch !== issue.branch)
        await update({ branch: worktree.branch });
      try {
        const closed = await invoke<boolean>('shipping_dependency_closed', {
          repository: run.repository,
          reference: issue.id,
        });
        await update({
          ...refreshedIssueState(issue, closed),
          refreshError: null,
          refreshedAt: Date.now(),
        });
        const branch = worktree?.branch ?? issue.branch;
        if (branch && issue.state !== 'pending')
          await refreshShippingPullRequest(run, { ...issue, branch });
        if (issue.refreshError) return;
        const pr = shippingPullRequests.get(`${run.id}:${issue.id}`);
        if (pr?.mergedAt) {
          await update({ state: 'merged', workerSettled: true, error: null });
        } else if (pr?.state === 'CLOSED') {
          await update({
            state: 'failed',
            workerSettled: true,
            error: 'Pull request closed without merging.',
          });
        } else if (workerState === 'completed') {
          await update(
            pr?.url
              ? { state: 'awaiting_merge', workerSettled: true, error: null }
              : {
                  state: 'failed',
                  workerSettled: true,
                  error: 'Worker finished without a pull request. Inspect its thread.',
                },
          );
        } else if (workerState === 'failed' || workerState === 'interrupted') {
          await update({
            state: 'failed',
            workerSettled: true,
            error: `Worker ${workerState}.`,
          });
        } else if (
          workerState === 'working' ||
          workerState === 'waiting' ||
          workerState === 'queued'
        ) {
          await update({ state: 'working', workerSettled: false, error: null });
        }
      } catch (cause) {
        await update({ refreshError: describe(cause) });
      }
      return;
    }
    try {
      const closed = await invoke<boolean>('shipping_dependency_closed', {
        repository: run.repository,
        reference: String(issue.number),
      });
      await update({
        ...refreshedIssueState(issue, closed),
        refreshError: null,
        refreshedAt: Date.now(),
      });
    } catch (cause) {
      await update({ refreshError: describe(cause) });
      return;
    }
    if (issue.state !== 'pending') await refreshShippingPullRequest(run, issue);
    if (issue.refreshError) return;
    if (issue.state === 'merged') {
      if (issue.workerSettled && !issue.path) return;
      if (!issue.workerSettled) {
        const receipt = spawnReceipts.find((item) => item.receiptId === issue.receiptId);
        if (!receipt) {
          await update({
            error: 'Worker receipt is missing. Inspect its thread before cleanup.',
          });
          return;
        }
        if (!shippingWorkerSettled((await currentSpawnReceipt(receipt)).state)) return;
        await update({ workerSettled: true });
      }
      const taskThreadIds = [issue.threadId, ...(issue.checkpointThreadIds ?? [])].filter(
        (threadId): threadId is string => Boolean(threadId),
      );
      const taskThreadStates = Object.fromEntries(
        await Promise.all(
          taskThreadIds.map(async (threadId) => [
            threadId,
            await directShipWorkerState({ ...issue, threadId }),
          ]),
        ),
      );
      if (
        issue.path &&
        shipGatesSettled(issue) &&
        shipTaskThreadsSettled(issue, taskThreadStates, spawnReceipts)
      ) {
        try {
          await updateShipIssue(run, issue, await settledImplementationAttribution(issue.path));
          if (!shipGatesSettled(issue)) return;
          const archivePath = await invoke<string | null>('delete_worktree', {
            repository: run.repository,
            worktree: issue.path,
            force: false,
            archiveIgnored: true,
          });
          saveProjectCatalog(removeWorktree(projectCatalog, run.repository, issue.path));
          await updateShipIssue(run, issue, { path: null, archivePath, error: null });
        } catch (cause) {
          await update({ error: `Cleanup: ${describe(cause)}` });
        }
      }
      return;
    }
    if (issue.state === 'pending') return;
    if (issue.state === 'starting' && activeShipLaunches.has(`${run.id}:${issue.id}`)) return;
    if (run.provider === 'opencode' && !client && ['starting', 'working'].includes(issue.state))
      return;
    const pr = shippingPullRequests.get(`${run.id}:${issue.id}`);
    if (pr?.url && pr.url !== issue.pullRequest) await update({ pullRequest: pr.url });
    if (pr?.mergedAt) {
      await update({ state: 'merged', error: null });
      return;
    }
    if (pr?.state === 'CLOSED') {
      const receipt = spawnReceipts.find((item) => item.receiptId === issue.receiptId);
      if (receipt && !shippingWorkerSettled(receipt.state)) await currentSpawnReceipt(receipt);
      await update({
        state: 'failed',
        error: 'Pull request closed without merging.',
      });
      return;
    }
    const receipt = spawnReceipts.find((item) => item.receiptId === issue.receiptId);
    if (issue.state === 'failed') {
      if (receipt && !shippingWorkerSettled(receipt.state)) await currentSpawnReceipt(receipt);
      if (
        issue.error === 'Worker finished without a pull request. Inspect its thread.' &&
        receipt?.state === 'completed' &&
        pr?.url
      )
        await update({ state: 'awaiting_merge', error: null });
      return;
    }
    if (issue.state === 'starting') {
      if (!receipt || !receipt.targetId || (receipt.provider !== 'opencode' && !receipt.turnId)) {
        const existing = await invoke<CreatedWorktree | null>('find_shipping_worktree', {
          repository: run.repository,
          name: issue.branch,
        });
        if (existing && issue.path !== existing.path) await update({ path: existing.path });
        scheduleShipLaunch(run, issue);
      } else {
        if (receipt.provider === 'opencode') await recoverShippingOpenCodePrompt(receipt);
        else await recoverShippingAcpPrompt(receipt);
        await update({ state: 'working', threadId: receipt.targetId });
      }
    } else if (issue.state === 'working') {
      if (!receipt)
        await update({
          state: 'failed',
          error: 'Worker receipt is missing. Inspect its thread.',
        });
      else {
        const current = await currentSpawnReceipt(receipt);
        if (current.state === 'completed') {
          if (pr?.url) await update({ state: 'awaiting_merge', error: null });
          else if (Date.now() - current.updated > 60_000)
            await update({
              state: 'failed',
              error: 'Worker finished without a pull request. Inspect its thread.',
            });
        } else if (['failed', 'interrupted'].includes(current.state))
          await update({
            state: 'failed',
            error: current.error ?? `Worker ${current.state}.`,
          });
      }
    }
  }

  async function refreshShippingRun(run: ShipRun, refreshCompleted = false): Promise<void> {
    run.externalClosed ??= {};
    run.dependencyErrors ??= {};
    const aliases = new Set(
      run.issues.flatMap((issue) => [
        issue.id,
        String(issue.number),
        `${run.remote}#${issue.number}`,
      ]),
    );
    await Promise.all(
      [...new Set(run.issues.flatMap((issue) => issue.dependsOn))]
        .filter((dependency) => !aliases.has(dependency))
        .map((dependency) => refreshShippingDependency(run, dependency)),
    );
    await settleShipRefresh(
      run.issues.map((issue) => refreshShippingIssue(run, issue, refreshCompleted)),
    );
  }

  function launchReadyShipIssues(run: ShipRun): void {
    const unsettledReceiptIds = new Set(
      spawnReceipts
        .filter((receipt) => !shippingWorkerSettled(receipt.state))
        .map((receipt) => receipt.receiptId),
    );
    for (const issue of readyShipIssues(run, unsettledReceiptIds)) scheduleShipLaunch(run, issue);
  }

  async function tickShippingRuns(refreshCompleted = false): Promise<void> {
    if (shippingBusy || disposed || !isTauri() || !acpRecoveryReady) return;
    shippingBusy = true;
    try {
      await persistShipRefresh(
        shipRuns.map((run) => refreshShippingRun(run, refreshCompleted)),
        saveShipRuns,
      );
      for (const run of shipRuns) launchReadyShipIssues(run);
    } catch (cause) {
      error = describe(cause);
    } finally {
      shippingBusy = false;
    }
  }

  function saveSpawnReceipt(receipt: SpawnReceipt) {
    const protectedIds = new SvelteSet(
      shipRuns.flatMap((run) =>
        run.issues.flatMap((issue) =>
          issue.receiptId && (issue.state !== 'merged' || issue.workerSettled !== true)
            ? [issue.receiptId]
            : [],
        ),
      ),
    );
    for (const run of shipRuns)
      for (const issue of run.issues)
        for (const gate of issue.gates ?? [])
          if (!shippingWorkerSettled(gate.state)) protectedIds.add(gate.id);
    for (const run of shipRuns)
      for (const issue of run.issues)
        if (issue.path) {
          if (issue.receiptId) protectedIds.add(issue.receiptId);
          for (const threadId of issue.checkpointThreadIds ?? []) {
            const handoff = spawnReceipts.find((item) => item.targetId === threadId);
            if (handoff) protectedIds.add(handoff.receiptId);
          }
        }
    spawnReceipts = saveBoundedReceipt(spawnReceipts, receipt, protectedIds);
    setSetting('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
    for (const run of shipRuns) {
      const issue = run.issues.find((item) => item.receiptId === receipt.receiptId);
      if (issue) {
        issue.threadId = receipt.targetId;
        issue.workerModel = receipt.model;
        issue.workerState = receipt.state;
        issue.workerUpdatedAt = Math.max(issue.workerUpdatedAt ?? 0, receipt.updated);
        void saveShipRuns().catch((cause) => (error = describe(cause)));
      }
    }
    const owner = shipOwner(shipRuns, receipt.sourceDirectory, receipt.sourceId);
    const gate = gateSnapshot(receipt);
    if (owner && gate) {
      owner.issue.gates = [
        ...(owner.issue.gates ?? []).filter((item) => item.id !== gate.id),
        gate,
      ].toSorted((a, b) => a.created - b.created);
      void saveShipRuns().catch((cause) => (error = describe(cause)));
    }
    if (
      authorizeShipCheckpointThread(
        shipRuns,
        receipt.sourceDirectory,
        receipt.sourceId,
        receipt.targetDirectory,
        receipt.targetId,
      )
    )
      void saveShipRuns().catch((cause) => (error = describe(cause)));
  }

  function updateSpawnReceipt(id: string, changes: Partial<SpawnReceipt>, preserveUpdated = false) {
    const current = spawnReceipts.find((item) => item.receiptId === id);
    if (!current) return;
    if (
      !receiptNeedsRefresh(current) &&
      changes.state &&
      ['working', 'waiting', 'unavailable'].includes(changes.state)
    )
      return;
    if (
      Object.entries(changes).every(([key, value]) => current[key as keyof SpawnReceipt] === value)
    )
      return;
    saveSpawnReceipt({
      ...current,
      ...changes,
      updated: preserveUpdated ? current.updated : Date.now(),
    });
  }

  async function settleOpenCodeReceipt(
    receipt: SpawnReceipt,
    source: OpenCodeClient,
    outcome: 'succeeded' | 'failed' | 'interrupted' | undefined,
  ) {
    const sessionId = receipt.targetId?.slice('opencode:'.length);
    if (!sessionId || !receipt.prompt) {
      updateSpawnReceipt(receipt.receiptId, { state: 'unavailable' });
      return;
    }
    const page = await source.message.list({ sessionID: sessionId, limit: 50, order: 'desc' });
    const users = page.data.filter((message) => message.type === 'user');
    if (users.length !== 1 || users[0].text !== receipt.prompt) {
      updateSpawnReceipt(receipt.receiptId, { state: 'unavailable' });
      return;
    }
    const idle = page.data.find((message) => message.type === 'idle');
    const finished = idle?.outcome ?? outcome;
    if (!finished) {
      updateSpawnReceipt(receipt.receiptId, { state: 'unavailable' });
      return;
    }
    const result =
      page.data
        .flatMap((message) =>
          message.type === 'assistant' && message.time.completed
            ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
            : [],
        )
        .join('\n')
        .slice(-16_000) || null;
    updateSpawnReceipt(receipt.receiptId, {
      state:
        finished === 'succeeded' ? 'completed' : finished === 'failed' ? 'failed' : 'interrupted',
      result,
    });
  }

  async function currentSpawnReceipt(receipt: SpawnReceipt): Promise<SpawnReceipt> {
    if (!receiptNeedsRefresh(receipt)) return receipt;
    if (activeSpawnRequests.has(receipt.receiptId)) return receipt;
    if (
      !receipt.targetId ||
      !receipt.targetDirectory ||
      (receipt.provider !== 'opencode' && !receipt.turnId)
    ) {
      if (activeSpawnRequests.has(receipt.receiptId)) return receipt;
      updateSpawnReceipt(receipt.receiptId, { state: 'unavailable' });
      return spawnReceipts.find((item) => item.receiptId === receipt.receiptId) ?? receipt;
    }
    if (receipt.provider !== 'opencode') {
      const receiptActivity = await acp.activity().then(
        (states) => states[receipt.provider],
        () => null,
      );
      reconcileAcpSpawnReceipt(receipt, receiptActivity);
    } else if (client) {
      const sessionId = receipt.targetId.slice('opencode:'.length);
      try {
        const [session, active, inbox, permissions, forms] = await Promise.all([
          client.session.get({ sessionID: sessionId }),
          client.session.active(),
          client.session.inbox.list({ sessionID: sessionId }),
          client.permission.request.list({ location: { directory: receipt.targetDirectory } }),
          client.form.list({ location: { directory: receipt.targetDirectory } }),
        ]);
        if (session.location.directory !== receipt.targetDirectory)
          throw new Error('Target session moved to another worktree.');
        if (
          permissions.data.some((item) => item.sessionID === sessionId) ||
          forms.data.some((item) => item.sessionID === sessionId)
        )
          updateSpawnReceipt(receipt.receiptId, { state: 'waiting' });
        else if (active[sessionId]?.type === 'running')
          updateSpawnReceipt(receipt.receiptId, { state: 'working' });
        else if (session.outcome) await settleOpenCodeReceipt(receipt, client, session.outcome);
        else if (inbox.some((item) => item.id === receipt.turnId))
          updateSpawnReceipt(receipt.receiptId, { state: 'queued' });
        else if (!receipt.turnId && inbox.length === 1)
          updateSpawnReceipt(receipt.receiptId, { state: 'queued', turnId: inbox[0].id });
        else if (receipt.state === 'starting') return receipt;
        else await settleOpenCodeReceipt(receipt, client, session.outcome);
      } catch {
        updateSpawnReceipt(receipt.receiptId, { state: 'unavailable' });
      }
    } else {
      updateSpawnReceipt(receipt.receiptId, { state: 'unavailable' });
    }
    return spawnReceipts.find((item) => item.receiptId === receipt.receiptId) ?? receipt;
  }

  async function recoverShippingOpenCodePrompt(receipt: SpawnReceipt): Promise<void> {
    if (!client || !receipt.targetId || !receipt.prompt) return;
    const source = client;
    const sessionId = receipt.targetId.slice('opencode:'.length);
    activeSpawnRequests.add(receipt.receiptId);
    try {
      const [session, page, inbox, active] = await Promise.all([
        source.session.get({ sessionID: sessionId }),
        source.message.list({ sessionID: sessionId, limit: 50, order: 'desc' }),
        source.session.inbox.list({ sessionID: sessionId }),
        source.session.active(),
      ]);
      if (session.location.directory !== receipt.targetDirectory)
        throw new Error('Target session moved to another worktree.');
      const promptSeen = page.data.some(
        (message) => message.type === 'user' && message.text === receipt.prompt,
      );
      if (promptSeen || inbox.length || active[sessionId]?.type === 'running' || session.outcome)
        return;
      const turnId = receipt.turnId ?? crypto.randomUUID();
      if (!receipt.turnId) {
        updateSpawnReceipt(receipt.receiptId, { turnId });
        await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
      }
      const startingPrompt = source.session.prompt({
        sessionID: sessionId,
        text: receipt.prompt,
        id: turnId,
      });
      const inboxItem = await startingPrompt;
      updateSpawnReceipt(receipt.receiptId, { state: 'queued', turnId: inboxItem.id });
    } finally {
      activeSpawnRequests.delete(receipt.receiptId);
    }
  }

  async function recoverShippingAcpPrompt(receipt: SpawnReceipt): Promise<void> {
    if (!receipt.targetId || !receipt.targetDirectory || !receipt.turnId || !receipt.prompt) return;
    const sessionId = receipt.targetId.slice(`acp:${receipt.provider}:`.length);
    const [agentActivity, interrupted] = await Promise.all([
      acp.activity(),
      acp.interruptedTurns(),
    ]);
    const state = agentActivity[receipt.provider];
    if (
      state?.activeTurns[sessionId] === receipt.turnId ||
      state?.finished[sessionId]?.turnId === receipt.turnId ||
      interrupted.some(
        (turn) =>
          turn.agent === receipt.provider &&
          turn.sessionId === sessionId &&
          turn.turnId === receipt.turnId,
      )
    )
      return;
    activeSpawnRequests.add(receipt.receiptId);
    try {
      const info = await acp.connect(receipt.provider);
      const capabilities = info.agentCapabilities;
      const sessionCapabilities =
        capabilities && typeof capabilities === 'object' && 'sessionCapabilities' in capabilities
          ? capabilities.sessionCapabilities
          : null;
      const canResume =
        sessionCapabilities &&
        typeof sessionCapabilities === 'object' &&
        'resume' in sessionCapabilities;
      if (canResume) await acp.resume(receipt.provider, receipt.targetDirectory, sessionId);
      else await acp.load(receipt.provider, receipt.targetDirectory, sessionId);
      const turn = acp.prompt(receipt.provider, sessionId, receipt.prompt, receipt.turnId);
      activeSpawnTargets.set(receipt.targetId, receipt.receiptId);
      void turn.then(
        (outcome) => {
          const current = spawnReceipts.find((item) => item.receiptId === receipt.receiptId);
          updateSpawnReceipt(receipt.receiptId, {
            state:
              outcome.stopReason === 'cancelled' || current?.state === 'interrupted'
                ? 'interrupted'
                : 'completed',
            result: spawnOutput.get(receipt.receiptId) ?? current?.result ?? null,
          });
          spawnOutput.delete(receipt.receiptId);
          if (activeSpawnTargets.get(receipt.targetId!) === receipt.receiptId)
            activeSpawnTargets.delete(receipt.targetId!);
          return undefined;
        },
        (cause) => {
          updateSpawnReceipt(receipt.receiptId, { state: 'failed', error: describe(cause) });
          return undefined;
        },
      );
      await awaitCoordinationStart(turn, async () => {
        const current = (await acp.activity())[receipt.provider];
        return current?.activeTurns[sessionId] === receipt.turnId;
      });
    } finally {
      activeSpawnRequests.delete(receipt.receiptId);
    }
  }

  async function reconcileOpenCodeSpawnReceipts() {
    await Promise.all(
      spawnReceipts
        .filter((receipt) => receipt.provider === 'opencode' && receiptNeedsRefresh(receipt))
        .map((receipt) => currentSpawnReceipt(receipt)),
    );
  }

  function reconcileAcpSpawnReceipt(
    receipt: SpawnReceipt,
    agentActivity: Awaited<ReturnType<typeof acp.activity>>[AgentId] | null,
  ) {
    const state = acpReceiptState(receipt, agentActivity);
    if (
      receipt.requestId.startsWith('ship:') &&
      receipt.state === 'starting' &&
      state === 'unavailable'
    )
      return;
    if (state === 'working' || state === 'waiting') {
      updateSpawnReceipt(receipt.receiptId, { state });
      activeSpawnTargets.set(receipt.targetId!, receipt.receiptId);
    } else {
      const sessionId = receipt.targetId?.slice(`acp:${receipt.provider}:`.length);
      const outcome = sessionId ? agentActivity?.finished[sessionId] : undefined;
      updateSpawnReceipt(receipt.receiptId, {
        state,
        result: spawnOutput.get(receipt.receiptId) ?? receipt.result,
        error:
          state === 'failed' && outcome?.turnId === receipt.turnId
            ? (outcome.error ?? receipt.error)
            : receipt.error,
      });
      if (state === 'completed' && !spawnOutput.has(receipt.receiptId))
        void recoverAcpSpawnResult(receipt).catch(() => undefined);
      if (receipt.targetId && activeSpawnTargets.get(receipt.targetId) === receipt.receiptId)
        activeSpawnTargets.delete(receipt.targetId);
    }
  }

  async function recoverAcpSpawnResult(receipt: SpawnReceipt) {
    if (!receipt.targetId || !receipt.targetDirectory || !receipt.prompt) return;
    const sessionId = receipt.targetId.slice(`acp:${receipt.provider}:`.length);
    const replay: AgentEntry[] = [];
    const unlisten = await listen<AgentEvent>('acp-event', ({ payload }) => {
      if (payload.agent !== receipt.provider || payload.message.method !== 'session/update') return;
      const params = payload.message.params;
      if (params?.sessionId !== sessionId) return;
      const update = params.update;
      if (update && typeof update === 'object')
        updateEntriesInPlace(replay, update as Record<string, unknown>);
    });
    setAgentReplay(receipt.provider, sessionId, true);
    try {
      await acp.connect(receipt.provider);
      await acp.load(receipt.provider, receipt.targetDirectory, sessionId);
      const promptIndex = replay.findLastIndex(
        (entry) => entry.type === 'user' && entry.text.includes(receipt.prompt!),
      );
      if (promptIndex < 0) return;
      const following = replay.slice(promptIndex + 1);
      const nextUser = following.findIndex((entry) => entry.type === 'user');
      const turn = nextUser < 0 ? following : following.slice(0, nextUser);
      const result = turn
        .flatMap((entry) => (entry.type === 'assistant' ? [entry.text] : []))
        .join('\n')
        .slice(-16_000);
      if (result) updateSpawnReceipt(receipt.receiptId, { result }, true);
    } catch {
      return;
    } finally {
      setAgentReplay(receipt.provider, sessionId, false);
      unlisten();
    }
  }

  function coordinationProject(path: string): string | null {
    if (projectCatalog.repositories.includes(path)) return path;
    return (
      Object.entries(projectCatalog.worktrees).find(([, worktrees]) =>
        worktrees.some((worktree) => worktree.path === path),
      )?.[0] ?? null
    );
  }

  async function coordinationSource(request: CoordinationRequest): Promise<CoordinationSource> {
    if (!request.sourceAgent) {
      if (!client) throw new Error('The source agent session is unavailable.');
      const session = await client.session.get({ sessionID: request.sessionId });
      if (session.location.directory !== request.directory)
        throw new Error('The source agent session belongs to another worktree.');
      return {
        kind: 'opencode',
        agent: session.agent ?? 'OpenCode',
        model: session.model,
        title: session.title ?? 'OpenCode thread',
      };
    }
    const matches = agentThreads.filter(
      (item) =>
        item.directory === request.directory &&
        item.sessionId === request.sessionId &&
        item.agent === request.sourceAgent,
    );
    if (matches.length > 1) throw new Error('The source agent session is ambiguous.');
    const thread = matches[0];
    if (!thread) throw new Error('The source agent session is unavailable.');
    const runtime = (await acp.activity())[thread.agent];
    if (!runtime?.alive || !runtime.sessions.includes(thread.sessionId))
      throw new Error('The source agent session is unavailable.');
    return { kind: 'acp', agent: thread.agent, title: thread.title };
  }

  async function projectCoordinationThreads(project: string): Promise<CoordinationThread[]> {
    const directories = [
      project,
      ...(projectCatalog.worktrees[project] ?? []).map((worktree) => worktree.path),
    ];
    const threads: CoordinationThread[] = agentThreads
      .filter((thread) => directories.includes(thread.directory))
      .map((thread) => ({
        id: `acp:${thread.agent}:${thread.sessionId}`,
        directory: thread.directory,
        title: thread.title,
        agent: thread.agent,
      }));
    if (!client) return threads;
    const openCode = client;
    async function collect(
      path: string,
      cursor: string | undefined,
      seen: Set<string>,
    ): Promise<CoordinationThread[]> {
      const page = await openCode.session.list({
        directory: path,
        limit: 100,
        order: 'desc',
        parentID: null,
        ...(cursor ? { cursor } : {}),
      });
      const found = page.data
        .filter((session) => session.location.directory === path && !session.parentID)
        .map((session) => ({
          id: `opencode:${session.id}`,
          directory: path,
          title: session.title ?? 'OpenCode thread',
          agent: session.agent ?? 'OpenCode',
        }));
      const next = page.cursor.next ?? undefined;
      if (!next || seen.has(next)) return found;
      seen.add(next);
      return [...found, ...(await collect(path, next, seen))];
    }
    const listed = await Promise.all(
      directories.map((path) => collect(path, undefined, new Set())),
    );
    return [...threads, ...listed.flat()];
  }

  function queueCoordinationDelivery(target: CoordinationThread, message: CoordinationMessage) {
    const previous = coordinationDeliveries.get(message.target) ?? Promise.resolve();
    const delivery = previous
      .catch(() => undefined)
      .then(async () => {
        if (disposed || coordinationMessages.find((item) => item.id === message.id)?.delivered)
          return;
        const text = coordinationPrompt(message);
        const thread = agentThreads.find(
          (item) =>
            item.directory === target.directory &&
            target.id === `acp:${item.agent}:${item.sessionId}`,
        );
        if (thread) {
          const info = await acp.connect(thread.agent);
          const agentActivity = (await acp.activity())[thread.agent];
          if (!agentActivity?.sessions.includes(thread.sessionId)) {
            const capabilities = info.agentCapabilities;
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
            if (canResume) await acp.resume(thread.agent, thread.directory, thread.sessionId);
            else await acp.load(thread.agent, thread.directory, thread.sessionId);
          }
          await waitForCoordinationThread(thread);
          if (disposed) return;
          await invoke('record_turn_snapshot', {
            path: thread.directory,
            thread: target.id,
          });
          const tracking = await beginImplementationTurn(thread.directory, thread.model, target.id);
          updateAgentThreadStatus(thread, 'working');
          const turn = acp.prompt(thread.agent, thread.sessionId, text, crypto.randomUUID());
          void turn
            .then(
              async () => {
                await recordImplementationModel(thread.directory, thread.model, tracking);
                updateAgentThreadStatus(thread, 'done');
                return undefined;
              },
              async (cause) => {
                await recordImplementationModel(thread.directory, thread.model, tracking);
                updateAgentThreadStatus(thread, 'failed');
                error = `Agent message turn failed: ${describe(cause)}`;
                return undefined;
              },
            )
            .catch((cause) => {
              abandonImplementationTurn(thread.directory, tracking);
              error = `Could not track agent message turn: ${describe(cause)}`;
            });
          await awaitCoordinationStart(turn, async () => {
            const state = (await acp.activity())[thread.agent];
            return !!state?.active.includes(thread.sessionId);
          });
        } else {
          if (!client) throw new Error('OpenCode is unavailable for the receiving thread.');
          const promptClient = client;
          const sessionId = target.id.slice('opencode:'.length);
          await waitForOpenCodeCoordinationThread(sessionId);
          if (disposed) return;
          await invoke('record_turn_snapshot', { path: target.directory, thread: target.id });
          const session = await promptClient.session.get({ sessionID: sessionId });
          const tracking = await beginImplementationTurn(
            target.directory,
            session.model ? `${session.model.providerID}:${session.model.id}` : undefined,
            target.id,
          );
          const turn = promptClient.session.prompt({
            sessionID: sessionId,
            text,
          });
          void turn
            .then(() => promptClient.session.wait({ sessionID: sessionId }))
            .then(
              () =>
                recordImplementationModel(
                  target.directory,
                  session.model ? `${session.model.providerID}:${session.model.id}` : undefined,
                  tracking,
                ),
              () =>
                recordImplementationModel(
                  target.directory,
                  session.model ? `${session.model.providerID}:${session.model.id}` : undefined,
                  tracking,
                ),
            )
            .catch((cause) => {
              abandonImplementationTurn(target.directory, tracking);
              error = `Agent message turn failed: ${describe(cause)}`;
            });
          await awaitCoordinationStart(turn, async () => {
            const active = await promptClient.session.active();
            return active[sessionId]?.type === 'running';
          });
        }
        coordinationMessages = coordinationMessages.map((item) =>
          item.id === message.id ? { ...item, delivered: true } : item,
        );
        setSetting('sai-coordination-messages', JSON.stringify(coordinationMessages));
        return undefined;
      });
    coordinationDeliveries.set(message.target, delivery);
    void delivery
      .catch((cause) => {
        error = `Could not deliver agent message: ${describe(cause)}`;
      })
      .finally(() => {
        if (coordinationDeliveries.get(message.target) === delivery)
          coordinationDeliveries.delete(message.target);
      });
  }

  async function waitForCoordinationThread(thread: AgentThread): Promise<void> {
    if (disposed) return;
    const agentActivity = (await acp.activity())[thread.agent];
    if (!agentActivity?.active.includes(thread.sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return waitForCoordinationThread(thread);
  }

  async function waitForOpenCodeCoordinationThread(sessionId: string): Promise<void> {
    if (disposed || !client) return;
    const active = await client.session.active();
    if (active[sessionId]?.type !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return waitForOpenCodeCoordinationThread(sessionId);
  }

  function retryCoordinationDeliveries() {
    if (disposed) return;
    for (const message of coordinationMessages) {
      if (message.delivered || coordinationDeliveries.has(message.target)) continue;
      const last = coordinationAttempts.get(message.id) ?? 0;
      if (Date.now() - last < 30_000) continue;
      const split = message.target.lastIndexOf('\0');
      if (split < 0) continue;
      const targetDirectory = message.target.slice(0, split);
      const id = message.target.slice(split + 1);
      if (!coordinationProject(targetDirectory)) continue;
      coordinationAttempts.set(message.id, Date.now());
      queueCoordinationDelivery({ id, directory: targetDirectory, title: '', agent: '' }, message);
    }
  }

  async function performCoordination(request: CoordinationRequest): Promise<unknown> {
    const project = coordinationProject(request.directory);
    if (!project) throw new Error('This worktree is not in the Sail project catalog.');
    const source = await coordinationSource(request);
    const sourceId =
      source.kind === 'acp'
        ? `acp:${source.agent}:${request.sessionId}`
        : `opencode:${request.sessionId}`;
    if (
      request.name === 'terminal_create' ||
      request.name === 'terminal_write' ||
      request.name === 'terminal_stop'
    ) {
      if (source.kind !== 'acp')
        throw new Error('Terminal control requires a session-bound agent connection.');
      if (!agentTerminalsEnabled)
        throw new Error('Agent terminal execution is disabled in settings.');
      const owner = `${request.directory}\0${sourceId}`;
      if (request.name === 'terminal_create') {
        const registered = await invoke<RegisteredWorktree[]>('registered_worktrees', {
          repository: project,
          paths: [project, ...(projectCatalog.worktrees[project] ?? []).map((item) => item.path)],
        });
        if (
          request.directory !== project &&
          !registered.some((item) => item.path === request.directory)
        )
          throw new Error('The source worktree is not registered in this project.');
        const command = request.arguments.command;
        if (typeof command !== 'string' || !command.trim())
          throw new Error('A terminal command is required.');
        if (new TextEncoder().encode(command).length > 16_384)
          throw new Error('Terminal command exceeds 16384 bytes.');
        const layout = paneLayouts[request.directory] ?? mainPane();
        const target = leaves(layout)[0];
        const split = splitPane(layout, target.id, 'row');
        const prior = new Set(leaves(layout).map((pane) => pane.id));
        const created = leaves(split).find((pane) => !prior.has(pane.id));
        if (!created) throw new Error('Could not create a terminal pane.');
        paneLayouts = { ...paneLayouts, [request.directory]: split };
        persistPaneLayouts();
        let terminalId: string | null = null;
        try {
          terminalId = await invoke<string>('terminal_owned_create', {
            paneId: created.id,
            directory: request.directory,
            command,
            owner,
          });
          const current = paneLayouts[request.directory] ?? mainPane();
          const reserved = leaves(current).find((pane) => pane.id === created.id);
          if (!reserved || reserved.kind)
            throw new Error('The terminal pane changed before creation finished.');
          paneLayouts = {
            ...paneLayouts,
            [request.directory]: updatePane(current, created.id, {
              kind: 'terminal',
              owner: `${source.agent}: ${source.title}`,
            }),
          };
          persistPaneLayouts();
          if (directory !== request.directory) await loadProject(request.directory);
          focusPaneForTyping(created.id);
        } catch (cause) {
          if (terminalId) await invoke('terminal_close', { id: created.id });
          const current = paneLayouts[request.directory];
          if (current && leaves(current).some((pane) => pane.id === created.id)) {
            paneLayouts = { ...paneLayouts, [request.directory]: closePane(current, created.id) };
            persistPaneLayouts();
          }
          throw cause;
        }
        return { terminalId, paneId: created.id, worktree: request.directory };
      }
      const terminalId = request.arguments.terminalId;
      if (typeof terminalId !== 'string' || !terminalId.startsWith('shell:'))
        throw new Error('Choose an owned shell terminal ID.');
      if (request.name === 'terminal_write') {
        const data = request.arguments.data;
        if (typeof data !== 'string' || !data || new TextEncoder().encode(data).length > 16_384)
          throw new Error('Terminal input must be 1–16384 bytes.');
        await invoke('terminal_owned_write', { terminalId, owner, data });
        return { terminalId, writtenBytes: new TextEncoder().encode(data).length };
      }
      await invoke('terminal_owned_stop', { terminalId, owner });
      return { terminalId, stopping: true };
    }
    if (request.name === 'worktree_list' || request.name === 'worktree_info') {
      if (!agentWorktreesEnabled) throw new Error('Agent worktree access is disabled in settings.');
      const registered = await invoke<RegisteredWorktree[]>('registered_worktrees', {
        repository: project,
        paths: [project, ...(projectCatalog.worktrees[project] ?? []).map((item) => item.path)],
      });
      const worktrees = projectWorktreeInfo(
        projectCatalog,
        project,
        registered,
        [...agentThreads, ...nativeThreads],
        threadAttention,
      );
      if (request.name === 'worktree_list') return { repository: project, worktrees };
      const path = request.arguments.path;
      if (typeof path !== 'string') throw new Error('Worktree path is required.');
      const worktree = worktrees.find((item) => item.path === path);
      if (!worktree) throw new Error('Worktree is not in this project.');
      return worktree;
    }
    if (
      request.name === 'terminal_list' ||
      request.name === 'terminal_read' ||
      request.name === 'terminal_wait'
    ) {
      if (!agentWorktreesEnabled) throw new Error('Agent worktree access is disabled in settings.');
      const registered = await invoke<RegisteredWorktree[]>('registered_worktrees', {
        repository: project,
        paths: [project, ...(projectCatalog.worktrees[project] ?? []).map((item) => item.path)],
      });
      const allowed = [...new Set([project, ...registered.map((item) => item.path)])];
      if (request.name === 'terminal_list') {
        const [shells, agents] = await Promise.all([
          invoke<Record<string, unknown>[]>('terminal_inspect_list', { allowed }),
          invoke<Record<string, unknown>[]>('acp_terminal_inspect_list', { allowed }),
        ]);
        return {
          terminals: [...shells, ...agents].toSorted((a, b) =>
            String(a.terminalId).localeCompare(String(b.terminalId)),
          ),
        };
      }
      const id = request.arguments.terminalId;
      const cursor = request.arguments.cursor ?? 0;
      const maxBytes = request.arguments.maxBytes ?? 16_384;
      const timeoutMs = request.arguments.timeoutMs ?? 30_000;
      if (typeof id !== 'string' || (!id.startsWith('shell:') && !id.startsWith('agent:')))
        throw new Error('Choose a terminal ID from terminal_list.');
      if (!Number.isSafeInteger(cursor) || Number(cursor) < 0)
        throw new Error('Terminal cursor must be a non-negative integer.');
      if (!Number.isSafeInteger(maxBytes) || Number(maxBytes) < 1 || Number(maxBytes) > 65_536)
        throw new Error('Terminal page size must be 1–65536 bytes.');
      if (
        request.name === 'terminal_wait' &&
        (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 0 || Number(timeoutMs) > 30_000)
      )
        throw new Error('Wait timeout must be 0–30000 milliseconds.');
      const command = `${id.startsWith('shell:') ? 'terminal' : 'acp_terminal'}_inspect_${request.name === 'terminal_wait' ? 'wait' : 'read'}`;
      return invoke(command, { id, allowed, cursor, maxBytes, timeoutMs });
    }
    if (request.name === 'worktree_status') {
      if (!agentStatusEnabled) throw new Error('Agent status updates are disabled in settings.');
      const comment = request.arguments.comment;
      if (typeof comment !== 'string' || comment.length > 140)
        throw new Error('Status comment must be at most 140 characters.');
      if (
        !(projectCatalog.worktrees[project] ?? []).some((item) => item.path === request.directory)
      )
        throw new Error('Only a project worktree can have a status comment.');
      saveProjectCatalog(setWorktreeStatus(projectCatalog, project, request.directory, comment));
      return { comment: comment.trim() };
    }
    if (request.name === 'project_threads' || request.name === 'thread_message') {
      if (request.name === 'project_threads' && !agentThreadListEnabled)
        throw new Error('Agent thread listing is disabled in settings.');
      if (request.name === 'thread_message' && !agentMessagesEnabled)
        throw new Error('Agent messages are disabled in settings.');
      const threads = (await projectCoordinationThreads(project)).filter(
        (thread) => thread.id !== sourceId || thread.directory !== request.directory,
      );
      if (request.name === 'project_threads') return { threads };
      const targetId = request.arguments.threadId;
      const text = request.arguments.text;
      if (typeof targetId !== 'string' || typeof text !== 'string' || !text.trim())
        throw new Error('Choose a project thread and enter a message.');
      if (text.length > 2000) throw new Error('Agent message must be at most 2000 characters.');
      const target = threads.find((thread) => thread.id === targetId);
      if (!target) throw new Error('Target thread is not in this project.');
      const message: CoordinationMessage = {
        id: crypto.randomUUID(),
        target: coordinationKey(target.directory, target.id),
        sender: `${source.agent} · ${source.title}`,
        text: text.trim(),
        created: Date.now(),
      };
      coordinationMessages = enqueueCoordinationMessage(coordinationMessages, message);
      setSetting('sai-coordination-messages', JSON.stringify(coordinationMessages));
      setTimeout(retryCoordinationDeliveries, 200);
      return { queuedFor: target.id, queued: true, messageId: message.id };
    }
    if (
      request.name === 'agent_status' ||
      request.name === 'agent_wait' ||
      request.name === 'agent_result'
    ) {
      if (!agentWorktreesEnabled) throw new Error('Agent worktree access is disabled in settings.');
      const id = request.arguments.receiptId;
      const accessKey = request.arguments.accessKey;
      if (typeof id !== 'string' || typeof accessKey !== 'string')
        throw new Error('Launch receipt ID and access key are required.');
      const receipt = receiptForSource(
        spawnReceipts,
        id,
        accessKey,
        project,
        sourceId,
        request.directory,
      );
      if (!receipt) throw new Error('Launch receipt is unavailable to this source thread.');
      const requestedTimeout = request.arguments.timeoutMs;
      if (
        request.name === 'agent_wait' &&
        requestedTimeout !== undefined &&
        (!Number.isInteger(requestedTimeout) ||
          Number(requestedTimeout) < 0 ||
          Number(requestedTimeout) > 30_000)
      )
        throw new Error('Wait timeout must be 0–30000 milliseconds.');
      const deadline =
        Date.now() + (request.name === 'agent_wait' ? Number(requestedTimeout ?? 30_000) : 0);
      async function boundedReceipt(current: SpawnReceipt): Promise<SpawnReceipt> {
        if (request.name !== 'agent_wait') return currentSpawnReceipt(current);
        const remaining = deadline - Date.now();
        if (remaining <= 0) return current;
        let timer: ReturnType<typeof setTimeout>;
        try {
          return await Promise.race([
            currentSpawnReceipt(current),
            new Promise<SpawnReceipt>((resolve) => {
              timer = setTimeout(() => resolve(current), remaining);
            }),
          ]);
        } finally {
          clearTimeout(timer!);
        }
      }
      async function awaitReceipt(current: SpawnReceipt): Promise<SpawnReceipt> {
        if (
          request.name !== 'agent_wait' ||
          receiptIsSettled(current.state) ||
          current.state === 'waiting' ||
          Date.now() >= deadline ||
          disposed
        )
          return current;
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
        return awaitReceipt(await boundedReceipt(current));
      }
      const current = await awaitReceipt(await boundedReceipt(receipt));
      const status = {
        receiptId: current.receiptId,
        requestId: current.requestId,
        project: current.project,
        sourceId: current.sourceId,
        sourceDirectory: current.sourceDirectory,
        targetId: current.targetId,
        turnId: current.turnId,
        targetDirectory: current.targetDirectory,
        worktreeId: current.worktreeId,
        provider: current.provider,
        model: current.model,
        validation: current.validation,
        state: current.state,
        created: current.created,
        updated: current.updated,
        error: current.error,
      };
      if (request.name === 'agent_result')
        return { ...status, result: current.state === 'completed' ? current.result : null };
      return {
        ...status,
        ...(request.name === 'agent_wait'
          ? { timedOut: !receiptIsSettled(current.state) && current.state !== 'waiting' }
          : {}),
      };
    }
    if (request.name === 'task_checkpoint_read' || request.name === 'task_checkpoint_update') {
      const owner = shipCheckpointOwner(shipRuns, request.directory, sourceId);
      if (!owner) throw new Error('This thread cannot access a Ship task checkpoint.');
      await refreshShippingIssue(owner.run, owner.issue, true);
      const checkpoint =
        owner.issue.checkpoint ??
        initialTaskCheckpoint(
          { id: owner.issue.id, url: owner.issue.url, title: owner.issue.title },
          owner.run.approvedAt,
        );
      const currentRevision = await invoke<string>('working_tree_revision', {
        path: request.directory,
      });
      if (request.name === 'task_checkpoint_update') {
        const patch = request.arguments.checkpoint;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch))
          throw new Error('Checkpoint update requires a checkpoint object.');
        const liveCheckpoint = owner.issue.checkpoint ?? checkpoint;
        const updated = prepareTaskCheckpointUpdate(
          liveCheckpoint,
          patch,
          currentRevision,
          request.arguments.expectedSequence,
          request.arguments.expectedRevision,
          request.arguments.rebindRevision,
          Date.now(),
        );
        await updateShipIssue(owner.run, owner.issue, { checkpoint: updated });
      } else if (!owner.issue.checkpoint) {
        await updateShipIssue(owner.run, owner.issue, { checkpoint });
      }
      const saved = owner.issue.checkpoint ?? checkpoint;
      return {
        checkpoint: saved,
        reconciliation: reconcileTaskCheckpoint(saved, currentRevision, {
          issueState: owner.issue.issueState,
          pullRequest: owner.issue.pullRequest,
          deliveryState: owner.issue.state,
          refreshError: owner.issue.refreshError,
        }),
      };
    }
    if (request.name === 'ship_progress') return reportShipProgress(request, sourceId);
    if (request.name === 'validation_gate') {
      const owner = shipOwner(shipRuns, request.directory, sourceId);
      try {
        if (owner)
          await updateShipIssue(owner.run, owner.issue, {
            stage: request.arguments.gate === 'test-adversary' ? 'testing' : 'reviewing',
            events: appendShipEvent(owner.issue.events, String(request.arguments.gate)),
          });
        const result = await spawnValidationGate(request, project, sourceId);
        if (owner) await updateShipIssue(owner.run, owner.issue, { blockedReason: null });
        return result;
      } catch (cause) {
        if (owner)
          await updateShipIssue(owner.run, owner.issue, {
            blockedReason: describe(cause),
            events: appendShipEvent(
              owner.issue.events,
              String(request.arguments.gate),
              describe(cause),
            ),
          });
        throw cause;
      }
    }
    if (request.name === 'agent_spawn')
      return spawnCoordinatedAgent(request, project, source, sourceId);
    if (!agentWorktreesEnabled) throw new Error('Agent worktree creation is disabled in settings.');
    const name = request.arguments.name;
    const prompt = request.arguments.prompt;
    if (typeof name !== 'string' || typeof prompt !== 'string' || !prompt.trim())
      throw new Error('A worktree name and starting prompt are required.');
    if (prompt.length > 8000) throw new Error('Starting prompt must be at most 8000 characters.');
    const approval = browserApprovalQueue.then(() =>
      confirmWorktreeApproval(request.expiresAt, {
        agent: source.agent,
        title: source.title,
        name,
        project,
        prompt,
      }),
    );
    browserApprovalQueue = approval.catch(() => undefined);
    if (!(await approval)) throw new Error('User declined the worktree request.');
    if (Date.now() >= request.expiresAt)
      throw new Error('The worktree request expired before approval.');
    const created = await invoke<{ path: string; branch: string; base: string; setup: string }>(
      'create_worktree',
      { repository: request.directory, name, destinationParent: null, baseRef: null },
    );
    saveProjectCatalog(addWorktree(projectCatalog, project, created));
    if (created.setup) {
      await loadProject(created.path);
      if (directory !== created.path) throw new Error('Worktree changed before setup started.');
      const paneId = splitFocusedPane('row', 'terminal', created.setup);
      if (!paneId) throw new Error('Enlarge a pane before running worktree setup.');
      coordinationSetupWaiters.set(paneId, (code) => {
        if (code !== 0) {
          saveProjectCatalog(
            setWorktreeSetupStatus(projectCatalog, project, created.path, 'failed'),
          );
          error = `Worktree setup exited with code ${code}. The agent thread was not started.`;
          return;
        }
        saveProjectCatalog(setWorktreeSetupStatus(projectCatalog, project, created.path, 'ready'));
        void startCoordinatedThread(created, source, prompt.trim()).catch((cause) => {
          error = `Could not start coordinated thread: ${describe(cause)}`;
        });
      });
      return {
        path: created.path,
        branch: created.branch,
        status: 'setup-running',
        terminalPaneId: paneId,
      };
    }
    return startCoordinatedThread(created, source, prompt.trim());
  }

  async function reportShipProgress(request: CoordinationRequest, sourceId: string) {
    const report = parseShipReport(request.arguments);
    if ('verdict' in report) {
      const receipt = spawnReceipts.find(
        (item) =>
          item.validation &&
          item.targetId === sourceId &&
          item.targetDirectory === request.directory,
      );
      if (!receipt?.validation) {
        if (crossValidation.choices.length || crossValidation.strictDifferentModel)
          throw new Error(
            'Inline gate verdicts are disabled while cross-validation is configured.',
          );
        if (!('gate' in report))
          throw new Error('The implementation session must identify the completed inline gate.');
        const owner = shipOwner(shipRuns, request.directory, sourceId);
        if (!owner)
          throw new Error('Only the assigned Ship worker can report inline gate verdicts.');
        validateGateVerdict(report.gate, report.verdict);
        const now = Date.now();
        const model = resolvedWorkerModel(owner.issue) ?? null;
        await updateShipIssue(owner.run, owner.issue, {
          stage: report.gate === 'test-adversary' ? 'testing' : 'reviewing',
          blockedReason: ['BLOCKED', 'FAIL', 'NEEDS_FIXES'].includes(report.verdict)
            ? report.reason
            : null,
          gates: [
            ...(owner.issue.gates ?? []),
            {
              id: `inline:${sourceId}:${report.gate}:${crypto.randomUUID()}`,
              gate: report.gate,
              requestedModel: model ?? 'implementation session',
              provider: owner.run.provider,
              model,
              threadId: sourceId,
              directory: request.directory,
              state: 'completed',
              created: now,
              updated: now,
              error: null,
              verdict: report.verdict,
              reason: report.reason,
            },
          ],
          events: appendShipEvent(
            owner.issue.events,
            `${report.gate}: ${report.verdict}`,
            report.reason,
          ),
        });
        return { status: 'recorded' };
      }
      if (shippingWorkerSettled(receipt.state))
        throw new Error('This validation attempt has already finished.');
      validateGateVerdict(receipt.validation.gate, report.verdict);
      updateSpawnReceipt(receipt.receiptId, {
        validation: { ...receipt.validation, verdict: report.verdict, reason: report.reason },
      });
      await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
      const owner = shipOwner(shipRuns, receipt.sourceDirectory, receipt.sourceId);
      if (owner)
        await updateShipIssue(owner.run, owner.issue, {
          blockedReason: ['BLOCKED', 'FAIL', 'NEEDS_FIXES'].includes(report.verdict)
            ? report.reason
            : null,
          events: appendShipEvent(
            owner.issue.events,
            `${receipt.validation.gate}: ${report.verdict}`,
            report.reason,
          ),
        });
    } else {
      const owner = shipOwner(shipRuns, request.directory, sourceId);
      if (!owner) throw new Error('Only the assigned Ship worker can report issue progress.');
      await updateShipIssue(owner.run, owner.issue, {
        stage: report.stage,
        blockedReason: report.status === 'blocked' ? report.reason : null,
        events: appendShipEvent(owner.issue.events, report.stage, report.reason),
      });
    }
    return { status: 'recorded' };
  }

  async function spawnValidationGate(
    request: CoordinationRequest,
    project: string,
    sourceId: string,
  ) {
    if (!agentWorktreesEnabled) throw new Error('Agent coordination is disabled in settings.');
    const { gate, prompt, implementingModels } = request.arguments;
    if (!['code-adversary', 'findings-adversary', 'test-adversary'].includes(String(gate)))
      throw new Error('Choose a Ship It validation gate.');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000)
      throw new Error('Gate prompt must be 1–8000 characters.');
    const gatePrompt = `${prompt.trim()}\n\nBefore finishing, call ship_progress with your structured verdict and reason. For review passes use CLEAN, NEEDS_FIXES, or BLOCKED; for manual testing use PASS, FAIL, or BLOCKED. Report only your own pass. A failed or blocked verdict requires a concrete reason.`;
    if (
      !Array.isArray(implementingModels) ||
      !implementingModels.every((model) => typeof model === 'string' && !!model.trim())
    )
      throw new Error('List every implementation model.');
    await recoverImplementationModels(request.directory);
    const activeModels = await activeImplementationModels(request.directory, sourceId);
    if (!activeModels)
      throw new Error('The active implementation model is unknown. Wait for the turn to finish.');
    const usedModels = [
      ...new Set([
        ...implementationModels(request.directory),
        ...activeModels,
        ...implementingModels,
      ]),
    ];
    if (implementationAttributionUncertain(request.directory))
      throw new Error('Concurrent agent turns prevent reliable implementation model attribution.');
    const registered = await invoke<RegisteredWorktree[]>('registered_worktrees', {
      repository: project,
      paths: [request.directory],
    });
    const worktree = registered.find((item) => item.path === request.directory);
    if (!worktree) throw new Error('Source worktree is no longer registered with Git.');
    const branch = worktree.branch ?? '';
    const agents = await acp.agents();
    const models =
      client && runtimeState === 'connected'
        ? (await inspectRepository(client, request.directory)).models
        : [];
    const available = crossValidation.choices.filter((choice) =>
      choice.agent === 'opencode'
        ? models.some((model) => `${model.providerID}:${model.id}` === choice.model)
        : agents.some((agent) => agent.id === choice.agent && agent.available),
    );
    async function tryChoice(candidates: ValidationChoice[], reasons: string[]): Promise<unknown> {
      const currentCandidates = candidates.filter((candidate) =>
        crossValidation.choices.some(
          (selected) => selected.agent === candidate.agent && selected.model === candidate.model,
        ),
      );
      if (!currentCandidates.length) {
        const unavailable = selectValidationChoice(crossValidation, [], usedModels);
        throw new Error([unavailable.reason, ...reasons].filter(Boolean).join(' '));
      }
      const route = selectValidationChoice(crossValidation, currentCandidates, usedModels);
      if (!route.choice) throw new Error(route.reason ?? 'No eligible validation model.');
      const choice: ValidationChoice = route.choice;
      const gateSource: CoordinationSource =
        choice.agent === 'opencode'
          ? {
              kind: 'opencode',
              agent: 'OpenCode',
              model: {
                providerID: choice.model.slice(0, choice.model.indexOf(':')),
                id: choice.model.slice(choice.model.indexOf(':') + 1),
              },
              title: String(gate),
            }
          : { kind: 'acp', agent: choice.agent, model: choice.model, title: String(gate) };
      const receiptId = crypto.randomUUID();
      const accessKey = crypto.randomUUID();
      const ensureSelected = async () => {
        const selectedCandidates = currentCandidates.filter((candidate) =>
          crossValidation.choices.some(
            (selected) => selected.agent === candidate.agent && selected.model === candidate.model,
          ),
        );
        const active = await activeImplementationModels(request.directory, sourceId);
        if (!active || implementationAttributionUncertain(request.directory))
          throw new Error(
            'Concurrent agent turns prevent reliable implementation model attribution.',
          );
        const latestModels = [
          ...new Set([...implementationModels(request.directory), ...active, ...usedModels]),
        ];
        const current = selectValidationChoice(
          crossValidation,
          selectedCandidates,
          latestModels,
        ).choice;
        if (current?.agent !== choice.agent || current.model !== choice.model)
          throw new Error('Validation model selection changed before launch. Retry the gate.');
      };
      saveSpawnReceipt({
        receiptId,
        accessKey,
        requestId: request.id,
        project,
        sourceId,
        sourceDirectory: request.directory,
        targetId: null,
        turnId: null,
        targetDirectory: request.directory,
        worktreeId: request.directory,
        provider: choice.agent as SpawnReceipt['provider'],
        prompt: gatePrompt,
        validation: {
          gate: gate as import('./lib/ship-progress').GateName,
          requestedModel: choice.model,
        },
        state: 'starting',
        created: Date.now(),
        updated: Date.now(),
        result: null,
        error: null,
      });
      await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
      await saveShipRuns();
      try {
        if (choice.agent !== 'opencode') {
          try {
            await acp.connect(choice.agent);
          } catch (cause) {
            throw new ValidationCandidateUnavailable(
              `Provider ${choice.agent} is unavailable`,
              cause,
            );
          }
        }
        await ensureSelected();
        const started = await startCoordinatedThread(
          { path: request.directory, branch },
          gateSource,
          gatePrompt,
          receiptId,
          true,
          ensureSelected,
        );
        return {
          ...started,
          receiptId,
          accessKey,
          sourceId,
          targetId: started.threadId,
          provider: choice.agent,
          model: choice.model,
          gate,
          status: 'started',
        };
      } catch (cause) {
        updateSpawnReceipt(receiptId, { state: 'failed', error: describe(cause) });
        if (!(cause instanceof ValidationCandidateUnavailable)) throw cause;
        return tryChoice(
          candidates.filter((item) => item !== choice),
          [...reasons, `${choice.agent} / ${choice.model}: ${describe(cause)}`],
        );
      }
    }
    return tryChoice(available, []);
  }

  async function spawnCoordinatedAgent(
    request: CoordinationRequest,
    project: string,
    source: CoordinationSource,
    sourceId: string,
  ) {
    if (!agentWorktreesEnabled) throw new Error('Agent worktree access is disabled in settings.');
    const provider = request.arguments.provider;
    const prompt = request.arguments.prompt;
    const target = request.arguments.target;
    const suppliedReceiptId = request.arguments.receiptId;
    const suppliedAccessKey = request.arguments.accessKey;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      (suppliedReceiptId !== undefined || suppliedAccessKey !== undefined) &&
      (typeof suppliedReceiptId !== 'string' ||
        !uuid.test(suppliedReceiptId) ||
        typeof suppliedAccessKey !== 'string' ||
        !uuid.test(suppliedAccessKey))
    )
      throw new Error('Provide both receiptId and accessKey as UUIDs.');
    const receiptId = (suppliedReceiptId as string | undefined) ?? request.id;
    const receiptAccessKey = (suppliedAccessKey as string | undefined) ?? crypto.randomUUID();
    if (typeof provider !== 'string' || !['claude', 'codex', 'opencode'].includes(provider))
      throw new Error('Choose Claude, Codex, or OpenCode as the provider.');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000)
      throw new Error('Starting prompt must be 1–8000 characters.');
    if (target !== undefined && (typeof target !== 'object' || target === null))
      throw new Error('Target must describe a new or existing worktree.');
    const selectedTarget = target as { kind?: unknown; name?: unknown; path?: unknown } | undefined;
    const existing = selectedTarget?.kind === 'existing';
    if (selectedTarget && !existing && selectedTarget.kind !== 'new')
      throw new Error('Target kind must be new or existing.');
    const name = existing
      ? ''
      : selectedTarget
        ? selectedTarget.name
        : `agent-${crypto.randomUUID().slice(0, 8)}`;
    if (!existing && (typeof name !== 'string' || !name.trim()))
      throw new Error('New worktree name is required.');
    if (!existing && typeof name === 'string' && name.length > 64)
      throw new Error('Worktree name must be at most 64 characters.');
    const path = existing ? selectedTarget?.path : null;
    if (existing && typeof path !== 'string')
      throw new Error('Existing worktree path is required.');

    const chosenProvider: SpawnReceipt['provider'] =
      provider === 'claude' ? 'claude' : provider === 'codex' ? 'codex' : 'opencode';
    if (chosenProvider === 'opencode') {
      if (!client || runtimeState !== 'connected') throw new Error('OpenCode is unavailable.');
    } else {
      const available = (await acp.agents()).find((agent) => agent.id === chosenProvider);
      if (!available?.available)
        throw new Error(available?.reason ?? `${chosenProvider} is unavailable.`);
    }

    let destination: { path: string; branch: string } | null = null;
    if (existing) {
      const selectedPath = path as string;
      if (
        selectedPath !== project &&
        !(projectCatalog.worktrees[project] ?? []).some(
          (worktree) => worktree.path === selectedPath,
        )
      )
        throw new Error('Target worktree is not in this project.');
      const catalogWorktree = (projectCatalog.worktrees[project] ?? []).find(
        (worktree) => worktree.path === selectedPath,
      );
      if (catalogWorktree?.setupStatus === 'pending' || catalogWorktree?.setupStatus === 'failed')
        throw new Error('Complete worktree setup before spawning another agent there.');
      const registered = await invoke<RegisteredWorktree[]>('registered_worktrees', {
        repository: project,
        paths: [selectedPath],
      });
      const live = registered.find((worktree) => worktree.path === selectedPath);
      if (!live) throw new Error('Target worktree is no longer registered with Git.');
      destination = { path: selectedPath, branch: live.branch ?? '' };
      if (chosenProvider === 'opencode') {
        const report = await inspectRepository(client!, selectedPath);
        if (!report.workReady)
          throw new Error('Complete OpenCode setup in the target worktree before spawning.');
      }
    }

    if (spawnReceipts.some((item) => item.receiptId === receiptId))
      throw new Error('Launch receipt ID is already in use.');
    saveSpawnReceipt({
      receiptId,
      accessKey: receiptAccessKey,
      requestId: request.id,
      project,
      sourceId,
      sourceDirectory: request.directory,
      targetId: null,
      turnId: null,
      targetDirectory: destination?.path ?? null,
      worktreeId: destination?.path ?? null,
      provider: chosenProvider,
      prompt: prompt.trim(),
      state: 'queued',
      created: Date.now(),
      updated: Date.now(),
      result: null,
      error: null,
    });
    activeSpawnRequests.add(receiptId);

    if (Date.now() >= request.expiresAt)
      throw new Error('The agent spawn request expired before launch.');
    // Return before the backend's five-minute coordination timeout.
    const responseDeadline = request.expiresAt + 180_000;
    const previousSpawn = agentSpawnQueue;
    const launched = (async () => {
      const queueRemaining = responseDeadline - Date.now();
      if (queueRemaining <= 0) throw new Error('Agent spawn timed out while waiting to launch.');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Agent spawn timed out while waiting to launch.')),
          queueRemaining,
        );
        void previousSpawn
          .catch(() => undefined)
          .then(() => {
            clearTimeout(timer);
            resolve();
            return undefined;
          });
      });
      if (Date.now() >= responseDeadline)
        throw new Error('Agent spawn timed out while waiting to launch.');
      await coordinationSource(request);
      updateSpawnReceipt(receiptId, { state: 'starting' });

      if (destination) {
        const targetPath = destination.path;
        const registered = await invoke<RegisteredWorktree[]>('registered_worktrees', {
          repository: project,
          paths: [targetPath],
        });
        if (!registered.some((worktree) => worktree.path === targetPath))
          throw new Error('Target worktree is no longer registered with Git.');
      }

      if (chosenProvider !== 'opencode') await acp.connect(chosenProvider);
      if (!destination) {
        const created = await invoke<{ path: string; branch: string; setup: string }>(
          'create_worktree',
          { repository: project, name, destinationParent: null, baseRef: null },
        );
        saveProjectCatalog(addWorktree(projectCatalog, project, created));
        destination = created;
        updateSpawnReceipt(receiptId, {
          worktreeId: created.path,
          targetDirectory: created.path,
        });
        if (created.setup) {
          let setupTimedOut = false;
          try {
            await loadProject(created.path);
            if (directory !== created.path)
              throw new Error('Worktree changed before setup started.');
            const paneId = splitFocusedPane('row', 'terminal', created.setup);
            if (!paneId) throw new Error('Enlarge a pane before running worktree setup.');
            await new Promise<void>((resolve, reject) => {
              const remaining = Math.min(200_000, responseDeadline - Date.now());
              let expired = false;
              const timer = setTimeout(
                () => {
                  expired = true;
                  setupTimedOut = true;
                  reject(new Error('Agent spawn timed out before worktree setup completed.'));
                },
                Math.max(0, remaining),
              );
              coordinationSetupWaiters.set(paneId, (code) => {
                clearTimeout(timer);
                if (expired) {
                  saveProjectCatalog(
                    setWorktreeSetupStatus(
                      projectCatalog,
                      project,
                      created.path,
                      code === 0 ? 'ready' : 'failed',
                    ),
                  );
                  return;
                }
                if (code === 0) resolve();
                else
                  reject(new Error(`Worktree setup exited with code ${code}. Agent not started.`));
              });
            });
            saveProjectCatalog(
              setWorktreeSetupStatus(projectCatalog, project, created.path, 'ready'),
            );
          } catch (cause) {
            if (!setupTimedOut)
              saveProjectCatalog(
                setWorktreeSetupStatus(projectCatalog, project, created.path, 'failed'),
              );
            throw cause;
          }
        }
      }

      if (chosenProvider === 'opencode') {
        const report = await inspectRepository(client!, destination.path);
        if (!report.workReady)
          throw new Error('Complete OpenCode setup in the target worktree before spawning.');
      }
      await coordinationSource(request);
      const selectedSource: CoordinationSource =
        chosenProvider === 'opencode'
          ? { kind: 'opencode', agent: 'OpenCode', title: source.title }
          : { kind: 'acp', agent: chosenProvider, title: source.title };
      if (Date.now() >= responseDeadline)
        throw new Error('Agent spawn timed out before the agent could start.');
      const requireResponseTime = async () => {
        if (Date.now() + 30_000 >= responseDeadline)
          throw new Error('Agent spawn timed out before the agent could start.');
      };
      const started = await startCoordinatedThread(
        destination,
        selectedSource,
        prompt.trim(),
        receiptId,
        false,
        requireResponseTime,
      );
      activeSpawnRequests.delete(receiptId);
      return {
        ...started,
        worktreeId: destination.path,
        receiptId,
        accessKey: receiptAccessKey,
        sourceId,
        targetId: started.threadId,
        status: 'started',
      };
    })();
    agentSpawnQueue = launched.catch(() => undefined);
    return launched;
  }

  async function startCoordinatedThread(
    created: { path: string; branch: string },
    source: CoordinationSource,
    prompt: string,
    receiptId?: string,
    validation = false,
    beforePrompt?: () => Promise<void>,
  ) {
    if (validation) {
      const model = source.kind === 'acp' ? source.model : source.model?.id;
      if (!model || hasUnresolvedModelAlias(model))
        throw new ValidationCandidateUnavailable(
          'Cannot verify the actual validation model behind an alias. Select a concrete model ID.',
        );
    }
    if (!validation)
      await beginShipItRun(created.path, prompt, promptSkill(skills, prompt)?.name ?? null);
    if (source.kind === 'acp') {
      const session = await acp.create(source.agent, created.path).catch((cause) => {
        if (!validation) throw cause;
        throw new ValidationCandidateUnavailable(`${source.agent} is unavailable`, cause);
      });
      const reportedModel = session.configOptions?.find(
        (option) => option.type === 'select' && /model/i.test(`${option.id} ${option.name}`),
      )?.currentValue;
      if (source.model) {
        const modelOption = session.configOptions?.find(
          (option) => option.type === 'select' && /model/i.test(`${option.id} ${option.name}`),
        );
        if (!modelOption?.options.some((option) => option.value === source.model)) {
          const message = `Model ${source.model} is unavailable in ${source.agent}.`;
          throw validation ? new ValidationCandidateUnavailable(message) : new Error(message);
        }
        const changed = await acp
          .setConfig(source.agent, session.sessionId, modelOption.id, source.model)
          .catch((cause) => {
            if (!validation) throw cause;
            throw new ValidationCandidateUnavailable(
              `${source.agent} / ${source.model} is unavailable`,
              cause,
            );
          });
        const actual = changed.configOptions?.find((option) => option.id === modelOption.id);
        if (actual?.currentValue !== source.model) {
          const message = `Cannot verify ${source.agent} selected model ${source.model}.`;
          throw validation ? new ValidationCandidateUnavailable(message) : new Error(message);
        }
      }
      const thread: AgentThread = {
        agent: source.agent,
        model: source.model ?? reportedModel,
        sessionId: session.sessionId,
        directory: created.path,
        title: prompt.slice(0, 60),
        updated: Date.now(),
      };
      saveAgentThread(thread);
      if (receiptId)
        updateSpawnReceipt(receiptId, {
          targetId: `acp:${source.agent}:${session.sessionId}`,
          model: source.model ?? reportedModel,
          targetDirectory: created.path,
          worktreeId: created.path,
        });
      if (receiptId)
        await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
      if (receiptId) await saveShipRuns();
      await invoke('record_turn_snapshot', {
        path: created.path,
        thread: `acp:${source.agent}:${session.sessionId}`,
      });
      const tracking = validation
        ? null
        : await beginImplementationTurn(
            created.path,
            source.model ?? reportedModel,
            `acp:${source.agent}:${session.sessionId}`,
          );
      await beforePrompt?.();
      updateAgentThreadStatus(thread, 'working');
      const turnId = crypto.randomUUID();
      if (receiptId) updateSpawnReceipt(receiptId, { state: 'working', turnId });
      if (receiptId)
        await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
      if (receiptId) activeSpawnTargets.set(`acp:${source.agent}:${session.sessionId}`, receiptId);
      const turn = acp.prompt(source.agent, session.sessionId, prompt, turnId);
      const finished = turn.then(
        async (outcome) => {
          if (tracking)
            await recordImplementationModel(created.path, source.model ?? reportedModel, tracking);
          updateAgentThreadStatus(thread, 'done');
          if (receiptId) {
            const current = spawnReceipts.find((item) => item.receiptId === receiptId);
            updateSpawnReceipt(receiptId, {
              state:
                outcome.stopReason === 'cancelled' || current?.state === 'interrupted'
                  ? 'interrupted'
                  : 'completed',
              result: spawnOutput.get(receiptId) ?? current?.result ?? null,
            });
            spawnOutput.delete(receiptId);
            if (activeSpawnTargets.get(`acp:${source.agent}:${session.sessionId}`) === receiptId)
              activeSpawnTargets.delete(`acp:${source.agent}:${session.sessionId}`);
          }
          return undefined;
        },
        async (cause) => {
          if (tracking)
            await recordImplementationModel(created.path, source.model ?? reportedModel, tracking);
          updateAgentThreadStatus(thread, 'failed');
          if (receiptId) {
            updateSpawnReceipt(receiptId, { state: 'failed', error: describe(cause) });
            spawnOutput.delete(receiptId);
            if (activeSpawnTargets.get(`acp:${source.agent}:${session.sessionId}`) === receiptId)
              activeSpawnTargets.delete(`acp:${source.agent}:${session.sessionId}`);
          }
          error = describe(cause);
          throw cause;
        },
      );
      await awaitCoordinationStart(finished, async () => {
        const state = (await acp.activity())[source.agent];
        return !!state?.active.includes(session.sessionId);
      });
      void finished.catch(() => undefined);
      return {
        path: created.path,
        branch: created.branch,
        threadId: `acp:${source.agent}:${session.sessionId}`,
      };
    }
    if (!client) {
      const message = 'OpenCode is unavailable for the new thread.';
      throw validation ? new ValidationCandidateUnavailable(message) : new Error(message);
    }
    const promptClient = client;
    await ensureOpenCodeBrowser(created.path).catch((cause) => {
      if (!validation) throw cause;
      throw new ValidationCandidateUnavailable('OpenCode is unavailable', cause);
    });
    const session = await promptClient.session
      .create({
        location: { directory: created.path },
        metadata: { saiHarness: true },
        title: prompt.slice(0, 60),
        agent: source.agent === 'OpenCode' ? undefined : source.agent,
        model: source.model,
      })
      .catch((cause) => {
        if (!validation) throw cause;
        throw new ValidationCandidateUnavailable(
          `OpenCode / ${source.model?.providerID}:${source.model?.id} is unavailable`,
          cause,
        );
      });
    if (
      source.model &&
      (session.model?.providerID !== source.model.providerID ||
        session.model.id !== source.model.id)
    ) {
      const message = `Cannot verify OpenCode selected model ${source.model.providerID}:${source.model.id}.`;
      throw validation ? new ValidationCandidateUnavailable(message) : new Error(message);
    }
    if (receiptId)
      updateSpawnReceipt(receiptId, {
        targetId: `opencode:${session.id}`,
        model: session.model ? `${session.model.providerID}:${session.model.id}` : undefined,
        targetDirectory: created.path,
        worktreeId: created.path,
      });
    if (receiptId)
      await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
    if (receiptId) await saveShipRuns();
    rememberRecentThread({
      agent: 'opencode',
      sessionId: session.id,
      directory: created.path,
      title: prompt.slice(0, 60),
      updated: Date.now(),
    });
    await invoke('record_turn_snapshot', {
      path: created.path,
      thread: `opencode:${session.id}`,
    });
    const tracking = validation
      ? null
      : await beginImplementationTurn(
          created.path,
          session.model ? `${session.model.providerID}:${session.model.id}` : undefined,
          `opencode:${session.id}`,
        );
    const turnId = receiptId ? crypto.randomUUID() : undefined;
    if (receiptId) {
      updateSpawnReceipt(receiptId, { turnId: turnId! });
      await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
    }
    await beforePrompt?.();
    const startingPrompt = promptClient.session.prompt({
      sessionID: session.id,
      text: prompt,
      id: turnId,
    });
    if (receiptId)
      void startingPrompt
        .then(async (inbox) => {
          updateSpawnReceipt(receiptId, { turnId: inbox.id });
          try {
            await promptClient.session.wait({ sessionID: session.id });
            if (tracking)
              await recordImplementationModel(
                created.path,
                session.model ? `${session.model.providerID}:${session.model.id}` : undefined,
                tracking,
              );
            const outcome = await promptClient.session.get({ sessionID: session.id });
            const receipt = spawnReceipts.find((item) => item.receiptId === receiptId);
            if (receipt) await settleOpenCodeReceipt(receipt, promptClient, outcome.outcome);
          } catch (cause) {
            if (tracking) abandonImplementationTurn(created.path, tracking);
            updateSpawnReceipt(receiptId, { state: 'unavailable', error: describe(cause) });
          }
          return undefined;
        })
        .catch((cause) => {
          if (tracking) abandonImplementationTurn(created.path, tracking);
          updateSpawnReceipt(receiptId, { state: 'failed', error: describe(cause) });
        });
    else if (tracking)
      void startingPrompt
        .then(() => promptClient.session.wait({ sessionID: session.id }))
        .then(() =>
          recordImplementationModel(
            created.path,
            session.model ? `${session.model.providerID}:${session.model.id}` : undefined,
            tracking,
          ),
        )
        .catch((cause) => {
          abandonImplementationTurn(created.path, tracking);
          error = `Could not track implementation model: ${describe(cause)}`;
        });
    await awaitCoordinationStart(startingPrompt, async () => {
      if (!client) return false;
      const active = await client.session.active();
      return active[session.id]?.type === 'running';
    });
    void startingPrompt.catch((cause) => {
      error = `Could not start agent thread: ${describe(cause)}`;
    });
    return { path: created.path, branch: created.branch, threadId: `opencode:${session.id}` };
  }

  async function awaitCoordinationStart(
    turn: Promise<unknown>,
    isActive: () => Promise<boolean>,
  ): Promise<void> {
    let stopped = false;
    const deadline = Date.now() + 30_000;
    async function poll(): Promise<void> {
      if (stopped || disposed) return;
      if (await isActive().catch(() => false)) return;
      if (Date.now() >= deadline) throw new Error('Agent prompt did not start within 30 seconds.');
      await new Promise((resolve) => setTimeout(resolve, 100));
      return poll();
    }
    try {
      await Promise.race([turn, poll()]);
    } finally {
      stopped = true;
    }
  }

  function finishWorktreeApproval(allowed: boolean) {
    if (worktreeApprovalTimer) clearTimeout(worktreeApprovalTimer);
    worktreeApprovalTimer = undefined;
    const resolve = resolveWorktreeApproval;
    resolveWorktreeApproval = null;
    worktreeApproval = null;
    if (worktreeApprovalDialog?.open) worktreeApprovalDialog.close();
    resolve?.(allowed);
  }

  function confirmWorktreeApproval(
    expiresAt: number,
    details: NonNullable<typeof worktreeApproval>,
  ): Promise<boolean> {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0 || disposed) return Promise.resolve(false);
    return new Promise((resolve) => {
      resolveWorktreeApproval = resolve;
      worktreeApproval = details;
      worktreeApprovalTimer = setTimeout(() => finishWorktreeApproval(false), remaining);
      worktreeApprovalDialog.showModal();
    });
  }

  async function handleCoordinationRequest(request: CoordinationRequest) {
    let result: { value?: unknown; error?: string };
    try {
      result = { value: await performCoordination(request) };
    } catch (cause) {
      if (request.name === 'agent_spawn') {
        const id =
          typeof request.arguments.receiptId === 'string'
            ? request.arguments.receiptId
            : request.id;
        const receipt = spawnReceipts.find((item) => item.receiptId === id);
        if (receipt?.requestId === request.id) {
          if (!receiptIsSettled(receipt.state))
            updateSpawnReceipt(id, { state: 'failed', error: describe(cause) });
          activeSpawnRequests.delete(id);
        }
      }
      result = { error: describe(cause) };
    }
    try {
      await invoke('agent_coordination_reply', { id: request.id, result });
    } catch (cause) {
      error = describe(cause);
    }
  }

  function inboxTime(key: string, observed = Date.now()) {
    if (inboxSeen[key] === undefined || observed < inboxSeen[key]) {
      inboxSeen[key] = observed;
      if (Object.keys(inboxSeen).length > maxInboxSeen) {
        const oldest = Object.entries(inboxSeen)
          .filter(([entry]) => entry !== key)
          .toSorted((left, right) => left[1] - right[1])[0];
        delete inboxSeen[oldest[0]];
      }
      setSetting('sai-inbox-seen', JSON.stringify(inboxSeen));
    }
    return inboxSeen[key];
  }

  function forgetInboxTime(key: string) {
    if (inboxSeen[key] === undefined) return;
    delete inboxSeen[key];
    setSetting('sai-inbox-seen', JSON.stringify(inboxSeen));
  }

  function scheduleInboxRefresh() {
    ++inboxGeneration;
    clearTimeout(inboxRefreshTimer);
    inboxRefreshTimer = setTimeout(() => void refreshInbox(), 150);
  }

  function saveInboxOutcome(outcome: InboxOutcome) {
    const next = recordInboxOutcome(inboxOutcomes, outcome);
    if (next === inboxOutcomes) return;
    inboxOutcomes = next;
    setSetting('sai-inbox-outcomes', JSON.stringify(next));
    scheduleInboxRefresh();
  }

  function recordTurnOutcome(thread: AgentThread, eventId: string, receivedAt = Date.now()) {
    saveInboxOutcome({
      key: `turn:${threadKey(thread)}:${eventId}`,
      kind: 'turn-completed',
      directory: thread.directory,
      agentId: thread.agent,
      sessionId: thread.sessionId,
      text: `${thread.title} · completed`,
      receivedAt,
      eventId,
      read: false,
    });
  }

  async function refreshInbox() {
    if (disposed) return;
    const generation = ++inboxGeneration;
    inboxLoading = true;
    const locations = inboxLocations(projectCatalog);
    const byDirectory = new Map(locations.map((location) => [location.directory, location]));
    const source = client;
    const [acpResult, checksResult, ...openCodeResults] = await Promise.allSettled([
      acp.pendingInbox(),
      invoke<InboxCheck[]>('list_post_turn_checks').catch(() => []),
      ...(source
        ? locations.map(async (location) => {
            const [permissions, forms] = await Promise.all([
              source.permission.request.list({ location: { directory: location.directory } }),
              source.form.list({ location: { directory: location.directory } }),
            ]);
            const ids = [
              ...new Set([...permissions.data, ...forms.data].map((item) => item.sessionID)),
            ];
            const agents = new Map(
              await Promise.all(
                ids.map(async (id) => {
                  const agent = await source.session
                    .get({ sessionID: id })
                    .then((session) => session.agent)
                    .catch(() => null);
                  return [id, agent] as const;
                }),
              ),
            );
            return { location, permissions: permissions.data, forms: forms.data, agents };
          })
        : []),
    ]);
    if (generation !== inboxGeneration || disposed) return;
    const items: InboxItem[] = [];
    if (acpResult.status === 'fulfilled') {
      for (const pending of acpResult.value) {
        const sessionId = pending.message.params?.sessionId;
        const requestId = pending.message.id;
        if (typeof sessionId !== 'string' || requestId == null) continue;
        const thread = [...agentThreads, ...nativeChildThreads].find(
          (item) => item.agent === pending.agent && item.sessionId === sessionId,
        );
        if (!thread) continue;
        const location = byDirectory.get(thread.directory);
        if (!location) continue;
        const nativeChild = nativeSubagents[nativeSubagentId(pending.agent, sessionId)];
        const tool = pending.message.params?.toolCall;
        const title =
          tool && typeof tool === 'object' && 'title' in tool && typeof tool.title === 'string'
            ? tool.title
            : 'Allow agent action?';
        const options = Array.isArray(pending.message.params?.options)
          ? pending.message.params.options.filter(
              (option): option is NonNullable<InboxItem['options']>[number] =>
                typeof option === 'object' &&
                option !== null &&
                typeof option.optionId === 'string' &&
                typeof option.name === 'string' &&
                typeof option.kind === 'string',
            )
          : [];
        const key = `acp:${pending.agent}:${requestId}`;
        items.push({
          ...location,
          key,
          kind: 'acp-permission',
          agent: `${agentAvailability.find((item) => item.id === pending.agent)?.name ?? pending.agent}${nativeChild ? ` · ${nativeChild.name}` : ''}`,
          agentId: pending.agent,
          sessionId,
          requestId,
          text: title,
          receivedAt: pending.receivedAt,
          options,
        });
      }
    }
    for (const result of openCodeResults) {
      if (result.status !== 'fulfilled') continue;
      const { location, permissions, forms, agents } = result.value;
      for (const request of permissions) {
        const key = `opencode:permission:${request.id}`;
        items.push({
          ...location,
          key,
          kind: 'opencode-permission',
          agent: agents.get(request.sessionID) ?? 'OpenCode',
          sessionId: request.sessionID,
          requestId: request.id,
          text:
            request.message?.trim() ||
            `Allow ${request.action} on ${request.resources.join(', ')}?`,
          receivedAt: openCodeRequestTime(request.id) ?? inboxTime(key),
        });
      }
      for (const form of forms) {
        const key = `opencode:form:${form.id}`;
        items.push({
          ...location,
          key,
          kind: 'question',
          agent: agents.get(form.sessionID) ?? 'OpenCode',
          sessionId: form.sessionID,
          requestId: form.id,
          text: [form.title, ...form.fields.map((field) => field.title ?? field.key)].join(' · '),
          receivedAt: openCodeRequestTime(form.id) ?? inboxTime(key),
        });
      }
    }
    const failedChecks =
      checksResult.status === 'fulfilled'
        ? checksResult.value
            .map(failedCheckOutcome)
            .filter((outcome): outcome is InboxOutcome => outcome !== null)
        : [];
    for (const outcome of [
      ...inboxOutcomes.filter((item) => item.kind !== 'check-failed'),
      ...failedChecks,
    ]) {
      const location = byDirectory.get(outcome.directory);
      if (!location) continue;
      const saved = inboxOutcomes.find((item) => item.key === outcome.key);
      items.push({
        ...location,
        ...outcome,
        read: saved?.receivedAt === outcome.receivedAt ? saved.read : false,
        agent:
          agentAvailability.find((agent) => agent.id === outcome.agentId)?.name ?? outcome.agentId,
      });
    }
    inboxItems = sortInbox(items);
    inboxError =
      !source ||
      acpResult.status === 'rejected' ||
      openCodeResults.some((result) => result.status === 'rejected')
        ? 'Some projects could not be checked.'
        : '';
    inboxLoading = false;
  }

  function addProjectGroup(name: string) {
    if (projectCatalog.groups.some((group) => group.name.toLowerCase() === name.toLowerCase())) {
      error = `Project group “${name}” already exists.`;
      return;
    }
    saveProjectCatalog({
      ...projectCatalog,
      groups: [
        ...projectCatalog.groups,
        { id: crypto.randomUUID(), name, collapsed: false, repositories: [] },
      ],
    });
  }

  function renameProjectGroup(id: string, name: string) {
    if (
      projectCatalog.groups.some(
        (group) => group.id !== id && group.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      error = `Project group “${name}” already exists.`;
      return;
    }
    saveProjectCatalog({
      ...projectCatalog,
      groups: projectCatalog.groups.map((group) => (group.id === id ? { ...group, name } : group)),
    });
  }

  function deleteProjectGroup(id: string) {
    saveProjectCatalog({
      ...projectCatalog,
      groups: projectCatalog.groups.filter((group) => group.id !== id),
    });
  }

  function toggleProjectGroup(id: string) {
    saveProjectCatalog({
      ...projectCatalog,
      groups: projectCatalog.groups.map((group) =>
        group.id === id ? { ...group, collapsed: !group.collapsed } : group,
      ),
    });
  }

  function toggleProjectRepository(path: string) {
    const collapsed = projectCatalog.collapsedRepositories ?? [];
    saveProjectCatalog({
      ...projectCatalog,
      collapsedRepositories: collapsed.includes(path)
        ? collapsed.filter((repository) => repository !== path)
        : [...collapsed, path],
    });
  }

  function moveProjectRepository(path: string, groupID: string | null) {
    saveProjectCatalog(assignRepository(projectCatalog, path, groupID));
  }

  function removeProjectRepository(path: string) {
    if (
      path !== directory &&
      !(projectCatalog.worktrees[path] ?? []).some((worktree) => worktree.path === directory)
    )
      saveProjectCatalog(removeRepository(projectCatalog, path));
  }

  function createProjectWorktree(
    path: string,
    name: string,
    destinationParent: string | null,
    baseRef: string | null,
    agent: string | null,
    issue: GitHubIssue | null,
  ): Promise<string> {
    const id = crypto.randomUUID();
    const request = {
      repository: path,
      name,
      destinationParent,
      baseRef,
      agent,
      issue,
      initialDirectory: directory,
      initialSelection: selection,
    };
    worktreeCreationRequests.set(id, request);
    worktreeCreations = [...worktreeCreations, { id, repository: path, name, stage: 'Preparing' }];
    saveProjectCatalog({
      ...projectCatalog,
      collapsedRepositories: projectCatalog.collapsedRepositories?.filter(
        (repository) => repository !== path,
      ),
    });
    return runWorktreeCreation(id, request);
  }

  function retryWorktreeCreation(id: string) {
    const request = worktreeCreationRequests.get(id);
    if (!request || !worktreeCreations.some((creation) => creation.id === id && creation.error))
      return;
    worktreeCreations = worktreeCreations.map((creation) =>
      creation.id === id ? { ...creation, stage: 'Preparing', error: undefined } : creation,
    );
    const retry = { ...request, initialDirectory: directory, initialSelection: selection };
    worktreeCreationRequests.set(id, retry);
    void runWorktreeCreation(id, retry).catch(() => undefined);
  }

  function dismissWorktreeCreation(id: string) {
    if (!worktreeCreations.some((creation) => creation.id === id && creation.error)) return;
    worktreeCreations = worktreeCreations.filter((creation) => creation.id !== id);
    worktreeCreationRequests.delete(id);
  }

  async function runWorktreeCreation(
    id: string,
    request: WorktreeCreationRequest,
  ): Promise<string> {
    const { repository: path, name, destinationParent, baseRef, agent, issue } = request;
    let issuePrompt: string | null;
    let created: CreatedWorktree;
    try {
      const currentIssue = issue
        ? await invoke<GitHubIssue>('open_issue', { repository: path, number: issue.number })
        : null;
      issuePrompt = currentIssue
        ? `/ship-it ${currentIssue.url}\n\nSail already created this issue worktree and branch. Stay here; skip branch creation and cleanup. Run each adversarial review pass and manual test in a fresh subagent session. If a gate session cannot launch, pause and report the reason in this thread.`
        : null;
      worktreeCreations = worktreeCreations.map((creation) =>
        creation.id === id ? { ...creation, stage: 'Creating worktree' } : creation,
      );
      created = await invoke('create_worktree', {
        repository: path,
        name,
        destinationParent,
        baseRef,
      });
    } catch (cause) {
      worktreeCreations = worktreeCreations.map((creation) =>
        creation.id === id ? { ...creation, stage: 'Failed', error: describe(cause) } : creation,
      );
      throw cause;
    }
    worktreeCreations = worktreeCreations.filter((creation) => creation.id !== id);
    worktreeCreationRequests.delete(id);
    if (created.setup || agent) {
      const start = { repository: path, created, agent, issuePrompt };
      pendingWorktreeStarts.set(created.path, start);
      setSetting(`sai-pending-worktree-start:${created.path}`, JSON.stringify(start));
    }
    saveProjectCatalog({
      ...addWorktree(projectCatalog, path, created),
      collapsedRepositories: projectCatalog.collapsedRepositories?.filter(
        (repository) => repository !== path,
      ),
    });
    if (directory === request.initialDirectory && selection === request.initialSelection) {
      try {
        await loadProject(created.path);
      } catch (cause) {
        error = describe(cause);
      }
    }
    return created.path;
  }

  function finishCreatedWorktree(start: PendingWorktreeStart) {
    const { repository: path, created, agent, issuePrompt } = start;
    if (directory !== created.path) return;
    const startAgent = () => {
      if (directory !== created.path) return;
      if (agent === 'opencode') {
        if (workReady) {
          newWork();
          if (issuePrompt) draft = issuePrompt;
        } else pendingOpenCodeStart = { path: created.path, text: issuePrompt };
      } else if (agent) {
        if (issuePrompt)
          issuePrefills = {
            ...issuePrefills,
            [created.path]: { id: crypto.randomUUID(), text: issuePrompt },
          };
        focusMainPane();
        openAgent(agent);
        focusPaneForTyping('main');
      }
    };
    if (created.setup) {
      runningWorktreeSetups.add(created.path);
      const paneId = splitFocusedPane('row', 'terminal', created.setup);
      if (!paneId) {
        runningWorktreeSetups.delete(created.path);
        removeSetting(`sai-pending-worktree-start:${created.path}`);
        saveProjectCatalog(setWorktreeSetupStatus(projectCatalog, path, created.path, 'failed'));
        error = 'Could not open a terminal for worktree setup.';
        return;
      }
      terminalExitWaiters.set(paneId, (code) => {
        runningWorktreeSetups.delete(created.path);
        removeSetting(`sai-pending-worktree-start:${created.path}`);
        saveProjectCatalog(
          setWorktreeSetupStatus(
            projectCatalog,
            path,
            created.path,
            code === 0 ? 'ready' : 'failed',
          ),
        );
        if (code === 0) startAgent();
        else if (code >= 0) error = `Worktree setup exited with code ${code}.`;
      });
      return;
    }
    startAgent();
    removeSetting(`sai-pending-worktree-start:${created.path}`);
  }

  $effect(() => {
    const pending = pendingOpenCodeStart;
    if (!pending || directory !== pending.path || !workReady || switching || sending) return;
    pendingOpenCodeStart = null;
    newWork();
    if (pending.text) draft = pending.text;
    error = '';
    focusPaneForTyping('main');
  });

  const deletingWorktreeRequests = new SvelteSet<string>();

  async function deleteProjectWorktree(
    repository: string,
    path: string,
    branch: string,
    force = false,
  ) {
    if (deletingWorktreeRequests.has(path)) return;
    deletingWorktreeRequests.add(path);
    try {
      await deleteProjectWorktreeOnce(repository, path, branch, force);
    } finally {
      deletingWorktreeRequests.delete(path);
    }
  }

  async function removeMissingWorktreeFromGui(repository: string, path: string): Promise<void> {
    if (directory === path) await loadProject(repository);
    saveProjectCatalog(removeWorktree(projectCatalog, repository, path));
    const removedThreads = agentThreads.filter((thread) => thread.directory === path);
    const removedNative = sidebarOpenCodeThreads.filter((thread) => thread.directory === path);
    agentThreads = agentThreads.filter((thread) => thread.directory !== path);
    nativeThreads = nativeThreads.filter((thread) => thread.directory !== path);
    sidebarOpenCodeThreads = sidebarOpenCodeThreads.filter((thread) => thread.directory !== path);
    saveAgentThreads(agentThreads);
    setSetting('sai-recent-native-threads', JSON.stringify(nativeThreads));
    forgetMissingRecentThreads();
    for (const thread of [...removedThreads, ...removedNative]) {
      forgetThreadAttention(thread);
      if (thread.agent !== 'opencode') forgetRecentTranscript(thread);
    }
    delete paneLayouts[path];
    persistPaneLayouts();
    removeSetting(`sai-session:${path}`);
    pendingWorktreeStarts.delete(path);
    runningWorktreeSetups.delete(path);
    removeSetting(`sai-pending-worktree-start:${path}`);
    removeSetting(`sai-main-pane-empty:${path}`);
    error = '';
  }

  async function deleteProjectWorktreeOnce(
    repository: string,
    path: string,
    branch: string,
    force: boolean,
  ) {
    let retryForce = false;
    let config: WorktreeConfig | null;
    try {
      config = await invoke<WorktreeConfig | null>('worktree_config', { worktree: path });
    } catch (cause) {
      if (missingRepositoryPath(cause)) {
        await removeMissingWorktreeFromGui(repository, path);
        return;
      }
      error = describe(cause);
      return;
    }
    const e2eAnswer =
      import.meta.env.MODE === 'e2e' ? sessionStorage.getItem('sai-e2e-delete-worktree') : null;
    if (e2eAnswer) sessionStorage.removeItem('sai-e2e-delete-worktree');
    const confirmed =
      e2eAnswer === 'Yes'
        ? true
        : e2eAnswer === 'No'
          ? false
          : await confirmInApp(
              force ? 'Force delete worktree' : 'Delete worktree',
              force || config
                ? `Delete worktree “${branch}” at ${path}? This permanently removes uncommitted and ignored files, including copied files. The branch will remain.`
                : `Delete worktree “${branch}” at ${path}? Uncommitted and ignored files block deletion. The branch will remain.`,
              force ? 'Force delete' : 'Delete worktree',
            );
    if (!confirmed) return;
    const wasSelected = directory === path;
    worktreeDeletions = {
      ...worktreeDeletions,
      [path]: config?.archive ? 'Archiving' : 'Preparing deletion',
    };
    try {
      if (config?.archive) {
        if (!wasSelected) await loadProject(path);
        const paneId = splitFocusedPane('row', 'terminal', config.archive);
        if (!paneId) return;
        const code = await new Promise<number>((resolve) =>
          terminalExitWaiters.set(paneId, resolve),
        );
        if (code < 0) return;
        if (code !== 0) {
          const deleteAnyway = await confirmInApp(
            'Archive failed',
            `Archive script exited with code ${code}. Delete “${branch}” anyway?`,
            'Delete anyway',
          );
          if (!deleteAnyway) return;
        }
      }
      if (directory === path) await loadProject(repository);
      worktreeDeletions = { ...worktreeDeletions, [path]: 'Closing terminals' };
      await Promise.all(
        leaves(paneLayouts[path] ?? mainPane())
          .filter((pane) => pane.kind === 'terminal')
          .map((pane) => invoke('terminal_close', { id: terminalRuntimeId(path, pane.id) })),
      );
      worktreeDeletions = { ...worktreeDeletions, [path]: 'Deleting files' };
      await invoke('delete_worktree', { repository, worktree: path, force: force || !!config });
      saveProjectCatalog(removeWorktree(projectCatalog, repository, path));
      const removedThreads = agentThreads.filter((thread) => thread.directory === path);
      const removedNative = sidebarOpenCodeThreads.filter((thread) => thread.directory === path);
      agentThreads = agentThreads.filter((thread) => thread.directory !== path);
      nativeThreads = nativeThreads.filter((thread) => thread.directory !== path);
      sidebarOpenCodeThreads = sidebarOpenCodeThreads.filter((thread) => thread.directory !== path);
      saveAgentThreads(agentThreads);
      setSetting('sai-recent-native-threads', JSON.stringify(nativeThreads));
      forgetMissingRecentThreads();
      for (const thread of [...removedThreads, ...removedNative]) {
        forgetThreadAttention(thread);
        if (thread.agent !== 'opencode') forgetRecentTranscript(thread);
      }
      delete paneLayouts[path];
      persistPaneLayouts();
      removeSetting(`sai-session:${path}`);
      pendingWorktreeStarts.delete(path);
      runningWorktreeSetups.delete(path);
      removeSetting(`sai-pending-worktree-start:${path}`);
      removeSetting(`sai-main-pane-empty:${path}`);
      error = '';
    } catch (cause) {
      if (wasSelected && directory === repository) await loadProject(path);
      const deletionError = describe(cause);
      if (
        !force &&
        deletionError === 'Worktree has ignored files. Move or remove them before deleting.'
      ) {
        error = '';
        retryForce = true;
      } else error = deletionError;
    } finally {
      const remaining = { ...worktreeDeletions };
      delete remaining[path];
      worktreeDeletions = remaining;
    }
    if (retryForce) await deleteProjectWorktreeOnce(repository, path, branch, true);
  }

  let closingWorktree: string | null = null;

  function closeCurrentWorktree() {
    if (closingWorktree) return;
    const target = worktreeAt(projectCatalog, directory);
    if (!target) {
      error = projectCatalog.repositories.includes(directory)
        ? 'The main checkout cannot be deleted. Select a worktree to close it.'
        : 'Select a worktree to close it.';
      return;
    }
    closingWorktree = target.worktree.path;
    void deleteProjectWorktree(
      target.repository,
      target.worktree.path,
      target.worktree.branch,
    ).finally(() => (closingWorktree = null));
  }

  async function createProjectPullRequest(
    repository: string,
    worktree: ProjectWorktree,
    base: string,
    title: string,
    body: string,
    isDraft: boolean,
  ) {
    const pullRequest = await invoke<{ number: number; url: string }>('create_pull_request', {
      repository,
      worktree: worktree.path,
      branch: worktree.branch,
      base,
      title,
      body,
      draft: isDraft,
    });
    saveProjectCatalog(
      setWorktreePullRequest(projectCatalog, repository, worktree.path, pullRequest),
    );
  }

  async function sendFailedCheckLog(
    repository: string,
    worktree: ProjectWorktree,
    check: PullRequestCheck,
  ) {
    const actionsJob = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+$/.test(
      check.url,
    );
    const log = actionsJob
      ? await invoke<string>('failed_check_log', {
          repository,
          worktree: worktree.path,
          branch: worktree.branch,
          url: check.url,
        })
      : 'This check has no GitHub Actions job log. Open the check link for details.';
    const text = `Please investigate failed check “${check.name}” for ${worktree.branch}.\n${check.url}\n\n${log}`;
    const target = await invoke<string>('validate_repository', { path: worktree.path });
    if (directory !== target) await loadProject(target);
    if (directory !== target) throw new Error('Worktree changed before sending the logs.');
    const pane = leaves(paneLayout).find((leaf) => leaf.agent && leaf.thread);
    if (pane?.agent) {
      await sendDiffComments(pane.id, diffCommentKey(pane.id), text);
      return;
    }
    const thread = agentThreads.find((item) => item.directory === target);
    if (thread) {
      focusMainPane();
      openAgent(thread.agent, thread);
      await tick();
      await sendDiffComments('main', diffCommentKey('main'), text);
      return;
    }
    if (acpAgent) {
      await sendDiffComments('main', diffCommentKey('main'), text);
      return;
    }
    if (client && sessionID) {
      await sendDiffComments('main', diffCommentKey('main'), text);
      return;
    }
    throw new Error('Open an agent thread in this worktree before sending check logs.');
  }

  async function chooseProject(groupID: string | null = null) {
    try {
      const path = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: directory || undefined,
        title: 'Choose a repository',
      });
      if (path) await selectProject(path, groupID);
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function selectProject(path: string, groupID: string | null) {
    showWorkspace();
    try {
      path = await invoke<string>('validate_repository', { path });
      if (
        !projectCatalog.repositories.includes(path) &&
        !Object.values(projectCatalog.worktrees).some((worktrees) =>
          worktrees.some((worktree) => worktree.path === path),
        )
      )
        saveProjectCatalog(assignRepository(projectCatalog, path, groupID));
      if (path !== directory) await loadProject(path);
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function loadProject(path: string, recordRestoredThread = true) {
    const expectedSelection = selection + 1;
    const hydration = hydrateProject(path, recordRestoredThread);
    if (directory !== path || selection !== expectedSelection) {
      await hydration;
      return;
    }
    if (runningWorktreeSetups.has(path)) {
      await hydration;
      return;
    }
    const stored = getSetting(`sai-pending-worktree-start:${path}`);
    let recovered: PendingWorktreeStart | null = null;
    if (stored) {
      try {
        const candidate = JSON.parse(stored) as PendingWorktreeStart;
        if (
          candidate.created?.path === path &&
          typeof candidate.repository === 'string' &&
          projectCatalog.worktrees[candidate.repository]?.some(
            (worktree) => worktree.path === path,
          ) &&
          typeof candidate.created.branch === 'string' &&
          typeof candidate.created.base === 'string' &&
          typeof candidate.created.setup === 'string' &&
          (candidate.agent === null || typeof candidate.agent === 'string') &&
          (candidate.issuePrompt === null || typeof candidate.issuePrompt === 'string')
        )
          recovered = candidate;
      } catch {
        recovered = null;
      }
    }
    const start = pendingWorktreeStarts.get(path) ?? recovered;
    if (!start) {
      await hydration;
      const repository = Object.keys(projectCatalog.worktrees).find((repo) =>
        projectCatalog.worktrees[repo].some((worktree) => worktree.path === path),
      );
      if (
        repository &&
        projectCatalog.worktrees[repository].some(
          (worktree) => worktree.path === path && worktree.setupStatus === 'pending',
        )
      )
        saveProjectCatalog(setWorktreeSetupStatus(projectCatalog, repository, path, 'failed'));
      if (stored) removeSetting(`sai-pending-worktree-start:${path}`);
      return;
    }
    pendingWorktreeStarts.delete(path);
    finishCreatedWorktree(start);
    await hydration;
  }

  async function hydrateProject(path: string, recordRestoredThread = true) {
    if (directory !== path) {
      sideChat = null;
      agentEntrySnapshots = {};
      for (const batch of Object.values(pendingAgentBatches))
        completeAgentBatch(batch.id, 'Project changed before comments were sent.');
      for (const resolve of terminalExitWaiters.values()) resolve(-1);
      terminalExitWaiters.clear();
    }
    ++projectLoadGeneration;
    saveViewState();
    cacheCurrentTimeline();
    error = '';
    const current = ++selection;
    directory = path;
    mainPickerDirectory = getSetting(`sai-main-pane-empty:${path}`) === 'true' ? path : null;
    browserAccessDisabled = getSetting(`sai-browser-disabled:${path}`) === 'true';
    focusedPane = leaves(paneLayouts[path] ?? mainPane())[0]?.id ?? 'main';
    setSetting('sai-directory', path);
    lastSetupProbe = 0;
    setupProbeCount = 0;
    const savedMain = leaves(paneLayouts[path] ?? mainPane()).find((leaf) => leaf.id === 'main');
    acpAgent = savedMain?.agent ?? null;
    acpThread = savedMain?.thread ?? null;
    const restoredThread = leaves(paneLayouts[path] ?? mainPane()).find(
      (leaf) => leaf.id === focusedPane,
    )?.thread;
    if (
      recordRestoredThread &&
      restoredThread &&
      agentThreads.some((thread) => threadKey(thread) === threadKey(restoredThread))
    ) {
      rememberRecentThread(restoredThread);
      if (document.hasFocus()) markThreadRead(restoredThread);
    }
    ++sessionRefresh;
    workReady = false;
    planReady = false;
    setup = null;
    selectedAgentID = '';
    selectedModelKey = '';
    selectedVariant = '';
    clearDraftAttachments();
    sessionID = null;
    mobileView = 'chat';
    newSessionMode = null;
    selectedSession = null;
    sessions = [];
    activeSessionIDs = [];
    resetTimeline();
    draft = '';
    running = false;
    pendingPermissions = [];
    pendingForms = [];
    snapshot = { plan: null, questions: null };
    diffs = [];
    selectedFilePath = null;
    diffError = '';
    ++diffRefresh;
    diffLoading = false;
    if (client) await ensureOpenCodeBrowser(path).catch((cause) => (error = describe(cause)));
    if (!client || !(await refreshSetup(path)) || current !== selection) return;
    draft = viewStates.get(viewKey())?.draft ?? '';
    if (acpAgent) return;
    if (!workReady && !planReady) return;
    try {
      await refreshSessions();
      if (current !== selection) return;
      if (
        getSetting(`sai-main-pane-empty:${directory}`) === 'true' ||
        leaves(paneLayout).some((pane) => pane.id === 'main' && !!pane.kind)
      )
        return;
      const saved = getSetting(`sai-session:${directory}`);
      if (saved && (await restoreSession(saved))) return;
      if (current !== selection) return;
      if (saved) removeSetting(`sai-session:${directory}`);
      if (sessions[0]) await selectSession(sessions[0].id, true);
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function selectDefaultWorktree(path: string) {
    showWorkspace();
    if (path !== directory) await loadProject(path);
    if (path !== directory) return;
    const panes = leaves(paneLayout);
    const main = panes[0];
    if (
      panes.length !== 1 ||
      main?.id !== 'main' ||
      main.agent ||
      main.thread ||
      main.kind ||
      acpAgent ||
      sessionID ||
      newSessionMode
    )
      return;
    mainPickerDirectory = path;
    setSetting(`sai-main-pane-empty:${path}`, 'true');
    focusPaneForTyping('main');
    await tick();
    setTimeout(() => {
      if (directory === path && mainPickerDirectory === path)
        document
          .querySelector<HTMLButtonElement>('[data-pane-id="main"] [data-pane-picker]')
          ?.focus();
    }, 0);
  }

  async function refreshSetup(path = directory) {
    if (!client || !path) return false;
    setupLoading = true;
    setupError = '';
    const current = selection;
    try {
      const report = await inspectRepository(client, path);
      if (current !== selection) return false;
      if (path !== report.repository) {
        if (paneLayouts[path]) {
          paneLayouts = {
            ...paneLayouts,
            [report.repository]: migratePaneDirectory(paneLayouts[path], path, report.repository),
          };
          delete paneLayouts[path];
          persistPaneLayouts();
        }
        saveProjectCatalog(replaceRepositoryPath(projectCatalog, path, report.repository));
        const knownThreads = [...agentThreads, ...nativeThreads, ...sidebarOpenCodeThreads];
        if (recentCycleKeys) {
          const selectedKey = recentCycleKeys[recentCycleIndex];
          const migratedSelected = selectedKey
            ? migrateRecentThreadKeys([selectedKey], knownThreads, path, report.repository)[0]
            : null;
          recentCycleKeys = migrateRecentThreadKeys(
            recentCycleKeys,
            knownThreads,
            path,
            report.repository,
          );
          recentCycleIndex = migratedSelected ? recentCycleKeys.indexOf(migratedSelected) : -1;
        }
        recentThreadKeys = migrateRecentThreadKeys(
          recentThreadKeys,
          knownThreads,
          path,
          report.repository,
        );
        setSetting('sai-recent-agent-threads', JSON.stringify(recentThreadKeys));
        hiddenSidebarThreadKeys = migrateRecentThreadKeys(
          hiddenSidebarThreadKeys,
          knownThreads,
          path,
          report.repository,
        );
        setSetting('sai-hidden-sidebar-threads', JSON.stringify(hiddenSidebarThreadKeys));
        const attentionKeys = new Map(
          knownThreads
            .filter((thread) => thread.directory === path)
            .map((thread) => [
              threadKey(thread),
              threadKey({ ...thread, directory: report.repository }),
            ]),
        );
        threadAttention = Object.fromEntries(
          Object.entries(threadAttention).map(([key, value]) => [
            attentionKeys.get(key) ?? key,
            value,
          ]),
        );
        saveThreadAttention();
        agentThreads = agentThreads.map((thread) =>
          thread.directory === path
            ? Object.assign({}, thread, { directory: report.repository })
            : thread,
        );
        saveAgentThreads(agentThreads);
        nativeThreads = nativeThreads.map((thread) =>
          thread.directory === path ? { ...thread, directory: report.repository } : thread,
        );
        sidebarOpenCodeThreads = sidebarOpenCodeThreads.map((thread) =>
          thread.directory === path ? { ...thread, directory: report.repository } : thread,
        );
        setSetting('sai-recent-native-threads', JSON.stringify(nativeThreads));
        if (acpThread?.directory === path)
          acpThread = Object.assign({}, acpThread, { directory: report.repository });
      }
      directory = report.repository;
      setSetting('sai-directory', report.repository);
      setup = report;
      workReady = report.workReady;
      planReady = report.planReady;
      if (!selectedAgentID || !report.agents.some((agent) => agent.id === selectedAgentID))
        selectedAgentID =
          report.agents.find((agent) => agent.id !== 'architect')?.id ?? report.agents[0]?.id ?? '';
      const selectedModel = report.models.find((model) => modelKey(model) === selectedModelKey);
      if (!selectedModel) {
        selectedModelKey = report.defaultModel ? modelKey(report.defaultModel) : '';
        selectedVariant = report.defaultModel?.variant ?? '';
      } else if (!selectedModel.variants.some((variant) => variant.id === selectedVariant)) {
        selectedVariant = '';
      }
      return true;
    } catch (cause) {
      if (current !== selection) return false;
      setupError = describe(cause);
      workReady = false;
      planReady = false;
      return false;
    } finally {
      if (current === selection) setupLoading = false;
    }
  }

  async function restartSetup() {
    if (connecting || !client) return false;
    connecting = true;
    setupLoading = true;
    setupError = '';
    clearTimeout(recoveryTimer);
    try {
      const active = await client.session.active();
      if (sending || Object.values(active).some((session) => session.type === 'running')) {
        setupError = 'Wait for active OpenCode sessions to finish before restarting.';
        return false;
      }
      const info = await invoke<RuntimeInfo>('start_runtime', {
        binaryPath: appliedBinaryPath || null,
        restart: true,
      });
      await activateRuntime(info);
      return true;
    } catch (cause) {
      setupError = describe(cause);
      return false;
    } finally {
      connecting = false;
      setupLoading = false;
    }
  }

  async function refreshSidebarOpenCodeThreads(source: OpenCodeClient, paths: string[]) {
    const generation = ++sidebarInventoryGeneration;
    const results = await Promise.allSettled(
      paths.map((path) => listSidebarOpenCodeThreads(source, path)),
    );
    if (generation !== sidebarInventoryGeneration || disposed || source !== client) return;
    const failed = new Set(paths.filter((_, index) => results[index]?.status === 'rejected'));
    const retained = sidebarOpenCodeThreads.filter((thread) => failed.has(thread.directory));
    sidebarOpenCodeThreads = [
      ...results.flatMap((result) => (result.status === 'fulfilled' ? result.value.threads : [])),
      ...retained,
    ];
    sidebarOpenCodeOutcomes = Object.assign(
      {},
      ...results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value.outcomes] : [],
      ),
      Object.fromEntries(
        retained.flatMap((thread) => {
          const key = threadKey(thread);
          const outcome = sidebarOpenCodeOutcomes[key];
          return outcome ? [[key, outcome]] : [];
        }),
      ),
    );
    updateAttentionBadge();
    void reconcileNativeActivity();
  }

  function scheduleSidebarInventoryRefresh() {
    clearTimeout(sidebarInventoryTimer);
    sidebarInventoryTimer = setTimeout(() => {
      if (client) void refreshSidebarOpenCodeThreads(client, JSON.parse(sidebarDirectoryKey));
    }, 250);
  }

  $effect(() => {
    const source = client;
    const paths: string[] = JSON.parse(sidebarDirectoryKey);
    if (source) void refreshSidebarOpenCodeThreads(source, paths);
  });

  async function refreshSessions() {
    if (!client || !directory) return;
    const source = client;
    const path = directory;
    const current = ++sessionRefresh;
    async function collect(
      pageCursor: string | undefined,
      matches: SessionInfo[],
      seen: Set<string>,
    ): Promise<SessionInfo[]> {
      const result = await source.session.list({
        directory: path,
        limit: 25,
        order: 'desc',
        parentID: null,
        ...(pageCursor ? { cursor: pageCursor } : {}),
      });
      matches.push(
        ...result.data.filter(
          (session) => session.location.directory === path && !session.parentID,
        ),
      );
      const following = result.cursor.next ?? null;
      if (
        matches.length >= 25 ||
        !following ||
        following === pageCursor ||
        seen.has(following) ||
        path !== directory ||
        current !== sessionRefresh
      ) {
        return matches;
      }
      seen.add(following);
      return collect(following, matches, seen);
    }
    const matches = await collect(undefined, [], new Set());
    if (path !== directory || current !== sessionRefresh) return;
    const active = await source.session.active();
    if (path !== directory || current !== sessionRefresh) return;
    sessions = matches;
    activeSessionIDs = Object.keys(active);
    running = !!sessionID && activeSessionIDs.includes(sessionID);
    const selected = sessions.find((session) => session.id === sessionID);
    if (selected) {
      selectedSession = selected;
      syncSessionChoice(selected);
    } else if (sessionID) {
      const requestedID = sessionID;
      try {
        const info = await client.session.get({ sessionID: requestedID });
        if (path === directory && current === sessionRefresh && requestedID === sessionID) {
          if (info.location.directory === path && !info.parentID) {
            selectedSession = info;
            syncSessionChoice(info);
          } else {
            clearSelectedSession();
            error = 'This session does not belong to the selected repository.';
          }
        }
      } catch (cause) {
        if (
          path === directory &&
          current === sessionRefresh &&
          requestedID === sessionID &&
          isSessionNotFoundError(cause)
        ) {
          clearSelectedSession();
        }
      }
    }
  }

  async function restoreSession(id: string) {
    if (!client) return false;
    const path = directory;
    const current = selection;
    try {
      const info = await client.session.get({ sessionID: id });
      if (
        current !== selection ||
        path !== directory ||
        info.location.directory !== path ||
        info.parentID
      )
        return false;
      selectedSession = info;
      syncSessionChoice(info);
      await selectSession(id, true);
      return true;
    } catch (cause) {
      if (isSessionNotFoundError(cause)) return false;
      throw cause;
    }
  }

  function clearSelectedSession() {
    saveViewState();
    cacheCurrentTimeline();
    sessionID = null;
    if (mobileView === 'details') mobileView = 'chat';
    selectedSession = null;
    resetTimeline();
    snapshot = { plan: null, questions: null };
    clearDraftAttachments();
    running = false;
    pendingPermissions = [];
    pendingForms = [];
    removeSetting(`sai-session:${directory}`);
  }

  function openAgent(agent: AgentId, thread: AgentThread | null = null, preserveCycle = false) {
    if (!directory) return;
    sideChat = null;
    if (!preserveCycle) {
      recentCycleKeys = null;
      ++recentJumpGeneration;
    }
    if (thread) {
      showSidebarThread(thread);
      rememberRecentThread(thread);
      markThreadRead(thread);
    }
    if (focusedPane !== 'main' && leaves(paneLayout).some((leaf) => leaf.id === focusedPane)) {
      invalidatePaneSelection(focusedPane);
      savePaneLayout(updatePane(paneLayout, focusedPane, { agent, thread, kind: undefined }));
      return;
    }
    saveViewState();
    acpAgent = agent;
    acpThread = thread;
    savePaneLayout(updatePane(paneLayout, 'main', { agent, thread, kind: undefined }));
    mobileView = 'chat';
  }

  function openCommandPalette() {
    if (paletteDialog.open || document.querySelector('dialog[open]')) return;
    ++recentJumpGeneration;
    palettePreviousFocus = document.activeElement as HTMLElement | null;
    restorePaletteFocus = true;
    paletteStep = { kind: 'projects' };
    paletteQuery = '';
    paletteIndex = 0;
    paletteError = '';
    paletteOpenCodeSessions = [];
    paletteDialog.showModal();
    void tick().then(() => paletteInput.focus());
  }

  function closeCommandPalette(restore = true) {
    clearTimeout(paletteSearchTimer);
    ++paletteSessionGeneration;
    restorePaletteFocus = restore;
    paletteDialog.close();
  }

  function commandPaletteClosed() {
    if (restorePaletteFocus) palettePreviousFocus?.focus();
    palettePreviousFocus = null;
  }

  function setPaletteStep(step: PaletteStep) {
    clearTimeout(paletteSearchTimer);
    ++paletteSessionGeneration;
    paletteStep = step;
    paletteQuery = '';
    paletteError = '';
    paletteOpenCodeSessions = [];
    paletteLoading = false;
    paletteIndex = 0;
    if (step.kind === 'sessions' && step.agent === 'opencode')
      void loadPaletteOpenCodeSessions(step.directory, '');
    void tick().then(() => {
      paletteIndex = Math.max(
        0,
        paletteEntries.findIndex((entry) => !entry.disabled),
      );
      paletteInput.focus();
      return undefined;
    });
  }

  function backCommandPalette() {
    const step = paletteStep;
    if (step.kind === 'sessions')
      setPaletteStep({ kind: 'agents', repository: step.repository, directory: step.directory });
    else if (step.kind === 'agents')
      setPaletteStep({ kind: 'worktrees', repository: step.repository });
    else if (step.kind === 'worktrees') setPaletteStep({ kind: 'projects' });
  }

  async function loadPaletteOpenCodeSessions(path: string, search: string) {
    const source = client;
    if (!source) {
      paletteLoading = false;
      paletteError = 'OpenCode is unavailable.';
      return;
    }
    const sessionSource = source.session;
    const generation = ++paletteSessionGeneration;
    paletteLoading = true;
    paletteError = '';
    try {
      async function collect(
        cursor: string | null,
        matches: PaletteOpenCodeSession[],
        seen: Set<string>,
      ): Promise<PaletteOpenCodeSession[]> {
        const result = await sessionSource.list({
          directory: path,
          limit: 50,
          order: 'desc',
          parentID: null,
          ...(search.trim() ? { search: search.trim() } : {}),
          ...(cursor ? { cursor } : {}),
        });
        if (generation !== paletteSessionGeneration) return matches;
        matches.push(
          ...result.data
            .filter((session) => session.location.directory === path && !session.parentID)
            .map((session) => ({
              id: session.id,
              title: session.title ?? 'Untitled session',
              directory: session.location.directory,
              parentID: session.parentID ?? null,
              updated: session.time.updated,
            })),
        );
        const next = result.cursor.next ?? null;
        if (matches.length >= 50 || !next || next === cursor || seen.has(next)) return matches;
        seen.add(next);
        return collect(next, matches, seen);
      }
      const matches = await collect(null, [], new Set());
      if (generation === paletteSessionGeneration) paletteOpenCodeSessions = matches.slice(0, 50);
    } catch (cause) {
      if (generation === paletteSessionGeneration) paletteError = describe(cause);
    } finally {
      if (generation === paletteSessionGeneration) paletteLoading = false;
    }
  }

  function updatePaletteQuery(value: string) {
    paletteQuery = value;
    paletteIndex = Math.max(
      0,
      paletteEntries.findIndex((entry) => !entry.disabled),
    );
    paletteError = '';
    clearTimeout(paletteSearchTimer);
    if (paletteStep.kind === 'sessions' && paletteStep.agent === 'opencode') {
      ++paletteSessionGeneration;
      paletteOpenCodeSessions = [];
      paletteLoading = true;
      const path = paletteStep.directory;
      paletteSearchTimer = setTimeout(() => void loadPaletteOpenCodeSessions(path, value), 180);
    }
    void tick().then(() => {
      paletteIndex = Math.max(
        0,
        paletteEntries.findIndex((entry) => !entry.disabled),
      );
      scrollToActivePaletteEntry();
      return undefined;
    });
  }

  function reopenCommandPalette(step: PaletteStep) {
    if (paletteDialog.open || document.querySelector('dialog[open]')) return;
    palettePreviousFocus = document.activeElement as HTMLElement | null;
    restorePaletteFocus = true;
    paletteDialog.showModal();
    setPaletteStep(step);
  }

  function saveCommands(commands: SavedCommand[]) {
    savedCommands = commands;
    setSetting('sai-saved-commands', JSON.stringify(commands));
  }

  function openCommandsDialog() {
    commandName = '';
    commandText = '';
    commandScope = 'global';
    editingCommand = null;
    commandsDialog.showModal();
  }

  function saveCommand() {
    const name = commandName.trim();
    const script = commandText.trim();
    const project =
      commandScope === 'project' ? selectedRepository(projectCatalog, directory) : null;
    if (!name || !script || (commandScope === 'project' && !project)) return;
    const entry: SavedCommand = {
      id: editingCommand ?? crypto.randomUUID(),
      name,
      command: script,
      project,
    };
    saveCommands(
      editingCommand
        ? savedCommands.map((item) => (item.id === editingCommand ? entry : item))
        : [...savedCommands, entry],
    );
    commandName = '';
    commandText = '';
    commandScope = 'global';
    editingCommand = null;
  }

  function runSavedCommand(command: SavedCommand) {
    if (!directory) {
      error = 'Select a project or worktree before running a command.';
      return;
    }
    closeCommandPalette(false);
    splitFocusedPane('row', 'terminal', command.command);
  }

  async function openAgentTerminal(id: string) {
    const terminal = agentTerminals.find((item) => item.terminalId === id);
    agentTerminalsDialog?.close();
    if (terminal && terminal.directory !== directory) await loadProject(terminal.directory, false);
    splitFocusedPane('row', 'agent-terminal', undefined, id);
  }

  async function choosePaletteEntry(entry: PaletteEntry | null) {
    if (!entry || entry.disabled || paletteBusy) return;
    const step = paletteStep;
    if (entry.kind === 'command' && entry.command) {
      runSavedCommand(entry.command);
      return;
    }
    if (step.kind === 'projects' && entry.kind === 'thread' && entry.thread) {
      paletteBusy = true;
      paletteError = '';
      const workspaceError = error;
      try {
        if (!(await jumpToRecentThread(threadKey(entry.thread))))
          throw new Error('This session is no longer available.');
        closeCommandPalette(false);
      } catch (cause) {
        error = workspaceError;
        paletteError = describe(cause);
      } finally {
        paletteBusy = false;
      }
      return;
    }
    if (step.kind === 'projects' && entry.kind === 'project' && entry.directory) {
      setPaletteStep({ kind: 'worktrees', repository: entry.directory });
      return;
    }
    if (entry.kind === 'worktree' && entry.directory) {
      paletteBusy = true;
      paletteError = '';
      try {
        const target = entry.directory;
        if (target !== directory) await loadProject(target);
        if (target !== directory) return;
        closeCommandPalette(false);
        const runningThread = agentThreads
          .filter(
            (thread) => thread.directory === target && runningAgentThreads[agentThreadKey(thread)],
          )
          .toSorted((a, b) => b.updated - a.updated)[0];
        const panes = leaves(paneLayout);
        const savedThreadPane = panes.find((pane) => pane.id !== 'main' && pane.thread);
        if (!acpThread && !sessionID && savedThreadPane) {
          focusPaneForTyping(savedThreadPane.id);
        } else if (!acpThread && !running && runningThread) {
          focusMainPane();
          openAgent(runningThread.agent, runningThread);
        } else if (!acpThread && !sessionID) {
          const emptyPane = panes.find(
            (pane) => pane.id !== 'main' && !pane.agent && !pane.thread && !pane.kind,
          );
          if (emptyPane) focusPaneForTyping(emptyPane.id);
          else if (
            panes.length === 1 &&
            panes[0]?.id === 'main' &&
            !panes[0].agent &&
            !panes[0].kind
          )
            await selectDefaultWorktree(target);
          else {
            await tick();
            splitFocusedPane('row');
          }
        }
        focusPaneForTyping(focusedPane);
      } catch (cause) {
        paletteError = describe(cause);
      } finally {
        paletteBusy = false;
      }
      return;
    }
    if (step.kind === 'worktrees' && entry.kind === 'new-worktree') {
      closeCommandPalette(false);
      paletteWorktreeRequest = {
        id: crypto.randomUUID(),
        path: step.repository,
        fromPalette: true,
      };
      return;
    }
    if (step.kind === 'agents' && entry.kind === 'agent' && entry.agent) {
      setPaletteStep({
        kind: 'sessions',
        repository: step.repository,
        directory: step.directory,
        agent: entry.agent,
      });
      return;
    }
    if (step.kind !== 'sessions') return;
    if (!['new-session', 'thread', 'opencode-session'].includes(entry.kind)) return;
    paletteBusy = true;
    paletteError = '';
    try {
      const target = step.directory;
      let expectedProjectLoad = projectLoadGeneration;
      if (target !== directory) {
        const pending = loadProject(target, false);
        expectedProjectLoad = projectLoadGeneration;
        await pending;
      }
      if (expectedProjectLoad !== projectLoadGeneration || !directory) return;
      if (step.agent === 'opencode' && entry.kind === 'new-session' && !workReady)
        throw new Error('Complete OpenCode setup in this worktree before starting a session.');
      const thread =
        entry.kind === 'thread' && entry.thread
          ? agentThreads.find(
              (item) =>
                item.directory === directory &&
                item.agent === entry.thread?.agent &&
                item.sessionId === entry.thread.sessionId,
            )
          : null;
      if (entry.kind === 'thread' && !thread)
        throw new Error('This session is no longer available.');
      closeCommandPalette(false);
      focusMainPane();
      if (step.agent === 'opencode') {
        if (entry.kind === 'new-session') newWork();
        else if (entry.kind === 'opencode-session' && entry.sessionId)
          await selectSession(entry.sessionId);
      } else if (entry.kind === 'new-session') openAgent(step.agent);
      else if (entry.kind === 'thread' && thread) openAgent(step.agent, thread);
      focusPaneForTyping('main');
    } catch (cause) {
      paletteError = describe(cause);
    } finally {
      paletteBusy = false;
    }
  }

  function keydownCommandPalette(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeCommandPalette();
    } else if (
      (event.key === 'Backspace' || event.key === 'ArrowLeft') &&
      !paletteQuery &&
      paletteStep.kind !== 'projects'
    ) {
      event.preventDefault();
      backCommandPalette();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!paletteEntries.length) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      for (let offset = 1; offset <= paletteEntries.length; offset++) {
        const index =
          (paletteIndex + direction * offset + paletteEntries.length * offset) %
          paletteEntries.length;
        if (!paletteEntries[index]?.disabled) {
          paletteIndex = index;
          break;
        }
      }
      scrollToActivePaletteEntry();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const selected = paletteEntries[paletteIndex];
      void choosePaletteEntry(
        selected && !selected.disabled
          ? selected
          : (paletteEntries.find((entry) => !entry.disabled) ?? null),
      );
    }
  }

  function scrollToActivePaletteEntry() {
    void tick().then(() =>
      paletteDialog
        .querySelector<HTMLElement>('.palette-entry.active')
        ?.scrollIntoView({ block: 'nearest' }),
    );
  }

  function saveAgentThread(thread: AgentThread) {
    agentThreads = [
      thread,
      ...agentThreads.filter(
        (item) =>
          item.agent !== thread.agent ||
          item.directory !== thread.directory ||
          item.sessionId !== thread.sessionId,
      ),
    ].toSorted((a, b) => b.updated - a.updated);
    saveAgentThreads(agentThreads);
    for (const [path, layout] of Object.entries(paneLayouts)) {
      let next = layout;
      for (const leaf of leaves(layout)) {
        if (
          leaf.thread?.sessionId === thread.sessionId &&
          leaf.thread.directory === thread.directory &&
          leaf.agent === thread.agent
        ) {
          next = updatePane(next, leaf.id, { thread });
        }
      }
      paneLayouts[path] = next;
    }
    persistPaneLayouts();
    if (
      acpAgent === thread.agent &&
      acpThread?.sessionId === thread.sessionId &&
      acpThread.directory === thread.directory
    )
      acpThread = thread;
  }

  function rememberRecentThread(thread: AgentThread) {
    if (thread.agent === 'opencode') {
      nativeThreads = [
        thread,
        ...nativeThreads.filter((item) => threadKey(item) !== threadKey(thread)),
      ].slice(0, 100);
      sidebarOpenCodeThreads = [
        thread,
        ...sidebarOpenCodeThreads.filter((item) => threadKey(item) !== threadKey(thread)),
      ];
      setSetting('sai-recent-native-threads', JSON.stringify(nativeThreads));
    }
    recentThreadKeys = touchRecentThread(recentThreadKeys, thread);
    setSetting('sai-recent-agent-threads', JSON.stringify(recentThreadKeys));
  }

  function forgetMissingRecentThreads() {
    recentThreadKeys = retainRecentThreads(recentThreadKeys, [
      ...agentThreads,
      ...nativeChildThreads,
      ...nativeThreads,
    ]);
    setSetting('sai-recent-agent-threads', JSON.stringify(recentThreadKeys));
  }

  function availableRecentKeys(): string[] {
    const availableAgents = new Set(
      agentAvailability.filter((agent) => agent.available).map((agent) => agent.id),
    );
    const projectPaths = new Set([
      ...projectCatalog.repositories,
      ...Object.values(projectCatalog.worktrees).flatMap((worktrees) =>
        worktrees.map((worktree) => worktree.path),
      ),
    ]);
    const availableThreads = new Set(
      [...agentThreads, ...nativeChildThreads, ...nativeThreads]
        .filter(
          (thread) =>
            (thread.agent === 'opencode'
              ? runtimeState === 'connected'
              : availableAgents.has(thread.agent)) && projectPaths.has(thread.directory),
        )
        .map(threadKey),
    );
    return recentThreadKeys.filter((key) => availableThreads.has(key));
  }

  function focusedThreadKey(): string | null {
    const thread =
      focusedPane === 'main'
        ? (acpThread ??
          (!acpAgent && sessionID
            ? nativeThreads.find(
                (item) => item.sessionId === sessionID && item.directory === directory,
              )
            : null))
        : leaves(paneLayout).find((pane) => pane.id === focusedPane)?.thread;
    return thread ? threadKey(thread) : null;
  }

  async function jumpToRecentThread(key: string): Promise<boolean> {
    const thread = [
      ...agentThreads,
      ...nativeChildThreads,
      ...nativeThreads,
      ...sidebarOpenCodeThreads,
    ].find((item) => threadKey(item) === key);
    if (
      !thread ||
      (thread.agent === 'opencode'
        ? runtimeState !== 'connected'
        : !agentAvailability.some((agent) => agent.id === thread.agent && agent.available))
    )
      return false;
    showWorkspace();
    const jump = ++recentJumpGeneration;
    let expectedProjectLoad = projectLoadGeneration;
    const target = await invoke<string>('validate_repository', { path: thread.directory }).catch(
      () => null,
    );
    if (!target || jump !== recentJumpGeneration || expectedProjectLoad !== projectLoadGeneration)
      return false;
    if (thread.directory !== directory || target !== directory) {
      const pending = loadProject(thread.directory, false);
      expectedProjectLoad = projectLoadGeneration;
      await pending;
    }
    if (jump !== recentJumpGeneration || expectedProjectLoad !== projectLoadGeneration)
      return false;
    const selected = [
      ...agentThreads,
      ...nativeChildThreads,
      ...nativeThreads,
      ...sidebarOpenCodeThreads,
    ].find(
      (item) =>
        item.directory === directory &&
        item.agent === thread.agent &&
        item.sessionId === thread.sessionId,
    );
    if (!selected) return false;
    showSidebarThread(selected);
    focusMainPane();
    if (selected.agent === 'opencode') {
      if (!(await selectSession(selected.sessionId))) return false;
    } else openAgent(selected.agent, selected, true);
    focusPaneForTyping('main');
    return true;
  }

  async function openShipTarget(path: string, threadId?: string | null) {
    try {
      await invoke('validate_repository', { path });
    } catch (cause) {
      if (missingRepositoryPath(cause))
        throw new Error('This Ship worktree no longer exists on disk.', { cause });
      throw cause;
    }
    if (threadId) {
      const thread = [
        ...agentThreads,
        ...nativeChildThreads,
        ...nativeThreads,
        ...sidebarOpenCodeThreads,
      ].find(
        (item) =>
          item.directory === path &&
          (item.agent === 'opencode'
            ? `opencode:${item.sessionId}`
            : `acp:${item.agent}:${item.sessionId}`) === threadId,
      );
      if (!thread)
        throw new Error('Session history is unavailable. Open the worktree to inspect it.');
      if (
        thread.agent === 'opencode'
          ? runtimeState !== 'connected'
          : !agentAvailability.some((agent) => agent.id === thread.agent && agent.available)
      )
        throw new Error('This session’s agent is unavailable.');
      if (!(await jumpToRecentThread(threadKey(thread))))
        throw new Error('Session history is unavailable. Open the worktree to inspect it.');
    } else await loadProject(path);
    closeShipRuns();
  }

  async function openSpawnTarget(receipt: SpawnReceipt) {
    if (!receipt.targetId || !receipt.targetDirectory)
      throw new Error('The child has not confirmed a target thread.');
    await openShipTarget(receipt.targetDirectory, receipt.targetId);
  }

  function openInbox() {
    if (!inboxDialog.open) inboxDialog.showModal();
    scheduleInboxRefresh();
  }

  async function focusInboxRequest(item: InboxItem, attempts = 40): Promise<void> {
    await tick();
    const request = [...document.querySelectorAll<HTMLElement>('[data-request-id]')].find(
      (element) =>
        element.dataset.requestId === String(item.requestId) &&
        element.dataset.sessionId === item.sessionId &&
        (item.kind !== 'acp-permission' || element.dataset.agentId === item.agentId) &&
        element.getClientRects().length,
    );
    if (request) {
      request.scrollIntoView({ block: 'center' });
      request.focus();
      return;
    }
    if (attempts === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return focusInboxRequest(item, attempts - 1);
  }

  async function openInboxItem(item: InboxItem) {
    inboxDialog.close();
    if (isInboxOutcome(item)) {
      const key = JSON.stringify([item.agentId, item.directory, item.sessionId]);
      const attentionBefore = threadAttention;
      try {
        await jumpToRecentThread(key);
        const outcome: InboxOutcome = {
          key: item.key,
          kind: item.kind as InboxOutcome['kind'],
          directory: item.directory,
          agentId: item.agentId!,
          sessionId: item.sessionId,
          text: item.text,
          receivedAt: item.receivedAt,
          eventId: item.eventId,
          read: false,
        };
        const previous = inboxOutcomes.filter((saved) => saved.key !== outcome.key);
        const next = markInboxOutcomeRead(recordInboxOutcome(previous, outcome), item.key);
        inboxOutcomes = next;
        setSetting('sai-inbox-outcomes', JSON.stringify(next));
        scheduleInboxRefresh();
        await focusInboxOutcome(item);
      } finally {
        if (item.kind === 'check-failed') {
          const preserved = preserveAttentionOnCheckOpen(threadAttention, attentionBefore, key);
          if (preserved !== threadAttention) {
            threadAttention = preserved;
            attentionRevision++;
            saveThreadAttention();
          }
        }
      }
      return;
    }
    if (item.kind === 'acp-permission') {
      const thread = [...agentThreads, ...nativeChildThreads].find(
        (entry) =>
          entry.agent === item.agentId &&
          entry.sessionId === item.sessionId &&
          entry.directory === item.directory,
      );
      if (thread) await jumpToRecentThread(threadKey(thread));
    } else {
      if (directory !== item.directory) await loadProject(item.directory, false);
      if (directory === item.directory) await selectSession(item.sessionId);
    }
    await focusInboxRequest(item);
  }

  async function focusInboxOutcome(item: InboxItem, attempts = 40): Promise<void> {
    await tick();
    if (item.kind === 'check-failed') {
      const check = [...document.querySelectorAll<HTMLElement>('.chat-area [data-check-id]')].find(
        (element) => element.dataset.checkId === item.eventId && element.getClientRects().length,
      );
      if (check) {
        check.scrollIntoView({ block: 'center' });
        check.focus();
        return;
      }
    } else {
      const visibleMessages = [
        ...document.querySelectorAll<HTMLElement>(
          '.chat-area .conversation .message[data-created]',
        ),
      ].filter(
        (element) =>
          element.getClientRects().length &&
          (element.classList.contains('user-message') ||
            element.classList.contains('assistant-message')),
      );
      const index = inboxTurnMessageIndex(
        visibleMessages.map((element) => ({
          kind: element.classList.contains('user-message') ? 'user' : 'assistant',
          created: Number(element.dataset.created),
        })),
        item.receivedAt,
      );
      const target = index === null ? null : visibleMessages[index];
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.focus();
        return;
      }
    }
    if (attempts === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return focusInboxOutcome(item, attempts - 1);
  }

  async function decideInbox(item: InboxItem, optionId: string | null) {
    if (item.kind === 'acp-permission') {
      const thread = [...agentThreads, ...nativeChildThreads].find(
        (entry) =>
          entry.agent === item.agentId &&
          entry.sessionId === item.sessionId &&
          entry.directory === item.directory,
      );
      if (!thread) throw new Error('Thread is no longer available.');
      await acp.permission(thread.agent, item.requestId!, optionId);
    } else if (item.kind === 'opencode-permission') {
      if (!client) throw new Error('OpenCode is not connected.');
      try {
        await client.permission.get({
          sessionID: item.sessionId,
          requestID: String(item.requestId),
        });
        await client.permission.reply({
          sessionID: item.sessionId,
          requestID: String(item.requestId),
          decision: optionId === 'reject' ? 'reject' : 'once',
        });
      } catch (cause) {
        if (!isPermissionNotFoundError(cause)) throw cause;
      }
    }
    recordDecisionActivity(
      {
        agent: item.agentId ?? 'opencode',
        directory: item.directory,
        sessionId: item.sessionId,
        title: item.text,
        updated: item.receivedAt,
      },
      String(item.requestId ?? item.key),
      item.text,
      optionId === null || optionId === 'reject' ? 'rejected' : 'completed',
    );
    await refreshInbox();
    if (item.kind === 'acp-permission') void restoreAgentActivity();
    if (item.kind === 'opencode-permission' && item.sessionId === sessionID) void refreshPrompts();
  }

  function createAgentThread(thread: AgentThread) {
    saveAgentThread(thread);
    rememberRecentThread(thread);
    if (acpAgent === thread.agent && directory === thread.directory && !acpThread) {
      migrateDiffComments(
        diffCommentKey('main'),
        `${directory}\0main\0acp:${thread.agent}:${thread.sessionId}`,
      );
      acpThread = thread;
      savePaneLayout(
        updatePane(paneLayout, 'main', { agent: thread.agent, thread, kind: undefined }),
      );
    }
  }

  function persistPaneLayouts() {
    setSetting('sai-pane-layouts', JSON.stringify(paneLayouts));
  }

  function clearMainPaneEmpty() {
    mainPickerDirectory = null;
    removeSetting(`sai-main-pane-empty:${directory}`);
  }

  function showEmptyMainPane() {
    ++selection;
    acpAgent = null;
    acpThread = null;
    if (sessionID) clearSelectedSession();
    newSessionMode = null;
    savePaneLayout(mainPane());
    mainPickerDirectory = directory;
    setSetting(`sai-main-pane-empty:${directory}`, 'true');
  }

  function savePaneLayout(layout: Pane) {
    paneLayouts = { ...paneLayouts, [directory]: layout };
    persistPaneLayouts();
    const main = leaves(layout).find((pane) => pane.id === 'main');
    if (main?.agent || main?.kind) clearMainPaneEmpty();
  }

  function paneSpan(id: string, axis: 'row' | 'column') {
    const bounds = document
      .querySelector<HTMLElement>(`[data-pane-id="${id}"]`)
      ?.getBoundingClientRect();
    return axis === 'row' ? bounds?.width : bounds?.height;
  }

  function splitFocusedPane(
    direction: 'row' | 'column',
    kind?: 'terminal' | 'browser' | 'agent-terminal',
    command?: string,
    agentTerminalId?: string,
  ) {
    if (!directory) return;
    let target = focusedPane;
    let splitDirection = direction;
    let span = paneSpan(target, splitDirection);
    if ((command || agentTerminalId) && (!span || span < 2 * minPaneSpan + 8)) {
      const options = leaves(paneLayout).flatMap((pane) =>
        (['row', 'column'] as const).map((axis) => ({
          id: pane.id,
          axis,
          span: paneSpan(pane.id, axis) ?? 0,
        })),
      );
      const choice = options
        .filter((option) => option.span >= 2 * minPaneSpan + 8)
        .toSorted(
          (a, b) => Number(b.id === focusedPane) - Number(a.id === focusedPane) || b.span - a.span,
        )[0];
      if (choice) {
        target = choice.id;
        splitDirection = choice.axis;
        span = choice.span;
      }
    }
    if (!span || span < 2 * minPaneSpan + 8) {
      error =
        command || agentTerminalId
          ? 'Enlarge a pane before running this command.'
          : 'Enlarge the focused pane before splitting it again.';
      return;
    }
    ++recentJumpGeneration;
    const layout = splitPane(paneLayout, target, splitDirection);
    const old = new Set(leaves(paneLayout).map((leaf) => leaf.id));
    const created = leaves(layout).find((leaf) => !old.has(leaf.id));
    if (!created) return;
    if (command) pendingCommands = { ...pendingCommands, [created.id]: command };
    const browserTab = kind === 'browser' ? newBrowserTab() : null;
    savePaneLayout(
      browserTab
        ? updatePane(layout, created.id, {
            kind: 'browser',
            tabs: [browserTab],
            activeTab: browserTab.id,
          })
        : kind === 'agent-terminal'
          ? updatePane(layout, created.id, { kind, terminalId: agentTerminalId })
          : kind
            ? updatePane(layout, created.id, { kind })
            : layout,
    );
    focusPaneForTyping(created.id);
    return created.id;
  }

  function openSideChat() {
    if (focusedPane === sideChat?.id) return;
    const current = leaves(paneLayout).find((leaf) => leaf.id === focusedPane);
    if (!current) return;
    let source: SideChat['source'];
    if (focusedPane === 'main' && !acpAgent && sessionID && client) {
      source = { kind: 'opencode', sessionID };
    } else if (current.agent === 'opencode' && current.thread && client) {
      source = { kind: 'opencode', sessionID: current.thread.sessionId };
    } else {
      const agent = focusedPane === 'main' ? acpAgent : current.agent;
      const thread = focusedPane === 'main' ? acpThread : current.thread;
      const transcript = agentEntrySnapshots[focusedPane];
      const pendingFirstTurn =
        !thread &&
        transcript?.sessionId === null &&
        transcript.entries.some((entry) => entry.type === 'user');
      if (!agent || (!thread && !pendingFirstTurn)) {
        error = 'Select an agent thread before opening a side chat.';
        return;
      }
      if (
        !transcript ||
        !transcript.ready ||
        (thread && transcript.sessionId !== thread.sessionId)
      ) {
        error = 'Wait for this thread to finish loading before opening a side chat.';
        return;
      }
      const context = transcript.entries
        .filter((entry) => entry.type === 'user' || entry.type === 'assistant')
        .map((entry) => `${entry.type}: ${'text' in entry ? entry.text : ''}`)
        .join('\n\n')
        .slice(-40000);
      source = { kind: 'acp', agent, context };
    }
    if ((paneSpan(focusedPane, 'row') ?? 0) < 2 * minPaneSpan + 8) {
      error = 'Enlarge the focused pane before opening a side chat.';
      return;
    }
    const id = crypto.randomUUID();
    sideChat = {
      id,
      parentId: focusedPane,
      parentThreadId: focusedPane === 'main' ? acpThread?.sessionId : current.thread?.sessionId,
      source,
    };
    focusPaneForTyping(id);
  }

  function focusPaneForTyping(id: string) {
    focusedPane = id;
    const thread =
      id === 'main' ? acpThread : leaves(paneLayout).find((pane) => pane.id === id)?.thread;
    if (thread) {
      rememberRecentThread(thread);
      markThreadRead(thread);
    }
    promptFocusPane = id;
    void focusPanePromptAfterTick(id);
  }

  function attachPickedElement(browserId: string, attachment: BrowserAttachment) {
    const candidates = leaves(paneLayout).filter(
      (leaf) => leaf.id !== browserId && (leaf.id === 'main' || !!leaf.agent),
    );
    const source = document.querySelector<HTMLElement>(`[data-pane-id="${browserId}"]`);
    if (!source || !candidates.length)
      throw new Error('Open an agent pane next to the browser first.');
    const bounds = source.getBoundingClientRect();
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;
    const next = candidates
      .map((leaf) => {
        const element = document.querySelector<HTMLElement>(`[data-pane-id="${leaf.id}"]`);
        const rect = element?.getBoundingClientRect();
        return {
          id: leaf.id,
          distance: rect
            ? Math.hypot(
                (rect.left + rect.right) / 2 - centerX,
                (rect.top + rect.bottom) / 2 - centerY,
              )
            : Infinity,
        };
      })
      .toSorted((a, b) => a.distance - b.distance)[0];
    if (!next || !Number.isFinite(next.distance)) throw new Error('Agent pane is unavailable.');
    if (attachment.previewUrl && attachment.url) {
      const captureSource = URL.canParse(attachment.url)
        ? new URL(attachment.url).hostname || attachment.url
        : attachment.url;
      reviewCaptures = retainCaptureMetadata([
        ...reviewCaptures,
        {
          id: attachment.id,
          paneId: next.id,
          phase: 'before' as const,
          source: captureSource,
          url: attachment.url,
          previewUrl: attachment.previewUrl,
          created: attachment.created ?? Date.now(),
          thread: null,
          turn: null,
          directory,
        },
      ]);
    }
    if (next.id === 'main' && !acpAgent) {
      draft = [draft.trim(), attachment.text].filter(Boolean).join('\n\n');
      attachedFiles = [...attachedFiles, attachment.imagePath];
      pickedImageText.set(attachment.imagePath, attachment.text);
      pickedCaptureIds.set(attachment.imagePath, attachment.id);
    } else {
      pickedAttachments = { ...pickedAttachments, [next.id]: attachment };
    }
    focusPaneForTyping(next.id);
  }

  function removeAttachedFile(path: string) {
    attachedFiles = attachedFiles.filter((item) => item !== path);
    if (clipboardAttachmentPaths.delete(path)) void removeClipboardFile(path);
    clipboardAttachmentNames.delete(path);
    const pickedText = pickedImageText.get(path);
    if (pickedText) {
      draft = draft.replace(pickedText, '').trim();
      pickedImageText.delete(path);
      pickedCaptureIds.delete(path);
      void invoke('browser_remove_capture', { path });
    }
  }

  function clearDraftAttachments() {
    draft = draftWithoutPickedImages(draft);
    for (const path of attachedFiles) {
      if (clipboardAttachmentPaths.delete(path)) void removeClipboardFile(path);
      clipboardAttachmentNames.delete(path);
      if (inFlightCaptures.has(path)) continue;
      if (!pickedImageText.delete(path)) continue;
      pickedCaptureIds.delete(path);
      void invoke('browser_remove_capture', { path });
    }
    attachedFiles = [];
  }

  function draftWithoutPickedImages(value: string) {
    for (const path of attachedFiles) {
      const pickedText = pickedImageText.get(path);
      if (pickedText) value = value.replace(pickedText, '').trim();
    }
    return value;
  }

  function markPickConsumed(id: string) {
    pickedAttachments = Object.fromEntries(
      Object.entries(pickedAttachments).filter(([, attachment]) => attachment.id !== id),
    );
  }

  function setReviewCapturePhase(id: string, phase: ReviewCapture['phase']) {
    reviewCaptures = reviewCaptures.map((capture) =>
      capture.id === id ? { ...capture, phase } : capture,
    );
  }

  function assignReviewCaptures(ids: string[], thread: string, turn: string) {
    const captureIds = new Set(ids);
    reviewCaptures = reviewCaptures.map((capture) =>
      captureIds.has(capture.id) ? { ...capture, thread, turn } : capture,
    );
  }

  function reviewPreviews(): ReviewPreview[] {
    return browserReviewPreviews(paneLayout);
  }

  function reviewEvidence(paneId: string, thread: string | null) {
    const captures = reviewCaptures.filter(
      (capture) =>
        capture.directory === directory &&
        (capture.thread === null ? capture.paneId === paneId : capture.thread === thread) &&
        (paneId === 'main' || capture.paneId === paneId),
    );
    const checks = thread
      ? postTurnResults.filter((check) => check.directory === directory && check.thread === thread)
      : [];
    return {
      captures,
      checks,
      previews: reviewPreviews(),
      filesUpdated: mainDiffEvidenceUpdated,
      updated: Math.max(
        mainDiffEvidenceUpdated,
        ...captures.map((capture) => capture.created),
        ...checks.map((check) => check.updated),
      ),
      oncheck: openReviewCheck,
      onpreview: openReviewPreview,
      oncapturephase: setReviewCapturePhase,
    };
  }

  function openReviewPreview(preview: ReviewPreview) {
    const next = selectReviewPreview(paneLayout, preview);
    if (!next) {
      error = 'Browser preview is no longer available.';
      return;
    }
    savePaneLayout(next);
    focusPane(preview.paneId);
  }

  async function openReviewCheck(check: PostTurnCheck) {
    showWorkspace();
    const thread = [...agentThreads, ...nativeThreads, ...sidebarOpenCodeThreads].find(
      (item) =>
        item.directory === check.directory &&
        (item.agent === 'opencode'
          ? `opencode:${item.sessionId}`
          : `acp:${item.agent}:${item.sessionId}`) === check.thread,
    );
    if (!thread || !(await jumpToRecentThread(threadKey(thread)))) {
      error = 'The session for this check is unavailable.';
      return;
    }
    mobileView = 'chat';
    await tick();
    const item = document.querySelector<HTMLElement>(`[data-check-id="${CSS.escape(check.id)}"]`);
    item?.scrollIntoView({ block: 'center' });
    item?.focus();
  }

  async function focusActivitySource(attribute: string, id: string, attempts = 30): Promise<void> {
    await tick();
    const target = [...chatArea.querySelectorAll<HTMLElement>(`[${attribute}]`)].find(
      (element) => element.getAttribute(attribute) === id,
    );
    if (target) {
      for (let parent: HTMLElement | null = target; parent; parent = parent.parentElement)
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      target.scrollIntoView({ block: 'center' });
      (target instanceof HTMLDetailsElement ? target.querySelector('summary') : target)?.focus();
      return;
    }
    if (attempts === 0) throw new Error('The recorded activity source is no longer available.');
    await new Promise((resolve) => setTimeout(resolve, 100));
    return focusActivitySource(attribute, id, attempts - 1);
  }

  async function selectActivityHistory(event: ActivityHistoryEvent) {
    if (event.kind === 'subagent') {
      const receipt = visibleSpawnReceipts.find((item) => item.receiptId === event.sourceId);
      if (!receipt) throw new Error('The recorded child is no longer available.');
      await openSpawnTarget(receipt);
      return;
    }
    if (event.kind === 'check') {
      const check = postTurnResults.find((item) => item.id === event.sourceId);
      if (!check) throw new Error('The recorded check is no longer available.');
      await openReviewCheck(check);
      return;
    }
    if (event.kind === 'decision') {
      const item = inboxItems.find(
        (candidate) =>
          !isInboxOutcome(candidate) &&
          candidate.directory === event.workspace &&
          candidate.sessionId === event.sessionId &&
          String(candidate.requestId ?? candidate.key) === event.sourceId,
      );
      if (item) {
        await openInboxItem(item);
        return;
      }
    }
    const thread = [
      ...agentThreads,
      ...nativeChildThreads,
      ...nativeThreads,
      ...sidebarOpenCodeThreads,
    ].find(
      (item) =>
        item.directory === event.workspace &&
        item.agent === event.agent &&
        item.sessionId === event.sessionId,
    );
    if (!thread || !(await jumpToRecentThread(threadKey(thread))))
      throw new Error('The recorded thread is no longer available.');
    mobileView = 'chat';
    if (event.kind === 'tool') await focusActivitySource('data-tool-id', event.sourceId);
  }

  function recordDecisionActivity(
    thread: AgentThread,
    sourceId: string,
    title: string,
    outcome: string,
  ) {
    durableActivityHistory = recentActivityEvents([
      ...durableActivityHistory,
      {
        workspace: thread.directory,
        kind: 'decision',
        source: thread.agent,
        sourceId,
        title,
        outcome,
        at: Date.now(),
        agent: thread.agent,
        sessionId: thread.sessionId,
      },
    ]);
    setSetting('sai-activity-history', saveActivityHistory(durableActivityHistory));
  }

  async function selectMainWorkspaceActivity(item: WorkspaceActivityItem) {
    if (item.kind === 'child') {
      const receipt = mainSpawnActivity.find((entry) => entry.receiptId === item.sourceId);
      if (receipt?.targetId && receipt.targetDirectory) {
        await openSpawnTarget(receipt);
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
    const target = chatArea?.querySelector<HTMLElement>(
      `[${attribute}="${CSS.escape(item.sourceId)}"]`,
    );
    for (let parent = target; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    target?.scrollIntoView({ block: 'center' });
    (target instanceof HTMLDetailsElement ? target.querySelector('summary') : target)?.focus();
  }

  function updateMainAgentWorkspaceActivity(
    items: WorkspaceActivityItem[],
    onselect: (item: WorkspaceActivityItem) => Promise<void>,
  ) {
    mainAgentWorkspaceActivity = items;
    selectMainAgentWorkspaceActivity = onselect;
  }

  async function selectMainActivity(item: WorkspaceActivityItem) {
    await (acpAgent ? selectMainAgentWorkspaceActivity(item) : selectMainWorkspaceActivity(item));
    if (window.matchMedia('(max-width: 850px)').matches) mobileView = 'chat';
  }

  function showActivitySource() {
    if (window.matchMedia('(max-width: 850px)').matches) mobileView = 'chat';
  }

  function focusPane(id: string) {
    if (focusedPane === id) return;
    ++recentJumpGeneration;
    focusedPane = id;
    const thread =
      id === 'main' ? acpThread : leaves(paneLayout).find((pane) => pane.id === id)?.thread;
    if (thread) {
      rememberRecentThread(thread);
      markThreadRead(thread);
    }
  }

  async function focusPanePromptAfterTick(id: string) {
    await tick();
    if (focusedPane !== id || promptFocusPane !== id) return;
    const pane = document.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
    const prompt = pane?.querySelector<HTMLTextAreaElement>(
      '[data-pane-prompt]:not(:disabled), .xterm-helper-textarea, .browser-toolbar input',
    );
    const picker = pane?.querySelector<HTMLButtonElement>(
      '[data-agent-choice]:not(:disabled), [data-pane-picker]',
    );
    if (prompt) {
      prompt.focus();
      promptFocusPane = null;
    } else if (picker) {
      picker.focus();
      promptFocusPane = null;
    } else {
      pane?.focus();
      if (id === 'main' && !acpAgent) promptFocusPane = null;
    }
  }

  function cancelPendingPromptFocus(event: FocusEvent) {
    if (!promptFocusPane) return;
    const pane = document.querySelector<HTMLElement>(`[data-pane-id="${promptFocusPane}"]`);
    if (!(event.target instanceof Node) || !pane?.contains(event.target)) promptFocusPane = null;
  }

  function closeFocusedPane(id: string) {
    if (id === sideChat?.id) {
      const parentId = sideChat.parentId;
      sideChat = null;
      focusPaneForTyping(parentId);
      return;
    }
    if (id === sideChat?.parentId) sideChat = null;
    invalidatePaneSelection(id);
    const batch = pendingAgentBatches[id];
    if (batch) completeAgentBatch(batch.id, 'Agent pane closed before comments were sent.');
    ++recentJumpGeneration;
    terminalExitWaiters.get(id)?.(1);
    terminalExitWaiters.delete(id);
    finishCoordinationSetup(id, 1);
    if (leaves(paneLayout).find((leaf) => leaf.id === id)?.kind === 'terminal')
      void invoke('terminal_close', { id: terminalRuntimeId(directory, id) });
    let layout = closePane(paneLayout, id);
    if (!('direction' in layout) && layout.id === 'main')
      layout = { id: 'main', agent: acpAgent, thread: acpThread };
    if (id === 'main' && !('direction' in layout) && layout.id === 'main') showEmptyMainPane();
    else savePaneLayout(layout);
    changesPanes = changesPanes.filter((item) => item !== id);
    focusPaneForTyping(leaves(layout)[0]?.id ?? 'main');
  }

  function closeCurrentPane() {
    ++recentJumpGeneration;
    if (focusedPane === sideChat?.id) {
      closeFocusedPane(focusedPane);
      return;
    }
    if (focusedPane === sideChat?.parentId && leaves(paneLayout).length === 1) sideChat = null;
    if (leaves(paneLayout).length > 1) {
      closeFocusedPane(focusedPane);
      return;
    }
    if (
      acpAgent ||
      !leaves(paneLayout).some((pane) => pane.id === 'main') ||
      leaves(paneLayout).some((pane) => pane.id === 'main' && !!pane.kind)
    ) {
      if (leaves(paneLayout)[0]?.kind === 'terminal')
        void invoke('terminal_close', {
          id: terminalRuntimeId(directory, leaves(paneLayout)[0].id),
        });
      showEmptyMainPane();
      changesPanes = [];
    } else if (sessionID || newSessionMode) {
      showEmptyMainPane();
    }
    focusPaneForTyping('main');
  }

  function updatePaneRatio(id: string, ratio: number) {
    savePaneLayout(updatePane(paneLayout, id, { ratio }));
  }

  function createPaneThread(id: string, thread: AgentThread) {
    invalidatePaneSelection(id);
    const sessionKey =
      thread.agent === 'opencode'
        ? `opencode:${thread.sessionId}`
        : `acp:${thread.agent}:${thread.sessionId}`;
    migrateDiffComments(diffCommentKey(id), `${directory}\0${id}\0${sessionKey}`);
    savePaneLayout(updatePane(paneLayout, id, { thread }));
    if (thread.agent === 'opencode') {
      rememberRecentThread(thread);
      void refreshSessions().catch((cause) => (error = describe(cause)));
      return;
    }
    saveAgentThread(thread);
    rememberRecentThread(thread);
  }

  function recordPaneActivity(thread: AgentThread) {
    if (thread.agent !== 'opencode') {
      saveAgentThread(thread);
      return;
    }
    const pane = leaves(paneLayout).find(
      (leaf) => leaf.agent === 'opencode' && leaf.thread?.sessionId === thread.sessionId,
    );
    if (pane) savePaneLayout(updatePane(paneLayout, pane.id, { thread }));
    rememberRecentThread(thread);
    void refreshSessions().catch((cause) => (error = describe(cause)));
  }

  function choosePaneAgent(id: string, agent: AgentId) {
    if (id === 'main') {
      if (agent === 'opencode') newWork();
      else openAgent(agent);
      return;
    }
    invalidatePaneSelection(id);
    const batch = pendingAgentBatches[id];
    if (batch) completeAgentBatch(batch.id, 'Agent pane changed before comments were sent.');
    savePaneLayout(updatePane(paneLayout, id, { agent, thread: null, kind: undefined }));
    focusPaneForTyping(id);
  }

  function choosePaneTerminal(id: string) {
    invalidatePaneSelection(id);
    const batch = pendingAgentBatches[id];
    if (batch) completeAgentBatch(batch.id, 'Agent pane changed before comments were sent.');
    savePaneLayout(updatePane(paneLayout, id, { agent: null, thread: null, kind: 'terminal' }));
    focusPaneForTyping(id);
  }

  function choosePaneBrowser(id: string) {
    invalidatePaneSelection(id);
    const batch = pendingAgentBatches[id];
    if (batch) completeAgentBatch(batch.id, 'Agent pane changed before comments were sent.');
    const tab = newBrowserTab();
    savePaneLayout(
      updatePane(paneLayout, id, {
        agent: null,
        thread: null,
        kind: 'browser',
        tabs: [tab],
        activeTab: tab.id,
      }),
    );
    focusPaneForTyping(id);
  }

  function updatePaneBrowser(id: string, tabs: BrowserTab[], activeTab: string) {
    savePaneLayout(updatePane(paneLayout, id, { tabs, activeTab }));
  }

  function diffCommentKey(id: string) {
    if (id === 'main')
      return `${directory}\0main\0${acpAgent ? `acp:${acpAgent}:${acpThread?.sessionId ?? 'new'}` : `opencode:${sessionID ?? 'new'}`}`;
    const pane = leaves(paneLayout).find((leaf) => leaf.id === id);
    if (pane?.agent === 'opencode')
      return `${directory}\0${id}\0opencode:${pane.thread?.sessionId ?? 'new'}`;
    return `${directory}\0${id}\0acp:${pane?.agent ?? 'none'}:${pane?.thread?.sessionId ?? 'new'}`;
  }

  function updateDiffComments(scope: string, comments: DiffComment[]) {
    diffComments = { ...diffComments, [scope]: comments };
  }

  function migrateDiffComments(from: string, to: string) {
    if (from === to || !diffComments[from]?.length) return;
    const next = { ...diffComments, [to]: [...(diffComments[to] ?? []), ...diffComments[from]] };
    delete next[from];
    diffComments = next;
  }

  function removeSentDiffComments(scope: string, ids: string[]) {
    const sent = new Set(ids);
    diffComments = Object.fromEntries(
      Object.entries(diffComments).map(([key, comments]) => [
        key,
        key === scope || comments.some((comment) => sent.has(comment.id))
          ? comments.filter((comment) => !sent.has(comment.id))
          : comments,
      ]),
    );
  }

  function completeAgentBatch(id: string, failure: string | null) {
    const entry = Object.entries(pendingAgentBatches).find(([, batch]) => batch.id === id);
    if (entry) {
      const next = { ...pendingAgentBatches };
      delete next[entry[0]];
      pendingAgentBatches = next;
    }
    const waiter = batchWaiters.get(id);
    batchWaiters.delete(id);
    if (failure) waiter?.reject(new Error(failure));
    else waiter?.resolve();
  }

  async function sendDiffComments(id: string, scope: string, text: string): Promise<void> {
    if (scope !== diffCommentKey(id))
      throw new Error('The agent thread changed. Review these comments before sending.');
    if (id === 'main' && !acpAgent) {
      if (!client || !sessionID || running || sending)
        throw new Error('Wait for the current agent turn.');
      const current = selection;
      const session = sessionID;
      sending = true;
      running = true;
      activity = 'Thinking';
      try {
        await invoke('record_turn_snapshot', {
          path: directory,
          thread: `opencode:${session}`,
        });
        await client.session.prompt({ sessionID: session, text });
        if (current === selection && session === sessionID)
          void refreshSession(session).catch((cause) => (error = describe(cause)));
      } catch (cause) {
        if (current === selection && session === sessionID) running = false;
        throw cause;
      } finally {
        sending = false;
      }
      return;
    }
    const agent =
      id === 'main' ? acpAgent : leaves(paneLayout).find((leaf) => leaf.id === id)?.agent;
    if (!agent || pendingAgentBatches[id]) throw new Error('Agent pane is not ready for comments.');
    const batch = { id: crypto.randomUUID(), text };
    return new Promise<void>((resolve, reject) => {
      batchWaiters.set(batch.id, { resolve, reject });
      pendingAgentBatches = { ...pendingAgentBatches, [id]: batch };
    });
  }

  function focusMainPane() {
    if (!leaves(paneLayout).some((leaf) => leaf.id === 'main')) {
      savePaneLayout({
        id: crypto.randomUUID(),
        direction: 'row',
        ratio: 0.5,
        first: mainPane(),
        second: paneLayout,
      });
    }
    focusedPane = 'main';
  }

  function removeAgentThread(thread: AgentThread) {
    const usage = { ...agentUsage };
    delete usage[threadKey(thread)];
    agentUsage = usage;
    agentThreads = agentThreads.filter(
      (item) =>
        item.agent !== thread.agent ||
        item.directory !== thread.directory ||
        item.sessionId !== thread.sessionId,
    );
    saveAgentThreads(agentThreads);
    forgetMissingRecentThreads();
    forgetThreadAttention(thread);
    for (const [path, layout] of Object.entries(paneLayouts)) {
      let next = layout;
      for (const leaf of leaves(layout)) {
        if (
          leaf.thread?.sessionId === thread.sessionId &&
          leaf.thread.directory === thread.directory &&
          leaf.agent === thread.agent
        )
          next = updatePane(next, leaf.id, { thread: null });
      }
      paneLayouts[path] = next;
    }
    persistPaneLayouts();
    if (
      acpThread?.sessionId === thread.sessionId &&
      acpThread.directory === thread.directory &&
      acpAgent === thread.agent
    ) {
      acpThread = null;
      savePaneLayout(
        updatePane(paneLayout, 'main', { agent: thread.agent, thread: null, kind: undefined }),
      );
    }
    void tick().then(() => forgetRecentTranscript(thread));
  }

  function agentThreadKey(thread: AgentThread): string {
    return threadKey(thread);
  }

  function focusedSnapshotThread(): string | null {
    const pane =
      focusedPane === 'main' ? null : leaves(paneLayout).find((leaf) => leaf.id === focusedPane);
    if (focusedPane !== 'main' && !pane) return null;
    const agent = pane ? pane.agent : acpAgent;
    const thread = pane ? pane.thread : acpThread;
    if (agent && thread)
      return agent === 'opencode'
        ? `opencode:${thread.sessionId}`
        : `acp:${agent}:${thread.sessionId}`;
    if (focusedPane === 'main' && !acpAgent && sessionID) return `opencode:${sessionID}`;
    return null;
  }

  async function openSnapshots() {
    const thread = focusedSnapshotThread();
    if (!directory || !thread) return;
    const path = directory;
    const generation = ++snapshotsGeneration;
    snapshotsThread = thread;
    snapshotsPath = path;
    snapshots = [];
    snapshotsError = '';
    snapshotsLoading = true;
    snapshotsDialog.showModal();
    try {
      const items = await invoke<TurnSnapshot[]>('list_turn_snapshots', { path, thread });
      if (generation === snapshotsGeneration) snapshots = items;
    } catch (cause) {
      if (generation === snapshotsGeneration) snapshotsError = describe(cause);
    } finally {
      if (generation === snapshotsGeneration) snapshotsLoading = false;
    }
  }

  async function restoreSnapshot(item: TurnSnapshot) {
    if (snapshotsRestoring) return;
    const generation = snapshotsGeneration;
    if (directory !== snapshotsPath || focusedSnapshotThread() !== snapshotsThread) {
      snapshotsError = 'Return to the thread whose history is open.';
      return;
    }
    if (
      running ||
      sending ||
      activeSessionIDs.length > 0 ||
      agentThreads.some(
        (thread) => thread.directory === snapshotsPath && runningAgentThreads[threadKey(thread)],
      )
    ) {
      snapshotsError = 'Wait for running agent turns before restoring.';
      return;
    }
    const confirmed = await confirmInApp(
      'Restore worktree',
      'Restore the worktree to this saved state? Current file changes will be saved as an undo entry.',
      'Restore',
    );
    if (!confirmed) return;
    if (
      running ||
      sending ||
      activeSessionIDs.length > 0 ||
      agentThreads.some(
        (thread) => thread.directory === snapshotsPath && runningAgentThreads[threadKey(thread)],
      )
    ) {
      snapshotsError = 'An agent turn started while confirmation was open. Wait before restoring.';
      return;
    }
    snapshotsRestoring = true;
    snapshotsError = '';
    try {
      await invoke('restore_turn_snapshot', {
        path: snapshotsPath,
        thread: snapshotsThread,
        id: item.id,
      });
      const items = await invoke<TurnSnapshot[]>('list_turn_snapshots', {
        path: snapshotsPath,
        thread: snapshotsThread,
      });
      if (generation === snapshotsGeneration) snapshots = items;
      if (acpAgent) await refreshAgentDiff();
      else await refreshDiff();
    } catch (cause) {
      if (generation === snapshotsGeneration) snapshotsError = describe(cause);
    } finally {
      snapshotsRestoring = false;
    }
  }

  function saveThreadAttention() {
    setSetting('sai-thread-attention', JSON.stringify(threadAttention));
  }

  function markThreadRead(thread: AgentThread) {
    const next = markAttentionRead(threadAttention, threadKey(thread));
    if (next === threadAttention) return;
    threadAttention = next;
    attentionRevision++;
    saveThreadAttention();
  }

  function forgetThreadAttention(thread: AgentThread) {
    const key = threadKey(thread);
    const next = { ...threadAttention };
    delete next[key];
    threadAttention = next;
    saveThreadAttention();
    const nextRunning = { ...runningAgentThreads };
    delete nextRunning[key];
    runningAgentThreads = nextRunning;
    updateAttentionBadge();
  }

  function threadIsViewed(key: string): boolean {
    return (
      document.hasFocus() &&
      (leaves(paneLayout).some((pane) => pane.thread && threadKey(pane.thread) === key) ||
        (!acpAgent && !!sessionID && focusedThreadKey() === key))
    );
  }

  function updateAttentionBadge() {
    if (!isTauri()) return;
    const threads = new Set([...agentThreads, ...sidebarOpenCodeThreads].map(threadKey));
    const count = Object.entries(threadAttention).filter(
      ([key, item]) => threads.has(key) && item.status === 'waiting',
    ).length;
    void invoke('set_attention_badge', { count }).catch(() => undefined);
  }

  async function reconcileNativeActivity() {
    if (!client) return;
    const source = client;
    const generation = ++nativeActivityGeneration;
    try {
      const paths: string[] = JSON.parse(sidebarDirectoryKey);
      const [active, requests] = await Promise.all([
        source.session.active(),
        Promise.allSettled(
          paths.map(async (path) => {
            const [permissions, forms] = await Promise.all([
              source.permission.request.list({ location: { directory: path } }),
              source.form.list({ location: { directory: path } }),
            ]);
            return [
              ...permissions.data.map((request) => request.sessionID),
              ...forms.data.map((form) => form.sessionID),
            ];
          }),
        ),
      ]);
      if (generation !== nativeActivityGeneration || source !== client) return;
      activeSessionIDs = Object.keys(active);
      const waiting = new Set(
        requests.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
      );
      const unavailable = new Set(
        paths.filter((_, index) => requests[index]?.status === 'rejected'),
      );
      const known = groupSidebarThreads([...sidebarOpenCodeThreads, ...nativeThreads]);
      const threads = Object.values(known).flat();
      const stale = threads.filter(
        (thread) =>
          !unavailable.has(thread.directory) &&
          !waiting.has(thread.sessionId) &&
          !active[thread.sessionId] &&
          ['working', 'waiting'].includes(threadAttention[threadKey(thread)]?.status ?? ''),
      );
      const outcomes = await Promise.allSettled(
        stale.map((thread) => source.session.get({ sessionID: thread.sessionId })),
      );
      if (generation !== nativeActivityGeneration || source !== client) return;
      nativeActivityReady = true;
      nativeUnavailableDirectories = [...unavailable];
      const ended = new Map(stale.map((thread, index) => [threadKey(thread), outcomes[index]]));
      for (const thread of threads) {
        if (unavailable.has(thread.directory)) continue;
        const result = ended.get(threadKey(thread));
        const status = waiting.has(thread.sessionId)
          ? 'waiting'
          : active[thread.sessionId]
            ? 'working'
            : result
              ? result.status === 'fulfilled'
                ? result.value.outcome === 'failed'
                  ? 'failed'
                  : result.value.outcome
                    ? 'done'
                    : null
                : null
              : null;
        if (status && status !== threadAttention[threadKey(thread)]?.status)
          updateAgentThreadStatus(thread, status);
        else if (result && !status) forgetThreadAttention(thread);
      }
    } catch {
      if (generation === nativeActivityGeneration && source === client) nativeActivityReady = false;
      return;
    }
  }

  async function recoverInterruptedAgentTurns() {
    let turns: InterruptedAgentTurn[];
    try {
      turns = await acp.interruptedTurns();
    } catch (cause) {
      error = `Could not restore interrupted agent work: ${describe(cause)}`;
      return;
    }
    await Promise.all(
      turns.map(async (turn) => {
        let thread = agentThreads.find(
          (item) =>
            item.agent === turn.agent &&
            item.sessionId === turn.sessionId &&
            item.directory === turn.directory,
        );
        if (!thread) {
          thread = {
            agent: turn.agent,
            sessionId: turn.sessionId,
            directory: turn.directory,
            title: turn.text.slice(0, 60) || 'Interrupted agent work',
            updated: Date.now(),
          };
          saveAgentThread(thread);
        }
        const recoveredThread = thread;
        const alreadyActive = async () => {
          const current = (await acp.activity())[turn.agent];
          return current?.activeTurns[turn.sessionId] === turn.turnId;
        };
        try {
          if (await alreadyActive()) {
            updateAgentThreadStatus(recoveredThread, 'working');
            return;
          }
          const info = await acp.connect(turn.agent);
          const capabilities = info.agentCapabilities;
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
          if (canResume) await acp.resume(turn.agent, turn.directory, turn.sessionId);
          else await acp.load(turn.agent, turn.directory, turn.sessionId);
          if (disposed) return;
          if (await alreadyActive()) {
            updateAgentThreadStatus(recoveredThread, 'working');
            return;
          }
          await invoke('record_turn_snapshot', {
            path: turn.directory,
            thread: `acp:${turn.agent}:${turn.sessionId}`,
          });
          updateAgentThreadStatus(recoveredThread, 'working');
          const prompt = [
            'Sail closed while your previous turn was running. Continue the interrupted work in this thread.',
            `Previous user request:\n${turn.text}`,
            'Inspect the current worktree and transcript before rerunning tools. Keep completed changes, rerun unfinished commands, and finish the request.',
          ].join('\n\n');
          const continued = acp.prompt(turn.agent, turn.sessionId, prompt, turn.turnId);
          void (async () => {
            try {
              const outcome = await continued;
              await acp.finishInterruptedTurn(turn);
              if (!disposed)
                updateAgentThreadStatus(
                  recoveredThread,
                  'done',
                  outcome.stopReason !== 'cancelled',
                );
            } catch (cause) {
              if (!disposed) {
                if (await alreadyActive()) updateAgentThreadStatus(recoveredThread, 'working');
                else {
                  updateAgentThreadStatus(recoveredThread, 'failed');
                  error = `Could not continue ${recoveredThread.title}: ${describe(cause)}`;
                }
              }
            }
          })();
          await awaitCoordinationStart(continued, async () => {
            const state = (await acp.activity())[turn.agent];
            return !!state?.active.includes(turn.sessionId);
          });
        } catch (cause) {
          if (await alreadyActive()) updateAgentThreadStatus(recoveredThread, 'working');
          else {
            updateAgentThreadStatus(recoveredThread, 'failed');
            error = `Could not continue ${recoveredThread.title}: ${describe(cause)}`;
          }
        }
      }),
    );
  }

  async function restoreAgentActivity(attempt = 0) {
    const revision = attentionRevision;
    try {
      const backendActivity = await acp.activity();
      if (disposed) return;
      for (const receipt of spawnReceipts.filter(
        (item) =>
          item.provider !== 'opencode' &&
          item.targetId &&
          item.turnId &&
          !receiptIsSettled(item.state),
      ))
        reconcileAcpSpawnReceipt(receipt, backendActivity[receipt.provider]);
      if (revision !== attentionRevision) {
        if (attempt < 2) await restoreAgentActivity(attempt + 1);
        return;
      }
      const previousAttention = threadAttention;
      threadAttention = reconcileAttention(
        threadAttention,
        agentThreads.map((thread) => ({
          agent: thread.agent,
          sessionId: thread.sessionId,
          key: threadKey(thread),
          viewed: threadIsViewed(threadKey(thread)),
        })),
        backendActivity,
      );
      saveThreadAttention();
      acpActivityReady = true;
      runningAgentThreads = Object.fromEntries(
        Object.entries(threadAttention)
          .filter(([, item]) => item.status === 'working' || item.status === 'waiting')
          .map(([key]) => [key, true]),
      );
      updateAttentionBadge();
      for (const thread of agentThreads) {
        const key = threadKey(thread);
        const before = previousAttention[key];
        const after = threadAttention[key];
        if (
          after?.unread &&
          before?.status !== after.status &&
          (after.status === 'waiting' || after.status === 'done')
        )
          showThreadAttentionNotification(thread, after.status);
      }
    } catch {
      return;
    }
  }

  function updateAgentThreadStatus(thread: AgentThread, status: ThreadStatus, notifyOnDone = true) {
    const key = agentThreadKey(thread);
    if (thread.agent !== 'opencode' && !agentThreads.some((item) => threadKey(item) === key))
      return;
    const { next, notify } = updateAttention(
      threadAttention,
      key,
      status,
      threadIsViewed(key),
      notifyOnDone,
    );
    threadAttention = next;
    attentionRevision++;
    saveThreadAttention();
    if (status === 'working' || status === 'waiting')
      runningAgentThreads = { ...runningAgentThreads, [key]: true };
    else {
      const nextRunning = { ...runningAgentThreads };
      delete nextRunning[key];
      runningAgentThreads = nextRunning;
    }
    updateAttentionBadge();
    if (notify) showThreadAttentionNotification(thread, status);
  }

  function showThreadAttentionNotification(thread: AgentThread, status: ThreadStatus) {
    if (!notificationsEnabled || !isTauri()) return;
    const children = activeSubagentsForSource(
      spawnReceipts,
      receiptSourceId(thread.agent, thread.sessionId),
      thread.directory,
    );
    void invoke('show_attention_notification', {
      threadKey: threadKey(thread),
      title: thread.title,
      body:
        status === 'waiting'
          ? 'Needs your input'
          : children.some((child) => child.state === 'waiting')
            ? 'Subagent needs your input'
            : children.length
              ? 'Subagents are still active'
              : 'Completed',
      sound: notificationSound,
    }).catch(() => undefined);
  }

  async function runOnePostTurnCheck(check: PostTurnCheck, retry = false) {
    const key = checkKey(check);
    if (
      pendingPostTurnChecks.has(key) ||
      (!retry && postTurnResults.some((item) => checkKey(item) === key))
    )
      return;
    pendingPostTurnChecks.add(key);
    try {
      if (check.source === 'repository') {
        const approved = await invoke<boolean>('is_post_turn_check_approved', {
          directory: check.directory,
          command: check.command,
        });
        if (!approved) {
          const allow = await confirmInApp(
            'Review repository post-turn check',
            `Run this repository command in ${check.directory} after agent turns?\n\n${check.command}`,
            'Approve command',
          );
          if (!allow) {
            const canceled = await invoke<PostTurnCheck>('cancel_post_turn_check', check);
            postTurnResults = upsertCheck(postTurnResults, canceled);
            return;
          }
          await invoke('approve_post_turn_check', {
            directory: check.directory,
            command: check.command,
          });
        }
      }
      postTurnResults = upsertCheck(postTurnResults, { ...check, status: 'running' });
      const result = await invoke<PostTurnCheck>('run_post_turn_check', {
        request: { ...check, retry },
      });
      postTurnResults = upsertCheck(postTurnResults, result);
    } catch (cause) {
      postTurnResults = upsertCheck(postTurnResults, {
        ...check,
        status: 'failed',
        output: describe(cause),
        code: null,
      });
    } finally {
      pendingPostTurnChecks.delete(key);
      scheduleInboxRefresh();
    }
  }

  async function runCompletedChecks(path: string, thread: string, turn: string) {
    if (!path || !thread || !turn) return;
    const entries: { source: 'repository' | 'personal'; command: string }[] =
      personalPostTurnChecks.map((command) => ({ source: 'personal', command }));
    try {
      const config = await invoke<WorktreeConfig | null>('worktree_config', { worktree: path });
      entries.push(
        ...(config?.postTurnChecks ?? []).map((command) => ({
          source: 'repository' as const,
          command,
        })),
      );
    } catch (cause) {
      error = `Could not load repository post-turn checks: ${describe(cause)}`;
    }
    for (const entry of entries) {
      void runOnePostTurnCheck({
        id: JSON.stringify([path, thread, turn, entry.source, entry.command]),
        updated: Date.now(),
        directory: path,
        thread,
        turn,
        ...entry,
        status: 'running',
        output: '',
        code: null,
      });
    }
  }

  function handleAgentEvent(event: AgentEvent) {
    const eventSessionId = event.message.params?.sessionId;
    const eventDirectory =
      typeof eventSessionId === 'string'
        ? ([...agentThreads, ...nativeChildThreads].find(
            (thread) => thread.agent === event.agent && thread.sessionId === eventSessionId,
          )?.directory ?? directory)
        : directory;
    nativeSubagents = updateNativeSubagents(
      nativeSubagents,
      event,
      eventDirectory,
      Date.now(),
      typeof eventSessionId === 'string' &&
        (!!replayingAgentSessions[JSON.stringify([event.agent, eventSessionId])] ||
          !!nativeSubagents[nativeSubagentId(event.agent, eventSessionId)]?.restored),
    );
    if (event.message.method === 'sail/permission_resolved' && typeof eventSessionId === 'string')
      nativeSubagents = setNativeSubagentWaiting(
        nativeSubagents,
        event.agent,
        eventSessionId,
        false,
      );
    if (event.message.method === 'session/update') {
      const params = event.message.params;
      const sessionId = params?.sessionId;
      if (typeof sessionId === 'string') {
        const update = params?.update;
        const content =
          update && typeof update === 'object' && 'content' in update ? update.content : null;
        const text =
          update &&
          typeof update === 'object' &&
          'sessionUpdate' in update &&
          update.sessionUpdate === 'agent_message_chunk' &&
          content &&
          typeof content === 'object' &&
          'text' in content &&
          typeof content.text === 'string'
            ? content.text
            : null;
        if (text && !replayingAgentSessions[JSON.stringify([event.agent, sessionId])])
          for (const receipt of spawnReceipts.filter(
            (item) =>
              item.targetId === `acp:${event.agent}:${sessionId}` &&
              activeSpawnTargets.get(item.targetId) === item.receiptId &&
              !receiptIsSettled(item.state),
          )) {
            const result = `${receipt.result ?? ''}${text}`.slice(-16_000);
            updateSpawnReceipt(receipt.receiptId, { result, activity: 'Writing response…' });
            spawnOutput.set(receipt.receiptId, result);
          }
        const toolTitle =
          update &&
          typeof update === 'object' &&
          'sessionUpdate' in update &&
          (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
          'title' in update &&
          typeof update.title === 'string'
            ? update.title
            : null;
        if (toolTitle && !replayingAgentSessions[JSON.stringify([event.agent, sessionId])])
          for (const receipt of spawnReceipts.filter(
            (item) =>
              item.targetId === `acp:${event.agent}:${sessionId}` &&
              activeSpawnTargets.get(item.targetId) === item.receiptId &&
              !receiptIsSettled(item.state),
          ))
            updateSpawnReceipt(receipt.receiptId, { activity: toolTitle });
        const usage = acpUsage(params?.update);
        if (usage?.rates && !replayingAgentSessions[JSON.stringify([event.agent, sessionId])])
          agentRates = { ...agentRates, [event.agent]: usage.rates };
        if (usage) {
          const nextUsage = { ...agentUsage };
          for (const thread of agentThreads.filter(
            (item) => item.agent === event.agent && item.sessionId === sessionId,
          )) {
            nextUsage[threadKey(thread)] = { context: usage.context };
          }
          agentUsage = nextUsage;
        }
      }
    }
    if (
      event.message.method === 'session/request_permission' ||
      event.message.method === 'sail/permission_resolved' ||
      event.message.method === 'sail/disconnected'
    )
      scheduleInboxRefresh();
    if (event.message.method === 'sail/prompt_finished') {
      const sessionId = event.message.params?.sessionId;
      const status = event.message.params?.status;
      const turnId = event.message.params?.turnId;
      if (typeof sessionId !== 'string' || (status !== 'done' && status !== 'failed')) return;
      if (
        status === 'done' &&
        typeof turnId === 'string' &&
        event.message.params?.notify !== false &&
        !replayingAgentSessions[JSON.stringify([event.agent, sessionId])]
      ) {
        const thread = agentThreads.find(
          (item) => item.agent === event.agent && item.sessionId === sessionId,
        );
        if (thread)
          void runCompletedChecks(thread.directory, `acp:${event.agent}:${sessionId}`, turnId);
      }
      for (const thread of agentThreads.filter(
        (item) => item.agent === event.agent && item.sessionId === sessionId,
      )) {
        updateAgentThreadStatus(thread, status, event.message.params?.notify !== false);
        if (
          status === 'done' &&
          typeof turnId === 'string' &&
          event.message.params?.notify !== false
        )
          recordTurnOutcome(thread, turnId);
      }
      for (const receipt of spawnReceipts.filter(
        (item) =>
          item.targetId === `acp:${event.agent}:${sessionId}` &&
          item.turnId === turnId &&
          !receiptIsSettled(item.state),
      ))
        updateSpawnReceipt(receipt.receiptId, {
          state:
            status === 'failed'
              ? 'failed'
              : event.message.params?.notify === false
                ? 'interrupted'
                : 'completed',
          result: spawnOutput.get(receipt.receiptId) ?? receipt.result,
          error:
            typeof event.message.params?.error === 'string'
              ? event.message.params.error
              : receipt.error,
        });
    } else if (event.message.method === 'session/request_permission') {
      const sessionId = event.message.params?.sessionId;
      if (typeof sessionId !== 'string') return;
      nativeSubagents = setNativeSubagentWaiting(nativeSubagents, event.agent, sessionId, true);
      for (const thread of agentThreads.filter(
        (item) => item.agent === event.agent && item.sessionId === sessionId,
      ))
        updateAgentThreadStatus(thread, 'waiting');
      for (const receipt of spawnReceipts.filter(
        (item) =>
          item.targetId === `acp:${event.agent}:${sessionId}` &&
          activeSpawnTargets.get(item.targetId) === item.receiptId &&
          !receiptIsSettled(item.state),
      ))
        updateSpawnReceipt(receipt.receiptId, { state: 'waiting' });
    } else if (event.message.method === 'sail/disconnected') {
      nativeSubagents = disconnectNativeSubagents(nativeSubagents, event.agent);
      for (const thread of agentThreads.filter(
        (item) =>
          item.agent === event.agent &&
          ['working', 'waiting'].includes(threadAttention[threadKey(item)]?.status ?? ''),
      ))
        updateAgentThreadStatus(thread, 'failed');
      for (const receipt of spawnReceipts.filter(
        (item) => item.provider === event.agent && !receiptIsSettled(item.state),
      ))
        updateSpawnReceipt(receipt.receiptId, { state: 'unavailable' });
    }
  }

  function setAgentReplay(agent: AgentId, sessionId: string | null, replaying: boolean) {
    if (!sessionId) return;
    const key = JSON.stringify([agent, sessionId]);
    const next = { ...replayingAgentSessions };
    const count = (next[key] ?? 0) + (replaying ? 1 : -1);
    if (count > 0) next[key] = count;
    else delete next[key];
    replayingAgentSessions = next;
    if (!replaying && sessionId)
      nativeSubagents = finalizeNativeSubagentRestore(nativeSubagents, agent, sessionId);
  }

  function invalidatePaneSelection(id: string) {
    paneSelections.set(id, (paneSelections.get(id) ?? 0) + 1);
  }

  async function selectSession(id: string, automatic = false): Promise<boolean> {
    if (!client || !directory) return false;
    if (!automatic) showWorkspace();
    const targetPane =
      !automatic && focusedPane !== 'main'
        ? leaves(paneLayout).find((pane) => pane.id === focusedPane)
        : null;
    if (!targetPane) {
      focusMainPane();
      acpAgent = null;
      acpThread = null;
      savePaneLayout(
        updatePane(paneLayout, 'main', { agent: null, thread: null, kind: undefined }),
      );
      if (sessionID || newSessionMode || draft !== (viewStates.get(viewKey())?.draft ?? ''))
        saveViewState();
    }
    const current = targetPane ? selection : ++selection;
    const paneSelection = targetPane ? (paneSelections.get(targetPane.id) ?? 0) + 1 : undefined;
    if (targetPane && paneSelection !== undefined) paneSelections.set(targetPane.id, paneSelection);
    const path = directory;
    const valid = () =>
      (targetPane || current === selection) &&
      path === directory &&
      (!targetPane ||
        (paneSelections.get(targetPane.id) === paneSelection &&
          leaves(paneLayout).some((pane) => pane.id === targetPane.id)));
    let info = sessions.find(
      (session) => session.id === id && session.location.directory === path && !session.parentID,
    );
    if (!info)
      try {
        info = await client.session.get({ sessionID: id });
        if (!valid()) return false;
        if (info.location.directory !== path || info.parentID)
          throw new Error('This session does not belong to the selected repository.');
      } catch (cause) {
        if (valid()) error = describe(cause);
        return false;
      }
    const nativeThread: AgentThread = {
      agent: 'opencode',
      sessionId: info.id,
      directory: path,
      title: info.title ?? 'OpenCode thread',
      updated: info.time.updated,
    };
    if (!automatic) showSidebarThread(nativeThread);
    rememberRecentThread(nativeThread);
    markThreadRead(nativeThread);
    if (targetPane) {
      const batch = pendingAgentBatches[targetPane.id];
      if (batch && targetPane.thread?.sessionId !== info.id)
        completeAgentBatch(batch.id, 'Thread changed before comments were sent.');
      savePaneLayout(
        updatePane(paneLayout, targetPane.id, {
          agent: 'opencode',
          thread: nativeThread,
          kind: undefined,
        }),
      );
      focusPaneForTyping(targetPane.id);
      return true;
    }
    cacheCurrentTimeline();
    sessionID = id;
    clearMainPaneEmpty();
    detailsOpen = true;
    selectedSession = info;
    syncSessionChoice(info);
    newSessionMode = null;
    clearDraftAttachments();
    restoreCachedTimeline(path, id);
    followChat = viewStates.get(viewKey())?.follow ?? true;
    running = activeSessionIDs.includes(id);
    activity = 'Thinking';
    activityTool = '';
    pendingPermissions = [];
    pendingForms = [];
    snapshot = { plan: null, questions: null };
    diffError = '';
    ++diffRefresh;
    diffLoading = false;
    sideTab = viewStates.get(viewKey())?.sideTab ?? 'plan';
    selectedFilePath = selectedDiffFile(
      diffs,
      viewStates.get(viewKey())?.selectedFilePath ?? null,
      path,
    );
    if (!automatic) mobileView = 'chat';
    error = '';
    setSetting(`sai-session:${directory}`, id);
    restoringTimelineSelection = current;
    try {
      await refreshSession(id, current);
      if (current === selection) {
        await restoreViewState();
        if (!automatic && window.matchMedia('(max-width: 850px)').matches) chatArea?.focus();
      }
    } finally {
      if (restoringTimelineSelection === current) restoringTimelineSelection = null;
    }
    if (current === selection && chatScroll && chatScroll.scrollHeight <= chatScroll.clientHeight)
      void loadOlderMessages();
    return true;
  }

  function syncSessionChoice(session: SessionInfo) {
    if (session.agent) selectedAgentID = session.agent;
    if (session.model) {
      selectedModelKey = modelKey(session.model);
      selectedVariant = session.model.variant ?? '';
    }
  }

  function newWork() {
    if (!workReady || switching || sending) return;
    if (focusedPane !== 'main' && leaves(paneLayout).some((pane) => pane.id === focusedPane)) {
      choosePaneAgent(focusedPane, 'opencode');
      return;
    }
    focusMainPane();
    acpAgent = null;
    acpThread = null;
    savePaneLayout(updatePane(paneLayout, 'main', { agent: null, thread: null, kind: undefined }));
    clearMainPaneEmpty();
    saveViewState();
    cacheCurrentTimeline();
    ++selection;
    sessionID = null;
    selectedSession = null;
    newSessionMode = 'work';
    selectedAgentID =
      setup?.agents.find((agent) => agent.id !== 'architect')?.id ?? selectedAgentID;
    if (setup?.defaultModel) selectedModelKey = modelKey(setup.defaultModel);
    selectedVariant = setup?.defaultModel?.variant ?? '';
    resetTimeline();
    snapshot = { plan: null, questions: null };
    diffs = [];
    selectedFilePath = null;
    sideTab = 'changes';
    ++diffRefresh;
    diffLoading = false;
    pendingPermissions = [];
    pendingForms = [];
    clearDraftAttachments();
    running = false;
    draft = viewStates.get(viewKey())?.draft ?? '';
    mobileView = 'chat';
    error = '';
  }

  async function newPlan() {
    if (!client || !directory || !planReady || switching || sending) return;
    focusMainPane();
    acpAgent = null;
    acpThread = null;
    savePaneLayout(updatePane(paneLayout, 'main', { agent: null, thread: null, kind: undefined }));
    const path = directory;
    const current = selection;
    try {
      const session = await client.session.create({
        agent: 'architect',
        location: { directory: path },
        metadata: { saiHarness: true },
        title: 'New plan',
      });
      if (current !== selection || path !== directory) return;
      await refreshSessions();
      if (current !== selection || path !== directory) return;
      selectedSession = session;
      await selectSession(session.id, true);
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function chooseAgent(id: string) {
    if (switching) return;
    const previous = selectedAgentID;
    selectedAgentID = id;
    if (!client || !sessionID) return;
    const current = sessionID;
    switching = true;
    try {
      await client.session.switchAgent({ sessionID: current, agent: id });
      const info = await client.session.get({ sessionID: current });
      if (current === sessionID) {
        selectedSession = info;
        syncSessionChoice(info);
      }
      await refreshSessions();
    } catch (cause) {
      if (current === sessionID) selectedAgentID = previous;
      error = describe(cause);
    } finally {
      switching = false;
    }
  }

  async function chooseModel(key: string) {
    if (running || sending || switching) return;
    const previous = selectedModelKey;
    const previousVariant = selectedVariant;
    selectedModelKey = key;
    selectedVariant = '';
    if (!client || !sessionID) return;
    const model = setup?.models.find((item) => modelKey(item) === key);
    if (!model) return;
    const current = sessionID;
    switching = true;
    try {
      await client.session.switchModel({
        sessionID: current,
        model: { id: model.id, providerID: model.providerID },
      });
      const info = await client.session.get({ sessionID: current });
      if (current === sessionID) {
        selectedSession = info;
        syncSessionChoice(info);
      }
      await refreshSessions();
    } catch (cause) {
      if (current === sessionID) {
        selectedModelKey = previous;
        selectedVariant = previousVariant;
      }
      error = describe(cause);
    } finally {
      switching = false;
    }
  }

  async function chooseEffort(variant: string) {
    if (running || sending || switching || !chosenModel) return;
    const previous = selectedVariant;
    selectedVariant = variant;
    if (!client || !sessionID) return;
    const current = sessionID;
    switching = true;
    try {
      await client.session.switchModel({
        sessionID: current,
        model: { id: chosenModel.id, providerID: chosenModel.providerID, variant },
      });
      const info = await client.session.get({ sessionID: current });
      if (current === sessionID) {
        selectedSession = info;
        syncSessionChoice(info);
      }
      await refreshSessions();
    } catch (cause) {
      if (current === sessionID) selectedVariant = previous;
      error = describe(cause);
    } finally {
      switching = false;
    }
  }

  function attachFiles() {
    const current = selection;
    const originalSessionID = sessionID;
    const path = directory;
    const e2ePath =
      import.meta.env.MODE === 'e2e' ? sessionStorage.getItem('sai-e2e-attachment-path') : null;
    if (e2ePath) sessionStorage.removeItem('sai-e2e-attachment-path');
    if (e2ePath) {
      attachedFiles = [...new Set([...attachedFiles, e2ePath])];
      return;
    }
    pathPicker = {
      selection: current,
      sessionID: originalSessionID,
      directory: path,
      initialPath: path || undefined,
    };
  }

  async function selectPickerPaths(paths: string[]) {
    const request = pathPicker;
    pathPicker = null;
    if (!request || !paths.length) return;
    if (
      request.selection !== selection ||
      request.sessionID !== sessionID ||
      request.directory !== directory
    )
      return;
    attachedFiles = [...new Set([...attachedFiles, ...paths])];
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
    const current = selection;
    const currentDirectory = directory;
    const staged = await Promise.all(
      files.map(async (file) => {
        try {
          return { file, path: await stageClipboardFile(file), failure: null };
        } catch (cause) {
          return { file, path: null, failure: describe(cause) };
        }
      }),
    );
    for (const { file, path, failure } of staged) {
      if (failure) {
        error = `Could not paste ${file.name}: ${failure}`;
        continue;
      }
      if (!path) continue;
      if (current !== selection || currentDirectory !== directory) {
        void removeClipboardFile(path);
        continue;
      }
      clipboardAttachmentPaths.add(path);
      clipboardAttachmentNames.set(path, file.name || 'clipboard-image.png');
      attachedFiles = [...attachedFiles, path];
    }
  }

  function startRename(session: { id: string; title?: string }) {
    editingSessionID = session.id;
    editedTitle = session.title ?? '';
    renameSessionDialog.showModal();
  }

  async function saveRename() {
    if (!client || !editingSessionID) return;
    const title = editedTitle.trim();
    if (!title) {
      error = 'Enter a session title.';
      return;
    }
    try {
      await client.session.update({ sessionID: editingSessionID, title });
      const renamedID = editingSessionID;
      nativeThreads = nativeThreads.map((thread) =>
        thread.sessionId === renamedID && thread.directory === directory
          ? { ...thread, title }
          : thread,
      );
      sidebarOpenCodeThreads = sidebarOpenCodeThreads.map((thread) =>
        thread.sessionId === renamedID && thread.directory === directory
          ? { ...thread, title }
          : thread,
      );
      setSetting('sai-recent-native-threads', JSON.stringify(nativeThreads));
      let nextLayout = paneLayout;
      for (const pane of leaves(paneLayout))
        if (pane.agent === 'opencode' && pane.thread?.sessionId === renamedID)
          nextLayout = updatePane(nextLayout, pane.id, { thread: { ...pane.thread, title } });
      if (nextLayout !== paneLayout) savePaneLayout(nextLayout);
      editingSessionID = null;
      renameSessionDialog.close();
      await refreshSessions();
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function removeSession(session: { id: string; title?: string }) {
    if (!client) return;
    const e2eAnswer =
      import.meta.env.MODE === 'e2e' ? sessionStorage.getItem('sai-e2e-delete-answer') : null;
    if (e2eAnswer) sessionStorage.removeItem('sai-e2e-delete-answer');
    const confirmed =
      e2eAnswer === 'Yes'
        ? true
        : e2eAnswer === 'No'
          ? false
          : await confirmInApp(
              'Delete plan session',
              `Delete “${session.title ?? 'Untitled plan'}”? This cannot be undone.`,
              'Delete session',
            );
    if (!confirmed) return;
    try {
      await client.session.remove({ sessionID: session.id });
      const usage = { ...openCodeUsage };
      delete usage[`${directory}:${session.id}`];
      openCodeUsage = usage;
      nativeThreads = nativeThreads.filter((thread) => thread.sessionId !== session.id);
      sidebarOpenCodeThreads = sidebarOpenCodeThreads.filter(
        (thread) => !(thread.sessionId === session.id && thread.directory === directory),
      );
      setSetting('sai-recent-native-threads', JSON.stringify(nativeThreads));
      forgetMissingRecentThreads();
      let nextLayout = paneLayout;
      for (const pane of leaves(paneLayout))
        if (pane.agent === 'opencode' && pane.thread?.sessionId === session.id)
          nextLayout = updatePane(nextLayout, pane.id, { thread: null });
      if (nextLayout !== paneLayout) savePaneLayout(nextLayout);
      if (session.id === sessionID) clearSelectedSession();
      forgetOpenCodeTimeline(directory, session.id);
      await refreshSessions();
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function refreshPrompts(id = sessionID, current = selection) {
    if (!client || !id || !directory) return;
    const source = client;
    const request = ++promptRefresh;
    const valid = () => current === selection && id === sessionID && request === promptRefresh;
    const permissionsTask = (async () => {
      try {
        const requests = await source.permission.list({ sessionID: id });
        if (valid()) pendingPermissions = requests;
      } catch (cause) {
        if (valid()) error = describe(cause);
      }
    })();
    const formsTask = (async () => {
      try {
        const forms = await source.session.form.list({ sessionID: id });
        if (valid()) pendingForms = forms;
      } catch (cause) {
        if (valid()) error = describe(cause);
      }
    })();
    await Promise.all([permissionsTask, formsTask]);
  }

  function resetTimeline() {
    discardLiveText();
    ++timelineRefresh;
    timelineSession = '';
    messages = [];
    olderMessageCursor = null;
    loadingOlder = false;
    followChat = true;
    for (const pending of messageTimers.values()) clearTimeout(pending.timer);
    messageTimers.clear();
    messageGeneration.clear();
  }

  function cacheCurrentTimeline() {
    if (!directory || !sessionID || timelineSession !== sessionID) return;
    rememberOpenCodeTimeline(directory, sessionID, {
      messages,
      cursor: olderMessageCursor,
    });
    openCodeTimelineRevision++;
  }

  function restoreCachedTimeline(path: string, id: string) {
    resetTimeline();
    const cached = recallOpenCodeTimeline(path, id);
    if (!cached) return;
    timelineSession = id;
    messages = cached.messages;
    olderMessageCursor = cached.cursor;
  }

  function scrollToLatest() {
    if (!followChat) return;
    cancelAnimationFrame(followFrame);
    followFrame = requestAnimationFrame(() => {
      if (chatScroll && followChat) chatScroll.scrollTop = chatScroll.scrollHeight;
    });
  }

  const mainSpawnRevision = $derived(
    spawnReceiptsForSource(spawnReceipts, sessionID ? `opencode:${sessionID}` : null, directory)
      .map((receipt) => receipt.updated)
      .join(','),
  );
  $effect(() => {
    if (mainSpawnRevision) void tick().then(scrollToLatest);
  });

  function acceptProjectedMessages(
    incoming: SessionMessageInfo[],
    observed: Record<string, number>,
  ): SessionMessageInfo[] {
    const accepted = incoming.filter(
      (message) => (messageGeneration.get(message.id) ?? 0) === (observed[message.id] ?? 0),
    );
    for (const message of accepted)
      messageGeneration.set(message.id, (messageGeneration.get(message.id) ?? 0) + 1);
    return accepted;
  }

  async function refreshTimeline(id: string, current: number) {
    if (!client) return;
    const source = client;
    const request = ++timelineRefresh;
    const observed = Object.fromEntries(messageGeneration);
    const valid = () => current === selection && id === sessionID && request === timelineRefresh;
    const first = await source.message.list({ sessionID: id, limit: 50, order: 'desc' });
    if (!valid()) return;
    if (timelineSession !== id) {
      timelineSession = id;
      messages = acceptProjectedMessages(first.data, observed).toReversed();
      olderMessageCursor = first.cursor.next ?? null;
      cacheCurrentTimeline();
      await tick();
      scrollToLatest();
      return;
    }
    const known = new Set(messages.map((message) => message.id));
    async function collectGap(
      cursor: string | null,
      incoming: SessionMessageInfo[],
    ): Promise<SessionMessageInfo[]> {
      if (!cursor || !incoming.length || incoming.some((message) => known.has(message.id)))
        return incoming;
      const page = await source.message.list({ sessionID: id, limit: 50, cursor });
      if (!valid()) return incoming;
      const combined = [...incoming, ...page.data];
      if (page.cursor.next === cursor || !page.data.length) return combined;
      return collectGap(page.cursor.next ?? null, combined);
    }
    const incoming = await collectGap(first.cursor.next ?? null, [...first.data]);
    if (!valid()) return;
    messages = mergeMessages(messages, acceptProjectedMessages(incoming, observed));
    cacheCurrentTimeline();
  }

  async function loadOlderMessages() {
    if (
      !client ||
      !sessionID ||
      !olderMessageCursor ||
      loadingOlder ||
      restoringTimelineSelection === selection
    )
      return;
    const id = sessionID;
    const current = selection;
    const cursor = olderMessageCursor;
    const observed = Object.fromEntries(messageGeneration);
    const height = chatScroll?.scrollHeight ?? 0;
    const top = chatScroll?.scrollTop ?? 0;
    const underfilled = !!chatScroll && height <= chatScroll.clientHeight;
    let loaded = false;
    loadingOlder = true;
    try {
      const page = await client.message.list({ sessionID: id, limit: 50, cursor });
      if (current !== selection || id !== sessionID) return;
      messages = mergeMessages(messages, acceptProjectedMessages(page.data, observed));
      olderMessageCursor = page.cursor.next === cursor ? null : (page.cursor.next ?? null);
      cacheCurrentTimeline();
      if (!underfilled) followChat = false;
      await tick();
      if (chatScroll)
        chatScroll.scrollTop =
          underfilled && followChat
            ? chatScroll.scrollHeight
            : top + chatScroll.scrollHeight - height;
      loaded = true;
    } catch (cause) {
      error = describe(cause);
    } finally {
      loadingOlder = false;
      if (
        loaded &&
        chatScroll &&
        chatScroll.scrollHeight <= chatScroll.clientHeight &&
        olderMessageCursor
      )
        void loadOlderMessages();
    }
  }

  async function refreshMessage(
    id: string,
    messageID: string,
    settled: boolean,
    generation: number,
  ) {
    if (!client) return;
    const current = selection;
    try {
      const message = await client.session.message.get({ sessionID: id, messageID });
      if (
        current !== selection ||
        id !== sessionID ||
        messageGeneration.get(messageID) !== generation
      )
        return;
      messages = mergeMessages(messages, [message]);
      cacheCurrentTimeline();
      if (settled) {
        const remaining = { ...liveText };
        delete remaining[messageID];
        liveText = remaining;
      }
    } catch {
      // The projection may not exist yet; the next durable event or resync will load it.
    }
  }

  function scheduleMessageRefresh(id: string, messageID: string, settled = false) {
    const previous = messageTimers.get(messageID);
    if (previous) clearTimeout(previous.timer);
    const generation = (messageGeneration.get(messageID) ?? 0) + 1;
    messageGeneration.set(messageID, generation);
    const timer = setTimeout(() => {
      messageTimers.delete(messageID);
      void refreshMessage(id, messageID, settled || !!previous?.settled, generation);
    }, 80);
    messageTimers.set(messageID, { timer, settled: settled || !!previous?.settled });
  }

  async function refreshDiff(id = sessionID, current = selection, quiet = false) {
    if (acpAgent || !directory) return;
    const path = directory;
    const generation = ++diffRefresh;
    try {
      const revision = await invoke<string>('working_tree_revision', { path });
      if (generation !== diffRefresh || path !== directory) return;
      if (quiet && diffRevisionPath === path && diffRevision === revision) return;
      if (!quiet) diffLoading = true;
      const next = await invoke<WorkingDiffInfo[]>('working_tree_diff', { path });
      if (
        acpAgent ||
        generation !== diffRefresh ||
        current !== selection ||
        id !== sessionID ||
        path !== directory
      )
        return;
      diffRevisionPath = path;
      diffRevision = revision;
      diffs = next;
      mainDiffEvidenceUpdated = Date.now();
      diffError = '';
      selectedFilePath = selectedDiffFile(next, selectedFilePath, path);
    } catch (cause) {
      if (!acpAgent && generation === diffRefresh && current === selection && id === sessionID)
        diffError = describe(cause);
    } finally {
      if (generation === diffRefresh) diffLoading = false;
    }
  }

  function selectDiffPath(path: string) {
    saveViewState();
    detailsOpen = true;
    sideTab = 'changes';
    mobileView = 'details';
    void focusDiffDetails();
    const key = repoPath(path, directory);
    selectedFilePath =
      (key ? diffs.find((file) => repoPath(file.file, directory) === key)?.file : undefined) ??
      path;
  }

  async function focusDiffDetails() {
    await tick();
    restoreSideScroll(viewStates.get(viewKey())?.sideScroll.changes);
    if (window.matchMedia('(max-width: 850px)').matches) detailsArea?.focus();
  }

  async function refreshSession(id = sessionID, current = selection) {
    if (!client || !id || !directory) return;
    const source = client;
    const path = directory;
    void refreshDiff(id, current, true);
    const [history, plan] = await Promise.allSettled([
      refreshTimeline(id, current),
      setup?.rpc.state === 'ready'
        ? getPlan(source, path, id)
        : Promise.resolve({ plan: null, questions: null } as PlanSnapshot),
      refreshPrompts(id, current),
    ]);
    if (current !== selection || id !== sessionID) return;
    if (history.status === 'rejected') error = describe(history.reason);
    if (plan.status === 'fulfilled') snapshot = plan.value;
    else error = describe(plan.reason);
  }

  async function refreshSidePanels() {
    if (!client || !sessionID || !directory) return;
    const source = client;
    const id = sessionID;
    const path = directory;
    const current = selection;
    const [plan] = await Promise.allSettled([
      setup?.rpc.state === 'ready'
        ? getPlan(source, path, id)
        : Promise.resolve({ plan: null, questions: null } as PlanSnapshot),
      refreshPrompts(id, current),
      refreshDiff(id, current),
    ]);
    if (current !== selection || id !== sessionID) return;
    if (plan.status === 'fulfilled') snapshot = plan.value;
    else error = describe(plan.reason);
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refreshSidePanels(), 120);
  }

  function scheduleDiffRefresh() {
    clearTimeout(diffTimer);
    diffTimer = setTimeout(() => void refreshDiff(), 120);
  }

  function applyTextDelta(messageID: string, ordinal: number, delta: string) {
    const parts = pendingTextDeltas[messageID] ?? (pendingTextDeltas[messageID] = {});
    const chunks = parts[ordinal] ?? (parts[ordinal] = []);
    chunks.push(delta);
    if (!textTimer) textTimer = setTimeout(flushTextDeltas, 50);
  }

  function discardLiveText() {
    clearTimeout(textTimer);
    textTimer = undefined;
    pendingTextDeltas = {};
    liveText = {};
  }

  function flushTextDeltas() {
    clearTimeout(textTimer);
    textTimer = undefined;
    if (!Object.keys(pendingTextDeltas).length) return;
    const next = { ...liveText };
    for (const [messageID, updates] of Object.entries(pendingTextDeltas)) {
      const existing = messages.find((message) => message.id === messageID);
      const parts = { ...next[messageID] };
      for (const [index, chunks] of Object.entries(updates)) {
        const ordinal = Number(index);
        const part = existing?.type === 'assistant' ? existing.content[ordinal] : undefined;
        const base = parts[ordinal] ?? (part?.type === 'text' ? part.text : '');
        parts[ordinal] = base + chunks.join('');
      }
      next[messageID] = parts;
    }
    pendingTextDeltas = {};
    liveText = next;
  }

  async function reconcileExecution(id: string, current: number) {
    await refreshTimeline(id, current);
    if (id === sessionID && !running) discardLiveText();
  }

  async function watchEvents(source: OpenCodeClient, signal: AbortSignal) {
    let failed = false;
    try {
      for await (const event of source.event.subscribe({ signal })) {
        if (signal.aborted) return;
        if (event.type === 'filesystem.changed' && event.location?.directory === directory)
          scheduleDiffRefresh();
        if (event.type === 'server.connected') {
          void resync().catch((cause) => {
            error = describe(cause);
          });
          void reconcileOpenCodeSpawnReceipts();
        }
        if (
          [
            'session.created',
            'session.renamed',
            'session.deleted',
            'session.agent.selected',
            'session.execution.started',
            'session.execution.succeeded',
            'session.execution.failed',
            'session.execution.interrupted',
          ].includes(event.type)
        ) {
          void refreshSessions().catch((cause) => {
            error = describe(cause);
          });
          scheduleSidebarInventoryRefresh();
        }
        const eventSession =
          'data' in event && 'sessionID' in event.data ? event.data.sessionID : undefined;
        if (typeof eventSession === 'string' && event.type === 'session.execution.succeeded') {
          const thread = [...sidebarOpenCodeThreads, ...nativeThreads].find(
            (item) =>
              item.sessionId === eventSession &&
              (!event.location?.directory || item.directory === event.location.directory),
          );
          const path =
            event.location?.directory ??
            thread?.directory ??
            (eventSession === sessionID ? directory : '');
          if (path) void runCompletedChecks(path, `opencode:${eventSession}`, event.id);
        }
        if (typeof eventSession === 'string' && event.type === 'session.text.delta') {
          for (const receipt of spawnReceipts.filter(
            (item) => item.targetId === `opencode:${eventSession}` && !receiptIsSettled(item.state),
          ))
            updateSpawnReceipt(receipt.receiptId, {
              result: `${receipt.result ?? ''}${event.data.delta}`.slice(-16_000),
              activity: 'Writing response…',
            });
        }
        if (typeof eventSession === 'string' && event.type === 'session.execution.started')
          for (const receipt of spawnReceipts.filter(
            (item) => item.targetId === `opencode:${eventSession}` && !receiptIsSettled(item.state),
          ))
            updateSpawnReceipt(receipt.receiptId, { state: 'working' });
        if (typeof eventSession === 'string' && event.type === 'session.tool.input.started')
          for (const receipt of spawnReceipts.filter(
            (item) => item.targetId === `opencode:${eventSession}` && !receiptIsSettled(item.state),
          ))
            updateSpawnReceipt(receipt.receiptId, { activity: `Using ${event.data.name}` });
        if (
          eventSession &&
          (event.type === 'session.execution.started' ||
            event.type === 'session.execution.succeeded' ||
            event.type === 'session.execution.failed' ||
            event.type === 'session.execution.interrupted')
        ) {
          ++nativeActivityGeneration;
          const matchingThreads = sidebarOpenCodeThreads.filter(
            (item) =>
              item.sessionId === eventSession &&
              (!event.location?.directory || item.directory === event.location.directory),
          );
          for (const thread of matchingThreads) {
            updateAgentThreadStatus(
              thread,
              event.type === 'session.execution.started'
                ? 'working'
                : event.type === 'session.execution.failed'
                  ? 'failed'
                  : 'done',
              event.type !== 'session.execution.interrupted',
            );
            if (event.type === 'session.execution.succeeded')
              recordTurnOutcome(thread, event.id, event.created);
          }
          if (event.type === 'session.execution.succeeded' && !matchingThreads.length) {
            const eventId = event.id;
            const completedAt = event.created;
            void source.session
              .get({ sessionID: eventSession })
              .then((session) => {
                if (signal.aborted || source !== client || session.parentID) return;
                const path = session.location.directory;
                if (!inboxLocations(projectCatalog).some((location) => location.directory === path))
                  return;
                recordTurnOutcome(
                  {
                    agent: 'opencode',
                    sessionId: eventSession,
                    directory: path,
                    title: session.title ?? 'OpenCode session',
                    updated: completedAt,
                  },
                  eventId,
                  completedAt,
                );
                return undefined;
              })
              .catch(() => undefined);
          }
        }
        if (
          eventSession === sessionID ||
          (event.type === 'rpc.planreview.changed' && event.location?.directory === directory)
        ) {
          const eventType: string = event.type;
          if (
            eventType === 'session.message.content.updated' &&
            'data' in event &&
            'messageID' in event.data &&
            typeof event.data.messageID === 'string' &&
            sessionID
          )
            scheduleMessageRefresh(sessionID, event.data.messageID);
          if (event.type === 'session.text.delta') {
            activity = 'Writing response';
            applyTextDelta(event.data.assistantMessageID, event.data.ordinal, event.data.delta);
            continue;
          }
          if (event.type === 'session.text.ended') {
            flushTextDeltas();
            const parts = liveText[event.data.assistantMessageID] ?? {};
            liveText[event.data.assistantMessageID] = {
              ...parts,
              [event.data.ordinal]: event.data.text,
            };
            scheduleMessageRefresh(event.data.sessionID, event.data.assistantMessageID, true);
          }
          if (
            'data' in event &&
            'assistantMessageID' in event.data &&
            typeof event.data.assistantMessageID === 'string' &&
            event.type !== 'session.text.ended'
          )
            scheduleMessageRefresh(event.data.sessionID, event.data.assistantMessageID);
          if (event.type === 'session.execution.started') {
            running = true;
            activity = 'Thinking';
            activityTool = '';
          }
          if (event.type === 'session.reasoning.started') activity = 'Thinking';
          if (event.type === 'session.text.started') activity = 'Writing response';
          if (event.type === 'session.tool.input.started') {
            activityTool = event.data.name;
            activity = `Preparing ${activityTool}`;
          }
          if (event.type === 'session.tool.called')
            activity = activityTool ? `Using ${activityTool}` : 'Using a tool';
          if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
            activity = 'Thinking';
            activityTool = '';
            scheduleDiffRefresh();
          }
          if (event.type === 'session.compaction.started') activity = 'Organizing context';
          if (event.type === 'session.retry.scheduled') activity = 'Retrying';
          if (
            [
              'session.execution.succeeded',
              'session.execution.failed',
              'session.execution.interrupted',
            ].includes(event.type)
          )
            running = false;
          if (
            [
              'session.execution.started',
              'session.execution.succeeded',
              'session.execution.failed',
              'session.execution.interrupted',
            ].includes(event.type) &&
            sessionID
          )
            void reconcileExecution(sessionID, selection).catch((cause) => {
              error = describe(cause);
            });
          if (
            event.type === 'rpc.planreview.changed' ||
            [
              'session.execution.succeeded',
              'session.execution.failed',
              'session.execution.interrupted',
            ].includes(event.type)
          )
            scheduleRefresh();
        }
        if (
          event.type === 'permission.asked' ||
          event.type === 'permission.replied' ||
          event.type === 'form.created' ||
          event.type === 'form.replied' ||
          event.type === 'form.cancelled'
        ) {
          if (event.type === 'permission.asked') {
            const thread = sidebarOpenCodeThreads.find(
              (item) =>
                item.sessionId === event.data.sessionID &&
                (!event.location?.directory || item.directory === event.location.directory),
            );
            if (thread) updateAgentThreadStatus(thread, 'waiting');
          }
          if (event.type === 'form.created') {
            const thread = sidebarOpenCodeThreads.find(
              (item) =>
                item.sessionId === event.data.form.sessionID &&
                (!event.location?.directory || item.directory === event.location.directory),
            );
            if (thread) updateAgentThreadStatus(thread, 'waiting');
          }
          if (event.type === 'permission.asked' && !openCodeRequestTime(event.data.id))
            inboxTime(`opencode:permission:${event.data.id}`, event.created);
          if (event.type === 'form.created' && !openCodeRequestTime(event.data.form.id))
            inboxTime(`opencode:form:${event.data.form.id}`, event.created);
          if (event.type === 'permission.replied')
            forgetInboxTime(`opencode:permission:${event.data.requestID}`);
          if (event.type === 'form.replied' || event.type === 'form.cancelled')
            forgetInboxTime(`opencode:form:${event.data.id}`);
          scheduleRefresh();
          scheduleInboxRefresh();
          void reconcileNativeActivity();
        }
      }
    } catch (cause) {
      failed = true;
      // A new subscription reloads missed state after the live stream fails.
      if (!signal.aborted)
        recordDiagnostic('opencode_event_stream_failed', {
          errorName: cause instanceof Error ? cause.name : typeof cause,
          message: describe(cause).slice(0, 500),
        });
    }
    if (!signal.aborted) {
      if (!failed) recordDiagnostic('opencode_event_stream_ended');
      ++nativeActivityGeneration;
      nativeActivityReady = false;
      runtimeState = 'starting';
      recoveryTimer = setTimeout(() => void recoverRuntime(), 1500);
    }
  }

  function fixOpenCodeToolFailure(
    key: string,
    name: string,
    input: unknown,
    reason: string,
    output: string,
  ) {
    const request = toolFailurePrompt(name, input, reason, output);
    draft = prepareToolFailureDraft(draft, request, failureRequests.get(key));
    failureRequests.set(key, request);
    void tick().then(() => mainPrompt?.focus());
  }

  async function send() {
    await pendingPaste;
    const command = draft.trim().toLowerCase();
    if (!attachedFiles.length && (command === '/model' || command === '/effort')) {
      if (!inputReady || running || sending || switching) return;
      draft = '';
      composerPickerOpen = command.slice(1) as 'model' | 'effort';
      return;
    }
    if (!client || !canSend) return;
    const source = client;
    let current = selection;
    const path = directory;
    const text = draft.trim();
    let id = sessionID;
    const requestedModel = chosenModel
      ? {
          id: chosenModel.id,
          providerID: chosenModel.providerID,
          variant: selectedVariant || undefined,
        }
      : undefined;
    const requestedAgent = selectedAgentID || undefined;
    const queueTurn = running;
    const sourceSkills = skills;
    let shipIssue: ShipItIssue | null;
    try {
      shipIssue = await beginShipItRun(path, text, promptSkill(sourceSkills, text)?.name ?? null);
    } catch (cause) {
      error = describe(cause);
      return;
    }
    if (current !== selection || path !== directory) return;
    const files = [...attachedFiles];
    let accepted = false;
    for (const file of files) {
      if (pickedImageText.has(file)) inFlightCaptures.add(file);
    }
    draft = '';
    viewStates.delete(viewKey());
    attachedFiles = [];
    sending = true;
    error = '';
    try {
      if (!id) {
        const session = await source.session.create({
          agent: requestedAgent,
          model: requestedModel,
          location: { directory: path },
          metadata: { saiHarness: true },
          title: text ? (text.length > 60 ? `${text.slice(0, 57)}…` : text) : 'New work',
        });
        id = session.id;
        if (current === selection && path === directory) {
          migrateDiffComments(diffCommentKey('main'), `${path}\0main\0opencode:${id}`);
          await refreshSessions();
          if (current === selection && path === directory) {
            selectedSession = session;
            await selectSession(id, true);
            if (sessionID === id && path === directory) current = selection;
          }
        }
      } else if (
        text &&
        (currentSession?.title === 'New plan' || currentSession?.title === 'New work')
      ) {
        await source.session.update({
          sessionID: id,
          title: text.length > 60 ? `${text.slice(0, 57)}…` : text,
        });
        if (current === selection && path === directory) await refreshSessions();
      }
      if (current === selection && path === directory) {
        running = true;
        activity = 'Thinking';
        activityTool = '';
      }
      const targetId = id;
      const promptRequest = runSerialOpenCodeTurn(targetId, async () => {
        const target = await source.session.get({ sessionID: targetId });
        if (target.location.directory !== path)
          throw new Error('Target session moved to another worktree.');
        const implementingModel = target.model
          ? `${target.model.providerID}:${target.model.id}`
          : undefined;
        if (shipIssue) {
          recordShipItOwner(path, `opencode:${targetId}`);
          await adoptDirectShipRun(shipIssue, path, `opencode:${targetId}`, implementingModel);
        }
        await invoke('record_turn_snapshot', { path, thread: `opencode:${targetId}` });
        const tracking = await beginImplementationTurn(
          path,
          implementingModel,
          `opencode:${targetId}`,
        );
        let response;
        try {
          response = await source.session.prompt({
            sessionID: targetId,
            text: resolveSkillPrompt(sourceSkills, text, implementingModel),
            skills: promptSkill(sourceSkills, text)?.id
              ? [{ id: promptSkill(sourceSkills, text)!.id! }]
              : undefined,
            delivery: queueTurn ? 'steer' : undefined,
            files: files.map((filePath) => ({
              uri: fileUri(filePath),
              name: clipboardAttachmentNames.get(filePath) ?? filePath.split(/[\\/]/).at(-1),
            })),
          });
        } catch (cause) {
          await recordImplementationModel(path, implementingModel, tracking);
          throw cause;
        }
        void source.session
          .wait({ sessionID: targetId })
          .then(
            () => recordImplementationModel(path, implementingModel, tracking),
            () => recordImplementationModel(path, implementingModel, tracking),
          )
          .catch((cause) => {
            abandonImplementationTurn(path, tracking);
            error = `Could not track implementation model: ${describe(cause)}`;
          });
        return response;
      });
      sending = false;
      const response = await promptRequest;
      const captureIds = files.flatMap((file) => {
        const captureId = pickedCaptureIds.get(file);
        return captureId ? [captureId] : [];
      });
      if (captureIds.length) assignReviewCaptures(captureIds, `opencode:${targetId}`, response.id);
      accepted = true;
      const staged = files.filter((file) => clipboardAttachmentPaths.delete(file));
      staged.forEach((file) => clipboardAttachmentNames.delete(file));
      if (staged.length)
        void client.session
          .wait({ sessionID: id })
          .catch(() => {})
          .finally(() => staged.forEach((file) => void removeClipboardFile(file)));
      for (const file of files) {
        if (!pickedImageText.delete(file)) continue;
        pickedCaptureIds.delete(file);
        void invoke('browser_remove_capture', { path: file });
      }
      if (current === selection && path === directory) await refreshSession(id);
    } catch (cause) {
      if (current === selection && path === directory) {
        if (!accepted) {
          draft = [text, draft.trim()].filter(Boolean).join('\n\n');
          attachedFiles = [...files, ...attachedFiles.filter((file) => !files.includes(file))];
        }
        if (!queueTurn) running = false;
        error = describe(cause);
      } else {
        for (const file of files) {
          if (clipboardAttachmentPaths.delete(file)) void removeClipboardFile(file);
          clipboardAttachmentNames.delete(file);
          if (!pickedImageText.delete(file)) continue;
          pickedCaptureIds.delete(file);
          void invoke('browser_remove_capture', { path: file });
        }
      }
    } finally {
      for (const file of files) inFlightCaptures.delete(file);
      sending = false;
    }
  }

  async function stop() {
    if (!client || !sessionID || !running) return;
    const id = sessionID;
    try {
      await client.session.interrupt({ sessionID: id });
      if (id === sessionID) running = false;
      await refreshTimeline(id, selection);
    } catch (cause) {
      error = `Could not stop the agent: ${describe(cause)}`;
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
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'b'
    ) {
      event.preventDefault();
      if (!event.repeat && !document.querySelector('dialog[open]')) toggleSidebar();
      return;
    }
    if (
      event.metaKey &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      event.key.toLowerCase() === 'j' &&
      !event.repeat &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      openSideChat();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ',') {
      event.preventDefault();
      if (!event.repeat) void openSettings();
      return;
    }
    if (
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key === 'Tab' &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      if (!recentCycleKeys) {
        recentCycleKeys = availableRecentKeys();
        recentCycleIndex = nextRecentIndex(
          recentCycleKeys,
          focusedThreadKey(),
          event.shiftKey ? -1 : 1,
        );
      } else {
        recentCycleIndex = nextRecentIndex(
          recentCycleKeys,
          recentCycleKeys[recentCycleIndex] ?? null,
          event.shiftKey ? -1 : 1,
        );
      }
      const key = recentCycleKeys[recentCycleIndex];
      if (key) void jumpToRecentThread(key);
      return;
    }
    if (
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      /^[1-9]$/.test(event.key) &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      recentCycleKeys = null;
      const key = availableRecentKeys()[Number(event.key) - 1];
      if (key) void jumpToRecentThread(key);
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'k' &&
      !event.repeat
    ) {
      event.preventDefault();
      openCommandPalette();
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      event.shiftKey &&
      event.key.toLowerCase() === 'w'
    ) {
      event.preventDefault();
      if (!event.repeat && !document.querySelector('dialog[open]')) closeCurrentWorktree();
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'n'
    ) {
      event.preventDefault();
      const repository = directory ? coordinationProject(directory) : null;
      if (repository && !event.repeat && !document.querySelector('dialog[open]'))
        paletteWorktreeRequest = { id: crypto.randomUUID(), path: repository, fromPalette: false };
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'w'
    ) {
      event.preventDefault();
      if (!event.repeat && !document.querySelector('dialog[open]')) closeCurrentPane();
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 't' &&
      !event.repeat &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      splitFocusedPane('row', 'terminal');
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      event.key.toLowerCase() === 'd' &&
      !event.repeat &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      splitFocusedPane(event.shiftKey ? 'column' : 'row');
      return;
    }
    if (
      !event.repeat &&
      !document.querySelector('dialog[open]') &&
      ((event.key === 'F6' && !event.metaKey && !event.ctrlKey && !event.altKey) ||
        ((event.metaKey || event.ctrlKey) &&
          event.altKey &&
          !event.shiftKey &&
          ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)))
    ) {
      const paneIDs = [
        ...leaves(paneLayout).map((leaf) => leaf.id),
        ...(sideChat ? [sideChat.id] : []),
      ];
      if (paneIDs.length < 2) return;
      event.preventDefault();
      const next =
        event.key === 'F6'
          ? paneIDs[
              (paneIDs.indexOf(focusedPane) + (event.shiftKey ? -1 : 1) + paneIDs.length) %
                paneIDs.length
            ]
          : adjacentPaneId(
              [...document.querySelectorAll<HTMLElement>('[data-pane-id]')].map((element) => {
                const { left, right, top, bottom } = element.getBoundingClientRect();
                return { id: element.dataset.paneId ?? '', left, right, top, bottom };
              }),
              focusedPane,
              event.key.slice(5).toLowerCase() as 'left' | 'right' | 'up' | 'down',
            );
      if (next) {
        ++recentJumpGeneration;
        focusPaneForTyping(next);
      }
      return;
    }
    if (
      event.key === 'Escape' &&
      !event.defaultPrevented &&
      !event.repeat &&
      !event.isComposing &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      focusedPane !== 'main' &&
      focusedLeaf?.agent !== 'opencode' &&
      document.querySelector('.pane-leaf.focused [data-detail-tab="ship"].active') &&
      (!mobileLayout || mobileView === 'details') &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      changesPanes = changesPanes.filter((id) => id !== focusedPane);
      return;
    }
    if (
      event.key === 'Escape' &&
      !event.defaultPrevented &&
      !event.repeat &&
      !event.isComposing &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      focusedPane === 'main' &&
      detailsOpen &&
      activeSideTab === 'ship' &&
      (!mobileLayout || mobileView === 'details') &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      closeShipRuns();
      return;
    }
    if (
      event.key === 'Escape' &&
      !event.defaultPrevented &&
      !event.repeat &&
      !event.isComposing &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !acpAgent &&
      focusedPane === 'main' &&
      running &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      void stop();
      return;
    }
    if (
      event.repeat ||
      event.key.toLowerCase() !== 'l' ||
      !(event.metaKey || event.ctrlKey) ||
      event.altKey ||
      event.shiftKey ||
      document.querySelector('dialog[open]')
    )
      return;
    event.preventDefault();
    void toggleChanges();
  }

  function toggleSidebar() {
    if (window.matchMedia('(max-width: 850px)').matches) {
      if (mobileView === 'sessions' && sidebarVisible) {
        void showMobileView('chat');
      } else {
        void showMobileView('sessions');
      }
      return;
    }
    sidebarVisible = !sidebarVisible;
    if (!sidebarVisible && sidebarElement.contains(document.activeElement))
      void tick().then(() => sidebarToggleElement.focus());
  }

  function showTaskOverview() {
    workspaceView = 'overview';
    mobileView = 'chat';
    setSetting('sai-workspace-view', workspaceView);
  }

  function showWorkspace() {
    workspaceView = 'workspace';
    setSetting('sai-workspace-view', workspaceView);
  }

  async function openTaskOverviewTarget(path: string, key: string | null) {
    showWorkspace();
    if (key && (await jumpToRecentThread(key))) return;
    if (path !== directory) await loadProject(path);
    focusPaneForTyping('main');
  }

  async function openTaskOverviewCheck(check: PostTurnCheck) {
    showWorkspace();
    await openReviewCheck(check);
  }

  function keyupWorkspace(event: KeyboardEvent) {
    if (event.key === 'Control') recentCycleKeys = null;
  }

  function focusWorkspace() {
    for (const pane of leaves(paneLayout)) if (pane.thread) markThreadRead(pane.thread);
    if (acpAgent && agentChangesOpen && activeSideTab === 'changes') void refreshAgentDiff();
    else if (!acpAgent && detailsOpen && activeSideTab === 'changes') void refreshDiff();
  }

  function describe(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    if (typeof cause === 'object' && cause && 'message' in cause) return String(cause.message);
    return String(cause);
  }
  function assistantText(message: SessionMessageInfo): string {
    return message.type === 'assistant'
      ? message.content
          .map((part, ordinal) =>
            part.type === 'text' ? (liveText[message.id]?.[ordinal] ?? part.text) : '',
          )
          .filter(Boolean)
          .join('\n')
      : '';
  }
</script>

<svelte:head><title>Sail · Plan workspace</title></svelte:head>
<svelte:window
  onkeydown={keydownWorkspace}
  onkeyup={(event) => {
    keyupWorkspace(event);
    copyCompletedSelection();
  }}
  onpointerup={copyCompletedSelection}
  onblur={() => (recentCycleKeys = null)}
  onfocus={focusWorkspace}
  onfocusin={cancelPendingPromptFocus}
/>
<div
  class="app-shell"
  data-mobile-view={mobileView}
  data-sidebar-visible={sidebarVisible}
  data-details-visible={mainDetailsVisible || shipFallbackVisible}
  style={`--topbar-height: ${topbarHeight}px; --details-width: ${visibleDetailsWidth}px`}
  bind:this={appShellElement}
>
  <aside
    id="project-sidebar"
    class="sidebar"
    aria-label="Projects"
    tabindex="-1"
    bind:this={sidebarElement}
  >
    <div class="brand"><span class="brand-mark">S.</span><span>Sail</span></div>
    <div class="sidebar-content">
      <ProjectSidebar
        catalog={projectCatalog}
        {directory}
        disabled={runtimeState !== 'connected' &&
          !agentAvailability.some((agent) => agent.available)}
        agents={agentAvailability}
        threads={sidebarThreads}
        attention={threadAttention}
        openCodeOutcomes={sidebarOpenCodeOutcomes}
        spawnReceipts={visibleSpawnReceipts}
        {acpActivityReady}
        {nativeActivityReady}
        {nativeUnavailableDirectories}
        selectedThread={focusedThreadKey()}
        openCodeAvailable={runtimeState === 'connected'}
        worktreeDialogRequest={paletteWorktreeRequest}
        {worktreeCreations}
        {worktreeDeletions}
        onretryworktree={retryWorktreeCreation}
        ondismissworktree={dismissWorktreeCreation}
        onworktreecancelled={(repository) =>
          reopenCommandPalette({ kind: 'worktrees', repository })}
        onselect={(path) => {
          showWorkspace();
          if (path !== directory) void loadProject(path);
        }}
        onselectdefault={(path) => void selectDefaultWorktree(path)}
        onselectthread={(key) => void jumpToRecentThread(key)}
        onremovethread={removeSidebarThread}
        onaddrepository={(groupID) => void chooseProject(groupID)}
        onaddgroup={addProjectGroup}
        onrenamegroup={renameProjectGroup}
        ondeletegroup={deleteProjectGroup}
        ontogglegroup={toggleProjectGroup}
        ontogglerepository={toggleProjectRepository}
        onmoverepository={moveProjectRepository}
        onremoverepository={removeProjectRepository}
        oncreateworktree={createProjectWorktree}
        ondeleteworktree={deleteProjectWorktree}
        oncreatepullrequest={createProjectPullRequest}
        onsendchecklog={sendFailedCheckLog}
      />
    </div>
    <div class="sidebar-footer">
      <button
        class="settings-launch"
        aria-label="Settings"
        title="Settings (⌘,)"
        onclick={openSettings}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          ><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" /><path
            d="m19.4 13.4 1.1.9-1.7 3-1.4-.4a8 8 0 0 1-1.8 1.1l-.3 1.5h-3.5l-.3-1.5a8 8 0 0 1-1.8-1.1l-1.4.4-1.7-3 1.1-.9a8 8 0 0 1 0-2.8l-1.1-.9 1.7-3 1.4.4a8 8 0 0 1 1.8-1.1l.3-1.5h3.5l.3 1.5a8 8 0 0 1 1.8 1.1l1.4-.4 1.7 3-1.1.9a8 8 0 0 1 0 2.8Z"
          /></svg
        >
      </button>
      <span class="sidebar-runtime" role="status"
        ><span class:connected={runtimeState === 'connected'} class="status-dot" aria-hidden="true"
        ></span><span>OpenCode {runtimeState}</span></span
      >
    </div>
  </aside>
  <div class="main-area">
    <header class="topbar" bind:this={topbarElement}>
      <button
        class="sidebar-toggle"
        bind:this={sidebarToggleElement}
        aria-label="Toggle project sidebar"
        aria-controls="project-sidebar"
        aria-expanded={sidebarVisible && (!mobileLayout || mobileView === 'sessions')}
        title="Toggle project sidebar (⌘B / Ctrl+B)"
        onclick={toggleSidebar}>☰</button
      >
      <nav class="mobile-switcher" aria-label="Workspace panels">
        <button aria-pressed={mobileView === 'sessions'} onclick={() => showMobileView('sessions')}
          >Projects</button
        >
        <button aria-pressed={mobileView === 'chat'} onclick={() => showMobileView('chat')}
          >Chat</button
        >
        <button aria-pressed={mobileView === 'details'} onclick={() => showMobileView('details')}
          >Details</button
        >
      </nav>
      <div class="breadcrumb">
        {#if workspaceView === 'overview'}<strong>All worktrees</strong><span class="slash">/</span
          ><strong>Task overview</strong>{:else}<button
            class="breadcrumb-project"
            onclick={() => chooseProject()}
            disabled={runtimeState !== 'connected' &&
              !agentAvailability.some((agent) => agent.available)}
            >{directory ? directory.split('/').filter(Boolean).at(-1) : 'Workspace'} ⌄</button
          ><span class="slash">/</span><strong>{focusedConversationTitle}</strong>{/if}
      </div>
      <div class="topbar-actions">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={workspaceView === 'overview'}
          onclick={() => (workspaceView === 'overview' ? showWorkspace() : showTaskOverview())}
          >{workspaceView === 'overview' ? 'Workspace' : 'Overview'}</Button
        >
        <Button variant="ghost" size="sm" aria-label="Pending requests" onclick={openInbox}
          >Inbox ({inboxItems.filter((item) => !isInboxOutcome(item) || !item.read).length})</Button
        >
        {#if directory}<Button
            variant="ghost"
            size="sm"
            onclick={newPlan}
            disabled={!planReady || switching || sending}
            aria-label="New plan"
            title="Start an Architect plan">New plan</Button
          >{/if}
        {#if directory}<div class="agent-launches">
            {#each agentAvailability as agent (agent.id)}
              <Button
                size="sm"
                variant="ghost"
                disabled={!agent.available}
                title={agent.reason ?? `New ${agent.name} thread`}
                onclick={() => openAgent(agent.id)}
                >+ <HarnessIcon agent={agent.id} /> {agent.name}</Button
              >
            {/each}
            <Button
              size="sm"
              variant="ghost"
              onclick={newWork}
              disabled={!workReady || switching || sending}
              title="New OpenCode thread">+ <HarnessIcon agent="opencode" /> OpenCode</Button
            >
          </div>{/if}
        {#if directory}<button
            class="agent-menu-launch"
            onclick={() =>
              reopenCommandPalette({
                kind: 'agents',
                repository: selectedRepository(projectCatalog, directory) ?? directory,
                directory,
              })}>Agents</button
          >{/if}
        {#if actionAgentThread}<Button
            variant="ghost"
            size="sm"
            aria-label="Remove thread"
            onclick={() => {
              if (actionAgentThread) removeAgentThread(actionAgentThread);
            }}>Remove thread</Button
          >{:else if actionOpenCodeSession}<Button
            variant="ghost"
            size="sm"
            onclick={() => actionOpenCodeSession && startRename(actionOpenCodeSession)}
            >Rename</Button
          ><Button
            variant="ghost"
            size="sm"
            onclick={() => actionOpenCodeSession && void removeSession(actionOpenCodeSession)}
            >Delete</Button
          >{/if}
        {#if !acpAgent && sessionID && openCodeUsage[`${directory}:${sessionID}`] !== undefined}<span
            class="session-usage">Context {openCodeUsage[`${directory}:${sessionID}`]}%</span
          >{/if}
        {#if directory}<Button
            variant="ghost"
            size="sm"
            aria-pressed={!browserAccessDisabled}
            onclick={toggleAgentBrowserAccess}
            title="Toggle agent browser access for this project"
            >Agent browser {browserAccessDisabled ? 'off' : 'on'}</Button
          >{/if}
        {#if selectedWorktreeConfig?.run}<Button
            variant="ghost"
            size="sm"
            onclick={() => splitFocusedPane('row', 'terminal', selectedWorktreeConfig?.run)}
            >Run project</Button
          >{/if}
        {#if agentTerminals.length}<Button
            variant="ghost"
            size="sm"
            onclick={() => agentTerminalsDialog.showModal()}
            >Agent terminals ({agentTerminals.length})</Button
          >{/if}
        {#if directory && focusedSnapshotThread()}<Button
            variant="ghost"
            size="sm"
            onclick={() => void openSnapshots()}>Restore</Button
          >{/if}
        <Button variant="ghost" size="sm" onclick={openCommandsDialog}>Commands</Button>
        <Button
          variant="ghost"
          size="sm"
          onclick={toggleChanges}
          aria-controls="session-details"
          aria-expanded={focusedPane !== 'main'
            ? changesPanes.includes(focusedPane)
            : acpAgent
              ? agentChangesOpen
              : detailsOpen &&
                (mainShipFallback ||
                  (sessionID ? activeSideTab === 'changes' : activeSideTab === 'ship'))}
          title={sessionID || acpAgent ? 'Toggle Changes (⌘L)' : 'Toggle details (⌘L)'}
          >{sessionID || acpAgent ? 'Changes' : 'Details'}</Button
        >
      </div>
    </header>
    {#if $settingsError}<p class="notice error" role="alert">{$settingsError}</p>{/if}
    {#if setupError}<p class="notice error" role="alert">{setupError}</p>{/if}
    {#if error}<div class="notice error" role="alert">{error}</div>{/if}
    {#snippet mainPaneContent()}
      <div class="workspace">
        <main
          class="chat-area"
          aria-label="Session conversation"
          tabindex="-1"
          bind:this={chatArea}
        >
          {#if acpAgent}
            {#key `${directory}:${acpAgent}`}
              <AgentWorkspace
                agent={acpAgent}
                agentName={agentAvailability.find((agent) => agent.id === acpAgent)?.name ??
                  acpAgent}
                {directory}
                {taskLocation}
                thread={acpThread}
                usage={acpThread
                  ? { ...agentUsage[threadKey(acpThread)], rates: agentRates[acpThread.agent] }
                  : undefined}
                coordinationMessages={coordinationMessages.filter(
                  (message) =>
                    acpThread &&
                    message.target ===
                      coordinationKey(directory, `acp:${acpAgent}:${acpThread.sessionId}`),
                )}
                spawnReceipts={spawnReceiptsForSource(
                  visibleSpawnReceipts,
                  acpThread ? `acp:${acpAgent}:${acpThread.sessionId}` : null,
                  directory,
                )}
                onopensubagent={openSpawnTarget}
                nativeEntries={acpThread
                  ? nativeSubagents[nativeSubagentId(acpThread.agent, acpThread.sessionId)]
                      ?.transcript
                  : undefined}
                focusPrompt={promptFocusPane === 'main'}
                picked={pickedAttachments.main}
                prefill={issuePrefills[directory]}
                onprefillconsumed={(id) => {
                  if (issuePrefills[directory]?.id === id) {
                    const next = { ...issuePrefills };
                    delete next[directory];
                    issuePrefills = next;
                  }
                }}
                externalPrompt={pendingAgentBatches.main}
                onexternalresult={completeAgentBatch}
                onpickedconsumed={markPickConsumed}
                onattachmentsent={assignReviewCaptures}
                onpromptfocused={() => (promptFocusPane = null)}
                onentrieschange={(entries, sessionId, ready) =>
                  (agentEntrySnapshots = {
                    ...agentEntrySnapshots,
                    main: { entries, sessionId, ready },
                  })}
                onworkspaceactivity={updateMainAgentWorkspaceActivity}
                ondecision={(thread, permission, optionId) =>
                  recordDecisionActivity(
                    thread,
                    String(permission.id),
                    permission.title,
                    optionId === 'reject' ? 'rejected' : 'completed',
                  )}
                running={!!(acpThread && runningAgentThreads[agentThreadKey(acpThread)])}
                focused={focusedPane === 'main'}
                oncreated={createAgentThread}
                onactivity={saveAgentThread}
                onstatus={updateAgentThreadStatus}
                onreplaychange={setAgentReplay}
                onterminal={(id) => void openAgentTerminal(id)}
                onshipit={adoptDirectShipRun}
                postTurnChecks={postTurnResults.filter(
                  (check) =>
                    acpThread &&
                    check.directory === directory &&
                    check.thread === `acp:${acpAgent}:${acpThread.sessionId}`,
                )}
                onretrycheck={(check) => void runOnePostTurnCheck(check, true)}
              />
            {/key}
          {:else}
            <div class="agent-header">
              <div class="agent-heading">
                <HarnessIcon agent="opencode" /><strong>OpenCode</strong><span
                  >{currentSession?.title ??
                    (newSessionMode === 'work' ? 'New work' : 'New thread')}</span
                >
              </div>
              <ActivityStatus
                status={runtimeState === 'starting'
                  ? 'connecting'
                  : runtimeState !== 'connected'
                    ? 'offline'
                    : pendingPermissions.length ||
                        pendingForms.length ||
                        setup?.model.state === 'action'
                      ? 'waiting'
                      : running
                        ? 'working'
                        : workReady
                          ? 'ready'
                          : setupLoading
                            ? 'connecting'
                            : 'offline'}
              />
            </div>
            <div class="chat-body">
              <div
                class="conversation"
                bind:this={chatScroll}
                onscroll={() => {
                  followChat = chatScroll ? nearBottom(chatScroll) : true;
                  if (chatScroll && chatScroll.scrollTop <= 80) void loadOlderMessages();
                }}
              >
                {#if !sessionID && messages.length === 0}<div class="welcome">
                    <div class="welcome-mark">◇</div>
                    <p class="eyebrow">{planReady ? 'PLAN WITH ARCHITECT' : 'START WORK'}</p>
                    <h1>What are we working on?</h1>
                    <p>
                      {planReady
                        ? 'Choose an agent and model, then describe the work. Use New plan for Architect-first planning.'
                        : workReady
                          ? 'Choose an OpenCode agent and describe the work.'
                          : agentAvailability.some((agent) => agent.available)
                            ? 'Choose an available agent to start in this repository.'
                            : 'Connect a model in OpenCode settings to start.'}
                    </p>
                    {#if !directory}<Button
                        onclick={() => chooseProject()}
                        disabled={runtimeState !== 'connected'}>Select repository</Button
                      >{/if}
                    {#if directory && !workReady}<div class="welcome-agents">
                        {#each agentAvailability.filter((agent) => agent.available) as agent (agent.id)}<Button
                            variant="secondary"
                            onclick={() => openAgent(agent.id)}
                            >Start with <HarnessIcon agent={agent.id} /> {agent.name}</Button
                          >{/each}
                      </div>{/if}
                  </div>{/if}
                {#each displayChatMessages as message (message.id)}
                  {#if message.type === 'spawn-response'}
                    <SpawnResponse receipt={message.receipt} />
                  {:else if message.type === 'user'}
                    {@const attribution = coordinationMessageForText(
                      message.text,
                      coordinationMessages.filter(
                        (item) =>
                          item.target === coordinationKey(directory, `opencode:${sessionID}`),
                      ),
                    )}
                    <ChatMessage
                      kind="user"
                      author={attribution ? `From ${attribution.sender}` : 'You'}
                      messageId={message.id}
                      created={message.time.created}
                    >
                      <Markdown
                        source={attribution
                          ? message.text.replace(coordinationPrompt(attribution), attribution.text)
                          : message.text}
                      />
                      {#if message.files?.length}<div class="message-files">
                          {#each message.files as file, fileIndex (fileIndex)}<span
                              >{file.name ??
                                (file.source.type === 'uri' ? file.source.uri : 'Attachment')}</span
                            >{/each}
                        </div>{/if}
                    </ChatMessage>
                  {:else if message.type === 'assistant'}<ChatMessage
                      kind="assistant"
                      author={message.agent}
                      messageId={message.id}
                      created={message.time.created}
                    >
                      {#if assistantText(message)}<Markdown source={assistantText(message)} />{/if}
                      {#each message.content as part, ordinal (ordinal)}
                        {#if part.type === 'tool'}
                          {@const reason =
                            part.state.status === 'error'
                              ? openCodeErrorDetails(part.state.error)
                              : ''}
                          {@const output =
                            part.state.status === 'completed' || part.state.status === 'error'
                              ? (part.state.content ?? [])
                                  .map((item) =>
                                    item.type === 'text' ? item.text : (item.name ?? item.uri),
                                  )
                                  .join('\n')
                              : ''}
                          <ToolActivity
                            activityId={`${message.id}:${part.id}`}
                            title={part.name}
                            status={part.state.status}
                            input={part.state.input}
                            {output}
                            error={reason}
                            source={part.state.status === 'error'
                              ? (reportedHookIdentity(part.state.metadata) ?? '')
                              : ''}
                            onfix={part.state.status === 'error'
                              ? () =>
                                  fixOpenCodeToolFailure(
                                    `${message.id}:${part.id}`,
                                    part.name,
                                    part.state.input,
                                    reason,
                                    output,
                                  )
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
                    </ChatMessage>{/if}
                {/each}
                <OpenCodeSubagents {client} parentID={sessionID} />
                {#each coordinationMessages.filter((message) => sessionID && message.target === coordinationKey(directory, `opencode:${sessionID}`) && !chatMessages.some((item) => item.type === 'user' && item.text.includes(coordinationPrompt(message)))) as message (message.id)}
                  <ChatMessage
                    kind="user"
                    author={`From ${message.sender}${message.delivered ? '' : ' · queued'}`}
                  >
                    <Markdown source={message.text} />
                  </ChatMessage>
                {/each}
                {#each liveOnly as [id, parts] (id)}
                  <ChatMessage
                    kind="assistant"
                    author={`${currentSession?.agent ?? 'Agent'} · streaming`}
                    messageId={id}
                  >
                    <Markdown
                      source={Object.entries(parts)
                        .toSorted(([a], [b]) => Number(a) - Number(b))
                        .map(([, value]) => value)
                        .join('\n')}
                    />
                  </ChatMessage>
                {/each}
                <PostTurnChecks
                  checks={mainPostTurnChecks}
                  onretry={(check) => void runOnePostTurnCheck(check, true)}
                />
                <SpawnActivity receipts={mainSpawnActivity} onopen={openSpawnTarget} />
                {#if running && runtimeState === 'connected'}<div class="chat-working">
                    <ActivityStatus
                      status={pendingPermissions.length || pendingForms.length
                        ? 'waiting'
                        : 'working'}
                    />
                    <span class="working-label" role="status">{activity}</span>
                    <Button size="sm" variant="secondary" onclick={stop}>Stop</Button>
                  </div>{/if}
              </div>
            </div>
            {#if workReady || sessionID}<div class="composer-wrap">
                <PromptPanel
                  {pendingPermissions}
                  {pendingForms}
                  client={connecting ? null : client}
                  {sessionID}
                  onchanged={() => refreshPrompts()}
                />
                <div class="composer">
                  <TaskLocation location={mainPromptLocation} />
                  <textarea
                    role="combobox"
                    aria-autocomplete="list"
                    aria-haspopup="listbox"
                    aria-controls={skillMatches.length ? skillMenuId : undefined}
                    aria-expanded={skillMatches.length > 0}
                    aria-activedescendant={skillMatches.length
                      ? `${skillMenuId}-option-${Math.min(skillSelected, skillMatches.length - 1)}`
                      : undefined}
                    data-pane-prompt
                    aria-label="Message"
                    bind:this={mainPrompt}
                    bind:value={draft}
                    onpaste={(event) => {
                      pendingPaste = Promise.all([pendingPaste, pasteFiles(event)]).then(() => {});
                    }}
                    onkeydown={keydown}
                    rows="3"
                    wrap="soft"
                    placeholder={inputReady
                      ? 'Describe the work or ask a question…'
                      : 'OpenCode needs a connected model…'}
                    disabled={!inputReady || sending}></textarea>
                  {#if attachedFiles.length}<div class="attachments">
                      {#each attachedFiles as path (path)}<span
                          >{clipboardAttachmentNames.get(path) ?? path.split(/[\\/]/).at(-1)}<button
                            aria-label={`Remove ${clipboardAttachmentNames.get(path) ?? path.split(/[\\/]/).at(-1)}`}
                            onclick={() => removeAttachedFile(path)}>×</button
                          ></span
                        >{/each}
                    </div>{/if}
                  <SkillMenu
                    id={skillMenuId}
                    skills={skillMatches}
                    selected={skillSelected}
                    choose={chooseSkill}
                  />
                  <div class="composer-bottom">
                    <div class="composer-controls">
                      <OptionPicker
                        label="Agent"
                        value={selectedAgentID}
                        options={agentChoices}
                        open={composerPickerOpen === 'agent'}
                        disabled={running || sending || switching || !workReady}
                        onopen={() => (composerPickerOpen = 'agent')}
                        onclose={() => (composerPickerOpen = null)}
                        onchoose={(value) => void chooseAgent(value)}
                      />
                      <OptionPicker
                        label="Model"
                        value={selectedModelKey}
                        options={modelChoices}
                        open={composerPickerOpen === 'model'}
                        disabled={running || sending || switching || !workReady}
                        onopen={() => (composerPickerOpen = 'model')}
                        onclose={() => (composerPickerOpen = null)}
                        onchoose={(value) => void chooseModel(value)}
                      />
                      <OptionPicker
                        label="Effort"
                        value={selectedVariant}
                        options={effortChoices}
                        open={composerPickerOpen === 'effort'}
                        disabled={running || sending || switching || !workReady}
                        onopen={() => (composerPickerOpen = 'effort')}
                        onclose={() => (composerPickerOpen = null)}
                        onchoose={(value) => void chooseEffort(value)}
                      />
                    </div>
                    <div class="composer-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onclick={attachFiles}
                        disabled={!inputReady || sending}>Attach files</Button
                      >
                      <Button onclick={send} disabled={!canSend} loading={sending}
                        >{running ? 'Queue ↗' : 'Send ↗'}</Button
                      >
                    </div>
                  </div>
                </div>
              </div>{/if}
          {/if}
        </main>
      </div>
    {/snippet}
    {#if workspaceView === 'overview'}
      <TaskOverview
        catalog={projectCatalog}
        threads={sidebarThreads}
        statuses={taskOverviewStatuses}
        agentNames={taskOverviewAgentNames}
        checks={postTurnResults}
        receipts={visibleSpawnReceipts}
        {directory}
        onopen={openTaskOverviewTarget}
        onopencheck={openTaskOverviewCheck}
      />
    {/if}
    <div class="workspace-pane-host" hidden={workspaceView === 'overview'}>
      <PaneTree
        active={workspaceView === 'workspace'}
        pane={paneLayout}
        focused={focusedPane}
        {directory}
        project={coordinationProject(directory) ?? directory}
        {taskLocation}
        {dark}
        agents={paneAgents}
        {sideChat}
        {client}
        {setup}
        {runtimeState}
        {coordinationMessages}
        spawnReceipts={visibleSpawnReceipts}
        onopensubagent={openSpawnTarget}
        {shipRuns}
        {shippingBusy}
        nativeSubagents={Object.values(nativeSubagents)}
        onshiprefresh={() => tickShippingRuns(true)}
        onshipopen={openShipTarget}
        onshipsettings={openSettings}
        onship={(graph, provider, limit, source) =>
          startShippingRun(graph, provider, limit, source)}
        onshipit={adoptDirectShipRun}
        postTurnChecks={postTurnResults}
        onretrycheck={(check) => void runOnePostTurnCheck(check, true)}
        {agentUsage}
        {agentRates}
        onentries={(id, entries, sessionId, ready) =>
          (agentEntrySnapshots = { ...agentEntrySnapshots, [id]: { entries, sessionId, ready } })}
        {changesPanes}
        main={mainPaneContent}
        mainPicker={showMainPicker}
        canClose={leaves(paneLayout).length > 1 ||
          !!sideChat ||
          leaves(paneLayout).some((pane) => pane.id === 'main' && !!pane.kind)}
        onfocus={focusPane}
        onclose={closeFocusedPane}
        onratio={updatePaneRatio}
        oncreated={createPaneThread}
        onchooseagent={choosePaneAgent}
        onchooseterminal={choosePaneTerminal}
        onchoosebrowser={choosePaneBrowser}
        onbrowserstate={updatePaneBrowser}
        onbrowserpick={attachPickedElement}
        {pickedAttachments}
        {diffComments}
        ondiffcomments={updateDiffComments}
        ondiffcommentssent={removeSentDiffComments}
        onsenddiffcomments={sendDiffComments}
        {pendingAgentBatches}
        onbatchcomplete={completeAgentBatch}
        onpickedconsumed={markPickConsumed}
        onattachmentsent={assignReviewCaptures}
        onshortcut={keydownWorkspace}
        onactivity={recordPaneActivity}
        onhistorychange={() => openCodeTimelineRevision++}
        activityEvents={currentActivityHistory}
        activityLoading={inboxLoading}
        activityError={inboxError}
        onactivityrefresh={() => void refreshInbox()}
        onactivityselect={selectActivityHistory}
        onactivityopen={showActivitySource}
        ondecision={recordDecisionActivity}
        onusage={(id, context) => {
          if (context !== undefined && openCodeUsage[`${directory}:${id}`] !== context)
            openCodeUsage = { ...openCodeUsage, [`${directory}:${id}`]: context };
        }}
        focusPromptPane={promptFocusPane}
        onpromptfocused={() => (promptFocusPane = null)}
        running={(thread) => !!(thread && runningAgentThreads[agentThreadKey(thread)])}
        onstatus={updateAgentThreadStatus}
        onreplaychange={setAgentReplay}
        onchanges={(id) => {
          changesPanes = changesPanes.filter((item) => item !== id);
        }}
        {pendingCommands}
        oncommandstarted={(id) => {
          const next = { ...pendingCommands };
          delete next[id];
          pendingCommands = next;
        }}
        onterminalexit={(id, code) => {
          terminalExitWaiters.get(id)?.(code);
          terminalExitWaiters.delete(id);
          finishCoordinationSetup(id, code);
        }}
        onterminalownerlost={(id) =>
          savePaneLayout(updatePane(paneLayout, id, { owner: undefined }))}
        onagentterminal={(id) => void openAgentTerminal(id)}
        reviewCaptures={reviewCaptures.filter((capture) => capture.directory === directory)}
        reviewPreviews={reviewPreviews()}
        onreviewcheck={openReviewCheck}
        onreviewpreview={openReviewPreview}
        onreviewcapturephase={setReviewCapturePhase}
      />
    </div>
  </div>
  {#if shipFallbackVisible}<section class="ship-fallback" aria-label="Ship run details">
      <ShipPanel
        repository={coordinationProject(directory) ?? directory}
        runs={shipRuns}
        busy={shippingBusy}
        nativeSubagents={Object.values(nativeSubagents)}
        onclose={closeShipRuns}
        onrefresh={() => tickShippingRuns(true)}
        onopen={openShipTarget}
        onsettings={async () => {
          closeShipRuns();
          await openSettings();
        }}
      />
    </section>{/if}
  {#if !mainShipFallback && (sessionID || acpAgent || activeSideTab === 'ship')}<div
      class="details-resizer"
      role="slider"
      tabindex="0"
      aria-label="Pane divider position"
      aria-orientation="horizontal"
      aria-controls="session-details"
      aria-valuemin="300"
      aria-valuemax={Math.max(300, workspaceWidth - 328)}
      aria-valuenow={Math.max(300, workspaceWidth - 8 - visibleDetailsWidth)}
      aria-valuetext={`Details pane ${visibleDetailsWidth} pixels wide`}
      onpointerdown={startDetailsResize}
      onpointermove={moveDetailsResize}
      onpointerup={endDetailsResize}
      onpointercancel={endDetailsResize}
      onkeydown={keydownDetailsResize}
      ondblclick={() => setDetailsWidth(420)}
      onfocusin={() => focusPane('main')}
    ></div>
    <section
      id="session-details"
      class="side-area"
      aria-label="Session details"
      tabindex="-1"
      bind:this={detailsArea}
      onfocusin={() => focusPane('main')}
      onpointerdown={() => focusPane('main')}
    >
      <nav class="side-tabs" aria-label="Session detail tabs">
        {#if !acpAgent && showPlanPanel && sessionID}<button
            class:active={activeSideTab === 'plan'}
            aria-current={activeSideTab === 'plan' ? 'page' : undefined}
            onclick={() => switchSideTab('plan')}>Plan</button
          >{/if}{#if sessionID || acpAgent}<button
            class:active={activeSideTab === 'changes'}
            aria-current={activeSideTab === 'changes' ? 'page' : undefined}
            onclick={toggleChanges}>Changes ({diffs.length})</button
          >{/if}{#if sessionID || acpAgent}<button
            class:active={activeSideTab === 'history'}
            aria-current={activeSideTab === 'history' ? 'page' : undefined}
            onclick={() => switchSideTab('history')}>Activity</button
          >{/if}<button
          class:active={activeSideTab === 'ship'}
          aria-current={activeSideTab === 'ship' ? 'page' : undefined}
          onclick={() => switchSideTab('ship')}>Ship runs ({shipRuns.length})</button
        >
      </nav>
      <div class="side-panel-body">
        {#if !acpAgent && showPlanPanel}<div
            class:inactive={activeSideTab !== 'plan'}
            class="side-view"
          >
            <PlanPanel
              {snapshot}
              client={connecting ? null : client}
              {directory}
              {sessionID}
              {dark}
              onchanged={() => refreshSession()}
              onselectfile={selectDiffPath}
              shipRun={shipRuns.find(
                (run) =>
                  run.repository === (coordinationProject(directory) ?? directory) &&
                  run.source === snapshot.plan?.sessionID,
              ) ?? null}
              onship={(graph, provider, limit) =>
                startShippingRun(graph, provider, limit, snapshot.plan?.sessionID ?? '')}
            />
          </div>{/if}
        {#if sessionID || acpAgent}<div
            class:inactive={activeSideTab !== 'changes'}
            class="side-view"
          >
            <DiffPanel
              {directory}
              files={diffs}
              annotations={acpAgent ? {} : diffAnnotations}
              selected={selectedFilePath}
              loading={diffLoading}
              error={diffError}
              onselect={(file) => (selectedFilePath = file)}
              onrefresh={() => (acpAgent ? refreshAgentDiff() : refreshDiff())}
              onclose={toggleChanges}
              scope={diffCommentKey('main')}
              comments={diffComments[diffCommentKey('main')] ?? []}
              oncomments={updateDiffComments}
              oncommentssent={removeSentDiffComments}
              onsendcomments={(scope, text) => sendDiffComments('main', scope, text)}
              evidence={reviewEvidence(
                'main',
                acpAgent
                  ? acpThread
                    ? `acp:${acpAgent}:${acpThread.sessionId}`
                    : null
                  : sessionID
                    ? `opencode:${sessionID}`
                    : null,
              )}
            />
          </div>{/if}
        {#if sessionID || acpAgent}<div
            class:inactive={activeSideTab !== 'history'}
            class="side-view"
          >
            <WorkspaceActivity
              items={acpAgent ? mainAgentWorkspaceActivity : mainWorkspaceActivity}
              events={currentActivityHistory}
              agent={acpAgent ?? 'opencode'}
              sessionId={acpAgent ? acpThread?.sessionId : (sessionID ?? undefined)}
              loading={inboxLoading}
              error={inboxError}
              onrefresh={() => void refreshInbox()}
              onselect={selectMainActivity}
              onselecthistory={selectActivityHistory}
            />
          </div>{/if}
        <div class:inactive={activeSideTab !== 'ship'} class="side-view">
          <ShipPanel
            repository={coordinationProject(directory) ?? directory}
            active={activeSideTab === 'ship' && detailsOpen && (acpAgent ? agentChangesOpen : true)}
            runs={shipRuns}
            busy={shippingBusy}
            nativeSubagents={Object.values(nativeSubagents)}
            onclose={closeShipRuns}
            onrefresh={() => tickShippingRuns(true)}
            onopen={openShipTarget}
            onsettings={async () => {
              closeShipRuns();
              await openSettings();
            }}
          />
        </div>
      </div>
    </section>{/if}
  <AgentStatusBar items={agentStatusItems} onopen={(key) => jumpToRecentThread(key)} />
</div>
<ConfirmDialog request={confirmation} onanswer={answerConfirmation} />
<PathPicker
  open={pathPicker !== null}
  title="Attach files"
  mode="files"
  initialPath={pathPicker?.initialPath}
  onselect={(paths) => void selectPickerPaths(paths)}
  oncancel={() => (pathPicker = null)}
/>
<dialog
  class="commands-dialog worktree-approval-dialog"
  bind:this={worktreeApprovalDialog}
  aria-label="Agent worktree request"
  onclose={() => {
    if (!worktreeApprovalDialog.open) finishWorktreeApproval(false);
  }}
>
  {#if worktreeApproval}
    <div class="commands-header"><h2>Agent worktree request</h2></div>
    {#if worktreeApproval.existingPath}
      <p>
        Allow {worktreeApproval.agent} thread “{worktreeApproval.title}” to start a new
        {worktreeApproval.provider} thread in {worktreeApproval.existingPath}?
      </p>
      <p>The new agent will share this worktree’s files with other agents running there.</p>
    {:else}
      <p>
        Allow {worktreeApproval.agent} thread “{worktreeApproval.title}” to create worktree “{worktreeApproval.name}”
        in {worktreeApproval.project} and start a new {worktreeApproval.provider ?? 'agent'} thread?
      </p>
    {/if}
    <p class="worktree-approval-prompt">{worktreeApproval.prompt}</p>
    <div class="worktree-approval-actions">
      <button type="button" onclick={() => finishWorktreeApproval(false)}>Deny</button>
      <button type="button" onclick={() => finishWorktreeApproval(true)}
        >{worktreeApproval.existingPath ? 'Allow shared worktree' : 'Allow worktree'}</button
      >
    </div>
  {/if}
</dialog>
<dialog
  class="command-palette"
  bind:this={paletteDialog}
  aria-label="Command palette"
  onclose={commandPaletteClosed}
>
  <nav class="palette-path" aria-label="Command palette path">
    <button
      class:current={paletteStep.kind === 'projects'}
      onclick={() => setPaletteStep({ kind: 'projects' })}>Projects</button
    >
    {#if paletteStep.kind !== 'projects'}
      <span aria-hidden="true">›</span><button
        class:current={paletteStep.kind === 'worktrees'}
        title={paletteRepository}
        onclick={() => setPaletteStep({ kind: 'worktrees', repository: paletteRepository })}
        >{locationName(paletteRepository)}</button
      >
    {/if}
    {#if paletteStep.kind === 'agents' || paletteStep.kind === 'sessions'}
      <span aria-hidden="true">›</span><button
        class:current={paletteStep.kind === 'agents'}
        title={paletteLocation}
        onclick={() =>
          setPaletteStep({
            kind: 'agents',
            repository: paletteRepository,
            directory: paletteLocation,
          })}
        >{paletteLocation === paletteRepository
          ? 'Main checkout'
          : ((projectCatalog.worktrees[paletteRepository] ?? []).find(
              (worktree) => worktree.path === paletteLocation,
            )?.branch ?? locationName(paletteLocation))}</button
      >
    {/if}
    {#if paletteStep.kind === 'sessions'}
      <span aria-hidden="true">›</span><strong
        >{paletteAgentID === 'opencode'
          ? 'OpenCode'
          : (agentAvailability.find((agent) => agent.id === paletteAgentID)?.name ??
            paletteAgentID)}</strong
      >
    {/if}
  </nav>
  <div class="palette-search">
    <input
      bind:this={paletteInput}
      value={paletteQuery}
      aria-label="Search command palette"
      placeholder={paletteStep.kind === 'projects'
        ? 'Search projects or commands…'
        : paletteStep.kind === 'worktrees'
          ? 'Search worktrees…'
          : paletteStep.kind === 'agents'
            ? 'Choose an agent…'
            : 'New or existing session…'}
      oninput={(event) => updatePaletteQuery(event.currentTarget.value)}
      onkeydown={keydownCommandPalette}
    />
    <kbd>{paletteStep.kind === 'projects' ? 'Esc' : '⌫ back'}</kbd>
  </div>
  <div class="palette-results">
    {#each paletteEntries as entry, index (entry.id)}
      <button
        class="palette-entry"
        data-kind={entry.kind}
        class:active={index === paletteIndex}
        aria-current={index === paletteIndex ? 'true' : undefined}
        disabled={entry.disabled || paletteBusy}
        onclick={() => void choosePaletteEntry(entry)}
      >
        {#if entry.agent}<HarnessIcon agent={entry.agent} />{/if}
        <span><strong>{entry.label}</strong><small>{entry.detail}</small></span>
        <span class="palette-kind"
          >{entry.kind === 'project'
            ? 'Project'
            : entry.kind === 'worktree'
              ? 'Worktree'
              : entry.kind === 'new-worktree'
                ? 'Create'
                : entry.kind === 'agent'
                  ? 'Agent'
                  : entry.kind === 'command'
                    ? 'Command'
                    : entry.kind === 'new-session'
                      ? 'New'
                      : 'Session'}</span
        >
      </button>
    {:else}
      <div class="palette-empty">
        <p>{paletteLoading ? 'Loading sessions…' : `No matches for “${paletteQuery}”.`}</p>
        {#if paletteStep.kind === 'projects' && !projectCatalog.repositories.length}<button
            onclick={() => {
              closeCommandPalette(false);
              void chooseProject();
            }}>Add repository…</button
          >{/if}
      </div>
    {/each}
    {#if paletteLoading && paletteEntries.length}<p class="palette-status" role="status">
        Loading sessions…
      </p>{/if}
    {#if paletteError}<p class="palette-error" role="alert">{paletteError}</p>{/if}
  </div>
</dialog>
<dialog class="commands-dialog" bind:this={snapshotsDialog} aria-label="Worktree restore history">
  <div class="commands-header">
    <h2>Restore worktree</h2>
    <button aria-label="Close restore history" onclick={() => snapshotsDialog.close()}>×</button>
  </div>
  <div class="commands-list">
    {#if snapshotsError}<p role="alert" class="notice error">{snapshotsError}</p>{/if}
    {#if snapshotsLoading}<p>Loading saved turns…</p>{/if}
    {#each snapshots as item (item.id)}
      <div class="commands-row">
        <span
          >{item.kind === 'undo' ? 'Undo restore' : 'Before agent turn'} · {new Date(
            item.created,
          ).toLocaleString()}</span
        >
        <button
          aria-label={`Restore ${item.kind === 'undo' ? 'undo entry' : 'before agent turn'} from ${new Date(item.created).toLocaleString()} (${item.id.slice(-8)})`}
          disabled={snapshotsRestoring}
          onclick={() => void restoreSnapshot(item)}>Restore</button
        >
      </div>
    {:else}
      {#if !snapshotsLoading}<p>No saved turns in this thread yet.</p>{/if}
    {/each}
  </div>
</dialog>
<dialog class="commands-dialog" bind:this={agentTerminalsDialog} aria-label="Agent terminals">
  <div class="commands-header">
    <h2>Agent terminals</h2>
    <button aria-label="Close agent terminals" onclick={() => agentTerminalsDialog.close()}
      >×</button
    >
  </div>
  <div class="commands-list">
    {#each agentTerminals as terminal (terminal.terminalId)}
      <div class="commands-row">
        <span
          ><strong>{terminal.command}</strong><small>{terminal.agent} · {terminal.directory}</small
          ></span
        >
        <button onclick={() => void openAgentTerminal(terminal.terminalId)}>Open</button>
      </div>
    {/each}
  </div>
</dialog>
<dialog class="commands-dialog" bind:this={commandsDialog} aria-label="Saved commands">
  <div class="commands-header">
    <h2>Saved commands</h2>
    <button aria-label="Close saved commands" onclick={() => commandsDialog.close()}>×</button>
  </div>
  <div class="commands-list">
    {#each commandsForDirectory(savedCommands, projectCatalog, directory) as command (command.id)}
      <div class="commands-row">
        <span
          ><strong>{command.name}</strong><small
            >{command.project ? command.project.split(/[\\/]/).at(-1) : 'Global'} · {command.command}</small
          ></span
        >
        <button
          aria-label={`Edit ${command.name}`}
          onclick={() => {
            editingCommand = command.id;
            commandName = command.name;
            commandText = command.command;
            commandScope = command.project ? 'project' : 'global';
          }}>Edit</button
        ><button
          aria-label={`Delete ${command.name}`}
          onclick={() => saveCommands(savedCommands.filter((item) => item.id !== command.id))}
          >Delete</button
        >
      </div>
    {:else}<p>No commands saved yet.</p>{/each}
  </div>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      saveCommand();
    }}
  >
    <label>Name<input bind:value={commandName} required /></label>
    <label>Command<textarea bind:value={commandText} required rows="3"></textarea></label>
    <div class="command-scope-field">
      Scope
      <OptionPicker
        label="Scope"
        value={commandScope}
        options={[
          { value: 'global', name: 'Global' },
          {
            value: 'project',
            name: 'Current project',
            disabled: !selectedRepository(projectCatalog, directory),
          },
        ]}
        open={commandScopePickerOpen}
        onopen={() => (commandScopePickerOpen = true)}
        onclose={() => (commandScopePickerOpen = false)}
        onchoose={(value) => (commandScope = value as 'global' | 'project')}
      />
    </div>
    <button type="submit" disabled={!commandName.trim() || !commandText.trim()}
      >{editingCommand ? 'Save changes' : 'Save command'}</button
    >
  </form>
</dialog>
<dialog class="rename-session-dialog" bind:this={renameSessionDialog} aria-label="Rename session">
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void saveRename();
    }}
  >
    <label
      >Session title<input aria-label="Session title" bind:value={editedTitle} required /></label
    >
    <button type="button" onclick={() => renameSessionDialog.close()}>Cancel</button>
    <button type="submit">Save</button>
  </form>
</dialog>
<dialog class="inbox-dialog" bind:this={inboxDialog} aria-label="Pending requests across projects">
  <div class="inbox-dialog-top">
    <span>All projects</span>
    <button aria-label="Close pending requests" onclick={() => inboxDialog.close()}>×</button>
  </div>
  {#if inboxError}<p class="notice error" role="alert">{inboxError}</p>{/if}
  <InboxPanel
    items={inboxItems}
    loading={inboxLoading}
    error={inboxError}
    onopen={(item) => void openInboxItem(item)}
    ondecide={decideInbox}
  />
</dialog>
