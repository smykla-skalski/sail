import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

await test('the probe serves HTTP requests while its client command is running', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sail-660-probe-test-'));
  try {
    const binary = join(scratch, 'fixture-client.mjs');
    writeFileSync(
      binary,
      `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('2.0.24');
} else if (args[0] === 'service') {
  process.exit(0);
} else {
  const config = JSON.parse(readFileSync('opencode.json', 'utf8'));
  config.mcp ??= { servers: {} };
  if (args[1] === 'add') {
    const url = args[args.indexOf('--url') + 1];
    const headerIndex = args.indexOf('--header');
    const headers = headerIndex < 0 ? {} : {
      Authorization: args[headerIndex + 1].slice('Authorization='.length),
    };
    const response = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      signal: AbortSignal.timeout(2000),
    });
    if (response.status !== (headers.Authorization ? 200 : 401)) process.exit(1);
    config.mcp.servers[args[2]] = { type: 'remote', url, headers };
    writeFileSync('opencode.json', JSON.stringify(config));
  } else if (args[1] === 'list') {
    for (const [name, server] of Object.entries(config.mcp.servers)) {
      const response = await fetch(server.url, {
        method: 'POST', headers: server.headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        signal: AbortSignal.timeout(2000),
      });
      if (response.status === 401) {
        await fetch(new URL('/.well-known/oauth-authorization-server', server.url), {
          signal: AbortSignal.timeout(2000),
        });
      }
      console.log(name + (response.status === 200 ? ' connected' : ' needs authentication'));
    }
  } else if (args[1] !== 'logout') {
    process.exit(1);
  }
}
`,
      { mode: 0o700 },
    );
    const result = runProbe(binary);
    assert.equal(result.status, 'complete');
    assert.deepEqual(
      result.findings.filter((finding) => !finding.pass).map((finding) => finding.id),
      [],
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

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
    'unauthenticated-oauth-discovery',
  ]) {
    assert.ok(byId.has(id), `the probe must report the ${id} finding`);
    assert.equal(byId.get(id)?.pass, true, `the ${id} contract must hold`);
  }
});
