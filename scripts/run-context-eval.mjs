import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import {
  assertContextEvalCoverage,
  collectSafetyFindings,
  contextEvalMatrixSchema,
  contextEvalObservationSchema,
  contextEvalTaskSetSchema,
  runContextEval,
  summarizeContextEval,
} from '../src/lib/context-eval.ts';

const runnerSchema = z
  .object({
    provider: z.enum(['claude', 'codex', 'opencode']),
    command: z.string().min(1),
    args: z.array(z.string()),
    forwardEnvironment: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  })
  .strict();

const configSchema = z
  .object({
    matrix: contextEvalMatrixSchema,
    runners: z.array(runnerSchema).min(1),
    timeoutMs: z.number().int().positive().max(3_600_000).default(900_000),
    concurrency: z.number().int().min(1).max(32).default(4),
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

const taskSetPath = option('--tasks');
const configPath = option('--config');
const outputPath = option('--output');
if (!taskSetPath || !configPath || !outputPath)
  throw new Error(
    'Usage: npm run test:context-eval -- --tasks TASKSET --config CONFIG --output NEW_DIRECTORY',
  );

const taskSet = contextEvalTaskSetSchema.parse(
  JSON.parse(await readFile(resolve(taskSetPath), 'utf8')),
);
const config = configSchema.parse(JSON.parse(await readFile(resolve(configPath), 'utf8')));
const outputRoot = resolve(outputPath);
await mkdir(outputRoot);
await mkdir(join(outputRoot, 'runs'));

function isolatedEnvironment(runDirectory, runner, seed) {
  const environment = {
    PATH: process.env.PATH ?? '',
    SAIL_CONTEXT_EVAL_SEED: String(seed),
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
    argument.replace(
      /\{input\}|\{output\}|\{workdir\}/g,
      (placeholder) => substitutions[placeholder],
    ),
  );
  if (!runner.args.some((argument) => argument.includes('{input}')))
    throw new Error(`${runner.provider} runner args must include {input}.`);
  if (!runner.args.some((argument) => argument.includes('{output}')))
    throw new Error(`${runner.provider} runner args must include {output}.`);

  const child = spawn(runner.command, args, {
    cwd: runDirectory,
    env: isolatedEnvironment(runDirectory, runner, invocation.seed),
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: false,
    detached: process.platform !== 'win32',
  });
  await new Promise((resolveRun, rejectRun) => {
    const killRunner = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    let timedOut = false;
    let escalation = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      killRunner('SIGTERM');
      escalation = setTimeout(() => killRunner('SIGKILL'), 5_000);
    }, config.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      rejectRun(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (timedOut)
        rejectRun(new Error(`${invocation.runId} timed out after ${config.timeoutMs} ms.`));
      else if (code === 0) resolveRun();
      else rejectRun(new Error(`${invocation.runId} exited with ${code ?? signal}.`));
    });
  });
  return contextEvalObservationSchema.parse(JSON.parse(await readFile(output, 'utf8')));
}

const {
  taskSet: parsedTaskSet,
  matrix,
  results,
} = await runContextEval(taskSet, config.matrix, execute, config.concurrency);
assertContextEvalCoverage(results, parsedTaskSet, matrix);
const safetyFindings = collectSafetyFindings(results);
const summary = summarizeContextEval(results, parsedTaskSet.preregistered);
const report = {
  schemaVersion: 1,
  taskSet: parsedTaskSet.name,
  preregistered: parsedTaskSet.preregistered,
  matrix,
  results,
  safety: {
    gate: safetyFindings.length ? 'failed' : 'passed',
    findings: safetyFindings,
  },
  summary: safetyFindings.length ? null : summary,
};
await writeFile(join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
  flag: 'wx',
});

if (safetyFindings.length) {
  process.stderr.write(
    `Context eval safety gate failed; the report is audit evidence only:\n${safetyFindings
      .map((finding) => `${finding.runId} ${finding.kind}: ${finding.evidence}`)
      .join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Ran ${results.length} paired runs; verdict ${summary.verdict} at the preregistered threshold.\n`,
  );
}
