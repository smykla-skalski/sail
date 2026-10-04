import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function completeTurn(text: string) {
  await $('.agent-composer textarea').setValue(text);
  await $('.agent-actions button').click();
  await expect($('.agent-permission')).toBeDisplayed();
  await $('.agent-permission button').click();
  await expect($('.agent-conversation')).toHaveText(expect.stringContaining(`Done: ${text}`));
}

describe('post-turn checks', () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'sail-post-turn-')));
  const repositoryCommand = "printf 'repository check'; printf 'run\\n' >> repository-runs.txt";
  const personalCommand = "printf 'personal check'; printf 'run\\n' >> personal-runs.txt; exit 7";

  before(async () => {
    execFileSync('git', ['init', '-q', repository]);
    mkdirSync(join(repository, '.sail'));
    writeFileSync(
      join(repository, '.sail', 'worktree.json'),
      JSON.stringify({ postTurnChecks: [repositoryCommand] }),
    );
    execFileSync('git', ['-C', repository, 'add', '.sail/worktree.json']);
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'baseline',
    ]);
    await browser.execute(
      (path, personal) => {
        sessionStorage.setItem('sail-e2e-settings', 'enabled');
        localStorage.setItem('sai-directory', path);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [path], groups: [] }),
        );
        localStorage.setItem('sai-post-turn-personal', JSON.stringify([personal]));
      },
      repository,
      personalCommand,
    );
    await browser.refresh();
    await expect($('.agent-launches')).toHaveText(expect.stringContaining('Claude'));
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
  });

  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true });
  });

  it('reviews repository commands, runs both sources, and retries a failed check', async () => {
    await completeTurn('Approval preview');
    await expect($('.confirmation-dialog')).toHaveText(expect.stringContaining(repositoryCommand));
    await browser.execute(
      async (path, command) => {
        const tauri = Reflect.get(window, '__TAURI__');
        await tauri.core.invoke('approve_post_turn_check', { directory: path, command });
      },
      repository,
      repositoryCommand,
    );
    await browser.refresh();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Claude'));
    await completeTurn('Check turn');
    try {
      await browser.waitUntil(
        () =>
          existsSync(join(repository, 'repository-runs.txt')) &&
          existsSync(join(repository, 'personal-runs.txt')) &&
          readFileSync(join(repository, 'personal-runs.txt'), 'utf8') === 'run\nrun\n',
      );
    } catch (cause) {
      console.error('Post-turn diagnostic', {
        conversation: await $('.agent-conversation').getText(),
        alerts: await browser.execute(() => document.body.innerText.slice(-3000)),
        history: await browser.execute(async () => {
          const tauri = Reflect.get(window, '__TAURI__');
          return tauri.core.invoke('list_post_turn_checks');
        }),
      });
      throw cause;
    }
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('repository check'));
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('personal check'));
    expect(readFileSync(join(repository, 'repository-runs.txt'), 'utf8')).toBe('run\n');
    await $('.post-turn-check button').click();
    await browser.waitUntil(
      () => readFileSync(join(repository, 'personal-runs.txt'), 'utf8') === 'run\nrun\nrun\n',
    );
    expect(readFileSync(join(repository, 'repository-runs.txt'), 'utf8')).toBe('run\n');
    await browser.refresh();
    const repeated = await browser.execute(
      async (path, command) => {
        const tauri = Reflect.get(window, '__TAURI__');
        const checks: unknown = await tauri.core.invoke('list_post_turn_checks');
        if (!Array.isArray(checks)) throw new Error('Check history missing');
        const check: unknown = checks.find(
          (item: unknown) =>
            item !== null &&
            typeof item === 'object' &&
            Reflect.get(item, 'directory') === path &&
            Reflect.get(item, 'command') === command &&
            Reflect.get(item, 'source') === 'repository',
        );
        if (!check || typeof check !== 'object') throw new Error('Repository result missing');
        return tauri.core.invoke('run_post_turn_check', {
          request: { ...check, retry: false },
        });
      },
      repository,
      repositoryCommand,
    );
    expect(repeated.status).toBe('passed');
    expect(readFileSync(join(repository, 'repository-runs.txt'), 'utf8')).toBe('run\n');
    const statuses = await browser.execute(() =>
      Object.values(JSON.parse(localStorage.getItem('sai-thread-attention') ?? '{}')).map(
        (item: unknown) => (item && typeof item === 'object' ? Reflect.get(item, 'status') : null),
      ),
    );
    expect(statuses).toContain('done');
  });

  it('runs personal checks when repository config is invalid', async () => {
    writeFileSync(join(repository, '.sail', 'worktree.json'), '{');
    await completeTurn('Invalid config turn');
    await browser.waitUntil(
      () => readFileSync(join(repository, 'personal-runs.txt'), 'utf8') === 'run\nrun\nrun\nrun\n',
    );
    await expect($('.notice.error')).toHaveText(
      expect.stringContaining('Could not load repository post-turn checks'),
    );
  });
});
