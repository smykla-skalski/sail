import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function selectClaudeThread(title: string) {
  await $('.agent-menu-launch').click();
  const search = $('[aria-label="Search command palette"]');
  await search.setValue('Claude');
  await browser.keys('Enter');
  await search.setValue(title);
  await browser.keys('Enter');
}

async function activeClaudeSessions(): Promise<unknown[]> {
  return browser.execute(async () => {
    const tauri = Reflect.get(window, '__TAURI__');
    const activity: unknown = await tauri.core.invoke('acp_activity');
    if (!activity || typeof activity !== 'object') throw new Error('Missing ACP activity');
    const claude: unknown = Reflect.get(activity, 'claude');
    if (!claude || typeof claude !== 'object') throw new Error('Missing Claude activity');
    const active: unknown = Reflect.get(claude, 'active');
    if (!Array.isArray(active)) throw new Error('Missing active Claude sessions');
    return active;
  });
}

describe('ACP agent threads', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-acp-e2e-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
  });

  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true });
  });

  it('hosts Claude and Codex conversations, approvals, and restored history in Sail', async () => {
    await browser.execute((path) => {
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [] }),
      );
    }, realpathSync(repository));
    await browser.refresh();
    try {
      await expect($('.agent-launches')).toHaveText(expect.stringContaining('Claude'));
    } catch (cause) {
      console.error('ACP discovery diagnostic', {
        agents: await browser.tauri.execute(async ({ core }) => core.invoke('acp_agents')),
        sidebar: await $('.sidebar').getText(),
        page: await browser.execute(() => document.body.innerText.slice(0, 2000)),
      });
      throw cause;
    }
    await $('.agent-launches button').click();
    await expect($('.workspace .chat-area .agent-workspace')).toBeDisplayed();
    try {
      await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    } catch (cause) {
      console.error('ACP connection diagnostic', {
        agents: await browser.tauri.execute(async ({ core }) => core.invoke('acp_agents')),
        workspace: await $('.agent-workspace').getText(),
        settings: await $('.topbar-actions').getText(),
      });
      throw cause;
    }
    await expect($('.agent-picker-controls')).toHaveText(expect.stringContaining('Model'));
    await expect($('.agent-picker-controls')).toHaveText(expect.stringContaining('Effort'));
    await $('.agent-composer textarea').setValue('/');
    await expect($('.skill-menu')).toHaveText(
      expect.stringContaining('Implement and ship a GitHub issue'),
    );
    await expect($('.skill-menu')).toHaveText(expect.stringContaining('/ship-it'));
    await expect($$('.skill-menu button[role="option"]')).toBeElementsArrayOfSize(15);
    await expect($('.skill-menu')).toHaveText(expect.stringContaining('/fixture-9'));
    await $(
      "//div[contains(@class,'skill-menu')]//button[strong[normalize-space()='/review']]",
    ).click();
    expect(await $('.agent-composer textarea').getValue()).toBe('/review ');
    await $('.agent-composer textarea').setValue('/model');
    await browser.keys('Enter');
    await expect($('.option-menu[role="listbox"]')).toBeDisplayed();
    await expect($('.option-menu button[role="option"]:nth-child(2)')).toBeDisplayed();
    await browser.keys('ArrowDown');
    await browser.keys('Enter');
    await expect($('.option-trigger[aria-label^="Model:"]')).toHaveText(
      expect.stringContaining('Fast model'),
    );
    await $('.option-trigger[aria-label^="Model:"]').click();
    await $('.option-menu button[role="option"]:nth-child(3)').click();
    await $('.agent-composer textarea').setValue('Keep this draft');
    await $('.agent-actions button').click();
    await expect($('.agent-error')).toHaveText(expect.stringContaining('Model change rejected'));
    await expect($('.agent-composer textarea')).toHaveValue('Keep this draft');
    await expect($('.agent-conversation')).not.toHaveText(
      expect.stringContaining('Keep this draft'),
    );
    await $('.option-trigger[aria-label^="Model:"]').click();
    await $('.option-menu button[role="option"]:nth-child(2)').click();
    await $('.agent-composer textarea').setValue('');
    await $('.agent-composer textarea').setValue('/effort');
    await browser.keys('Enter');
    await browser.keys('ArrowDown');
    await browser.keys('Enter');
    await expect($('.option-trigger[aria-label^="Effort:"]')).toHaveText(
      expect.stringContaining('High'),
    );
    await $('.agent-composer textarea').setValue('Do a small thing');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toHaveText(expect.stringContaining('Run test action'));
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Do a small thing'),
    );
    await expect($('.option-trigger[aria-label^="Model:"]')).toHaveText(
      expect.stringContaining('Fast model'),
    );
    writeFileSync(join(repository, 'agent-change.txt'), 'Changed by agent\n');
    await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();
    await expect($('.workspace .side-area')).toHaveText(
      expect.stringContaining('agent-change.txt'),
    );
    await expect($('.review-evidence')).toHaveText(expect.stringContaining('Review evidence'));
    await expect($('.review-evidence')).toHaveText(
      expect.stringContaining('Git working tree · current'),
    );
    await expect($('.review-evidence')).toHaveText(
      expect.stringContaining('No checks recorded. Turn completion does not mean checks passed.'),
    );
    await $(
      "//section[contains(@class,'review-evidence')]//button[.//span[contains(.,'agent-change.txt')]]",
    ).click();
    await expect($('.diff-files button.active')).toHaveText(
      expect.stringContaining('agent-change.txt'),
    );
    await $('.workspace .side-area button[aria-label="Close Changes"]').click();
    await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();
    await $('.workspace .side-area .side-tabs button:nth-child(2)').click();
    await $('.workspace .side-area button[aria-label="Close Ship runs"]').click();
    await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();
    await expect($('.workspace .side-area')).toHaveText(
      expect.stringContaining('agent-change.txt'),
    );
    await $('.workspace .side-area button[aria-label="Close Changes"]').click();

    await $('.agent-launches button:nth-child(2)').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Codex'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await expect($('.agent-auth')).toHaveText(expect.stringContaining('Sign in with ChatGPT'));
    await $('.agent-auth button').click();
    await expect($('.option-trigger[aria-label^="Model:"]')).toHaveText('Test model');
    await expect($('.option-trigger[aria-label^="Effort:"]')).toHaveText('Medium');
    await $('.agent-composer textarea').setValue('Try Codex');
    await $('.agent-actions button').click();
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('Done: Try Codex'));
    await $('.agent-picker-controls .option-trigger[aria-label^="Effort:"]').click();
    await browser.keys('ArrowDown');
    await browser.keys('Enter');
    await expect($('.option-trigger[aria-label^="Effort:"]')).toHaveText(
      expect.stringContaining('High'),
    );

    try {
      await selectClaudeThread('Do a small thing');
    } catch (cause) {
      console.error('ACP thread list diagnostic', {
        sidebar: await $('.sidebar').getText(),
        threads: await browser.execute(() => localStorage.getItem('sail-agent-threads')),
      });
      throw cause;
    }
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Claude'));
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Do a small thing'),
    );
    await expect($('.option-trigger[aria-label^="Model:"]')).toHaveText(
      expect.stringContaining('Fast model'),
    );
    await expect($('.option-trigger[aria-label^="Effort:"]')).toHaveText(
      expect.stringContaining('High'),
    );
    await browser.refresh();
    try {
      await selectClaudeThread('Do a small thing');
    } catch (cause) {
      console.error('ACP reload diagnostic', {
        sidebar: await $('.sidebar').getText(),
        threads: await browser.execute(() => localStorage.getItem('sail-agent-threads')),
        directory: await browser.execute(() => localStorage.getItem('sai-directory')),
        origin: await browser.execute(() => location.origin),
        keys: await browser.execute(() => Object.keys(localStorage)),
      });
      throw cause;
    }
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Do a small thing'),
    );
    await expect($('.option-trigger[aria-label^="Model:"]')).toHaveText(
      expect.stringContaining('Fast model'),
    );
    await expect($('.option-trigger[aria-label^="Effort:"]')).toHaveText(
      expect.stringContaining('High'),
    );

    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Claude'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Delayed approval');
    await $('.agent-actions button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await expect($('.agent-working-message')).toHaveText(expect.stringContaining('Claude'));
    await expect($('.agent-working-message .agent-busy')).toHaveText(
      expect.stringContaining('Stop'),
    );
    await $('.agent-launches button:nth-child(2)').click();
    await browser.pause(1800);
    await selectClaudeThread('Delayed approval');
    await $('.agent-permission').waitForDisplayed();
    await expect($('.agent-permission')).toHaveText(expect.stringContaining('Run test action'));
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Delayed approval'),
    );

    await $('.agent-composer textarea').setValue('Escape stop');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await browser.keys('Escape');
    await expect($('.agent-permission')).not.toBeDisplayed();
    await expect($('.agent-busy')).not.toBeDisplayed();
    await expect($('.agent-tool-group')).toHaveText(expect.stringContaining('cancelled'));

    await $('.agent-composer textarea').setValue('Slow cancel');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await browser.keys('Escape');
    await expect($('.agent-tool-current')).toHaveText(expect.stringContaining('stopping'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await expect($('.agent-tool-group')).toHaveText(expect.stringContaining('cancelled'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));

    await $('.agent-composer textarea').setValue('Long answer');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    const beforeReply = await browser.execute(() => {
      const conversation = document.querySelector('.agent-conversation');
      if (!conversation) return -1;
      conversation.scrollTop = conversation.scrollHeight;
      conversation.dispatchEvent(new Event('scroll'));
      return conversation.scrollTop;
    });
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('Answer line 99'));
    expect(
      await browser.execute(() => {
        const conversation = document.querySelector('.agent-conversation');
        return conversation ? conversation.scrollHeight > conversation.clientHeight : false;
      }),
    ).toBe(true);
    expect(
      await browser.execute(() => document.querySelector('.agent-conversation')?.scrollTop ?? -1),
    ).toBeGreaterThan(beforeReply);

    await $('.agent-composer textarea').setValue('Activity demo');
    await $('.agent-actions button').click();
    await expect($('.agent-tool-current')).toBeDisplayed();
    await browser.execute(() => {
      const conversation = document.querySelector('.agent-conversation');
      if (conversation) {
        conversation.scrollTop = 0;
        conversation.dispatchEvent(new Event('scroll'));
      }
    });
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('The checks passed. The tool details are available above.'),
    );
    expect(
      await browser.execute(() => document.querySelector('.agent-conversation')?.scrollTop),
    ).toBe(0);

    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Cancel creation');
    await $('.agent-actions button').click();
    await browser.keys('Escape');
    await expect($('.agent-busy')).not.toBeDisplayed();
    await expect($('.agent-composer textarea')).toHaveValue('Cancel creation');
    await expect($('.agent-conversation')).not.toHaveText(
      expect.stringContaining('Cancel creation'),
    );

    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Disable effort');
    await $('.agent-actions button').click();
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('Disable effort'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('/effort');
    await browser.keys('Enter');
    await expect($('.option-menu')).toHaveText(
      expect.stringContaining('No choices available for this model or agent.'),
    );
  });

  it('shows nested native ACP children and restores their separate history', async () => {
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
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Claude'));
    await $('.agent-composer textarea').setValue('Native subagents');
    await $('.agent-actions button').click();
    await expect($('button[aria-label*="for Native subagents"]')).toHaveText(
      expect.stringContaining('1 historical'),
    );
    await $('button[aria-label*="for Native subagents"]').click();
    await expect($('.sidebar')).toHaveText(expect.stringContaining('Inspect native delegation'));
    await expect($('.agent-conversation')).not.toHaveText(
      expect.stringContaining('Child transcript stays separate.'),
    );

    await $(
      "//button[contains(@class,'project-agent-row') and contains(.,'Inspect native delegation')]",
    ).click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Child transcript stays separate.'),
    );
    await expect($('button[aria-label*="for Inspect native delegation"]')).toHaveText(
      expect.stringContaining('1 historical'),
    );
    await $('button[aria-label*="for Inspect native delegation"]').click();
    await expect($('.sidebar')).toHaveText(expect.stringContaining('Inspect nested delegation'));

    await browser.refresh();
    await selectClaudeThread('Native subagents');
    await expect($('button[aria-label*="for Native subagents"]')).toHaveText(
      expect.stringContaining('1 historical'),
    );
    await $('button[aria-label*="for Native subagents"]').click();
    await expect($('.sidebar')).toHaveText(expect.stringContaining('Inspect native delegation'));
    await $(
      "//button[contains(@class,'project-agent-row') and contains(.,'Inspect native delegation')]",
    ).click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Child transcript stays separate.'),
    );
  });

  it('queues a typed message until the current ACP turn finishes', async () => {
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Delayed approval');
    await $('.agent-actions button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await $('.agent-composer textarea').setValue('Queued follow-up');
    await $('.agent-actions button').click();
    await expect($('.agent-conversation .queued-messages')).toHaveText(
      expect.stringContaining('Queued follow-up'),
    );
    await expect($('.agent-permission')).toBeDisplayed();
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Delayed approval'),
    );
    await expect($('.agent-permission')).toBeDisplayed();
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Queued follow-up'),
    );
    await expect($('.queued-messages')).not.toExist();
  });

  it('keeps an active ACP turn running when closing Sail is cancelled', async () => {
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
    await $('.agent-composer textarea').setValue('Keep running during close');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();

    const activeBefore = await activeClaudeSessions();
    expect(activeBefore).toHaveLength(1);

    await browser.execute(async () => {
      const tauri = Reflect.get(window, '__TAURI__');
      await tauri.window.getCurrentWindow().close();
    });
    await expect($('.confirmation-dialog')).toHaveText(
      expect.stringContaining('Running commands stop when Sail closes'),
    );
    await $('.confirmation-dialog button:first-child').click();
    await expect($('.confirmation-dialog')).not.toBeDisplayed();
    await expect($('.agent-permission')).toBeDisplayed();

    const activeAfter = await activeClaudeSessions();
    expect(activeAfter).toEqual(activeBefore);

    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Keep running during close'),
    );
  });

  it('steers a queued message into the running ACP turn after a tool call', async () => {
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Steer demo');
    await $('.agent-actions button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await $('.agent-composer textarea').setValue('Steer follow-up');
    await $('.agent-actions button').click();
    await expect($('.agent-conversation .queued-messages')).toHaveText(
      expect.stringContaining('Steer follow-up'),
    );
    await expect($('.agent-composer textarea')).toHaveValue('');
    await expect($('.agent-composer')).not.toHaveText(expect.stringContaining('Steer follow-up'));
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Steered: Steer follow-up'),
    );
    await expect($('.agent-busy')).toBeDisplayed();
    await expect($('.queued-messages')).not.toExist();
    const steeredEntries = await browser.execute(() =>
      [...document.querySelectorAll('.agent-conversation .user-message:not(.queued-message)')]
        .map((element) => element.querySelector('.message-body')?.textContent ?? '')
        .filter((text) => text.includes('Steer follow-up')),
    );
    expect(steeredEntries).toHaveLength(1);
    const conversation = await $('.agent-conversation').getText();
    expect(conversation.indexOf('Steer follow-up')).toBeLessThan(
      conversation.indexOf('Steered: Steer follow-up'),
    );
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Steer demo finished.'),
    );
    await expect($('.agent-busy')).not.toBeDisplayed();
    await expect($('.agent-conversation')).not.toHaveText(
      expect.stringContaining('Done: Steer follow-up'),
    );
  });

  it('attributes delayed edits when steering starts a detached turn', async () => {
    const path = realpathSync(repository);
    await browser.execute((directory) => {
      localStorage.removeItem(`sai-implementation-models:${directory}`);
    }, path);
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Steer new-turn demo');
    await $('.agent-actions button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await $('.agent-composer textarea').setValue('Detached steer follow-up');
    await $('.agent-actions button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Detached steering turn started.'),
    );
    const beforeEdit = await browser.execute(
      (directory) => ({
        models: JSON.parse(localStorage.getItem(`sai-implementation-models:${directory}`) ?? '[]'),
        pending: JSON.parse(
          localStorage.getItem(`sai-implementation-pending:${directory}`) ?? '[]',
        ),
      }),
      path,
    );
    expect(beforeEdit.models).toHaveLength(0);
    expect(beforeEdit.pending.length).toBeGreaterThan(0);
    await browser.waitUntil(async () => {
      const saved = await browser.execute(
        (directory) => localStorage.getItem(`sai-implementation-models:${directory}`),
        path,
      );
      return JSON.parse(saved ?? '[]').includes('test');
    });
    const pending = await browser.execute(
      (directory) => localStorage.getItem(`sai-implementation-pending:${directory}`),
      path,
    );
    expect(JSON.parse(pending ?? '[]')).toHaveLength(0);
  });

  it('waits for both parallel tools before steering once', async () => {
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Steer parallel demo');
    await $('.agent-actions button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await $('.agent-composer textarea').setValue('Steer parallel follow-up');
    await $('.agent-actions button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('First parallel tool finished.'),
    );
    await browser.pause(500);
    await expect($('.agent-conversation .queued-messages')).toHaveText(
      expect.stringContaining('Steer parallel follow-up'),
    );
    await expect($('.agent-conversation')).not.toHaveText(
      expect.stringContaining('Steered: Steer parallel follow-up'),
    );
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Steered: Steer parallel follow-up'),
    );
    await expect($('.queued-messages')).not.toExist();
    const conversation = await $('.agent-conversation').getText();
    expect(conversation.match(/Steered: Steer parallel follow-up/g)).toHaveLength(1);
    expect(conversation.indexOf('Steer parallel follow-up')).toBeLessThan(
      conversation.indexOf('Steered: Steer parallel follow-up'),
    );
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Steer parallel demo finished.'),
    );
  });

  it('sends a queued message when the prompt finishes before steering replies', async () => {
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Steer no-response demo');
    await $('.agent-actions button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await $('.agent-composer textarea').setValue('Steer no-response follow-up');
    await $('.agent-actions button').click();
    await expect($('.agent-conversation .queued-messages')).toHaveText(
      expect.stringContaining('Steer no-response follow-up'),
    );
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Steer no-response follow-up'),
    );
    await expect($('.queued-messages')).not.toExist();
    const entries = await browser.execute(() =>
      [...document.querySelectorAll('.agent-conversation .user-message:not(.queued-message)')]
        .map((element) => element.querySelector('.message-body')?.textContent ?? '')
        .filter((text) => text.includes('Steer no-response follow-up')),
    );
    expect(entries).toHaveLength(1);
  });

  it('keeps agent messages and failures visible around grouped tool activity', async () => {
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
    await $('.agent-composer textarea').setValue('Activity failure demo');
    await $('.agent-actions button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('I recovered from the read failure'),
    );
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    const group = $('.agent-tool-group');
    await expect($$('.agent-tool-group')).toBeElementsArrayOfSize(2);
    await expect(group).toHaveText(expect.stringContaining('2 actions'));
    await expect(group).toHaveText(expect.stringContaining('Failed'));
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('The first read failed. I’m searching another path.'),
    );
    await group.$('summary').click();
    await expect(group.$$('.tool-activity')).toBeElementsArrayOfSize(2);
    await expect(group).toHaveText(expect.stringContaining('Could not read the first path.'));
  });

  it('explains a blocked ACP action and sends its latest failure to the agent', async () => {
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
    await $('.agent-composer textarea').setValue('Hook failure demo');
    await $('.agent-actions button').click();
    await expect($('.agent-tool-failure')).toBeDisplayed();
    await expect($$('.agent-tool-failure')).toBeElementsArrayOfSize(1);
    await expect($('.agent-tool-failure')).toHaveText(expect.stringContaining('GIT010'));
    await expect($('.agent-tool-failure')).toHaveText(expect.stringContaining('Add -s -S flags'));
    await $('.agent-composer textarea').setValue('Keep this context.');
    await $('.agent-tool-failure button').click();
    await $('.agent-tool-failure button').click();
    const prepared = await $('.agent-composer textarea').getValue();
    expect(prepared).toContain('Keep this context.');
    expect(prepared.match(/Rule or hook: GIT010/g)).toHaveLength(1);
    await $('.agent-actions button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('I will add the required flags.'),
    );
    const sent = await $$('.agent-conversation .user-message');
    await expect(sent.at(-1)).toHaveText(expect.stringContaining('Rule or hook: GIT010'));
  });

  it('keeps post-action hook failures distinct from blocked actions', async () => {
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
    await $('.agent-composer textarea').setValue('Post-hook failure demo');
    await $('.agent-actions button').click();
    await expect($('.agent-tool-failure')).toHaveText(
      expect.stringContaining('Post-action hook failed'),
    );
    await $('.agent-tool-failure button').click();
    const prepared = await $('.agent-composer textarea').getValue();
    expect(prepared).toContain('Check the action result before retrying it');
    expect(prepared).not.toContain('hook-blocked action');
  });

  it('shows an agent shell command and its output in tool activity', async () => {
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
    await $('.agent-composer textarea').setValue('Activity demo');
    await $('.agent-actions button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('The checks passed.'),
    );
    const group = $('.agent-tool-group');
    await group.$('summary').click();
    const command = group.$('.tool-activity-command');
    await expect(command).toHaveText('npm test');
    const tools = await group.$$('.tool-activity');
    if ((await tools.at(-1)!.getAttribute('open')) === null)
      await tools.at(-1)!.$('summary').click();
    await expect(group).toHaveText(expect.stringContaining('All checks passed.'));
  });

  it('manages the focused split thread without removing the main thread', async () => {
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
    await $('.agent-composer textarea').setValue('Main action');
    await $('.agent-actions button').click();
    await expect($('.agent-permission button')).toBeDisplayed();
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('Done: Main action'));
    await browser.keys(['Meta', 'd']);
    await expect($('.pane-leaf.focused [data-pane-picker]')).toBeDisplayed();
    await $('.agent-launches button').click();
    await $('.pane-leaf.focused .agent-composer textarea').setValue('Split action');
    await $('.pane-leaf.focused .agent-actions button').click();
    await expect($('.pane-leaf.focused .agent-permission button')).toBeDisplayed();
    await $('.pane-leaf.focused .agent-permission button').click();
    await expect($('.pane-leaf.focused .agent-conversation')).toHaveText(
      expect.stringContaining('Done: Split action'),
    );
    await $('[aria-label="Remove thread"]').click();
    const titles = await browser.execute(() =>
      JSON.parse(localStorage.getItem('sail-agent-threads') ?? '[]').map(
        (thread: { title: string }) => thread.title,
      ),
    );
    expect(titles).toContain('Main action');
    expect(titles).not.toContain('Split action');
  });
});
