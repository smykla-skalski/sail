<script lang="ts">
  import { Button } from '@smykla-skalski/sui';
  import HarnessIcon from './HarnessIcon.svelte';
  import MenuButton from './MenuButton.svelte';
  import type { AgentAvailability, AgentId } from './lib/acp';
  import { ariaKeyShortcutsFor, shortcutFor, shortcutLabel } from './lib/shortcuts';

  export type TopbarSubagentNav = {
    parentTitle: string;
    position: string;
    hasPrevious: boolean;
    hasNext: boolean;
  };

  export type TopbarThreadActions =
    | { kind: 'agent'; title: string; onrename: () => void; ondelete: () => void }
    | { kind: 'opencode'; title: string; onrename: () => void; ondelete: () => void };

  type MobileView = 'sessions' | 'chat' | 'details';

  let {
    element = $bindable(),
    sidebarToggle = $bindable(),
    sidebarExpanded,
    ontogglesidebar,
    mobileView,
    onmobileview,
    overview,
    onoverview,
    shipQueue,
    onshipqueue,
    projectName,
    projectDisabled,
    onchooseproject,
    conversationTitle,
    inboxCount,
    oninbox,
    onpalette,
    directory,
    agents,
    onopenagent,
    planDisabled,
    onnewplan,
    onswitchthread,
    threadActions,
    contextUsage,
    browserAccess,
    ontogglebrowser,
    memoryCapture,
    memoryCaptureAvailable,
    memoryCaptureBusy,
    ontogglememorycapture,
    onrunproject,
    agentTerminalCount,
    onagentterminals,
    onrestore,
    oncommands,
    changesLabel,
    changesTitle,
    changesExpanded,
    ontogglechanges,
    subagentNav = null,
    onsubagentparent,
    onsubagentsibling,
  }: {
    element?: HTMLElement;
    sidebarToggle?: HTMLButtonElement;
    sidebarExpanded: boolean;
    ontogglesidebar: () => void;
    mobileView: MobileView;
    onmobileview: (view: MobileView) => void;
    overview: boolean;
    onoverview: () => void;
    shipQueue: boolean;
    onshipqueue: () => void;
    projectName: string;
    projectDisabled: boolean;
    onchooseproject: () => void;
    conversationTitle: string;
    inboxCount: number;
    oninbox: () => void;
    onpalette: () => void;
    directory: string;
    agents: AgentAvailability[];
    onopenagent: (agent: AgentId) => void;
    planDisabled: boolean;
    onnewplan: () => void;
    onswitchthread: () => void;
    threadActions: TopbarThreadActions | null;
    contextUsage?: number;
    browserAccess: boolean;
    ontogglebrowser: () => void;
    memoryCapture: boolean;
    memoryCaptureAvailable: boolean;
    memoryCaptureBusy: boolean;
    ontogglememorycapture: () => void;
    onrunproject: (() => void) | null;
    agentTerminalCount: number;
    onagentterminals: () => void;
    onrestore: (() => void) | null;
    oncommands: () => void;
    changesLabel: string;
    changesTitle: string;
    changesExpanded: boolean;
    ontogglechanges: () => void;
    subagentNav?: TopbarSubagentNav | null;
    onsubagentparent?: () => void;
    onsubagentsibling?: (direction: -1 | 1) => void;
  } = $props();

  const platform = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? 'mac' : 'other';
  const keyLabel = (id: 'subagent.parent' | 'subagent.previous' | 'subagent.next') =>
    shortcutLabel(shortcutFor(id), platform);
  const paletteShortcut = shortcutLabel(shortcutFor('palette.open'), platform);

  const threadLabel = $derived(
    [
      threadActions ? `Thread ${threadActions.title}` : 'Thread',
      contextUsage === undefined ? '' : `context ${contextUsage}% used`,
    ]
      .filter(Boolean)
      .join(', '),
  );
</script>

