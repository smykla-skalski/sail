<script lang="ts">
  import { OPEN_IN_SPLIT_EVENT } from './lib/external-link';
  class ValidationCandidateUnavailable extends Error {
    constructor(message: string, cause?: unknown) {
      super(cause === undefined ? message : `${message}: ${describe(cause)}`, { cause });
    }
  }

  import { onMount, tick, untrack } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { emitTo, listen } from '@tauri-apps/api/event';
  import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import type { BrowserAttachment } from './lib/browser-pick';
  import { Button } from '@smykla-skalski/sui';
  import WorkspaceActivity from './WorkspaceActivity.svelte';
  import { type WorkspaceActivityItem } from './lib/workspace-activity';
  import {
    loadActivityHistory,
    recentActivityEvents,
    saveActivityHistory,
    sharedActivityHistory,
    type ActivityHistoryEvent,
    type ActivityHistoryInput,
  } from './lib/activity-history';
  import Markdown from './Markdown.svelte';
  import PlanPanel from './PlanPanel.svelte';
  import PlanHistoryPanel from './PlanHistoryPanel.svelte';
  import { acpPlanBackend, acpPlans, planKey, type PlanScope } from './lib/acp-plans';
  import { isPlanTool } from './lib/plan-engine';
  import { openCodeSessionId, sameThreadId } from './lib/thread-id';
  import {
    automaticRecallControl,
    persistAutomaticRecall,
    withAutomaticMemoryRecall,
  } from './lib/memory-recall';
  import { nativePlanUpdate, type NativePlan } from './lib/native-plan';
  import {
    loadNativePlan,
    clearStructuredQuestions,
    removeStructuredQuestion,
    saveNativePlan,
  } from './lib/planning-state';
  import { elicitationSummary } from './lib/elicitation-form';
  import ShipPanel from './ShipPanel.svelte';
  import AppTopbar from './AppTopbar.svelte';
  import {
    appendShipEvent,
    beginLatestRefresh,
    nextValidationReservation,
    gateSnapshot,
    currentShipBlockedReason,
    loadShipRunStore,
    repositoryForRemote,
    serializeShipRuns,
    shippingWorkerGone,
    unrecoverableGraceExpired,
    unrecoverableIssuePlan,
    parseShipReport,
    requireValidatorEconomics,
    refreshedIssueState,
    refreshedPullRequest,
    closedWithoutMerge,
    shipGatesSettled,
    shipCleanupRequest,
    shipEvidenceReadiness,
    shipOwnedThreadIds,
    shipOwnershipQuietGeneration,
    shipOwnershipQuietPass,
    shipTaskThreadsSettled,
    reconciledShipGates,
    recoverValidationEvidence,
    persistShipRefresh,
    settleShipRefresh,
    type GateName,
    type ShippingPullRequest,
    shipOwner,
    shipCheckpointOwner,
    shipTaskReceiptIdsToProtect,
    authorizeShipCheckpointThread,
    commitRevisionBoundValidation,
    rollbackValidationIssue,
    rollbackValidationReceipt,
    gateVerdictPassed,
    validateGateVerdict,
    validationRevisionDrifted,
  } from './lib/ship-progress';
  import type { PublishedGraph } from './lib/issue-graph';
  import {
    migrateShipArchive,
    parseShipArchiveDelay,
    shipArchiveMigrationKey,
    shipRunArchived,
    shipRunDueForArchive,
    type ShipArchiveDelay,
  } from './lib/ship-archive';
  import {
    shipArchiveAction,
    shipArchiveConfirmation,
    shipMergeAction,
    shipMergeConfirmation,
    shipReopenAction,
    shipReopenConfirmation,
    shipRetryAction,
    shipRetryConfirmation,
    shipStopAction,
    shipStopConfirmation,
    stoppedMessage,
    type ShipActionId,
  } from './lib/ship-actions';
  import {
    adoptRegisteredDirectShipRun,
    acpWorkerTerminationConfirmed,
    beginAuthorizedCoordinationPrompt,
    dispatchAuthorizedDirectShipPrompt,
    directClaimHandoffChanges,
    settleDirectClaimHandoff,
    directShipPromptAuthorized,
    claimHeartbeatDue,
    claimMonotonicLeaseDeadline,
    claimRefreshRequiresFence,
    completeAuthorizedPromptRecovery,
    createPromptDispatchTracker,
    createShipRun,
    fenceExpiredShippingLease,
    fencePredecessorWorkerBeforeTakeover,
    fenceResumedShippingClaim,
    fenceShippingTaskThreads,
    isDirectShipRun,
    monotonicDeadlineExpired,
    nextClaimHeartbeatDeadline,
    persistAcquiredClaim,
    persistStartedShippingWorker,
    persistVerifiedHeartbeat,
    predecessorTakeoverChanges,
    recoveredClaimLeaseDeadlines,
    recoveredClaimWorkerFenceRequired,
    readyShipIssues,
    registeredShipBranch,
    refreshShippingIssueAfterClaim,
    resumedShippingIssueChanges,
    serializeShippingClaimOperation,
    resolvedWorkerModel,
    settleClosedPullRequest,
    shippingClockWasSuspended,
    shippingClaimOwnedByInstance,
    shippingWorkerSettled,
    shipWorkerPrompt,
    parseMergeOwner,
    type MergeOwner,
    shippingSetupAction,
    settledLostClaimFence,
    terminalClaimReleaseReady,
    terminalClaimReleaseReason,
    type DirectShipAuthorization,
    type ShippingClaim,
    type ShippingClaimObservation,
    type ShipIssue,
    type ShipRun,
    type ShippingTarget,
    workerStateSettled,
  } from './lib/issue-shipping';
  import type { ShipItIssue } from './lib/implementation-models';
  import { checkState } from './lib/pull-request-checks.ts';
  import {
    ciFailurePrompt,
    ciTriageEconomics,
    recordCiFailureTriage,
    resolveCiFailureTriages,
    triageCiFailure,
    type CiRerunPolicy,
  } from './lib/ci-failure-triage.ts';
  import {
    initialTaskCheckpoint,
    prepareTaskCheckpointUpdate,
    reconcileTaskCheckpoint,
    updateTaskCheckpoint,
  } from './lib/task-checkpoint.ts';
  import {
    contextCheckpointLead,
    contextHandoffPrompt,
    contextPressureStage,
    parseContextHandoffThreshold,
    reconcileHandoffOutcomes,
    transferHandoffOwnership,
    updateThreadContextPressure,
    type ContextProvider,
  } from './lib/context-handoff.ts';
  import {
    automaticPermissionPolicy,
    capabilityProfileEnablesTool,
    capabilityProfileForPhase,
    capabilityProfileFromMetadata,
    intersectCapabilityProfiles,
    permissionDecisionTitle,
    permissionOutcome,
    permissionReadResources,
    type CapabilityProfile,
  } from './lib/capability-profiles';
  import {
    commitRevisionBoundEvidence,
    evidenceReadiness,
    ciEvidenceIdentity,
    mergeEvidenceManifests,
    nextTaskEvidenceSequence,
    readStableEvidenceBoundary,
    requireEvidenceBaseRevision,
    requireEvidenceExecutionBoundary,
    requireEvidenceRevision,
    recordTaskEvidence,
    rollbackTaskEvidenceRecord,
    recordCiEvidenceObservation,
    reconcileCiEvidenceSnapshot,
    syncEvidenceManifest,
    taskEvidenceSchema,
    type EvidenceResult,
    type TaskEvidence,
  } from './lib/task-evidence.ts';
  import {
    selectShipValidationPolicy,
    readStableShipValidationInputs,
    assertShipGateAllowed,
    requiredShipGatesSatisfied,
    shipRiskLevels,
    type ShipRisk,
    type ShipValidationConfig,
  } from './lib/ship-risk-policy.ts';
  import {
    acpModelId,
    modelRoutingSettingsKey,
    parseModelRoutingSettings,
    selectModelRoute,
    type ModelRouteRole,
  } from './lib/model-routing.ts';
  import {
    syntheticCiEconomics,
    taskEconomicsSchema,
    type TaskEconomics,
  } from './lib/task-economics.ts';
  import DiffPanel from './DiffPanel.svelte';
  import ProjectSidebar from './ProjectSidebar.svelte';
  import {
    clampSidebarWidth,
    parseSidebarWidth,
    sidebarDefaultWidth,
    sidebarIsRail,
    sidebarMaxWidth,
    sidebarMinWidth,
    sidebarRailWidth,
    stepSidebarWidth,
  } from './lib/sidebar-width';
  import ShipQueue from './ShipQueue.svelte';
  import TaskOverview from './TaskOverview.svelte';
  import type { GitHubIssue, PullRequestCheck } from './ProjectSidebar.svelte';
  import AgentWorkspace from './AgentWorkspace.svelte';
  import AgentStatusBar from './AgentStatusBar.svelte';
  import { resolveTaskLocation, type TaskLocation as TaskLocationValue } from './lib/task-location';
  import {
    checkKey,
    personalChecks,
    upsertCheck,
    type PostTurnCheck,
  } from './lib/post-turn-checks';
  import HarnessIcon from './HarnessIcon.svelte';
  import OptionPicker from './OptionPicker.svelte';
  import { promptSkill, type SkillChoice } from './lib/skills';
  import { bundledSkills } from './lib/bundled-skills';
  import { parseValidationSettings, validationSettingsKey } from './lib/cross-validation';
  import {
    hasUnresolvedModelAlias,
    selectValidationChoice,
    type ValidationRoute,
  } from './lib/cross-validation';
  import {
    abandonImplementationTurn,
    activeImplementationModels,
    assertShipItIssueRepository,
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
  import {
    assertAutomaticPermissionAllowed,
    permissionChoiceForPolicy,
    permissionResolver,
    type AutomaticPermissionRequest,
  } from './lib/permission-resolution';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import type { Confirmation } from './ConfirmDialog.svelte';
  import PaneTree from './PaneTree.svelte';
  import InboxPanel from './InboxPanel.svelte';
  import {
    applyAttentionLifecycle,
    attentionRoute,
    attentionSurfaceCounts,
    dismissAttention,
    isAttentionTarget,
    loadAttentionLedger,
    nextAttentionItem,
    sessionRequestCandidates,
    shipAttentionCandidates,
    shipReceiptIds,
    snoozeAttention,
    snoozeUntil,
    subagentAttentionCandidates,
    threadRequestKeys,
    type AttentionItem,
    type AttentionLedger,
    type AttentionSnooze,
    type AttentionTarget,
  } from './lib/attention-items';
  import {
    attentionNotificationType,
    createNotificationCoalescer,
    legacyNotificationsKey,
    loadNotificationPrefs,
    notificationAllowed,
    notificationPrefsKey,
    type NotificationPrefs,
  } from './lib/notification-prefs';
  import {
    detectShortcutPlatform,
    matches as shortcutMatches,
    shortcutFor,
    terminalOwnsKey,
    shortcutLabel,
    ariaKeyShortcutsFor,
    shortcuts as shortcutRegistry,
  } from './lib/shortcuts';
  import { subagentNavigation } from './lib/subagent-nav';
  import {
    parentTurnStopHint,
    answeredPermissionKey,
    permissionAlreadyAnswered,
    permissionResolution,
    shipOwnedTargetKey,
    stoppableSubagents,
    subagentStop,
    type AnsweredPermission,
    type SubagentControl,
  } from './lib/subagent-control';
  import {
    failedCheckOutcome,
    inboxLocations,
    inboxPermissionDecisionTitle,
    inboxTurnMessageIndex,
    isInboxOutcome,
    loadInboxOutcomes,
    markInboxOutcomeRead,
    recordInboxOutcome,
    sortInbox,
    type InboxItem,
    type InboxCheck,
    type InboxOutcome,
  } from './lib/inbox';
  import {
    locationName,
    paletteActions,
    searchCommandPalette,
    type PaletteActionId,
    type PaletteEntry,
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
    listSidebarAcpThreads,
    recordSidebarOpenCodeOutcome,
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
    acpDisconnectAffectsSession,
    acpDisconnectedSessionIds,
    acpEventMatchesSession,
    acpFailedPromptInterrupted,
    acpPromptInterrupted,
    applyLiveTranscriptUpdate,
    forgetRecentTranscript,
    invalidateLiveTranscript,
    loadAgentThreads,
    mergeAgentThreadActivity,
    mergeAgentThreadRename,
    mergeAgentThreadUpdate,
    normalizeAgentThreadKeywords,
    loadInterruptedAgentTurns,
    loadRecentTranscript,
    rememberSessionState,
    saveAgentThreads,
    tracksLiveTranscript,
    updateEntriesInPlace,
    type AgentCommand,
    type AgentConfigOption,
    type AgentActivity,
    type AgentEntry,
    type AgentAvailability,
    type AgentEvent,
    type AgentId,
    type AgentThread,
    type InterruptedAgentTurn,
  } from './lib/acp';
  import { acpPermissionActivitySourceId } from './lib/acp-permissions';
  import { type PlanSnapshot } from './lib/plan';
  import { copyCompletedSelection, copyStatusHost } from './lib/auto-copy';
  import {
    coordinationKey,
    coordinationPrompt,
    enqueueCoordinationMessage,
    loadCoordinationMessages,
    projectWorktreeInfo,
    type CoordinationMessage,
    type RegisteredWorktree,
  } from './lib/coordination';
  import {
    acpReceiptState,
    acpPromptHasBackendEvidence,
    acpReplacementDispatchAction,
    acpTurnEvidenceState,
    acpTurnNeedsProviderInspection,
    acpTurnPromptCanRetry,
    activeSpawnReceiptForThread,
    activeSubagentsForSource,
    handoffReceiptForInterruptedTurn,
    handoffReceiptNeedsResolution,
    handoffPromptNeedsRecovery,
    loadSpawnReceipts,
    receiptForSource,
    receiptIsLatestFinishedTurn,
    replayResultForReceipt,
    receiptMatchesTurn,
    receiptNeedsRefresh,
    receiptIsSettled,
    receiptSourceId,
    pendingHandoffReplacement,
    replacementReceiptForInspection,
    resolvedHandoffRecoveryError,
    saveBoundedReceipt,
    spawnPromptDispatchAllowed,
    spawnReceiptsForSource,
    type ReplacementDispatchAction,
    type SpawnReceipt,
    type SpawnState,
  } from './lib/agent-results';
  import {
    disconnectNativeSubagents,
    finalizeNativeSubagentRestore,
    nativeSubagentAcceptsPrompts,
    nativeSubagentId,
    nativeSubagentReceipts,
    nativeSubagentThreads as threadsForNativeSubagents,
    reconcileNativeSubagents,
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
    defaultResourceLimits,
    isCheckingMachinePressure,
    parseResourceLimit,
    resourceLimitKeys,
    setResourceLimit,
    setPressureThresholds,
  } from './lib/resource-limits';
  import {
    defaultPressureThresholds,
    parsePressureThreshold,
    pressureThresholdKeys,
  } from './lib/machine-pressure';
  import {
    parseThemePreference,
    resolveTheme,
    systemDarkQuery,
    themeSettingKey,
    watchSystemDark,
    type ThemePreference,
  } from './lib/theme';
  import {
    commandsForDirectory,
    loadSavedCommands,
    selectedRepository,
    type SavedCommand,
  } from './lib/saved-commands';
  import { annotateDiffs, repoPath, selectedDiffFile, type WorkingDiffInfo } from './lib/diff';
  import type { DiffComment } from './lib/diff-comments';
  import {
    automaticCaptureControl,
    persistAutomaticCapture,
    type MemoryStatus,
  } from './lib/memory-capture';

  interface MemoryCaptureCandidate {
    directory: string;
    agent: string;
    sessionId: string;
    kind: 'decision' | 'constraint' | 'discovery' | 'preference' | 'handoff';
    content: string;
    confirmationReason: 'sensitive' | 'broader_scope' | null;
  }

  import {
    browserReviewPreviews,
    retainCaptureMetadata,
    selectReviewPreview,
    type ReviewCapture,
    type ReviewPreview,
  } from './lib/review-evidence';
  import { acpUsage, type AgentUsage, type RateWindow } from './lib/agent-usage';
  import { buildAgentStatusItems, statusBarAttentionCount } from './lib/agent-status';
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
    owningRepository,
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

  let themePreference = $state<ThemePreference>(parseThemePreference(getSetting(themeSettingKey)));
  let systemDark = $state(globalThis.matchMedia?.(systemDarkQuery).matches ?? false);
  const dark = $derived(resolveTheme(themePreference, systemDark) === 'dark');
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
  const initialShipArchiveDelay = parseShipArchiveDelay(getSetting('sai-ship-archive-delay'));
  const storedShipRuns = loadShipRunStore(getSetting('sai-ship-runs'));
  // Entries this build cannot parse are written back with every save instead of being lost.
  const unparsedShipRuns = storedShipRuns.unparsed;
  const shipArchiveMigration =
    getSetting(shipArchiveMigrationKey) === 'done'
      ? null
      : migrateShipArchive(storedShipRuns.runs, initialShipArchiveDelay, Date.now());
  const initialShipRuns = shipArchiveMigration?.runs ?? storedShipRuns.runs;
  const initialShipArchiveNotice = shipArchiveMigration?.archived
    ? shipArchiveMigration.archived
    : Number(getSetting('sai-ship-archive-notice')) || 0;
  if (shipArchiveMigration) {
    if (shipArchiveMigration.archived > 0) {
      setSetting('sai-ship-runs', serializeShipRuns(initialShipRuns, unparsedShipRuns));
      setSetting('sai-ship-archive-notice', String(initialShipArchiveNotice));
    }
    setSetting(shipArchiveMigrationKey, 'done');
  }
  let shipArchiveDelay = $state<ShipArchiveDelay>(initialShipArchiveDelay);
  let shipRuns = $state<ShipRun[]>(initialShipRuns);
  let shipArchiveNotice = $state(initialShipArchiveNotice);

  function capabilityProfileForShipThread(path: string, threadId?: string): CapabilityProfile {
    if (!threadId) return 'build';
    const owner = shipCheckpointOwner(
      shipRuns.filter((run) => !shipRunArchived(run)),
      path,
      threadId,
    );
    return capabilityProfileForPhase(owner?.issue.checkpoint?.phase);
  }

  function capabilityProfileForAcpSession(
    agent: AgentId,
    path: string,
    sessionId: string,
    fallback?: CapabilityProfile,
  ): CapabilityProfile {
    return (
      agentThreads.find(
        (thread) =>
          thread.agent === agent && thread.directory === path && thread.sessionId === sessionId,
      )?.capabilityProfile ??
      nativeChildThreads.find(
        (thread) =>
          thread.agent === agent && thread.directory === path && thread.sessionId === sessionId,
      )?.capabilityProfile ??
      fallback ??
      'build'
    );
  }

  function effectiveCapabilityProfileForAcpSession(
    agent: AgentId,
    path: string,
    sessionId: string,
    fallback?: CapabilityProfile,
  ): CapabilityProfile {
    return intersectCapabilityProfiles(
      capabilityProfileForAcpSession(agent, path, sessionId, fallback),
      capabilityProfileForShipThread(path, receiptSourceId(agent, sessionId)),
    );
  }

  function liveInboxPermissionPolicy(item: InboxItem, thread?: AgentThread) {
    if (item.kind !== 'acp-permission') return item.policy;
    const owner =
      thread ??
      [...agentThreads, ...nativeChildThreads].find(
        (entry) =>
          entry.agent === item.agentId &&
          entry.sessionId === item.sessionId &&
          entry.directory === item.directory,
      );
    if (!owner) return item.policy;
    return automaticPermissionPolicy({
      profile: effectiveCapabilityProfileForAcpSession(
        owner.agent,
        owner.directory,
        owner.sessionId,
        owner.capabilityProfile,
      ),
      workspace: owner.directory,
      title: item.permissionTitle ?? item.text,
      toolCall: item.permissionToolCall,
      options: item.options ?? [],
      resourceTrust: item.permissionResourceTrust,
    });
  }

  function withLiveInboxPermissionPolicy(item: InboxItem): InboxItem {
    const policy = liveInboxPermissionPolicy(item);
    if (item.kind !== 'acp-permission' || !policy) return item;
    return {
      ...item,
      policy,
      allow: policy.recommendation !== 'deny',
      text: permissionDecisionTitle(item.permissionTitle ?? item.text, policy),
    };
  }
  let shippingBusy = $state(false);
  const activeShipLaunches = new SvelteSet<string>();
  const fencedShipLaunches = new SvelteSet<string>();
  const shipClaimHeartbeatDeadlines = new SvelteMap<string, number>();
  const shipClaimLeaseDeadlines = new SvelteMap<string, number>();
  const shipClaimLeaseWallDeadlines = new SvelteMap<string, number>();
  const shipClaimLeaseFenceTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>();
  const shipClaimResumeValidations = new SvelteSet<string>();
  const shipClaimResumeFences = new SvelteMap<string, Promise<void>>();
  const shippingPromptGenerations = new SvelteMap<string, number>();
  const shippingPromptDispatches = createPromptDispatchTracker();
  const shipClaimOperations = new SvelteMap<string, Promise<void>>();
  const shippingInstanceId = crypto.randomUUID();
  let shippingClockWall = Date.now();
  let shippingClockMonotonic = performance.now();
  const ciRerunPolicy: CiRerunPolicy = {
    allowed: ['flaky', 'infrastructure'],
    maxAttempts: 2,
  };
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
  type CreatedWorktree = {
    path: string;
    branch: string;
    base: string;
    setup: string;
    shippingTarget?: ShippingTarget;
  };
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
  let memoryRecallAvailable = $state(false);
  let memoryRecallEnabled = $state(false);
  let memoryRecallProjectKey = $state('');
  let memoryRecallBusy = $state(false);
  let memoryRecallRefresh = 0;
  let memoryCaptureAvailable = $state(false);
  let memoryCaptureEnabled = $state(false);
  let memoryCaptureProjectKey = $state('');
  let memoryCaptureBusy = $state(false);
  let memoryCaptureRefresh = 0;
  type BrowserAccessRequest = { id: string; sessionId: string; directory: string; origin?: string };
  type CoordinationRequest = {
    id: string;
    sessionId: string;
    sourceAgent: string | null;
    directory: string;
    name:
      | 'worktree_create'
      | 'agent_spawn'
      | 'validation_policy'
      | 'validation_gate'
      | 'ship_progress'
      | 'task_checkpoint_read'
      | 'task_checkpoint_update'
      | 'task_evidence_record'
      | 'sail_plan_propose'
      | 'sail_plan_ask'
      | 'sail_plan_step'
      | 'sail_plan_amend'
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
      | 'thread_keywords'
      | 'project_threads'
      | 'thread_message'
      | 'capability_check';
    arguments: Record<string, unknown>;
    expiresAt: number;
  };
  type CoordinationThread = {
    id: string;
    directory: string;
    title: string;
    agent: string;
  };
  type CoordinationSource = {
    kind: 'acp';
    agent: string;
    model?: string;
    variant?: string;
    title: string;
  };
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
  const spawnTargetKey = (path: string, targetId: string) => JSON.stringify([path, targetId]);
  for (const receipt of initialSpawnReceipts) {
    if (
      receipt.targetId &&
      receipt.turnId &&
      (receipt.state === 'working' || receipt.state === 'waiting')
    )
      activeSpawnTargets.set(
        spawnTargetKey(receipt.targetDirectory ?? '', receipt.targetId),
        receipt.receiptId,
      );
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
    validation?: ShipValidationConfig;
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

  function confirmInApp(
    title: string,
    message: string,
    confirmLabel: string,
    { destructive = false }: { destructive?: boolean } = {},
  ): Promise<boolean> {
    const pending = confirmationQueue.then(
      () =>
        new Promise<boolean>((resolve) => {
          confirmationResolver = resolve;
          confirmation = { id: crypto.randomUUID(), title, message, confirmLabel, destructive };
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

  async function captureProjectMemory(candidate: MemoryCaptureCandidate) {
    try {
      const status = await invoke<MemoryStatus>('memory_status', {
        directory: candidate.directory,
      });
      if (!status.enabled || getSetting(`sai-memory-auto-capture:${status.projectKey}`) !== 'true')
        return;
      if (candidate.confirmationReason) {
        const reason =
          candidate.confirmationReason === 'sensitive'
            ? 'Sensitive values were removed before this preview.'
            : 'This memory may apply beyond the current task.';
        const confirmed = await confirmInApp(
          'Save shared memory?',
          `${reason}\n\n${candidate.kind}: ${candidate.content}`,
          'Save memory',
        );
        if (!confirmed) return;
      }
      await invoke('memory_remember', {
        directory: candidate.directory,
        input: {
          content: candidate.content,
          kind: candidate.kind,
          tags: ['automatic-capture'],
          provenance: { agent: candidate.agent, sessionId: candidate.sessionId },
        },
      });
    } catch (cause) {
      error = `Could not capture shared memory: ${describe(cause)}`;
    }
  }
  let editingCommand = $state<string | null>(null);
  let binaryPath = $state(getSetting('sai-opencode-bin') ?? '');
  let agentAvailability = $state<AgentAvailability[]>([]);
  let agentDetectionError = $state('');
  let agentThreads = $state<AgentThread[]>(savedAgentThreads);
  let nativeSubagents = $state<NativeSubagentStore>({});
  let nativeSubagentGeneration = 0;
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
      if (issue)
        void adoptDirectShipRun(issue, path, `acp:${agent}:${sessionId}`, model).catch(
          (cause) => (error = describe(cause)),
        );
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
  const notificationLoad = loadNotificationPrefs(
    getSetting(notificationPrefsKey),
    getSetting(legacyNotificationsKey),
  );
  let notificationPrefs = $state<NotificationPrefs>(notificationLoad.prefs);
  if (notificationLoad.migrated)
    setSetting(notificationPrefsKey, JSON.stringify(notificationLoad.prefs));
  let crossValidation = $state(parseValidationSettings(getSetting(validationSettingsKey)));
  let modelRouting = $state(parseModelRoutingSettings(getSetting(modelRoutingSettingsKey)));
  let resourceLimits = $state({
    agent: parseResourceLimit(getSetting(resourceLimitKeys.agent), defaultResourceLimits.agent),
    browser: parseResourceLimit(
      getSetting(resourceLimitKeys.browser),
      defaultResourceLimits.browser,
    ),
    e2e: parseResourceLimit(getSetting(resourceLimitKeys.e2e), defaultResourceLimits.e2e),
  });
  let pressureThresholds = $state({
    memoryFreePercent: parsePressureThreshold(
      getSetting(pressureThresholdKeys.memoryFreePercent),
      defaultPressureThresholds.memoryFreePercent,
    ),
    swapUsedPercent: parsePressureThreshold(
      getSetting(pressureThresholdKeys.swapUsedPercent),
      defaultPressureThresholds.swapUsedPercent,
    ),
    diskFreePercent: parsePressureThreshold(
      getSetting(pressureThresholdKeys.diskFreePercent),
      defaultPressureThresholds.diskFreePercent,
    ),
  });
  let contextHandoffThreshold = $state(
    parseContextHandoffThreshold(getSetting('sai-context-handoff-threshold')),
  );
  let notificationSound = $state(getSetting('sai-notification-sound') !== 'false');
  let autoCopyEnabled = $state(getSetting('sai-auto-copy-enabled') !== 'false');
  let copiedStatus = $state('');
  let copiedStatusTimer: ReturnType<typeof setTimeout> | undefined;
  let copyStatusRegion: HTMLDivElement;
  let copyStatusHome: { parent: Node; next: Node | null } | undefined;
  let shortcutsDialog: HTMLDialogElement;
  const shortcutPlatform = detectShortcutPlatform();
  let agentWorktreesEnabled = $state(getSetting('sai-agent-worktrees-enabled') !== 'false');
  let agentTerminalsEnabled = $state(getSetting('sai-agent-terminals-enabled') === 'true');
  let agentStatusEnabled = $state(getSetting('sai-agent-status-enabled') !== 'false');
  let agentThreadListEnabled = $state(getSetting('sai-agent-thread-list-enabled') !== 'false');
  let agentMessagesEnabled = $state(getSetting('sai-agent-messages-enabled') !== 'false');
  let mergeOwner = $state<MergeOwner>(parseMergeOwner(getSetting('sai-ship-merge-owner')));
  let inboxItems = $state<InboxItem[]>([]);
  let liveInboxItems = $derived(inboxItems.map(withLiveInboxPermissionPolicy));
  let attentionLedger = $state<AttentionLedger>(
    loadAttentionLedger(getSetting('sai-attention-ledger')),
  );
  let attentionClock = $state(Date.now());
  let lastAttentionId = $state<string | null>(null);
  let shipFocusRequest = $state<{
    id: number;
    runId: string;
    issueId: string;
    focus: 'issue' | 'pull-request';
  } | null>(null);
  let sessionAttention = $derived(sessionRequestCandidates(liveInboxItems));
  let attentionView = $derived(
    applyAttentionLifecycle(
      attentionLedger,
      [
        ...sessionAttention,
        ...shipAttentionCandidates(
          shipRuns.filter((run) => !shipRunArchived(run)),
          {
            mergeOwner,
            now: attentionClock,
            requestThreads: threadRequestKeys(sessionAttention),
          },
        ),
        ...subagentAttentionCandidates(
          visibleSpawnReceipts,
          threadRequestKeys(sessionAttention),
          shipReceiptIds(shipRuns),
        ),
      ],
      attentionClock,
    ),
  );
  let attentionItems = $derived(attentionView.items);
  let attentionCounts = $derived(attentionSurfaceCounts(attentionItems));
  let stateAttentionItems = $derived(attentionItems.filter((item) => item.dismissible));
  let notifiedAttention = new Set<string>();
  let attentionBaselined = false;

  $effect(() => {
    const view = attentionView;
    if (view.changed) {
      attentionLedger = view.ledger;
      setSetting('sai-attention-ledger', JSON.stringify(view.ledger));
    }
  });

  $effect(() => {
    const count = attentionCounts.dock;
    if (isTauri()) void invoke('set_attention_badge', { count }).catch(() => undefined);
  });

  $effect(() => {
    const items = attentionItems;
    if (attentionBaselined)
      for (const item of items) {
        if (!item.kind.startsWith('ship-') || notifiedAttention.has(item.id)) continue;
        notifications.enqueue({
          type: attentionNotificationType(item.kind),
          target: item.target,
          title: `Ship · ${item.title}`,
          body: item.detail ?? 'Needs your attention',
        });
      }
    attentionBaselined = true;
    notifiedAttention = new Set(items.map((item) => item.id));
  });
  let inboxOutcomes = $state<InboxOutcome[]>(loadInboxOutcomes(getSetting('sai-inbox-outcomes')));
  let durableActivityHistory = $state<ActivityHistoryEvent[]>(
    loadActivityHistory(getSetting('sai-activity-history')),
  );
  $effect(() => sharedActivityHistory.set(durableActivityHistory));
  let inboxLoading = $state(false);
  let inboxError = $state('');
  let inboxDialog: HTMLDialogElement;
  let inboxRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let inboxGeneration = 0;
  // Requests resolved since a refresh started; that refresh's stale list must not bring them back.
  const resolvedDuringRefresh = new SvelteMap<string, number>();
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
  let paletteLoading = $state(false);
  let paletteBusy = $state(false);
  let paletteError = $state('');
  let paletteSessionGeneration = 0;
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
  const paletteRepository = $derived('repository' in paletteStep ? paletteStep.repository : '');
  const paletteLocation = $derived('directory' in paletteStep ? paletteStep.directory : '');
  const paletteAgentID = $derived('agent' in paletteStep ? paletteStep.agent : '');
  const paletteEntries = $derived.by(() =>
    searchCommandPalette({
      step: paletteStep,
      query: paletteQuery,
      catalog: projectCatalog,
      currentDirectory: directory,
      agents: agentAvailability,
      threads: [...agentThreads, ...sidebarOpenCodeThreads],
      commands: savedCommands,
      actions: paletteActions({
        theme: themePreference,
        overview: workspaceView === 'overview',
        hasDirectory: !!directory,
      }),
      runningThreadKeys: Object.keys(runningAgentThreads),
    }),
  );
  let pickedAttachments = $state<Record<string, BrowserAttachment>>({});
  let reviewCaptures = $state<(ReviewCapture & { directory: string })[]>([]);
  let mainDiffEvidenceUpdated = $state(Date.now());
  let diffComments = $state<Record<string, DiffComment[]>>({});
  let pendingAgentBatches = $state<
    Record<string, { id: string; text: string; leavePlanMode?: boolean }>
  >({});
  let issuePrefills = $state<Record<string, { id: string; text: string }>>({});
  let agentEntrySnapshots = $state.raw<
    Record<string, { sessionId: string | null; entries: AgentEntry[]; ready: boolean }>
  >({});
  $effect(() => {
    const active = new Set(
      leaves(paneLayout)
        .filter((leaf) => leaf.agent)
        .map((leaf) => leaf.id),
    );
    const retained = Object.entries(agentEntrySnapshots).filter(([id]) => active.has(id));
    if (retained.length !== Object.keys(agentEntrySnapshots).length)
      agentEntrySnapshots = Object.fromEntries(retained);
  });
  const batchWaiters = new SvelteMap<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  let openingSettings = false;
  let settingsCreation: Promise<void> | null = null;
  let closingMain = false;
  let editingThread = $state<AgentThread | null>(null);
  let editedTitle = $state('');
  let renameSessionDialog: HTMLDialogElement;
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
      !acpAgent
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
  let nativePlan = $state<NativePlan | null>(null);
  let nativePlanFeedback = $state('');
  let nativePlanRevision = $state<{ id: string; feedback: string } | null>(null);
  let nativePlanRevisionPending = $state(false);
  let nativePlanRevisionError = $state('');
  let diffs = $state<WorkingDiffInfo[]>([]);
  let diffLoading = $state(false);
  let diffError = $state('');
  let selectedFilePath = $state<string | null>(null);
  type SideTab = 'plan' | 'planhistory' | 'changes' | 'history' | 'ship';
  let sideTab = $state<SideTab>('plan');
  let detailsOpen = $state(true);
  let diffRefresh = 0;
  let diffRevision = '';
  let diffRevisionPath = '';

  function requestNativePlanRevision() {
    const feedback = nativePlanFeedback.trim();
    if (!feedback) {
      nativePlanRevisionError = 'Describe what should change before requesting a revision.';
      return;
    }
    nativePlanRevisionError = '';
    nativePlanRevisionPending = true;
    nativePlanRevision = { id: crypto.randomUUID(), feedback };
  }

  function finishNativePlanRevision(id: string, failure: string | null) {
    if (nativePlanRevision?.id !== id) return;
    nativePlanRevisionPending = false;
    nativePlanRevision = null;
    nativePlanRevisionError = failure ?? '';
    if (!failure) nativePlanFeedback = '';
  }
  const skills: SkillChoice[] = bundledSkills;
  let mobileView = $state<'sessions' | 'chat' | 'details'>('chat');
  let workspaceView = $state<'workspace' | 'overview' | 'ship-queue'>(
    ['overview', 'ship-queue'].includes(getSetting('sai-workspace-view') ?? '')
      ? (getSetting('sai-workspace-view') as 'overview' | 'ship-queue')
      : 'workspace',
  );
  let sidebarVisible = $state(true);
  let mobileLayout = $state(window.matchMedia('(max-width: 850px)').matches);
  const savedDetailsWidth = Number(getSetting('sai-details-width'));
  let detailsWidth = $state(
    Number.isFinite(savedDetailsWidth) && savedDetailsWidth >= 320 ? savedDetailsWidth : 420,
  );
  let workspaceWidth = $state(0);
  let shellWidth = $state(window.innerWidth);
  let sidebarWidth = $state(parseSidebarWidth(getSetting('sai-sidebar-width')));
  let sidebarResizeStart: { x: number; width: number } | null = null;
  let appShellElement = $state<HTMLDivElement>();
  let resizeStart: { x: number; width: number } | null = null;
  let error = $state('');
  let sidebarElement: HTMLElement;
  let sidebarToggleElement = $state<HTMLButtonElement>();
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
    const update = () => {
      shellWidth = element.clientWidth;
      workspaceWidth = element.clientWidth - sidebarElement.clientWidth;
    };
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
    if (view === 'details') {
      const pane =
        focusedPane === 'main' ? null : leaves(paneLayout).find((item) => item.id === focusedPane);
      if (pane?.agent) {
        if (!changesPanes.includes(focusedPane)) changesPanes = [...changesPanes, focusedPane];
      } else if (mainShipFallback || !acpAgent) {
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
    sideTab = tab;
    await tick();
    restoreSideScroll();
    if (tab === 'changes' && acpAgent) void refreshAgentDiff();
  }

  function revealMainPlan(scope: PlanScope, reason: string) {
    if (!acpPlanScope || planKey(scope) !== planKey(acpPlanScope)) return;
    if (!['proposed', 'questions', 'amended', 'checkpoint', 'done'].includes(reason)) return;
    sideTab = 'plan';
    agentChangesOpen = true;
    if (window.matchMedia('(max-width: 850px)').matches) mobileView = 'details';
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
    toggleShipRuns();
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

  let diffPollTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let selection = 0;
  const paneSelections = new SvelteMap<string, number>();
  let sidebarInventoryGeneration = 0;
  let sidebarInventoryTimer: ReturnType<typeof setTimeout> | undefined;
  let projectLoadGeneration = 0;

  let actionAgentThread = $derived(
    focusedPane === 'main' ? acpThread : focusedLeaf?.agent ? focusedLeaf.thread : null,
  );
  let focusedConversationTitle = $derived(
    focusedPane !== 'main'
      ? (focusedLeaf?.thread?.title ??
          (focusedLeaf?.agent ? `New ${focusedLeaf.agent} thread` : 'Workspace'))
      : acpAgent
        ? (acpThread?.title ?? `New ${acpAgent} thread`)
        : 'New session',
  );
  let navigableReceipts = $derived(visibleSpawnReceipts);
  let subagentNav = $derived.by(() => {
    const focused = actionAgentThread
      ? {
          agent: actionAgentThread.agent,
          sessionId: actionAgentThread.sessionId,
          directory: actionAgentThread.directory,
        }
      : null;
    return subagentNavigation(navigableReceipts, focused);
  });
  let subagentParentTitle = $derived.by(() => {
    const parent = subagentNav?.parent;
    if (!parent) return '';
    const thread = [...agentThreads, ...nativeChildThreads, ...sidebarOpenCodeThreads].find(
      (item) =>
        item.directory === parent.directory &&
        receiptSourceId(item.agent, item.sessionId) === parent.threadId,
    );
    return thread?.title ?? 'Parent thread';
  });
  function goToSubagentTarget(target: { directory: string; threadId: string } | null | undefined) {
    if (!target) return;
    void openShipTarget(target.directory, target.threadId).catch(
      (cause) => (error = describe(cause)),
    );
  }
  function goToSubagentSibling(direction: -1 | 1) {
    goToSubagentTarget(direction < 0 ? subagentNav?.previous : subagentNav?.next);
  }
  let answeredPermissions = $state<AnsweredPermission[]>([]);
  // Inbox items can go before their resolution event arrives, so their titles are kept here.
  const permissionTitles = new SvelteMap<string, string>();
  $effect(() => {
    const items = inboxItems;
    untrack(() => {
      for (const item of items)
        if (item.kind === 'acp-permission' && item.permissionTitle)
          permissionTitles.set(item.key, item.permissionTitle);
    });
  });
  function recordAnsweredPermission(
    agentId: string,
    worktreeDirectory: string,
    sessionId: string,
    params: Record<string, unknown> | undefined,
  ) {
    const requestId = params?.requestId;
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return;
    const inboxKey = `acp:${worktreeDirectory}:${agentId}:${sessionId}:${requestId}`;
    const key = JSON.stringify([
      worktreeDirectory,
      answeredPermissionKey(agentId, sessionId, requestId, params),
    ]);
    const title =
      inboxItems.find((item) => item.key === inboxKey)?.permissionTitle ??
      permissionTitles.get(inboxKey) ??
      'Permission request';
    permissionTitles.delete(inboxKey);
    if (answeredPermissions.some((item) => item.key === key)) return;
    answeredPermissions = [
      ...answeredPermissions,
      {
        key,
        agentId,
        directory: worktreeDirectory,
        sessionId,
        title,
        outcome: permissionResolution(params),
      },
    ].slice(-50);
  }
  const shipOwnedThreads = $derived.by(() => {
    const owned = new SvelteSet<string>();
    for (const issue of shipRuns.flatMap((run) => run.issues)) {
      if (!issue.path) continue;
      if (issue.threadId) owned.add(shipOwnedTargetKey(issue.path, issue.threadId));
      for (const id of issue.checkpointThreadIds ?? [])
        owned.add(shipOwnedTargetKey(issue.path, id));
    }
    return owned;
  });
  async function stopSubagent(receipt: SpawnReceipt) {
    const policy = subagentStop(receipt, shipOwnedThreads);
    if (policy === 'parent-turn') throw new Error(parentTurnStopHint);
    if (policy !== 'stop' || !receipt.targetId || !receipt.targetDirectory)
      throw new Error('This subagent stops through Stop run.');
    const match = /^acp:([^:]+):(.+)$/.exec(receipt.targetId);
    if (!match) throw new Error('This subagent cannot be stopped safely.');
    await acp.cancel(match[1]!, receipt.targetDirectory, match[2]!, receipt.turnId);
    updateSpawnReceipt(receipt.receiptId, { state: 'interrupted' });
  }
  async function stopAllSubagents(receipts: SpawnReceipt[]) {
    const targets = stoppableSubagents(receipts, shipOwnedThreads);
    if (!targets.length) return;
    const confirmed = await confirmInApp(
      'Stop all subagents?',
      `This stops ${targets.length} running subagents. Ship workers and validation gates keep running; stop them with Stop run.`,
      'Stop all',
      { destructive: true },
    );
    if (!confirmed) return;
    const results = await Promise.allSettled(targets.map((receipt) => stopSubagent(receipt)));
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length)
      throw new Error(
        `${failed.length} of ${targets.length} subagents did not stop: ${describe(failed[0]!.reason)}`,
      );
  }
  const subagentControl = $derived<SubagentControl>({
    permissions: liveInboxItems,
    answered: answeredPermissions,
    shipOwned: shipOwnedThreads,
    ondecide: decideInbox,
    onstop: stopSubagent,
    onstopall: stopAllSubagents,
  });
  let mainAgentWorkspaceActivity = $state<WorkspaceActivityItem[]>([]);
  let selectMainAgentWorkspaceActivity = $state<(item: WorkspaceActivityItem) => Promise<void>>(
    async () => {
      throw new Error('The activity source is unavailable.');
    },
  );
  const activityHistory = $derived.by(() => {
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
    const cachedThreads = new Map(
      [...agentThreads, ...nativeThreads].map((thread) => [threadKey(thread), thread]),
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
        sourceId: inboxDecisionActivitySourceId(item),
        title: item.text,
        outcome: 'waiting',
        at: item.receivedAt,
        agent: item.agentId,
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
  let maxDetailsWidth = $derived(Math.max(320, workspaceWidth - 308));
  let visibleDetailsWidth = $derived(Math.min(detailsWidth, maxDetailsWidth));

  function setDetailsWidth(width: number) {
    detailsWidth = Math.min(maxDetailsWidth, Math.max(320, Math.round(width)));
    setSetting('sai-details-width', String(detailsWidth));
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

  let maxSidebarWidth = $derived(
    Math.max(sidebarMinWidth, Math.min(sidebarMaxWidth, Math.floor(shellWidth * 0.4))),
  );
  let visibleSidebarWidth = $derived(clampSidebarWidth(sidebarWidth, maxSidebarWidth));
  let sidebarRail = $derived(sidebarIsRail(visibleSidebarWidth) && !mobileLayout);

  function setSidebarWidth(width: number) {
    sidebarWidth = clampSidebarWidth(width, maxSidebarWidth);
    setSetting('sai-sidebar-width', String(sidebarWidth));
  }

  function startSidebarResize(event: PointerEvent) {
    if (event.button !== 0) return;
    sidebarResizeStart = { x: event.clientX, width: sidebarElement.getBoundingClientRect().width };
    if (event.currentTarget instanceof HTMLElement)
      event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveSidebarResize(event: PointerEvent) {
    if (!sidebarResizeStart) return;
    sidebarWidth = clampSidebarWidth(
      sidebarResizeStart.width + event.clientX - sidebarResizeStart.x,
      maxSidebarWidth,
    );
  }

  function endSidebarResize() {
    if (!sidebarResizeStart) return;
    sidebarResizeStart = null;
    setSetting('sai-sidebar-width', String(sidebarWidth));
  }

  function keydownSidebarResize(event: KeyboardEvent) {
    const step = event.shiftKey ? 50 : 20;
    const width =
      event.key === 'ArrowRight'
        ? stepSidebarWidth(visibleSidebarWidth, step, maxSidebarWidth)
        : event.key === 'ArrowLeft'
          ? stepSidebarWidth(visibleSidebarWidth, -step, maxSidebarWidth)
          : event.key === 'Home'
            ? sidebarRailWidth
            : event.key === 'End'
              ? maxSidebarWidth
              : null;
    if (width === null) return;
    event.preventDefault();
    setSidebarWidth(width);
  }

  let acpPlanTick = $state(0);
  let acpPlanScope = $derived<PlanScope | null>(
    acpAgent && acpThread ? { agent: acpAgent, directory, sessionId: acpThread.sessionId } : null,
  );
  let acpSnapshot = $derived.by((): PlanSnapshot => {
    void acpPlanTick;
    return acpPlanScope ? acpPlans().snapshot(acpPlanScope) : { plan: null, questions: null };
  });
  let acpPlanHistory = $derived.by(() => {
    void acpPlanTick;
    return acpPlanScope ? acpPlans().history(acpPlanScope) : [];
  });
  let mainPlanBackend = $derived(
    acpPlanScope
      ? acpPlanBackend(acpPlans(), acpPlanScope, {
          send: (text, options) => sendPlanMessage('main', text, options),
        })
      : null,
  );
  let showPlanPanel = $derived(!!nativePlan || !!acpSnapshot.plan || !!acpSnapshot.questions);
  let activeSideTab = $derived(
    sideTab === 'ship'
      ? 'ship'
      : showPlanPanel && sideTab === 'plan'
        ? 'plan'
        : acpAgent && sideTab === 'planhistory' && acpPlanHistory.length
          ? 'planhistory'
          : acpAgent && sideTab !== 'history'
            ? 'changes'
            : sideTab === 'history'
              ? 'history'
              : 'changes',
  );
  let mainDetailsVisible = $derived(
    workspaceView === 'workspace' &&
      !mainShipFallback &&
      !!(acpAgent || activeSideTab === 'ship') &&
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
  let diffAnnotations = $derived(
    annotateDiffs(diffs, acpAgent ? acpSnapshot.plan : null, directory),
  );

  function setTheme(preference: ThemePreference) {
    themePreference = preference;
    setSetting(themeSettingKey, preference);
  }

  $effect(() => {
    document.documentElement.dataset.suiTheme = dark ? 'dark' : 'light';
  });

  function settingsSnapshot(): SettingsSnapshot {
    return {
      theme: themePreference,
      binaryPath,
      directory,
      agents: agentAvailability,
      agentsError: agentDetectionError,
      crossValidation,
      modelRouting,
      notificationPrefs,
      notificationSound,
      autoCopyEnabled,
      personalPostTurnChecks,
      agentWorktreesEnabled,
      agentTerminalsEnabled,
      agentStatusEnabled,
      agentThreadListEnabled,
      agentMessagesEnabled,
      mergeOwner,
      shipArchiveDelay,
      contextHandoffThreshold,
      resourceLimits,
      pressureThresholds,
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

  function openLinkInSplit(event: Event) {
    if (event instanceof CustomEvent && typeof event.detail?.url === 'string')
      splitFocusedPane('row', 'browser', undefined, undefined, event.detail.url);
  }

  onMount(() => {
    window.addEventListener(OPEN_IN_SPLIT_EVENT, openLinkInSplit);
    let unlistenAgentEvents: (() => void) | undefined;
    let unlistenBrowserAccess: (() => void) | undefined;
    let unlistenCoordination: (() => void) | undefined;
    const unsubscribePlans = acpPlans().subscribe((change) => {
      acpPlanTick += 1;
      revealMainPlan(change.scope, change.reason);
    });
    let unlistenTerminalExit: (() => void) | undefined;
    const coordinationRetry = setInterval(() => {
      if (isTauri()) retryCoordinationDeliveries();
    }, 10_000);
    if (isTauri()) setTimeout(retryCoordinationDeliveries, 2_000);
    let unlistenAgentTerminals: (() => void) | undefined;
    let unlistenNotificationClick: (() => void) | undefined;
    let unlistenMemoryCapture: (() => void) | undefined;
    let stopEmulatedClick: (() => void) | undefined;
    setTheme(themePreference);
    const stopSystemTheme = watchSystemDark((value) => (systemDark = value));
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
      void listen<MemoryCaptureCandidate>('memory:capture-candidate', ({ payload }) => {
        void captureProjectMemory(payload);
      }).then((unlisten) => (unlistenMemoryCapture = unlisten));
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
              const agentActivity = await acp.activity(directory);
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
        if (action.type === 'theme') setTheme(action.value);
        else if (action.type === 'binary') {
          binaryPath = action.value.trim();
          void setSettingDurable('sai-opencode-bin', binaryPath).then(detectAgents, (cause) => {
            agentDetectionError = `Could not save the OpenCode binary: ${describe(cause)}`;
          });
        } else if (action.type === 'notification-pref') {
          notificationPrefs = { ...notificationPrefs, [action.notification]: action.value };
          setSetting(notificationPrefsKey, JSON.stringify(notificationPrefs));
        } else if (action.type === 'notification-sound') {
          notificationSound = action.value;
          setSetting('sai-notification-sound', String(action.value));
        } else if (action.type === 'auto-copy') {
          autoCopyEnabled = action.value;
          setSetting('sai-auto-copy-enabled', String(action.value));
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
        } else if (action.type === 'merge-owner') {
          mergeOwner = parseMergeOwner(action.value);
          setSetting('sai-ship-merge-owner', mergeOwner);
        } else if (action.type === 'ship-archive-delay') {
          shipArchiveDelay = parseShipArchiveDelay(action.value);
          setSetting('sai-ship-archive-delay', shipArchiveDelay);
          void archiveDueShipRuns();
        } else if (action.type === 'context-handoff-threshold') {
          const previousThreshold = contextHandoffThreshold;
          contextHandoffThreshold = parseContextHandoffThreshold(String(action.value));
          setSetting('sai-context-handoff-threshold', String(contextHandoffThreshold));
          if (contextHandoffThreshold < previousThreshold)
            for (const run of shipRuns)
              for (const issue of run.issues)
                if (
                  issue.state === 'working' &&
                  issue.path &&
                  issue.threadId &&
                  issue.contextPercent !== undefined &&
                  issue.contextPercent < previousThreshold
                )
                  void recordShipContextPressure(
                    issue.path,
                    issue.threadId,
                    issue.contextPercent,
                    Math.max(0, contextHandoffThreshold - contextCheckpointLead - 1),
                  ).catch((cause) => (error = describe(cause)));
        } else if (action.type === 'resource-limit') {
          if (Number.isSafeInteger(action.value) && action.value >= 0 && action.value <= 32) {
            resourceLimits = { ...resourceLimits, [action.kind]: action.value };
            setSetting(resourceLimitKeys[action.kind], String(action.value));
            if (action.kind !== 'e2e') setResourceLimit(action.kind, action.value);
          }
        } else if (action.type === 'pressure-threshold') {
          if (Number.isSafeInteger(action.value) && action.value >= 0 && action.value <= 100) {
            pressureThresholds = { ...pressureThresholds, [action.kind]: action.value };
            setSetting(pressureThresholdKeys[action.kind], String(action.value));
            setPressureThresholds(pressureThresholds);
          }
        } else if (action.type === 'detect-agents') void detectAgents();
        else if (action.type === 'cross-validation') {
          crossValidation = action.value;
          setSetting(validationSettingsKey, JSON.stringify(action.value));
        } else if (action.type === 'model-routing') {
          modelRouting = action.value;
          setSetting(modelRoutingSettingsKey, JSON.stringify(action.value));
        }
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
      if (import.meta.env.MODE === 'e2e') {
        const emulateClick = (event: Event) =>
          void openNotificationTarget((event as CustomEvent<unknown>).detail);
        window.addEventListener('sail-e2e-notification-click', emulateClick);
        stopEmulatedClick = () =>
          window.removeEventListener('sail-e2e-notification-click', emulateClick);
      }
      void listen<unknown>('sail-notification-click', ({ payload }) => {
        void openNotificationTarget(payload);
      }).then((unlisten) => {
        if (disposed) unlisten();
        else unlistenNotificationClick = unlisten;
        return undefined;
      });
      if (directory) {
        const initialDirectory = directory;
        void canonicalizeProject(initialDirectory).then(() =>
          Promise.all([
            refreshAutomaticMemoryRecall(initialDirectory),
            refreshAutomaticMemoryCapture(initialDirectory),
          ]),
        );
      }
    }
    const attentionTimer = setInterval(() => (attentionClock = Date.now()), 30_000);
    const shippingTimer = setInterval(() => void tickShippingRuns(), 15_000);
    void tickShippingRuns();
    const sidebarRefreshTimer = setInterval(scheduleSidebarInventoryRefresh, 30_000);
    diffPollTimer = setInterval(() => {
      const visible = !window.matchMedia('(max-width: 850px)').matches || mobileView === 'details';
      if (acpAgent && agentChangesOpen && activeSideTab === 'changes' && visible && !diffLoading)
        void refreshAgentDiff(true);
    }, 3000);
    return () => {
      window.removeEventListener(OPEN_IN_SPLIT_EVENT, openLinkInSplit);
      stopSettingsRequest?.();
      stopSettingsAction?.();
      stopCloseRequest?.();
      stopPaneClose?.();
      stopWorktreeClose?.();
      disposed = true;
      finishWorktreeApproval(false);
      clearInterval(coordinationRetry);
      clearInterval(shippingTimer);
      for (const timer of shipClaimLeaseFenceTimers.values()) clearTimeout(timer);
      shipClaimLeaseFenceTimers.clear();
      clearTimeout(inboxRefreshTimer);
      clearInterval(attentionTimer);
      notifications.dispose();
      clearInterval(sidebarRefreshTimer);
      clearTimeout(sidebarInventoryTimer);
      clearInterval(diffPollTimer);
      unlistenAgentEvents?.();
      unlistenBrowserAccess?.();
      unlistenCoordination?.();
      unsubscribePlans();
      unlistenTerminalExit?.();
      unlistenAgentTerminals?.();
      unlistenNotificationClick?.();
      unlistenMemoryCapture?.();
      stopEmulatedClick?.();
      stopSystemTheme();
    };
  });

  function toggleAgentBrowserAccess() {
    if (!directory) return;
    browserAccessDisabled = !browserAccessDisabled;
    setSetting(`sai-browser-disabled:${directory}`, String(browserAccessDisabled));
    void invoke('browser_project_access', {
      directory,
      enabled: !browserAccessDisabled,
    }).catch((cause) => (error = describe(cause)));
  }

  async function refreshAutomaticMemoryRecall(path: string) {
    const refresh = ++memoryRecallRefresh;
    memoryRecallAvailable = false;
    memoryRecallEnabled = false;
    memoryRecallProjectKey = '';
    try {
      const status = await invoke<{ enabled: boolean; projectKey: string }>('memory_status', {
        directory: path,
      });
      if (refresh !== memoryRecallRefresh || directory !== path) return;
      const control = automaticRecallControl(
        status,
        getSetting(`sai-memory-auto-recall:${status.projectKey}`),
      );
      memoryRecallAvailable = control.available;
      memoryRecallEnabled = control.enabled;
      memoryRecallProjectKey = control.projectKey;
    } catch (cause) {
      if (refresh === memoryRecallRefresh && directory === path)
        error = `Could not load automatic memory recall: ${describe(cause)}`;
    }
  }

  async function toggleAutomaticMemoryRecall() {
    if (!memoryRecallAvailable || memoryRecallBusy || !memoryRecallProjectKey) return;
    const projectKey = memoryRecallProjectKey;
    const enabled = !memoryRecallEnabled;
    memoryRecallBusy = true;
    try {
      await persistAutomaticRecall(projectKey, enabled);
      if (memoryRecallProjectKey === projectKey) memoryRecallEnabled = enabled;
    } catch (cause) {
      error = `Could not update automatic memory recall: ${describe(cause)}`;
    } finally {
      if (memoryRecallProjectKey === projectKey) memoryRecallBusy = false;
    }
  }

  async function refreshAutomaticMemoryCapture(path: string) {
    const refresh = ++memoryCaptureRefresh;
    memoryCaptureAvailable = false;
    memoryCaptureEnabled = false;
    memoryCaptureProjectKey = '';
    try {
      const status = await invoke<MemoryStatus>('memory_status', { directory: path });
      if (refresh !== memoryCaptureRefresh || directory !== path) return;
      const control = automaticCaptureControl(
        status,
        getSetting(`sai-memory-auto-capture:${status.projectKey}`),
      );
      memoryCaptureAvailable = control.available;
      memoryCaptureEnabled = control.enabled;
      memoryCaptureProjectKey = status.projectKey;
    } catch (cause) {
      if (refresh === memoryCaptureRefresh && directory === path)
        error = `Could not load automatic memory capture: ${describe(cause)}`;
    }
  }

  async function toggleAutomaticMemoryCapture() {
    if (!memoryCaptureAvailable || memoryCaptureBusy || !memoryCaptureProjectKey) return;
    const projectKey = memoryCaptureProjectKey;
    const enabled = !memoryCaptureEnabled;
    memoryCaptureBusy = true;
    try {
      await persistAutomaticCapture(projectKey, enabled);
      if (memoryCaptureProjectKey === projectKey) memoryCaptureEnabled = enabled;
    } catch (cause) {
      error = `Could not update automatic memory capture: ${describe(cause)}`;
    } finally {
      if (memoryCaptureProjectKey === projectKey) memoryCaptureBusy = false;
    }
  }

  function saveProjectCatalog(next: ProjectCatalog) {
    projectCatalog = next;
    setSetting('sai-project-catalog', JSON.stringify(next));
    scheduleInboxRefresh();
  }

  async function saveShipRuns(): Promise<void> {
    const value = serializeShipRuns(shipRuns, unparsedShipRuns);
    await setSettingDurable('sai-ship-runs', value);
  }

  async function archiveDueShipRuns(): Promise<void> {
    const now = Date.now();
    const due = shipRuns.filter((run) => shipRunDueForArchive(run, shipArchiveDelay, now));
    if (!due.length) return;
    for (const run of due) {
      run.archivedAt = now;
      run.archivedBy = 'auto';
    }
    await saveShipRuns();
  }

  async function confirmShipAction(request: {
    title: string;
    message: string;
    confirmLabel: string;
    destructive: boolean;
  }): Promise<boolean> {
    return confirmInApp(request.title, request.message, request.confirmLabel, {
      destructive: request.destructive,
    });
  }

  const shipMergesInFlight = new SvelteSet<string>();

  async function mergeShipIssue(run: ShipRun, issue: ShipIssue): Promise<string> {
    const key = `${run.id}:${issue.id}`;
    if (shipMergesInFlight.has(key)) throw new Error('A merge request is already in progress.');
    shipMergesInFlight.add(key);
    try {
      return await requestShipMerge(run, issue);
    } finally {
      shipMergesInFlight.delete(key);
    }
  }

  async function requestShipMerge(run: ShipRun, issue: ShipIssue): Promise<string> {
    const available = shipMergeAction(issue);
    if (!available.enabled) throw new Error(available.reason ?? 'This pull request cannot merge.');
    if (!(await confirmShipAction(shipMergeConfirmation(issue, run.remote)))) return '';
    const ready = shipMergeAction(issue);
    if (!ready.enabled) throw new Error(ready.reason ?? 'This pull request cannot merge.');
    const outcome = await invoke<{
      method: 'github' | 'bot-comment';
      strategy: string;
      comment: string | null;
    }>('ship_merge_pull_request', {
      request: {
        repository: run.repository,
        expectedRepository: run.remote,
        pullRequest: issue.pullRequest,
        expectedHead: issue.checkpoint?.revision,
        evidenceReady: shipEvidenceReadiness(issue).ready,
      },
    });
    if (outcome.method !== 'bot-comment') {
      void tickShippingRuns(true);
      return `Merged the pull request (${outcome.strategy}).`;
    }
    const posted = `Posted “${outcome.comment}” on the pull request. The repository's bot merges it.`;
    // Kept in memory even if saving fails, so this session cannot post the comment again.
    await updateShipIssue(
      run,
      issue,
      {
        mergeRequested: {
          at: Date.now(),
          head: issue.pullRequestHead ?? null,
          comment: outcome.comment ?? '',
        },
      },
      false,
    );
    void tickShippingRuns(true);
    try {
      await saveShipRuns();
    } catch (cause) {
      return `${posted} Sail could not save that the merge was requested: ${describe(cause)}`;
    }
    return posted;
  }

  function requireShipClaimOwnership(issue: ShipIssue, action: string): void {
    if (
      issue.claim?.status === 'active' &&
      !shippingClaimOwnedByInstance(issue.claim, shippingInstanceId)
    )
      throw new Error(
        `Another Sail instance holds the shipping claim for this issue. ${action} after it releases or expires.`,
      );
  }

  /** Stops leftovers and queues a fresh worker that resumes from the saved checkpoint. */
  async function restartShipIssue(
    run: ShipRun,
    issue: ShipIssue,
    nextAction: string,
    changes: Partial<ShipIssue> = {},
  ): Promise<void> {
    const checkpoint = issue.checkpoint;
    const resumed =
      checkpoint && (checkpoint.status === 'cancelled' || checkpoint.status === 'failed')
        ? updateTaskCheckpoint(
            checkpoint,
            {
              status: 'active',
              phase: checkpoint.phase === 'complete' ? 'implement' : checkpoint.phase,
              nextAction,
            },
            Date.now(),
          )
        : checkpoint;
    await updateShipIssue(run, issue, {
      state: 'pending',
      error: null,
      blockedReason: null,
      refreshError: null,
      workerSettled: false,
      receiptId: null,
      threadId: null,
      cancelledAt: undefined,
      stage: undefined,
      reportedStatus: undefined,
      claimFencePending: false,
      claimRevalidationPending: false,
      claimHandoffPending: false,
      dispatchFencePending: false,
      retryCount: (issue.retryCount ?? 0) + 1,
      ...changes,
      ...(resumed ? { checkpoint: resumed } : {}),
    });
    launchReadyShipIssues(run);
  }

  async function retryShipIssue(run: ShipRun, issue: ShipIssue): Promise<string> {
    const available = shipRetryAction(issue);
    if (!available.enabled) throw new Error(available.reason ?? 'This issue cannot be retried.');
    requireShipClaimOwnership(issue, 'Retry');
    if (!(await confirmShipAction(shipRetryConfirmation(issue)))) return '';
    if (!(issue.workerSettled === true && (await shippingTaskWorkersSettled(issue))))
      await stopShippingWorker(issue);
    const stillRetryable = shipRetryAction(issue);
    if (!stillRetryable.enabled)
      throw new Error(stillRetryable.reason ?? 'This issue changed and cannot be retried.');
    await restartShipIssue(run, issue, 'Resume from the saved checkpoint after the retry.');
    return 'Retry queued. A fresh worker resumes from the saved checkpoint.';
  }

  async function reopenShipIssue(run: ShipRun, issue: ShipIssue): Promise<string> {
    const available = shipReopenAction(issue);
    if (!available.enabled)
      throw new Error(available.reason ?? 'This pull request cannot be reopened.');
    requireShipClaimOwnership(issue, 'Reopen');
    if (!(await confirmShipAction(shipReopenConfirmation(issue, run.remote)))) return '';
    const ready = shipReopenAction(issue);
    if (!ready.enabled)
      throw new Error(ready.reason ?? 'This issue changed and cannot be reopened.');
    const outcome = await invoke<{ head: string; pullRequest: string; alreadyOpen: boolean }>(
      'ship_reopen_pull_request',
      {
        request: {
          repository: run.repository,
          expectedRepository: run.remote,
          pullRequest: issue.pullRequest,
        },
      },
    );
    if (!(issue.workerSettled === true && (await shippingTaskWorkersSettled(issue))))
      await stopShippingWorker(issue);
    const key = `${run.id}:${issue.id}`;
    // A lookup started before the reopen would report the pull request closed again.
    beginLatestRefresh(shippingPullRequestGenerations, key);
    const cached = shippingPullRequests.get(key);
    if (cached) shippingPullRequests.set(key, { ...cached, state: 'OPEN' });
    await restartShipIssue(
      run,
      issue,
      `Pull request ${outcome.pullRequest} was reopened at ${outcome.head.slice(0, 8)}. Reconcile it with the checkpoint and continue the pull request loop.`,
      { pullRequestState: 'OPEN', pullRequestHead: outcome.head },
    );
    return outcome.alreadyOpen
      ? 'The pull request was already open. A fresh worker resumes from the saved checkpoint.'
      : 'Pull request reopened. A fresh worker resumes from the saved checkpoint.';
  }

  async function stopShipRun(run: ShipRun): Promise<string> {
    const available = shipStopAction(run);
    if (!available.enabled) throw new Error(available.reason ?? 'Nothing to stop.');
    if (run.issues.some((issue) => activeShipLaunches.has(`${run.id}:${issue.id}`)))
      throw new Error('A worker is still launching. Stop the run once it has started.');
    if (!(await confirmShipAction(shipStopConfirmation(run)))) return '';
    if (run.issues.some((issue) => activeShipLaunches.has(`${run.id}:${issue.id}`)))
      throw new Error('A worker is still launching. Stop the run once it has started.');
    const stopping = run.issues.filter((issue) =>
      ['pending', 'starting', 'working', 'awaiting_merge'].includes(issue.state),
    );
    const markStopped = async (issue: ShipIssue) => {
      if (issue.state === 'merged') return;
      const checkpoint = issue.checkpoint;
      return updateShipIssue(run, issue, {
        state: 'failed',
        error: stoppedMessage,
        blockedReason: null,
        workerSettled: true,
        cancelledAt: Date.now(),
        ...(checkpoint && checkpoint.status !== 'completed'
          ? {
              checkpoint: updateTaskCheckpoint(
                checkpoint,
                { status: 'cancelled', blocker: null },
                Date.now(),
              ),
            }
          : {}),
      });
    };
    const saved = stopping.filter((issue) => issue.state === 'pending').map(markStopped);
    const unsettled = stopping.filter((issue) => !issue.cancelledAt);
    const outcomes = await Promise.allSettled(
      unsettled.map(async (issue) => {
        if (!(issue.workerSettled === true && (await shippingTaskWorkersSettled(issue))))
          await stopShippingWorker(issue);
        await markStopped(issue);
      }),
    );
    await Promise.all(saved);
    const failures = outcomes.flatMap((outcome, index) =>
      outcome.status === 'rejected'
        ? [`#${unsettled[index]?.number}: ${describe(outcome.reason)}`]
        : [],
    );
    if (failures.length) throw new Error(`Could not stop ${failures.join('; ')}`);
    return 'Run stopped. Claims are released as cancelled.';
  }

  async function archiveShipRunByUser(run: ShipRun): Promise<string> {
    const available = shipArchiveAction(run);
    if (!available.enabled) throw new Error(available.reason ?? 'This run cannot be archived.');
    if (!(await confirmShipAction(shipArchiveConfirmation(run)))) return '';
    run.archivedAt = Date.now();
    run.archivedBy = 'user';
    await saveShipRuns();
    return 'Run archived. Use the Archived filter to find it.';
  }

  async function unarchiveShipRunByUser(run: ShipRun): Promise<string> {
    delete run.archivedAt;
    delete run.archivedBy;
    run.unarchivedAt = Date.now();
    await saveShipRuns();
    void tickShippingRuns(true);
    return 'Run restored.';
  }

  async function runShipAction(
    id: ShipActionId,
    run: ShipRun,
    issue: ShipIssue | null,
  ): Promise<string> {
    if (id === 'merge' && issue) return mergeShipIssue(run, issue);
    if (id === 'retry' && issue) return retryShipIssue(run, issue);
    if (id === 'reopen' && issue) return reopenShipIssue(run, issue);
    if (id === 'stop') return stopShipRun(run);
    if (id === 'archive') return archiveShipRunByUser(run);
    if (id === 'unarchive') return unarchiveShipRunByUser(run);
    throw new Error('Unknown Ship action.');
  }

  async function openShipQueueIssue(runId: string, issueId: string) {
    const run = shipRuns.find((item) => item.id === runId);
    if (!run) return;
    showWorkspace();
    if (directory !== run.repository && coordinationProject(directory) !== run.repository)
      await loadProject(run.repository, false);
    showShipRuns();
    shipFocusRequest = {
      id: (shipFocusRequest?.id ?? 0) + 1,
      runId,
      issueId,
      focus: 'issue',
    };
  }

  function dismissShipArchiveNotice() {
    shipArchiveNotice = 0;
    setSetting('sai-ship-archive-notice', '0');
  }

  async function updateShipIssue(
    run: ShipRun,
    issue: ShipIssue,
    changes: Partial<ShipIssue>,
    durable = true,
  ): Promise<void> {
    const current = run.issues.find((item) => item.id === issue.id);
    if (!current) return;
    if (changes.evidenceManifests)
      changes = {
        ...changes,
        evidenceManifests: mergeEvidenceManifests(
          current.evidenceManifests ?? [],
          changes.evidenceManifests,
        ),
      };
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
      setSetting('sai-ship-runs', serializeShipRuns(shipRuns, unparsedShipRuns));
      throw cause;
    }
  }

  function contextProvider(threadId: string): ContextProvider {
    if (openCodeSessionId(threadId)) return 'opencode';
    if (threadId.startsWith('acp:claude:')) return 'claude';
    return 'codex';
  }

  async function recordShipContextPressure(
    path: string,
    threadId: string,
    context: number | undefined,
    previousContext?: number,
  ): Promise<void> {
    const owner = shipCheckpointOwner(shipRuns, path, threadId);
    if (!owner || context === undefined) return;
    const primary = owner.issue.threadId === threadId;
    const pressure = updateThreadContextPressure(
      owner.issue.contextPercentByThread,
      threadId,
      context,
      owner.issue.threadId ?? undefined,
    );
    const previous =
      previousContext ?? pressure.previous ?? (primary ? owner.issue.contextPercent : undefined);
    const stage = contextPressureStage(previous, context, contextHandoffThreshold);
    const changes: Partial<ShipIssue> = {
      contextPercentByThread: pressure.contexts,
      ...(primary ? { contextPercent: context } : {}),
    };
    if (!primary) {
      await updateShipIssue(owner.run, owner.issue, changes);
      return;
    }
    const checkpoint = owner.issue.checkpoint;
    const handoffInFlight = owner.issue.contextHandoffs?.some(
      (handoff) =>
        handoff.fromThreadId === threadId &&
        !handoff.toThreadId &&
        handoff.outcome === 'pending' &&
        contextHandoffsInFlight.has(handoff.id),
    );
    if (stage && handoffInFlight) {
      await updateShipIssue(owner.run, owner.issue, changes);
      return;
    }
    if ((stage === 'checkpoint' || stage === 'handoff') && checkpoint) {
      changes.contextCheckpointRequestedAt = Date.now();
      changes.contextCheckpointRequestedSequence = checkpoint.sequence;
      coordinationMessages = enqueueCoordinationMessage(coordinationMessages, {
        id: crypto.randomUUID(),
        target: coordinationKey(path, threadId),
        sender: 'Sail · context guard',
        text: `Context reached ${context}%. Update the canonical task checkpoint now, before the ${contextHandoffThreshold}% handoff threshold. Record the current revision, semantic state, pending gates, blockers, and one concrete next action.`,
        created: Date.now(),
      });
      setSetting('sai-coordination-messages', JSON.stringify(coordinationMessages));
      setTimeout(retryCoordinationDeliveries, 0);
    }
    if (stage === 'handoff' && checkpoint) {
      changes.contextHandoffOfferedAt = Date.now();
      changes.contextHandoffOfferedSequence = checkpoint.sequence;
      const pending = owner.issue.contextHandoffs?.findLast(
        (handoff) =>
          handoff.fromThreadId === threadId && !handoff.toThreadId && handoff.outcome === 'pending',
      );
      if (pending && !contextHandoffsInFlight.has(pending.id))
        changes.contextHandoffs = (owner.issue.contextHandoffs ?? []).map((handoff) =>
          handoff.id === pending.id
            ? Object.assign({}, handoff, {
                context,
                compactions: owner.issue.contextCompactions?.[contextProvider(threadId)] ?? 0,
                checkpointSequence: checkpoint.sequence,
                revision: checkpoint.revision,
                offeredAt: Date.now(),
                retriesBefore: owner.issue.retryCount ?? 0,
                lostStateFailuresBefore: owner.issue.lostStateFailures ?? 0,
                error: null,
              })
            : handoff,
        );
      else if (!pending)
        changes.contextHandoffs = [
          ...(owner.issue.contextHandoffs ?? []),
          {
            id: crypto.randomUUID(),
            provider: contextProvider(threadId),
            fromThreadId: threadId,
            toThreadId: null,
            context,
            compactions: owner.issue.contextCompactions?.[contextProvider(threadId)] ?? 0,
            checkpointSequence: checkpoint.sequence,
            revision: checkpoint.revision,
            offeredAt: Date.now(),
            startedAt: null,
            retriesBefore: owner.issue.retryCount ?? 0,
            lostStateFailuresBefore: owner.issue.lostStateFailures ?? 0,
            retriesAfter: null,
            lostStateFailuresAfter: null,
            outcome: 'pending' as const,
            error: null,
          },
        ].slice(-100);
    }
    await updateShipIssue(owner.run, owner.issue, changes);
  }

  async function recordShipContextEvent(
    path: string,
    threadId: string,
    eventId: string,
    kind: 'compaction' | 'retry',
  ): Promise<void> {
    const owner = shipCheckpointOwner(shipRuns, path, threadId);
    if (!owner || owner.issue.contextEventIds?.includes(eventId)) return;
    const provider = contextProvider(threadId);
    const contextEventIds = [...(owner.issue.contextEventIds ?? []), eventId].slice(-200);
    await updateShipIssue(owner.run, owner.issue, {
      contextEventIds,
      ...(kind === 'compaction'
        ? {
            contextCompactions: {
              ...owner.issue.contextCompactions,
              [provider]: (owner.issue.contextCompactions?.[provider] ?? 0) + 1,
            },
          }
        : { retryCount: (owner.issue.retryCount ?? 0) + 1 }),
    });
  }

  async function reconcileProviderNativeSubagents(issue: ShipIssue): Promise<number> {
    if (!issue.path) return 0;
    const nativeSnapshot = await acp.nativeSubagents(issue.path);
    const previous = nativeSubagents;
    nativeSubagents = reconcileNativeSubagents(nativeSubagents, nativeSnapshot.subagents);
    if (nativeSubagents !== previous) nativeSubagentGeneration += 1;
    let authorized = false;
    for (const child of nativeSnapshot.subagents)
      authorized =
        authorizeShipCheckpointThread(
          shipRuns,
          child.directory,
          `acp:${child.agent}:${child.parentSessionId}`,
          child.directory,
          `acp:${child.agent}:${child.sessionId}`,
        ) || authorized;
    if (authorized) await saveShipRuns();
    return nativeSnapshot.generation;
  }

  async function waitForSettledShipWorker(
    issue: ShipIssue,
    threadId = issue.threadId,
    attempts = 50,
  ): Promise<SpawnState> {
    if (issue.path) await reconcileProviderNativeSubagents(issue);
    const state = await directShipWorkerState({ ...issue, threadId });
    if (shippingWorkerSettled(state) || attempts <= 1) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return waitForSettledShipWorker(issue, threadId, attempts - 1);
  }

  async function cancelShipThread(
    issue: ShipIssue,
    threadId: string,
    attempts = 50,
  ): Promise<SpawnState> {
    const launch = activeSpawnReceiptForThread(
      spawnReceipts,
      activeSpawnRequests,
      threadId,
      issue.path ?? '',
    );
    if (launch && (launch.state === 'queued' || launch.state === 'starting')) {
      updateSpawnReceipt(launch.receiptId, {
        state: 'interrupted',
        error: 'Launch cancelled before prompt dispatch.',
      });
      await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
      return 'interrupted';
    }
    const current = await directShipWorkerState({ ...issue, threadId });
    if (launch && shippingWorkerSettled(current)) {
      if (attempts <= 1)
        throw new Error('A task-owned worker launch did not settle before handoff.');
      await new Promise((resolve) => setTimeout(resolve, 100));
      return cancelShipThread(issue, threadId, attempts - 1);
    }
    if (shippingWorkerSettled(current)) return current;
    const match = /^acp:([^:]+):(.+)$/.exec(threadId);
    if (!match) throw new Error('A task worker identity cannot be stopped safely.');
    await acp.cancel(match[1], issue.path ?? '', match[2], null);
    return waitForSettledShipWorker(issue, threadId);
  }

  async function settleOwnedShipThreads(
    issue: ShipIssue,
    retired: SvelteSet<string>,
    attempts = 300,
    quietGeneration: string | null = null,
  ): Promise<{ retired: SvelteSet<string>; nativeGeneration: number }> {
    if (attempts <= 0)
      throw new Error('Task-owned workers kept spawning during handoff cancellation.');
    const nativeGeneration = await reconcileProviderNativeSubagents(issue);
    const ownedReceipts = [...spawnReceipts, ...nativeChildReceipts];
    const lineage = new SvelteSet([...retired, ...shipOwnedThreadIds(issue, ownedReceipts)]);
    const owned = [...lineage].filter((threadId) => !retired.has(threadId));
    const unresolvedSpawn = ownedReceipts.some(
      (receipt) =>
        receipt.sourceDirectory === issue.path &&
        receipt.targetDirectory === issue.path &&
        lineage.has(receipt.sourceId) &&
        !receipt.targetId &&
        !shippingWorkerSettled(receipt.state),
    );
    const currentGeneration = JSON.stringify([nativeSubagentGeneration, nativeGeneration]);
    if (!owned.length && !unresolvedSpawn && quietGeneration === currentGeneration)
      return { retired, nativeGeneration };
    if (!owned.length && !unresolvedSpawn) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return settleOwnedShipThreads(issue, retired, attempts - 1, currentGeneration);
    }
    const states = await Promise.all(
      owned.map(async (threadId) => ({
        threadId,
        state: await cancelShipThread(issue, threadId),
      })),
    );
    for (const { threadId, state } of states) {
      if (!shippingWorkerSettled(state))
        throw new Error('A task-owned worker did not settle, so the handoff was not started.');
      retired.add(threadId);
    }
    if (unresolvedSpawn) await new Promise((resolve) => setTimeout(resolve, 100));
    return settleOwnedShipThreads(issue, retired, attempts - 1, null);
  }

  const contextHandoffsInFlight = new SvelteSet<string>();

  const replacementInspectionError =
    'Prompt dispatch may have completed before restart; inspect the restored provider session before cancelling and retrying.';

  function preserveReplacementForInspection(receipt: SpawnReceipt, detail?: string): void {
    saveSpawnReceipt(
      replacementReceiptForInspection(
        receipt,
        detail ? `${replacementInspectionError} ${detail}` : replacementInspectionError,
        Date.now(),
      ),
    );
  }

  async function replacementDispatchAction(
    receipt: SpawnReceipt,
  ): Promise<ReplacementDispatchAction> {
    if (!receipt.targetId || !receipt.targetDirectory || !receipt.turnId || !receipt.prompt)
      return 'reject';
    const sessionId = receipt.targetId.slice(`acp:${receipt.provider}:`.length);
    try {
      return acpReplacementDispatchAction(
        await acp.turnEvidence(
          receipt.provider,
          receipt.targetDirectory,
          sessionId,
          receipt.turnId,
        ),
      );
    } catch {
      return 'inspect';
    }
  }

  async function retryUncertainHandoff(
    run: ShipRun,
    issue: ShipIssue,
    handoff: NonNullable<ShipIssue['contextHandoffs']>[number],
  ): Promise<void> {
    const receipt = spawnReceipts.find((item) => item.receiptId === issue.receiptId);
    if (
      !receipt ||
      !receipt.targetId ||
      !receipt.targetDirectory ||
      !receipt.turnId ||
      !handoffReceiptNeedsResolution(receipt)
    )
      throw new Error('This handoff no longer needs provider inspection.');
    const confirmed = await confirmInApp(
      'Cancel and retry context handoff?',
      'Inspect the restored provider session first. Continue only after confirming that its work must not be adopted. Sail will cancel that session before creating a fresh worker.',
      'Cancel and retry',
    );
    if (!confirmed) return;
    const sessionId = receipt.targetId.slice(`acp:${receipt.provider}:`.length);
    await acp.cancel(receipt.provider, receipt.targetDirectory, sessionId, receipt.turnId);
    updateSpawnReceipt(receipt.receiptId, {
      state: 'interrupted',
      error: 'Cancelled after provider inspection before a safe retry.',
    });
    await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
    const now = Date.now();
    const retry = {
      ...handoff,
      id: crypto.randomUUID(),
      provider: contextProvider(issue.threadId!),
      fromThreadId: issue.threadId!,
      toThreadId: null,
      checkpointSequence: Math.max(0, issue.checkpoint!.sequence - 1),
      revision: issue.checkpoint!.revision,
      offeredAt: now,
      startedAt: null,
      retriesBefore: issue.retryCount ?? 0,
      lostStateFailuresBefore: issue.lostStateFailures ?? 0,
      retriesAfter: null,
      lostStateFailuresAfter: null,
      outcome: 'pending' as const,
      error: null,
    };
    await updateShipIssue(run, issue, {
      contextHandoffs: [
        ...(issue.contextHandoffs ?? []).map((item) =>
          item.id === handoff.id
            ? Object.assign({}, item, {
                outcome: 'failed' as const,
                error: 'Cancelled after provider inspection before a safe retry.',
              })
            : item,
        ),
        retry,
      ].slice(-100),
      handoffRecoveryRequired: false,
      workerSettled: true,
      workerState: 'interrupted',
      error: null,
    });
    await handoffShipIssue(run, issue);
  }

  async function handoffShipIssue(run: ShipRun, issue: ShipIssue): Promise<void> {
    if (!issue.path || !issue.threadId || !issue.checkpoint)
      throw new Error('This task has no active worker checkpoint to hand off.');
    const offer = issue.contextHandoffs?.findLast(
      (item) =>
        item.fromThreadId === issue.threadId && !item.toThreadId && item.outcome === 'pending',
    );
    if (!offer) {
      const uncertain = issue.contextHandoffs?.findLast(
        (item) =>
          item.toThreadId === issue.threadId &&
          item.outcome === 'pending' &&
          issue.handoffRecoveryRequired === true,
      );
      if (uncertain) return retryUncertainHandoff(run, issue, uncertain);
      throw new Error('This task has no pending context handoff.');
    }
    if (contextHandoffsInFlight.has(offer.id))
      throw new Error('This context handoff is already starting.');
    contextHandoffsInFlight.add(offer.id);
    try {
      if (issue.checkpoint.sequence <= offer.checkpointSequence)
        throw new Error('The worker must update the canonical checkpoint before handoff.');
      const revision = await invoke<string>('working_tree_revision', { path: issue.path });
      if (issue.checkpoint.revision !== revision)
        throw new Error('The checkpoint must be rebound to the current worktree revision first.');
      const receiptId = crypto.randomUUID();
      const accessKey = crypto.randomUUID();
      const previousWorker = {
        receiptId: issue.receiptId,
        threadId: issue.threadId,
        checkpointThreadIds: issue.checkpointThreadIds,
        workerSettled: issue.workerSettled,
        workerState: issue.workerState,
      };
      let cancellationCompleted = false;
      let previousWorkerState = issue.workerState ?? 'unavailable';
      let retiredThreadIds = new SvelteSet<string>();
      try {
        const previousThreadId = issue.threadId;
        previousWorkerState = await cancelShipThread(issue, previousThreadId);
        cancellationCompleted = true;
        if (!shippingWorkerSettled(previousWorkerState))
          throw new Error('The current worker did not settle, so the handoff was not started.');
        retiredThreadIds.add(previousThreadId);
        const settlement = await settleOwnedShipThreads(issue, retiredThreadIds);
        retiredThreadIds = settlement.retired;
        const currentOffer = issue.contextHandoffs?.find((item) => item.id === offer.id);
        if (
          !currentOffer ||
          currentOffer.fromThreadId !== issue.threadId ||
          currentOffer.toThreadId ||
          currentOffer.outcome !== 'pending' ||
          issue.checkpoint.sequence <= currentOffer.checkpointSequence
        )
          throw new Error('The handoff checkpoint changed while the current worker was stopping.');
        const settledRevision = await invoke<string>('working_tree_revision', { path: issue.path });
        if (issue.checkpoint.revision !== settledRevision)
          throw new Error('The settled checkpoint must match the current worktree revision.');
        const prompt = contextHandoffPrompt({
          checkpoint: issue.checkpoint,
          branch: issue.branch,
          revision: settledRevision,
          pullRequest: issue.pullRequest,
          gates: (issue.gates ?? []).map(
            (gate) =>
              `${gate.gate}: ${gate.verdict ?? gate.state}${gate.reason ? ` (${gate.reason})` : ''}`,
          ),
        });
        saveSpawnReceipt({
          receiptId,
          accessKey,
          requestId: `handoff:${offer.id}`,
          project: run.repository,
          sourceId: issue.threadId,
          sourceDirectory: issue.path,
          targetId: null,
          turnId: null,
          targetDirectory: issue.path,
          worktreeId: issue.path,
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
          { path: issue.path, branch: issue.branch },
          { kind: 'acp', agent: run.provider, title: issue.title },
          prompt,
          receiptId,
          false,
          async () => {
            const targetId = spawnReceipts.find((item) => item.receiptId === receiptId)?.targetId;
            if (!targetId) throw new Error('The fresh worker did not publish its thread identity.');
            const startedAt = Date.now();
            await updateShipIssue(run, issue, {
              receiptId,
              threadId: targetId,
              checkpointThreadIds: (issue.checkpointThreadIds ?? []).filter(
                (threadId) => !retiredThreadIds.has(threadId),
              ),
              contextHandoffs: (issue.contextHandoffs ?? []).map((item) =>
                item.id === offer.id
                  ? transferHandoffOwnership(
                      item,
                      targetId,
                      startedAt,
                      issue.retryCount ?? 0,
                      issue.lostStateFailures ?? 0,
                    )
                  : item.fromThreadId === offer.fromThreadId &&
                      !item.toThreadId &&
                      item.outcome === 'pending'
                    ? Object.assign({}, item, {
                        outcome: 'failed' as const,
                        error: 'Superseded by the accepted handoff.',
                      })
                    : item,
              ),
              contextPercent: undefined,
              handoffRecoveryRequired: false,
              state: 'working',
              error: null,
              refreshError: null,
              workerSettled: false,
              workerState: 'working',
            });
          },
          settlement.nativeGeneration,
        );
        if (issue.threadId !== started.threadId)
          throw new Error('The fresh worker identity changed before handoff completed.');
      } catch (cause) {
        const replacementReceipt = spawnReceipts.find((item) => item.receiptId === receiptId);
        const replacementThreadId = replacementReceipt?.targetId;
        const dispatchAction =
          replacementReceipt &&
          replacementThreadId &&
          replacementThreadId !== previousWorker.threadId
            ? await replacementDispatchAction(replacementReceipt)
            : 'reject';
        if (
          replacementReceipt &&
          replacementThreadId &&
          replacementThreadId !== previousWorker.threadId &&
          dispatchAction !== 'reject'
        ) {
          const replacementState =
            dispatchAction === 'inspect'
              ? 'unavailable'
              : await directShipWorkerState({
                  ...issue,
                  threadId: replacementThreadId,
                });
          const reconciledState =
            replacementState === 'unavailable' ? replacementReceipt.state : replacementState;
          if (dispatchAction === 'inspect')
            preserveReplacementForInspection(replacementReceipt, describe(cause));
          else
            updateSpawnReceipt(receiptId, {
              state: reconciledState,
              error: `Replacement startup confirmation failed: ${describe(cause)}`,
            });
          await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
          await updateShipIssue(run, issue, {
            receiptId,
            threadId: replacementThreadId,
            checkpointThreadIds: (issue.checkpointThreadIds ?? []).filter(
              (threadId) => !retiredThreadIds.has(threadId),
            ),
            contextHandoffs: (issue.contextHandoffs ?? []).map((item) =>
              item.id === offer.id
                ? Object.assign(
                    transferHandoffOwnership(
                      item,
                      replacementThreadId,
                      item.startedAt ?? Date.now(),
                      issue.retryCount ?? 0,
                      issue.lostStateFailures ?? 0,
                    ),
                    { error: describe(cause) },
                  )
                : item,
            ),
            contextPercent: undefined,
            handoffRecoveryRequired: dispatchAction === 'inspect',
            state: 'working',
            error:
              dispatchAction === 'inspect'
                ? replacementInspectionError
                : `Replacement worker started, but activity confirmation failed: ${describe(cause)}`,
            workerSettled:
              dispatchAction === 'inspect' ? false : shippingWorkerSettled(reconciledState),
            workerState: replacementState,
          });
          throw cause;
        }
        updateSpawnReceipt(receiptId, { state: 'failed', error: describe(cause) });
        await updateShipIssue(run, issue, {
          ...previousWorker,
          ...(cancellationCompleted
            ? {
                workerSettled: shippingWorkerSettled(previousWorkerState),
                workerState: previousWorkerState,
              }
            : {}),
          contextHandoffs: (issue.contextHandoffs ?? []).map((item) =>
            item.id === offer.id
              ? Object.assign({}, item, {
                  toThreadId: null,
                  startedAt: null,
                  outcome: 'pending' as const,
                  error: describe(cause),
                })
              : item,
          ),
        });
        throw cause;
      }
    } finally {
      contextHandoffsInFlight.delete(offer.id);
    }
  }

  function shippingPromptDispatchPending(issue: ShipIssue, key: string): boolean {
    const ownedThreads = new Set([issue.threadId, ...(issue.checkpointThreadIds ?? [])]);
    return (
      shippingPromptDispatches.pending(key) ||
      spawnReceipts.some(
        (receipt) =>
          receipt.dispatchPending === true &&
          receipt.targetDirectory === issue.path &&
          (receipt.receiptId === issue.receiptId || ownedThreads.has(receipt.targetId)),
      )
    );
  }

  async function startShippingRun(
    graph: PublishedGraph,
    provider: ShipRun['provider'],
    limit: number,
    source: string,
  ): Promise<void> {
    const repository = coordinationProject(directory);
    const remote = graph.issues[0]?.repository ?? '';
    if (!remote) throw new Error('Select a published repository issue graph.');
    if (!repository)
      throw new Error('Open the project repository or one of its worktrees to ship this plan.');
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
      setSetting('sai-ship-runs', serializeShipRuns(shipRuns, unparsedShipRuns));
      throw cause;
    }
    showShipRuns();
    void tickShippingRuns();
  }

  function detectShippingClockResume(): boolean {
    const wallNow = Date.now();
    const monotonicNow = performance.now();
    const resumed = shippingClockWasSuspended(
      shippingClockWall,
      shippingClockMonotonic,
      wallNow,
      monotonicNow,
    );
    shippingClockWall = wallNow;
    shippingClockMonotonic = monotonicNow;
    if (!resumed) return false;
    for (const run of shipRuns) {
      for (const issue of run.issues) {
        const claim = issue.claim;
        if (!claim || claim.status !== 'active') continue;
        const key = `${run.id}:${issue.id}`;
        const validationKey = `${key}:${claim.id}:${claim.commentId}`;
        shipClaimResumeValidations.add(validationKey);
        shipClaimHeartbeatDeadlines.delete(validationKey);
        shipClaimLeaseDeadlines.delete(validationKey);
        shipClaimLeaseWallDeadlines.delete(validationKey);
        clearShippingClaimLeaseFence(validationKey);
        shippingPromptGenerations.set(key, (shippingPromptGenerations.get(key) ?? 0) + 1);
        beginShippingResumeFence(run, issue, validationKey);
      }
    }
    return true;
  }

  function shippingPromptAuthorization(run: ShipRun, issue: ShipIssue): DirectShipAuthorization {
    detectShippingClockResume();
    const claim = issue.claim;
    if (!claim || !shippingClaimOwnedByInstance(claim, shippingInstanceId))
      throw new Error('Direct shipping claim is no longer active.');
    const key = `${run.id}:${issue.id}`;
    const validationKey = `${key}:${claim.id}:${claim.commentId}`;
    if (shipClaimResumeValidations.has(validationKey))
      throw new Error('Direct shipping claim must be revalidated after system resume.');
    if (!shipClaimLeaseDeadlines.has(validationKey))
      throw new Error('Direct shipping claim lease was not validated.');
    const generation = (shippingPromptGenerations.get(key) ?? 0) + 1;
    shippingPromptGenerations.set(key, generation);
    const authorized = () => {
      detectShippingClockResume();
      const currentRun = shipRuns.find((item) =>
        item.issues.some((candidate) => `${item.id}:${candidate.id}` === key),
      );
      const currentIssue = currentRun?.issues.find(
        (candidate) => `${currentRun.id}:${candidate.id}` === key,
      );
      const currentClaim = currentIssue?.claim;
      const currentValidationKey = currentClaim
        ? `${key}:${currentClaim.id}:${currentClaim.commentId}`
        : '';
      return (
        directShipPromptAuthorized(
          currentIssue,
          claim.id,
          generation,
          shippingPromptGenerations.get(key),
          performance.now(),
          shipClaimLeaseDeadlines.get(currentValidationKey),
        ) &&
        currentClaim?.instanceId === shippingInstanceId &&
        (shipClaimLeaseWallDeadlines.get(currentValidationKey) ?? 0) > Date.now() &&
        !shipClaimResumeValidations.has(currentValidationKey)
      );
    };
    return {
      claim,
      key,
      generation,
      authorized,
      dispatch: <T,>(start: () => T) =>
        shippingPromptDispatches.track(key, () => {
          if (!authorized())
            throw new Error('Direct shipping authorization expired at the dispatch boundary.');
          return start();
        }),
    };
  }

  function shippingPromptAuthorizationForReceipt(receipt: SpawnReceipt): DirectShipAuthorization {
    for (const run of shipRuns) {
      const issue = run.issues.find((candidate) => candidate.receiptId === receipt.receiptId);
      if (issue) return shippingPromptAuthorization(run, issue);
    }
    throw new Error('Shipping worker no longer owns a tracked issue.');
  }

  async function adoptDirectShipRunWithAuthorization(
    issue: ShipItIssue,
    path: string,
    threadId: string,
    knownWorkerModel?: string,
    requireClaim = false,
  ): Promise<DirectShipAuthorization | undefined> {
    await assertShipItIssueRepository(path, issue);
    const provider: ShipRun['provider'] = contextProvider(threadId);
    const [, agent, sessionId] = /^acp:([^:]+):(.+)$/.exec(threadId) ?? [];
    const workerModel =
      knownWorkerModel ??
      agentThreads.find(
        (thread) =>
          thread.agent === agent && thread.sessionId === sessionId && thread.directory === path,
      )?.model;
    const project = worktreeAt(projectCatalog, path)?.repository ?? path;
    const adopted = await adoptRegisteredDirectShipRun(
      invoke<RegisteredWorktree[]>('registered_worktrees', {
        repository: project,
        paths: [path],
      }),
      {
        id: crypto.randomUUID(),
        project,
        directory: path,
        repository: issue.repository,
        number: issue.number,
        provider,
        threadId,
        workerModel,
        approvedAt: Date.now(),
      },
      () => shipRuns,
      (runs) => (shipRuns = runs),
      saveShipRuns,
    );
    if (!adopted) return;
    showShipRuns();
    if (!requireClaim) return;
    const run = shipRuns.find((item) =>
      item.issues.some((candidate) => candidate.path === path && candidate.threadId === threadId),
    );
    const directIssue = run?.issues.find(
      (candidate) => candidate.path === path && candidate.threadId === threadId,
    );
    if (!run || !directIssue) throw new Error('Direct shipping run was not saved.');
    if (directIssue.claim?.status === 'active') {
      if (!(await refreshShippingClaim(run, directIssue, true, true)))
        throw new Error('Direct shipping claim could not be revalidated.');
      const verifiedClaim = directIssue.claim;
      if (!verifiedClaim || verifiedClaim.status !== 'active')
        throw new Error('Direct shipping claim is no longer active.');
      if (directIssue.state === 'failed')
        await updateShipIssue(
          run,
          directIssue,
          directClaimHandoffChanges(directIssue, verifiedClaim),
        );
      return shippingPromptAuthorization(run, directIssue);
    }
    await acquireShippingClaim(run, directIssue, true);
    return shippingPromptAuthorization(run, directIssue);
  }

  async function adoptDirectShipRun(
    issue: ShipItIssue,
    path: string,
    threadId: string,
    knownWorkerModel?: string,
    requireClaim = false,
  ): Promise<ShippingClaim | undefined> {
    return (
      await adoptDirectShipRunWithAuthorization(
        issue,
        path,
        threadId,
        knownWorkerModel,
        requireClaim,
      )
    )?.claim;
  }

  async function acquireShippingClaim(
    run: ShipRun,
    issue: ShipIssue,
    directHandoff = false,
  ): Promise<ShippingClaim> {
    const key = `${run.id}:${issue.id}`;
    return serializeShippingClaimOperation(shipClaimOperations, key, async () => {
      const existing = issue.claim;
      if (existing && shippingClaimOwnedByInstance(existing, shippingInstanceId)) {
        if (directHandoff && issue.state === 'failed')
          await updateShipIssue(run, issue, directClaimHandoffChanges(issue, existing));
        return existing;
      }
      const leaseStartedAt = performance.now();
      const acquiredAt = new Date().toISOString();
      const claim = await invoke<ShippingClaim>('acquire_shipping_claim', {
        repository: run.repository,
        expectedRepository: run.remote,
        number: issue.number,
        claim: {
          id: crypto.randomUUID(),
          instanceId: shippingInstanceId,
          holder: `Sail ${run.provider} (${run.id.slice(0, 8)})`,
          task: `ship:${run.id}:${issue.id}`,
          acquiredAt,
          heartbeatAt: acquiredAt,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          status: 'active',
          commentId: 0,
        },
      });
      await persistAcquiredClaim(
        claim,
        (acquired) =>
          updateShipIssue(
            run,
            issue,
            directHandoff ? directClaimHandoffChanges(issue, acquired) : { claim: acquired },
          ),
        async (acquired) => {
          await invoke<ShippingClaim>('release_shipping_claim', {
            repository: run.repository,
            expectedRepository: run.remote,
            number: issue.number,
            claim: acquired,
            instanceId: shippingInstanceId,
            reason: 'claim persistence failed',
          });
        },
      );
      const validationKey = `${run.id}:${issue.id}:${claim.id}:${claim.commentId}`;
      const leaseDeadline = claimMonotonicLeaseDeadline(leaseStartedAt, claim);
      shipClaimLeaseDeadlines.set(validationKey, leaseDeadline);
      shipClaimLeaseWallDeadlines.set(
        validationKey,
        Date.now() + Math.max(0, leaseDeadline - performance.now()),
      );
      scheduleShippingClaimLeaseFence(run, issue, validationKey, leaseDeadline);
      shipClaimHeartbeatDeadlines.set(
        validationKey,
        nextClaimHeartbeatDeadline(performance.now(), leaseDeadline),
      );
      return claim;
    });
  }

  function clearShippingClaimLeaseFence(validationKey: string): void {
    const timer = shipClaimLeaseFenceTimers.get(validationKey);
    if (timer) clearTimeout(timer);
    shipClaimLeaseFenceTimers.delete(validationKey);
  }

  function scheduleShippingClaimLeaseFence(
    run: ShipRun,
    issue: ShipIssue,
    validationKey: string,
    deadline: number,
  ): void {
    clearShippingClaimLeaseFence(validationKey);
    const wallDeadline = shipClaimLeaseWallDeadlines.get(validationKey);
    const delay = Math.min(
      Math.max(
        0,
        Math.min(
          deadline - performance.now(),
          wallDeadline === undefined ? Number.POSITIVE_INFINITY : wallDeadline - Date.now(),
        ),
      ),
      2_147_483_647,
    );
    shipClaimLeaseFenceTimers.set(
      validationKey,
      setTimeout(() => {
        shipClaimLeaseFenceTimers.delete(validationKey);
        void fenceShippingClaimAtLeaseDeadline(run.id, issue.id, validationKey);
      }, delay),
    );
  }

  async function fenceShippingClaimAtLeaseDeadline(
    runId: string,
    issueId: string,
    validationKey: string,
  ): Promise<void> {
    if (disposed) return;
    const run = shipRuns.find((candidate) => candidate.id === runId);
    const issue = run?.issues.find((candidate) => candidate.id === issueId);
    if (!run || !issue) return;
    const claim = issue.claim;
    if (!claim || `${run.id}:${issue.id}:${claim.id}:${claim.commentId}` !== validationKey) return;
    const deadline = shipClaimLeaseDeadlines.get(validationKey);
    const wallDeadline = shipClaimLeaseWallDeadlines.get(validationKey);
    const fenced = await fenceExpiredShippingLease(
      performance.now(),
      deadline,
      async () => {
        shipClaimHeartbeatDeadlines.delete(validationKey);
        shipClaimLeaseDeadlines.delete(validationKey);
        shipClaimLeaseWallDeadlines.delete(validationKey);
        await updateShipIssue(run, issue, {
          claimFencePending: true,
          workerSettled: false,
          blockedReason: 'Shipping claim lease expired before heartbeat completion.',
        });
        await retryShippingClaimFence(run, issue);
      },
      Date.now(),
      wallDeadline,
    );
    if (!fenced && deadline !== undefined)
      scheduleShippingClaimLeaseFence(run, issue, validationKey, deadline);
  }

  async function acquireRecoveredShippingClaim(run: ShipRun, issue: ShipIssue): Promise<boolean> {
    try {
      await acquireShippingClaim(run, issue);
      return true;
    } catch (cause) {
      await fenceRecoveredShippingWorker(
        run,
        issue,
        missingRepositoryPath(cause)
          ? 'Shipping repository no longer exists. Start a new run from the project.'
          : `Shipping claim recovery failed: ${describe(cause)}`,
      );
      return false;
    }
  }

  async function reconcileForeignShippingClaim(run: ShipRun, issue: ShipIssue): Promise<void> {
    const claim = issue.claim;
    if (!claim || claim.status !== 'active') return;
    const validationKey = `${run.id}:${issue.id}:${claim.id}:${claim.commentId}`;
    try {
      await fencePredecessorWorkerBeforeTakeover(
        () =>
          invoke<ShippingClaimObservation>('observe_shipping_claim', {
            repository: run.repository,
            number: issue.number,
            claim,
            recoveryId: shippingInstanceId,
          }),
        async () => {
          const taskWorkersSettled =
            issue.workerSettled === true && (await shippingTaskWorkersSettled(issue));
          if (!recoveredClaimWorkerFenceRequired(issue, taskWorkersSettled)) return;
          const blockedReason = 'The predecessor shipping claim expired; fencing its worker.';
          await updateShipIssue(run, issue, {
            claimFencePending: true,
            workerSettled: false,
            blockedReason,
            refreshError: null,
          });
          await fenceRecoveredShippingWorker(run, issue, blockedReason, false);
          if (!issue.workerSettled)
            throw new Error(issue.refreshError ?? 'Worker termination was not confirmed.');
        },
        () =>
          invoke('complete_predecessor_shipping_claim_fence', {
            repository: run.repository,
            number: issue.number,
            claim,
            recoveryId: shippingInstanceId,
          }),
        async ({ observation, fenced }) => {
          if (!fenced) {
            if (issue.claim?.id !== claim.id || issue.claim.commentId !== claim.commentId) return;
            await updateShipIssue(run, issue, { claim: observation.claim, refreshError: null });
            scheduleRecoveredShippingClaimLeaseFence(
              run,
              issue,
              validationKey,
              observation.remainingLeaseMillis,
            );
            return;
          }
          if (!issue.workerSettled) return;
          shipClaimLeaseDeadlines.delete(validationKey);
          shipClaimLeaseWallDeadlines.delete(validationKey);
          clearShippingClaimLeaseFence(validationKey);
          await updateShipIssue(run, issue, predecessorTakeoverChanges(issue));
        },
      );
    } catch (cause) {
      await updateShipIssue(run, issue, {
        refreshError: `Foreign claim reconciliation failed: ${describe(cause)}`,
      });
    }
  }

  function scheduleRecoveredShippingClaimLeaseFence(
    run: ShipRun,
    issue: ShipIssue,
    validationKey: string,
    remainingLeaseMillis: number,
  ): void {
    const deadlines = recoveredClaimLeaseDeadlines(
      performance.now(),
      Date.now(),
      remainingLeaseMillis,
    );
    shipClaimLeaseDeadlines.set(validationKey, deadlines.monotonic);
    shipClaimLeaseWallDeadlines.set(validationKey, deadlines.wall);
    scheduleShippingClaimLeaseFence(run, issue, validationKey, deadlines.monotonic);
  }

  async function fenceRecoveredShippingWorker(
    run: ShipRun,
    issue: ShipIssue,
    blockedReason: string,
    terminalOnSuccess = true,
  ): Promise<void> {
    const key = `${run.id}:${issue.id}`;
    fencedShipLaunches.add(key);
    shippingPromptGenerations.set(key, (shippingPromptGenerations.get(key) ?? 0) + 1);
    try {
      await stopShippingWorker(issue);
    } catch (cause) {
      await updateShipIssue(run, issue, {
        claimFencePending: true,
        workerSettled: false,
        blockedReason,
        refreshError: `Worker fencing failed: ${describe(cause)}`,
      });
      return;
    }
    await updateShipIssue(run, issue, {
      ...(terminalOnSuccess ? { state: 'failed', claimFencePending: false } : {}),
      workerSettled: true,
      workerState: 'interrupted',
      blockedReason,
      refreshError: null,
    });
  }

  async function fencePendingPromptDispatch(
    run: ShipRun,
    issue: ShipIssue,
    reason: string,
  ): Promise<boolean> {
    const key = `${run.id}:${issue.id}`;
    fencedShipLaunches.add(key);
    if (!issue.dispatchFencePending) {
      shippingPromptGenerations.set(key, (shippingPromptGenerations.get(key) ?? 0) + 1);
      await updateShipIssue(run, issue, {
        dispatchFencePending: true,
        workerSettled: false,
        blockedReason: reason,
      });
    }
    try {
      await stopShippingWorker(issue);
    } catch (cause) {
      await updateShipIssue(run, issue, {
        dispatchFencePending: true,
        workerSettled: false,
        refreshError: `Worker fencing failed: ${describe(cause)}`,
      });
      return false;
    }
    await updateShipIssue(run, issue, {
      dispatchFencePending: false,
      workerSettled: true,
      workerState: 'interrupted',
      refreshError: null,
    });
    return true;
  }

  async function retryShippingClaimFence(run: ShipRun, issue: ShipIssue): Promise<void> {
    const blockedReason = currentShipBlockedReason(issue.blockedReason);
    await fenceRecoveredShippingWorker(run, issue, blockedReason, false);
    if (!issue.workerSettled) return;
    const claim = issue.claim;
    if (claim?.status === 'active' && !shippingClaimOwnedByInstance(claim, shippingInstanceId)) {
      await updateShipIssue(run, issue, {
        state: 'failed',
        claim: undefined,
        claimFencePending: false,
        claimRevalidationPending: false,
        claimHandoffPending: false,
        refreshError: null,
      });
      return;
    }
    if (claim?.status === 'active') {
      try {
        const released = await invoke<ShippingClaim>('release_shipping_claim', {
          repository: run.repository,
          expectedRepository: run.remote,
          number: issue.number,
          claim,
          instanceId: shippingInstanceId,
          reason: 'claim lost',
        });
        await updateShipIssue(run, issue, { claim: released });
      } catch (cause) {
        const settled = settledLostClaimFence(claim, cause);
        if (settled) {
          await updateShipIssue(run, issue, settled);
          return;
        }
        if (missingRepositoryPath(cause)) {
          await updateShipIssue(run, issue, {
            state: 'failed',
            claim: undefined,
            claimFencePending: false,
            claimRevalidationPending: false,
            claimHandoffPending: false,
            refreshError: null,
          });
          return;
        }
        await updateShipIssue(run, issue, {
          claimFencePending: true,
          refreshError: `Claim release failed: ${describe(cause)}`,
        });
        return;
      }
    }
    await updateShipIssue(run, issue, {
      state: 'failed',
      claimFencePending: false,
      claimRevalidationPending: false,
      claimHandoffPending: false,
      refreshError: null,
    });
  }

  async function failClosedShippingIssue(
    run: ShipRun,
    issue: ShipIssue,
    workerState: SpawnState,
  ): Promise<void> {
    const reason = closedWithoutMerge;
    await settleClosedPullRequest(
      workerState,
      async () => {
        await updateShipIssue(run, issue, {
          claimFencePending: true,
          workerSettled: false,
          blockedReason: reason,
        });
        await retryShippingClaimFence(run, issue);
        return !issue.claimFencePending;
      },
      () =>
        updateShipIssue(run, issue, {
          state: 'failed',
          workerSettled: true,
          error: reason,
        }),
    );
  }

  async function launchShipIssue(run: ShipRun, issue: ShipIssue): Promise<void> {
    const launchKey = `${run.id}:${issue.id}`;
    const ensureClaimHeld = () => {
      if (fencedShipLaunches.has(launchKey))
        throw new Error('Shipping claim was lost while the worker was launching.');
    };
    let claim = issue.claim;
    let authorization: DirectShipAuthorization | undefined;
    let receiptId: string | null = null;
    let launchedThreadId: string | null = null;
    let workerStopped = false;
    const persistLaunchFence = async (threadId: string, stopCause: unknown) => {
      const fence = {
        threadId,
        claimFencePending: true,
        workerSettled: false,
        blockedReason: 'Worker started before shipping state could be saved.',
        refreshError: `Worker fencing failed: ${describe(stopCause)}`,
      };
      try {
        await updateShipIssue(run, issue, fence);
      } catch (persistCause) {
        Object.assign(issue, fence);
        error = `Shipping worker fence persistence failed: ${describe(persistCause)}`;
      }
    };
    try {
      if (!claim || claim.status !== 'active') claim = await acquireShippingClaim(run, issue);
      ensureClaimHeld();
      authorization = shippingPromptAuthorization(run, issue);
      receiptId = crypto.randomUUID();
      await updateShipIssue(run, issue, { state: 'starting', receiptId });
      const created = await invoke<CreatedWorktree>('create_shipping_worktree', {
        repository: run.repository,
        name: issue.branch,
      });
      ensureClaimHeld();
      const shippingTarget =
        created.shippingTarget ??
        (await invoke<ShippingTarget>('shipping_worktree_target', {
          repository: run.repository,
          worktree: created.path,
          branch: created.branch,
        }));
      ensureClaimHeld();
      await updateShipIssue(run, issue, {
        path: created.path,
        branch: created.branch,
        shippingTarget,
      });
      saveProjectCatalog(addWorktree(projectCatalog, run.repository, created));
      if (shippingSetupAction(issue, created.setup) === 'run') {
        await updateShipIssue(run, issue, { setupStarted: true });
        await invoke('run_shipping_setup', { path: created.path });
        ensureClaimHeld();
        await updateShipIssue(run, issue, { setupCompleted: true });
      }
      const available = (await acp.agents()).find((agent) => agent.id === run.provider);
      if (!available?.available)
        throw new Error(available?.reason ?? `${run.provider} is unavailable.`);
      await acp.connect(run.provider, created.path);
      ensureClaimHeld();
      const gateExecution =
        'Before validation, call validation_policy with your explicit low, medium, or high risk choice. Inspect its selected risk, required gates, and sources, then run every selected review or test gate through validation_gate in a fresh subagent session for each pass or retry. The session may use the implementation provider and model. If a fresh gate session cannot launch, pause and report the reason in this thread.';
      const gateReporting =
        'Each validation session reports its own gate verdict through ship_progress; do not report review or test verdicts from this implementation session.';
      const target = shippingTarget;
      const prompt = shipWorkerPrompt({
        issueUrl: issue.url,
        claimId: claim.id,
        claimTask: claim.task,
        repository: target.repository,
        baseBranch: target.baseBranch,
        baseRevision: target.baseRevision,
        gateExecution,
        gateReporting,
        mergeOwner,
      });
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
        { kind: 'acp', agent: run.provider, title: issue.title },
        prompt,
        receiptId,
        false,
        undefined,
        undefined,
        authorization,
      );
      launchedThreadId = started.threadId;
      if (fencedShipLaunches.has(launchKey)) {
        throw new Error('Shipping claim was lost while the worker was launching.');
      }
      const persistence = await persistStartedShippingWorker(
        started.threadId,
        (threadId) => updateShipIssue(run, issue, { state: 'working', threadId }),
        (threadId) => stopShippingWorker({ ...issue, threadId }),
        persistLaunchFence,
      );
      if (persistence?.fencePending) return;
      if (persistence) {
        workerStopped = true;
        throw persistence.error;
      }
    } catch (cause) {
      const receipt = receiptId
        ? spawnReceipts.find((item) => item.receiptId === receiptId)
        : undefined;
      const workerThreadId = launchedThreadId ?? receipt?.targetId ?? null;
      if (workerThreadId && !workerStopped) {
        try {
          await stopShippingWorker({ ...issue, threadId: workerThreadId });
          workerStopped = true;
        } catch (stopCause) {
          await persistLaunchFence(workerThreadId, stopCause);
          return;
        }
      }
      if (receiptId && receipt && (!receipt.turnId || workerStopped)) {
        updateSpawnReceipt(receiptId, { state: 'failed', error: describe(cause) });
        await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
      }
      await updateShipIssue(run, issue, {
        state: 'failed',
        workerSettled: !workerThreadId || workerStopped,
        error: describe(cause),
      });
    }
  }

  async function refreshShippingClaim(
    run: ShipRun,
    issue: ShipIssue,
    revalidate = false,
    forceHeartbeat = false,
    resumeFence = false,
  ): Promise<boolean> {
    const key = `${run.id}:${issue.id}`;
    return serializeShippingClaimOperation(shipClaimOperations, key, () =>
      refreshShippingClaimLocked(run, issue, revalidate, forceHeartbeat, resumeFence),
    );
  }

  async function refreshShippingClaimLocked(
    run: ShipRun,
    issue: ShipIssue,
    revalidate: boolean,
    forceHeartbeat: boolean,
    resumeFence: boolean,
  ): Promise<boolean> {
    const claim = issue.claim;
    if (!claim || claim.status !== 'active') return true;
    if (!shippingClaimOwnedByInstance(claim, shippingInstanceId)) return false;
    const validationKey = `${run.id}:${issue.id}:${claim.id}:${claim.commentId}`;
    const monotonicNow = performance.now();
    const monotonicLeaseDeadline = shipClaimLeaseDeadlines.get(validationKey);
    if (
      issue.claimHandoffPending &&
      monotonicLeaseDeadline !== undefined &&
      monotonicNow >= monotonicLeaseDeadline
    ) {
      shipClaimHeartbeatDeadlines.delete(validationKey);
      shipClaimLeaseDeadlines.delete(validationKey);
      shipClaimLeaseWallDeadlines.delete(validationKey);
      clearShippingClaimLeaseFence(validationKey);
      await updateShipIssue(run, issue, {
        claimFencePending: true,
        workerSettled: false,
        blockedReason: 'Shipping claim expired during worker handoff.',
      });
      await retryShippingClaimFence(run, issue);
      return false;
    }
    const dispatchKey = `${run.id}:${issue.id}`;
    const taskWorkersSettled =
      issue.workerSettled === true && (await shippingTaskWorkersSettled(issue));
    const terminal =
      !forceHeartbeat &&
      terminalClaimReleaseReady(
        issue,
        shippingPromptDispatchPending(issue, dispatchKey),
        taskWorkersSettled,
      );
    const heartbeatDue =
      !terminal &&
      (forceHeartbeat ||
        (revalidate &&
          (!shipClaimHeartbeatDeadlines.has(validationKey) ||
            !shipClaimLeaseDeadlines.has(validationKey))) ||
        claimHeartbeatDue(monotonicNow, shipClaimHeartbeatDeadlines.get(validationKey)));
    const leaseStartedAt = performance.now();
    try {
      const updated = terminal
        ? await invoke<ShippingClaim>('release_shipping_claim', {
            repository: run.repository,
            expectedRepository: run.remote,
            number: issue.number,
            claim,
            instanceId: shippingInstanceId,
            reason: terminalClaimReleaseReason(issue),
          })
        : heartbeatDue
          ? await invoke<ShippingClaim>('heartbeat_shipping_claim', {
              repository: run.repository,
              expectedRepository: run.remote,
              number: issue.number,
              claim,
              instanceId: shippingInstanceId,
              leaseMillis: 120_000,
            })
          : claim;
      const heartbeatActive =
        heartbeatDue && updated !== claim
          ? await persistVerifiedHeartbeat(updated, (verified) =>
              updateShipIssue(run, issue, { claim: verified }),
            )
          : true;
      if (!heartbeatDue && updated !== claim) await updateShipIssue(run, issue, { claim: updated });
      if (heartbeatDue && !heartbeatActive) {
        shipClaimHeartbeatDeadlines.delete(validationKey);
        shipClaimLeaseDeadlines.delete(validationKey);
        shipClaimLeaseWallDeadlines.delete(validationKey);
        clearShippingClaimLeaseFence(validationKey);
        await updateShipIssue(run, issue, {
          claimFencePending: true,
          claimRevalidationPending: false,
          workerSettled: false,
          blockedReason: `Shipping claim lost: ${updated.releaseReason ?? 'heartbeat verification failed'}`,
          refreshError: null,
        });
        await retryShippingClaimFence(run, issue);
        return false;
      }
      if (heartbeatDue && issue.claimFencePending && !resumeFence) {
        shipClaimHeartbeatDeadlines.delete(validationKey);
        shipClaimLeaseDeadlines.delete(validationKey);
        shipClaimLeaseWallDeadlines.delete(validationKey);
        clearShippingClaimLeaseFence(validationKey);
        return false;
      }
      if (heartbeatDue && updated.status === 'active') {
        shipClaimResumeValidations.delete(validationKey);
        const leaseDeadline = claimMonotonicLeaseDeadline(leaseStartedAt, updated);
        shipClaimLeaseDeadlines.set(validationKey, leaseDeadline);
        shipClaimLeaseWallDeadlines.set(
          validationKey,
          Date.now() + Math.max(0, leaseDeadline - performance.now()),
        );
        scheduleShippingClaimLeaseFence(run, issue, validationKey, leaseDeadline);
        shipClaimHeartbeatDeadlines.set(
          validationKey,
          nextClaimHeartbeatDeadline(performance.now(), leaseDeadline),
        );
      }
      if (terminal) {
        shipClaimResumeValidations.delete(validationKey);
        shipClaimHeartbeatDeadlines.delete(validationKey);
        shipClaimLeaseDeadlines.delete(validationKey);
        shipClaimLeaseWallDeadlines.delete(validationKey);
        clearShippingClaimLeaseFence(validationKey);
      }
      return true;
    } catch (cause) {
      const message = describe(cause);
      if (
        !terminal &&
        claimRefreshRequiresFence(claim, cause, monotonicNow, monotonicLeaseDeadline)
      ) {
        shipClaimHeartbeatDeadlines.delete(validationKey);
        shipClaimLeaseDeadlines.delete(validationKey);
        shipClaimLeaseWallDeadlines.delete(validationKey);
        clearShippingClaimLeaseFence(validationKey);
        await updateShipIssue(run, issue, {
          claimFencePending: true,
          claimRevalidationPending: false,
          workerSettled: false,
          blockedReason: `Shipping claim lost: ${message}`,
          refreshError: null,
        });
        await retryShippingClaimFence(run, issue);
        return false;
      }
      await updateShipIssue(run, issue, { refreshError: `Claim: ${message}` }, false);
      return !revalidate && !heartbeatDue;
    }
  }

  async function waitForAcpWorkerTermination(
    agent: string,
    worktreeDirectory: string,
    sessionId: string,
    turnId: string | null,
    deadline: number,
  ): Promise<void> {
    const [agentActivity, interrupted] = await Promise.all([
      acp.activity(worktreeDirectory),
      acp.interruptedTurns(),
    ]);
    if (acpWorkerTerminationConfirmed(agentActivity[agent], interrupted, agent, sessionId, turnId))
      return;
    if (monotonicDeadlineExpired(performance.now(), deadline))
      throw new Error('ACP worker did not confirm termination after cancellation.');
    await new Promise((resolve) => setTimeout(resolve, 100));
    return waitForAcpWorkerTermination(agent, worktreeDirectory, sessionId, turnId, deadline);
  }

  async function stopShippingThread(issue: ShipIssue, threadId: string): Promise<void> {
    const match = /^acp:([^:]+):(.+)$/.exec(threadId);
    if (!match) throw new Error('Worker thread cannot be interrupted automatically.');
    const primaryReceipt = spawnReceipts.find((item) => item.receiptId === issue.receiptId);
    const receipt =
      primaryReceipt?.targetId === threadId
        ? primaryReceipt
        : spawnReceipts.find(
            (item) => item.targetId === threadId && item.targetDirectory === issue.path,
          );
    const [, agent, sessionId] = match;
    const turnId = receipt?.turnId ?? null;
    try {
      await acp.cancel(agent, issue.path ?? '', sessionId, turnId);
      await waitForAcpWorkerTermination(
        agent,
        issue.path ?? '',
        sessionId,
        turnId,
        performance.now() + 5_000,
      );
    } catch (cause) {
      if (!shippingWorkerGone(cause)) throw cause;
    }
    if (receipt) updateSpawnReceipt(receipt.receiptId, { state: 'interrupted' });
  }

  async function stopShippingWorker(issue: ShipIssue): Promise<void> {
    const primaryThreadId =
      issue.threadId ?? spawnReceipts.find((item) => item.receiptId === issue.receiptId)?.targetId;
    await fenceShippingTaskThreads(
      [primaryThreadId, ...(issue.checkpointThreadIds ?? [])],
      (threadId) => stopShippingThread(issue, threadId),
    );
  }

  function beginShippingResumeFence(run: ShipRun, issue: ShipIssue, validationKey: string): void {
    if (shipClaimResumeFences.has(validationKey)) return;
    const fence = (async () => {
      const workersAlreadySettled =
        issue.workerSettled === true && (await shippingTaskWorkersSettled(issue));
      await updateShipIssue(run, issue, {
        claimFencePending: true,
        claimRevalidationPending: true,
        workerSettled: workersAlreadySettled,
        blockedReason: 'Worker paused while the shipping claim is revalidated after system resume.',
      });
      try {
        await fenceResumedShippingClaim(
          async () => {
            if (workersAlreadySettled) return;
            await stopShippingWorker(issue);
          },
          async () => {
            const terminal = issue.state === 'merged' || issue.state === 'failed';
            await updateShipIssue(run, issue, {
              ...(terminal ? { claimFencePending: false } : {}),
              workerSettled: true,
              workerState: 'interrupted',
            });
            return refreshShippingClaim(run, issue, true, !terminal, true);
          },
          () => updateShipIssue(run, issue, resumedShippingIssueChanges(issue)),
        );
      } catch (cause) {
        await updateShipIssue(run, issue, {
          refreshError: `Resume fencing failed: ${describe(cause)}`,
        });
      }
    })()
      .catch((cause) => {
        error = `Resume fencing failed: ${describe(cause)}`;
      })
      .finally(() => shipClaimResumeFences.delete(validationKey));
    shipClaimResumeFences.set(validationKey, fence);
  }

  async function retryShippingResumeValidation(run: ShipRun, issue: ShipIssue): Promise<void> {
    const terminal = issue.state === 'merged' || issue.state === 'failed';
    const workersAlreadySettled =
      issue.workerSettled === true && (await shippingTaskWorkersSettled(issue));
    try {
      await fenceResumedShippingClaim(
        async () => {
          if (workersAlreadySettled) return;
          await stopShippingWorker(issue);
          await updateShipIssue(run, issue, {
            workerSettled: true,
            workerState: 'interrupted',
            refreshError: null,
          });
        },
        () => refreshShippingClaim(run, issue, true, !terminal, true),
        () => updateShipIssue(run, issue, resumedShippingIssueChanges(issue)),
      );
    } catch (cause) {
      await updateShipIssue(run, issue, {
        claimFencePending: true,
        claimRevalidationPending: true,
        workerSettled: false,
        refreshError: `Resume fencing failed: ${describe(cause)}`,
      });
    }
  }

  async function shippingTaskWorkersSettled(issue: ShipIssue): Promise<boolean> {
    const threadIds = [...new Set([issue.threadId, ...(issue.checkpointThreadIds ?? [])])].filter(
      (threadId): threadId is string => Boolean(threadId),
    );
    if (!threadIds.length) return issue.workerSettled === true;
    const states = Object.fromEntries(
      await Promise.all(
        threadIds.map(async (threadId) => [
          threadId,
          await directShipWorkerState({ ...issue, threadId }),
        ]),
      ),
    );
    return shipTaskThreadsSettled(issue, states, spawnReceipts);
  }

  function scheduleShipLaunch(run: ShipRun, issue: ShipIssue): void {
    const key = `${run.id}:${issue.id}`;
    if (activeShipLaunches.has(key)) return;
    fencedShipLaunches.delete(key);
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
  const shippingPullRequestGenerations = new Map<string, number>();
  async function refreshShippingPullRequest(
    run: ShipRun,
    issue: ShipIssue,
    revision?: string,
    worktreePath?: string | null,
    baseRevision?: string,
  ): Promise<void> {
    const refreshKey = `${run.id}:${issue.id}`;
    const isLatestRefresh = beginLatestRefresh(shippingPullRequestGenerations, refreshKey);
    try {
      const shippingTarget = worktreePath
        ? await shippingTargetFor(run, issue, worktreePath)
        : issue.shippingTarget;
      if (!shippingTarget)
        throw new Error('Shipping target is unavailable for pull request lookup.');
      const targetRepository = shippingTarget.repository;
      if (targetRepository.toLowerCase() !== run.remote.toLowerCase())
        throw new Error('Stored shipping target does not match the approved issue repository.');
      const pr = await invoke<ShippingPullRequest | null>('shipping_pull_request', {
        repository: run.repository,
        branch: issue.branch,
        targetRepository,
        baseBranch: shippingTarget.baseBranch,
      });
      if (!isLatestRefresh()) return;
      if (pr) shippingPullRequests.set(refreshKey, pr);
      else shippingPullRequests.delete(refreshKey);
      const cleanCommit =
        revision && worktreePath
          ? await invoke<string | null>('working_tree_commit', { path: worktreePath })
          : null;
      if (!isLatestRefresh()) return;
      const refreshedRevision =
        revision && worktreePath
          ? await invoke<string>('working_tree_revision', { path: worktreePath })
          : revision;
      if (!isLatestRefresh()) return;
      const currentIssue = run.issues.find((item) => item.id === issue.id) ?? issue;
      let evidenceManifests = currentIssue.evidenceManifests ?? [];
      const checkpoint = currentIssue.checkpoint;
      if (refreshedRevision && checkpoint)
        evidenceManifests = syncEvidenceManifest(
          evidenceManifests,
          refreshedRevision,
          checkpoint.acceptanceCriteria,
          Date.now(),
          baseRevision,
        );
      if (
        pr &&
        revision &&
        refreshedRevision === revision &&
        checkpoint &&
        cleanCommit === pr.headRefOid
      ) {
        const timestamp = Date.now();
        const observations: TaskEvidence[] = pr.checks.map((check) => {
          const identity = ciEvidenceIdentity(revision, check);
          const state = checkState(check);
          return {
            id: identity.id,
            kind: 'command',
            name: `ci:${check.name}`,
            provider: 'github',
            model: null,
            result: state === 'passing' ? 'passed' : state === 'failing' ? 'failed' : 'pending',
            timestamp,
            outputReference: check.url || pr.url,
            criteria: [],
            economics: {
              ...syntheticCiEconomics(),
              failedCommands: state === 'failing' ? 1 : 0,
            },
            identityUncertain: identity.uncertain,
            reconciliationKey: identity.reconciliationKey,
            executionOrder: identity.executionOrder,
          };
        });
        evidenceManifests = reconcileCiEvidenceSnapshot(
          evidenceManifests,
          revision,
          observations,
          baseRevision,
        );
        for (const observation of observations) {
          evidenceManifests = recordCiEvidenceObservation(
            evidenceManifests,
            revision,
            checkpoint.acceptanceCriteria,
            observation,
            baseRevision,
          );
        }
      }
      await updateShipIssue(
        run,
        issue,
        {
          ...refreshedPullRequest(currentIssue, pr),
          ...(pr && currentIssue.ciTriages
            ? {
                ciTriages: resolveCiFailureTriages(
                  currentIssue.ciTriages,
                  pr.headRefOid,
                  new Set(
                    pr.checks
                      .filter((check) => checkState(check) === 'passing')
                      .map((check) => check.name),
                  ),
                  Date.now(),
                ),
              }
            : {}),
          ...(refreshedRevision
            ? {
                evidenceRevision: refreshedRevision,
                evidenceManifests,
                evidenceCommit:
                  refreshedRevision === revision ? (cleanCommit ?? undefined) : undefined,
              }
            : {}),
        },
        false,
      );
    } catch (cause) {
      if (!isLatestRefresh()) return;
      await updateShipIssue(run, issue, { refreshError: describe(cause) }, false);
    }
  }

  async function directShipWorkerState(issue: ShipIssue): Promise<SpawnState> {
    if (!issue.threadId || !issue.path) return 'unavailable';
    const native = nativeChildReceipts.find(
      (receipt) =>
        sameThreadId(receipt.targetId, issue.threadId!) && receipt.targetDirectory === issue.path,
    );
    if (native) return native.state;
    const match = /^acp:([^:]+):(.+)$/.exec(issue.threadId);
    if (!match) return 'unavailable';
    const [, agent, sessionId] = match;
    try {
      const [agentActivity, interrupted] = await Promise.all([
        acp.activity(issue.path ?? ''),
        acp.interruptedTurns(),
      ]);
      const state = agentActivity[agent];
      if (state?.waiting.includes(sessionId)) return 'waiting';
      if (state?.active.includes(sessionId)) return 'working';
      if (interrupted.some((turn) => turn.agent === agent && turn.sessionId === sessionId))
        return 'interrupted';
      if (state?.finished[sessionId]?.status === 'failed') return 'failed';
      if (state?.finished[sessionId]?.status === 'interrupted') return 'interrupted';
      if (state?.finished[sessionId] || state?.sessions.includes(sessionId)) return 'completed';
      return 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  async function settledShipOwnershipSnapshot(issue: ShipIssue): Promise<{
    generation: number;
    nativeGeneration: number;
    ownershipGeneration: string;
    receipts: SpawnReceipt[];
  } | null> {
    const nativeGeneration = await reconcileProviderNativeSubagents(issue);
    const generation = nativeSubagentGeneration;
    const receipts = [...spawnReceipts, ...nativeChildReceipts];
    const receiptSnapshot = JSON.stringify(
      receipts
        .filter(
          (receipt) =>
            receipt.sourceDirectory === issue.path || receipt.targetDirectory === issue.path,
        )
        .map((receipt) => [
          receipt.receiptId,
          receipt.sourceId,
          receipt.targetId,
          receipt.sourceDirectory,
          receipt.targetDirectory,
          receipt.state,
        ])
        .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
    );
    const threadIds = [...new Set(shipOwnedThreadIds(issue, receipts))];
    const ownershipGeneration = shipOwnershipQuietGeneration(generation, nativeGeneration, []);
    const states = Object.fromEntries(
      await Promise.all(
        threadIds.map(async (threadId) => [
          threadId,
          await directShipWorkerState({ ...issue, threadId }),
        ]),
      ),
    );
    const currentReceipts = [...spawnReceipts, ...nativeChildReceipts];
    const currentSnapshot = JSON.stringify(
      currentReceipts
        .filter(
          (receipt) =>
            receipt.sourceDirectory === issue.path || receipt.targetDirectory === issue.path,
        )
        .map((receipt) => [
          receipt.receiptId,
          receipt.sourceId,
          receipt.targetId,
          receipt.sourceDirectory,
          receipt.targetDirectory,
          receipt.state,
        ])
        .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
    );
    if (
      !shipOwnershipQuietPass(generation, nativeSubagentGeneration, false).settled ||
      receiptSnapshot !== currentSnapshot ||
      !shipTaskThreadsSettled(issue, states, receipts)
    )
      return null;
    return {
      generation,
      nativeGeneration,
      ownershipGeneration,
      receipts,
    };
  }

  function missingRepositoryPath(cause: unknown): boolean {
    return describe(cause) === 'Repository path does not exist. Choose an existing directory.';
  }

  async function shippingTargetFor(
    run: ShipRun,
    issue: ShipIssue,
    path: string,
  ): Promise<ShippingTarget> {
    if (!issue.branch) {
      const registered = await invoke<RegisteredWorktree[]>('registered_worktrees', {
        repository: run.repository,
        paths: [path],
      });
      const branch = registeredShipBranch(registered, path);
      await updateShipIssue(run, issue, { branch });
    }
    if (issue.shippingTarget) {
      if (issue.shippingTarget.repository.toLowerCase() !== run.remote.toLowerCase())
        throw new Error('Stored shipping target does not match the approved issue repository.');
      return issue.shippingTarget;
    }
    const shippingTarget = await invoke<ShippingTarget>('shipping_worktree_target', {
      repository: run.repository,
      worktree: path,
      branch: issue.branch,
    });
    if (shippingTarget.repository.toLowerCase() !== run.remote.toLowerCase())
      throw new Error('Shipping worktree target does not match the approved issue repository.');
    await updateShipIssue(run, issue, { shippingTarget });
    return shippingTarget;
  }

  async function refreshShippingIssue(
    run: ShipRun,
    issue: ShipIssue,
    refreshCompleted = false,
  ): Promise<void> {
    const update = (changes: Partial<ShipIssue>) => updateShipIssue(run, issue, changes, false);
    const recoveredHandoffs = reconcileHandoffOutcomes(
      issue.contextHandoffs,
      spawnReceipts,
      issue.retryCount ?? 0,
      issue.lostStateFailures ?? 0,
    );
    if (recoveredHandoffs !== issue.contextHandoffs)
      await update({ contextHandoffs: recoveredHandoffs });
    const dispatchKey = `${run.id}:${issue.id}`;
    if (issue.dispatchFencePending) {
      if (
        !(await fencePendingPromptDispatch(
          run,
          issue,
          issue.blockedReason ?? 'Prompt dispatch did not settle before worker fencing.',
        ))
      )
        return;
      if (issue.state !== 'merged' && issue.state !== 'failed')
        await update({
          state: 'failed',
          error: 'Prompt dispatch did not settle before worker fencing.',
        });
      return;
    }
    if (
      (issue.state === 'merged' || issue.state === 'failed') &&
      issue.workerSettled &&
      shippingPromptDispatchPending(issue, dispatchKey) &&
      !(await fencePendingPromptDispatch(
        run,
        issue,
        'Terminal issue retained an unsettled prompt dispatch.',
      ))
    )
      return;
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
    const worktreeGone = path
      ? !(await invoke<boolean>('repository_path_available', { path }).catch(() => true))
      : false;
    if (worktreeGone && !issue.worktreeUnavailable) await update({ worktreeUnavailable: true });
    else if (!worktreeGone && issue.worktreeUnavailable && !isDirectShipRun(run))
      await update({ worktreeUnavailable: false });
    if (worktreeGone && !issue.shippingTarget && issue.branch) {
      const target = await invoke<ShippingTarget>('shipping_repository_target', {
        repository: run.repository,
        branch: issue.branch,
      }).catch(() => null);
      if (target && target.repository.toLowerCase() === run.remote.toLowerCase())
        await update({ shippingTarget: target });
    }
    const pullRequestPath = worktreeGone ? null : path;
    const pullRequestLookup = !worktreeGone || !!issue.shippingTarget;
    let currentRevision: string | undefined;
    let currentBaseRevision: string | undefined;
    if (path && !worktreeGone) {
      const shippingTarget = await shippingTargetFor(run, issue, path);
      const models = implementationModels(path);
      const modelUncertain = implementationAttributionUncertain(path);
      const workerModel = resolvedWorkerModel({ ...issue, models });
      if (
        JSON.stringify(models) !== JSON.stringify(issue.models) ||
        modelUncertain !== issue.modelUncertain ||
        workerModel !== issue.workerModel
      )
        await update({ models, modelUncertain, workerModel });
      const [revision, baseRevision] = await Promise.all([
        invoke<string>('working_tree_revision', { path }),
        invoke<string>('shipping_base_revision', { path, baseRef: shippingTarget.baseRef }),
      ]);
      currentRevision = revision;
      currentBaseRevision = baseRevision;
      await markValidationRevisionDrift(path, currentRevision);
      if (
        issue.validationPolicy &&
        issue.validationPolicy.baseRevision !== currentBaseRevision &&
        issue.blockedReason !== 'The shipping base changed. Select validation risk again.'
      )
        await update({
          blockedReason: 'The shipping base changed. Select validation risk again.',
          events: appendShipEvent(
            issue.events,
            'validation policy invalidated',
            'shipping base changed',
          ),
        });
      if (issue.checkpoint) {
        const evidenceManifests = syncEvidenceManifest(
          issue.evidenceManifests ?? [],
          currentRevision,
          issue.checkpoint.acceptanceCriteria,
          Date.now(),
          currentBaseRevision,
        );
        if (
          issue.evidenceRevision !== currentRevision ||
          JSON.stringify(issue.evidenceManifests ?? []) !== JSON.stringify(evidenceManifests)
        )
          await update({
            evidenceRevision: currentRevision,
            evidenceManifests,
            ...(issue.evidenceRevision !== currentRevision ? { evidenceCommit: undefined } : {}),
          });
      }
    }
    issue.gates = reconciledShipGates(issue, spawnReceipts);
    const recoveredEvidence = recoverValidationEvidence(issue, currentBaseRevision);
    if (recoveredEvidence) await update(recoveredEvidence);
    await Promise.all(
      (issue.gates ?? []).map(async (gate) => {
        const receipt = spawnReceipts.find((item) => item.receiptId === gate.id);
        if (receipt && !shippingWorkerSettled(receipt.state)) await currentSpawnReceipt(receipt);
      }),
    );
    issue.gates = reconciledShipGates(issue, spawnReceipts);
    if (isDirectShipRun(run)) {
      let workerState = await directShipWorkerState(issue);
      if (shippingPromptDispatchPending(issue, dispatchKey) && workerStateSettled(workerState)) {
        if (
          !(await fencePendingPromptDispatch(
            run,
            issue,
            'Worker reported a terminal state before prompt dispatch settled.',
          ))
        )
          return;
        workerState = 'interrupted';
      }
      if (workerState !== issue.workerState) await update({ workerState });
      if (issue.claimHandoffPending) {
        const claim = issue.claim;
        const validationKey = claim ? `${run.id}:${issue.id}:${claim.id}:${claim.commentId}` : '';
        if (
          !(await settleDirectClaimHandoff(
            issue,
            workerState,
            async () => {
              await update({
                claimFencePending: true,
                workerSettled: false,
                blockedReason: 'Shipping claim expired during worker handoff.',
              });
              await retryShippingClaimFence(run, issue);
            },
            () => update({ claimHandoffPending: false }),
            performance.now(),
            shipClaimLeaseDeadlines.get(validationKey),
          ))
        )
          return;
      }
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
        if (issue.title === `Issue #${issue.number}`) {
          const title = await invoke<string>('ship_issue_title', {
            repository: run.repository,
            reference: issue.id,
          }).catch(() => '');
          if (title) await update({ title });
        }
        const branch = worktree?.branch ?? issue.branch;
        if (branch && issue.state !== 'pending' && pullRequestLookup)
          await refreshShippingPullRequest(
            run,
            { ...issue, branch },
            currentRevision,
            pullRequestPath,
            currentBaseRevision,
          );
        if (issue.refreshError) return;
        const pr = shippingPullRequests.get(`${run.id}:${issue.id}`);
        if (pr?.mergedAt) {
          await update({
            state: 'merged',
            workerSettled: workerStateSettled(workerState),
            error: null,
          });
        } else if (pr?.state === 'CLOSED') {
          await failClosedShippingIssue(run, issue, workerState);
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
    if (issue.state !== 'pending' && pullRequestLookup)
      await refreshShippingPullRequest(
        run,
        issue,
        currentRevision,
        pullRequestPath,
        currentBaseRevision,
      );
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
        const workerState = (await currentSpawnReceipt(receipt)).state;
        if (!shippingWorkerSettled(workerState)) return;
        if (
          shippingPromptDispatchPending(issue, dispatchKey) &&
          !(await fencePendingPromptDispatch(
            run,
            issue,
            'Worker reported a terminal state before prompt dispatch settled.',
          ))
        )
          return;
        await update({ workerSettled: true });
      }
      const ownership = await settledShipOwnershipSnapshot(issue);
      if (
        issue.path &&
        shipGatesSettled(issue) &&
        ownership &&
        shipEvidenceReadiness(issue).ready &&
        (issue.validationPolicyRequired === false ||
          requiredShipGatesSatisfied(issue.validationPolicy, issue.gates ?? []))
      ) {
        try {
          await updateShipIssue(
            run,
            issue,
            worktreeGone ? {} : await settledImplementationAttribution(issue.path),
          );
          if (
            !shipGatesSettled(issue) ||
            !shipEvidenceReadiness(issue).ready ||
            (issue.validationPolicyRequired !== false &&
              !requiredShipGatesSatisfied(issue.validationPolicy, issue.gates ?? []))
          )
            return;
          if (nativeSubagentGeneration !== ownership.generation) return;
          const confirmedOwnership = await settledShipOwnershipSnapshot(issue);
          if (
            !confirmedOwnership ||
            confirmedOwnership.generation !== ownership.generation ||
            confirmedOwnership.nativeGeneration !== ownership.nativeGeneration ||
            confirmedOwnership.ownershipGeneration !== ownership.ownershipGeneration
          )
            return;
          const archivePath = await invoke<string | null>('delete_worktree', {
            request: {
              ...shipCleanupRequest(run.repository, issue, currentRevision),
              nativeGeneration: confirmedOwnership.nativeGeneration,
            },
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
    const pr = shippingPullRequests.get(`${run.id}:${issue.id}`);
    if (pr?.url && pr.url !== issue.pullRequest) await update({ pullRequest: pr.url });
    if (pr?.mergedAt) {
      await update({ state: 'merged', error: null });
      return;
    }
    if (pr?.state === 'CLOSED') {
      const receipt = spawnReceipts.find((item) => item.receiptId === issue.receiptId);
      const workerState = receipt ? (await currentSpawnReceipt(receipt)).state : 'unavailable';
      if (
        shippingWorkerSettled(workerState) &&
        shippingPromptDispatchPending(issue, dispatchKey) &&
        !(await fencePendingPromptDispatch(
          run,
          issue,
          'Worker reported a terminal state before prompt dispatch settled.',
        ))
      )
        return;
      await failClosedShippingIssue(run, issue, workerState);
      return;
    }
    let receipt = spawnReceipts.find((item) => item.receiptId === issue.receiptId);
    if (issue.state === 'working') {
      const replacement = pendingHandoffReplacement(issue, spawnReceipts);
      if (replacement) {
        const dispatchAction = await replacementDispatchAction(replacement);
        if (dispatchAction === 'reject') {
          updateSpawnReceipt(replacement.receiptId, {
            state: 'failed',
            error: 'Replacement prompt was not proven dispatched; retry the pending handoff.',
          });
          await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
          await updateShipIssue(run, issue, {
            error:
              'Replacement prompt dispatch could not be proven. Inspect it, then retry the pending handoff.',
            workerSettled: true,
            workerState: 'interrupted',
          });
          return;
        }
        if (dispatchAction === 'inspect') {
          preserveReplacementForInspection(replacement);
          await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
        }
        const handoffId = replacement.requestId.slice('handoff:'.length);
        const startedAt = Date.now();
        await updateShipIssue(run, issue, {
          receiptId: replacement.receiptId,
          threadId: replacement.targetId,
          checkpointThreadIds: (issue.checkpointThreadIds ?? []).filter(
            (threadId) => threadId !== replacement.sourceId,
          ),
          contextHandoffs: (issue.contextHandoffs ?? []).map((handoff) =>
            handoff.id === handoffId
              ? transferHandoffOwnership(
                  handoff,
                  replacement.targetId!,
                  startedAt,
                  issue.retryCount ?? 0,
                  issue.lostStateFailures ?? 0,
                )
              : handoff,
          ),
          contextPercent: undefined,
          handoffRecoveryRequired: dispatchAction === 'inspect',
          error: dispatchAction === 'inspect' ? replacementInspectionError : null,
          refreshError: null,
          workerSettled: false,
          workerState: dispatchAction === 'inspect' ? 'unavailable' : 'starting',
        });
        receipt =
          spawnReceipts.find((item) => item.receiptId === replacement.receiptId) ?? replacement;
      }
    }
    if (issue.state === 'failed') {
      const currentReceipt =
        receipt && !shippingWorkerSettled(receipt.state)
          ? await currentSpawnReceipt(receipt)
          : receipt;
      if (
        currentReceipt &&
        shippingWorkerSettled(currentReceipt.state) &&
        shippingPromptDispatchPending(issue, dispatchKey) &&
        !(await fencePendingPromptDispatch(
          run,
          issue,
          'Worker reported a terminal state before prompt dispatch settled.',
        ))
      )
        return;
      if (currentReceipt && shippingWorkerSettled(currentReceipt.state) && !issue.workerSettled)
        await update({ workerSettled: true });
      if (
        issue.error === 'Worker finished without a pull request. Inspect its thread.' &&
        currentReceipt?.state === 'completed' &&
        pr?.url
      )
        await update({ state: 'awaiting_merge', error: null });
      return;
    }
    if (issue.state === 'starting') {
      if (!receipt || !receipt.targetId || !receipt.turnId) {
        const existing = await invoke<CreatedWorktree | null>('find_shipping_worktree', {
          repository: run.repository,
          name: issue.branch,
        });
        if (existing && (issue.path !== existing.path || !issue.shippingTarget))
          await update({ path: existing.path, shippingTarget: existing.shippingTarget });
        scheduleShipLaunch(run, issue);
      } else {
        const authorization = shippingPromptAuthorizationForReceipt(receipt);
        await completeAuthorizedPromptRecovery(
          authorization,
          () => recoverShippingAcpPrompt(receipt, authorization),
          () => update({ state: 'working', threadId: receipt.targetId }),
        );
      }
    } else if (issue.state === 'working') {
      if (!receipt)
        await update({
          state: 'failed',
          error: 'Worker receipt is missing. Inspect its thread.',
        });
      else {
        if (handoffPromptNeedsRecovery(issue, receipt)) {
          const authorization = shippingPromptAuthorizationForReceipt(receipt);
          await completeAuthorizedPromptRecovery(
            authorization,
            () => recoverShippingAcpPrompt(receipt, authorization),
            async () => undefined,
          );
        }
        const current = await currentSpawnReceipt(receipt);
        const recoveryRequired = handoffReceiptNeedsResolution(current);
        if (recoveryRequired !== (issue.handoffRecoveryRequired === true))
          await update({
            handoffRecoveryRequired: recoveryRequired,
            error: resolvedHandoffRecoveryError(recoveryRequired, issue.error),
          });
        if (current.state === 'completed') {
          if (
            shippingPromptDispatchPending(issue, dispatchKey) &&
            !(await fencePendingPromptDispatch(
              run,
              issue,
              'Worker reported a terminal state before prompt dispatch settled.',
            ))
          )
            return;
          if (pr?.url) await update({ state: 'awaiting_merge', workerSettled: true, error: null });
          else if (Date.now() - current.updated > 60_000)
            await update({
              state: 'failed',
              workerSettled: true,
              error: 'Worker finished without a pull request. Inspect its thread.',
            });
        } else if (['failed', 'interrupted'].includes(current.state)) {
          if (
            shippingPromptDispatchPending(issue, dispatchKey) &&
            !(await fencePendingPromptDispatch(
              run,
              issue,
              'Worker reported a terminal state before prompt dispatch settled.',
            ))
          )
            return;
          await update({
            state: 'failed',
            workerSettled: true,
            error: current.error ?? `Worker ${current.state}.`,
          });
        }
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
      run.issues.map((issue) =>
        (async () => {
          const receipt = spawnReceipts.find((item) => item.receiptId === issue.receiptId);
          const claim = issue.claim;
          const claimOwned = shippingClaimOwnedByInstance(claim, shippingInstanceId);
          if (claim?.status === 'active' && !claimOwned) {
            await reconcileForeignShippingClaim(run, issue);
            return;
          }
          const validationKey = claim ? `${run.id}:${issue.id}:${claim.id}:${claim.commentId}` : '';
          const resumeFence = shipClaimResumeFences.get(validationKey);
          if (resumeFence) {
            await resumeFence;
            return;
          }
          if (
            issue.state === 'starting' &&
            !issue.threadId &&
            receipt?.targetId &&
            !activeShipLaunches.has(`${run.id}:${issue.id}`)
          ) {
            await updateShipIssue(run, issue, {
              threadId: receipt.targetId,
              claimFencePending: true,
              workerSettled: false,
              blockedReason: 'Worker launch was interrupted before shipping state was saved.',
            });
          }
          await refreshShippingIssueAfterClaim(
            issue,
            (revalidate) => refreshShippingClaim(run, issue, revalidate),
            () => acquireRecoveredShippingClaim(run, issue),
            () => refreshShippingIssue(run, issue, refreshCompleted),
            () => retryShippingClaimFence(run, issue),
            () => retryShippingResumeValidation(run, issue),
            claimOwned,
          );
        })(),
      ),
    );
  }

  function launchReadyShipIssues(run: ShipRun): void {
    const unsettledReceiptIds = new Set(
      spawnReceipts
        .filter((receipt) => receipt.dispatchPending || !shippingWorkerSettled(receipt.state))
        .map((receipt) => receipt.receiptId),
    );
    for (const issue of readyShipIssues(run, unsettledReceiptIds)) scheduleShipLaunch(run, issue);
  }

  const shipRepairMisses = new SvelteMap<string, { key: string; retryAt: number }>();
  const shipRepositoryDeadSince = new SvelteMap<string, number>();

  // Older runs stored a worktree path as their repository; once that worktree
  // is deleted every claim and fence call fails, so point them at the checkout.
  // Returns when each still-unrecoverable run was first seen dead.
  async function repairShipRunRepositories(): Promise<Map<string, number>> {
    const runs = shipRuns.filter((run) => !shipRunArchived(run));
    const available = await Promise.all(
      runs.map((run) =>
        invoke<boolean>('repository_path_available', { path: run.repository }).catch(() => true),
      ),
    );
    const dead = runs.filter((_, index) => !available[index]);
    for (const [index, run] of runs.entries())
      if (available[index]) shipRepositoryDeadSince.delete(run.id);
    if (!dead.length) return new SvelteMap();
    const catalogKey = projectCatalog.repositories.join('\0');
    const now = Date.now();
    const lookups = dead.filter((run) => {
      const miss = shipRepairMisses.get(run.id);
      return !miss || miss.key !== catalogKey || miss.retryAt <= now;
    });
    const repaired = new SvelteSet<string>();
    if (lookups.length) {
      const candidates = await Promise.all(
        projectCatalog.repositories.map(async (path) => {
          try {
            return {
              path,
              remote: await invoke<string>('shipping_target_repository', { repository: path }),
              failed: false,
            };
          } catch {
            return { path, remote: null, failed: true };
          }
        }),
      );
      const lookupFailed = candidates.some((candidate) => candidate.failed);
      for (const run of lookups) {
        const repository = repositoryForRemote(
          candidates,
          run.remote,
          owningRepository(projectCatalog, run.repository),
        );
        if (repository) {
          run.repository = repository;
          repaired.add(run.id);
          shipRepairMisses.delete(run.id);
          continue;
        }
        const since = shipRepositoryDeadSince.get(run.id) ?? now;
        const definitive = !lookupFailed || unrecoverableGraceExpired(since, now);
        shipRepairMisses.set(run.id, {
          key: catalogKey,
          retryAt: definitive ? Number.POSITIVE_INFINITY : now + 60_000,
        });
      }
      if (repaired.size) await saveShipRuns();
    }
    const unrecoverable = new SvelteMap<string, number>();
    for (const run of dead) {
      if (repaired.has(run.id)) {
        shipRepositoryDeadSince.delete(run.id);
        continue;
      }
      const since = shipRepositoryDeadSince.get(run.id) ?? Date.now();
      shipRepositoryDeadSince.set(run.id, since);
      unrecoverable.set(run.id, since);
    }
    return unrecoverable;
  }

  async function settleUnrecoverableShipRun(run: ShipRun): Promise<void> {
    const reason = 'Shipping repository no longer exists. Start a new run from the project.';
    await Promise.all(
      run.issues.map(async (issue) => {
        const plan = unrecoverableIssuePlan(issue);
        if (plan === 'none') return;
        if (plan === 'fail') await fenceRecoveredShippingWorker(run, issue, reason);
        if (plan === 'fail' && !issue.workerSettled) return;
        const keepsState =
          plan === 'clear' && (issue.state === 'merged' || issue.state === 'awaiting_merge');
        await updateShipIssue(run, issue, {
          claim: undefined,
          claimFencePending: false,
          refreshError: null,
          ...(keepsState
            ? {}
            : {
                claimRevalidationPending: false,
                claimHandoffPending: false,
                worktreeUnavailable: true,
              }),
        });
      }),
    );
  }

  async function tickShippingRuns(refreshCompleted = false): Promise<void> {
    if (shippingBusy || disposed || !isTauri() || !acpRecoveryReady) return;
    detectShippingClockResume();
    shippingBusy = true;
    try {
      const unrecoverable = await repairShipRunRepositories();
      const active = shipRuns.filter((run) => !shipRunArchived(run));
      await persistShipRefresh(
        active.map((run) => {
          const since = unrecoverable.get(run.id);
          if (since === undefined) return refreshShippingRun(run, refreshCompleted);
          return unrecoverableGraceExpired(since, Date.now())
            ? settleUnrecoverableShipRun(run)
            : Promise.resolve();
        }),
        saveShipRuns,
      );
      for (const run of active) if (!unrecoverable.has(run.id)) launchReadyShipIssues(run);
      await archiveDueShipRuns();
    } catch (cause) {
      error = describe(cause);
    } finally {
      shippingBusy = false;
    }
  }

  function saveSpawnReceipt(receipt: SpawnReceipt) {
    const protectedIds = new SvelteSet<string>();
    for (const run of shipRuns)
      for (const issue of run.issues)
        for (const gate of issue.gates ?? [])
          if (!shippingWorkerSettled(gate.state)) protectedIds.add(gate.id);
    for (const run of shipRuns) {
      for (const issue of run.issues) {
        if (issue.path) {
          if (issue.receiptId) protectedIds.add(issue.receiptId);
          const historicalThreadIds = (issue.contextHandoffs ?? []).flatMap((handoff) => [
            handoff.fromThreadId,
            handoff.toThreadId,
          ]);
          for (const threadId of [...(issue.checkpointThreadIds ?? []), ...historicalThreadIds]) {
            if (!threadId) continue;
            const handoff = spawnReceipts.find((item) => item.targetId === threadId);
            if (handoff) protectedIds.add(handoff.receiptId);
          }
        }
        for (const receiptId of shipTaskReceiptIdsToProtect(issue, spawnReceipts))
          protectedIds.add(receiptId);
      }
    }
    for (const pendingReceipt of spawnReceipts)
      if (pendingReceipt.dispatchPending) protectedIds.add(pendingReceipt.receiptId);
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
    if (shippingWorkerSettled(receipt.state) && receipt.targetId)
      for (const run of shipRuns)
        for (const issue of run.issues) {
          const contextHandoffs = reconcileHandoffOutcomes(
            issue.contextHandoffs,
            [receipt],
            issue.retryCount ?? 0,
            issue.lostStateFailures ?? 0,
          );
          if (contextHandoffs === issue.contextHandoffs) continue;
          issue.contextHandoffs = contextHandoffs;
          void saveShipRuns().catch((cause) => (error = describe(cause)));
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

  async function currentSpawnReceipt(receipt: SpawnReceipt): Promise<SpawnReceipt> {
    receipt = spawnReceipts.find((item) => item.receiptId === receipt.receiptId) ?? receipt;
    if (!receiptNeedsRefresh(receipt)) return receipt;
    if (handoffReceiptNeedsResolution(receipt)) return receipt;
    if (activeSpawnRequests.has(receipt.receiptId)) return receipt;
    if (!receipt.targetId || !receipt.targetDirectory || !receipt.turnId) {
      if (activeSpawnRequests.has(receipt.receiptId)) return receipt;
      updateSpawnReceipt(receipt.receiptId, { state: 'unavailable' });
      return spawnReceipts.find((item) => item.receiptId === receipt.receiptId) ?? receipt;
    }
    const receiptActivity = await acp.activity(receipt.targetDirectory).then(
      (states) => states[receipt.provider],
      () => null,
    );
    reconcileAcpSpawnReceipt(receipt, receiptActivity);
    return spawnReceipts.find((item) => item.receiptId === receipt.receiptId) ?? receipt;
  }

  async function recoverShippingAcpPrompt(
    receipt: SpawnReceipt,
    authorization: DirectShipAuthorization,
  ): Promise<void> {
    if (!receipt.targetId || !receipt.targetDirectory || !receipt.turnId || !receipt.prompt) return;
    const targetDirectory = receipt.targetDirectory;
    const agentActivity = await acp.activity(targetDirectory);
    const state = agentActivity[receipt.provider];
    if (acpPromptHasBackendEvidence(receipt, state ?? null)) return;
    const sessionId = receipt.targetId.slice(`acp:${receipt.provider}:`.length);
    if (await reconcileDurableAcpTurn(receipt, sessionId)) return;
    activeSpawnRequests.add(receipt.receiptId);
    try {
      const info = await acp.connect(receipt.provider, targetDirectory);
      const capabilities = info.agentCapabilities;
      const sessionCapabilities =
        capabilities && typeof capabilities === 'object' && 'sessionCapabilities' in capabilities
          ? capabilities.sessionCapabilities
          : null;
      const canResume =
        sessionCapabilities &&
        typeof sessionCapabilities === 'object' &&
        'resume' in sessionCapabilities;
      const capabilityProfile = capabilityProfileForAcpSession(
        receipt.provider,
        targetDirectory,
        sessionId,
        receipt.validation ? 'review' : undefined,
      );
      if (canResume)
        await acp.resume(receipt.provider, targetDirectory, sessionId, capabilityProfile);
      else await acp.load(receipt.provider, targetDirectory, sessionId, capabilityProfile);
      const restoredActivity = (await acp.activity(targetDirectory))[receipt.provider] ?? null;
      if (acpPromptHasBackendEvidence(receipt, restoredActivity)) {
        reconcileAcpSpawnReceipt(receipt, restoredActivity);
        return;
      }
      if (await reconcileDurableAcpTurn(receipt, sessionId, true)) return;
      requireSpawnPromptDispatch(receipt.receiptId);
      const recalledPrompt = await withAutomaticMemoryRecall({
        directory: targetDirectory,
        prompt: receipt.prompt,
        query: receipt.prompt,
        sessionKey: `acp:${receipt.provider}:${sessionId}`,
      });
      let queued = false;
      const turn = dispatchAuthorizedDirectShipPrompt(authorization, () =>
        acp.prompt(
          receipt.provider,
          targetDirectory,
          sessionId,
          recalledPrompt,
          receipt.turnId!,
          [],
          (limit) => {
            queued = limit !== null;
          },
          false,
        ),
      );
      activeSpawnTargets.set(spawnTargetKey(targetDirectory, receipt.targetId), receipt.receiptId);
      void turn.then(
        (outcome) => {
          const current = spawnReceipts.find((item) => item.receiptId === receipt.receiptId);
          updateSpawnReceipt(receipt.receiptId, {
            state: acpPromptInterrupted(outcome) ? 'interrupted' : 'completed',
            result: spawnOutput.get(receipt.receiptId) ?? current?.result ?? null,
          });
          spawnOutput.delete(receipt.receiptId);
          if (
            activeSpawnTargets.get(spawnTargetKey(targetDirectory, receipt.targetId!)) ===
            receipt.receiptId
          )
            activeSpawnTargets.delete(spawnTargetKey(targetDirectory, receipt.targetId!));
          return undefined;
        },
        async (cause) => {
          if (!(await reconcileDurableAcpTurn(receipt, sessionId)))
            updateSpawnReceipt(receipt.receiptId, {
              state: 'unavailable',
              error: `Prompt dispatch can be retried: ${describe(cause)}`,
            });
          spawnOutput.delete(receipt.receiptId);
          if (
            activeSpawnTargets.get(spawnTargetKey(targetDirectory, receipt.targetId!)) ===
            receipt.receiptId
          )
            activeSpawnTargets.delete(spawnTargetKey(targetDirectory, receipt.targetId!));
          return undefined;
        },
      );
      await awaitCoordinationStart(
        turn,
        async () => {
          const current = (await acp.activity(targetDirectory))[receipt.provider];
          return current?.activeTurns[sessionId] === receipt.turnId;
        },
        () => queued,
      );
      const current = spawnReceipts.find((item) => item.receiptId === receipt.receiptId);
      if (current?.state === 'starting')
        updateSpawnReceipt(receipt.receiptId, { state: 'working' });
    } finally {
      activeSpawnRequests.delete(receipt.receiptId);
    }
  }

  async function reconcileDurableAcpTurn(
    receipt: SpawnReceipt,
    sessionId: string,
    providerRestored = false,
  ): Promise<boolean> {
    if (!receipt.targetDirectory || !receipt.turnId) return false;
    const evidence = await acp.turnEvidence(
      receipt.provider,
      receipt.targetDirectory,
      sessionId,
      receipt.turnId,
    );
    if (acpTurnPromptCanRetry(evidence)) return false;
    if (acpTurnNeedsProviderInspection(evidence) && !providerRestored) return false;
    const state = acpTurnEvidenceState(evidence);
    if (!state) return false;
    updateSpawnReceipt(receipt.receiptId, {
      state,
      error: acpTurnNeedsProviderInspection(evidence)
        ? `Prompt dispatch may have completed before restart; inspect the restored provider session before cancelling and retrying.${evidence?.error ? ` ${evidence.error}` : ''}`
        : (evidence?.error ?? null),
    });
    return true;
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
      activeSpawnTargets.set(
        spawnTargetKey(receipt.targetDirectory ?? '', receipt.targetId!),
        receipt.receiptId,
      );
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
      if (
        receipt.targetId &&
        activeSpawnTargets.get(spawnTargetKey(receipt.targetDirectory ?? '', receipt.targetId)) ===
          receipt.receiptId
      )
        activeSpawnTargets.delete(spawnTargetKey(receipt.targetDirectory ?? '', receipt.targetId));
    }
  }

  async function recoverAcpSpawnResult(receipt: SpawnReceipt) {
    const targetDirectory = receipt.targetDirectory;
    if (
      !receipt.targetId ||
      typeof targetDirectory !== 'string' ||
      !receipt.prompt ||
      !receipt.turnId
    )
      return;
    const worktreeDirectory: string = targetDirectory;
    const sessionId = receipt.targetId.slice(`acp:${receipt.provider}:`.length);
    async function isLatestFinishedTurn() {
      const activity = await acp.activity(worktreeDirectory).catch(() => null);
      return receiptIsLatestFinishedTurn(receipt, activity?.[receipt.provider], sessionId);
    }
    const replay: AgentEntry[] = [];
    const unlisten = await listen<AgentEvent>('acp-event', ({ payload }) => {
      if (!acpEventMatchesSession(payload, receipt.provider, worktreeDirectory, sessionId)) return;
      const update = payload.message.params?.update;
      if (update && typeof update === 'object')
        updateEntriesInPlace(replay, update as Record<string, unknown>);
    });
    setAgentReplay(receipt.provider, worktreeDirectory, sessionId, true);
    try {
      await acp.connect(receipt.provider, worktreeDirectory);
      await acp.load(
        receipt.provider,
        worktreeDirectory,
        sessionId,
        capabilityProfileForAcpSession(
          receipt.provider,
          worktreeDirectory,
          sessionId,
          receipt.validation ? 'review' : undefined,
        ),
      );
      const latestFinished = await isLatestFinishedTurn();
      const result = replayResultForReceipt(replay, receipt.prompt, latestFinished);
      if (result) updateSpawnReceipt(receipt.receiptId, { result }, true);
    } catch {
      return;
    } finally {
      setAgentReplay(receipt.provider, worktreeDirectory, sessionId, false);
      unlisten();
    }
  }

  function coordinationProject(path: string): string | null {
    return owningRepository(projectCatalog, path);
  }

  async function coordinationSource(request: CoordinationRequest): Promise<CoordinationSource> {
    if (!request.sourceAgent) throw new Error('The source agent session is unavailable.');
    const matches = agentThreads.filter(
      (item) =>
        item.directory === request.directory &&
        item.sessionId === request.sessionId &&
        item.agent === request.sourceAgent,
    );
    if (matches.length > 1) throw new Error('The source agent session is ambiguous.');
    const thread = matches[0];
    if (!thread) throw new Error('The source agent session is unavailable.');
    const runtime = (await acp.activity(thread.directory))[thread.agent];
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
    if (!agentAvailability.some((agent) => agent.id === 'opencode' && agent.available))
      return threads;
    const known = new Set(threads.map((thread) => thread.id));
    const listed = await Promise.all(directories.map((path) => listOpenCodeRootThreads(path)));
    return [
      ...threads,
      ...listed
        .flat()
        .map((thread) => ({
          id: `acp:opencode:${thread.sessionId}`,
          directory: thread.directory,
          title: thread.title,
          agent: 'opencode',
        }))
        .filter((thread) => !known.has(thread.id)),
    ];
  }

  function shippingOwnerForCoordination(target: CoordinationThread) {
    const checkpointOwner = shipCheckpointOwner(shipRuns, target.directory, target.id);
    if (checkpointOwner) return checkpointOwner;
    for (const run of shipRuns) {
      const issue = run.issues.find((candidate) => {
        const receipt = spawnReceipts.find((item) => item.receiptId === candidate.receiptId);
        return (
          candidate.path === target.directory &&
          (candidate.threadId === target.id || receipt?.targetId === target.id)
        );
      });
      if (issue) return { run, issue };
    }
    return undefined;
  }

  function finishCoordinationDelivery(message: CoordinationMessage): void {
    coordinationMessages = coordinationMessages.map((item) =>
      item.id === message.id ? { ...item, delivered: true } : item,
    );
    setSetting('sai-coordination-messages', JSON.stringify(coordinationMessages));
  }

  function queueCoordinationDelivery(target: CoordinationThread, message: CoordinationMessage) {
    const previous = coordinationDeliveries.get(message.target) ?? Promise.resolve();
    const delivery = previous
      .catch(() => undefined)
      .then(async () => {
        if (disposed || coordinationMessages.find((item) => item.id === message.id)?.delivered)
          return;
        const text = coordinationPrompt(message);
        const thread = [...agentThreads, ...sidebarOpenCodeThreads].find(
          (item) =>
            item.directory === target.directory &&
            target.id === `acp:${item.agent}:${item.sessionId}`,
        );
        if (!thread) throw new Error('The receiving thread is unavailable.');
        const info = await acp.connect(thread.agent, thread.directory);
        const agentActivity = (await acp.activity(thread.directory))[thread.agent];
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
          const capabilityProfile = thread.capabilityProfile ?? 'build';
          if (canResume)
            await acp.resume(thread.agent, thread.directory, thread.sessionId, capabilityProfile);
          else await acp.load(thread.agent, thread.directory, thread.sessionId, capabilityProfile);
        }
        await waitForCoordinationThread(thread);
        if (disposed) return;
        await invoke('record_turn_snapshot', {
          path: thread.directory,
          thread: target.id,
        });
        const tracking = await beginImplementationTurn(thread.directory, thread.model, target.id);
        updateAgentThreadStatus(thread, 'working');
        const turnId = crypto.randomUUID();
        const recalledText = await withAutomaticMemoryRecall({
          directory: thread.directory,
          prompt: text,
          query: text,
          sessionKey: `acp:${thread.agent}:${thread.sessionId}`,
        });
        const owner = shippingOwnerForCoordination(target);
        let shippingReceipt: SpawnReceipt | undefined;
        if (owner) {
          const receipt = spawnReceipts.find(
            (item) => item.targetId === target.id && item.targetDirectory === target.directory,
          );
          if (!receipt) {
            abandonImplementationTurn(thread.directory, tracking);
            finishCoordinationDelivery(message);
            return;
          }
          shippingReceipt = receipt;
        }
        let turn: ReturnType<typeof acp.prompt>;
        let queued = false;
        try {
          if (owner && shippingReceipt) {
            const originalReceipt = { ...shippingReceipt };
            const started = await beginAuthorizedCoordinationPrompt(
              () => shippingPromptAuthorization(owner.run, owner.issue),
              async () => {
                saveSpawnReceipt({
                  ...originalReceipt,
                  prompt: text,
                  state: 'working',
                  turnId,
                  result: null,
                  error: null,
                  updated: Date.now(),
                });
                activeSpawnTargets.set(
                  spawnTargetKey(target.directory, target.id),
                  shippingReceipt!.receiptId,
                );
                await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
              },
              async () => {
                if (
                  activeSpawnTargets.get(spawnTargetKey(target.directory, target.id)) ===
                  shippingReceipt!.receiptId
                )
                  activeSpawnTargets.delete(spawnTargetKey(target.directory, target.id));
                saveSpawnReceipt(originalReceipt);
                await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
              },
              () =>
                acp.prompt(
                  thread.agent,
                  thread.directory,
                  thread.sessionId,
                  recalledText,
                  turnId,
                  [],
                  (limit) => {
                    queued = limit !== null;
                  },
                  false,
                ),
            );
            turn = started.turn;
          } else
            turn = acp.prompt(
              thread.agent,
              thread.directory,
              thread.sessionId,
              recalledText,
              turnId,
              [],
              (limit) => {
                queued = limit !== null;
              },
              false,
            );
        } catch {
          abandonImplementationTurn(thread.directory, tracking);
          return;
        }
        void turn
          .then(
            async (outcome) => {
              await recordImplementationModel(thread.directory, thread.model, tracking);
              const currentShippingReceipt = shippingReceipt
                ? spawnReceipts.find((item) => item.receiptId === shippingReceipt.receiptId)
                : undefined;
              if (shippingReceipt && !receiptMatchesTurn(currentShippingReceipt, turnId))
                return undefined;
              updateAgentThreadStatus(
                thread,
                acpPromptInterrupted(outcome) ? 'interrupted' : 'done',
              );
              if (shippingReceipt) {
                updateSpawnReceipt(shippingReceipt.receiptId, {
                  state: acpPromptInterrupted(outcome) ? 'interrupted' : 'completed',
                  result:
                    spawnOutput.get(shippingReceipt.receiptId) ?? shippingReceipt.result ?? null,
                });
                spawnOutput.delete(shippingReceipt.receiptId);
                if (
                  activeSpawnTargets.get(spawnTargetKey(target.directory, target.id)) ===
                  shippingReceipt.receiptId
                )
                  activeSpawnTargets.delete(spawnTargetKey(target.directory, target.id));
              }
              return undefined;
            },
            async (cause) => {
              await recordImplementationModel(thread.directory, thread.model, tracking);
              const currentShippingReceipt = shippingReceipt
                ? spawnReceipts.find((item) => item.receiptId === shippingReceipt.receiptId)
                : undefined;
              if (shippingReceipt && !receiptMatchesTurn(currentShippingReceipt, turnId))
                return undefined;
              const interrupted = await acpFailedPromptInterrupted(
                thread.agent,
                thread.directory,
                thread.sessionId,
                turnId,
              );
              updateAgentThreadStatus(thread, interrupted ? 'interrupted' : 'failed');
              if (shippingReceipt) {
                updateSpawnReceipt(shippingReceipt.receiptId, {
                  state: interrupted ? 'interrupted' : 'failed',
                  error: interrupted ? null : describe(cause),
                });
                spawnOutput.delete(shippingReceipt.receiptId);
                if (
                  activeSpawnTargets.get(spawnTargetKey(target.directory, target.id)) ===
                  shippingReceipt.receiptId
                )
                  activeSpawnTargets.delete(spawnTargetKey(target.directory, target.id));
              }
              if (!interrupted) error = `Agent message turn failed: ${describe(cause)}`;
              return undefined;
            },
          )
          .catch((cause) => {
            abandonImplementationTurn(thread.directory, tracking);
            error = `Could not track agent message turn: ${describe(cause)}`;
          });
        await awaitCoordinationStart(
          turn,
          async () => {
            const state = (await acp.activity(thread.directory))[thread.agent];
            return !!state?.active.includes(thread.sessionId);
          },
          () => queued,
        );
        finishCoordinationDelivery(message);
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
    const agentActivity = (await acp.activity(thread.directory))[thread.agent];
    if (!agentActivity?.active.includes(thread.sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return waitForCoordinationThread(thread);
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
    const sourceId = `acp:${source.agent}:${request.sessionId}`;
    const effectiveProfile = effectiveCapabilityProfileForAcpSession(
      source.agent,
      request.directory,
      request.sessionId,
    );
    const requestedTool =
      request.name === 'capability_check' && typeof request.arguments.tool === 'string'
        ? request.arguments.tool
        : request.name;
    if (!capabilityProfileEnablesTool(effectiveProfile, requestedTool))
      throw new Error(
        `${requestedTool} is unavailable under the ${effectiveProfile} capability profile.`,
      );
    if (request.name === 'capability_check') return { profile: effectiveProfile };
    if (isPlanTool(request.name)) {
      return acpPlans().runTool(
        { agent: source.agent, directory: request.directory, sessionId: request.sessionId },
        request.name,
        request.arguments,
      );
    }
    if (
      request.name === 'terminal_create' ||
      request.name === 'terminal_write' ||
      request.name === 'terminal_stop'
    ) {
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
    if (request.name === 'thread_keywords') {
      const keywords = normalizeAgentThreadKeywords(request.arguments.keywords);
      const thread = agentThreads.find(
        (item) =>
          item.agent === source.agent &&
          item.directory === request.directory &&
          item.sessionId === request.sessionId,
      );
      if (!thread) throw new Error('The source agent session is unavailable.');
      saveAgentThread({ ...thread, keywords });
      return { keywords };
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
      let current = await awaitReceipt(await boundedReceipt(receipt));
      if (request.name === 'agent_result' && current.state === 'completed' && !current.result) {
        await recoverAcpSpawnResult(current);
        current = spawnReceipts.find((item) => item.receiptId === current.receiptId) ?? current;
      }
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
    if (request.name === 'task_evidence_record') {
      const owner = shipCheckpointOwner(shipRuns, request.directory, sourceId);
      if (!owner?.issue.checkpoint)
        throw new Error('This thread cannot record evidence for a Ship task.');
      const shippingTarget = await shippingTargetFor(owner.run, owner.issue, request.directory);
      const execution = await readStableEvidenceBoundary(
        () => invoke<string>('working_tree_revision', { path: request.directory }),
        () => invoke<string>('working_tree_generation', { path: request.directory }),
        () =>
          invoke<string>('shipping_base_revision', {
            path: request.directory,
            baseRef: shippingTarget.baseRef,
          }),
      );
      await markValidationRevisionDrift(request.directory, execution.revision);
      requireEvidenceExecutionBoundary(
        {
          revision: request.arguments.expectedRevision,
          mutationGeneration: request.arguments.expectedMutationGeneration,
          baseRevision: request.arguments.expectedBaseRevision,
        },
        execution,
      );
      if (owner.issue.checkpoint.revision !== execution.revision)
        throw new Error(
          'Bind the task checkpoint to the current revision before recording evidence.',
        );
      const receipt = spawnReceipts.find(
        (item) => item.targetId === sourceId && item.targetDirectory === request.directory,
      );
      const evidence = taskEvidenceSchema.parse({
        id: crypto.randomUUID(),
        kind: 'command',
        name: request.arguments.command,
        provider: receipt?.provider ?? owner.run.provider,
        model: receipt?.model ?? resolvedWorkerModel(owner.issue) ?? null,
        result: request.arguments.result as EvidenceResult,
        timestamp: Date.now(),
        outputReference: request.arguments.outputReference,
        criteria: request.arguments.criteria,
        economics:
          request.arguments.economics === undefined
            ? undefined
            : taskEconomicsSchema.parse(request.arguments.economics),
      });
      const readBoundary = () =>
        readStableEvidenceBoundary(
          () => invoke<string>('working_tree_revision', { path: request.directory }),
          () => invoke<string>('working_tree_generation', { path: request.directory }),
          () =>
            invoke<string>('shipping_base_revision', {
              path: request.directory,
              baseRef: shippingTarget.baseRef,
            }),
        );
      await commitRevisionBoundEvidence({
        expected: execution,
        readBoundary,
        commit: async (registerRollback) => {
          const checkpoint = owner.issue.checkpoint;
          if (!checkpoint || checkpoint.revision !== execution.revision)
            throw new Error(
              'Bind the task checkpoint to the current revision before recording evidence.',
            );
          const previous = $state.snapshot({
            evidenceRevision: owner.issue.evidenceRevision,
            evidenceManifests: owner.issue.evidenceManifests,
          });
          let committed = previous;
          registerRollback(async () => {
            Object.assign(
              owner.issue,
              rollbackTaskEvidenceRecord(owner.issue, previous, committed, evidence.id),
            );
            await saveShipRuns();
          });
          const evidenceManifests = recordTaskEvidence(
            owner.issue.evidenceManifests ?? [],
            execution.revision,
            checkpoint.acceptanceCriteria,
            evidence,
            execution.baseRevision,
          );
          await updateShipIssue(
            owner.run,
            owner.issue,
            { evidenceRevision: execution.revision, evidenceManifests },
            false,
          );
          committed = $state.snapshot({
            evidenceRevision: owner.issue.evidenceRevision,
            evidenceManifests: owner.issue.evidenceManifests,
          });
          await saveShipRuns();
        },
      });
      return {
        status: 'recorded',
        evidence,
        readiness: evidenceReadiness(
          owner.issue.evidenceManifests ?? [],
          execution.revision,
          owner.issue.checkpoint.requiredGates,
          owner.issue.checkpoint.acceptanceCriteria,
          execution.baseRevision,
        ),
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
      const shippingTarget = await shippingTargetFor(owner.run, owner.issue, request.directory);
      const execution = await readStableEvidenceBoundary(
        () => invoke<string>('working_tree_revision', { path: request.directory }),
        () => invoke<string>('working_tree_generation', { path: request.directory }),
        () =>
          invoke<string>('shipping_base_revision', {
            path: request.directory,
            baseRef: shippingTarget.baseRef,
          }),
      );
      await markValidationRevisionDrift(request.directory, execution.revision);
      if (request.name === 'task_checkpoint_update') {
        const patch = request.arguments.checkpoint;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch))
          throw new Error('Checkpoint update requires a checkpoint object.');
        const liveCheckpoint = owner.issue.checkpoint ?? checkpoint;
        const updated = prepareTaskCheckpointUpdate(
          liveCheckpoint,
          patch,
          execution.revision,
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
      const evidenceManifests = syncEvidenceManifest(
        owner.issue.evidenceManifests ?? [],
        execution.revision,
        saved.acceptanceCriteria,
        Date.now(),
        execution.baseRevision,
      );
      if (
        owner.issue.evidenceRevision !== execution.revision ||
        JSON.stringify(owner.issue.evidenceManifests ?? []) !== JSON.stringify(evidenceManifests)
      )
        await updateShipIssue(owner.run, owner.issue, {
          evidenceRevision: execution.revision,
          evidenceManifests,
        });
      const reconciliation = reconcileTaskCheckpoint(saved, execution.revision, {
        issueState: owner.issue.issueState,
        pullRequest: owner.issue.pullRequest,
        deliveryState: owner.issue.state,
        refreshError: owner.issue.refreshError,
      });
      const storedReconciliation = {
        revisionMatches: reconciliation.revisionMatches,
        resumable: reconciliation.resumable,
        deliveryState: reconciliation.deliveryState,
        issueState: reconciliation.issueState,
        reason: reconciliation.reason,
      };
      if (
        JSON.stringify(owner.issue.checkpointReconciliation) !==
        JSON.stringify(storedReconciliation)
      )
        await updateShipIssue(owner.run, owner.issue, {
          checkpointReconciliation: storedReconciliation,
        });
      const incomingHandoff = owner.issue.contextHandoffs?.findLast(
        (handoff) => handoff.toThreadId === sourceId && handoff.outcome === 'pending',
      );
      if (!reconciliation.revisionMatches && saved.revision && incomingHandoff) {
        const eventId = `lost-state:${saved.sequence}:${saved.revision}:${execution.revision}`;
        if (!owner.issue.contextEventIds?.includes(eventId))
          await updateShipIssue(owner.run, owner.issue, {
            contextEventIds: [...(owner.issue.contextEventIds ?? []), eventId].slice(-200),
            lostStateFailures: (owner.issue.lostStateFailures ?? 0) + 1,
          });
      }
      return {
        checkpoint: saved,
        reconciliation,
        evidence: {
          manifests: evidenceManifests,
          readiness: evidenceReadiness(
            evidenceManifests,
            execution.revision,
            saved.requiredGates,
            saved.acceptanceCriteria,
            execution.baseRevision,
          ),
        },
        execution,
      };
    }
    if (request.name === 'ship_progress') return reportShipProgress(request, sourceId);
    if (request.name === 'validation_policy') {
      const owner = shipOwner(shipRuns, request.directory, sourceId);
      if (!owner) throw new Error('Only the assigned Ship worker can select validation risk.');
      const explicitRisk = request.arguments.risk;
      if (!shipRiskLevels.includes(explicitRisk as ShipRisk))
        throw new Error('Choose validation risk low, medium, or high.');
      const shippingTarget = await shippingTargetFor(owner.run, owner.issue, request.directory);
      const { revision, mutationGeneration, baseRevision, changedPaths, config } =
        await readStableShipValidationInputs(
          () => invoke<string>('working_tree_revision', { path: request.directory }),
          () => invoke<string>('working_tree_generation', { path: request.directory }),
          (selectedBaseRevision) =>
            invoke<string[]>('shipping_changed_paths', {
              path: request.directory,
              baseRevision: selectedBaseRevision,
            }),
          () => invoke<WorktreeConfig | null>('worktree_config', { worktree: request.directory }),
          3,
          () =>
            invoke<string>('shipping_base_revision', {
              path: request.directory,
              baseRef: shippingTarget.baseRef,
            }),
        );
      const policy = selectShipValidationPolicy(
        config?.validation,
        changedPaths,
        explicitRisk as ShipRisk,
        revision,
        owner.issue.validationPolicy,
        Date.now(),
        baseRevision,
        mutationGeneration,
      );
      const checkpointBeforePolicy =
        owner.issue.checkpoint ??
        initialTaskCheckpoint(
          { id: owner.issue.id, url: owner.issue.url, title: owner.issue.title },
          Date.now(),
        );
      const checkpoint = prepareTaskCheckpointUpdate(
        checkpointBeforePolicy,
        { requiredGates: policy.requiredGates },
        revision,
        checkpointBeforePolicy.sequence,
        checkpointBeforePolicy.revision,
        true,
        Date.now(),
      );
      const evidenceManifests = syncEvidenceManifest(
        owner.issue.evidenceManifests ?? [],
        revision,
        checkpoint.acceptanceCriteria,
        Date.now(),
        baseRevision,
      );
      await updateShipIssue(owner.run, owner.issue, {
        validationPolicyRequired: true,
        validationPolicy: policy,
        blockedReason: null,
        checkpoint,
        evidenceRevision: revision,
        evidenceManifests,
        events: appendShipEvent(
          owner.issue.events,
          `validation policy: ${policy.risk}`,
          policy.sources.join(' · '),
        ),
      });
      return {
        risk: policy.risk,
        requiredGates: policy.requiredGates,
        sources: policy.sources,
        revision: policy.revision,
        mutationGeneration: policy.mutationGeneration,
        baseRevision: policy.baseRevision,
        changedPaths: policy.changedPaths,
      };
    }
    if (request.name === 'validation_gate') {
      const owner = shipOwner(shipRuns, request.directory, sourceId);
      try {
        if (owner) {
          const shippingTarget = await shippingTargetFor(owner.run, owner.issue, request.directory);
          const [revision, baseRevision] = await Promise.all([
            invoke<string>('working_tree_revision', { path: request.directory }),
            invoke<string>('shipping_base_revision', {
              path: request.directory,
              baseRef: shippingTarget.baseRef,
            }),
          ]);
          assertShipGateAllowed(
            owner.issue.validationPolicy,
            request.arguments.gate as GateName,
            revision,
            baseRevision,
          );
          await updateShipIssue(owner.run, owner.issue, {
            stage: request.arguments.gate === 'test-adversary' ? 'testing' : 'reviewing',
            events: appendShipEvent(owner.issue.events, String(request.arguments.gate)),
          });
        }
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

  async function recordGateEvidence(
    owner: { run: ShipRun; issue: ShipIssue },
    gate: import('./lib/ship-progress').GateName,
    verdict: import('./lib/ship-progress').GateVerdict,
    provider: string,
    model: string | null,
    criteria: string[] | undefined,
    untestedCriteria: import('./lib/task-evidence').UntestedCriterion[] | undefined,
    outputReference: string | undefined,
    fallbackReference: string,
    expectedRevision: unknown,
    baseRevision: string,
    evidenceIdentity?: { id: string; timestamp: number; sequence?: number },
    economics?: TaskEconomics,
  ): Promise<
    Pick<ShipIssue, 'evidenceRevision' | 'evidenceManifests'> & { evidenceSequence: number }
  > {
    if (!owner.issue.path || !owner.issue.checkpoint)
      throw new Error('Gate evidence needs a canonical task checkpoint and worktree.');
    const revision = await invoke<string>('working_tree_revision', { path: owner.issue.path });
    requireEvidenceRevision(expectedRevision, revision);
    if (owner.issue.checkpoint.revision !== revision)
      throw new Error('Bind the task checkpoint to the current revision before reporting a gate.');
    const reportedCriteria = [
      ...(criteria ?? []),
      ...(untestedCriteria ?? []).map(({ criterion }) => criterion),
    ];
    const unknownCriterion = reportedCriteria.find(
      (criterion) => !owner.issue.checkpoint!.acceptanceCriteria.includes(criterion),
    );
    if (unknownCriterion)
      throw new Error(`Gate evidence named an unknown acceptance criterion: ${unknownCriterion}`);
    const evidenceId = evidenceIdentity?.id ?? crypto.randomUUID();
    const evidenceSequence =
      evidenceIdentity?.sequence ?? nextTaskEvidenceSequence(owner.issue.evidenceManifests ?? []);
    const evidenceManifests = recordTaskEvidence(
      owner.issue.evidenceManifests ?? [],
      revision,
      owner.issue.checkpoint.acceptanceCriteria,
      {
        id: evidenceId,
        kind: 'gate',
        name: gate,
        provider,
        model,
        result: gateVerdictPassed(gate, verdict) ? 'passed' : 'failed',
        timestamp: evidenceIdentity?.timestamp ?? Date.now(),
        sequence: evidenceSequence,
        outputReference: outputReference ?? fallbackReference,
        criteria: [...new Set(reportedCriteria)],
        ...(untestedCriteria?.length ? { untestedCriteria } : {}),
        economics,
      },
      baseRevision,
    );
    return {
      evidenceRevision: revision,
      evidenceManifests,
      evidenceSequence,
    };
  }

  function validationIssueSnapshot(issue: ShipIssue) {
    return $state.snapshot({
      evidenceRevision: issue.evidenceRevision,
      evidenceManifests: issue.evidenceManifests,
      stage: issue.stage,
      blockedReason: issue.blockedReason,
      gates: issue.gates,
      events: issue.events,
    });
  }

  async function markValidationRevisionDrift(
    targetDirectory: string,
    currentRevision: string,
  ): Promise<void> {
    let changed = false;
    for (const receipt of spawnReceipts) {
      if (
        receipt.targetDirectory !== targetDirectory ||
        !receipt.validation ||
        shippingWorkerSettled(receipt.state) ||
        !validationRevisionDrifted(receipt.validation, currentRevision) ||
        receipt.validation.revisionDrifted
      )
        continue;
      updateSpawnReceipt(receipt.receiptId, {
        validation: { ...receipt.validation, revisionDrifted: true },
      });
      changed = true;
    }
    if (changed) await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
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
      if (!receipt?.validation)
        throw new Error(
          'Ship It gate verdicts must come from a fresh validation subagent session.',
        );
      const validation = receipt.validation;
      if (shippingWorkerSettled(receipt.state))
        throw new Error('This validation attempt has already finished.');
      requireValidatorEconomics(report, validation.protocolVersion !== 2);
      if (validation.revisionDrifted)
        throw new Error('The worktree changed during validation. Rerun the gate.');
      const owner = shipOwner(shipRuns, receipt.sourceDirectory, receipt.sourceId);
      const shippingTarget = owner
        ? await shippingTargetFor(owner.run, owner.issue, receipt.sourceDirectory)
        : undefined;
      if (owner) {
        const [revision, baseRevision] = await Promise.all([
          invoke<string>('working_tree_revision', { path: receipt.sourceDirectory }),
          invoke<string>('shipping_base_revision', {
            path: receipt.sourceDirectory,
            baseRef: shippingTarget!.baseRef,
          }),
        ]);
        assertShipGateAllowed(
          owner.issue.validationPolicy,
          validation.gate,
          revision,
          baseRevision,
        );
      }
      validateGateVerdict(validation.gate, report.verdict);
      const evidenceTimestamp = Date.now();
      const evidenceCriteria = report.criteria ?? [];
      const evidenceUntestedCriteria = report.untestedCriteria ?? [];
      const evidenceOutputReference =
        report.outputReference ?? `thread:${receipt.targetId ?? receipt.receiptId}`;
      await commitRevisionBoundValidation({
        expectedRevision: validation.revision,
        expectedMutationGeneration: validation.mutationGeneration,
        expectedBaseRevision: validation.baseRevision,
        readRevision: () => invoke<string>('working_tree_revision', { path: request.directory }),
        readMutationGeneration: () =>
          invoke<string>('working_tree_generation', { path: request.directory }),
        readBaseRevision: shippingTarget
          ? () =>
              invoke<string>('shipping_base_revision', {
                path: request.directory,
                baseRef: shippingTarget.baseRef,
              })
          : undefined,
        prepare: async () => {
          const evidenceChanges = owner
            ? await recordGateEvidence(
                owner,
                validation.gate,
                report.verdict,
                receipt.provider,
                receipt.model ?? null,
                report.criteria,
                report.untestedCriteria,
                report.outputReference,
                `thread:${receipt.targetId ?? receipt.receiptId}`,
                validation.revision,
                validation.baseRevision!,
                {
                  id: `gate:${receipt.receiptId}`,
                  timestamp: evidenceTimestamp,
                  sequence: validation.evidenceSequence,
                },
                report.economics,
              )
            : null;
          if (owner && evidenceChanges)
            requireEvidenceBaseRevision(validation.revision!, owner.issue.evidenceRevision);
          return evidenceChanges;
        },
        commit: async (evidenceChanges, registerRollback) => {
          const previousReceipt = $state.snapshot(receipt);
          const previousIssue = owner ? validationIssueSnapshot(owner.issue) : null;
          let committedReceipt = previousReceipt;
          let committedIssue = previousIssue;
          registerRollback(async () => {
            const failures: unknown[] = [];
            try {
              const currentReceipt = spawnReceipts.find(
                (candidate) => candidate.receiptId === receipt.receiptId,
              );
              if (currentReceipt) {
                saveSpawnReceipt(
                  rollbackValidationReceipt(currentReceipt, previousReceipt, committedReceipt),
                );
                await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
              }
            } catch (cause) {
              failures.push(cause);
            }
            try {
              if (owner && previousIssue && committedIssue) {
                Object.assign(
                  owner.issue,
                  rollbackValidationIssue(
                    owner.issue,
                    previousIssue,
                    committedIssue,
                    `gate:${receipt.receiptId}`,
                  ),
                );
                await saveShipRuns();
              }
            } catch (cause) {
              failures.push(cause);
            }
            if (failures.length) throw new AggregateError(failures, 'Validation rollback failed.');
          });
          const evidenceSequence = evidenceChanges?.evidenceSequence;
          updateSpawnReceipt(receipt.receiptId, {
            validation: {
              ...validation,
              verdict: report.verdict,
              reason: report.reason,
              evidenceCriteria,
              evidenceUntestedCriteria,
              evidenceOutputReference,
              evidenceTimestamp,
              evidenceSequence,
              evidenceEconomics: report.economics,
            },
          });
          committedReceipt = $state.snapshot(
            spawnReceipts.find((candidate) => candidate.receiptId === receipt.receiptId)!,
          );
          await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
          if (owner && evidenceChanges) {
            const issueEvidenceChanges = {
              evidenceRevision: evidenceChanges.evidenceRevision,
              evidenceManifests: evidenceChanges.evidenceManifests,
            };
            await updateShipIssue(
              owner.run,
              owner.issue,
              {
                ...issueEvidenceChanges,
                blockedReason: report.verdict === 'BLOCKED' ? report.reason : null,
                events: appendShipEvent(
                  owner.issue.events,
                  `${validation.gate}: ${report.verdict}`,
                  report.reason,
                ),
              },
              false,
            );
            committedIssue = validationIssueSnapshot(owner.issue);
            await saveShipRuns();
          }
        },
      });
    } else {
      const owner = shipOwner(shipRuns, request.directory, sourceId);
      if (!owner) throw new Error('Only the assigned Ship worker can report issue progress.');
      await updateShipIssue(owner.run, owner.issue, {
        stage: report.stage,
        reportedStatus: report.status,
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
    const { gate, prompt } = request.arguments;
    if (
      !['inline-review', 'code-adversary', 'findings-adversary', 'test-adversary'].includes(
        String(gate),
      )
    )
      throw new Error('Choose a Ship It validation gate.');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000)
      throw new Error('Gate prompt must be 1–8000 characters.');
    const gatePrompt = `${prompt.trim()}\n\nBefore finishing, call ship_progress with your structured verdict, the exact acceptance criterion strings this pass verified, a bounded output reference, and privacy-safe economics counters for your validator activity. For review passes use CLEAN, NEEDS_FIXES, or BLOCKED; for manual testing use PASS, PASS (partial), FAIL, or BLOCKED. A PASS (partial) must also provide untestedCriteria as exact criterion and environmental blocker pairs, disjoint from criteria. Report only your own pass. A failed or blocked verdict requires a concrete reason.`;
    await recoverImplementationModels(request.directory);
    const activeModels = await activeImplementationModels(request.directory, sourceId);
    if (!activeModels)
      throw new Error('Implementation activity is still unresolved. Wait for the turn to finish.');
    const gateOwner = shipOwner(shipRuns, request.directory, sourceId);
    const routeRisk = gateOwner?.issue.validationPolicy?.risk ?? 'medium';
    const routeRole = gate === 'test-adversary' ? 'testing' : 'review';
    const configuredGateRoute = modelRouting.routes.find(
      (candidate) => candidate.role === routeRole && candidate.risk === routeRisk,
    );
    const routeSelection = configuredGateRoute
      ? selectModelRoute(modelRouting, { role: routeRole, risk: routeRisk })
      : null;
    if (routeSelection && !routeSelection.route)
      throw new Error(routeSelection.reason ?? `No eligible ${routeRole} route.`);
    const validationSettings = routeSelection?.route
      ? { choices: [{ agent: routeSelection.route.provider, model: routeSelection.route.model }] }
      : crossValidation;
    const sourceThread = agentThreads.find(
      (thread) =>
        thread.directory === request.directory &&
        thread.sessionId === request.sessionId &&
        thread.agent === request.sourceAgent,
    );
    const defaultAgent = gateOwner?.run.provider ?? request.sourceAgent;
    if (!defaultAgent || !['claude', 'codex', 'opencode'].includes(defaultAgent))
      throw new Error('The assigned Ship worker provider is unavailable.');
    const implementationModel =
      (gateOwner ? resolvedWorkerModel(gateOwner.issue) : undefined) ?? sourceThread?.model;
    const defaultGateRoute: ValidationRoute = {
      agent: defaultAgent,
      ...(implementationModel && !hasUnresolvedModelAlias(implementationModel)
        ? { model: implementationModel }
        : {}),
    };
    const gateRoutes: ValidationRoute[] = validationSettings.choices.length
      ? validationSettings.choices
      : [defaultGateRoute];
    const registered = await invoke<RegisteredWorktree[]>('registered_worktrees', {
      repository: project,
      paths: [request.directory],
    });
    const worktree = registered.find((item) => item.path === request.directory);
    if (!worktree) throw new Error('Source worktree is no longer registered with Git.');
    const branch = worktree.branch ?? '';
    const agents = await acp.agents();
    const available = gateRoutes.filter((choice) =>
      agents.some((agent) => agent.id === choice.agent && agent.available),
    );
    async function tryChoice(candidates: ValidationRoute[], reasons: string[]): Promise<unknown> {
      const currentCandidates = candidates.filter((candidate) =>
        gateRoutes.some(
          (selected) => selected.agent === candidate.agent && selected.model === candidate.model,
        ),
      );
      if (!currentCandidates.length) {
        const unavailable = selectValidationChoice({ choices: gateRoutes }, []);
        throw new Error([unavailable.reason, ...reasons].filter(Boolean).join(' '));
      }
      const route = selectValidationChoice({ choices: gateRoutes }, currentCandidates);
      if (!route.choice) throw new Error(route.reason ?? 'No eligible validation model.');
      const choice: ValidationRoute = route.choice;
      const gateSource: CoordinationSource = {
        kind: 'acp',
        agent: choice.agent,
        ...(choice.model ? { model: acpModelId(choice.agent, choice.model) } : {}),
        variant: routeSelection?.route?.variant,
        title: String(gate),
      };
      const receiptId = crypto.randomUUID();
      const accessKey = crypto.randomUUID();
      const shippingTarget = gateOwner
        ? await shippingTargetFor(gateOwner.run, gateOwner.issue, request.directory)
        : undefined;
      const priorGates = [
        ...new Map(
          [
            ...(gateOwner?.issue.gates ?? []),
            ...spawnReceipts.flatMap((receipt) => {
              if (receipt.sourceId !== sourceId || receipt.sourceDirectory !== request.directory)
                return [];
              const recordedGate = gateSnapshot(receipt);
              return recordedGate ? [recordedGate] : [];
            }),
          ].map((candidate) => [candidate.id, candidate]),
        ).values(),
      ];
      const { sequence, evidenceSequence } = nextValidationReservation(
        priorGates,
        gateOwner?.issue.evidenceManifests ?? [],
      );
      const ensureSelected = async () => {
        const selectedCandidates = currentCandidates.filter((candidate) =>
          gateRoutes.some(
            (selected) => selected.agent === candidate.agent && selected.model === candidate.model,
          ),
        );
        const active = await activeImplementationModels(request.directory, sourceId);
        if (!active)
          throw new Error(
            'Implementation activity is still unresolved. Wait for the turn to finish.',
          );
        const current = selectValidationChoice({ choices: gateRoutes }, selectedCandidates).choice;
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
          requestedModel: choice.model ?? 'implementation model',
          sequence,
          evidenceSequence,
          protocolVersion: 2,
        },
        routing: {
          role: routeRole,
          risk: routeRisk,
          contextIsolationRequired: true,
          requested: {
            provider: choice.agent as SpawnReceipt['provider'],
            model: choice.model ?? null,
            variant: routeSelection?.route?.variant ?? null,
          },
          actual: null,
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
        try {
          await acp.connect(choice.agent, request.directory);
        } catch (cause) {
          throw new ValidationCandidateUnavailable(
            `Provider ${choice.agent} is unavailable`,
            cause,
          );
        }
        await ensureSelected();
        const [revision, mutationGeneration, baseRevision] = await Promise.all([
          invoke<string>('working_tree_revision', { path: request.directory }),
          invoke<string>('working_tree_generation', { path: request.directory }),
          shippingTarget
            ? invoke<string>('shipping_base_revision', {
                path: request.directory,
                baseRef: shippingTarget.baseRef,
              })
            : Promise.resolve(undefined),
        ]);
        updateSpawnReceipt(receiptId, {
          validation: {
            gate: gate as import('./lib/ship-progress').GateName,
            requestedModel: choice.model ?? 'implementation model',
            sequence,
            evidenceSequence,
            revision,
            mutationGeneration,
            baseRevision,
            protocolVersion: 2,
          },
        });
        await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
        const ensureLaunchState = async () => {
          await ensureSelected();
          const currentRevision = await invoke<string>('working_tree_revision', {
            path: request.directory,
          });
          requireEvidenceRevision(revision, currentRevision);
          const currentGeneration = await invoke<string>('working_tree_generation', {
            path: request.directory,
          });
          if (currentGeneration !== mutationGeneration)
            throw new Error('The worktree was modified before validation started. Retry the gate.');
          if (
            shippingTarget &&
            (await invoke<string>('shipping_base_revision', {
              path: request.directory,
              baseRef: shippingTarget.baseRef,
            })) !== baseRevision
          )
            throw new Error('The shipping base changed before validation started. Retry the gate.');
        };
        const started = await startCoordinatedThread(
          { path: request.directory, branch },
          gateSource,
          gatePrompt,
          receiptId,
          true,
          ensureLaunchState,
        );
        return {
          ...started,
          receiptId,
          accessKey,
          sourceId,
          targetId: started.threadId,
          provider: choice.agent,
          model: choice.model ?? null,
          gate,
          status: 'started',
        };
      } catch (cause) {
        updateSpawnReceipt(receiptId, { state: 'failed', error: describe(cause) });
        if (!(cause instanceof ValidationCandidateUnavailable)) throw cause;
        return tryChoice(
          candidates.filter((item) => item !== choice),
          [
            ...reasons,
            `${choice.agent} / ${choice.model ?? 'implementation default'}: ${describe(cause)}`,
          ],
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
    const role = request.arguments.role;
    const risk = request.arguments.risk;
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
    const routed = role !== undefined || risk !== undefined;
    if (
      routed &&
      (typeof role !== 'string' ||
        !['exploration', 'implementation', 'debugging', 'review', 'testing', 'ci-triage'].includes(
          role,
        ) ||
        typeof risk !== 'string' ||
        !shipRiskLevels.includes(risk as ShipRisk))
    )
      throw new Error('Choose both a routing role and low, medium, or high task risk.');
    if (!routed && provider === undefined)
      throw new Error('Choose a routing role and task risk, or a legacy provider.');
    if (!routed && !['claude', 'codex', 'opencode'].includes(String(provider)))
      throw new Error('Choose Claude, Codex, or OpenCode.');
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

    const routeSelection = routed
      ? selectModelRoute(modelRouting, {
          role: role as ModelRouteRole,
          risk: risk as ShipRisk,
        })
      : null;
    if (routeSelection?.reason)
      throw new Error(routeSelection.reason ?? 'No eligible model route.');
    const route = routeSelection?.route;
    const selectedProvider = route?.provider ?? provider ?? source.agent;
    const chosenProvider: SpawnReceipt['provider'] =
      selectedProvider === 'claude'
        ? 'claude'
        : selectedProvider === 'codex'
          ? 'codex'
          : 'opencode';
    const available = (await acp.agents()).find((agent) => agent.id === chosenProvider);
    if (!available?.available)
      throw new Error(available?.reason ?? `${chosenProvider} is unavailable.`);

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
      ...(routed && routeSelection
        ? {
            routing: {
              role: role as ModelRouteRole,
              risk: risk as ShipRisk,
              contextIsolationRequired: routeSelection.contextIsolationRequired,
              requested: {
                provider: chosenProvider,
                model: route?.model ?? null,
                variant: route?.variant ?? null,
              },
              actual: null,
            },
          }
        : {}),
    });
    activeSpawnRequests.add(receiptId);

    if (Date.now() >= request.expiresAt)
      throw new Error('The agent spawn request expired before launch.');
    // Return before the backend's five-minute coordination timeout.
    let responseDeadline = request.expiresAt + 180_000;
    let pressureQueuedAt: number | null = null;
    let resolveQueuedResponse: ((value: Record<string, unknown>) => void) | null = null;
    const queuedResponse = new Promise<Record<string, unknown>>((resolve) => {
      resolveQueuedResponse = resolve;
    });
    const onPressureQueue = (limit: number | null, reason: string | null) => {
      if (limit !== null && !isCheckingMachinePressure(reason)) {
        pressureQueuedAt ??= Date.now();
        updateSpawnReceipt(receiptId, { state: 'queued' });
        resolveQueuedResponse?.({
          status: 'queued',
          receiptId,
          accessKey: receiptAccessKey,
          sourceId,
          reason: reason ?? 'Waiting for agent capacity.',
        });
        resolveQueuedResponse = null;
      } else if (pressureQueuedAt !== null && limit === null) {
        responseDeadline += Date.now() - pressureQueuedAt;
        pressureQueuedAt = null;
      }
    };
    let releaseSpawnQueue: (() => void) | null = null;
    const launched = (async () => {
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

      const pressureDirectory =
        destination?.path ??
        (await invoke<string>('worktree_pressure_directory', { repository: project }));
      await acp.connect(chosenProvider, destination?.path ?? request.directory, undefined, {
        directory: pressureDirectory,
        onQueue: onPressureQueue,
      });
      updateSpawnReceipt(receiptId, { state: 'starting' });
      const previousSpawn = agentSpawnQueue;
      agentSpawnQueue = new Promise<void>((resolve) => {
        releaseSpawnQueue = resolve;
      });
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

      await coordinationSource(request);
      const selectedSource: CoordinationSource = {
        kind: 'acp',
        agent: chosenProvider,
        title: source.title,
        model: route ? acpModelId(chosenProvider, route.model) : undefined,
        variant: route?.variant,
      };
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
        undefined,
        undefined,
        (limit, reason) => {
          onPressureQueue(limit, reason);
          if (limit === null) updateSpawnReceipt(receiptId, { state: 'working' });
        },
      );
      activeSpawnRequests.delete(receiptId);
      return {
        ...started,
        worktreeId: destination.path,
        receiptId,
        accessKey: receiptAccessKey,
        sourceId,
        targetId: started.threadId,
        ...(routeSelection
          ? { contextIsolationRequired: routeSelection.contextIsolationRequired }
          : {}),
        status: 'started',
      };
    })();
    const trackedLaunch = launched
      .finally(() => releaseSpawnQueue?.())
      .catch((cause) => {
        const receipt = spawnReceipts.find((item) => item.receiptId === receiptId);
        if (receipt && !receiptIsSettled(receipt.state))
          updateSpawnReceipt(receiptId, { state: 'failed', error: describe(cause) });
        activeSpawnRequests.delete(receiptId);
        throw cause;
      });
    return Promise.race([trackedLaunch, queuedResponse]);
  }

  async function startCoordinatedThread(
    created: { path: string; branch: string },
    source: CoordinationSource,
    prompt: string,
    receiptId?: string,
    validation = false,
    beforePrompt?: () => Promise<void>,
    nativeGeneration?: number,
    promptAuthorization?: DirectShipAuthorization,
    onPromptQueue?: (limit: number | null, reason: string | null) => void,
  ) {
    const requestedModel =
      validation && source.model && hasUnresolvedModelAlias(source.model)
        ? undefined
        : source.model;
    if (!validation)
      await beginShipItRun(created.path, prompt, promptSkill(skills, prompt)?.name ?? null);
    const routingRole = receiptId
      ? spawnReceipts.find((item) => item.receiptId === receiptId)?.routing?.role
      : undefined;
    const routedProfile: CapabilityProfile =
      routingRole === 'exploration'
        ? 'explore'
        : ['review', 'testing'].includes(routingRole ?? '')
          ? 'review'
          : 'build';
    const capabilityProfile: CapabilityProfile = validation
      ? 'review'
      : routingRole
        ? routedProfile
        : 'build';
    const session = await acp
      .create(source.agent, created.path, capabilityProfile, nativeGeneration)
      .catch((cause) => {
        if (!validation) throw cause;
        throw new ValidationCandidateUnavailable(`${source.agent} is unavailable`, cause);
      });
    try {
      let configOptions = session.configOptions ?? [];
      const reportedModel = configOptions.find(
        (option) => option.type === 'select' && /model/i.test(`${option.id} ${option.name}`),
      )?.currentValue;
      if (requestedModel) {
        const modelOption = configOptions.find(
          (option) => option.type === 'select' && /model/i.test(`${option.id} ${option.name}`),
        );
        if (!modelOption?.options.some((option) => option.value === requestedModel)) {
          const message = `Model ${requestedModel} is unavailable in ${source.agent}.`;
          throw validation ? new ValidationCandidateUnavailable(message) : new Error(message);
        }
        const changed = await acp
          .setConfig(source.agent, created.path, session.sessionId, modelOption.id, requestedModel)
          .catch((cause) => {
            if (!validation) throw cause;
            throw new ValidationCandidateUnavailable(
              `${source.agent} / ${requestedModel} is unavailable`,
              cause,
            );
          });
        const actual = changed.configOptions?.find((option) => option.id === modelOption.id);
        if (actual?.currentValue !== requestedModel) {
          const message = `Cannot verify ${source.agent} selected model ${requestedModel}.`;
          throw validation ? new ValidationCandidateUnavailable(message) : new Error(message);
        }
        configOptions = changed.configOptions ?? configOptions;
      }
      const reportedVariant = configOptions.find(
        (option) =>
          option.type === 'select' &&
          /(variant|effort|reasoning)/i.test(`${option.id} ${option.name}`),
      )?.currentValue;
      if (source.variant) {
        const variantOption = configOptions.find(
          (option) =>
            option.type === 'select' &&
            /(variant|effort|reasoning)/i.test(`${option.id} ${option.name}`),
        );
        if (!variantOption?.options.some((option) => option.value === source.variant))
          throw new Error(`Variant ${source.variant} is unavailable in ${source.agent}.`);
        const changed = await acp.setConfig(
          source.agent,
          created.path,
          session.sessionId,
          variantOption.id,
          source.variant,
        );
        const actual = changed.configOptions?.find((option) => option.id === variantOption.id);
        if (actual?.currentValue !== source.variant)
          throw new Error(`Cannot verify ${source.agent} selected variant ${source.variant}.`);
      }
      const thread: AgentThread = {
        agent: source.agent,
        model: requestedModel ?? reportedModel,
        sessionId: session.sessionId,
        directory: created.path,
        title: prompt.slice(0, 60),
        updated: Date.now(),
        capabilityProfile,
      };
      saveAgentThread(thread);
      if (receiptId) {
        const receipt = spawnReceipts.find((item) => item.receiptId === receiptId);
        updateSpawnReceipt(receiptId, {
          targetId: `acp:${source.agent}:${session.sessionId}`,
          model: requestedModel ?? reportedModel,
          targetDirectory: created.path,
          worktreeId: created.path,
          ...(receipt?.routing
            ? {
                routing: {
                  ...receipt.routing,
                  actual: {
                    provider: source.agent as 'claude' | 'codex' | 'opencode',
                    model: requestedModel ?? reportedModel ?? null,
                    variant: source.variant ?? reportedVariant ?? null,
                  },
                },
              }
            : {}),
        });
      }
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
            requestedModel ?? reportedModel,
            `acp:${source.agent}:${session.sessionId}`,
          );
      updateAgentThreadStatus(thread, 'working');
      const turnId = crypto.randomUUID();
      if (receiptId) {
        updateSpawnReceipt(receiptId, { turnId, dispatchPending: true });
        await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
      }
      await beforePrompt?.();
      if (receiptId) requireSpawnPromptDispatch(receiptId);
      const recalledPrompt = await withAutomaticMemoryRecall({
        directory: created.path,
        prompt,
        query: prompt,
        sessionKey: `acp:${source.agent}:${session.sessionId}`,
      });
      let pressureQueued = false;
      const turn = dispatchAuthorizedDirectShipPrompt(promptAuthorization, () => {
        const targetId = `acp:${source.agent}:${session.sessionId}`;
        if (receiptId) {
          updateSpawnReceipt(receiptId, { state: 'working', dispatchPending: false });
          activeSpawnTargets.set(spawnTargetKey(created.path, targetId), receiptId);
        }
        try {
          return acp.prompt(
            source.agent,
            created.path,
            session.sessionId,
            recalledPrompt,
            turnId,
            [],
            (limit, reason) => {
              pressureQueued = limit !== null;
              onPromptQueue?.(limit, reason);
            },
            false,
          );
        } catch (cause) {
          if (
            receiptId &&
            activeSpawnTargets.get(spawnTargetKey(created.path, targetId)) === receiptId
          )
            activeSpawnTargets.delete(spawnTargetKey(created.path, targetId));
          throw cause;
        }
      });
      if (receiptId)
        await setSettingDurable('sai-agent-spawn-receipts', JSON.stringify(spawnReceipts));
      const finished = turn.then(
        async (outcome) => {
          if (tracking)
            await recordImplementationModel(
              created.path,
              requestedModel ?? reportedModel,
              tracking,
            );
          updateAgentThreadStatus(thread, acpPromptInterrupted(outcome) ? 'interrupted' : 'done');
          if (receiptId) {
            const current = spawnReceipts.find((item) => item.receiptId === receiptId);
            updateSpawnReceipt(receiptId, {
              state: acpPromptInterrupted(outcome) ? 'interrupted' : 'completed',
              result: spawnOutput.get(receiptId) ?? current?.result ?? null,
            });
            spawnOutput.delete(receiptId);
            if (
              activeSpawnTargets.get(
                spawnTargetKey(created.path, `acp:${source.agent}:${session.sessionId}`),
              ) === receiptId
            )
              activeSpawnTargets.delete(
                spawnTargetKey(created.path, `acp:${source.agent}:${session.sessionId}`),
              );
          }
          return undefined;
        },
        async (cause) => {
          if (tracking)
            await recordImplementationModel(
              created.path,
              requestedModel ?? reportedModel,
              tracking,
            );
          const interrupted = await acpFailedPromptInterrupted(
            source.agent,
            created.path,
            session.sessionId,
            turnId,
          );
          updateAgentThreadStatus(thread, interrupted ? 'interrupted' : 'failed');
          if (receiptId) {
            updateSpawnReceipt(receiptId, {
              state: interrupted ? 'interrupted' : 'failed',
              error: interrupted ? null : describe(cause),
            });
            spawnOutput.delete(receiptId);
            if (
              activeSpawnTargets.get(
                spawnTargetKey(created.path, `acp:${source.agent}:${session.sessionId}`),
              ) === receiptId
            )
              activeSpawnTargets.delete(
                spawnTargetKey(created.path, `acp:${source.agent}:${session.sessionId}`),
              );
          }
          if (!interrupted) error = describe(cause);
          throw cause;
        },
      );
      await awaitCoordinationStart(
        finished.catch(async (cause) => {
          if (
            await acpFailedPromptInterrupted(source.agent, created.path, session.sessionId, turnId)
          )
            return;
          throw cause;
        }),
        async () => {
          const state = (await acp.activity(created.path))[source.agent];
          return !!state?.active.includes(session.sessionId);
        },
        () => pressureQueued,
      );
      void finished.catch(() => undefined);
      return {
        path: created.path,
        branch: created.branch,
        threadId: `acp:${source.agent}:${session.sessionId}`,
      };
    } catch (cause) {
      await acp.cancel(source.agent, created.path, session.sessionId, null).catch(() => undefined);
      if (nativeGeneration !== undefined)
        await acp.releaseSessionFence(source.agent, created.path, session.sessionId);
      throw cause;
    }
  }

  function requireSpawnPromptDispatch(receiptId: string): void {
    const receipt = spawnReceipts.find((item) => item.receiptId === receiptId);
    if (!spawnPromptDispatchAllowed(receipt))
      throw new Error('Agent launch was cancelled before prompt dispatch.');
  }

  async function awaitCoordinationStart(
    turn: Promise<unknown>,
    isActive: () => Promise<boolean>,
    isQueued: () => boolean = () => false,
  ): Promise<void> {
    let stopped = false;
    let deadline = Date.now() + 30_000;
    async function poll(): Promise<void> {
      if (stopped || disposed) return;
      if (isQueued()) deadline = Date.now() + 30_000;
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
    const [acpResult, checksResult] = await Promise.allSettled([
      acp.pendingInbox(),
      invoke<InboxCheck[]>('list_post_turn_checks').catch(() => []),
    ]);
    if (generation !== inboxGeneration || disposed) return;
    const items: InboxItem[] = [];
    const automaticPermissions: AutomaticPermissionRequest[] = [];
    const acpResourceTrust =
      acpResult.status === 'fulfilled'
        ? new Map(
            await Promise.all(
              acpResult.value.map(async (pending) => {
                const sessionId = pending.message.params?.sessionId;
                const thread = [...agentThreads, ...nativeChildThreads].find(
                  (item) =>
                    item.agent === pending.agent &&
                    item.sessionId === sessionId &&
                    item.directory === pending.directory,
                );
                const trust = thread
                  ? await acp
                      .permissionResourcesTrusted(
                        thread.directory,
                        permissionReadResources(pending.message.params?.toolCall),
                      )
                      .catch(() => ({ trusted: false, canonicalResources: [] }))
                  : { trusted: false, canonicalResources: [] };
                return [pending, trust] as const;
              }),
            ),
          )
        : new Map();
    if (generation !== inboxGeneration || disposed) return;
    if (acpResult.status === 'fulfilled') {
      for (const pending of acpResult.value) {
        const sessionId = pending.message.params?.sessionId;
        const requestId = pending.message.id;
        if (typeof sessionId !== 'string' || requestId == null) continue;
        const thread = [...agentThreads, ...nativeChildThreads].find(
          (item) =>
            item.agent === pending.agent &&
            item.sessionId === sessionId &&
            item.directory === pending.directory,
        );
        if (!thread) continue;
        const location = byDirectory.get(thread.directory);
        if (!location) continue;
        const nativeChild =
          nativeSubagents[nativeSubagentId(pending.agent, pending.directory, sessionId)];
        if (pending.message.method === 'elicitation/create') {
          const message = pending.message.params?.message;
          const schema = pending.message.params?.requestedSchema;
          items.push({
            ...location,
            key: `elicitation:${pending.directory}:${pending.agent}:${sessionId}:${requestId}`,
            kind: 'question',
            agent: `${agentAvailability.find((item) => item.id === pending.agent)?.name ?? pending.agent}${nativeChild ? ` · ${nativeChild.name}` : ''}`,
            agentId: pending.agent,
            sessionId,
            requestId,
            text: elicitationSummary(message, schema),
            receivedAt: pending.receivedAt,
          });
          continue;
        }
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
        const resourceTrust = acpResourceTrust.get(pending);
        const policy = automaticPermissionPolicy({
          profile: intersectCapabilityProfiles(
            thread.capabilityProfile ?? 'build',
            capabilityProfileForShipThread(
              thread.directory,
              receiptSourceId(thread.agent, thread.sessionId),
            ),
          ),
          workspace: thread.directory,
          title,
          toolCall: tool,
          options,
          resourceTrust,
        });
        const key = `acp:${pending.directory}:${pending.agent}:${sessionId}:${requestId}`;
        const rawPermissionGeneration = pending.message.params?.sailPermissionGeneration;
        const permissionGeneration =
          typeof rawPermissionGeneration === 'number'
            ? rawPermissionGeneration
            : pending.receivedAt;
        const rawPermissionFingerprint = pending.message.params?.sailPermissionFingerprint;
        const permissionFingerprint =
          typeof rawPermissionFingerprint === 'string' ? rawPermissionFingerprint : undefined;
        const decisionTitle = permissionDecisionTitle(title, policy);
        items.push({
          ...location,
          key,
          kind: 'acp-permission',
          agent: `${agentAvailability.find((item) => item.id === pending.agent)?.name ?? pending.agent}${nativeChild ? ` · ${nativeChild.name}` : ''}`,
          agentId: pending.agent,
          sessionId,
          requestId,
          text: decisionTitle,
          receivedAt: pending.receivedAt,
          options,
          allow: policy.recommendation !== 'deny',
          policy,
          permissionTitle: title,
          permissionToolCall: tool,
          permissionResourceTrust: resourceTrust,
          generation: permissionGeneration,
          fingerprint: permissionFingerprint,
        });
        automaticPermissions.push({
          key,
          generation: permissionFingerprint ?? permissionGeneration,
          policy,
          respond: async (optionId) => {
            const latestTrust = await acp.permissionResourcesTrusted(
              thread.directory,
              permissionReadResources(tool),
            );
            assertAutomaticPermissionAllowed(
              {
                profile: effectiveCapabilityProfileForAcpSession(
                  thread.agent,
                  thread.directory,
                  thread.sessionId,
                  thread.capabilityProfile,
                ),
                workspace: thread.directory,
                title,
                toolCall: tool,
                options,
                resourceTrust: latestTrust,
              },
              optionId,
            );
            await acp.permission(
              pending.agent,
              thread.directory,
              requestId,
              optionId,
              sessionId,
              permissionGeneration,
              permissionFingerprint,
            );
          },
          record: (optionId) =>
            recordDecisionActivity(
              thread,
              acpPermissionActivitySourceId(requestId, permissionGeneration, permissionFingerprint),
              decisionTitle,
              permissionOutcome(options, optionId),
              policy.reason,
            ),
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
    const automaticResults = await Promise.allSettled(
      automaticPermissions.map(async (request) => ({
        key: request.key,
        resolved: await permissionResolver.resolve(request),
      })),
    );
    if (generation !== inboxGeneration || disposed) return;
    const resolved = new Set(
      automaticResults.flatMap((result) =>
        result.status === 'fulfilled' && result.value.resolved ? [result.value.key] : [],
      ),
    );
    for (const [key, at] of resolvedDuringRefresh)
      if (at < generation) resolvedDuringRefresh.delete(key);
    inboxItems = sortInbox(
      items.filter((item) => !resolved.has(item.key) && !resolvedDuringRefresh.has(item.key)),
    );
    inboxError =
      acpResult.status === 'rejected' ||
      automaticResults.some((result) => result.status === 'rejected')
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
      if (agent) {
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
      if (thread.agent !== 'opencode') {
        forgetRecentTranscript(thread);
        void acp.forget(thread.agent, thread.directory, thread.sessionId).catch(() => {});
      }
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

  function needsForceDelete(message: string) {
    return (
      message === 'Worktree has ignored files. Move or remove them before deleting.' ||
      message.includes('contains modified or untracked files')
    );
  }

  function hasActiveAgentSessions(message: string) {
    return message.startsWith('Worktree has active agent sessions');
  }

  async function deleteProjectWorktreeOnce(
    repository: string,
    path: string,
    branch: string,
    force: boolean,
    stopAgents = false,
  ) {
    let retryForce = false;
    let retryStop = false;
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
      stopAgents || e2eAnswer === 'Yes'
        ? true
        : e2eAnswer === 'No'
          ? false
          : await confirmInApp(
              force ? 'Force delete worktree' : 'Delete worktree',
              force || config
                ? `Delete worktree “${branch}” at ${path}? This permanently removes uncommitted and ignored files, including copied files. The branch will remain.`
                : `Delete worktree “${branch}” at ${path}? Uncommitted and ignored files block deletion. The branch will remain.`,
              force ? 'Force delete' : 'Delete worktree',
              { destructive: true },
            );
    if (!confirmed) return;
    const wasSelected = directory === path;
    worktreeDeletions = {
      ...worktreeDeletions,
      [path]: config?.archive ? 'Archiving' : 'Preparing deletion',
    };
    try {
      if (config?.archive && !stopAgents) {
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
            { destructive: true },
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
      await invoke('delete_worktree', {
        request: {
          repository,
          worktree: path,
          force: force || !!config,
          expectedRevision: null,
          expectedBranch: null,
          ...(stopAgents ? { stopAgents: true } : {}),
        },
      });
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
        if (thread.agent !== 'opencode') {
          forgetRecentTranscript(thread);
          void acp.forget(thread.agent, thread.directory, thread.sessionId).catch(() => {});
        }
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
      if (!stopAgents && hasActiveAgentSessions(deletionError)) {
        error = '';
        retryStop = true;
      } else if (!force && needsForceDelete(deletionError)) {
        error = '';
        retryForce = true;
      } else error = deletionError;
    } finally {
      const remaining = { ...worktreeDeletions };
      delete remaining[path];
      worktreeDeletions = remaining;
    }
    if (retryStop) {
      const stopConfirmed = await confirmInApp(
        'Agent is running',
        `An agent is still running in worktree “${branch}”. Stop it and delete the worktree at ${path}? Uncommitted and ignored files are removed. The branch will remain.`,
        'Stop agent and delete',
        { destructive: true },
      );
      if (stopConfirmed) await deleteProjectWorktreeOnce(repository, path, branch, true, true);
    } else if (retryForce) await deleteProjectWorktreeOnce(repository, path, branch, true);
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
    const target = await invoke<string>('validate_repository', { path: worktree.path });
    if (directory !== target) await loadProject(target);
    if (directory !== target) throw new Error('Worktree changed before sending the logs.');
    const owner = shipRuns
      .flatMap((run) => run.issues.map((issue) => ({ run, issue })))
      .find(({ issue }) => issue.path === target);
    const revision =
      check.revision ?? (await invoke<string>('working_tree_revision', { path: worktree.path }));
    const recorded = recordCiFailureTriage(
      owner?.issue.ciTriages ?? [],
      triageCiFailure(
        {
          revision,
          workflow: check.workflow ?? 'GitHub Actions',
          job: check.name,
          attempt: check.attempt ?? 1,
          log,
          url: check.url,
        },
        ciRerunPolicy,
        Date.now(),
      ),
    );
    if (recorded.duplicate) return;
    const triage = recorded.triage;
    const text = ciFailurePrompt(triage);
    const pane = leaves(paneLayout).find(
      (leaf) =>
        leaf.agent &&
        leaf.thread &&
        (!owner?.issue.threadId ||
          leaf.thread.sessionId === owner.issue.threadId ||
          `${leaf.thread.agent}:${leaf.thread.sessionId}` === owner.issue.threadId),
    );
    if (pane?.agent) {
      await sendDiffComments(pane.id, diffCommentKey(pane.id), text);
    } else {
      const thread = agentThreads.find(
        (item) =>
          item.directory === target &&
          (!owner?.issue.threadId ||
            item.sessionId === owner.issue.threadId ||
            `${item.agent}:${item.sessionId}` === owner.issue.threadId),
      );
      if (thread) {
        focusMainPane();
        openAgent(thread.agent, thread);
        await tick();
        await sendDiffComments('main', diffCommentKey('main'), text);
      } else if (acpAgent) await sendDiffComments('main', diffCommentKey('main'), text);
      else
        throw new Error(
          'Open the owning agent thread in this worktree before sending CI evidence.',
        );
    }
    if (owner) {
      let evidenceManifests = owner.issue.evidenceManifests ?? [];
      if (owner.issue.checkpoint)
        evidenceManifests = recordTaskEvidence(
          evidenceManifests,
          revision,
          owner.issue.checkpoint.acceptanceCriteria,
          {
            id: triage.id,
            kind: 'command',
            name: `ci-triage:${triage.workflow}/${triage.job}`,
            provider: 'github',
            model: null,
            result: 'failed',
            timestamp: triage.routedAt,
            outputReference: triage.url,
            criteria: [],
            economics: ciTriageEconomics(triage),
            executionOrder: [check.runId ?? check.databaseId ?? triage.routedAt, triage.attempt],
          },
          owner.issue.shippingTarget?.baseRevision,
        );
      await updateShipIssue(owner.run, owner.issue, {
        ciTriages: recorded.records,
        evidenceRevision: revision,
        evidenceManifests,
      });
    }
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
    error = '';
    ++selection;
    directory = path;
    mainPickerDirectory = getSetting(`sai-main-pane-empty:${path}`) === 'true' ? path : null;
    browserAccessDisabled = getSetting(`sai-browser-disabled:${path}`) === 'true';
    focusedPane = leaves(paneLayouts[path] ?? mainPane())[0]?.id ?? 'main';
    setSetting('sai-directory', path);
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
    mobileView = 'chat';
    diffs = [];
    selectedFilePath = null;
    diffError = '';
    ++diffRefresh;
    diffLoading = false;
    await canonicalizeProject(path);
    if (directory) await refreshAutomaticMemoryRecall(directory);
    if (directory) await refreshAutomaticMemoryCapture(directory);
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
      acpAgent
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

  /** Moves saved state to Git's canonical repository path, or falls back when the path is gone. */
  async function canonicalizeProject(path: string) {
    const current = selection;
    try {
      const repository = await invoke<string>('validate_repository', { path });
      if (current !== selection) return;
      if (path === repository) {
        setSetting('sai-directory', repository);
        return;
      }
      if (paneLayouts[path]) {
        paneLayouts = {
          ...paneLayouts,
          [repository]: migratePaneDirectory(paneLayouts[path], path, repository),
        };
        delete paneLayouts[path];
        persistPaneLayouts();
      }
      saveProjectCatalog(replaceRepositoryPath(projectCatalog, path, repository));
      const knownThreads = [...agentThreads, ...nativeThreads, ...sidebarOpenCodeThreads];
      if (recentCycleKeys) {
        const selectedKey = recentCycleKeys[recentCycleIndex];
        const migratedSelected = selectedKey
          ? migrateRecentThreadKeys([selectedKey], knownThreads, path, repository)[0]
          : null;
        recentCycleKeys = migrateRecentThreadKeys(recentCycleKeys, knownThreads, path, repository);
        recentCycleIndex = migratedSelected ? recentCycleKeys.indexOf(migratedSelected) : -1;
      }
      recentThreadKeys = migrateRecentThreadKeys(recentThreadKeys, knownThreads, path, repository);
      setSetting('sai-recent-agent-threads', JSON.stringify(recentThreadKeys));
      hiddenSidebarThreadKeys = migrateRecentThreadKeys(
        hiddenSidebarThreadKeys,
        knownThreads,
        path,
        repository,
      );
      setSetting('sai-hidden-sidebar-threads', JSON.stringify(hiddenSidebarThreadKeys));
      const attentionKeys = new Map(
        knownThreads
          .filter((thread) => thread.directory === path)
          .map((thread) => [threadKey(thread), threadKey({ ...thread, directory: repository })]),
      );
      threadAttention = Object.fromEntries(
        Object.entries(threadAttention).map(([key, value]) => [
          attentionKeys.get(key) ?? key,
          value,
        ]),
      );
      saveThreadAttention();
      agentThreads = agentThreads.map((thread) =>
        thread.directory === path ? Object.assign({}, thread, { directory: repository }) : thread,
      );
      saveAgentThreads(agentThreads);
      nativeThreads = nativeThreads.map((thread) =>
        thread.directory === path ? { ...thread, directory: repository } : thread,
      );
      sidebarOpenCodeThreads = sidebarOpenCodeThreads.map((thread) =>
        thread.directory === path ? { ...thread, directory: repository } : thread,
      );
      setSetting('sai-recent-native-threads', JSON.stringify(nativeThreads));
      if (acpThread?.directory === path)
        acpThread = Object.assign({}, acpThread, { directory: repository });
      directory = repository;
      setSetting('sai-directory', repository);
    } catch (cause) {
      if (current !== selection) return;
      if (missingRepositoryPath(cause)) {
        const fallback = await availableFallbackDirectory(path);
        if (current !== selection) return;
        if (fallback) {
          void loadProject(fallback, false).catch((loadCause) => {
            if (directory === fallback) error = describe(loadCause);
          });
          return;
        }
      }
      error = describe(cause);
    }
  }

  async function availableFallbackDirectory(missing: string): Promise<string | null> {
    const parent = worktreeAt(projectCatalog, missing)?.repository;
    const candidates = [parent, ...projectCatalog.repositories].filter(
      (path): path is string => !!path && path !== missing,
    );
    const unique = [...new Set(candidates)];
    const available = await Promise.all(
      unique.map((path) =>
        invoke<boolean>('repository_path_available', { path }).catch(() => false),
      ),
    );
    return unique.find((_, index) => available[index]) ?? null;
  }

  async function listOpenCodeRootThreads(path: string): Promise<AgentThread[]> {
    const threads = await listSidebarAcpThreads(
      'opencode',
      (cursor) => acp.listSessions('opencode', path, cursor, 'explore'),
      path,
    );
    // OpenCode's session/list has no parent marker, so only children Sail has seen are hidden.
    return threads.filter(
      (thread) =>
        !nativeSubagents[nativeSubagentId('opencode', thread.directory, thread.sessionId)],
    );
  }

  async function refreshSidebarOpenCodeThreads(paths: string[]): Promise<string | null> {
    if (!agentAvailability.some((agent) => agent.id === 'opencode' && agent.available)) return null;
    const generation = ++sidebarInventoryGeneration;
    const results = await Promise.allSettled(paths.map((path) => listOpenCodeRootThreads(path)));
    if (generation !== sidebarInventoryGeneration || disposed) return null;
    const failed = new Set(paths.filter((_, index) => results[index]?.status === 'rejected'));
    const listed = new Set(paths);
    const retained = sidebarOpenCodeThreads.filter(
      (thread) => !listed.has(thread.directory) || failed.has(thread.directory),
    );
    const renamed = new Map(
      agentThreads.filter((thread) => thread.renamed).map((thread) => [threadKey(thread), thread]),
    );
    sidebarOpenCodeThreads = [
      ...results
        .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
        .map((thread) => {
          const saved = renamed.get(threadKey(thread));
          return saved ? Object.assign({}, thread, { title: saved.title, renamed: true }) : thread;
        }),
      ...retained,
    ];
    const failure = results.find((result) => result.status === 'rejected');
    return failure?.status === 'rejected'
      ? `Could not list OpenCode sessions: ${describe(failure.reason)}`
      : null;
  }

  let sidebarInventoryFailure = '';

  function reportSidebarInventoryFailure(failure: string | null) {
    // The 30 s refresh must not re-raise the same failure over the user's current error.
    if (failure && failure !== sidebarInventoryFailure) error = failure;
    sidebarInventoryFailure = failure ?? '';
  }

  function scheduleSidebarInventoryRefresh() {
    clearTimeout(sidebarInventoryTimer);
    sidebarInventoryTimer = setTimeout(() => {
      void refreshSidebarOpenCodeThreads(JSON.parse(sidebarDirectoryKey)).then(
        reportSidebarInventoryFailure,
        (cause: unknown) => reportSidebarInventoryFailure(describe(cause)),
      );
    }, 250);
  }

  $effect(() => {
    const tracked = sidebarDirectoryKey;
    const available = agentAvailability.some((agent) => agent.id === 'opencode' && agent.available);
    if (tracked && available) scheduleSidebarInventoryRefresh();
  });

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
    paletteIndex = Math.max(
      0,
      paletteEntries.findIndex((entry) => !entry.disabled),
    );
    paletteError = '';
    paletteDialog.showModal();
    void tick().then(() => paletteInput.focus());
  }

  function closeCommandPalette(restore = true) {
    ++paletteSessionGeneration;
    restorePaletteFocus = restore;
    paletteDialog.close();
  }

  function commandPaletteClosed() {
    if (restorePaletteFocus) palettePreviousFocus?.focus();
    palettePreviousFocus = null;
  }

  function setPaletteStep(step: PaletteStep) {
    ++paletteSessionGeneration;
    paletteStep = step;
    paletteQuery = '';
    paletteError = '';
    paletteLoading = false;
    paletteIndex = 0;
    if (step.kind === 'sessions' && step.agent === 'opencode')
      void loadPaletteOpenCodeSessions(step.directory);
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

  async function loadPaletteOpenCodeSessions(path: string) {
    const generation = ++paletteSessionGeneration;
    paletteLoading = true;
    paletteError = '';
    try {
      const failure = await refreshSidebarOpenCodeThreads([path]);
      if (generation === paletteSessionGeneration && failure) paletteError = failure;
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

  function runPaletteAction(id: PaletteActionId) {
    // Actions that open a dialog or move focus must not get it pulled back to the palette trigger.
    closeCommandPalette(id.startsWith('theme.') || id === 'sidebar.toggle');
    switch (id) {
      case 'pane.split':
        splitFocusedPane('row');
        break;
      case 'terminal.split':
        splitFocusedPane('row', 'terminal');
        break;
      case 'chat.side':
        openSideChat();
        break;
      case 'inbox.open':
        openInbox();
        break;
      case 'attention.next':
        void goToNextAttention();
        break;
      case 'overview.toggle':
        if (workspaceView === 'overview') showWorkspace();
        else showTaskOverview();
        break;
      case 'ship.open':
        showShipRuns();
        break;
      case 'changes.toggle':
        void toggleChanges();
        break;
      case 'settings.open':
        void openSettings();
        break;
      case 'theme.system':
        setTheme('system');
        break;
      case 'theme.light':
        setTheme('light');
        break;
      case 'theme.dark':
        setTheme('dark');
        break;
      case 'shortcuts.help':
        openShortcutSheet();
        break;
      case 'sidebar.toggle':
        toggleSidebar();
        break;
    }
  }

  function openShortcutSheet() {
    if (shortcutsDialog.open || document.querySelector('dialog[open]')) return;
    shortcutsDialog.showModal();
  }

  function placeCopyStatus() {
    const node = window.getSelection()?.anchorNode;
    const anchor = node instanceof Element ? node : (node?.parentElement ?? null);
    const host = copyStatusHost(anchor, [...document.querySelectorAll('dialog:modal')]);
    copyStatusHome ??= {
      parent: copyStatusRegion.parentNode as Node,
      next: copyStatusRegion.nextSibling,
    };
    if (host) {
      if (copyStatusRegion.parentNode === host) return false;
      host.append(copyStatusRegion);
      return true;
    }
    const { parent, next } = copyStatusHome;
    if (copyStatusRegion.parentNode === parent) return false;
    parent.insertBefore(copyStatusRegion, next?.parentNode === parent ? next : null);
    return true;
  }

  async function announceCopied() {
    clearTimeout(copiedStatusTimer);
    const moved = placeCopyStatus();
    copiedStatus = '';
    // A cleared region makes a repeated "Copied" a new live-region change.
    await tick();
    // Screen readers skip changes made as a live region is inserted.
    if (moved) await new Promise((resolve) => setTimeout(resolve, 100));
    copiedStatus = 'Copied';
    copiedStatusTimer = setTimeout(() => (copiedStatus = ''), 2000);
  }

  function copySelection() {
    copyCompletedSelection({ enabled: autoCopyEnabled, oncopied: () => void announceCopied() });
  }

  async function choosePaletteEntry(entry: PaletteEntry | null) {
    if (!entry || entry.disabled || paletteBusy) return;
    const step = paletteStep;
    if (entry.kind === 'command' && entry.command) {
      runSavedCommand(entry.command);
      return;
    }
    if (entry.kind === 'action' && entry.actionId) {
      runPaletteAction(entry.actionId);
      return;
    }
    if (step.kind === 'projects' && entry.kind === 'thread' && entry.thread) {
      paletteBusy = true;
      paletteError = '';
      const workspaceError = error;
      try {
        if (!(await jumpToRecentThread(threadKey(entry.thread))))
          throw new Error(jumpFailure || 'This session is no longer available.');
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
        if (!acpThread && savedThreadPane) {
          focusPaneForTyping(savedThreadPane.id);
        } else if (!acpThread && runningThread) {
          focusMainPane();
          openAgent(runningThread.agent, runningThread);
        } else if (!acpThread) {
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
    if (!['new-session', 'thread'].includes(entry.kind)) return;
    paletteBusy = true;
    paletteError = '';
    try {
      if (entry.kind === 'thread') {
        if (!entry.thread || !(await jumpToRecentThread(threadKey(entry.thread))))
          throw new Error('This session is no longer available.');
        closeCommandPalette(false);
        focusPaneForTyping('main');
        return;
      }
      const target = step.directory;
      let expectedProjectLoad = projectLoadGeneration;
      if (target !== directory) {
        const pending = loadProject(target, false);
        expectedProjectLoad = projectLoadGeneration;
        await pending;
      }
      if (expectedProjectLoad !== projectLoadGeneration || !directory) return;
      closeCommandPalette(false);
      focusMainPane();
      if (entry.kind === 'new-session') openAgent(step.agent);
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
    const previous = agentThreads.find((item) => threadKey(item) === threadKey(thread));
    thread = mergeAgentThreadUpdate(previous, thread);
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

  function saveAgentActivity(thread: AgentThread) {
    const previous = agentThreads.find((item) => threadKey(item) === threadKey(thread));
    saveAgentThread(mergeAgentThreadActivity(previous, thread));
  }

  function rememberRecentThread(thread: AgentThread) {
    if (!agentThreads.some((item) => threadKey(item) === threadKey(thread)))
      saveAgentThread(thread);
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
        .filter((thread) => availableAgents.has(thread.agent) && projectPaths.has(thread.directory))
        .map(threadKey),
    );
    return recentThreadKeys.filter((key) => availableThreads.has(key));
  }

  function focusedThreadKey(): string | null {
    const thread =
      focusedPane === 'main'
        ? acpThread
        : leaves(paneLayout).find((pane) => pane.id === focusedPane)?.thread;
    return thread ? threadKey(thread) : null;
  }

  let jumpFailure = '';

  function threadAgentUnavailable(thread: AgentThread): string | null {
    const agent = agentAvailability.find((item) => item.id === thread.agent);
    if (agent?.available) return null;
    return `${agent?.name ?? thread.agent} is unavailable.${agent?.reason ? ` ${agent.reason}` : ''}`;
  }

  async function jumpToRecentThread(key: string): Promise<boolean> {
    jumpFailure = '';
    const known = () =>
      [...agentThreads, ...nativeChildThreads, ...nativeThreads, ...sidebarOpenCodeThreads].find(
        (item) => threadKey(item) === key,
      );
    const thread = known();
    if (!thread) {
      jumpFailure = 'This thread is no longer listed.';
      return false;
    }
    const unavailable = threadAgentUnavailable(thread);
    if (unavailable) {
      jumpFailure = unavailable;
      return false;
    }
    showWorkspace();
    const jump = ++recentJumpGeneration;
    let expectedProjectLoad = projectLoadGeneration;
    if (thread.directory === directory) {
      const available = await invoke<boolean>('repository_path_available', {
        path: directory,
      }).catch(() => false);
      if (jump !== recentJumpGeneration || expectedProjectLoad !== projectLoadGeneration)
        return false;
      if (!available) {
        jumpFailure = 'This session is no longer available.';
        return false;
      }
      showSidebarThread(thread);
      focusMainPane();
      openAgent(thread.agent, thread, true);
      focusPaneForTyping('main');
      return true;
    }
    const target = await invoke<string>('validate_repository', { path: thread.directory }).catch(
      (cause: unknown) => {
        jumpFailure = describe(cause);
        return null;
      },
    );
    if (!target) return false;
    if (jump !== recentJumpGeneration || expectedProjectLoad !== projectLoadGeneration)
      return false;
    const pending = loadProject(thread.directory, false);
    expectedProjectLoad = projectLoadGeneration;
    void pending.catch((cause) => {
      if (expectedProjectLoad === projectLoadGeneration) error = describe(cause);
    });
    if (jump !== recentJumpGeneration || expectedProjectLoad !== projectLoadGeneration)
      return false;
    const selected = known();
    if (!selected || selected.directory !== directory) {
      jumpFailure = 'This thread is no longer listed.';
      return false;
    }
    showSidebarThread(selected);
    focusMainPane();
    openAgent(selected.agent, selected, true);
    focusPaneForTyping('main');
    return true;
  }

  async function selectSidebarThread(key: string) {
    try {
      if (!(await jumpToRecentThread(key)) && jumpFailure) error = jumpFailure;
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function openShipTarget(path: string, threadId?: string | null, prefill?: string | null) {
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
          item.directory === path && sameThreadId(threadId, `acp:${item.agent}:${item.sessionId}`),
      );
      if (!thread)
        throw new Error('Session history is unavailable. Open the worktree to inspect it.');
      if (threadAgentUnavailable(thread)) throw new Error('This session’s agent is unavailable.');
      if (!(await jumpToRecentThread(threadKey(thread))))
        throw new Error('Session history is unavailable. Open the worktree to inspect it.');
      if (prefill) prefillWorkerComposer(thread, prefill);
    } else await loadProject(path);
    closeShipRuns();
  }

  /** Puts the worker's pending request in its composer and focuses it; a busy worker queues the reply. */
  function prefillWorkerComposer(thread: AgentThread, text: string) {
    issuePrefills = {
      ...issuePrefills,
      [thread.directory]: { id: crypto.randomUUID(), text },
    };
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
        element.dataset.agentId === item.agentId &&
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
    const thread = [...agentThreads, ...nativeChildThreads].find(
      (entry) =>
        entry.agent === item.agentId &&
        entry.sessionId === item.sessionId &&
        entry.directory === item.directory,
    );
    if (thread) await jumpToRecentThread(threadKey(thread));
    await focusInboxRequest(item);
  }

  function saveAttentionLedger(ledger: AttentionLedger) {
    attentionLedger = ledger;
    setSetting('sai-attention-ledger', JSON.stringify(ledger));
  }

  function dismissAttentionItem(item: AttentionItem) {
    saveAttentionLedger(dismissAttention(attentionLedger, item));
  }

  function snoozeAttentionItem(item: AttentionItem, choice: AttentionSnooze) {
    saveAttentionLedger(snoozeAttention(attentionLedger, item, snoozeUntil(choice, Date.now())));
  }

  async function openAttentionTarget(target: AttentionTarget) {
    const route = attentionRoute(target);
    if (route.view === 'thread') {
      const request = inboxItems.find(
        (item) =>
          !isInboxOutcome(item) &&
          item.agentId === route.agentId &&
          item.directory === route.directory &&
          item.sessionId === route.sessionId &&
          String(item.requestId) === String(route.requestId),
      );
      if (request) await openInboxItem(request);
      else
        await jumpToRecentThread(JSON.stringify([route.agentId, route.directory, route.sessionId]));
      return;
    }
    inboxDialog.close();
    if (route.view === 'subagent') {
      const receipt = visibleSpawnReceipts.find((item) => item.receiptId === route.receiptId);
      if (!receipt) throw new Error('The subagent is no longer available.');
      await openSpawnTarget(receipt);
      return;
    }
    showWorkspace();
    if (directory !== route.repository && coordinationProject(directory) !== route.repository)
      await loadProject(route.repository, false);
    showShipRuns();
    shipFocusRequest = {
      id: (shipFocusRequest?.id ?? 0) + 1,
      runId: route.runId,
      issueId: route.issueId,
      focus: route.focus,
    };
  }

  async function openAttentionItem(item: AttentionItem) {
    try {
      await openAttentionTarget(item.target);
    } catch (cause) {
      error = describe(cause);
    }
  }

  async function openNotificationTarget(payload: unknown) {
    if (typeof payload === 'string') {
      await jumpToRecentThread(payload);
      return;
    }
    if (isAttentionTarget(payload)) await openAttentionTarget(payload);
  }

  async function goToNextAttention() {
    const item = nextAttentionItem(attentionItems, lastAttentionId);
    if (!item) return;
    lastAttentionId = item.id;
    await openAttentionItem(item);
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
    try {
      await decideInboxItem(item, optionId);
    } catch (cause) {
      // Settled elsewhere: its resolution event records whether it was answered or cancelled.
      if (item.kind !== 'acp-permission' || !permissionAlreadyAnswered(cause)) throw cause;
      await refreshInbox();
    }
  }

  async function decideInboxItem(item: InboxItem, optionId: string | null) {
    if (item.kind === 'acp-permission') {
      const thread = [...agentThreads, ...nativeChildThreads].find(
        (entry) =>
          entry.agent === item.agentId &&
          entry.sessionId === item.sessionId &&
          entry.directory === item.directory,
      );
      if (!thread) throw new Error('Thread is no longer available.');
      const policy = liveInboxPermissionPolicy(item, thread);
      if (!policy) throw new Error('Permission policy is no longer available.');
      const settledOptionId = permissionChoiceForPolicy(policy, item.options ?? [], optionId);
      await permissionResolver.resolve({
        key: item.key,
        generation: item.fingerprint ?? item.generation ?? item.receivedAt,
        policy,
        optionId: settledOptionId,
        respond: (resolvedOptionId: string | null) =>
          acp.permission(
            thread.agent,
            thread.directory,
            item.requestId!,
            resolvedOptionId,
            item.sessionId,
            typeof item.generation === 'number' ? item.generation : undefined,
            item.fingerprint,
          ),
        record: (resolvedOptionId: string | null) =>
          recordDecisionActivity(
            thread,
            inboxDecisionActivitySourceId(item),
            inboxPermissionDecisionTitle(
              item,
              resolvedOptionId === null ||
                permissionOutcome(item.options ?? [], resolvedOptionId) === 'rejected'
                ? 'rejected'
                : 'completed',
            ),
            resolvedOptionId === null
              ? 'rejected'
              : permissionOutcome(item.options ?? [], resolvedOptionId),
          ),
      });
      await refreshInbox();
      void restoreAgentActivity();
      return;
    }
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
    browserUrl?: string,
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
    if (browserTab && browserUrl) {
      browserTab.history = [browserUrl];
      browserTab.index = 0;
    }
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
    if (!transcript || !transcript.ready || (thread && transcript.sessionId !== thread.sessionId)) {
      error = 'Wait for this thread to finish loading before opening a side chat.';
      return;
    }
    const context = transcript.entries
      .filter((entry) => entry.type === 'user' || entry.type === 'assistant')
      .map((entry) => `${entry.type}: ${'text' in entry ? entry.text : ''}`)
      .join('\n\n')
      .slice(-40000);
    const source: SideChat['source'] = { kind: 'acp', agent, context };
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
    pickedAttachments = { ...pickedAttachments, [next.id]: attachment };
    focusPaneForTyping(next.id);
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
        sameThreadId(check.thread, `acp:${item.agent}:${item.sessionId}`),
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
          inboxDecisionActivitySourceId(candidate) === event.sourceId,
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
    automaticReason?: string,
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
        ...(automaticReason === undefined ? {} : { automatic: true, reason: automaticReason }),
      },
    ]);
    setSetting('sai-activity-history', saveActivityHistory(durableActivityHistory));
  }

  function inboxDecisionActivitySourceId(item: InboxItem): string {
    if (item.kind !== 'acp-permission') return String(item.requestId ?? item.key);
    return acpPermissionActivitySourceId(
      item.requestId ?? item.key,
      item.generation ?? item.receivedAt,
      item.fingerprint,
    );
  }

  function updateMainAgentWorkspaceActivity(
    items: WorkspaceActivityItem[],
    onselect: (item: WorkspaceActivityItem) => Promise<void>,
  ) {
    mainAgentWorkspaceActivity = items;
    selectMainAgentWorkspaceActivity = onselect;
  }

  async function selectMainActivity(item: WorkspaceActivityItem) {
    await selectMainAgentWorkspaceActivity(item);
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
    }
    focusPaneForTyping('main');
  }

  function updatePaneRatio(id: string, ratio: number) {
    savePaneLayout(updatePane(paneLayout, id, { ratio }));
  }

  function createPaneThread(id: string, thread: AgentThread) {
    invalidatePaneSelection(id);
    const sessionKey = `acp:${thread.agent}:${thread.sessionId}`;
    migrateDiffComments(diffCommentKey(id), `${directory}\0${id}\0${sessionKey}`);
    savePaneLayout(updatePane(paneLayout, id, { thread }));
    if (thread.agent === 'opencode') {
      rememberRecentThread(thread);
      scheduleSidebarInventoryRefresh();
      return;
    }
    saveAgentThread(thread);
    rememberRecentThread(thread);
  }

  function choosePaneAgent(id: string, agent: AgentId) {
    if (id === 'main') {
      openAgent(agent);
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
      return `${directory}\0main\0acp:${acpAgent ?? 'none'}:${acpThread?.sessionId ?? 'new'}`;
    const pane = leaves(paneLayout).find((leaf) => leaf.id === id);
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
    return sendAgentPaneBatch(id, text, false);
  }

  function sendAgentPaneBatch(id: string, text: string, leavePlanMode: boolean): Promise<void> {
    const agent =
      id === 'main' ? acpAgent : leaves(paneLayout).find((leaf) => leaf.id === id)?.agent;
    if (!agent || pendingAgentBatches[id]) throw new Error('Agent pane is not ready for comments.');
    const batch = { id: crypto.randomUUID(), text, leavePlanMode };
    return new Promise<void>((resolve, reject) => {
      batchWaiters.set(batch.id, { resolve, reject });
      pendingAgentBatches = { ...pendingAgentBatches, [id]: batch };
    });
  }

  async function sendPlanMessage(
    id: string,
    text: string,
    options: { leavePlanMode: boolean },
  ): Promise<void> {
    await sendAgentPaneBatch(id, text, options.leavePlanMode);
  }

  function revealPlanPane(id: string) {
    if (id === 'main') return;
    if (!changesPanes.includes(id)) changesPanes = [...changesPanes, id];
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

  async function deleteAgentThread(thread: AgentThread) {
    const stillRunning = !!runningAgentThreads[agentThreadKey(thread)];
    const confirmed = await confirmInApp(
      'Delete thread',
      `Delete “${thread.title}” from Sail? Its transcript and status are removed from Sail.${
        stillRunning ? ' The agent is still working, and deleting the thread does not stop it.' : ''
      }`,
      'Delete thread',
      { destructive: true },
    );
    if (confirmed) removeAgentThread(thread);
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
    if (thread.agent === 'opencode') {
      sidebarOpenCodeThreads = sidebarOpenCodeThreads.filter(
        (item) => threadKey(item) !== threadKey(thread),
      );
      // session/list keeps returning a deleted OpenCode session.
      removeSidebarThread(thread);
    }
    void acp.forget(thread.agent, thread.directory, thread.sessionId).catch(() => {});
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
    if (agent && thread) return `acp:${agent}:${thread.sessionId}`;
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
  }

  function threadIsViewed(key: string): boolean {
    return (
      document.hasFocus() &&
      leaves(paneLayout).some((pane) => pane.thread && threadKey(pane.thread) === key)
    );
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
        const handoffReceipt = handoffReceiptForInterruptedTurn(turn, spawnReceipts);
        const alreadyActive = async () => {
          const current = (await acp.activity(turn.directory))[turn.agent];
          return current?.activeTurns[turn.sessionId] === turn.turnId;
        };
        try {
          if (handoffReceipt) {
            const reconciled = await reconcileDurableAcpTurn(handoffReceipt, turn.sessionId);
            if (reconciled) await acp.finishInterruptedTurn(turn);
            return;
          }
          if (await alreadyActive()) {
            updateAgentThreadStatus(recoveredThread, 'working');
            return;
          }
          const info = await acp.connect(turn.agent, turn.directory);
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
          const recoveredProfile = recoveredThread.capabilityProfile ?? 'build';
          if (canResume)
            await acp.resume(turn.agent, turn.directory, turn.sessionId, recoveredProfile);
          else await acp.load(turn.agent, turn.directory, turn.sessionId, recoveredProfile);
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
          const recalledPrompt = await withAutomaticMemoryRecall({
            directory: turn.directory,
            prompt,
            query: turn.text,
            sessionKey: `acp:${turn.agent}:${turn.sessionId}`,
          });
          let queued = false;
          const continued = acp.prompt(
            turn.agent,
            turn.directory,
            turn.sessionId,
            recalledPrompt,
            turn.turnId,
            [],
            (limit) => {
              queued = limit !== null;
            },
            false,
          );
          void (async () => {
            try {
              const outcome = await continued;
              await acp.finishInterruptedTurn(turn);
              if (!disposed)
                updateAgentThreadStatus(
                  recoveredThread,
                  acpPromptInterrupted(outcome) ? 'interrupted' : 'done',
                  !acpPromptInterrupted(outcome),
                );
            } catch (cause) {
              if (!disposed) {
                if (await alreadyActive()) updateAgentThreadStatus(recoveredThread, 'working');
                else {
                  const interrupted = await acpFailedPromptInterrupted(
                    turn.agent,
                    turn.directory,
                    turn.sessionId,
                    turn.turnId,
                  );
                  updateAgentThreadStatus(recoveredThread, interrupted ? 'interrupted' : 'failed');
                  if (!interrupted)
                    error = `Could not continue ${recoveredThread.title}: ${describe(cause)}`;
                }
              }
            }
          })();
          await awaitCoordinationStart(
            continued,
            async () => {
              const state = (await acp.activity(turn.directory))[turn.agent];
              return !!state?.active.includes(turn.sessionId);
            },
            () => queued,
          );
        } catch (cause) {
          if (await alreadyActive()) updateAgentThreadStatus(recoveredThread, 'working');
          else {
            const interrupted = await acpFailedPromptInterrupted(
              turn.agent,
              turn.directory,
              turn.sessionId,
              turn.turnId,
            );
            updateAgentThreadStatus(recoveredThread, interrupted ? 'interrupted' : 'failed');
            if (!interrupted)
              error = `Could not continue ${recoveredThread.title}: ${describe(cause)}`;
          }
        }
      }),
    );
  }

  async function restoreAgentActivity(attempt = 0) {
    const revision = attentionRevision;
    try {
      const activityDirectories = [
        ...new Set([
          ...agentThreads.map((thread) => thread.directory),
          ...spawnReceipts.flatMap((item) => (item.targetDirectory ? [item.targetDirectory] : [])),
          directory,
        ]),
      ];
      const backendActivity: Record<string, AgentActivity> = {};
      await Promise.all(
        activityDirectories.map(async (path) => {
          const scoped = await acp.activity(path);
          for (const [agent, state] of Object.entries(scoped))
            backendActivity[JSON.stringify([path, agent])] = state;
        }),
      );
      if (disposed) return;
      for (const receipt of spawnReceipts.filter(
        (item) =>
          item.provider !== 'opencode' &&
          item.targetId &&
          item.turnId &&
          !receiptIsSettled(item.state),
      ))
        reconcileAcpSpawnReceipt(
          receipt,
          backendActivity[JSON.stringify([receipt.targetDirectory, receipt.provider])],
        );
      if (revision !== attentionRevision) {
        if (attempt < 2) await restoreAgentActivity(attempt + 1);
        return;
      }
      const previousAttention = threadAttention;
      threadAttention = reconcileAttention(
        threadAttention,
        agentThreads.map((thread) => ({
          agent: thread.agent,
          directory: thread.directory,
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
    const savedThread = agentThreads.find((item) => threadKey(item) === key);
    if (thread.agent !== 'opencode' && !savedThread) return;
    if (savedThread && thread.agent !== 'opencode') {
      const receiptUpdated = spawnReceipts
        .filter(
          (item) =>
            item.targetId === receiptSourceId(thread.agent, thread.sessionId) &&
            item.targetDirectory === thread.directory,
        )
        .reduce((latest, item) => Math.max(latest, item.updated), 0);
      saveAgentThread({
        ...savedThread,
        updated: Math.max(Date.now(), savedThread.updated + 1, receiptUpdated + 1),
      });
    }
    if (thread.agent === 'opencode')
      sidebarOpenCodeOutcomes = recordSidebarOpenCodeOutcome(
        sidebarOpenCodeOutcomes,
        thread,
        status,
      );
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
    if (notify) showThreadAttentionNotification(thread, status);
  }

  function showThreadAttentionNotification(thread: AgentThread, status: ThreadStatus) {
    if (!isTauri()) return;
    const children = activeSubagentsForSource(
      spawnReceipts,
      receiptSourceId(thread.agent, thread.sessionId),
      thread.directory,
    );
    notifications.enqueue({
      type: status === 'waiting' ? 'input' : 'completed',
      target: {
        type: 'thread',
        agentId: thread.agent,
        directory: thread.directory,
        sessionId: thread.sessionId,
      },
      title: thread.title,
      body:
        status === 'waiting'
          ? 'Needs your input'
          : children.some((child) => child.state === 'waiting')
            ? 'Subagent needs your input'
            : children.length
              ? 'Subagents are still active'
              : 'Completed',
    });
  }

  const notifications = createNotificationCoalescer({
    allow: (notification) =>
      notificationAllowed(notificationPrefs[notification.type], !document.hasFocus()),
    send: (notification) =>
      void invoke('show_attention_notification', {
        target: notification.target,
        title: notification.title,
        body: notification.body,
        sound: notificationSound,
      }).catch(() => undefined),
  });

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
    if (event.message.method === 'sail/disconnected' && !event.directory) {
      const sessionDirectories = event.message.params?.sessionDirectories;
      if (sessionDirectories && typeof sessionDirectories === 'object') {
        const groups = new SvelteMap<string, string[]>();
        for (const [sessionId, path] of Object.entries(sessionDirectories)) {
          if (typeof path !== 'string') continue;
          groups.set(path, [...(groups.get(path) ?? []), sessionId]);
        }
        for (const [path, sessionIds] of groups)
          handleAgentEvent({
            ...event,
            directory: path,
            message: { ...event.message, params: { ...event.message.params, sessionIds } },
          });
      }
      return;
    }
    const eventDirectory = event.directory ?? event.worktree;
    if (!eventDirectory) return;
    const eventSessionId = event.message.params?.sessionId;
    const eventThread =
      typeof eventSessionId === 'string'
        ? [...agentThreads, ...nativeChildThreads].find(
            (thread) =>
              thread.agent === event.agent &&
              thread.sessionId === eventSessionId &&
              thread.directory === eventDirectory,
          )
        : undefined;
    const eventProfile = capabilityProfileFromMetadata(
      event.message.params,
      eventThread?.capabilityProfile ?? 'build',
    );
    const previousNativeSubagents = nativeSubagents;
    nativeSubagents = updateNativeSubagents(
      nativeSubagents,
      event,
      eventDirectory,
      Date.now(),
      typeof eventSessionId === 'string' &&
        (!!replayingAgentSessions[JSON.stringify([event.agent, eventDirectory, eventSessionId])] ||
          !!nativeSubagents[nativeSubagentId(event.agent, eventDirectory, eventSessionId)]
            ?.restored),
      eventProfile,
    );
    if (nativeSubagents !== previousNativeSubagents) nativeSubagentGeneration += 1;
    const nativeUpdate = event.message.params?.update;
    if (
      event.message.method === 'session/update' &&
      typeof eventSessionId === 'string' &&
      nativeUpdate &&
      typeof nativeUpdate === 'object' &&
      'sessionUpdate' in nativeUpdate &&
      nativeUpdate.sessionUpdate === 'subagent_spawned' &&
      'subagentSessionId' in nativeUpdate &&
      typeof nativeUpdate.subagentSessionId === 'string' &&
      authorizeShipCheckpointThread(
        shipRuns,
        eventDirectory,
        `acp:${event.agent}:${eventSessionId}`,
        eventDirectory,
        `acp:${event.agent}:${nativeUpdate.subagentSessionId}`,
      )
    )
      void saveShipRuns().catch((cause) => (error = describe(cause)));
    if (event.message.method === 'sail/permission_resolved' && typeof eventSessionId === 'string')
      recordAnsweredPermission(event.agent, eventDirectory, eventSessionId, event.message.params);
    if (event.message.method === 'sail/permission_resolved' && typeof eventSessionId === 'string')
      nativeSubagents = setNativeSubagentWaiting(
        nativeSubagents,
        event.agent,
        eventDirectory,
        eventSessionId,
        false,
      );
    if (event.message.method === 'session/update') {
      const params = event.message.params;
      const sessionId = params?.sessionId;
      if (typeof sessionId === 'string') {
        const update = params?.update;
        if (update && typeof update === 'object') {
          const data = update as Record<string, unknown>;
          const thread = [...agentThreads, ...nativeChildThreads].find(
            (item) =>
              item.agent === event.agent &&
              item.sessionId === sessionId &&
              item.directory === eventDirectory,
          );
          const planDirectory = thread?.directory ?? eventDirectory;
          const priorPlan = loadNativePlan({
            agent: event.agent,
            directory: planDirectory,
            sessionId,
          });
          const plan = nativePlanUpdate(event.agent, data, priorPlan);
          if (plan)
            saveNativePlan({ agent: event.agent, directory: planDirectory, sessionId }, plan);
          if (replayingAgentSessions[JSON.stringify([event.agent, eventDirectory, sessionId])])
            invalidateLiveTranscript(event.agent, eventDirectory, sessionId);
          else if (tracksLiveTranscript(event.agent, eventDirectory, sessionId)) {
            applyLiveTranscriptUpdate(event.agent, eventDirectory, sessionId, data);
            acpPlans().observe({ agent: event.agent, directory: planDirectory, sessionId }, data);
          }
          if (data.sessionUpdate === 'config_option_update' && Array.isArray(data.configOptions))
            rememberSessionState(event.agent, eventDirectory, sessionId, {
              configOptions: data.configOptions as AgentConfigOption[],
            });
          if (
            data.sessionUpdate === 'available_commands_update' &&
            Array.isArray(data.availableCommands)
          )
            rememberSessionState(event.agent, eventDirectory, sessionId, {
              availableCommands: data.availableCommands as AgentCommand[],
            });
        }
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
        if (
          text &&
          !replayingAgentSessions[JSON.stringify([event.agent, eventDirectory, sessionId])]
        )
          for (const receipt of spawnReceipts.filter(
            (item) =>
              item.targetId === `acp:${event.agent}:${sessionId}` &&
              item.targetDirectory === eventDirectory &&
              item.targetDirectory === eventDirectory &&
              activeSpawnTargets.get(spawnTargetKey(eventDirectory, item.targetId)) ===
                item.receiptId &&
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
        if (
          toolTitle &&
          !replayingAgentSessions[JSON.stringify([event.agent, eventDirectory, sessionId])]
        )
          for (const receipt of spawnReceipts.filter(
            (item) =>
              item.targetId === `acp:${event.agent}:${sessionId}` &&
              item.targetDirectory === eventDirectory &&
              item.targetDirectory === eventDirectory &&
              activeSpawnTargets.get(spawnTargetKey(eventDirectory, item.targetId)) ===
                item.receiptId &&
              !receiptIsSettled(item.state),
          ))
            updateSpawnReceipt(receipt.receiptId, { activity: toolTitle });
        const usage = acpUsage(params?.update);
        const replaying =
          !!replayingAgentSessions[JSON.stringify([event.agent, eventDirectory, sessionId])];
        if (usage?.rates && !replaying) agentRates = { ...agentRates, [event.agent]: usage.rates };
        if (usage) {
          const nextUsage = { ...agentUsage };
          const matchingThreads = [...agentThreads, ...nativeChildThreads].filter(
            (item) =>
              item.agent === event.agent &&
              item.sessionId === sessionId &&
              item.directory === eventDirectory,
          );
          for (const thread of matchingThreads) {
            nextUsage[threadKey(thread)] = { context: usage.context };
          }
          agentUsage = nextUsage;
          const matchingThread = matchingThreads[0];
          if (matchingThread && !replaying)
            void recordShipContextPressure(
              matchingThread.directory,
              `acp:${event.agent}:${sessionId}`,
              usage.context,
            ).catch((cause) => (error = describe(cause)));
        }
        const updateKind =
          update && typeof update === 'object' && 'sessionUpdate' in update
            ? String(update.sessionUpdate)
            : '';
        if (!replaying && /compact|retry/i.test(updateKind)) {
          const matchingThread = [...agentThreads, ...nativeChildThreads].find(
            (item) =>
              item.agent === event.agent &&
              item.sessionId === sessionId &&
              item.directory === eventDirectory,
          );
          if (matchingThread)
            void recordShipContextEvent(
              matchingThread.directory,
              `acp:${event.agent}:${sessionId}`,
              `acp:${event.agent}:${sessionId}:${event.message.id ?? crypto.randomUUID()}`,
              /compact/i.test(updateKind) ? 'compaction' : 'retry',
            ).catch((cause) => (error = describe(cause)));
        }
      }
    }
    if (event.message.method === 'sail/permission_resolved' && typeof eventSessionId === 'string') {
      // The scheduled refresh lags; the thread header already shows the request answered.
      const resolvedKey = `acp:${eventDirectory}:${event.agent}:${eventSessionId}:${String(event.message.params?.requestId)}`;
      resolvedDuringRefresh.set(resolvedKey, inboxGeneration);
      if (inboxItems.some((item) => item.key === resolvedKey))
        inboxItems = inboxItems.filter((item) => item.key !== resolvedKey);
    }
    if (
      event.message.method === 'session/request_permission' ||
      event.message.method === 'elicitation/create' ||
      event.message.method === '$/cancel_request' ||
      event.message.method === 'sail/permission_resolved' ||
      event.message.method === 'sail/disconnected'
    )
      scheduleInboxRefresh();
    if (event.message.method === '$/cancel_request') {
      const requestID = event.message.params?.id;
      const sessionId = event.message.params?.sessionId;
      if (
        (typeof requestID === 'string' || typeof requestID === 'number') &&
        typeof sessionId === 'string'
      )
        removeStructuredQuestion(event.agent, eventDirectory, sessionId, requestID);
    }
    if (event.message.method === 'sail/prompt_finished') {
      const sessionId = event.message.params?.sessionId;
      const status = event.message.params?.status;
      const turnId = event.message.params?.turnId;
      if (
        typeof sessionId !== 'string' ||
        (status !== 'done' && status !== 'failed' && status !== 'interrupted')
      )
        return;
      if (
        status === 'done' &&
        typeof turnId === 'string' &&
        event.message.params?.notify !== false
      ) {
        const thread = agentThreads.find(
          (item) =>
            item.agent === event.agent &&
            item.sessionId === sessionId &&
            item.directory === eventDirectory,
        );
        if (thread)
          void runCompletedChecks(thread.directory, `acp:${event.agent}:${sessionId}`, turnId);
      }
      for (const thread of agentThreads.filter(
        (item) =>
          item.agent === event.agent &&
          item.sessionId === sessionId &&
          item.directory === eventDirectory,
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
          item.targetDirectory === eventDirectory &&
          item.turnId === turnId &&
          !receiptIsSettled(item.state),
      ))
        updateSpawnReceipt(receipt.receiptId, {
          state:
            status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : 'completed',
          result: spawnOutput.get(receipt.receiptId) ?? receipt.result,
          error:
            typeof event.message.params?.error === 'string'
              ? event.message.params.error
              : receipt.error,
        });
    } else if (event.message.method === 'session/request_permission') {
      const sessionId = event.message.params?.sessionId;
      if (typeof sessionId !== 'string') return;
      nativeSubagents = setNativeSubagentWaiting(
        nativeSubagents,
        event.agent,
        eventDirectory,
        sessionId,
        true,
      );
      for (const thread of agentThreads.filter(
        (item) =>
          item.agent === event.agent &&
          item.sessionId === sessionId &&
          item.directory === eventDirectory,
      ))
        updateAgentThreadStatus(thread, 'waiting');
      for (const receipt of spawnReceipts.filter(
        (item) =>
          item.targetId === `acp:${event.agent}:${sessionId}` &&
          item.targetDirectory === eventDirectory &&
          activeSpawnTargets.get(spawnTargetKey(eventDirectory, item.targetId)) ===
            item.receiptId &&
          !receiptIsSettled(item.state),
      ))
        updateSpawnReceipt(receipt.receiptId, { state: 'waiting' });
    } else if (event.message.method === 'sail/disconnected') {
      const disconnectedSessionIds =
        acpDisconnectedSessionIds(event.message) ??
        Object.values(nativeSubagents)
          .filter((child) => child.agent === event.agent && child.directory === eventDirectory)
          .map((child) => child.sessionId);
      for (const sessionId of disconnectedSessionIds)
        clearStructuredQuestions(event.agent, eventDirectory, sessionId);
      nativeSubagents = disconnectNativeSubagents(
        nativeSubagents,
        event.agent,
        eventDirectory,
        disconnectedSessionIds,
      );
      for (const thread of agentThreads.filter(
        (item) =>
          item.agent === event.agent &&
          item.directory === eventDirectory &&
          acpDisconnectAffectsSession(
            event.message,
            item.sessionId,
            item.capabilityProfile ?? 'build',
          ) &&
          ['working', 'waiting'].includes(threadAttention[threadKey(item)]?.status ?? ''),
      ))
        updateAgentThreadStatus(thread, 'failed');
      for (const receipt of spawnReceipts.filter((item) => {
        const prefix = `acp:${event.agent}:`;
        const sessionId = item.targetId?.startsWith(prefix)
          ? item.targetId.slice(prefix.length)
          : null;
        return (
          item.provider === event.agent &&
          item.targetDirectory === eventDirectory &&
          acpDisconnectAffectsSession(event.message, sessionId) &&
          !receiptIsSettled(item.state)
        );
      }))
        updateSpawnReceipt(receipt.receiptId, { state: 'unavailable' });
    }
  }

  function setAgentReplay(
    agent: AgentId,
    worktreeDirectory: string,
    sessionId: string | null,
    replaying: boolean,
  ) {
    if (!sessionId) return;
    const key = JSON.stringify([agent, worktreeDirectory, sessionId]);
    const next = { ...replayingAgentSessions };
    const count = (next[key] ?? 0) + (replaying ? 1 : -1);
    if (count > 0) next[key] = count;
    else delete next[key];
    replayingAgentSessions = next;
    if (!replaying && sessionId)
      nativeSubagents = finalizeNativeSubagentRestore(
        nativeSubagents,
        agent,
        worktreeDirectory,
        sessionId,
      );
  }

  function invalidatePaneSelection(id: string) {
    paneSelections.set(id, (paneSelections.get(id) ?? 0) + 1);
  }

  function newPlan() {
    openAgent('opencode');
  }

  function startThreadRename(thread: AgentThread) {
    editingThread = thread;
    editedTitle = thread.title;
    renameSessionDialog.showModal();
  }

  function renameAgentThread(thread: AgentThread, title: string) {
    const previous = agentThreads.find((item) => threadKey(item) === threadKey(thread));
    const renamed = mergeAgentThreadRename(previous, thread, title);
    saveAgentThread(renamed);
    sidebarOpenCodeThreads = sidebarOpenCodeThreads.map((item) =>
      threadKey(item) === threadKey(thread)
        ? Object.assign({}, item, { title, renamed: true })
        : item,
    );
    if (acpThread && threadKey(acpThread) === threadKey(thread))
      acpThread = { ...acpThread, title, renamed: true };
  }

  async function saveRename() {
    const title = editedTitle.trim();
    if (!title) {
      error = 'Enter a session title.';
      return;
    }
    if (editingThread) {
      renameAgentThread(editingThread, title);
      editingThread = null;
      renameSessionDialog.close();
    }
  }

  function selectDiffPath(path: string) {
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
    restoreSideScroll();
    if (window.matchMedia('(max-width: 850px)').matches) detailsArea?.focus();
  }

  function keydownWorkspace(event: KeyboardEvent) {
    if (shortcutMatches(event, 'sidebar.toggle')) {
      event.preventDefault();
      if (!event.repeat && !document.querySelector('dialog[open]')) toggleSidebar();
      return;
    }
    if (
      shortcutMatches(event, 'chat.side') &&
      !event.repeat &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      openSideChat();
      return;
    }
    if (shortcutMatches(event, 'attention.next')) {
      event.preventDefault();
      if (!event.repeat && !document.querySelector('dialog[open]')) void goToNextAttention();
      return;
    }
    for (const [id, go] of [
      ['subagent.parent', () => goToSubagentTarget(subagentNav?.parent)],
      ['subagent.previous', () => goToSubagentSibling(-1)],
      ['subagent.next', () => goToSubagentSibling(1)],
    ] as const) {
      if (
        shortcutMatches(event, id) &&
        subagentNav &&
        !terminalOwnsKey(event, event.target as Element | null)
      ) {
        event.preventDefault();
        if (!event.repeat && !document.querySelector('dialog[open]')) go();
        return;
      }
    }
    if (shortcutMatches(event, 'settings.open')) {
      event.preventDefault();
      if (!event.repeat) void openSettings();
      return;
    }
    if (shortcutMatches(event, 'threads.cycle') && !document.querySelector('dialog[open]')) {
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
    if (shortcutMatches(event, 'threads.jump') && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      recentCycleKeys = null;
      const key = availableRecentKeys()[Number(event.key) - 1];
      if (key) void jumpToRecentThread(key);
      return;
    }
    if (shortcutMatches(event, 'palette.open') && !event.repeat) {
      event.preventDefault();
      openCommandPalette();
      return;
    }
    if (shortcutMatches(event, 'shortcuts.help')) {
      event.preventDefault();
      if (!event.repeat) openShortcutSheet();
      return;
    }
    if (shortcutMatches(event, 'worktree.close')) {
      event.preventDefault();
      if (!event.repeat && !document.querySelector('dialog[open]')) closeCurrentWorktree();
      return;
    }
    if (shortcutMatches(event, 'worktree.new')) {
      event.preventDefault();
      const repository = directory ? coordinationProject(directory) : null;
      if (repository && !event.repeat && !document.querySelector('dialog[open]'))
        paletteWorktreeRequest = { id: crypto.randomUUID(), path: repository, fromPalette: false };
      return;
    }
    if (shortcutMatches(event, 'pane.close')) {
      event.preventDefault();
      if (!event.repeat && !document.querySelector('dialog[open]')) closeCurrentPane();
      return;
    }
    if (
      shortcutMatches(event, 'terminal.split') &&
      !event.repeat &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      splitFocusedPane('row', 'terminal');
      return;
    }
    if (
      shortcutMatches(event, 'pane.split') &&
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
      event.repeat ||
      !shortcutMatches(event, 'details.toggle') ||
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
      void tick().then(() => sidebarToggleElement?.focus());
  }

  function showTaskOverview() {
    workspaceView = 'overview';
    mobileView = 'chat';
    setSetting('sai-workspace-view', workspaceView);
  }

  function showShipQueue() {
    workspaceView = 'ship-queue';
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
    if (detectShippingClockResume()) void tickShippingRuns();
    for (const pane of leaves(paneLayout)) if (pane.thread) markThreadRead(pane.thread);
    if (acpAgent && agentChangesOpen && activeSideTab === 'changes') void refreshAgentDiff();
  }

  function describe(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    if (typeof cause === 'object' && cause && 'message' in cause) return String(cause.message);
    return String(cause);
  }
</script>

<svelte:head><title>Sail · Plan workspace</title></svelte:head>
<svelte:window
  onkeydown={keydownWorkspace}
  onkeyup={(event) => {
    keyupWorkspace(event);
    copySelection();
  }}
  onpointerup={copySelection}
  onblur={() => (recentCycleKeys = null)}
  onfocus={focusWorkspace}
  onfocusin={cancelPendingPromptFocus}
/>
<div
  class="app-shell"
  data-mobile-view={mobileView}
  data-sidebar-visible={sidebarVisible}
  data-details-visible={mainDetailsVisible || shipFallbackVisible}
  data-sidebar-rail={sidebarRail}
  style={`--topbar-height: ${topbarHeight}px; --details-width: ${visibleDetailsWidth}px; --sidebar-width: ${visibleSidebarWidth}px`}
  bind:this={appShellElement}
>
  <aside
    id="project-sidebar"
    class="sidebar"
    aria-label="Projects"
    tabindex="-1"
    bind:this={sidebarElement}
  >
    <div class="brand"><span class="brand-mark">S.</span><span class="brand-name">Sail</span></div>
    <div class="sidebar-content">
      <ProjectSidebar
        compact={sidebarRail}
        catalog={projectCatalog}
        {directory}
        disabled={!agentAvailability.some((agent) => agent.available)}
        agents={agentAvailability}
        threads={sidebarThreads}
        attention={threadAttention}
        openCodeOutcomes={sidebarOpenCodeOutcomes}
        spawnReceipts={navigableReceipts}
        {acpActivityReady}
        selectedThread={focusedThreadKey()}
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
        onselectthread={(key) => void selectSidebarThread(key)}
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
    </div>
    {#if sidebarVisible && !mobileLayout}<div
        class="sidebar-resizer"
        role="slider"
        tabindex="0"
        aria-label="Sidebar width"
        aria-orientation="horizontal"
        aria-controls="project-sidebar"
        aria-valuemin={sidebarRailWidth}
        aria-valuemax={maxSidebarWidth}
        aria-valuenow={visibleSidebarWidth}
        aria-valuetext={sidebarRail
          ? 'Sidebar collapsed to icons'
          : `Sidebar ${visibleSidebarWidth} pixels wide`}
        onpointerdown={startSidebarResize}
        onpointermove={moveSidebarResize}
        onpointerup={endSidebarResize}
        onpointercancel={endSidebarResize}
        onkeydown={keydownSidebarResize}
        ondblclick={() => setSidebarWidth(sidebarRail ? sidebarDefaultWidth : sidebarRailWidth)}
      ></div>{/if}
  </aside>
  <div class="main-area">
    <AppTopbar
      bind:element={topbarElement}
      bind:sidebarToggle={sidebarToggleElement}
      sidebarExpanded={sidebarVisible && (!mobileLayout || mobileView === 'sessions')}
      ontogglesidebar={toggleSidebar}
      {mobileView}
      onmobileview={(view) => void showMobileView(view)}
      overview={workspaceView === 'overview'}
      onoverview={() => (workspaceView === 'overview' ? showWorkspace() : showTaskOverview())}
      shipQueue={workspaceView === 'ship-queue'}
      onshipqueue={() => (workspaceView === 'ship-queue' ? showWorkspace() : showShipQueue())}
      projectName={directory ? locationName(directory) : 'Workspace'}
      projectDisabled={!agentAvailability.some((agent) => agent.available)}
      onchooseproject={() => void chooseProject()}
      conversationTitle={focusedConversationTitle}
      inboxCount={attentionCounts.inbox}
      oninbox={openInbox}
      onpalette={openCommandPalette}
      {directory}
      agents={agentAvailability}
      onopenagent={(agent) => openAgent(agent)}
      planDisabled={!agentAvailability.some((agent) => agent.id === 'opencode' && agent.available)}
      onnewplan={newPlan}
      onswitchthread={() =>
        reopenCommandPalette({
          kind: 'agents',
          repository: selectedRepository(projectCatalog, directory) ?? directory,
          directory,
        })}
      threadActions={actionAgentThread
        ? {
            kind: 'agent',
            title: actionAgentThread.title,
            onrename: () => actionAgentThread && startThreadRename(actionAgentThread),
            ondelete: () => actionAgentThread && void deleteAgentThread(actionAgentThread),
          }
        : null}
      browserAccess={!browserAccessDisabled}
      ontogglebrowser={toggleAgentBrowserAccess}
      memoryRecall={memoryRecallEnabled}
      {memoryRecallAvailable}
      {memoryRecallBusy}
      ontogglememoryrecall={() => void toggleAutomaticMemoryRecall()}
      memoryCapture={memoryCaptureEnabled}
      {memoryCaptureAvailable}
      {memoryCaptureBusy}
      ontogglememorycapture={() => void toggleAutomaticMemoryCapture()}
      onrunproject={selectedWorktreeConfig?.run
        ? () => splitFocusedPane('row', 'terminal', selectedWorktreeConfig?.run)
        : null}
      agentTerminalCount={agentTerminals.length}
      onagentterminals={() => agentTerminalsDialog.showModal()}
      onrestore={directory && focusedSnapshotThread() ? () => void openSnapshots() : null}
      oncommands={openCommandsDialog}
      changesLabel={acpAgent ? 'Changes' : 'Details'}
      changesTitle={acpAgent ? 'Toggle Changes (⌘L)' : 'Toggle details (⌘L)'}
      changesExpanded={focusedPane !== 'main'
        ? changesPanes.includes(focusedPane)
        : acpAgent
          ? agentChangesOpen
          : detailsOpen && (mainShipFallback || activeSideTab === 'ship')}
      ontogglechanges={() => void toggleChanges()}
      subagentNav={subagentNav
        ? {
            parentTitle: subagentParentTitle,
            position: `${subagentNav.index + 1} of ${subagentNav.siblings.length}`,
            hasPrevious: !!subagentNav.previous,
            hasNext: !!subagentNav.next,
          }
        : null}
      onsubagentparent={() => goToSubagentTarget(subagentNav?.parent)}
      onsubagentsibling={goToSubagentSibling}
    />
    {#if $settingsError}<p class="notice error" role="alert">{$settingsError}</p>{/if}
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
                {subagentControl}
                childPrompts={acpThread
                  ? nativeSubagentAcceptsPrompts(
                      nativeSubagents[
                        nativeSubagentId(acpThread.agent, acpThread.directory, acpThread.sessionId)
                      ],
                    )
                  : false}
                nativeEntries={acpThread
                  ? nativeSubagents[
                      nativeSubagentId(acpThread.agent, acpThread.directory, acpThread.sessionId)
                    ]?.transcript
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
                onnativeplan={(plan) => {
                  nativePlan = plan;
                  if (!plan) {
                    nativePlanFeedback = '';
                    nativePlanRevision = null;
                    nativePlanRevisionPending = false;
                    nativePlanRevisionError = '';
                  }
                }}
                planRevision={nativePlanRevision ?? undefined}
                onplanrevisionresult={finishNativePlanRevision}
                onworkspaceactivity={updateMainAgentWorkspaceActivity}
                ondecision={(thread, permission, optionId) =>
                  recordDecisionActivity(
                    thread,
                    acpPermissionActivitySourceId(
                      permission.id,
                      permission.generation,
                      permission.fingerprint,
                    ),
                    permission.policy
                      ? permissionDecisionTitle(
                          permission.title,
                          permission.policy,
                          permissionOutcome(permission.options, optionId),
                        )
                      : permission.title,
                    permissionOutcome(permission.options, optionId),
                  )}
                capabilityProfile={capabilityProfileForShipThread(
                  directory,
                  acpThread ? receiptSourceId(acpThread.agent, acpThread.sessionId) : undefined,
                )}
                running={!!(acpThread && runningAgentThreads[agentThreadKey(acpThread)])}
                activityReady={acpActivityReady}
                focused={focusedPane === 'main'}
                oncreated={createAgentThread}
                onactivity={saveAgentActivity}
                onstatus={updateAgentThreadStatus}
                onreplaychange={setAgentReplay}
                onterminal={(id) => void openAgentTerminal(id)}
                onshipit={adoptDirectShipRunWithAuthorization}
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
            <div class="chat-body">
              <div class="conversation">
                <div class="welcome">
                  <div class="welcome-mark">◇</div>
                  <p class="eyebrow">START WORK</p>
                  <h1>What are we working on?</h1>
                  <p>
                    {agentAvailability.some((agent) => agent.available)
                      ? 'Choose an available agent to start in this repository.'
                      : 'No agent is available. Install one or choose its binary in settings.'}
                  </p>
                  {#if !directory}<Button onclick={() => chooseProject()}>Select repository</Button
                    >{:else}<div class="welcome-agents">
                      {#each agentAvailability.filter((agent) => agent.available) as agent (agent.id)}<Button
                          variant="secondary"
                          onclick={() => openAgent(agent.id)}
                          >Start with <HarnessIcon agent={agent.id} /> {agent.name}</Button
                        >{/each}
                    </div>{/if}
                </div>
              </div>
            </div>
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
    {#if workspaceView === 'ship-queue'}
      <ShipQueue
        runs={shipRuns}
        busy={shippingBusy}
        {mergeOwner}
        archiveNotice={shipArchiveNotice}
        onrefresh={() => tickShippingRuns(true)}
        onopen={openShipQueueIssue}
        onaction={runShipAction}
        ondismissnotice={dismissShipArchiveNotice}
        onsettings={openSettings}
        onclose={showWorkspace}
      />
    {/if}
    <div class="workspace-pane-host" hidden={workspaceView !== 'workspace'}>
      <PaneTree
        active={workspaceView === 'workspace'}
        pane={paneLayout}
        focused={focusedPane}
        {directory}
        project={coordinationProject(directory) ?? directory}
        {taskLocation}
        capabilityProfileForThread={(thread) =>
          capabilityProfileForShipThread(
            directory,
            thread ? receiptSourceId(thread.agent, thread.sessionId) : undefined,
          )}
        {dark}
        agents={agentAvailability}
        {sideChat}
        {coordinationMessages}
        spawnReceipts={visibleSpawnReceipts}
        onopensubagent={openSpawnTarget}
        {subagentControl}
        {shipRuns}
        shipNeedsInput={attentionCounts.shipTab}
        {shippingBusy}
        {mergeOwner}
        nativeSubagents={Object.values(nativeSubagents)}
        onshiprefresh={() => tickShippingRuns(true)}
        onshipopen={openShipTarget}
        onshipsettings={openSettings}
        onshiphandoff={handoffShipIssue}
        onshipaction={runShipAction}
        ondismissshipnotice={dismissShipArchiveNotice}
        {shipArchiveNotice}
        onship={(graph, provider, limit, source) =>
          startShippingRun(graph, provider, limit, source)}
        onshipit={adoptDirectShipRunWithAuthorization}
        postTurnChecks={postTurnResults}
        onretrycheck={(check) => void runOnePostTurnCheck(check, true)}
        {agentUsage}
        {agentRates}
        onentries={(id, entries, sessionId, ready) =>
          (agentEntrySnapshots = { ...agentEntrySnapshots, [id]: { entries, sessionId, ready } })}
        {changesPanes}
        dockDetails={!mainDetailsVisible && !shipFallbackVisible && !mobileLayout}
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
        onsendplan={sendPlanMessage}
        onrevealplan={revealPlanPane}
        onbatchcomplete={completeAgentBatch}
        onpickedconsumed={markPickConsumed}
        onattachmentsent={assignReviewCaptures}
        onshortcut={keydownWorkspace}
        onactivity={saveAgentActivity}
        activityEvents={currentActivityHistory}
        activityLoading={inboxLoading}
        activityError={inboxError}
        onactivityrefresh={() => void refreshInbox()}
        onactivityselect={selectActivityHistory}
        onactivityopen={showActivitySource}
        ondecision={recordDecisionActivity}
        focusPromptPane={promptFocusPane}
        onpromptfocused={() => (promptFocusPane = null)}
        running={(thread) => !!(thread && runningAgentThreads[agentThreadKey(thread)])}
        activityReady={acpActivityReady}
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
        {mergeOwner}
        nativeSubagents={Object.values(nativeSubagents)}
        onclose={closeShipRuns}
        focusRequest={shipFocusRequest}
        onrefresh={() => tickShippingRuns(true)}
        onopen={openShipTarget}
        onhandoff={handoffShipIssue}
        onaction={runShipAction}
        ondismissnotice={dismissShipArchiveNotice}
        archiveNotice={shipArchiveNotice}
        onsettings={async () => {
          closeShipRuns();
          await openSettings();
        }}
      />
    </section>{/if}
  {#if !mainShipFallback && (acpAgent || activeSideTab === 'ship')}<div
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
      <div class="side-tabs" role="tablist" aria-label="Session detail tabs">
        {#if showPlanPanel && acpAgent}<button
            class:active={activeSideTab === 'plan'}
            role="tab"
            aria-selected={activeSideTab === 'plan'}
            onclick={() => switchSideTab('plan')}>Plan</button
          >{/if}{#if acpAgent}<button
            class:active={activeSideTab === 'changes'}
            role="tab"
            aria-selected={activeSideTab === 'changes'}
            onclick={toggleChanges}>Changes ({diffs.length})</button
          >{/if}{#if acpAgent && acpPlanHistory.length}<button
            class:active={activeSideTab === 'planhistory'}
            aria-current={activeSideTab === 'planhistory' ? 'page' : undefined}
            onclick={() => switchSideTab('planhistory')}>Plan history</button
          >{/if}{#if acpAgent}<button
            class:active={activeSideTab === 'history'}
            role="tab"
            aria-selected={activeSideTab === 'history'}
            onclick={() => switchSideTab('history')}>Activity</button
          >{/if}<button
          class:active={activeSideTab === 'ship'}
          role="tab"
          aria-selected={activeSideTab === 'ship'}
          aria-label={`Ship runs, ${attentionCounts.shipTab} need input`}
          onclick={() => switchSideTab('ship')}>Ship runs ({attentionCounts.shipTab})</button
        >
      </div>
      <div class="side-panel-body">
        {#if showPlanPanel}<div class:inactive={activeSideTab !== 'plan'} class="side-view">
            {#if acpAgent && (acpSnapshot.plan || acpSnapshot.questions)}<PlanPanel
                snapshot={acpSnapshot}
                backend={mainPlanBackend}
                {directory}
                sessionID={acpThread?.sessionId ?? null}
                {dark}
                onchanged={async () => {
                  acpPlanTick += 1;
                }}
                onselectfile={selectDiffPath}
                shipRun={shipRuns.find(
                  (run) =>
                    run.repository === (coordinationProject(directory) ?? directory) &&
                    run.source === acpSnapshot.plan?.sessionID,
                ) ?? null}
                onship={(graph, provider, limit) =>
                  startShippingRun(graph, provider, limit, acpSnapshot.plan?.sessionID ?? '')}
              />{:else if acpAgent && nativePlan}<section
                class="native-plan-panel"
                aria-label="Native plan"
              >
                <Markdown source={nativePlan.markdown} />
                {#if nativePlan.tasks.length}<ul>
                    {#each nativePlan.tasks as task (`${task.status}:${task.title}`)}<li>
                        {task.status}: {task.title}
                      </li>{/each}
                  </ul>{/if}
                <div class="native-plan-revision">
                  <label for="native-plan-feedback">Revision feedback</label>
                  <textarea
                    id="native-plan-feedback"
                    bind:value={nativePlanFeedback}
                    rows="3"
                    placeholder="Describe what should change in this plan"
                    disabled={nativePlanRevisionPending}></textarea>
                  {#if nativePlanRevisionError}<p role="alert">{nativePlanRevisionError}</p>{/if}
                  {#if nativePlanRevisionError}<Button
                      size="sm"
                      variant="secondary"
                      onclick={requestNativePlanRevision}
                      disabled={nativePlanRevisionPending}
                      loading={nativePlanRevisionPending}>Retry revision</Button
                    >{:else}<Button
                      size="sm"
                      variant="secondary"
                      onclick={requestNativePlanRevision}
                      disabled={nativePlanRevisionPending}
                      loading={nativePlanRevisionPending}>Request revision</Button
                    >{/if}
                </div>
              </section>{/if}
          </div>{/if}
        {#if acpAgent}<div class:inactive={activeSideTab !== 'changes'} class="side-view">
            <DiffPanel
              {directory}
              files={diffs}
              annotations={diffAnnotations}
              selected={selectedFilePath}
              loading={diffLoading}
              error={diffError}
              onselect={(file) => (selectedFilePath = file)}
              onrefresh={() => refreshAgentDiff()}
              onclose={toggleChanges}
              scope={diffCommentKey('main')}
              comments={diffComments[diffCommentKey('main')] ?? []}
              oncomments={updateDiffComments}
              oncommentssent={removeSentDiffComments}
              onsendcomments={(scope, text) => sendDiffComments('main', scope, text)}
              evidence={reviewEvidence(
                'main',
                acpAgent && acpThread ? `acp:${acpAgent}:${acpThread.sessionId}` : null,
              )}
            />
          </div>{/if}
        {#if acpAgent && acpPlanHistory.length}<div
            class:inactive={activeSideTab !== 'planhistory'}
            class="side-view"
          >
            <PlanHistoryPanel
              events={acpPlanHistory}
              loading={false}
              error=""
              onrefresh={() => (acpPlanTick += 1)}
            />
          </div>{/if}
        {#if acpAgent}<div class:inactive={activeSideTab !== 'history'} class="side-view">
            <WorkspaceActivity
              items={mainAgentWorkspaceActivity}
              events={currentActivityHistory}
              agent={acpAgent}
              sessionId={acpThread?.sessionId}
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
            {mergeOwner}
            nativeSubagents={Object.values(nativeSubagents)}
            onclose={closeShipRuns}
            focusRequest={shipFocusRequest}
            onrefresh={() => tickShippingRuns(true)}
            onopen={openShipTarget}
            onhandoff={handoffShipIssue}
            onaction={runShipAction}
            ondismissnotice={dismissShipArchiveNotice}
            archiveNotice={shipArchiveNotice}
            onsettings={async () => {
              closeShipRuns();
              await openSettings();
            }}
          />
        </div>
      </div>
    </section>{/if}
  <AgentStatusBar
    items={agentStatusItems}
    attentionCount={statusBarAttentionCount(
      attentionCounts.statusBar,
      agentStatusItems,
      threadRequestKeys(sessionAttention),
    )}
    onopen={(key) => jumpToRecentThread(key)}
  />
</div>
<ConfirmDialog request={confirmation} onanswer={answerConfirmation} />
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
      role="combobox"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      aria-expanded={paletteEntries.length > 0}
      aria-controls={paletteEntries.length ? 'palette-listbox' : undefined}
      aria-activedescendant={paletteEntries.length && paletteEntries[paletteIndex]
        ? `palette-option-${paletteIndex}`
        : undefined}
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
    {#if paletteEntries.length}<div id="palette-listbox" role="listbox" aria-label="Results">
        {#each paletteEntries as entry, index (entry.id)}
          <button
            class="palette-entry"
            id={`palette-option-${index}`}
            role="option"
            tabindex="-1"
            aria-selected={index === paletteIndex}
            data-kind={entry.kind}
            class:active={index === paletteIndex}
            aria-current={index === paletteIndex ? 'true' : undefined}
            disabled={entry.disabled || paletteBusy}
            aria-keyshortcuts={entry.shortcut ? ariaKeyShortcutsFor(entry.shortcut) : undefined}
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
                          : entry.kind === 'action'
                            ? entry.shortcut
                              ? shortcutLabel(shortcutFor(entry.shortcut), shortcutPlatform)
                              : 'Action'
                            : 'Session'}</span
            >
          </button>
        {/each}
      </div>{:else}
      <div class="palette-empty">
        <p>{paletteLoading ? 'Loading sessions…' : `No matches for “${paletteQuery}”.`}</p>
        {#if paletteStep.kind === 'projects' && !projectCatalog.repositories.length}<button
            onclick={() => {
              closeCommandPalette(false);
              void chooseProject();
            }}>Add repository…</button
          >{/if}
      </div>
    {/if}
    {#if paletteLoading && paletteEntries.length}<p class="palette-status" role="status">
        Loading sessions…
      </p>{/if}
    {#if paletteError}<p class="palette-error" role="alert">{paletteError}</p>{/if}
  </div>
</dialog>
<dialog
  class="commands-dialog shortcuts-dialog"
  bind:this={shortcutsDialog}
  aria-labelledby="shortcuts-title"
>
  <div class="commands-header">
    <h2 id="shortcuts-title">Keyboard shortcuts</h2>
    <button aria-label="Close keyboard shortcuts" onclick={() => shortcutsDialog.close()}>×</button>
  </div>
  <dl class="shortcuts-list">
    {#each shortcutRegistry as shortcut (shortcut.id)}
      <div class="shortcuts-row" data-shortcut-id={shortcut.id}>
        <dt>{shortcut.label}</dt>
        <dd><kbd>{shortcutLabel(shortcut, shortcutPlatform)}</kbd></dd>
      </div>
    {/each}
  </dl>
</dialog>
<div
  class="copy-status"
  role="status"
  aria-live="polite"
  aria-atomic="true"
  bind:this={copyStatusRegion}
>
  {#if copiedStatus}<span>{copiedStatus}</span>{/if}
</div>
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
    items={liveInboxItems}
    attention={stateAttentionItems}
    total={attentionCounts.inbox}
    loading={inboxLoading}
    error={inboxError}
    onopen={(item) => void openInboxItem(item)}
    onopenattention={(item) => {
      inboxDialog.close();
      void openAttentionItem(item);
    }}
    ondismiss={dismissAttentionItem}
    onsnooze={snoozeAttentionItem}
    ondecide={decideInbox}
  />
</dialog>
