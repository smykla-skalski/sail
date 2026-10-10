import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const runner = resolve('scripts/context-provider-conformance.mjs');
const fixture = resolve('test/fixtures/context-provider/stdio.mjs');
const httpFixture = resolve('test/fixtures/context-provider/http.mjs');

function profile(mode = 'valid') {
  return {
    version: 1,
    transport: { type: 'stdio', command: process.execPath, args: [fixture, mode] },
    probe: {
      tool: 'fixture_search',
      arguments: { query: 'AGENTS.md' },
      sourcePointer: '/structuredContent/items/0/sourceUri',
      revisionPointer: '/structuredContent/items/0/revision',
      expectedSource: 'file:///project/AGENTS.md',
      expectedRevision: 'abc123',
    },
    errorProbe: {
      tool: 'fixture_error',
      arguments: { secret: '$SECRET' },
      secretEnvironment: 'SAIL_CONFORMANCE_SECRET',
    },
  };
}

function run(config: object) {
  const directory = mkdtempSync(join(tmpdir(), 'sail-context-conformance-'));
  try {
    const path = join(directory, 'profile.json');
    writeFileSync(path, JSON.stringify(config));
    return spawnSync(process.execPath, [runner, '--config', path], {
      encoding: 'utf8',
      env: { ...process.env, SAIL_CONFORMANCE_SECRET: 'fixture-secret-123' },
      timeout: 10_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

void test('offline stdio provider passes the versioned profile', () => {
  const result = run(profile());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'pass',
    profileVersion: 1,
    protocolVersion: '2025-06-18',
    checks: [
      'initialize',
      'capabilities',
      'bounded-result',
      'provenance',
      'error',
      'secret-redaction',
    ],
  });
});

for (const [mode, reason] of [
  ['wrong-version', 'Unsupported MCP protocol version'],
  ['invalid-stdout', 'Non-MCP output'],
  ['oversized', 'exceeds 64 KiB'],
  ['wrong-revision', 'revision provenance differs'],
] as const) {
  void test(`rejects ${mode}`, () => {
    const result = run(profile(mode));
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(reason));
    assert.doesNotMatch(result.stderr, /fixture-secret-123/);
  });
}

void test('rejects unsupported profile versions', () => {
  const result = run({ ...profile(), version: 2 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported conformance profile version/);
});

for (const mode of ['json', 'sse', 'sse-open']) {
  void test(`offline Streamable HTTP provider passes with ${mode} responses`, async () => {
    const server = spawn(process.execPath, [httpFixture, mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const port = await new Promise<string>((resolvePort, reject) => {
        let text = '';
        server.once('error', reject);
        server.once('exit', (code) =>
          reject(new Error(`HTTP fixture exited before listening: ${code}`)),
        );
        server.stdout.setEncoding('utf8');
        server.stdout.on('data', (chunk: string) => {
          text += chunk;
          if (text.includes('\n')) resolvePort(text.trim());
        });
      });
      const config = {
        ...profile(),
        transport: {
          type: 'streamable-http',
          url: `http://127.0.0.1:${port}/mcp`,
          headerEnvironment: { Authorization: 'SAIL_CONFORMANCE_TOKEN' },
        },
      };
      const directory = mkdtempSync(join(tmpdir(), 'sail-context-conformance-'));
      try {
        const path = join(directory, 'profile.json');
        writeFileSync(path, JSON.stringify(config));
        const result = spawnSync(process.execPath, [runner, '--config', path], {
          encoding: 'utf8',
          env: {
            ...process.env,
            SAIL_CONFORMANCE_SECRET: 'fixture-secret-123',
            SAIL_CONFORMANCE_TOKEN: 'Bearer fixture-token',
          },
          timeout: 10_000,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).status, 'pass');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    } finally {
      server.kill();
    }
  });
}
