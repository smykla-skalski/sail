import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

function stopFixtureChild(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

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
          '--literal',
          'José space "quote" trailing\\',
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

void test('CLI keeps run directories private when host paths are forwarded', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sail-context-eval-'));
  try {
    const configPath = join(temporary, 'config.json');
    const outputPath = join(temporary, 'output');
    const runner = join(root, 'test/fixtures/context-eval/runner.mjs');
    const config = JSON.parse(contextEvalConfig(runner, false));
    config.runners[0].forwardEnvironment = [
      'HOME',
      'TMPDIR',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'XDG_DATA_HOME',
      'TEMP',
      'TMP',
    ];
    await writeFile(configPath, JSON.stringify(config));

    await execute(
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
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: temporary,
          TMPDIR: temporary,
          XDG_CONFIG_HOME: temporary,
          XDG_CACHE_HOME: temporary,
          XDG_DATA_HOME: temporary,
          TEMP: temporary,
          TMP: temporary,
        },
      },
    );

    const report = JSON.parse(await readFile(join(outputPath, 'report.json'), 'utf8'));
    assert.equal(report.results.length, 14);
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
    assert.equal(report.summary, null);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

void test('CLI substitutes placeholders without rewriting inserted paths', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sail-context-eval-'));
  try {
    const configPath = join(temporary, 'config.json');
    const outputPath = join(temporary, 'José {output}');
    const runner = join(root, 'test/fixtures/context-eval/runner.mjs');
    await writeFile(configPath, contextEvalConfig(runner, false));
    await execute(
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
    const report = JSON.parse(await readFile(join(outputPath, 'report.json'), 'utf8'));
    assert.equal(report.results.length, 14);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

void test('CLI bounds a trapped runner timeout', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sail-context-eval-'));
  try {
    const configPath = join(temporary, 'config.json');
    const outputPath = join(temporary, 'output');
    const runner = join(root, 'test/fixtures/context-eval/runner.mjs');
    await writeFile(
      configPath,
      JSON.stringify({
        ...JSON.parse(contextEvalConfig(runner, false)),
        runners: [
          {
            provider: 'codex',
            command: process.execPath,
            args: [runner, '--trap', '--input', '{input}', '--output', '{output}'],
          },
        ],
        concurrency: 32,
        timeoutMs: 500,
      }),
    );
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
          { cwd: root, timeout: 15_000 },
        ),
      (error: { stderr: string; killed: boolean }) => {
        assert.equal(error.killed, false);
        assert.match(error.stderr, /timed out after 500 ms/);
        return true;
      },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

void test(
  'timed-out runners stop same-group descendants',
  { skip: process.platform === 'win32' },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'sail-context-eval-'));
    const childPids: number[] = [];
    try {
      const configPath = join(temporary, 'config.json');
      const outputPath = join(temporary, 'output');
      const runner = join(root, 'test/fixtures/context-eval/runner.mjs');
      await writeFile(
        configPath,
        JSON.stringify({
          ...JSON.parse(contextEvalConfig(runner, false)),
          runners: [
            {
              provider: 'codex',
              command: process.execPath,
              args: [
                runner,
                '--spawn-trapped-descendant',
                '--input',
                '{input}',
                '--output',
                '{output}',
              ],
            },
          ],
          concurrency: 32,
          timeoutMs: 1_000,
        }),
      );

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
            { cwd: root, timeout: 15_000 },
          ),
        /timed out after 1000 ms/,
      );
      const runDirectories = await readdir(join(outputPath, 'runs'));
      const childFiles = await Promise.all(
        runDirectories.map(async (directory) =>
          readFile(join(outputPath, 'runs', directory, 'observation.json.child-pid'), 'utf8'),
        ),
      );
      childPids.push(...childFiles.map(Number));
      const heartbeat = join(outputPath, 'runs', runDirectories[0], 'observation.json.heartbeat');
      const before = await readFile(heartbeat, 'utf8');
      await new Promise((settled) => setTimeout(settled, 200));
      assert.equal(await readFile(heartbeat, 'utf8'), before);
    } finally {
      childPids.forEach(stopFixtureChild);
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

void test('failed runners stop descendants before returning an error', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sail-context-eval-'));
  const childPids: number[] = [];
  try {
    const configPath = join(temporary, 'config.json');
    const outputPath = join(temporary, 'output');
    const runner = join(root, 'test/fixtures/context-eval/runner.mjs');
    await writeFile(
      configPath,
      JSON.stringify({
        ...JSON.parse(contextEvalConfig(runner, false)),
        runners: [
          {
            provider: 'codex',
            command: process.execPath,
            args: [
              runner,
              '--spawn-trapped-descendant',
              '--exit-after-spawn',
              '--input',
              '{input}',
              '--output',
              '{output}',
            ],
          },
        ],
        concurrency: 1,
      }),
    );

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
          { cwd: root, timeout: 15_000 },
        ),
      /exited with 1/,
    );
    const runDirectories = await readdir(join(outputPath, 'runs'));
    const childPid = Number(
      await readFile(
        join(outputPath, 'runs', runDirectories[0], 'observation.json.child-pid'),
        'utf8',
      ),
    );
    childPids.push(childPid);
    const heartbeat = join(outputPath, 'runs', runDirectories[0], 'observation.json.heartbeat');
    const before = await readFile(heartbeat, 'utf8');
    await new Promise((settled) => setTimeout(settled, 200));
    assert.equal(await readFile(heartbeat, 'utf8'), before);
  } finally {
    childPids.forEach(stopFixtureChild);
    await rm(temporary, { recursive: true, force: true });
  }
});
