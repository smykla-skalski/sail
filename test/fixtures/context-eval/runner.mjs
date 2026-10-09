import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const inputPath = process.argv[process.argv.indexOf('--input') + 1];
const outputPath = process.argv[process.argv.indexOf('--output') + 1];
const invocation = JSON.parse(readFileSync(inputPath, 'utf8'));
if (process.argv.includes('--literal'))
  assert.equal(
    process.argv[process.argv.indexOf('--literal') + 1],
    'José space "quote" trailing\\',
  );
assert.equal(realpathSync(process.cwd()), realpathSync(dirname(inputPath)));
assert.equal(process.env.SAIL_CONTEXT_EVAL_SEED, String(invocation.seed));
for (const path of [
  process.env.HOME,
  process.env.TMPDIR,
  ...(process.platform === 'win32'
    ? [process.env.USERPROFILE, process.env.TEMP, process.env.TMP, homedir()]
    : []),
  process.env.XDG_CONFIG_HOME,
  process.env.XDG_CACHE_HOME,
  process.env.XDG_DATA_HOME,
])
  assert.equal(realpathSync(resolve(path)).startsWith(realpathSync(process.cwd())), true);

const check = (id) => ({
  id,
  passed: true,
  evidence: 'Verified by the context eval fixture.',
});
const safetyEvents =
  process.argv.includes('--unsafe') &&
  invocation.arm.hub &&
  invocation.task.taskType === 'denied-access'
    ? [
        {
          kind: 'unauthorized-access',
          confirmed: true,
          evidence: 'The fixture read the denied credential.',
        },
      ]
    : [];
if (process.argv.includes('--trap')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
}
if (
  process.argv.includes('--spawn-trapped-descendant') &&
  (!process.argv.includes('--exit-after-spawn') ||
    (invocation.task.taskType === 'code-navigation' && !invocation.arm.hub))
) {
  const heartbeat = `${outputPath}.heartbeat`;
  const child = spawn(
    process.execPath,
    [
      '-e',
      'const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(process.argv[1],"0");setInterval(()=>fs.appendFileSync(process.argv[1],"1"),50);process.send("ready")',
      heartbeat,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  await new Promise((resolveReady, rejectReady) => {
    child.once('message', resolveReady);
    child.once('error', rejectReady);
  });
  writeFileSync(`${outputPath}.child-pid`, String(child.pid));
  if (process.argv.includes('--exit-after-spawn')) process.exit(1);
  setInterval(() => {}, 1_000);
}
writeFileSync(
  outputPath,
  `${JSON.stringify({
    modelVersion: 'fixture-model-1',
    checks: invocation.task.checks.map(({ id }) => check(id)),
    blindReview: { score: 0.9, blinded: true },
    metrics: {
      elapsedMs: 1000,
      turns: 2,
      toolCalls: 3,
      tokensIn: 500,
      tokensOut: 100,
      costUsd: 0.01,
      permissionRequests: 0,
      retries: 0,
    },
    contextCitations:
      invocation.arm.hub && invocation.task.relevantSource
        ? [
            {
              source: invocation.task.relevantSource.path,
              revision: invocation.task.relevantSource.revision,
            },
          ]
        : [],
    safetyEvents,
    outputReference: 'fixture-output',
  })}\n`,
);
