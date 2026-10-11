<script lang="ts">
  import { onMount } from 'svelte';
  import { Channel, invoke } from '@tauri-apps/api/core';
  import { Terminal, type ILink } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';
  import { terminalFileLinks } from './lib/terminal-links';
  import { terminalTheme } from './lib/terminal-theme';
  import { terminalRuntimeId } from './lib/panes';
  import { terminalDivertsKey } from './lib/shortcuts';

  type TerminalEvent = { kind: 'output'; data: number[] } | { kind: 'exit'; code: number };

  let {
    id,
    directory,
    focused,
    dark,
    onshortcut,
    command,
    oncommandstarted,
    onexit,
    owner,
    onownerlost,
  }: {
    id: string;
    directory: string;
    focused: boolean;
    dark: boolean;
    onshortcut: (event: KeyboardEvent) => void;
    command?: string;
    oncommandstarted: (id: string) => void;
    onexit: (id: string, code: number) => void;
    owner?: string;
    onownerlost: (id: string) => void;
  } = $props();
  const runtimeId = $derived(terminalRuntimeId(directory, id));
  let container: HTMLDivElement;
  let terminal: Terminal;
  let fit: FitAddon;
  let observer: ResizeObserver;
  let exitCode = $state<number | null>(null);
  let error = $state('');
  let disposed = false;
  let started = false;
  let generation = 0;
  const attachment = crypto.randomUUID();
  let initialCommand = $state<string | undefined>();

  function channel(reportExit: (code: number) => void): Channel<TerminalEvent> {
    const current = ++generation;
    const receiver = new Channel<TerminalEvent>();
    Object.assign(receiver, {
      onmessage: (event: TerminalEvent) => {
        if (disposed || current !== generation) return;
        if (event.kind === 'output') terminal.write(new Uint8Array(event.data));
        else {
          exitCode = event.code;
          onexit(id, event.code);
          reportExit(event.code);
        }
      },
    });
    return receiver;
  }

  async function open() {
    let reportedExit: number | null = null;
    try {
      const existed = await invoke<boolean>('terminal_open', {
        params: {
          id: runtimeId,
          directory,
          command: initialCommand,
          size: { cols: terminal.cols, rows: terminal.rows },
          attachment,
        },
        onEvent: channel((code) => (reportedExit = code)),
      });
      if (owner && !existed) onownerlost(id);
      started = true;
      if (initialCommand) oncommandstarted(id);
      exitCode = reportedExit;
      error = '';
      if (focused) terminal.focus();
    } catch (cause) {
      error = String(cause);
      onexit(id, 1);
    }
  }

  async function restart() {
    try {
      ++generation;
      await invoke('terminal_close', { id: runtimeId });
      terminal.reset();
      started = false;
      await open();
    } catch (cause) {
      error = String(cause);
    }
  }

  function resize() {
    if (!container.clientWidth || !container.clientHeight) return;
    fit.fit();
    if (started)
      void invoke('terminal_resize', {
        id: runtimeId,
        cols: terminal.cols,
        rows: terminal.rows,
      }).catch((cause) => (error = String(cause)));
  }

  onMount(() => {
    initialCommand = command;
    terminal = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      screenReaderMode: true,
      theme: terminalTheme(dark),
    });
    fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      if (!terminalDivertsKey(event)) return true;
      onshortcut(event);
      event.stopPropagation();
      return false;
    });
    terminal.onData((data) => {
      void invoke('terminal_write', {
        id: runtimeId,
        data: [...new TextEncoder().encode(data)],
      }).catch((cause) => (error = String(cause)));
    });
    terminal.onBinary((data) => {
      void invoke('terminal_write', {
        id: runtimeId,
        data: [...data].map((character) => character.codePointAt(0) ?? 0),
      }).catch((cause) => (error = String(cause)));
    });
    const copySelection = () => {
      const selection = terminal.getSelection();
      if (selection?.trim()) void navigator.clipboard?.writeText(selection).catch(() => {});
    };
    container.addEventListener('pointerup', copySelection);
    container.addEventListener('keyup', copySelection);
    terminal.registerLinkProvider({
      provideLinks(line, callback) {
        const buffer = terminal.buffer.active;
        let first = line - 1;
        while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
        let last = line - 1;
        while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped) last++;
        let content = '';
        const cells: { start: { x: number; y: number }; end: { x: number; y: number } }[] = [];
        for (let row = first; row <= last; row++) {
          const bufferLine = buffer.getLine(row);
          for (let column = 0; column < terminal.cols; column++) {
            const cell = bufferLine?.getCell(column);
            if (!cell || cell.getWidth() === 0) continue;
            const chars = cell.getChars() || ' ';
            content += chars;
            for (let index = 0; index < chars.length; index++) {
              cells.push({
                start: { x: column + 1, y: row + 1 },
                end: { x: column + cell.getWidth(), y: row + 1 },
              });
            }
          }
        }
        const links: ILink[] = [];
        for (const link of terminalFileLinks(content)) {
          const start = link.start - 1;
          const end = start + link.text.length - 1;
          const firstCell = cells[start];
          const lastCell = cells[end];
          if (!firstCell || !lastCell || line < firstCell.start.y || line > lastCell.end.y)
            continue;
          links.push({
            text: link.text,
            range: {
              start: firstCell.start,
              end: lastCell.end,
            },
            activate: () =>
              void invoke('terminal_open_file', {
                id: runtimeId,
                path: link.path,
                line: link.line,
              }).catch((cause) => (error = String(cause))),
          });
        }
        callback(links);
      },
    });
    observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    void open();
    return () => {
      disposed = true;
      ++generation;
      observer.disconnect();
      container.removeEventListener('pointerup', copySelection);
      container.removeEventListener('keyup', copySelection);
      terminal.dispose();
      void invoke('terminal_detach', { id: runtimeId, attachment });
    };
  });

  $effect(() => {
    if (focused && terminal) terminal.focus();
  });

  $effect(() => {
    if (terminal) terminal.options.theme = terminalTheme(dark);
  });
</script>

<div class="terminal-pane" aria-label="Shell terminal">
  <div class="terminal-screen" bind:this={container}></div>
  {#if exitCode !== null}<div class="terminal-exit" role="status">
      {initialCommand ? 'Command' : 'Shell'} exited with code {exitCode}.
      <button onclick={restart}>Restart</button>
    </div>{/if}
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
</div>
