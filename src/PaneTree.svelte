<script lang="ts">
  import type { Snippet } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import type { WorkingDiffInfo } from './lib/diff';
  import PaneTree from './PaneTree.svelte';
  import AgentWorkspace from './AgentWorkspace.svelte';
  import DiffPanel from './DiffPanel.svelte';
  import PlanPanel from './PlanPanel.svelte';
  import PlanHistoryPanel from './PlanHistoryPanel.svelte';
  import WorkspaceActivity from './WorkspaceActivity.svelte';
  import ShipPanel from './ShipPanel.svelte';
  import type { ShipActionId } from './lib/ship-actions';
  import EmptyPanePicker from './EmptyPanePicker.svelte';
  import HarnessIcon from './HarnessIcon.svelte';
  import TerminalPane from './TerminalPane.svelte';
  import AgentTerminalPane from './AgentTerminalPane.svelte';
  import BrowserPane from './BrowserPane.svelte';
  import SideChat from './SideChat.svelte';
  import type { AgentThread, AgentAvailability, AgentEntry } from './lib/acp';
  import { acpPermissionActivitySourceId } from './lib/acp-permissions';
  import type { OpenCodeClient } from './lib/opencode';
  import type { SetupReport } from './lib/onboarding';
  import type { BrowserAttachment } from './lib/browser-pick';
  import type { DiffComment } from './lib/diff-comments';
  import { coordinationKey, type CoordinationMessage } from './lib/coordination';
  import { spawnReceiptsForSource, type SpawnReceipt } from './lib/agent-results';
  import type { SubagentControl } from './lib/subagent-control';
  import type { ThreadStatus } from './lib/attention';
  import type { PostTurnCheck } from './lib/post-turn-checks';
  import type { ReviewCapture, ReviewPreview } from './lib/review-evidence';
  import type { AgentUsage, RateWindow } from './lib/agent-usage';
  import type { PublishedGraph } from './lib/issue-graph';
  import type {
    DirectShipAuthorization,
    MergeOwner,
    ShipIssue,
    ShipRun,
  } from './lib/issue-shipping';
  import type { ActivityHistoryEvent } from './lib/activity-history';
  import type { WorkspaceActivityItem } from './lib/workspace-activity';
  import type { ShipItIssue } from './lib/implementation-models';
  import type { TaskLocation } from './lib/task-location';
  import {
    permissionDecisionTitle,
    permissionOutcome,
    type CapabilityProfile,
  } from './lib/capability-profiles';
  import type { NativeSubagent } from './lib/native-subagents';
  import { threadKey } from './lib/recent-threads';
  import type { PlanSnapshot } from './lib/plan';
  import { acpPlanBackend, acpPlans, planKey, type PlanScope } from './lib/acp-plans';
  import { annotateDiffs } from './lib/diff';
  import {
    clampPaneRatio,
    paneRatioBounds,
    type BrowserTab,
    type Pane,
    type SideChat as SideChatState,
  } from './lib/panes';

  type Props = {
    active: boolean;
    pane: Pane;
    focused: string;
    directory: string;
    project: string;
    taskLocation: TaskLocation;
    capabilityProfile: CapabilityProfile;
    onensureprofile: (directory: string, profile: CapabilityProfile) => Promise<() => void>;
    dark: boolean;
    agents: AgentAvailability[];
    sideChat: SideChatState | null;
    client: OpenCodeClient | null;
    runtimeState: 'starting' | 'connected' | 'error';
    setup: SetupReport | null;
    coordinationMessages: CoordinationMessage[];
    spawnReceipts: SpawnReceipt[];
    onopensubagent: (receipt: SpawnReceipt) => Promise<void>;
    subagentControl?: SubagentControl;
    shipRuns: ShipRun[];
    shipNeedsInput: number;
    shippingBusy: boolean;
    mergeOwner?: MergeOwner;
    nativeSubagents: NativeSubagent[];
    onshiprefresh: () => Promise<void>;
    onshipopen: (path: string, threadId?: string | null) => Promise<void>;
    onshipsettings: () => Promise<void>;
    onshiphandoff: (run: ShipRun, issue: ShipIssue) => Promise<void>;
    onshipaction: (id: ShipActionId, run: ShipRun, issue: ShipIssue | null) => Promise<string>;
    ondismissshipnotice: () => void;
    shipArchiveNotice?: number;
    onship: (
      graph: PublishedGraph,
      provider: ShipRun['provider'],
      limit: number,
      source: string,
    ) => Promise<void>;
    onshipit: (
      issue: ShipItIssue,
      directory: string,
      threadId: string,
      workerModel?: string,
      requireClaim?: boolean,
    ) => Promise<DirectShipAuthorization | undefined>;
    postTurnChecks: PostTurnCheck[];
    onretrycheck: (check: PostTurnCheck) => void;
    agentUsage: Record<string, AgentUsage>;
    agentRates: Record<string, RateWindow[]>;
    onentries: (
      id: string,
      entries: AgentEntry[],
      sessionId: string | null,
      ready: boolean,
    ) => void;
    changesPanes: string[];
    dockDetails: boolean;
    main: Snippet;
    mainPicker: boolean;
    canClose: boolean;
    onfocus: (id: string) => void;
    onclose: (id: string) => void;
    onratio: (id: string, ratio: number) => void;
    oncreated: (id: string, thread: AgentThread) => void;
    onchooseagent: (id: string, agent: string) => void;
    onchooseterminal: (id: string) => void;
    onchoosebrowser: (id: string) => void;
    onbrowserstate: (id: string, tabs: BrowserTab[], activeTab: string) => void;
    onbrowserpick: (id: string, attachment: BrowserAttachment) => void;
    pickedAttachments: Record<string, BrowserAttachment>;
    onpickedconsumed: (id: string) => void;
    onattachmentsent: (ids: string[], thread: string, turn: string) => void;
    diffComments: Record<string, DiffComment[]>;
    ondiffcomments: (scope: string, comments: DiffComment[]) => void;
    ondiffcommentssent: (scope: string, ids: string[]) => void;
    onsenddiffcomments: (id: string, scope: string, text: string) => Promise<void>;
    pendingAgentBatches: Record<string, { id: string; text: string; leavePlanMode?: boolean }>;
    onsendplan: (id: string, text: string, options: { leavePlanMode: boolean }) => Promise<void>;
    onrevealplan: (id: string) => void;
    onbatchcomplete: (id: string, failure: string | null) => void;
    onshortcut: (event: KeyboardEvent) => void;
    onactivity: (thread: AgentThread) => void;
    onhistorychange: () => void;
    activityEvents: ActivityHistoryEvent[];
    activityLoading: boolean;
    activityError: string;
    onactivityrefresh: () => void;
    onactivityselect: (event: ActivityHistoryEvent) => void | Promise<void>;
    onactivityopen: () => void;
    ondecision: (thread: AgentThread, id: string, title: string, outcome: string) => void;
    onusage: (sessionID: string, context: number | undefined) => void;
    focusPromptPane: string | null;
    onpromptfocused: () => void;
    running: (thread: AgentThread | null) => boolean;
    activityReady: boolean;
    onstatus: (thread: AgentThread, status: ThreadStatus, notifyOnDone?: boolean) => void;
    onreplaychange: (agent: string, sessionId: string | null, replaying: boolean) => void;
    onchanges: (id: string) => void;
    pendingCommands: Record<string, string>;
    oncommandstarted: (id: string) => void;
    onterminalexit: (id: string, code: number) => void;
    onterminalownerlost: (id: string) => void;
    onagentterminal: (id: string) => void;
    reviewCaptures: ReviewCapture[];
    reviewPreviews: ReviewPreview[];
    onreviewcheck: (check: PostTurnCheck) => void;
    onreviewpreview: (preview: ReviewPreview) => void;
    onreviewcapturephase: (id: string, phase: ReviewCapture['phase']) => void;
  };

  let {
    active,
    pane,
    focused,
    directory,
    project,
    taskLocation,
    capabilityProfile,
    onensureprofile,
    dark,
    agents,
    sideChat,
    client,
    runtimeState,
    setup,
    coordinationMessages,
    spawnReceipts,
    onopensubagent,
    subagentControl,
    shipRuns,
    shipNeedsInput,
    shippingBusy,
    mergeOwner = 'you',
    nativeSubagents,
    onshiprefresh,
    onshipopen,
    onshipsettings,
    onshiphandoff,
    onshipaction,
    ondismissshipnotice,
    shipArchiveNotice = 0,
    onship,
    onshipit,
    postTurnChecks,
    onretrycheck,
    agentUsage,
    agentRates,
    onentries,
    changesPanes,
    dockDetails,
    main,
    mainPicker,
    canClose,
    onfocus,
    onclose,
    onratio,
    oncreated,
    onchooseagent,
    onchooseterminal,
    onchoosebrowser,
    onbrowserstate,
    onbrowserpick,
    pickedAttachments,
    onpickedconsumed,
    onattachmentsent,
    diffComments,
    ondiffcomments,
    ondiffcommentssent,
    onsenddiffcomments,
    pendingAgentBatches,
    onsendplan,
    onrevealplan,
    onbatchcomplete,
    onshortcut,
    onactivity,
    onhistorychange,
    activityEvents,
    activityLoading,
    activityError,
    onactivityrefresh,
    onactivityselect,
    onactivityopen,
    ondecision,
    onusage,
    focusPromptPane,
    onpromptfocused,
    running,
    activityReady,
    onstatus,
    onreplaychange,
    onchanges,
    pendingCommands,
    oncommandstarted,
    onterminalexit,
    onterminalownerlost,
    onagentterminal,
    reviewCaptures,
    reviewPreviews,
    onreviewcheck,
    onreviewpreview,
    onreviewcapturephase,
  }: Props = $props();
  let container = $state<HTMLDivElement>();
  let splitWidth = $state(0);
  let splitHeight = $state(0);
  let dragging = false;
  let previewRatio = $state<number | null>(null);
  const splitSpan = $derived(
    'direction' in pane ? (pane.direction === 'row' ? splitWidth : splitHeight) : 0,
  );
  const ratioBounds = $derived(paneRatioBounds(splitSpan));
  const visibleRatio = $derived(
    clampPaneRatio(previewRatio ?? ('direction' in pane ? pane.ratio : 0.5), splitSpan),
  );
  let diffs = $state<WorkingDiffInfo[]>([]);
  let diffLoading = $state(false);
  let diffError = $state('');
  let selectedFile = $state<string | null>(null);
  let diffGeneration = 0;
  let diffRevision = '';
  let diffRevisionPath = '';
  let diffEvidenceUpdated = $state(Date.now());
  let acpTab = $state<'plan' | 'history' | 'changes' | 'activity' | 'ship'>('changes');
  let acpPlanTick = $state(0);
  let planRevealed = false;
  const emptySnapshot: PlanSnapshot = { plan: null, questions: null };
  const acpScope = $derived.by((): PlanScope | null => {
    if ('direction' in pane || !pane.agent || !pane.thread) return null;
    return { agent: pane.agent, directory, sessionId: pane.thread.sessionId };
  });
  const acpSnapshot = $derived.by(() => {
    void acpPlanTick;
    return acpScope ? acpPlans().snapshot(acpScope) : emptySnapshot;
  });
  const acpPlanHistory = $derived.by(() => {
    void acpPlanTick;
    return acpScope ? acpPlans().history(acpScope) : [];
  });
  const acpBackend = $derived(
    acpScope && 'id' in pane
      ? acpPlanBackend(acpPlans(), acpScope, {
          send: (text, options) => onsendplan(pane.id, text, options),
        })
      : null,
  );
  let paneActivityItems = $state<WorkspaceActivityItem[]>([]);
  let selectPaneActivity = $state<(item: WorkspaceActivityItem) => Promise<void>>(async () => {
    throw new Error('The activity source is unavailable.');
  });
  let previousAcpOpen = false;

  function updatePaneActivity(
    items: WorkspaceActivityItem[],
    onselect: (item: WorkspaceActivityItem) => Promise<void>,
  ) {
    paneActivityItems = items;
    selectPaneActivity = onselect;
  }

  async function selectPaneActivitySource(item: WorkspaceActivityItem) {
    await selectPaneActivity(item);
    onactivityopen();
  }

  function paneOwnsActivity(event: ActivityHistoryEvent): boolean {
    return (
      !('direction' in pane) &&
      !!pane.agent &&
      !!pane.thread &&
      event.workspace === directory &&
      event.agent === pane.agent &&
      event.sessionId === pane.thread.sessionId
    );
  }

  function paneOwnsChild(event: ActivityHistoryEvent): boolean {
    if ('direction' in pane || !pane.agent || !pane.thread || event.kind !== 'subagent')
      return false;
    const source = `acp:${pane.agent}:${pane.thread.sessionId}`;
    return spawnReceiptsForSource(spawnReceipts, source, directory).some(
      (receipt) => receipt.receiptId === event.sourceId,
    );
  }

  async function selectPaneActivityHistory(event: ActivityHistoryEvent) {
    if (event.kind === 'parent' && paneOwnsActivity(event)) {
      onfocus(pane.id);
      onactivityopen();
      return;
    }
    const kind = event.kind === 'subagent' ? 'child' : event.kind;
    if (kind !== 'parent' && (paneOwnsActivity(event) || paneOwnsChild(event))) {
      await selectPaneActivity({
        id: event.id,
        sourceId: event.sourceId,
        kind,
        section: 'recent',
        title: event.title,
        detail: event.source,
        status: event.outcome,
        updated: event.at,
      });
      onactivityopen();
      return;
    }
    await onactivityselect(event);
  }

  function reviewEvidence(thread: string | null) {
    const checks = thread ? postTurnChecks.filter((check) => check.thread === thread) : [];
    const captures = reviewCaptures.filter(
      (capture) =>
        capture.paneId === pane.id && (capture.thread === null || capture.thread === thread),
    );
    return {
      checks,
      captures,
      previews: reviewPreviews,
      filesUpdated: diffEvidenceUpdated,
      updated: Math.max(
        diffEvidenceUpdated,
        ...checks.map((check) => check.updated),
        ...captures.map((capture) => capture.created),
      ),
      oncheck: onreviewcheck,
      onpreview: onreviewpreview,
      oncapturephase: onreviewcapturephase,
    };
  }

  function closeAcpDetails() {
    if (changesPanes.includes(pane.id)) onchanges(pane.id);
  }

  function closeShipOnEscape(event: KeyboardEvent) {
    if (
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      'direction' in pane ||
      pane.id !== focused ||
      !pane.agent ||
      !changesPanes.includes(pane.id) ||
      acpTab !== 'ship' ||
      document.querySelector('dialog[open]')
    )
      return;
    event.preventDefault();
    closeAcpDetails();
  }

  $effect(() => {
    if ('direction' in pane || !pane.agent) return;
    const open = changesPanes.includes(pane.id);
    if (open && !previousAcpOpen) acpTab = planRevealed ? 'plan' : 'changes';
    planRevealed = false;
    previousAcpOpen = open;
  });

  $effect(() => {
    const scope = acpScope;
    if (!scope || !('id' in pane)) return;
    const paneId = pane.id;
    const revealing = new Set(['proposed', 'questions', 'amended', 'checkpoint', 'done']);
    return acpPlans().subscribe((change) => {
      if (planKey(change.scope) !== planKey(scope)) return;
      acpPlanTick += 1;
      if (!revealing.has(change.reason)) return;
      planRevealed = true;
      acpTab = 'plan';
      onrevealplan(paneId);
    });
  });

  async function refreshDiff(quiet = false) {
    const current = ++diffGeneration;
    const path = directory;
    try {
      const revision = await invoke<string>('working_tree_revision', { path });
      if (current !== diffGeneration || path !== directory) return;
      if (quiet && diffRevisionPath === path && diffRevision === revision) return;
      diffLoading = true;
      const files = await invoke<WorkingDiffInfo[]>('working_tree_diff', { path });
      if (current !== diffGeneration || path !== directory) return;
      diffRevisionPath = path;
      diffRevision = revision;
      diffEvidenceUpdated = Date.now();
      diffs = files;
      selectedFile =
        files.find((file) => file.file === selectedFile)?.file ?? files[0]?.file ?? null;
      diffError = '';
    } catch (cause) {
      if (current === diffGeneration) diffError = String(cause);
    } finally {
      if (current === diffGeneration) diffLoading = false;
    }
  }

  $effect(() => {
    if ('direction' in pane || pane.id === 'main') return;
    if (!changesPanes.includes(pane.id) || acpTab !== 'changes') return;
    void refreshDiff();
    const timer = setInterval(() => void refreshDiff(true), 5000);
    return () => clearInterval(timer);
  });

  function ratioFromPointer(event: PointerEvent) {
    const bounds = container!.getBoundingClientRect();
    const span =
      pane && 'direction' in pane && pane.direction === 'row' ? bounds.width : bounds.height;
    const offset =
      pane && 'direction' in pane && pane.direction === 'row'
        ? event.clientX - bounds.left
        : event.clientY - bounds.top;
    return clampPaneRatio(offset / span, span);
  }

  function resizeKey(event: KeyboardEvent) {
    if (!('direction' in pane)) return;
    const step = event.shiftKey ? 0.1 : 0.02;
    const change =
      pane.direction === 'row'
        ? event.key === 'ArrowRight'
          ? step
          : event.key === 'ArrowLeft'
            ? -step
            : 0
        : event.key === 'ArrowDown'
          ? step
          : event.key === 'ArrowUp'
            ? -step
            : 0;
    if (!change) return;
    event.preventDefault();
    onratio(pane.id, clampPaneRatio(visibleRatio + change, splitSpan));
  }
