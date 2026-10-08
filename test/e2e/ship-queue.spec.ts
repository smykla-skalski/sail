import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShipIssue, ShipRun } from '../../src/lib/issue-shipping';
import { fixture, withMergeEvidence } from '../ship-fixtures';
import { chooseTopbarAction } from './topbar';

const head = '0123456789abcdef0123456789abcdef01234567';
const moved = 'fedcba9876543210fedcba9876543210fedcba98';
const auditDirectory = process.env.SAIL_VISUAL_AUDIT_DIR;
const fakeGh = process.env.SAIL_E2E_FAKE_GH_DIR ?? '';
const hour = 60 * 60 * 1000;

const capture = async (name: string) => {
  if (!auditDirectory) return;
  mkdirSync(auditDirectory, { recursive: true });
  await browser.saveScreenshot(join(auditDirectory, `${name}.png`));
};

const setTheme = (theme: 'light' | 'dark') =>
  browser.execute((value) => {
    document.documentElement.dataset.suiTheme = value;
  }, theme);

const calls = (): { method: string; endpoint: string; fields: string[] }[] => {
  try {
    return readFileSync(join(fakeGh, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

const row = (id: string) => $(`.ship-queue tr[data-ship-issue-id="${id}"]`);

const confirm = async (title: RegExp) => {
  const dialog = $('.confirmation-dialog');
  await expect(dialog).toBeDisplayed();
  await expect(dialog.$('h2')).toHaveText(expect.stringMatching(title));
  await dialog.$('.confirmation-primary').click();
  await expect(dialog).not.toBeDisplayed();
};

const storedRuns = (): Promise<ShipRun[]> =>
  browser.tauri.execute(async ({ core }) => {
    const settings = await core.invoke<Record<string, string>>('load_settings');
    return JSON.parse(settings['sai-ship-runs'] ?? '[]');
  });

function readyIssue(id: string, number: number, pullRequest: number): ShipIssue {
  const base = fixture().issues[0];
  const evidence = withMergeEvidence(base);
  const issue = JSON.parse(
    JSON.stringify({ ...evidence, id, number }).replaceAll('revision-one', head),
  );
  return Object.assign(issue, {
    url: `https://github.com/fixture/repo/issues/${number}`,
    title: `Ready fixture ${number}`,
    branch: id,
    path: null,
    state: 'awaiting_merge',
    stage: 'awaiting_merge',
    pullRequest: `https://github.com/fixture/repo/pull/${pullRequest}`,
    pullRequestState: 'OPEN',
    pullRequestHead: head,
    pullRequestMergeable: true,
    evidenceCommit: head,
    checks: [],
    workerSettled: true,
    dependsOn: [],
  });
}

function finishedRun(id: string, at: number): ShipRun {
  const base = fixture();
  return {
    id,
    source: 'plan',
    repository: '/missing/finished',
    remote: 'fixture/old',
    provider: 'claude',
    limit: 2,
    approvedAt: at - hour,
    externalClosed: {},
    umbrella: {
      number: 90,
      title: 'Finished long ago',
      url: 'https://github.com/fixture/old/issues/90',
    },
    issues: base.issues.map((issue, index) =>
      Object.assign({}, issue, {
        id: `old-${index}`,
        number: 91 + index,
        title: `Old issue ${index + 1}`,
        state: 'merged' as const,
        path: null,
        workerSettled: true,
        checkpoint: {
          ...issue.checkpoint!,
          phase: 'complete' as const,
          status: 'completed' as const,
        },
        events: [{ at, stage: 'merged' }],
        claim: {
          id: `claim-${index}`,
          holder: 'Sail claude',
          task: `ship:${id}:old-${index}`,
          acquiredAt: new Date(at - hour).toISOString(),
          heartbeatAt: new Date(at - hour).toISOString(),
          expiresAt: new Date(at - hour).toISOString(),
          status: 'released' as const,
          releasedAt: new Date(at).toISOString(),
          releaseReason: 'merged',
          commentId: 70 + index,
        },
      }),
    ),
  };
}

describe('Ship queue, archive and actions', () => {
  const root = mkdtempSync(join(tmpdir(), 'sail-ship-queue-'));
  const repository = realpathSync(root);

  before(async () => {
    execFileSync('git', ['init', '-q', repository]);
    writeFileSync(
      join(repository, 'AGENTS.md'),
      'Merge by posting a PR comment with exact body `squash`; the bot merges.\n',
    );
    writeFileSync(
      join(fakeGh, 'state.json'),
      JSON.stringify({
        repository: 'fixture/repo',
        pulls: {
          'fixture/repo#7': { state: 'open', merged: false, draft: false, head },
          'fixture/repo#8': { state: 'open', merged: false, draft: false, head: moved },
        },
      }),
    );
    const now = Date.now();
    const checkpoint = (issue: ShipIssue, status: 'active' | 'failed') => ({
      ...fixture().issues[0].checkpoint!,
      taskId: issue.id,
      sequence: 3,
      revision: head,
      status,
      phase: 'implement' as const,
    });
    const failed: ShipIssue = {
      ...fixture().issues[1],
      id: 'failed',
      number: 12,
      title: 'Failed fixture',
      url: 'https://github.com/fixture/repo/issues/12',
      dependsOn: ['fixture/other#900'],
      state: 'failed',
      branch: 'failed',
      path: null,
      error: 'Worker failed.',
      workerSettled: true,
    };
    failed.checkpoint = checkpoint(failed, 'failed');
    const pending: ShipIssue = {
      ...fixture().issues[1],
      id: 'queued',
      number: 13,
      title: 'Queued fixture',
      url: 'https://github.com/fixture/repo/issues/13',
      dependsOn: ['fixture/other#900'],
      state: 'pending',
      branch: 'queued',
      path: null,
    };
    pending.checkpoint = checkpoint(pending, 'active');
    const active: ShipRun = {
      id: 'active-run',
      source: 'plan',
      repository,
      remote: 'fixture/repo',
      provider: 'claude',
      limit: 3,
      approvedAt: now - 2 * hour,
      externalClosed: {},
      umbrella: {
        number: 10,
        title: 'Queue fixture',
        url: 'https://github.com/fixture/repo/issues/10',
      },
      issues: [readyIssue('ready', 11, 7), readyIssue('moved', 14, 8), failed, pending],
    };
    const stoppable: ShipRun = {
      ...active,
      id: 'stoppable-run',
      approvedAt: now - hour,
      limit: 2,
      umbrella: {
        number: 20,
        title: 'Stoppable fixture',
        url: 'https://github.com/fixture/repo/issues/20',
      },
      issues: [
        { ...pending, id: 'stop-a', number: 21, title: 'Stop fixture A', branch: 'stop-a' },
        { ...pending, id: 'stop-b', number: 22, title: 'Stop fixture B', branch: 'stop-b' },
      ],
    };
    const old = finishedRun('finished-run', Date.parse('2026-01-01T00:00:00Z'));
    await browser.tauri.execute(
      async ({ core }, input) => {
        await core.invoke('save_setting', {
          key: 'sai-ship-runs',
          value: JSON.stringify(input.runs),
        });
        await core.invoke('save_setting', { key: 'sai-ship-archive-migrated-v1', value: null });
        await core.invoke('save_setting', { key: 'sai-ship-archive-notice', value: null });
        await core.invoke('save_setting', { key: 'sai-ship-archive-delay', value: '1d' });
        await core.invoke('save_setting', {
          key: 'sai-project-catalog',
          value: JSON.stringify({ repositories: [input.repository], groups: [], worktrees: {} }),
        });
        await core.invoke('save_setting', { key: 'sai-directory', value: input.repository });
        await core.invoke('save_setting', { key: 'sai-workspace-view', value: 'workspace' });
      },
      { runs: [active, stoppable, old], repository },
    );
    await browser.execute(() => {
      localStorage.clear();
      localStorage.setItem('sail-settings-migrated-v1', '1');
      sessionStorage.setItem('sail-e2e-settings', 'enabled');
    });
    await browser.setWindowSize(1280, 850);
    await browser.refresh();
    await expect($('.app-shell')).toBeDisplayed();
  });

  after(async () => {
    await browser.execute(() => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.clear();
    });
    rmSync(root, { recursive: true, force: true });
  });

  it('archives qualifying runs on upgrade, keeps their data and shows the count', async () => {
    await chooseTopbarAction('More actions', 'Ship queue');
    await expect($('.ship-queue')).toBeDisplayed();
    await expect($('[data-ship-archive-notice]')).toHaveText(
      expect.stringContaining('1 run archived'),
    );
    expect(await storedRuns()).toHaveLength(3);
    const finished = (await storedRuns()).find((run) => run.id === 'finished-run')!;
    expect(finished.archivedBy).toBe('auto');
    expect(finished.issues).toHaveLength(2);
    expect(finished.issues[0].checkpoint?.status).toBe('completed');
    await expect($('.ship-queue')).not.toHaveText(expect.stringContaining('Old issue 1'));
    await $('[data-ship-archive-notice] button=Show').click();
    await expect($('.ship-queue')).toHaveText(expect.stringContaining('Old issue 1'));
    await expect($('[data-ship-archive-notice]')).not.toExist();
  });

  it('unarchive returns the run to the list and keeps it there', async () => {
    await $('.ship-queue [data-ship-action="unarchive"]').click();
    await expect($('[data-ship-result]')).toHaveText(expect.stringContaining('Run restored'));
    await $('.queue-filters button*=Active').click();
    await $('.queue-check input').click();
    await expect(row('old-0')).toBeDisplayed();
    await browser.pause(1500);
    const run = (await storedRuns()).find((item) => item.id === 'finished-run')!;
    expect(run.archivedAt).toBeUndefined();
    expect(run.unarchivedAt).toBeGreaterThan(0);
    await $('.queue-check input').click();
  });

  it('lists issues from every run, needs-input first, with worker pool usage', async () => {
    const ids = await $$('.ship-queue tbody tr').map((entry) =>
      entry.getAttribute('data-ship-issue-id'),
    );
    expect(ids).toContain('ready');
    expect(ids).toContain('stop-a');
    expect(ids).not.toContain('old-0');
    expect(ids.indexOf('failed')).toBeLessThan(ids.indexOf('queued'));
    await expect($('[data-testid="ship-pool"]')).toHaveText(expect.stringContaining('workers'));
    await $('.queue-filters select').selectByVisibleText('Stoppable fixture · fixture/repo');
    await expect($$('.ship-queue tbody tr')).toBeElementsArrayOfSize(2);
    await $('.queue-filters select').selectByIndex(0);
    await setTheme('light');
    await capture('ship-queue-light');
    await setTheme('dark');
    await capture('ship-queue-dark');
    await setTheme('light');
  });

  it('merge posts exactly the repository comment after confirmation', async () => {
    await row('ready').$('[data-ship-action="merge"]').click();
    await confirm(/Merge #11 Ready fixture 11\?/);
    await expect($('[data-ship-result]')).toHaveText(expect.stringContaining('Posted “squash”'));
    const posted = calls();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      method: 'POST',
      endpoint: 'repos/fixture/repo/issues/7/comments',
      fields: ['body=squash'],
    });
    expect(JSON.stringify(posted)).not.toContain('admin');
    expect(JSON.stringify(posted)).not.toContain('/merge');
  });

  it('merge refuses when the pull request head moved past the checkpoint revision', async () => {
    await row('moved').$('[data-ship-action="merge"]').click();
    await confirm(/Merge #14 Ready fixture 14\?/);
    await expect($('[data-ship-result]')).toHaveText(
      expect.stringContaining('differs from the checkpoint revision'),
    );
    expect(calls()).toHaveLength(1);
  });

  it('declining the confirmation merges nothing', async () => {
    await row('ready').$('[data-ship-action="merge"]').click();
    const dialog = $('.confirmation-dialog');
    await expect(dialog).toBeDisplayed();
    await dialog.$('button=Cancel').click();
    await expect(dialog).not.toBeDisplayed();
    expect(calls()).toHaveLength(1);
  });

  it('retry queues a failed issue again from its saved checkpoint', async () => {
    await row('failed').$('[data-ship-action="retry"]').click();
    await confirm(/Retry #12 Failed fixture\?/);
    await expect($('[data-ship-result]')).toHaveText(expect.stringContaining('Retry queued'));
    await browser.waitUntil(async () => {
      const issue = (await storedRuns())
        .find((run) => run.id === 'active-run')
        ?.issues.find((item) => item.id === 'failed');
      return issue?.state === 'pending' && issue.retryCount === 1;
    });
    const issue = (await storedRuns())
      .find((run) => run.id === 'active-run')!
      .issues.find((item) => item.id === 'failed')!;
    expect(issue.error).toBeNull();
    expect(issue.checkpoint?.status).toBe('active');
    expect(issue.checkpoint?.sequence).toBe(4);
    await expect(row('failed').$('[data-ship-action="retry"]')).not.toExist();
  });

  it('stop run cancels every unfinished issue, then archive hides the run', async () => {
    await $('.queue-filters select').selectByVisibleText('Stoppable fixture · fixture/repo');
    await expect($('.queue-run-actions [data-ship-action="archive"]')).toBeDisabled();
    await $('.queue-run-actions [data-ship-action="stop"]').click();
    const dialog = $('.confirmation-dialog');
    await expect(dialog.$('h2')).toHaveText(expect.stringContaining('Stoppable fixture'));
    await expect(dialog.$('.confirmation-primary')).toHaveAttribute('data-variant', 'danger');
    await dialog.$('.confirmation-primary').click();
    await expect($('[data-ship-result]')).toHaveText(expect.stringContaining('Run stopped'));
    const run = (await storedRuns()).find((item) => item.id === 'stoppable-run')!;
    for (const issue of run.issues) {
      expect(issue.state).toBe('failed');
      expect(issue.error).toBe('Stopped by you.');
      expect(issue.cancelledAt).toBeGreaterThan(0);
      expect(issue.checkpoint?.status).toBe('cancelled');
    }
    await expect($('.queue-run-actions [data-ship-action="stop"]')).toBeDisabled();
    await $('.queue-run-actions [data-ship-action="archive"]').click();
    await confirm(/Archive Stoppable fixture\?/);
    await expect($('[data-ship-result]')).toHaveText(expect.stringContaining('Run archived'));
    expect((await storedRuns()).find((item) => item.id === 'stoppable-run')?.archivedBy).toBe(
      'user',
    );
    await $('.queue-filters button*=Archived').click();
    await expect(row('stop-a')).toBeDisplayed();
    await $('.ship-queue tbody [data-ship-action="unarchive"]').click();
    await expect($('[data-ship-result]')).toHaveText(expect.stringContaining('Run restored'));
  });

  it('the Ship panel offers the same archive filter and run actions', async () => {
    await chooseTopbarAction('More actions', 'Back to workspace');
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true }),
      ),
    );
    await expect($('.ship-panel')).toBeDisplayed();
    await $('.ship-scope button*=Archived').click();
    await expect($('.ship-panel')).toHaveText(expect.stringContaining('No archived runs'));
    await $('.ship-scope button*=Active').click();
    await expect($('.ship-panel [data-ship-action="stop"]')).toBeDisplayed();
  });
});
