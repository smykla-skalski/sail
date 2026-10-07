import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('agent switching', () => {
  const currentRepository = mkdtempSync(join(tmpdir(), 'sail-switch-current-'));
  const targetRepository = mkdtempSync(join(tmpdir(), 'sail-switch-target-'));

  before(() => {
    execFileSync('git', ['init', '-q', currentRepository]);
    execFileSync('git', ['init', '-q', targetRepository]);
  });

  after(() => {
    rmSync(currentRepository, { recursive: true, force: true });
    rmSync(targetRepository, { recursive: true, force: true });
  });

  it('opens an ACP thread while OpenCode prepares its worktree', async () => {
    const current = realpathSync(currentRepository);
    const target = realpathSync(targetRepository);
    await browser.execute((path) => sessionStorage.setItem('sai-e2e-switch-target', path), target);
    const session = await browser.tauri.execute(async ({ core }) => {
      const path = sessionStorage.getItem('sai-e2e-switch-target');
      if (!path) throw new Error('Missing target repository');
      await core.invoke('acp_connect', { agent: 'claude' });
      return core.invoke<{ sessionId: string }>('acp_new_session', {
        agent: 'claude',
        cwd: path,
      });
    });
    await browser.execute(
      ({ current: selectedPath, target: targetPath, sessionId }) => {
        sessionStorage.removeItem('sai-e2e-switch-target');
        localStorage.setItem('sai-directory', selectedPath);
        localStorage.removeItem('sai-pane-layouts');
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [selectedPath, targetPath], groups: [], worktrees: {} }),
        );
        localStorage.setItem(
          'sail-agent-threads',
          JSON.stringify([
            {
              agent: 'claude',
              sessionId,
              directory: targetPath,
              title: 'Switch target',
              updated: Date.now(),
            },
          ]),
        );
      },
      { current, target, sessionId: session.sessionId },
    );
    await browser.refresh();
    await expect($('.sidebar-footer')).toHaveText(expect.stringContaining('OpenCode connected'));
    const row = $('.project-agent-row[aria-label*="Switch target"]');
    await expect(row).toBeDisplayed();

    await browser.execute(() => {
      sessionStorage.setItem('sai-e2e-browser-setup-delay', '2000');
      sessionStorage.removeItem('sai-e2e-browser-setup-started');
      sessionStorage.removeItem('sai-e2e-browser-setup-finished');
    });

    try {
      await browser.execute(() => {
        Reflect.set(window, '__switchStart', performance.now());
        const observer = new MutationObserver(() => {
          if (!document.querySelector('.agent-header')?.textContent?.includes('Switch target'))
            return;
          Reflect.set(window, '__switchVisible', performance.now());
          Reflect.set(
            window,
            '__switchStartedAtVisible',
            sessionStorage.getItem('sai-e2e-browser-setup-started'),
          );
          Reflect.set(
            window,
            '__switchFinishedAtVisible',
            sessionStorage.getItem('sai-e2e-browser-setup-finished'),
          );
          observer.disconnect();
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        document
          .querySelector<HTMLButtonElement>('.project-agent-row[aria-label*="Switch target"]')
          ?.click();
      });
      await expect($('.agent-header')).toHaveText(expect.stringContaining('Switch target'));
      await browser.waitUntil(async () =>
        browser.execute(() => Reflect.has(window, '__switchVisible')),
      );
      const result = await browser.execute(() => ({
        elapsed:
          Number(Reflect.get(window, '__switchVisible')) -
          Number(Reflect.get(window, '__switchStart')),
        started: Reflect.get(window, '__switchStartedAtVisible'),
        finished: Reflect.get(window, '__switchFinishedAtVisible'),
        selected: document.querySelector('.project-agent-row.active')?.getAttribute('aria-label'),
      }));
      console.log('ACP switch with delayed OpenCode setup', result);
      expect(result.started).toBe(target);
      expect(result.finished).toBeNull();
      expect(result.selected).toContain('Switch target');
      expect(result.elapsed).toBeLessThan(1_500);
      await browser.waitUntil(async () =>
        browser.execute(
          (path) => sessionStorage.getItem('sai-e2e-browser-setup-finished') === path,
          target,
        ),
      );
      await expect($('.agent-header')).toHaveText(expect.stringContaining('Switch target'));
      await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    } finally {
      await browser.execute(() => {
        sessionStorage.removeItem('sai-e2e-browser-setup-delay');
        sessionStorage.removeItem('sai-e2e-browser-setup-started');
        sessionStorage.removeItem('sai-e2e-browser-setup-finished');
      });
    }

    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('New thread'));
    await $('.agent-menu-launch').click();
    const search = $('[aria-label="Search command palette"]');
    await search.setValue('Claude');
    await browser.keys('Enter');
    await search.setValue('Switch target');
    await browser.keys('Enter');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Switch target'));
  });

  it('rejects a saved thread after its selected worktree is removed outside Sail', async () => {
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('New thread'));
    rmSync(targetRepository, { recursive: true, force: true });

    await $('.agent-menu-launch').click();
    const search = $('[aria-label="Search command palette"]');
    await search.setValue('Claude');
    await browser.keys('Enter');
    await search.setValue('Switch target');
    await browser.keys('Enter');
    await expect($('.palette-error')).toHaveText('This session is no longer available.');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('New thread'));
  });
});

