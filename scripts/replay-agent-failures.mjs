import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import {
  assertNoReplayRegressions,
  assertReplayCoverage,
  compareFailureReplay,
  failureReplayObservationSchema,
  failureReplayReportSchema,
  replayMatrixSchema,
  replayProviders,
  runFailureReplay,
} from '../src/lib/failure-replay.ts';

const runnerSchema = z
  .object({
    provider: z.enum(replayProviders),
    command: z.string().min(1),
    args: z.array(z.string()),
    forwardEnvironment: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  })
  .strict();

const configSchema = z
  .object({
    matrix: replayMatrixSchema,
    runners: z.array(runnerSchema).min(1),
    timeoutMs: z.number().int().positive().max(3_600_000).default(900_000),
    concurrency: z.number().int().min(1).max(32).default(4),
    maximumAcceptedCostIncrease: z.number().min(0).max(10).default(0.15),
  })
  .strict()
  .superRefine((config, context) => {
    const providers = config.runners.map((runner) => runner.provider);
    if (new Set(providers).size !== providers.length)
      context.addIssue({ code: 'custom', message: 'Runner providers must be unique.' });
    for (const provider of config.matrix.providers)
      if (!providers.includes(provider))
        context.addIssue({ code: 'custom', message: `Missing ${provider} runner.` });
  });

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}

const configPath = option('--config');
const corpusPath = option('--corpus');
const outputPath = option('--output');
const baselinePath = option('--baseline');
if (!configPath || !corpusPath || !outputPath)
  throw new Error(
    'Usage: npm run test:agent-replay -- --config CONFIG --corpus CORPUS --output NEW_DIRECTORY [--baseline REPORT]',
  );

const config = configSchema.parse(JSON.parse(await readFile(resolve(configPath), 'utf8')));
const corpus = JSON.parse(await readFile(resolve(corpusPath), 'utf8'));
const outputRoot = resolve(outputPath);
await mkdir(outputRoot);
await mkdir(join(outputRoot, 'runs'));

function isolatedEnvironment(runDirectory, runner, seed) {
  const environment = {
    PATH: process.env.PATH ?? '',
    SAIL_FAILURE_REPLAY_SEED: String(seed),
    HOME: join(runDirectory, 'home'),
    XDG_CONFIG_HOME: join(runDirectory, 'xdg', 'config'),
    XDG_CACHE_HOME: join(runDirectory, 'xdg', 'cache'),
    XDG_DATA_HOME: join(runDirectory, 'xdg', 'data'),
    TMPDIR: join(runDirectory, 'tmp'),
  };
  if (process.platform === 'win32') {
    environment.Path = process.env.Path ?? environment.PATH;
    environment.PATHEXT = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
    environment.SystemRoot = process.env.SystemRoot ?? '';
  }
  for (const name of runner.forwardEnvironment) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function execute(invocation) {
  const runner = config.runners.find((candidate) => candidate.provider === invocation.provider);
  if (!runner) throw new Error(`Missing runner for ${invocation.provider}.`);
  const runDirectory = join(outputRoot, 'runs', invocation.runId);
  await mkdir(runDirectory);
  await Promise.all(
    ['home', 'tmp', 'xdg/config', 'xdg/cache', 'xdg/data'].map((directory) =>
      mkdir(join(runDirectory, directory), { recursive: true }),
    ),
  );
  const input = join(runDirectory, 'input.json');
  const output = join(runDirectory, 'observation.json');
  await writeFile(input, `${JSON.stringify(invocation, null, 2)}\n`, { flag: 'wx' });
  const substitutions = { '{input}': input, '{output}': output, '{workdir}': runDirectory };
  const args = runner.args.map((argument) =>
    Object.entries(substitutions).reduce(
      (value, [placeholder, replacement]) => value.replaceAll(placeholder, replacement),
      argument,
    ),
  );
  if (!runner.args.some((argument) => argument.includes('{input}')))
    throw new Error(`${runner.provider} runner args must include {input}.`);
  if (!runner.args.some((argument) => argument.includes('{output}')))
    throw new Error(`${runner.provider} runner args must include {output}.`);

  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(runner.command, args, {
      cwd: runDirectory,
      env: isolatedEnvironment(runDirectory, runner, invocation.seed),
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: false,
    });
    const timeout = setTimeout(() => child.kill(), config.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${invocation.runId} exited with ${code ?? signal}.`));
    });
  });
  return failureReplayObservationSchema.parse(JSON.parse(await readFile(output, 'utf8')));
}

const report = await runFailureReplay(corpus, config.matrix, execute, config.concurrency);
assertReplayCoverage(report, corpus);
await writeFile(join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
  flag: 'wx',
});

if (baselinePath) {
  const baseline = failureReplayReportSchema.parse(
    JSON.parse(await readFile(resolve(baselinePath), 'utf8')),
  );
  const regressions = compareFailureReplay(baseline, report, config.maximumAcceptedCostIncrease);
  await writeFile(
    join(outputRoot, 'regressions.json'),
    `${JSON.stringify(regressions, null, 2)}\n`,
    { flag: 'wx' },
  );
  assertNoReplayRegressions(regressions);
}

const failed = report.results.filter((result) => !result.accepted);
process.stdout.write(
  `Replayed ${report.results.length} runs; ${report.results.length - failed.length} accepted.\n`,
);
if (failed.length) {
  process.stderr.write(`${failed.map((result) => result.runId).join('\n')}\n`);
  process.exitCode = 1;
}
