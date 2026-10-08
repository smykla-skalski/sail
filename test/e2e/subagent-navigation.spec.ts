import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(path: string) {
  execFileSync('git', ['init', '-q', path]);
}

async function childRequest(): Promise<{
  agent: string;
  sessionId: string;
  requestId: number;
  generation: number;
  fingerprint: string;
}> {
  return browser.execute(async () => {
    const tauri = Reflect.get(window, '__TAURI__');
    const card = document.querySelector<HTMLElement>('.spawn-permission, .agent-permission')!;
    const sessionId = card.dataset.sessionId!;
    const pending = await tauri.core.invoke('acp_pending_permissions', {
      agent: 'claude',
      sessionId,
    });
    const message = pending[0];
    return {
      agent: 'claude',
      sessionId,
      requestId: message.id,
      generation: message.params.sailPermissionGeneration,
      fingerprint: message.params.sailPermissionFingerprint,
    };
  });
}

async function answerOutsideUi(
  request: Awaited<ReturnType<typeof childRequest>>,
  optionId: string,
) {
  return browser.execute(
    async (value, option) => {
      const tauri = Reflect.get(window, '__TAURI__');
      try {
        await tauri.core.invoke('acp_permission', {
          params: {
            agent: value.agent,
            requestId: value.requestId,
            optionId: option,
            sessionId: value.sessionId,
            requestGeneration: value.generation,
            requestFingerprint: value.fingerprint,
          },
        });
        return 'ok';
      } catch (cause) {
        return String(cause);
      }
    },
    request,
    optionId,
  );
}

describe('subagent navigation and control', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-subagent-nav-'));
  const other = mkdtempSync(join(tmpdir(), 'sail-subagent-other-'));

  before(() => {
    git(repository);
    git(other);
  });

  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  async function startChildPermission() {
    await browser.execute((path) => {
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sai-pane-layouts');
      localStorage.removeItem('sail-agent-threads');
    }, realpathSync(repository));
    await browser.refresh();
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Native child permission');
    await $('.agent-actions button').click();
    await expect($('.spawn-permission')).toBeDisplayed();
  }

  it('lists a cross-worktree child as a reference row under its parent', async () => {
    const parentPath = realpathSync(repository);
    const childPath = realpathSync(other);
    await browser.execute(
      (parent, child) => {
        localStorage.setItem('sai-directory', parent);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [parent, child], groups: [], worktrees: {} }),
        );
        localStorage.removeItem('sai-pane-layouts');
        localStorage.setItem(
          'sail-agent-threads',
          JSON.stringify([
            { agent: 'claude', directory: parent, sessionId: 'p', title: 'Planner', updated: 2 },
            { agent: 'claude', directory: child, sessionId: 'r', title: 'Reviewer', updated: 3 },
          ]),
        );
        localStorage.setItem(
          'sai-agent-spawn-receipts',
          JSON.stringify([
            {
              receiptId: 'mcp-cross',
              accessKey: '',
              requestId: 'mcp-cross',
              project: parent,
              sourceId: 'acp:claude:p',
              sourceDirectory: parent,
              targetId: 'acp:claude:r',
              turnId: null,
              targetDirectory: child,
              worktreeId: null,
              provider: 'claude',
              prompt: 'Review the plan',
              state: 'working',
              created: 1,
              updated: Date.now(),
              result: null,
              error: null,
            },
          ]),
        );
      },
      parentPath,
      childPath,
    );
    await browser.refresh();
    await browser.pause(2000);
    const reference = $('.project-agent-row[data-reference]');
    await expect(reference).toBeDisplayed();
    await expect(reference).toHaveText(expect.stringContaining('in worktree'));
    await expect($$('.project-agent-row[data-depth="1"]')[0]).toBeDisplayed();
    await expect($('.project-agent-descendants')).toHaveText('(+1)');
    await expect($('.project-agent-origin')).toHaveText(
      expect.stringContaining('spawned by Planner'),
    );
  });

  it('answers a child permission inline from the parent and shows it answered', async () => {
    await startChildPermission();
    await expect($('.spawn-stop-hint')).toHaveText(
      expect.stringContaining('Stop the parent turn to stop Claude subagents'),
    );
    await expect($('button[aria-label="Stop worker subagent"]')).not.toExist();
    await $('.spawn-permission-option.allow').click();
    await expect($('.spawn-permission-answered')).toHaveText(expect.stringContaining('Answered'));
    await expect($('.spawn-permission')).not.toExist();
  });

  it('replays a pending child permission in the child view and navigates back', async () => {
    await startChildPermission();
    await $('button.spawn-open').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await expect($('.agent-readonly')).toHaveText(
      expect.stringContaining("Read-only: the agent doesn't accept messages for subagents yet"),
    );
    await expect($('.agent-busy button')).not.toExist();
    await expect($('.agent-composer textarea')).toBeDisabled();
    await expect($('.breadcrumb-parent')).toBeDisplayed();
    await expect($('button[aria-label="Go to parent thread"]')).toBeDisplayed();

    await browser.keys(['Meta', '[']);
    await browser.keys('NULL');
    await expect($('.spawn-permission')).toBeDisplayed();
    await expect($('button[aria-label="Go to parent thread"]')).not.toExist();
  });

  it('resolves one request once and shows Answered on both surfaces', async () => {
    await startChildPermission();
    await $('button.spawn-open').click();
    await expect($('.agent-permission')).toBeDisplayed();
    const request = await childRequest();
    expect(await answerOutsideUi(request, 'allow')).toBe('ok');
    await expect($('.agent-permission-answered')).toHaveText(expect.stringContaining('Answered'));
    expect(await answerOutsideUi(request, 'allow')).toBe('ok');
    expect(await answerOutsideUi(request, 'reject')).toContain('no longer pending');
    await $('button[aria-label="Go to parent thread"]').click();
    await expect($('.spawn-permission-answered')).toHaveText(expect.stringContaining('Answered'));
  });
});
