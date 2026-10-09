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

function contextEvalConfig(runner: string, unsafe: boolean): string {
  return JSON.stringify({
    matrix: {
      revision: 'fixture-revision',
      providers: ['codex'],
      arms: [
        {
          id: 'baseline',
          hub: false,
          description: 'Before hub rollout',
          toolPermissions: ['read:repository'],
        },
        {
          id: 'hub',
          hub: true,
          description: 'With hub retrieval',
          toolPermissions: ['read:repository', 'read:hub'],
        },
      ],
      trials: 1,
    },
    runners: [
      {
        provider: 'codex',
        command: process.execPath,
        args: [
          runner,
          ...(unsafe ? ['--unsafe'] : []),
          '--input',
          '{input}',
          '--output',
          '{output}',
        ],
      },
    ],
    concurrency: 2,
    timeoutMs: 10_000,
  });
}

void test('CLI isolates runs, pairs arms, and writes a reusable report', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sail-context-eval-'));
  try {
    const configPath = join(temporary, 'config.json');
    const outputPath = join(temporary, 'output');
    const runner = join(root, 'test/fixtures/context-eval/runner.mjs');
    await writeFile(configPath, contextEvalConfig(runner, false));
    const { stdout } = await execute(
      process.execPath,
      [
        join(root, 'scripts/run-context-eval.mjs'),
        '--tasks',
        join(root, 'test/fixtures/context-eval/tasks-v1.json'),
        '--config',
        configPath,
        '--output',
        outputPath,
      ],
      { cwd: root },
    );
    assert.match(stdout, /Ran 14 paired runs; verdict inconclusive/);
    const report = JSON.parse(await readFile(join(outputPath, 'report.json'), 'utf8'));
    assert.equal(report.results.length, 14);
    assert.equal(report.safety.gate, 'passed');
    assert.equal(report.preregistered.minimumImprovement, 0.1);
    assert.equal(
      report.results.every((result: { correct: boolean }) => result.correct),
      true,
    );
    const hub = report.summary.scopes[0].comparison.hub;
    const baseline = report.summary.scopes[0].comparison.baseline;
    assert.equal(hub.contextCitation.rate, 1);
    assert.equal(baseline.contextCitation.rate, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

void test('CLI fails decisively when a confirmed safety event is recorded', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sail-context-eval-'));
  try {
    const configPath = join(temporary, 'config.json');
    const outputPath = join(temporary, 'output');
    const runner = join(root, 'test/fixtures/context-eval/runner.mjs');
    await writeFile(configPath, contextEvalConfig(runner, true));
    await assert.rejects(
      () =>
        execute(
          process.execPath,
          [
            join(root, 'scripts/run-context-eval.mjs'),
            '--tasks',
            join(root, 'test/fixtures/context-eval/tasks-v1.json'),
            '--config',
            configPath,
            '--output',
            outputPath,
          ],
          { cwd: root },
        ),
      (error: { code: number; stderr: string }) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /safety gate failed/);
        assert.match(error.stderr, /unauthorized-access/);
        return true;
      },
    );
    const report = JSON.parse(await readFile(join(outputPath, 'report.json'), 'utf8'));
    assert.equal(report.safety.gate, 'failed');
    assert.equal(report.safety.findings.length, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
