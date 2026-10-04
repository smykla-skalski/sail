<script lang="ts">
  import type { Snippet } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import type { WorkingDiffInfo } from './lib/diff';
  import PaneTree from './PaneTree.svelte';
  import AgentWorkspace from './AgentWorkspace.svelte';
  import OpenCodePane from './OpenCodePane.svelte';
  import DiffPanel from './DiffPanel.svelte';
  import PlanPanel from './PlanPanel.svelte';
  import HistoryPanel from './HistoryPanel.svelte';
  import EmptyPanePicker from './EmptyPanePicker.svelte';
  import HarnessIcon from './HarnessIcon.svelte';
  import TerminalPane from './TerminalPane.svelte';
  import AgentTerminalPane from './AgentTerminalPane.svelte';
  import BrowserPane from './BrowserPane.svelte';
  import SideChat from './SideChat.svelte';
  import type { AgentThread, AgentAvailability, AgentEntry } from './lib/acp';
  import type { OpenCodeClient, SessionInfo } from './lib/opencode';
  import type { SetupReport } from './lib/onboarding';
  import type { BrowserAttachment } from './lib/browser-pick';
  import type { DiffComment } from './lib/diff-comments';
  import { coordinationKey, type CoordinationMessage } from './lib/coordination';
  import { spawnReceiptsForSource, type SpawnReceipt } from './lib/agent-results';
  import type { ThreadStatus } from './lib/attention';
  import type { PostTurnCheck } from './lib/post-turn-checks';
  import type { AgentUsage, RateWindow } from './lib/agent-usage';
  import type { PublishedGraph } from './lib/issue-graph';
  import type { ShipRun } from './lib/issue-shipping';
  import { threadKey } from './lib/recent-threads';
  import { getPlan, getHistory, type PlanSnapshot, type HistoryEntry } from './lib/plan';
  import { annotateDiffs } from './lib/diff';
  import {
    clampPaneRatio,
    paneRatioBounds,
    type BrowserTab,
    type Pane,
    type SideChat as SideChatState,
  } from './lib/panes';

  type Props = {
    pane: Pane;
    focused: string;
    directory: string;
    project: string;
    dark: boolean;
    agents: AgentAvailability[];
    sideChat: SideChatState | null;
    client: OpenCodeClient | null;
    setup: SetupReport | null;
    coordinationMessages: CoordinationMessage[];
    spawnReceipts: SpawnReceipt[];
    shipRuns: ShipRun[];
    onship: (
      graph: PublishedGraph,
      provider: ShipRun['provider'],
      limit: number,
      source: string,
    ) => Promise<void>;
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
    diffComments: Record<string, DiffComment[]>;
    ondiffcomments: (scope: string, comments: DiffComment[]) => void;
    ondiffcommentssent: (scope: string, ids: string[]) => void;
    onsenddiffcomments: (id: string, scope: string, text: string) => Promise<void>;
    pendingAgentBatches: Record<string, { id: string; text: string }>;
    onbatchcomplete: (id: string, failure: string | null) => void;
    onshortcut: (event: KeyboardEvent) => void;
    onactivity: (thread: AgentThread) => void;
    onusage: (sessionID: string, context: number | undefined) => void;
    focusPromptPane: string | null;
    onpromptfocused: () => void;
    running: (thread: AgentThread | null) => boolean;
    onstatus: (thread: AgentThread, status: ThreadStatus, notifyOnDone?: boolean) => void;
    onreplaychange: (agent: string, sessionId: string | null, replaying: boolean) => void;
    onchanges: (id: string) => void;
    pendingCommands: Record<string, string>;
    oncommandstarted: (id: string) => void;
    onterminalexit: (id: string, code: number) => void;
    onterminalownerlost: (id: string) => void;
    onagentterminal: (id: string) => void;
  };

  let {
    pane,
    focused,
    directory,
    project,
    dark,
    agents,
    sideChat,
    client,
    setup,
    coordinationMessages,
    spawnReceipts,
    shipRuns,
    onship,
    postTurnChecks,
    onretrycheck,
    agentUsage,
    agentRates,
    onentries,
    changesPanes,
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
    diffComments,
    ondiffcomments,
    ondiffcommentssent,
    onsenddiffcomments,
    pendingAgentBatches,
    onbatchcomplete,
    onshortcut,
    onactivity,
    onusage,
    focusPromptPane,
    onpromptfocused,
    running,
    onstatus,
    onreplaychange,
    onchanges,
    pendingCommands,
    oncommandstarted,
    onterminalexit,
    onterminalownerlost,
    onagentterminal,
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
  let nativeSnapshot = $state<PlanSnapshot>({ plan: null, questions: null });
  let nativeHistory = $state<HistoryEntry[]>([]);
  let nativeSession = $state<SessionInfo>();
  let nativeHistoryError = $state('');
  let nativeDetailsOpen = $state(false);
  let nativeTab = $state<'plan' | 'changes' | 'history'>('changes');
  let nativeDetailsGeneration = 0;
  const nativeDetailsVisible = $derived(nativeDetailsOpen || changesPanes.includes(pane.id));
  let previousChangesOpen = false;

  async function refreshNativeDetails() {
    if (!client || 'direction' in pane || !pane.thread || pane.agent !== 'opencode') return;
    const id = pane.thread.sessionId;
    const path = directory;
    const generation = ++nativeDetailsGeneration;
    if (setup?.rpc.state !== 'ready') {
      nativeSnapshot = { plan: null, questions: null };
      nativeHistory = [];
      nativeHistoryError = 'Install the plan-review plugin to record plan history.';
      return;
    }
    const [plan, history, session] = await Promise.allSettled([
      getPlan(client, path, id),
      getHistory(client, path, id),
      client.session.get({ sessionID: id }),
    ]);
    if (
      generation !== nativeDetailsGeneration ||
      path !== directory ||
      'direction' in pane ||
      id !== pane.thread?.sessionId
    )
      return;
    if (plan.status === 'fulfilled') {
      nativeSnapshot = plan.value;
      if ((plan.value.plan || plan.value.questions) && !nativeDetailsOpen) {
        nativeDetailsOpen = true;
        nativeTab = 'plan';
      }
    } else nativeHistoryError = String(plan.reason);
    if (history.status === 'fulfilled') {
      nativeHistory = history.value;
      nativeHistoryError = '';
    } else nativeHistoryError = String(history.reason);
    if (session.status === 'fulfilled') nativeSession = session.value;
  }

  $effect(() => {
    if ('direction' in pane) return;
    ++nativeDetailsGeneration;
    nativeSnapshot = { plan: null, questions: null };
    nativeHistory = [];
    nativeSession = undefined;
    nativeDetailsOpen = false;
    nativeTab = 'changes';
    const id = pane.thread?.sessionId;
    const source = client;
    const rpc = setup?.rpc.state;
    if (pane.agent !== 'opencode' || !id || !source || !rpc) return;
    void refreshNativeDetails();
  });

  $effect(() => {
    if ('direction' in pane || pane.agent !== 'opencode') return;
    const changesOpen = changesPanes.includes(pane.id);
    if (changesOpen === previousChangesOpen) return;
    previousChangesOpen = changesOpen;
    nativeDetailsOpen = changesOpen;
    if (changesOpen) nativeTab = 'changes';
  });

  $effect(() => {
    if ('direction' in pane || pane.agent !== 'opencode' || !pane.thread || !client) return;
    const source = client;
    const id = pane.thread.sessionId;
    const path = directory;
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of source.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) return;
          if (
            event.type === 'rpc.planreview.changed' &&
            event.location?.directory === path &&
            id === pane.thread?.sessionId
          )
            void refreshNativeDetails();
        }
      } catch {
        return;
      }
    })();
    return () => controller.abort();
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
    if (
      pane.agent === 'opencode'
        ? !nativeDetailsVisible || nativeTab !== 'changes'
        : !changesPanes.includes(pane.id)
    )
      return;
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
      {coordinationMessages}
      {spawnReceipts}
      {shipRuns}
      {onship}
      {postTurnChecks}
      {onretrycheck}
      {agentUsage}
      {agentRates}
      pane={pane.first}
      {focused}
      {directory}
      {project}
      {dark}
      {agents}
      {sideChat}
      {client}
      {setup}
      {onentries}
      {changesPanes}
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
      {diffComments}
      {ondiffcomments}
      {ondiffcommentssent}
      {onsenddiffcomments}
      {pendingAgentBatches}
      {onbatchcomplete}
      {onshortcut}
      {onactivity}
      {onusage}
      {focusPromptPane}
      {onpromptfocused}
      {running}
      {onstatus}
      {onreplaychange}
      {onchanges}
      {pendingCommands}
      {oncommandstarted}
      {onterminalexit}
      {onterminalownerlost}
      {onagentterminal}
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
      {coordinationMessages}
      {spawnReceipts}
      {shipRuns}
      {onship}
      {postTurnChecks}
      {onretrycheck}
      {agentUsage}
      {agentRates}
      pane={pane.second}
      {focused}
      {directory}
      {project}
      {dark}
      {agents}
      {sideChat}
      {client}
      {setup}
      {onentries}
      {changesPanes}
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
      {diffComments}
      {ondiffcomments}
      {ondiffcommentssent}
      {onsenddiffcomments}
      {pendingAgentBatches}
      {onbatchcomplete}
      {onshortcut}
      {onactivity}
      {onusage}
      {focusPromptPane}
      {onpromptfocused}
      {running}
      {onstatus}
      {onreplaychange}
      {onchanges}
      {pendingCommands}
      {oncommandstarted}
      {onterminalexit}
      {onterminalownerlost}
      {onagentterminal}
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
            {pane}
            {directory}
            onstate={(tabs, activeTab) => onbrowserstate(pane.id, tabs, activeTab)}
            onpick={(attachment) => onbrowserpick(pane.id, attachment)}
            onfocus={() => onfocus(pane.id)}
            {onshortcut}
          />
        {/key}
      {:else if pane.agent === 'opencode'}
        {#key `${pane.id}:opencode`}
          <div class="pane-agent-content" class:changes-open={nativeDetailsVisible}>
            <OpenCodePane
              {client}
              {directory}
              thread={pane.thread}
              {setup}
              coordinationMessages={coordinationMessages.filter(
                (message) =>
                  pane.thread &&
                  message.target ===
                    coordinationKey(directory, `opencode:${pane.thread.sessionId}`),
              )}
              postTurnChecks={postTurnChecks.filter(
                (check) =>
                  pane.thread &&
                  check.directory === directory &&
                  check.thread === `opencode:${pane.thread.sessionId}`,
              )}
              {onretrycheck}
              spawnReceipts={spawnReceiptsForSource(
                spawnReceipts,
                pane.thread ? `opencode:${pane.thread.sessionId}` : null,
                directory,
              )}
              focused={focused === pane.id}
              focusPrompt={focusPromptPane === pane.id}
              picked={pickedAttachments[pane.id]}
              externalPrompt={pendingAgentBatches[pane.id]}
              onexternalresult={onbatchcomplete}
              {onpickedconsumed}
              {onpromptfocused}
              oncreated={(thread) => oncreated(pane.id, thread)}
              onactivity={(thread) => {
                onactivity(thread);
                void refreshNativeDetails();
              }}
              {onusage}
              {onstatus}
            />
            {#if nativeDetailsVisible}
              <section class="native-details side-area" aria-label="OpenCode session details">
                <nav class="side-tabs" aria-label="OpenCode detail tabs">
                  {#if nativeSnapshot.plan || nativeSnapshot.questions}<button
                      class:active={nativeTab === 'plan'}
                      onclick={() => (nativeTab = 'plan')}>Plan</button
                    >{/if}<button
                    class:active={nativeTab === 'changes'}
                    onclick={() => (nativeTab = 'changes')}>Changes ({diffs.length})</button
                  ><button
                    class:active={nativeTab === 'history'}
                    onclick={() => (nativeTab = 'history')}>History</button
                  ><button
                    aria-label="Close OpenCode details"
                    onclick={() => {
                      nativeDetailsOpen = false;
                      if (changesPanes.includes(pane.id)) onchanges(pane.id);
                    }}>×</button
                  >
                </nav>
                {#if nativeTab === 'plan'}
                  <PlanPanel
                    snapshot={nativeSnapshot}
                    {client}
                    {directory}
                    sessionID={pane.thread?.sessionId ?? null}
                    {dark}
                    onchanged={refreshNativeDetails}
                    shipRun={shipRuns.find(
                      (run) =>
                        run.source === nativeSnapshot.plan?.sessionID && run.repository === project,
                    ) ?? null}
                    onship={(graph, provider, limit) =>
                      onship(graph, provider, limit, nativeSnapshot.plan?.sessionID ?? '')}
                    onselectfile={(file) => {
                      selectedFile = file;
                      nativeTab = 'changes';
                    }}
                  />
                {:else if nativeTab === 'history'}
                  <HistoryPanel
                    events={nativeHistory}
                    session={nativeSession}
                    loading={false}
                    error={nativeHistoryError}
                    onrefresh={refreshNativeDetails}
                  />
                {:else}
                  <DiffPanel
                    {directory}
                    files={diffs}
                    annotations={annotateDiffs(diffs, nativeSnapshot.plan, directory)}
                    selected={selectedFile}
                    loading={diffLoading}
                    error={diffError}
                    onselect={(file) => (selectedFile = file)}
                    onrefresh={refreshDiff}
                    onclose={() => {
                      nativeDetailsOpen = false;
                      if (changesPanes.includes(pane.id)) onchanges(pane.id);
                    }}
                    scope={`${directory}\0${pane.id}\0opencode:${pane.thread?.sessionId ?? 'new'}`}
                    comments={diffComments[
                      `${directory}\0${pane.id}\0opencode:${pane.thread?.sessionId ?? 'new'}`
                    ] ?? []}
                    oncomments={ondiffcomments}
                    oncommentssent={ondiffcommentssent}
                    onsendcomments={(scope, text) => onsenddiffcomments(pane.id, scope, text)}
                  />
                {/if}
              </section>
            {/if}
          </div>
        {/key}
      {:else if pane.agent}
        {#key `${directory}:${pane.id}:${pane.agent}`}
          <div class="pane-agent-content" class:changes-open={changesPanes.includes(pane.id)}>
            <AgentWorkspace
              agent={pane.agent}
              agentName={agents.find((agent) => agent.id === pane.agent)?.name ?? pane.agent}
              {directory}
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
              postTurnChecks={postTurnChecks.filter(
                (check) =>
                  pane.thread &&
                  check.directory === directory &&
                  check.thread === `acp:${pane.agent}:${pane.thread.sessionId}`,
              )}
              {onretrycheck}
              running={running(pane.thread)}
              focused={focused === pane.id}
              focusPrompt={focusPromptPane === pane.id}
              picked={pickedAttachments[pane.id]}
              externalPrompt={pendingAgentBatches[pane.id]}
              onexternalresult={onbatchcomplete}
              {onpickedconsumed}
              {onpromptfocused}
              onentrieschange={(entries, sessionId, ready) =>
                onentries(pane.id, entries, sessionId, ready)}
              oncreated={(thread) => oncreated(pane.id, thread)}
              {onactivity}
              {onstatus}
              {onreplaychange}
              onterminal={onagentterminal}
            />
            {#if changesPanes.includes(pane.id)}
              <DiffPanel
                {directory}
                files={diffs}
                annotations={{}}
                selected={selectedFile}
                loading={diffLoading}
                error={diffError}
                onselect={(file) => (selectedFile = file)}
                onrefresh={refreshDiff}
                onclose={() => onchanges(pane.id)}
                scope={`${directory}\0${pane.id}\0acp:${pane.agent}:${pane.thread?.sessionId ?? 'new'}`}
                comments={diffComments[
                  `${directory}\0${pane.id}\0acp:${pane.agent}:${pane.thread?.sessionId ?? 'new'}`
                ] ?? []}
                oncomments={ondiffcomments}
                oncommentssent={ondiffcommentssent}
                onsendcomments={(scope, text) => onsenddiffcomments(pane.id, scope, text)}
              />
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
            focused={focused === sideChat.id}
            focusPrompt={focusPromptPane === sideChat.id}
            {onpromptfocused}
          />
        </section>
      {/key}
    {/if}
  </div>
{/if}
