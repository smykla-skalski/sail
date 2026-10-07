import { browser, expect } from '@wdio/globals';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

type McpConfig = { command: string; args: string[]; env: Record<string, string> };
const mcpResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ text: z.string() })),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
const listing = z.object({
  skill: z.literal('ship-it'),
  coreVersion: z.string(),
  references: z.array(z.object({ name: z.string(), version: z.string() })),
});

const skillRoot = resolve('skills/ship-it');
const version = (content: string) =>
  `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
const bundledFiles = new Map(
  ['references', 'scripts'].flatMap((directory) =>
    readdirSync(join(skillRoot, directory))
      .filter((name) => !name.startsWith('.'))
      .map((name) => [
        directory === 'scripts' ? `scripts/${name}` : name,
        readFileSync(join(skillRoot, directory, name), 'utf8'),
      ]),
  ),
);

function skillReference(config: McpConfig, reference?: string) {
  const child = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.stdin.end(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'skill_reference',
        arguments: reference === undefined ? { skill: 'ship-it' } : { skill: 'ship-it', reference },
      },
    })}\n`,
  );
  return new Promise<z.infer<typeof mcpResult>>((done, fail) => {
    const timer = setTimeout(() => child.kill(), 30_000);
    child.once('error', fail);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        fail(new Error(`MCP process exited ${code}: ${stderr}; stdout=${stdout}`));
        return;
      }
      try {
        done(z.object({ result: mcpResult }).parse(JSON.parse(stdout.trim())).result);
      } catch (error) {
        fail(new Error(`Invalid MCP response: ${stdout}; stderr=${stderr}`, { cause: error }));
      }
    });
  });
}

describe('bundled Ship It skill', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-ship-skill-'));

  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('serves every synced reference and script offline with exact versions', async () => {
    const config = await browser.tauri.execute(
      async ({ core }, input) => core.invoke<McpConfig>('browser_mcp_config', input),
      { directory: realpathSync(repository), agent: 'claude' },
    );
    const listed = await skillReference(config);
    expect(listed.isError).not.toBe(true);
    const { coreVersion, references } = listing.parse(listed.structuredContent);
    expect(coreVersion).toBe(version(readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')));
    expect(references.map(({ name }) => name).toSorted()).toEqual(
      [...bundledFiles.keys()].toSorted(),
    );
    const loaded = await Promise.all(
      references.map(async ({ name, version: listedVersion }) => ({
        name,
        listedVersion,
        result: await skillReference(config, name),
      })),
    );
    for (const { name, listedVersion, result } of loaded) {
      expect(listedVersion).toBe(version(bundledFiles.get(name) ?? ''));
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ reference: name, version: listedVersion });
      expect(result.content[0].text.endsWith(bundledFiles.get(name) ?? '\0')).toBe(true);
    }

    const core = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
    expect(core).toContain('## Sail mode');
    expect(core).toContain('"You merge" rule');
    const missing = await Promise.all(
      ['replay.md', 'scripts/replay_failures.py', '../SKILL.md'].map((name) =>
        skillReference(config, name),
      ),
    );
    for (const result of missing) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Unknown bundled skill reference.');
    }
  });
});
