import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openSettings, returnToWorkspace } from './settings-window';

const root = mkdtempSync(join(tmpdir(), 'sail-memory-import-e2e-'));
const repository = resolve(root, 'repository');
const claudeConfig = process.env.CLAUDE_CONFIG_DIR;

function projectName(path: string) {
  return path.replace(/[^a-z0-9]/gi, '-');
}

describe('agent memory import', () => {
  before(async () => {
    if (!claudeConfig) throw new Error('Set a private CLAUDE_CONFIG_DIR for this test.');
    mkdirSync(repository, { recursive: true });
    execFileSync('git', ['init', '-q', repository]);
    const canonicalRepository = realpathSync(repository);
    const memory = join(claudeConfig, 'projects', projectName(canonicalRepository), 'memory');
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, 'MEMORY.md'), 'Use local clusters for acceptance tests.');
    writeFileSync(join(memory, 'project-note.md'), 'Use local clusters for acceptance tests.');
    await browser.execute((directory) => {
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem('sai-theme', 'system');
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [] }),
      );
    }, canonicalRepository);
    await browser.refresh();
    await browser.tauri.execute(async ({ core }) => {
      const directory = localStorage.getItem('sai-directory');
      const projectKey = await core.invoke<string>('memory_project_key', { directory });
      await core.invoke('save_setting', { key: `sai-memory-mode:${projectKey}`, value: 'sail' });
    });
  });

  after(async () => {
    if ((await browser.tauri.listWindows()).includes('settings')) await returnToWorkspace();
    rmSync(root, { recursive: true, force: true });
  });

  it('previews local notes and imports each once', async () => {
    await openSettings();
    await $('.settings-navigation button:nth-child(4)').click();
    await expect($('button=Import all')).toBeDisplayed();
    await expect($('.memory-import-choice')).not.toExist();
    await [
      [2560, 1440],
      [1920, 1200],
      [390, 850],
    ].reduce<Promise<void>>(async (previous, [width, height]) => {
      await previous;
      await browser.setWindowSize(width, height);
      const actual = await browser.execute(() => innerWidth);
      console.log(`Memory import view: requested ${width}, actual ${actual}`);
      expect(
        await browser.execute(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      if (width === 2560 && process.env.SAIL_VISUAL_AUDIT_DIR) {
        await browser.tauri.execute(async ({ core }) =>
          core.invoke('plugin:window|set_theme', { label: 'settings', value: 'light' }),
        );
        await browser.saveScreenshot(
          join(process.env.SAIL_VISUAL_AUDIT_DIR, 'memory-import-light.png'),
        );
        await browser.tauri.execute(async ({ core }) =>
          core.invoke('plugin:window|set_theme', { label: 'settings', value: 'dark' }),
        );
        await browser.saveScreenshot(
          join(process.env.SAIL_VISUAL_AUDIT_DIR, 'memory-import-dark.png'),
        );
      }
    }, Promise.resolve());
    await browser.setWindowSize(1920, 1200);
    await browser.execute(() => {
      document.documentElement.style.zoom = '2';
    });
    expect(
      await browser.execute(() => document.documentElement.scrollWidth <= innerWidth + 1),
    ).toBe(true);
    await browser.execute(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'Import all')
        ?.focus();
    });
    expect(await browser.execute(() => document.activeElement?.textContent?.trim())).toBe(
      'Import all',
    );
    await $('button=Import all').click();
    await browser.execute(() => {
      document.documentElement.style.zoom = '';
    });
    await expect($('.settings-content')).toHaveText(
      expect.stringContaining('Imported 1 memory from Claude Code.'),
    );
    await expect($('button=Import all')).not.toExist();
    const records = await browser.tauri.execute(async ({ core }) =>
      core.invoke<Array<{ content: string; provenance: { agent?: string; source?: string } }>>(
        'memory_list',
        {
          directory: localStorage.getItem('sai-directory'),
          includeForgotten: false,
        },
      ),
    );
    expect(records).toHaveLength(1);
    expect(records[0].provenance.agent).toBe('claude');
    expect(records[0].provenance.source).toBe('Claude Code memory/project-note.md');
  });
});
