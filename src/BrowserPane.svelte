<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import type { BrowserTab, Pane } from './lib/panes';
  import type { PickedBrowserElement, BrowserAttachment } from './lib/browser-pick';
  import { describePickedElement } from './lib/browser-pick';
  import { browserPopIndex, newBrowserTab } from './lib/panes';
  import { watchDetectedServers, type DetectedServer } from './lib/detected-servers';
  import { resourceQueues } from './lib/resource-limits';

  type BrowserLeaf = Extract<Pane, { kind: 'browser' }>;
  type BrowserEvent = { label: string; url: string };
  type BrowserShortcut = { label: string; action: string };
  type BrowserRoute = BrowserEvent & { mode: 'push' | 'replace' | 'pop' };

  let {
    pane,
    directory,
    active,
    onstate,
    onfocus,
    onshortcut,
    onpick,
  }: {
    pane: BrowserLeaf;
    directory: string;
    active: boolean;
    onstate: (tabs: BrowserTab[], activeTab: string) => void;
    onfocus: () => void;
    onshortcut: (event: KeyboardEvent) => void;
    onpick: (attachment: BrowserAttachment) => void;
  } = $props();

  let viewport: HTMLDivElement;
  let paneRoot: HTMLDivElement;
  let address = $state('');
  let error = $state('');
  let loading = $state(false);
  let queuedLimit = $state<number | null>(null);
  let browserRelease: (() => void) | null = null;
  let agentAction = $state('');
  let servers = $state<DetectedServer[]>([]);
  let agentActionTimer: ReturnType<typeof setTimeout> | null = null;
  let liveLabel = $state<string | null>(null);
  let ready = $state(false);
  let mountedTab = '';
  let generation = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let expectedUrl: string | null = null;
  let popDirection: -1 | 1 = -1;
  let mounted = false;
  let picking = $state(false);

  const current = $derived(pane.tabs.find((tab) => tab.id === pane.activeTab));
  const currentUrl = $derived(current?.history[current.index] ?? '');

  $effect(() => {
    if (!ready || !liveLabel) return;
    void invoke('browser_visibility', {
      label: liveLabel,
      visible: active && !document.querySelector('dialog[open]'),
    });
    if (active) void tick().then(() => resize());
  });

  function normalizeUrl(value: string): string {
    const input = value.trim();
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(input)
      ? input
      : `${/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(input) ? 'http' : 'https'}://${input}`;
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS URL.');
    return url.toString();
  }

  function tabTitle(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return 'Page';
    }
  }

  function bounds() {
    const rect = viewport.getBoundingClientRect();
    return {
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      width: Math.max(1, Math.min(rect.width, window.innerWidth - Math.max(0, rect.left))),
      height: Math.max(1, Math.min(rect.height, window.innerHeight - Math.max(0, rect.top))),
    };
  }

  function updateTab(tab: BrowserTab) {
    onstate(
      pane.tabs.map((item) => (item.id === tab.id ? tab : item)),
      pane.activeTab,
    );
  }

  function recordNavigation(url: string, mode: 'push' | 'replace' | 'pop' = 'push') {
    const tab = current;
    if (!tab || tab.history[tab.index] === url) return;
    if (mode === 'replace' && tab.index >= 0) {
      const history = [...tab.history];
      history[tab.index] = url;
      updateTab({ ...tab, history });
      return;
    }
    if (mode === 'pop') {
      const index = browserPopIndex(tab.history, tab.index, url, popDirection);
      if (index >= 0) {
        popDirection = index < tab.index ? -1 : 1;
        updateTab({ ...tab, index });
        return;
      }
    }
    popDirection = -1;
    const history = [...tab.history.slice(0, tab.index + 1), url].slice(-100);
    updateTab({ ...tab, history, index: history.length - 1 });
  }

  function clearTimer() {
    if (timeout) clearTimeout(timeout);
    timeout = null;
  }

  function showAgentAction(action: string) {
    if (agentActionTimer) clearTimeout(agentActionTimer);
    agentAction = `Agent: ${action.replaceAll('_', ' ')}`;
    agentActionTimer = setTimeout(() => (agentAction = ''), 3000);
  }

  function beginLoading(url: string) {
    const label = liveLabel;
    if (!label) return;
    clearTimer();
    expectedUrl = url;
    loading = true;
    error = '';
    timeout = setTimeout(() => {
      if (liveLabel !== label || !loading) return;
      error = `Could not load ${url}. Check the address and connection.`;
      loading = false;
      void closeLive();
    }, 12000);
  }

  async function closeLive() {
    clearTimer();
    expectedUrl = null;
    const label = liveLabel;
    liveLabel = null;
    ready = false;
    picking = false;
    if (label) resourceQueues.browser.cancel(label);
    try {
      if (label) await invoke('browser_close', { label });
    } finally {
      browserRelease?.();
      browserRelease = null;
      queuedLimit = null;
    }
  }

  async function togglePicker() {
    if (!liveLabel || !ready) return;
    try {
      const enabled = !picking;
      await invoke('browser_picker', { label: liveLabel, enabled });
      picking = enabled;
      error = '';
    } catch (cause) {
      error = String(cause);
    }
  }

  function cancelPickerOnEscape(event: KeyboardEvent) {
    if (
      !picking ||
      event.key !== 'Escape' ||
      !liveLabel ||
      document.querySelector('dialog[open]') ||
      !(event.target instanceof Node) ||
      !paneRoot.contains(event.target)
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void invoke('browser_picker', { label: liveLabel, enabled: false }).catch((cause) => {
      error = String(cause);
    });
    picking = false;
  }

  async function attachPickedElement(element: PickedBrowserElement) {
    picking = false;
    try {
      const encoded = await invoke<string>('browser_capture', { label: element.label });
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const scaleX = image.naturalWidth / element.viewport.width;
      const scaleY = image.naturalHeight / element.viewport.height;
      const left = Math.max(0, Math.floor(element.rect.x * scaleX));
      const top = Math.max(0, Math.floor(element.rect.y * scaleY));
      const right = Math.min(
        image.naturalWidth,
        Math.ceil((element.rect.x + element.rect.width) * scaleX),
      );
      const bottom = Math.min(
        image.naturalHeight,
        Math.ceil((element.rect.y + element.rect.height) * scaleY),
      );
      if (right <= left || bottom <= top)
        throw new Error('Selected element is outside the visible page.');
      const canvas = document.createElement('canvas');
      canvas.width = right - left;
      canvas.height = bottom - top;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Cannot crop browser capture.');
      context.drawImage(
        image,
        left,
        top,
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const previewUrl = canvas.toDataURL('image/png');
      const png = previewUrl.split(',')[1];
      const imagePath = await invoke<string>('browser_save_capture', { png });
      try {
        onpick({
          id: crypto.randomUUID(),
          text: describePickedElement(element),
          imagePath,
          previewUrl,
          url: element.url,
          created: Date.now(),
        });
      } catch (cause) {
        await invoke('browser_remove_capture', { path: imagePath });
        throw cause;
      }
    } catch (cause) {
      error = String(cause);
    }
  }

  async function mountCurrent() {
    const currentGeneration = ++generation;
    mountedTab = pane.activeTab;
    await closeLive();
    if (!mounted || currentGeneration !== generation) return;
    const tab = pane.tabs.find((item) => item.id === mountedTab);
    const url = tab?.history[tab.index];
    if (!url) {
      loading = false;
      error = '';
      return;
    }
    const label = `browser-${crypto.randomUUID()}`;
    liveLabel = label;
    ready = false;
    loading = true;
    error = '';
    expectedUrl = url;
    let release: (() => void) | null = null;
    let unsubscribe: (() => void) | null = null;
    try {
      const queue = resourceQueues.browser;
      if (queue.status.active >= queue.status.limit || queue.status.waiting)
        queuedLimit = queue.status.limit;
      unsubscribe = queue.subscribe(() => {
        if (liveLabel === label && queue.isQueued(label)) queuedLimit = queue.status.limit;
      });
      release = await queue.acquire(label);
      unsubscribe();
      unsubscribe = null;
      queuedLimit = null;
      if (!mounted || currentGeneration !== generation || liveLabel !== label) {
        release();
        return;
      }
      browserRelease = release;
      const openingUrl = currentUrl || url;
      expectedUrl = openingUrl;
      await invoke('browser_open', {
        label,
        directory,
        paneId: pane.id,
        url: openingUrl,
        bounds: bounds(),
      });
      if (!mounted || currentGeneration !== generation) {
        await invoke('browser_close', { label });
        release();
        if (browserRelease === release) browserRelease = null;
        return;
      }
      if (currentUrl && currentUrl !== openingUrl) {
        expectedUrl = currentUrl;
        await invoke('browser_navigate', { label, url: currentUrl });
      }
      ready = true;
      await invoke('browser_visibility', {
        label,
        visible: active && !document.querySelector('dialog[open]'),
      });
      await tick();
      await resize();
      if (loading) beginLoading(openingUrl);
    } catch (cause) {
      unsubscribe?.();
      release?.();
      if (browserRelease === release) browserRelease = null;
      if (currentGeneration === generation) {
        error = String(cause);
        loading = false;
        liveLabel = null;
        ready = false;
        queuedLimit = null;
        void invoke('browser_close', { label });
      }
    }
  }

  async function resize() {
    if (!ready || !liveLabel || !viewport.clientWidth || !viewport.clientHeight) return;
    try {
      await invoke('browser_bounds', { label: liveLabel, bounds: bounds() });
    } catch (cause) {
      error = String(cause);
    }
  }

  async function navigate(value: string) {
    try {
      const url = normalizeUrl(value);
      address = url;
      recordNavigation(url);
      if (liveLabel && ready) {
        beginLoading(url);
        await invoke('browser_navigate', { label: liveLabel, url });
      } else if (!liveLabel) {
        await tick();
        await mountCurrent();
      }
    } catch (cause) {
      error = String(cause);
      loading = false;
      clearTimer();
    }
  }

  async function go(step: number) {
    const tab = current;
    if (!tab) return;
    const index = tab.index + step;
    const url = tab.history[index];
    if (!url) return;
    popDirection = step < 0 ? -1 : 1;
    updateTab({ ...tab, index });
    address = url;
    try {
      if (liveLabel && ready) {
        beginLoading(url);
        await invoke('browser_navigate', { label: liveLabel, url });
      } else if (!liveLabel) {
        await tick();
        await mountCurrent();
      }
    } catch (cause) {
      error = String(cause);
      loading = false;
      clearTimer();
    }
  }

  async function reload() {
    if (!currentUrl) return;
    if (liveLabel && !ready) return;
    if (!liveLabel) {
      await mountCurrent();
      return;
    }
    try {
      beginLoading(currentUrl);
      await invoke('browser_reload', { label: liveLabel });
    } catch (cause) {
      error = String(cause);
      loading = false;
      clearTimer();
    }
  }

  function newTab() {
    if (pane.tabs.length >= 30) return;
    const tab = newBrowserTab();
    onstate([...pane.tabs, tab], tab.id);
  }

  function closeTab(id: string) {
    let tabs = pane.tabs.filter((tab) => tab.id !== id);
    if (!tabs.length) tabs = [newBrowserTab()];
    onstate(tabs, id === pane.activeTab ? tabs[0].id : pane.activeTab);
  }

  onMount(() => {
    mounted = true;
    const stopServers = watchDetectedServers(directory, (detected) => (servers = detected));
    const observer = new ResizeObserver(() => void resize());
    observer.observe(viewport);
    const overlayObserver = new MutationObserver(() => {
      if (!ready || !liveLabel) return;
      void invoke('browser_visibility', {
        label: liveLabel,
        visible: active && !document.querySelector('dialog[open]'),
      });
    });
    overlayObserver.observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ['open'],
    });
    const unlisten = Promise.all([
      listen<{ paneId: string; url: string }>('browser:agent-navigate', ({ payload }) => {
        if (payload.paneId === pane.id) {
          showAgentAction('navigate');
          void navigate(payload.url);
        }
      }),
      listen<{ label: string; action: string }>('browser:agent-action', ({ payload }) => {
        if (payload.label === liveLabel) showAgentAction(payload.action);
      }),
      listen<BrowserEvent>('browser:navigate', ({ payload }) => {
        if (payload.label !== liveLabel) return;
        picking = false;
        beginLoading(payload.url);
        address = payload.url;
        recordNavigation(payload.url);
      }),
      listen<BrowserRoute>('browser:route', ({ payload }) => {
        if (payload.label !== liveLabel) return;
        address = payload.url;
        recordNavigation(payload.url, payload.mode);
      }),
      listen<BrowserEvent>('browser:loaded', ({ payload }) => {
        if (payload.label !== liveLabel) return;
        if (payload.url !== expectedUrl) return;
        clearTimer();
        expectedUrl = null;
        loading = false;
        error = '';
      }),
      listen<BrowserShortcut>('browser:shortcut', ({ payload }) => {
        if (payload.label !== liveLabel) return;
        onfocus();
        void invoke('browser_focus', { label: payload.label });
        if (payload.action === 'focus') return;
        const direction = payload.action.startsWith('arrow');
        const key = direction
          ? `Arrow${payload.action.slice(5, 6).toUpperCase()}${payload.action.slice(6)}`
          : 'w';
        onshortcut(new KeyboardEvent('keydown', { key, metaKey: true, altKey: direction }));
      }),
      listen<PickedBrowserElement>('browser:picked', ({ payload }) => {
        if (payload.label === liveLabel) void attachPickedElement(payload);
      }),
      listen<string>('browser:pick-cancel', ({ payload }) => {
        if (payload === liveLabel) picking = false;
      }),
    ]);
    void unlisten.then(async () => {
      if (!mounted) return false;
      await invoke('browser_pane_register', { directory, paneId: pane.id, open: true });
      if (mounted) await mountCurrent();
      else await invoke('browser_pane_register', { directory, paneId: pane.id, open: false });
      return true;
    });
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', cancelPickerOnEscape, true);
    return () => {
      mounted = false;
      stopServers();
      if (agentActionTimer) clearTimeout(agentActionTimer);
      ++generation;
      observer.disconnect();
      overlayObserver.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', cancelPickerOnEscape, true);
      void unlisten.then(async (listeners) => {
        listeners.forEach((stop) => stop());
        await invoke('browser_pane_register', { directory, paneId: pane.id, open: false });
        return true;
      });
      void closeLive();
    };
  });

  $effect(() => {
    if (mounted && pane.activeTab !== mountedTab) void mountCurrent();
  });

  $effect(() => {
    if (pane.activeTab && currentUrl) address = currentUrl;
    else if (pane.activeTab) address = '';
  });