</script>

<svelte:window onkeydown={closeShipOnEscape} />

{#if 'direction' in pane}
  <div
    class="pane-split"
    class:row={pane.direction === 'row'}
    class:column={pane.direction === 'column'}
    style={`--pane-ratio: ${visibleRatio * 100}%`}
    bind:this={container}
    bind:clientWidth={splitWidth}
    bind:clientHeight={splitHeight}
  >
    <PaneTree
      {active}
      {coordinationMessages}
      {spawnReceipts}
      {onopensubagent}
      {subagentControl}
      {shipRuns}
      {shipNeedsInput}
      {shippingBusy}
      {mergeOwner}
      {nativeSubagents}
      {onshiprefresh}
      {onshipopen}
      {onshipsettings}
      {onshiphandoff}
      {onshipaction}
      {ondismissshipnotice}
      {shipArchiveNotice}
      {onship}
      {onshipit}
      {postTurnChecks}
      {onretrycheck}
      {agentUsage}
      {agentRates}
      pane={pane.first}
      {focused}
      {directory}
      {project}
      {taskLocation}
      {dark}
      {agents}
      {sideChat}
      {client}
      {runtimeState}
      {setup}
      {onentries}
      {changesPanes}
      {dockDetails}
      {main}
      {mainPicker}
      {canClose}
      {onfocus}
      {onclose}
      {onratio}
      {oncreated}
      {onchooseagent}
      {onchooseterminal}
      {onchoosebrowser}
      {onbrowserstate}
      {onbrowserpick}
      {pickedAttachments}
      {onpickedconsumed}
      {onattachmentsent}
      {diffComments}
      {ondiffcomments}
      {ondiffcommentssent}
      {onsenddiffcomments}
      {pendingAgentBatches}
      {onsendplan}
      {onrevealplan}
      {onbatchcomplete}
      {onshortcut}
      {onactivity}
      {onhistorychange}
      {activityEvents}
      {activityLoading}
      {activityError}
      {onactivityrefresh}
      {onactivityselect}
      {onactivityopen}
      {ondecision}
      {onusage}
      {focusPromptPane}
      {onpromptfocused}
      {running}
      {activityReady}
      {onstatus}
      {onreplaychange}
      {onchanges}
      {pendingCommands}
      {oncommandstarted}
      {onterminalexit}
      {onterminalownerlost}
      {onagentterminal}
      {reviewCaptures}
      {reviewPreviews}
      {onreviewcheck}
      {onreviewpreview}
      {onreviewcapturephase}
      {capabilityProfile}
      {onensureprofile}
    />
    <div
      class="pane-divider"
      role="slider"
      tabindex="0"
      aria-label="Split pane divider"
      aria-orientation={pane.direction === 'row' ? 'vertical' : 'horizontal'}
      aria-valuemin={Math.round(ratioBounds.min * 100)}
      aria-valuemax={Math.round(ratioBounds.max * 100)}
      aria-valuenow={Math.round(visibleRatio * 100)}
      onpointerdown={(event) => {
        if (event.button !== 0) return;
        dragging = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onpointermove={(event) => {
        if (dragging) previewRatio = ratioFromPointer(event);
      }}
      onpointerup={() => {
        dragging = false;
        if (previewRatio !== null) onratio(pane.id, previewRatio);
        previewRatio = null;
      }}
      onpointercancel={() => {
        dragging = false;
        previewRatio = null;
      }}
      onkeydown={resizeKey}
    ></div>
    <PaneTree
      {active}
      {coordinationMessages}
      {spawnReceipts}
      {onopensubagent}
      {subagentControl}
      {shipRuns}
      {shipNeedsInput}
      {shippingBusy}
      {mergeOwner}
      {nativeSubagents}
      {onshiprefresh}
      {onshipopen}
      {onshipsettings}
      {onshiphandoff}
      {onshipaction}
      {ondismissshipnotice}
      {shipArchiveNotice}
      {onship}
      {onshipit}
      {postTurnChecks}
      {onretrycheck}
      {agentUsage}
      {agentRates}
      pane={pane.second}
      {focused}
      {directory}
      {project}
      {taskLocation}
      {dark}
      {agents}
      {sideChat}
      {client}
      {runtimeState}
      {setup}
      {onentries}
      {changesPanes}
      {dockDetails}
      {main}
      {mainPicker}
      {canClose}
      {onfocus}
      {onclose}
      {onratio}
      {oncreated}
      {onchooseagent}
      {onchooseterminal}
      {onchoosebrowser}
      {onbrowserstate}
      {onbrowserpick}
      {pickedAttachments}
      {onpickedconsumed}
      {onattachmentsent}
      {diffComments}
      {ondiffcomments}
      {ondiffcommentssent}
      {onsenddiffcomments}
      {pendingAgentBatches}
      {onsendplan}
      {onrevealplan}
      {onbatchcomplete}
      {onshortcut}
      {onactivity}
      {onhistorychange}
      {activityEvents}
      {activityLoading}
      {activityError}
      {onactivityrefresh}
      {onactivityselect}
      {onactivityopen}
      {ondecision}
      {onusage}
      {focusPromptPane}
      {onpromptfocused}
      {running}
      {activityReady}
      {onstatus}
      {onreplaychange}
      {onchanges}
      {pendingCommands}
      {oncommandstarted}
      {onterminalexit}
      {onterminalownerlost}
      {onagentterminal}
      {reviewCaptures}
      {reviewPreviews}
      {onreviewcheck}
      {onreviewpreview}
      {onreviewcapturephase}
      {capabilityProfile}
      {onensureprofile}
    />
  </div>
{:else}
  <div class="pane-leaf-frame" class:side-open={sideChat?.parentId === pane.id}>
    <section
      class="pane-leaf"
      class:focused={focused === pane.id}
      data-pane-id={pane.id}
      aria-keyshortcuts="Meta+Alt+ArrowLeft Meta+Alt+ArrowRight Meta+Alt+ArrowUp Meta+Alt+ArrowDown F6 Shift+F6"
      aria-label={pane.kind === 'terminal'
        ? 'Terminal pane'
        : pane.kind === 'agent-terminal'
          ? 'Agent terminal pane'
          : pane.kind === 'browser'
            ? 'Browser pane'
            : pane.id === 'main'
              ? 'Main pane'
              : pane.agent
                ? `${pane.agent} pane`
                : 'Empty pane'}
      tabindex="-1"
      onfocusin={() => onfocus(pane.id)}
      onpointerdown={(event) => {
        onfocus(pane.id);
        if (
          (pane.id === 'main' && !mainPicker) ||
          pane.agent ||
          pane.kind === 'terminal' ||
          pane.kind === 'agent-terminal' ||
          pane.kind === 'browser' ||
          !(event.target instanceof Element)
        )
          return;
        if (event.target.closest('button, input, textarea, select')) return;
        (
          event.currentTarget.querySelector<HTMLButtonElement>(
            '[data-agent-choice]:not(:disabled), [data-pane-picker]',
          ) ?? event.currentTarget
        ).focus();
      }}
    >
      {#if pane.id !== 'main'}
        <div class="pane-heading">
          {#if pane.agent}<HarnessIcon agent={pane.agent} size={14} />{/if}
          <span
            >{pane.kind === 'terminal'
              ? pane.owner
                ? `Terminal · ${pane.owner}`
                : 'Terminal'
              : pane.kind === 'agent-terminal'
                ? 'Agent terminal'
                : pane.kind === 'browser'
                  ? 'Browser'
                  : (pane.thread?.title ??
                    (pane.agent ? `New ${pane.agent} thread` : 'Empty pane'))}</span
          ><small>⌘⌥ + arrow to switch</small><button
            aria-label="Close pane"
            onclick={() => onclose(pane.id)}>×</button
          >
        </div>
      {:else if canClose}
        <div class="pane-heading">
          {#if pane.agent}<HarnessIcon agent={pane.agent} size={14} />{/if}
          <span
            >{pane.kind === 'terminal'
              ? pane.owner
                ? `Terminal · ${pane.owner}`
                : 'Terminal'
              : pane.kind === 'browser'
                ? 'Browser'
                : 'Main thread'}</span
          ><small>⌘⌥ + arrow to switch</small><button
            aria-label="Close main pane"
            onclick={() => onclose(pane.id)}>×</button
          >
        </div>
      {/if}
      {#if pane.id === 'main' && !mainPicker && !pane.kind}
        {@render main()}
      {:else if pane.kind === 'terminal'}
        {#key `${directory}:${pane.id}`}
          <TerminalPane
            id={pane.id}
            {directory}
            {dark}
            focused={focused === pane.id}
            {onshortcut}
            command={pendingCommands[pane.id]}
            {oncommandstarted}
            onexit={onterminalexit}
            owner={pane.owner}
            onownerlost={onterminalownerlost}
          />
        {/key}
      {:else if pane.kind === 'agent-terminal'}
        <AgentTerminalPane id={pane.terminalId} {dark} />
      {:else if pane.kind === 'browser'}
        {#key `${directory}:${pane.id}`}
          <BrowserPane
            {active}
            {pane}
            {directory}
            onstate={(tabs, activeTab) => onbrowserstate(pane.id, tabs, activeTab)}
            onpick={(attachment) => onbrowserpick(pane.id, attachment)}
            onfocus={() => onfocus(pane.id)}
            {onshortcut}
          />
        {/key}
      {:else if pane.agent}
        {#key `${directory}:${pane.id}:${pane.agent}`}
          <div class="pane-agent-content" class:changes-open={changesPanes.includes(pane.id)}>
            <AgentWorkspace
              agent={pane.agent}
              agentName={agents.find((agent) => agent.id === pane.agent)?.name ?? pane.agent}
              {directory}
              {taskLocation}
              thread={pane.thread}
              usage={pane.thread
                ? { ...agentUsage[threadKey(pane.thread)], rates: agentRates[pane.thread.agent] }
                : undefined}
              coordinationMessages={coordinationMessages.filter(
                (message) =>
                  pane.thread &&
                  message.target ===
                    coordinationKey(directory, `acp:${pane.agent}:${pane.thread.sessionId}`),
              )}
              spawnReceipts={spawnReceiptsForSource(
                spawnReceipts,
                pane.thread ? `acp:${pane.agent}:${pane.thread.sessionId}` : null,
                directory,
              )}
              {onopensubagent}
              {subagentControl}
              postTurnChecks={postTurnChecks.filter(
                (check) =>
                  pane.thread &&
                  check.directory === directory &&
                  check.thread === `acp:${pane.agent}:${pane.thread.sessionId}`,
              )}
              {onretrycheck}
              running={running(pane.thread)}
              {activityReady}
              focused={focused === pane.id}
              focusPrompt={focusPromptPane === pane.id}
              picked={pickedAttachments[pane.id]}
              externalPrompt={pendingAgentBatches[pane.id]}
              onexternalresult={onbatchcomplete}
              {onpickedconsumed}
              {onattachmentsent}
              {onpromptfocused}
              onentrieschange={(entries, sessionId, ready) =>
                onentries(pane.id, entries, sessionId, ready)}
              onworkspaceactivity={updatePaneActivity}
              oncreated={(thread) => oncreated(pane.id, thread)}
              {onactivity}
              ondecision={(thread, permission, optionId) =>
                ondecision(
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
              {capabilityProfile}
              {onstatus}
              {onreplaychange}
              onterminal={onagentterminal}
              {onshipit}
            />
            {#if changesPanes.includes(pane.id)}
              <section class="native-details side-area" aria-label="Agent details">
                <nav class="side-tabs" aria-label="Agent detail tabs">
                  <div class="side-tabs-list" role="tablist" aria-label="Agent details">
                    {#if acpSnapshot.plan || acpSnapshot.questions}<button
                        class:active={acpTab === 'plan'}
                        role="tab"
                        aria-selected={acpTab === 'plan'}
                        onclick={() => (acpTab = 'plan')}>Plan</button
                      >{/if}<button
                      class:active={acpTab === 'changes'}
                      role="tab"
                      aria-selected={acpTab === 'changes'}
                      onclick={() => (acpTab = 'changes')}>Changes ({diffs.length})</button
                    >{#if acpPlanHistory.length}<button
                        class:active={acpTab === 'history'}
                        role="tab"
                        aria-selected={acpTab === 'history'}
                        onclick={() => (acpTab = 'history')}>Plan history</button
                      >{/if}<button
                      class:active={acpTab === 'activity'}
                      role="tab"
                      aria-selected={acpTab === 'activity'}
                      onclick={() => (acpTab = 'activity')}>Activity</button
                    ><button
                      data-detail-tab="ship"
                      class:active={acpTab === 'ship'}
                      role="tab"
                      aria-selected={acpTab === 'ship'}
                      aria-label={`Ship runs, ${shipNeedsInput} need input`}
                      onclick={() => (acpTab = 'ship')}>Ship runs ({shipNeedsInput})</button
                    >
                  </div>
                  <button
                    class="side-tabs-close"
                    aria-label="Close agent details"
                    onclick={closeAcpDetails}>×</button
                  >
                </nav>
                {#if acpTab === 'plan' && (acpSnapshot.plan || acpSnapshot.questions)}
                  <PlanPanel
                    snapshot={acpSnapshot}
                    backend={acpBackend}
                    {directory}
                    sessionID={pane.thread?.sessionId ?? null}
                    {dark}
                    onchanged={async () => {
                      acpPlanTick += 1;
                    }}
                    shipRun={shipRuns.find(
                      (run) =>
                        run.source === acpSnapshot.plan?.sessionID && run.repository === project,
                    ) ?? null}
                    onship={(graph, provider, limit) =>
                      onship(graph, provider, limit, acpSnapshot.plan?.sessionID ?? '')}
                    onselectfile={(file) => {
                      selectedFile = file;
                      acpTab = 'changes';
                    }}
                  />
                {:else if acpTab === 'history'}
                  <PlanHistoryPanel
                    events={acpPlanHistory}
                    session={undefined}
                    loading={false}
                    error=""
                    onrefresh={() => (acpPlanTick += 1)}
                  />
                {:else if acpTab === 'ship'}
                  <ShipPanel
                    repository={project}
                    runs={shipRuns}
                    busy={shippingBusy}
                    {mergeOwner}
                    {nativeSubagents}
                    onclose={closeAcpDetails}
                    onrefresh={onshiprefresh}
                    onopen={async (path, threadId) => {
                      await onshipopen(path, threadId);
                      closeAcpDetails();
                    }}
                    onsettings={onshipsettings}
                    onhandoff={onshiphandoff}
                    onaction={onshipaction}
                    ondismissnotice={ondismissshipnotice}
                    archiveNotice={shipArchiveNotice}
                  />
                {:else if acpTab === 'activity'}
                  <WorkspaceActivity
                    items={paneActivityItems}
                    events={activityEvents}
                    agent={pane.agent}
                    sessionId={pane.thread?.sessionId}
                    loading={activityLoading}
                    error={activityError}
                    onrefresh={onactivityrefresh}
                    onselect={selectPaneActivitySource}
                    onselecthistory={selectPaneActivityHistory}
                  />
                {:else}
                  <DiffPanel
                    {directory}
                    files={diffs}
                    annotations={annotateDiffs(diffs, acpSnapshot.plan, directory)}
                    selected={selectedFile}
                    loading={diffLoading}
                    error={diffError}
                    onselect={(file) => (selectedFile = file)}
                    onrefresh={refreshDiff}
                    onclose={closeAcpDetails}
                    scope={`${directory}\0${pane.id}\0acp:${pane.agent}:${pane.thread?.sessionId ?? 'new'}`}
                    comments={diffComments[
                      `${directory}\0${pane.id}\0acp:${pane.agent}:${pane.thread?.sessionId ?? 'new'}`
                    ] ?? []}
                    oncomments={ondiffcomments}
                    oncommentssent={ondiffcommentssent}
                    onsendcomments={(scope, text) => onsenddiffcomments(pane.id, scope, text)}
                    evidence={reviewEvidence(
                      pane.thread ? `acp:${pane.agent}:${pane.thread.sessionId}` : null,
                    )}
                  />
                {/if}
              </section>
            {/if}
          </div>
        {/key}
      {:else}
        <EmptyPanePicker
          {agents}
          focused={focused === pane.id}
          onselect={(agent) => onchooseagent(pane.id, agent)}
          onterminal={() => onchooseterminal(pane.id)}
          onbrowser={() => onchoosebrowser(pane.id)}
        />
      {/if}
    </section>
    {#if sideChat?.parentId === pane.id}
      {#key sideChat.id}
        <section
          class="pane-leaf side-chat-leaf"
          class:focused={focused === sideChat.id}
          data-pane-id={sideChat.id}
          aria-label="Side chat pane"
          tabindex="-1"
          onfocusin={() => onfocus(sideChat.id)}
        >
          <div class="pane-heading">
            <span>Side chat</span><small>⌘⌥ + arrow to switch</small><button
              aria-label="Close pane"
              onclick={() => onclose(sideChat.id)}>×</button
            >
          </div>
          <SideChat
            source={sideChat.source}
            {client}
            {directory}
            {taskLocation}
            focused={focused === sideChat.id}
            focusPrompt={focusPromptPane === sideChat.id}
            {onpromptfocused}
            {onensureprofile}
          />
        </section>
      {/key}
    {/if}
  </div>
{/if}
