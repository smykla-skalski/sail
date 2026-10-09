import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function openSidebarThreadWithin(title: string) {
  await browser.execute((threadTitle) => {
    Reflect.set(window, '__switchStart', performance.now());
    const visible = () =>
      document.querySelector('.agent-header')?.textContent?.includes(threadTitle) ?? false;
    const observer = new MutationObserver(() => {
      if (!visible()) return;
      Reflect.set(window, '__switchVisible', performance.now());
      observer.disconnect();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    [...document.querySelectorAll<HTMLButtonElement>('.project-agent-row')]
      .find((row) => row.getAttribute('aria-label')?.includes(threadTitle))
      ?.click();
    if (visible()) {
      Reflect.set(window, '__switchVisible', performance.now());
      observer.disconnect();
    }
  }, title);
  await expect($('.agent-header')).toHaveText(expect.stringContaining(title));
  await browser.waitUntil(async () =>
    browser.execute(() => Reflect.has(window, '__switchVisible')),
  );
  const result = await browser.execute(() => ({
    elapsed:
      Number(Reflect.get(window, '__switchVisible')) - Number(Reflect.get(window, '__switchStart')),
    selected: document.querySelector('.project-agent-row.active')?.getAttribute('aria-label'),
  }));
  console.log('OpenCode ACP sidebar switch', { title, ...result });
  expect(result.selected).toContain(title);
  expect(result.elapsed).toBeLessThan(500);
  await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
}

describe('agent switching', () => {
  const currentRepository = mkdtempSync(join(tmpdir(), 'sail-switch-current-'));
  const targetRepository = mkdtempSync(join(tmpdir(), 'sail-switch-target-'));
  const openCodeWorkers = ['OpenCode worker one', 'OpenCode worker two', 'OpenCode worker three'];

  before(() => {
    execFileSync('git', ['init', '-q', currentRepository]);
    execFileSync('git', ['init', '-q', targetRepository]);
  });

  after(() => {
    rmSync(currentRepository, { recursive: true, force: true });
    rmSync(targetRepository, { recursive: true, force: true });
  });

  it('opens and switches three working OpenCode ACP threads within 500 ms', async () => {
    const current = realpathSync(currentRepository);
    const target = realpathSync(targetRepository);
    await browser.execute((path) => sessionStorage.setItem('sai-e2e-switch-target', path), target);
    const sessions = await browser.tauri.execute(async ({ core }, titles) => {
      const path = sessionStorage.getItem('sai-e2e-switch-target');
      if (!path) throw new Error('Missing target repository');
      await core.invoke('acp_connect', { agent: 'opencode' });
      return Promise.all(
        titles.map((title) =>
          core.invoke<{ sessionId: string }>('acp_new_session', {
            params: { agent: 'opencode', cwd: path, title },
          }),
        ),
      );
    }, openCodeWorkers);
    await browser.execute(
      ({ current: selectedPath, target: targetPath, sessions: created, titles }) => {
        sessionStorage.removeItem('sai-e2e-switch-target');
        localStorage.setItem('sai-directory', selectedPath);
        localStorage.removeItem('sai-pane-layouts');
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [selectedPath, targetPath], groups: [], worktrees: {} }),
        );
        localStorage.setItem(
          'sail-agent-threads',
          JSON.stringify(
            created.map((session, index) => ({
              agent: 'opencode',
              sessionId: session.sessionId,
              directory: targetPath,
              title: titles[index],
              updated: Date.now() - index,
            })),
          ),
        );
      },
      { current, target, sessions, titles: openCodeWorkers },
    );
    await browser.tauri.execute(async ({ core }, created) => {
      for (const [index, session] of created.entries())
        void core.invoke('acp_prompt', {
          params: {
            agent: 'opencode',
            sessionId: session.sessionId,
            text: 'Sidebar performance turn',
            turnId: `opencode-sidebar-${index}`,
            imagePaths: [],
          },
        });
    }, sessions);
    await browser.refresh();
    await expect($('.project-agent-row[aria-label*="OpenCode worker one"]')).toBeDisplayed();
    await expect($('.project-agent-row[aria-label*="OpenCode worker two"]')).toBeDisplayed();
    await expect($('.project-agent-row[aria-label*="OpenCode worker three"]')).toBeDisplayed();
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          [...document.querySelectorAll('.project-agent-row')]
            .filter((row) => row.getAttribute('aria-label')?.includes('OpenCode worker'))
            .every((row) => row.getAttribute('aria-label')?.includes('Working')),
        ),
      { timeoutMsg: 'OpenCode workers did not remain working before the sidebar timing check' },
    );

    await openSidebarThreadWithin(openCodeWorkers[0]);
    await openSidebarThreadWithin(openCodeWorkers[1]);
    await openSidebarThreadWithin(openCodeWorkers[2]);
    await browser.tauri.execute(
      async ({ core }, created) =>
        Promise.all(
          created.map((session) =>
            core.invoke('acp_cancel', {
              agent: 'opencode',
              sessionId: session.sessionId,
              turnId: null,
            }),
          ),
        ),
      sessions,
    );
  });

  it('rejects a saved thread after its selected worktree is removed outside Sail', async () => {
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('New thread'));
    rmSync(targetRepository, { recursive: true, force: true });

    await $('.agent-menu-launch').click();
    const search = $('[aria-label="Search command palette"]');
    await search.setValue('OpenCode');
    await browser.keys('Enter');
    await search.setValue(openCodeWorkers[0]);
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

async function conversationText(rendered = -1, attempts = 40): Promise<string> {
  const count = await browser.execute(() => {
    const scroll = document.querySelector<HTMLElement>('.agent-conversation');
    if (!scroll) return 0;
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event('scroll'));
    return scroll.querySelectorAll('*').length;
  });
  if (count === rendered || attempts === 0) return $('.agent-conversation').getText();
  await browser.pause(250);
  return conversationText(count, attempts - 1);
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

function expectEachOnce(text: string, prefix: string, last: number) {
  const missing: number[] = [];
  const repeated: number[] = [];
  for (let index = 1; index <= last; index += 1) {
    const count = occurrences(text, `${prefix}${index} `);
    if (count === 0) missing.push(index);
    if (count > 1) repeated.push(index);
  }
  expect({ prefix, missing, repeated }).toEqual({ prefix, missing: [], repeated: [] });
}

async function sendPrompt(text: string) {
  await $('.agent-composer textarea').setValue(text);
  await $("//*[contains(@class,'agent-actions')]//button[contains(.,'Send')]").click();
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
            params: { agent: thread.agent, cwd: thread.directory },
          }),
        ),
      );
      return created.map((session) => session.sessionId);
    });
    await browser.execute(
      (saved, personalCheck, directories) => {
        sessionStorage.removeItem('sai-e2e-continuity-threads');
        sessionStorage.setItem('sail-e2e-settings', 'enabled');
        // A shared webview keeps the migration marker between runs, and a migrated start wipes
        // these keys before the app reads them.
        localStorage.removeItem('sail-settings-migrated-v1');
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
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await expect($('.agent-picker-controls')).toHaveText(expect.stringContaining('Test model'));
    expect(restarts(first)).toBe(0);
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

  it('shows the whole live turn after switching back during a flood of updates', async () => {
    await openThread('Continuity main');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    const before = restarts(first);
    const promptsBefore = occurrences(await conversationText(), 'Flood turn');
    await sendPrompt('Flood turn');
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('Flood waiting.'));
    await openThread('Continuity sibling');
    writeFileSync(join(first, 'flood-go.txt'), 'go\n');
    await browser.waitUntil(() => existsSync(join(first, 'flood-sent.txt')), {
      timeout: 20_000,
      timeoutMsg: 'The test agent did not send the flood',
    });
    await browser.pause(1000);
    await openThread('Continuity main');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await expect($('.agent-history-gap')).not.toBeExisting();
    const live = await conversationText();
    expect(occurrences(live, 'Flood turn')).toBe(promptsBefore + 1);
    expect(occurrences(live, 'Flood waiting.')).toBe(1);
    expectEachOnce(live, 'msg-', 90);
    expectEachOnce(live, 'long-', 40);
    expectEachOnce(live, 'f-', 2600);
    expect(restarts(first)).toBe(before);
    writeFileSync(join(first, 'flood-release.txt'), 'release\n');
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('Flood finished.'), {
      wait: 15_000,
    });
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    const finished = await conversationText();
    expect(occurrences(finished, 'Flood turn')).toBe(promptsBefore + 1);
    expectEachOnce(finished, 'f-', 2600);
    expect(restarts(first)).toBe(before);
  });

  it('marks the capped view after an app reload until the turn ends', async () => {
    await openThread('Continuity main');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    const before = restarts(first);
    const earlier = await conversationText();
    await sendPrompt('Long turn');
    await browser.waitUntil(
      async () =>
        occurrences(await $('.agent-conversation').getText(), 'part-3 ') >
        occurrences(earlier, 'part-3 '),
    );
    await browser.refresh();
    await openThread('Continuity main');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await expect($('.agent-history-gap')).toHaveText('Earlier messages load when this turn ends.');
    expect(restarts(first)).toBe(before);
    await expect($('.agent-history-gap')).not.toBeExisting({ wait: 45_000 });
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'), {
      wait: 15_000,
    });
    const transcript = await conversationText();
    expect(occurrences(transcript, 'Long turn')).toBe(occurrences(earlier, 'Long turn') + 1);
    for (let part = 1; part <= 60; part += 1)
      expect(occurrences(transcript, `part-${part} `)).toBe(
        occurrences(earlier, `part-${part} `) + 1,
      );
    expect(restarts(first)).toBe(before);
  });

  it('lets background work finish after switching away and back', async () => {
    await openThread('Continuity main');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await sendPrompt('Background task');
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Background task started.'),
    );
    await switchAwayAndBack('Continuity main', 'Continuity sibling');
    await switchAwayAndBack('Continuity main', 'Continuity elsewhere');
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Background task started. Background task finished.'),
      { wait: 15_000 },
    );
    const background = await $('.agent-conversation').getText();
    expect(background.split('Background task finished.').length - 1).toBe(1);
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
      wait: 30_000,
    });
    expect(restarts(codex)).toBe(before);
  });

  it('keeps the parent transcript after visiting its native child', async () => {
    await openThread('Continuity main');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await sendPrompt('Second live subagent');
    const child =
      "//button[contains(@class,'project-agent-row') and contains(.,'Inspect second delegation')]";
    await expect($(child)).toHaveText(expect.stringContaining('Working'));
    await $(child).click();
    await expect($('.agent-header')).toHaveText(
      expect.stringContaining('Inspect second delegation'),
    );
    await browser.pause(1500);
    await openThread('Continuity main');
    const kept = await conversationText();
    expect(occurrences(kept, 'Second live subagent')).toBe(1);
    const streamed = [...kept.matchAll(/second-(\d+) /g)].map((match) => Number(match[1]));
    expect(streamed.length).toBeGreaterThan(1);
    expect(Math.min(...streamed)).toBe(1);
    for (const part of streamed) expect(kept.split(`second-${part} `).length - 1).toBe(1);
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Second subagent finished.'),
      { wait: 20_000 },
    );
    expect(restarts(first)).toBe(0);
  });
});