type ContinuityThread = { agent: 'claude' | 'codex'; directory: string; title: string };

function restarts(directory: string): number {
  const file = join(directory, 'acp-restarts.txt');
  return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
}

async function openThread(title: string) {
  await $(`.project-agent-row[aria-label*="${title}"]`).click();
  await expect($('.agent-header')).toHaveText(expect.stringContaining(title));
}

async function switchAwayAndBack(title: string, away: string, times = 3): Promise<void> {
  if (times === 0) return;
  await openThread(away);
  await browser.pause(700);
  await openThread(title);
  await browser.pause(300);
  await switchAwayAndBack(title, away, times - 1);
}

async function sendPrompt(text: string) {
  await $('.agent-composer textarea').setValue(text);
  await $('.agent-actions button').click();
}

describe('agent sessions survive thread switches', () => {
  const first = realpathSync(mkdtempSync(join(tmpdir(), 'sail-continuity-first-')));
  const second = realpathSync(mkdtempSync(join(tmpdir(), 'sail-continuity-second-')));
  const codex = realpathSync(mkdtempSync(join(tmpdir(), 'sail-restart-on-load-')));
  const threads: ContinuityThread[] = [
    { agent: 'claude', directory: first, title: 'Continuity main' },
    { agent: 'claude', directory: first, title: 'Continuity sibling' },
    { agent: 'claude', directory: second, title: 'Continuity elsewhere' },
    { agent: 'codex', directory: codex, title: 'Continuity codex' },
    { agent: 'codex', directory: codex, title: 'Codex sibling' },
  ];

  before(async () => {
    for (const directory of [first, second, codex]) execFileSync('git', ['init', '-q', directory]);
    await browser.execute((value) => {
      sessionStorage.setItem('sai-e2e-continuity-threads', value);
    }, JSON.stringify(threads));
    const sessions = await browser.tauri.execute(async ({ core }) => {
      const pending: { agent: string; directory: string }[] = JSON.parse(
        sessionStorage.getItem('sai-e2e-continuity-threads') ?? '[]',
      );
      await core.invoke('acp_connect', { agent: 'claude' });
      await core.invoke('acp_connect', { agent: 'codex' });
      await core.invoke('acp_authenticate', { agent: 'codex', methodId: 'chat-gpt' });
      const created = await Promise.all(
        pending.map((thread) =>
          core.invoke<{ sessionId: string }>('acp_new_session', {
            agent: thread.agent,
            cwd: thread.directory,
          }),
        ),
      );
      return created.map((session) => session.sessionId);
    });
    await browser.execute(
      (saved, personalCheck, directories) => {
        sessionStorage.removeItem('sai-e2e-continuity-threads');
        sessionStorage.setItem('sail-e2e-settings', 'enabled');
        localStorage.setItem('sai-directory', directories[0]);
        localStorage.removeItem('sai-pane-layouts');
        localStorage.setItem('sai-post-turn-personal', JSON.stringify([personalCheck]));
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: directories, groups: [], worktrees: {} }),
        );
        localStorage.setItem('sail-agent-threads', saved);
      },
      JSON.stringify(
        threads.map((thread, index) => ({
          agent: thread.agent,
          sessionId: sessions[index],
          directory: thread.directory,
          title: thread.title,
          updated: Date.now() - index,
        })),
      ),
      "printf 'run\\n' >> continuity-runs.txt",
      [first, second, codex],
    );
    await browser.refresh();
    await expect($('.project-agent-row[aria-label*="Continuity main"]')).toBeDisplayed();
  });

  after(async () => {
    await browser.execute(() => {
      localStorage.removeItem('sai-post-turn-personal');
      sessionStorage.removeItem('sail-e2e-settings');
    });
    for (const directory of [first, second, codex])
      rmSync(directory, { recursive: true, force: true });
  });

  it('keeps a long turn running across switches within and across worktrees', async () => {
    await openThread('Continuity main');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await sendPrompt('Long turn');
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('part-1 '));
    await switchAwayAndBack('Continuity main', 'Continuity sibling');
    await switchAwayAndBack('Continuity main', 'Continuity elsewhere');
    await browser.pause(500);
    const live = await $('.agent-conversation').getText();
    const seen = Math.max(...[...live.matchAll(/part-(\d+) /g)].map((match) => Number(match[1])));
    expect(seen).toBeGreaterThan(1);
    expect(seen).toBeLessThan(60);
    for (let part = 1; part <= seen; part += 1)
      expect(live.split(`part-${part} `).length - 1).toBe(1);
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await openThread('Continuity sibling');
    await browser.waitUntil(() => existsSync(join(first, 'continuity-runs.txt')), {
      timeout: 20_000,
      timeoutMsg: 'The post-turn check did not run for a turn that finished while away',
    });
    await openThread('Continuity main');
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('part-60 '));
    const transcript = await $('.agent-conversation').getText();
    for (let part = 1; part <= 60; part += 1)
      expect(transcript.split(`part-${part} `).length - 1).toBe(1);
    await expect($('.agent-picker-controls')).toHaveText(expect.stringContaining('Test model'));
    await expect($('.agent-header')).not.toHaveText(expect.stringContaining('Interrupted'));
    expect(restarts(first)).toBe(0);
    expect(readFileSync(join(first, 'continuity-runs.txt'), 'utf8')).toBe('run\n');
  });

  it('lets background work finish after switching away and back', async () => {
    await openThread('Continuity main');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await sendPrompt('Background task');
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Background task started.'),
    );
    await switchAwayAndBack('Continuity main', 'Continuity elsewhere');
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Background task finished.'),
      { wait: 15_000 },
    );
    expect(restarts(first)).toBe(0);
  });

  it('keeps a live subagent working and does not duplicate it on replay', async () => {
    await openThread('Continuity main');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await sendPrompt('Live native subagent');
    const child =
      "//button[contains(@class,'project-agent-row') and contains(.,'Inspect live delegation')]";
    await expect($(child)).toHaveText(expect.stringContaining('Working'));
    await switchAwayAndBack('Continuity main', 'Continuity sibling', 2);
    await expect($(child)).toHaveText(expect.stringContaining('Working'));
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Live subagent finished.'),
      { wait: 15_000 },
    );
    await switchAwayAndBack('Continuity main', 'Continuity sibling', 1);
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    const toggle = $('button[aria-label*="for Continuity main"]');
    if (await toggle.isExisting()) await toggle.click();
    await expect($(child)).toBeDisplayed();
    expect(await $$(child).length).toBe(1);
    await expect($('.sidebar')).not.toHaveText(expect.stringContaining('Disconnected'));
    expect(restarts(first)).toBe(0);
  });

  it('keeps Sail tools connected after switching', async () => {
    await openThread('Continuity main');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await sendPrompt('Check tools');
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Worktree tool works'),
      { wait: 15_000 },
    );
  });

  it('recovers a session the adapter dropped on the next activation', async () => {
    await openThread('Continuity main');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await sendPrompt('Evict session');
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('Session evicted.'));
    await switchAwayAndBack('Continuity main', 'Continuity sibling', 1);
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await sendPrompt('Discuss interruption');
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('The previous step was interrupted, then recovered.'),
    );
  });

  it('does not restore a running Codex session when switching back', async () => {
    await openThread('Continuity codex');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    const before = restarts(codex);
    await sendPrompt('Long turn');
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('part-1 '));
    await switchAwayAndBack('Continuity codex', 'Codex sibling');
    await switchAwayAndBack('Continuity codex', 'Continuity elsewhere', 1);
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('part-60 '), {
      wait: 15_000,
    });
    expect(restarts(codex)).toBe(before);
  });
});
