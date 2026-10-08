import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

void test('CLI isolates provider runs and writes a reusable report', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sail-failure-replay-'));
  try {
    const configPath = join(temporary, 'config.json');
    const outputPath = join(temporary, 'output');
    const runner = join(root, 'test/fixtures/agent-failures/runner.mjs');
    const providers = ['claude', 'codex', 'opencode'];
    await writeFile(
      configPath,
      JSON.stringify({
        matrix: {
          release: 'fixture-release',
          providers,
          profiles: [{ id: 'default', description: 'Fixture workflow' }],
        },
        runners: providers.map((provider) => ({
          provider,
          command: process.execPath,
          args: [runner, '--input', '{input}', '--output', '{output}'],
        })),
        concurrency: 2,
        timeoutMs: 10_000,
      }),
    );
    const { stdout } = await execute(
      process.execPath,
      [
        join(root, 'scripts/replay-agent-failures.mjs'),
        '--config',
        configPath,
        '--corpus',
        join(root, 'test/fixtures/agent-failures/corpus.json'),
        '--output',
        outputPath,
      ],
      { cwd: root },
    );
    assert.match(stdout, /Replayed 9 runs; 9 accepted/);
    const report = JSON.parse(await readFile(join(outputPath, 'report.json'), 'utf8'));
    assert.equal(report.results.length, 9);
    assert.equal(
      report.results.every((result: { accepted: boolean }) => result.accepted),
      true,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
