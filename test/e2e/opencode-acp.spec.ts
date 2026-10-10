import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseTopbarAction, topbarMenuTrigger } from './topbar';

describe('OpenCode in the ACP pane', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-opencode-acp-'));
  let path = '';

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
    path = realpathSync(repository);
    writeFileSync(
      join(path, '.acp-external-sessions.json'),
      JSON.stringify([
        {
          sessionId: 'ses_outside_1',
          title: 'Started in terminal',
          updatedAt: '2026-01-03T00:00:00Z',
        },
        { sessionId: 'ses_outside_2', title: 'Second outside', updatedAt: '2026-01-02T00:00:00Z' },
        { sessionId: 'ses_outside_3', title: 'Third outside', updatedAt: '2026-01-01T00:00:00Z' },
      ]),
    );
  });
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('migrates legacy OpenCode state once and lists sessions started outside Sail', async () => {
    await browser.execute((directory) => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sai-opencode-acp-migrated');
      localStorage.removeItem('sai-pane-layouts');
      localStorage.setItem(
        'sai-recent-native-threads',
        JSON.stringify([
          {
            agent: 'opencode',
            directory,
            sessionId: 'ses_outside_1',
            title: 'Started in terminal',
            updated: 5,
          },
        ]),
      );
      localStorage.setItem(`sai-session:${directory}`, 'ses_outside_1');
      localStorage.setItem(
        'sai-agent-spawn-receipts',
        JSON.stringify([
          {
            receiptId: 'legacy',
            accessKey: 'k',
            requestId: 'r',
            project: directory,
            sourceId: 'opencode:ses_outside_1',
            sourceDirectory: directory,
            targetId: 'opencode:ses_outside_2',
            turnId: null,
            targetDirectory: directory,
            worktreeId: null,
            provider: 'opencode',
            prompt: null,
            state: 'completed',
            created: 1,
            updated: 1,
            result: null,
            error: null,
          },
        ]),
      );
    }, path);
    await browser.refresh();
    await expect(topbarMenuTrigger('New agent')).toBeDisplayed();

    await expect($('.agent-header')).toHaveText(expect.stringContaining('OpenCode'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Started in terminal'));
    await expect($('.agent-composer [data-pane-prompt]')).toBeEnabled();

    const migrated = await browser.execute(() => ({
      marker: localStorage.getItem('sai-opencode-acp-migrated'),
      native: localStorage.getItem('sai-recent-native-threads'),
      session: Object.keys(localStorage).filter((key) => key.startsWith('sai-session:')),
      threads: localStorage.getItem('sail-agent-threads'),
      receipts: localStorage.getItem('sai-agent-spawn-receipts'),
    }));
    expect(migrated.marker).toBe('1');
    expect(migrated.native).toBeNull();
    expect(migrated.session).toEqual([]);
    expect(migrated.threads).toContain('ses_outside_1');
    expect(migrated.receipts).toContain('acp:opencode:ses_outside_2');
    expect(migrated.receipts).not.toContain('"opencode:ses_outside_2"');

    await browser.waitUntil(async () => (await $$('.project-agent-row')).length >= 3, {
      timeoutMsg: 'paged OpenCode sessions did not all reach the sidebar',
    });
    await Promise.all(
      ['Started in terminal', 'Second outside', 'Third outside'].map((title) =>
        expect($(`.project-agent-row[aria-label*="${title}"]`)).toBeDisplayed(),
      ),
    );
  });

  it('switches the pane on click and keeps a Sail-local rename', async () => {
    await $('.project-agent-row[aria-label*="Third outside"]').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Third outside'));
    await expect($('.agent-composer [data-pane-prompt]')).toBeEnabled();
    await expect($('.agent-error')).not.toExist();

    await chooseTopbarAction('More actions', 'Rename');
    const title = $('input[aria-label="Session title"]');
    await expect(title).toBeDisplayed();
    await title.setValue('Renamed in Sail');
    await $('.rename-session-dialog button[type="submit"]').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Renamed in Sail'));
    await expect($('.project-agent-row[aria-label*="Renamed in Sail"]')).toBeDisplayed();

    await browser.refresh();
    await expect($('.project-agent-row[aria-label*="Renamed in Sail"]')).toBeDisplayed();
    await expect($('.project-agent-row[aria-label*="Third outside"]')).not.toExist();
  });

  it('lists each OpenCode session once in the Switch thread palette after opening it', async () => {
    await $('.project-agent-row[aria-label*="Second outside"]').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Second outside'));
    await chooseTopbarAction('More actions', 'Switch thread');
    const search = $('[aria-label="Search command palette"]');
    await search.setValue('OpenCode');
    await browser.keys('Enter');
    await expect($('.palette-entry[data-kind="thread"]')).toBeDisplayed();
    const labels = await browser.execute(() =>
      [...document.querySelectorAll('.palette-entry[data-kind="thread"]')].map(
        (entry) => entry.textContent ?? '',
      ),
    );
    expect(labels.filter((label) => label.includes('Second outside'))).toHaveLength(1);
    await browser.keys('Escape');
  });

  it('renders OpenCode in a split pane through the same workspace', async () => {
    await browser.execute((directory) => {
      localStorage.setItem(
        'sai-pane-layouts',
        JSON.stringify({
          [directory]: {
            id: 'root',
            direction: 'row',
            ratio: 0.5,
            first: { id: 'main', agent: 'opencode', thread: null },
            second: {
              id: 'right',
              agent: 'opencode',
              thread: {
                agent: 'opencode',
                directory,
                sessionId: 'ses_outside_2',
                title: 'Second outside',
                updated: 2,
              },
            },
          },
        }),
      );
    }, path);
    await browser.refresh();
    await browser.waitUntil(async () => (await $$('.pane-leaf')).length === 2);
    expect((await $$('.pane-leaf .agent-composer [data-pane-prompt]')).length).toBe(2);
    await expect($('.pane-leaf[data-pane-id="right"] .agent-header')).toHaveText(
      expect.stringContaining('Second outside'),
    );
  });
});