</script>

<div class="browser-pane" aria-label="Browser pane" bind:this={paneRoot}>
  <div class="browser-tabs" role="tablist" aria-label="Browser tabs">
    {#each pane.tabs as tab (tab.id)}
      {@const url = tab.history[tab.index] ?? ''}
      <button
        class:active={tab.id === pane.activeTab}
        role="tab"
        aria-selected={tab.id === pane.activeTab}
        onclick={() => onstate(pane.tabs, tab.id)}>{url ? tabTitle(url) : 'New tab'}</button
      >
      <button
        class="browser-tab-close"
        aria-label="Close browser tab"
        onclick={() => closeTab(tab.id)}>×</button
      >
    {/each}
    <button aria-label="New browser tab" disabled={pane.tabs.length >= 30} onclick={newTab}
      >+</button
    >
  </div>
  <form
    class="browser-toolbar"
    onsubmit={(event) => {
      event.preventDefault();
      void navigate(address);
    }}
  >
    <button
      type="button"
      aria-label="Back"
      disabled={!current || current.index <= 0}
      onclick={() => void go(-1)}>←</button
    >
    <button
      type="button"
      aria-label="Forward"
      disabled={!current || current.index >= current.history.length - 1}
      onclick={() => void go(1)}>→</button
    >
    <button type="button" aria-label="Reload" disabled={!currentUrl} onclick={() => void reload()}
      >↻</button
    >
    <input
      aria-label="Address"
      placeholder="localhost:3000 or https://example.com"
      bind:value={address}
    />
    <button type="submit">Go</button>
    <button
      type="button"
      aria-label="Developer tools"
      disabled={!ready}
      onclick={() => void invoke('browser_devtools', { label: liveLabel })}>⌘⌥I</button
    >
    <button
      type="button"
      aria-label={picking ? 'Cancel element picker' : 'Pick page element'}
      aria-pressed={picking}
      disabled={!ready}
      onclick={() => void togglePicker()}>{picking ? 'Cancel pick' : 'Pick element'}</button
    >
  </form>
  {#if servers.length}
    <div class="browser-servers" aria-label="Dev servers in this worktree">
      {#each servers as server (server.port)}
        <button
          type="button"
          aria-label={`Open dev server on port ${server.port}`}
          onclick={() => void navigate(server.url)}>:{server.port}</button
        >
      {/each}
    </div>
  {/if}
  {#if loading}<p class="browser-loading" role="status">
      {queuedLimit === null ? 'Loading…' : `Waiting for browser slot (limit ${queuedLimit})`}
    </p>{/if}
  {#if agentAction}<p class="browser-agent-action" role="status">{agentAction}</p>{/if}
  {#if error}<div class="browser-error" role="alert">
      <p>{error}</p>
      <button onclick={() => void mountCurrent()}>Retry</button>
    </div>{/if}
  {#if !currentUrl && !error}<div class="browser-empty">Enter an address to open a page.</div>{/if}
  <div class="browser-viewport" bind:this={viewport}></div>
</div>
