import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const inputPath = process.argv[process.argv.indexOf('--input') + 1];
const outputPath = process.argv[process.argv.indexOf('--output') + 1];
const invocation = JSON.parse(readFileSync(inputPath, 'utf8'));
assert.equal(realpathSync(process.cwd()), realpathSync(dirname(inputPath)));
assert.equal(process.env.SAIL_FAILURE_REPLAY_SEED, String(invocation.seed));
for (const path of [
  process.env.HOME,
  process.env.TMPDIR,
  process.env.XDG_CONFIG_HOME,
  process.env.XDG_CACHE_HOME,
  process.env.XDG_DATA_HOME,
])
  assert.equal(realpathSync(resolve(path)).startsWith(realpathSync(process.cwd())), true);

const grade = { passed: true, evidence: ['Verified by the replay fixture.'] };
writeFileSync(
  outputPath,
  `${JSON.stringify({
    grades: {
      ownership: grade,
      acceptance: grade,
      evidenceFreshness: grade,
      permissionBehavior: grade,
      recovery: grade,
      finalOutcome: grade,
    },
    outcomeAccepted: true,
    metrics: {
      elapsedMs: 1,
      turns: 1,
      toolCalls: 1,
      permissionRequests: 0,
      retries: 0,
      humanInterventions: 0,
      failedCommands: 0,
      repeatedWork: 0,
    },
    outputReference: 'fixture-output',
  })}\n`,
);
