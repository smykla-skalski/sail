import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import process from 'node:process';
import { z } from 'zod';

const pinnedVersion = '2.0.24';
const probeScript = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'opencode-remote-mcp-probe.mjs',
);

const probeFindingSchema = z.object({
  id: z.string(),
  title: z.string(),
  expectation: z.string(),
  observed: z.string(),
  pass: z.boolean(),
});

const probeResultSchema = z.object({
  status: z.string(),
  version: z.string().optional(),
  findings: z.array(probeFindingSchema),
});

function openCodeBinary() {
  const override = process.env.SAIL_OPENCODE_PROBE_BIN;
  if (override) return override;
  const located = spawnSync('which', ['opencode'], { encoding: 'utf8' });
  return located.status === 0 && located.stdout.trim() ? located.stdout.trim() : undefined;
}

function runProbe(binary: string) {
  const stdout = execFileSync(process.execPath, [probeScript, '--bin', binary, '--json'], {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return probeResultSchema.parse(JSON.parse(stdout));
}

await test('the pinned OpenCode client registers, replaces, removes, and authenticates remote MCP servers', async (t) => {
  const binary = openCodeBinary();
  if (!binary) {
    t.skip('no OpenCode binary on PATH; the probe needs the pinned client');
    return;
  }
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  const reported = /v?(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1];
  if (reported !== pinnedVersion) {
    t.skip(`OpenCode ${reported ?? 'unknown'} is not the pinned ${pinnedVersion}`);
    return;
  }

  const result = runProbe(binary);
  assert.equal(result.status, 'complete');
  assert.equal(result.version, pinnedVersion);
  assert.deepEqual(
    result.findings.filter((finding) => !finding.pass).map((finding) => finding.id),
    [],
  );

  const byId = new Map(result.findings.map((finding) => [finding.id, finding]));
  for (const id of [
    'add-remote',
    'replace-overwrites',
    'remove-has-no-command',
    'remove-via-config',
    'authenticate-header',
    'unauthenticated-rejected',
  ]) {
    assert.ok(byId.has(id), `the probe must report the ${id} finding`);
    assert.equal(byId.get(id)?.pass, true, `the ${id} contract must hold`);
  }
});