<header class="topbar" bind:this={element}>
  <button
    class="sidebar-toggle"
    bind:this={sidebarToggle}
    aria-label="Toggle project sidebar"
    aria-controls="project-sidebar"
    aria-expanded={sidebarExpanded}
    title="Toggle project sidebar (⌘B / Ctrl+B)"
    onclick={ontogglesidebar}>☰</button
  >
  <nav class="mobile-switcher" aria-label="Workspace panels">
    <button aria-pressed={mobileView === 'sessions'} onclick={() => onmobileview('sessions')}
      >Projects</button
    >
    <button aria-pressed={mobileView === 'chat'} onclick={() => onmobileview('chat')}>Chat</button>
    <button aria-pressed={mobileView === 'details'} onclick={() => onmobileview('details')}
      >Details</button
    >
  </nav>
  <div class="breadcrumb">
    {#if overview}<strong>All worktrees</strong><span class="slash">/</span><strong
        >Task overview</strong
      >{:else if shipQueue}<strong>All repositories</strong><span class="slash">/</span><strong
        >Ship queue</strong
      >{:else}<button
        class="breadcrumb-project"
        title={directory || undefined}
        onclick={onchooseproject}
        disabled={projectDisabled}>{projectName} ⌄</button
      ><span class="slash">/</span>{#if subagentNav}<button
          class="breadcrumb-project breadcrumb-parent"
          title={`Parent thread: ${subagentNav.parentTitle}`}
          aria-label={`Go to parent thread ${subagentNav.parentTitle}`}
          onclick={onsubagentparent}>{subagentNav.parentTitle}</button
        ><span class="slash">/</span>{/if}<strong title={conversationTitle}
        >{conversationTitle}</strong
      >{/if}
  </div>
  {#if subagentNav && !overview}
    <div class="subagent-nav" role="group" aria-label="Subagent navigation">
      <Button
        variant="ghost"
        size="sm"
        aria-label="Go to parent thread"
        aria-keyshortcuts={ariaKeyShortcutsFor('subagent.parent')}
        title={`Parent thread (${keyLabel('subagent.parent')})`}
        onclick={onsubagentparent}>↑ Parent</Button
      >
      <Button
        variant="ghost"
        size="sm"
        aria-label="Previous sibling subagent"
        aria-keyshortcuts={ariaKeyShortcutsFor('subagent.previous')}
        title={`Previous sibling (${keyLabel('subagent.previous')})`}
        disabled={!subagentNav.hasPrevious}
        onclick={() => onsubagentsibling?.(-1)}>‹</Button
      >
      <span class="subagent-nav-position" aria-live="polite">{subagentNav.position}</span>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Next sibling subagent"
        aria-keyshortcuts={ariaKeyShortcutsFor('subagent.next')}
        title={`Next sibling (${keyLabel('subagent.next')})`}
        disabled={!subagentNav.hasNext}
        onclick={() => onsubagentsibling?.(1)}>›</Button
      >
    </div>
  {/if}
  <div class="topbar-actions">
    <div class="topbar-primary">
      <Button
        variant="ghost"
        size="sm"
        class="topbar-palette"
        aria-label={`Command palette ${paletteShortcut}`}
        aria-keyshortcuts={ariaKeyShortcutsFor('palette.open')}
        title={`Open command palette (${paletteShortcut})`}
        onclick={onpalette}>{paletteShortcut}</Button
      >
      <Button
        variant="ghost"
        size="sm"
        data-topbar-inbox
        title="Pending requests and items needing attention"
        aria-keyshortcuts={ariaKeyShortcutsFor('attention.next')}
        onclick={oninbox}>Inbox ({inboxCount})</Button
      >
      {#if directory}<MenuButton
          class="new-agent-menu"
          label="New agent ▾"
          ariaLabel="New agent"
          menuLabel="New agent"
        >
          {#snippet trigger()}New<span class="menu-trigger-extra">&nbsp;agent</span
            >&nbsp;▾{/snippet}
          <div class="agent-launches" role="group" aria-label="Agents">
            {#each agents as agent (agent.id)}
              <button
                role="menuitem"
                disabled={!agent.available}
                title={agent.reason ?? `New ${agent.name} thread`}
                onclick={() => onopenagent(agent.id)}
                ><HarnessIcon agent={agent.id} /> {agent.name}</button
              >
            {/each}
          </div>
          <div class="menu-separator" role="separator"></div>
          <button
            role="menuitem"
            aria-label="New plan"
            title="Start an OpenCode thread to plan in"
            disabled={planDisabled}
            onclick={onnewplan}>New plan</button
          >
        </MenuButton>{/if}
      <Button
        variant="ghost"
        size="sm"
        onclick={ontogglechanges}
        aria-controls="session-details"
        aria-expanded={changesExpanded}
        title={changesTitle}>{changesLabel}</Button
      >
    </div>
    <MenuButton
      class="more-actions-menu"
      label="More actions"
      ariaLabel="More actions"
      title="More actions"
      menuLabel="More actions"
    >
      {#snippet trigger()}<span aria-hidden="true">⋯</span>{/snippet}
      <button role="menuitem" onclick={onoverview}
        >{overview ? 'Back to workspace' : 'Task overview'}</button
      >
      <button role="menuitem" onclick={onshipqueue}
        >{shipQueue ? 'Back to workspace' : 'Ship queue'}</button
      >
      {#if directory}<button role="menuitem" class="agent-menu-launch" onclick={onswitchthread}
          >Switch thread…</button
        >{/if}
      <button role="menuitem" onclick={oncommands}>Commands…</button>
      {#if onrunproject}<button role="menuitem" onclick={onrunproject}>Run project</button>{/if}
      {#if agentTerminalCount}<button role="menuitem" onclick={onagentterminals}
          >Agent terminals ({agentTerminalCount})</button
        >{/if}
      {#if directory}<button
          role="menuitemcheckbox"
          aria-checked={browserAccess}
          title="Toggle agent browser access for this project"
          onclick={ontogglebrowser}>Agent browser {browserAccess ? 'on' : 'off'}</button
        ><button
          role="menuitemcheckbox"
          aria-checked={memoryCapture}
          disabled={!memoryCaptureAvailable || memoryCaptureBusy}
          title={memoryCaptureAvailable
            ? 'Toggle automatic memory capture for this project'
            : 'Enable shared memory for this project first'}
          onclick={ontogglememorycapture}
          >Automatic memory capture {memoryCapture ? 'on' : 'off'}</button
        >{/if}
      {#if threadActions || onrestore}
        <div class="menu-separator" role="separator"></div>
        <div role="group" aria-label={threadLabel}>
          {#if threadActions}<span class="menu-label" aria-hidden="true" title={threadActions.title}
              >{threadActions.title}</span
            >{/if}
          {#if contextUsage !== undefined}<span class="menu-label session-usage" aria-hidden="true"
              >Context {contextUsage}%</span
            >{/if}
          {#if onrestore}<button role="menuitem" onclick={onrestore}>Restore…</button>{/if}
          {#if threadActions?.kind === 'opencode'}<button
              role="menuitem"
              onclick={threadActions.onrename}>Rename…</button
            ><button role="menuitem" class="danger" onclick={threadActions.ondelete}
              >Delete session…</button
            >{:else if threadActions}<button role="menuitem" onclick={threadActions.onrename}
              >Rename…</button
            ><button role="menuitem" class="danger" onclick={threadActions.ondelete}
              >Delete thread…</button
            >{/if}
        </div>
      {/if}
    </MenuButton>
  </div>
</header>
