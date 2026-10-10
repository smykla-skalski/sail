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

function run(
  config: object,
  secret = 'fixture-secret-123',
  environment: Record<string, string> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'sail-context-conformance-'));
  try {
    const path = join(directory, 'profile.json');
    writeFileSync(path, JSON.stringify(config));
    return spawnSync(process.execPath, [runner, '--config', path], {
      encoding: 'utf8',
      env: { ...process.env, ...environment, SAIL_CONFORMANCE_SECRET: secret },
      timeout: 10_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const secret of ['ab"cd', 'ab\\cd', 'ab\ncd', 'ab\u0001cd']) {
  void test(`rejects decoded secret echo ${JSON.stringify(secret)}`, () => {
    const result = run(profile('echo-secret'), secret);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error response exposes the secret/);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /Request denied/);
  });
}

for (const secret of ['ab"cd', 'ab\\cd', 'ab\ncd', 'ab\u0001cd']) {
  void test(`rejects JSON-encoded secret echo ${JSON.stringify(secret)}`, () => {
    const result = run(profile('echo-encoded-secret'), secret);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error response exposes the secret/);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /Request denied/);
  });
}

for (const secret of ['ab"cd', 'ab\\cd', 'ab\ncd', 'ab\u0001cd']) {
  void test(`rejects JSON-encoded secret in error object key ${JSON.stringify(secret)}`, () => {
    const result = run(profile('echo-encoded-key-secret'), secret);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error response exposes the secret/);
    assert.equal(result.stdout, '');
  });
}

for (const [mode, secret] of [
  ['echo-numeric-secret', '123'],
  ['echo-boolean-secret', 'true'],
] as const) {
  void test(`rejects ${mode} in an error field`, () => {
    const result = run(profile(mode), secret);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error response exposes the secret/);
    assert.equal(result.stdout, '');
  });
}

void test('rejects an error probe that does not send the secret', () => {
  const config = profile();
  config.errorProbe.arguments = {};
  const result = run(config);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Error probe arguments must include \$SECRET/);
  assert.equal(result.stdout, '');
});

void test('rejects an unadvertised error probe tool', () => {
  const result = run(profile('missing-error-tool'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Error probe tool is not advertised/);
  assert.equal(result.stdout, '');
});

void test('passes a named credential to a stdio provider', () => {
  const config = profile('requires-credential');
  config.transport.environment = { SAIL_PROVIDER_TOKEN: 'SAIL_CONFORMANCE_TOKEN' };
  const result = run(config, 'fixture-secret-123', { SAIL_CONFORMANCE_TOKEN: 'fixture-token' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'pass');
});

void test('rejects an unset stdio credential source', () => {
  const config = profile();
  config.transport.environment = { SAIL_PROVIDER_TOKEN: 'SAIL_CONFORMANCE_UNSET_TOKEN' };
  const result = run(config);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Stdio environment SAIL_CONFORMANCE_UNSET_TOKEN is unset/);
});

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
  ['secret-version', 'Unsupported MCP protocol version'],
  ['secret-error-code', 'Provider returned a JSON-RPC error'],
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

void test('inherited object properties cannot satisfy provenance', () => {
  const config = profile('wrong-revision');
  config.probe.sourcePointer = '/constructor/name';
  config.probe.revisionPointer = '/constructor/name';
  config.probe.expectedSource = 'Object';
  config.probe.expectedRevision = 'Object';

  const result = run(config);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /source provenance differs/);
});

async function runHttp(mode: string, secret = 'fixture-secret-123') {
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
      return spawnSync(process.execPath, [runner, '--config', path], {
        encoding: 'utf8',
        env: {
          ...process.env,
          SAIL_CONFORMANCE_SECRET: secret,
          SAIL_CONFORMANCE_TOKEN: 'Bearer fixture-token',
        },
        timeout: 10_000,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    server.kill();
  }
}

void test('HTTP rejects JSON-encoded secret in error object key', async () => {
  const result = await runHttp('echo-encoded-key-secret', 'ab"cd');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Error response exposes the secret/);
  assert.equal(result.stdout, '');
});

for (const mode of ['json', 'sse', 'sse-open']) {
  void test(`offline Streamable HTTP provider passes with ${mode} responses`, async () => {
    const result = await runHttp(mode);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'pass');
  });
}

for (const mode of [
  'malformed-json-init',
  'malformed-json-list',
  'malformed-json-read',
  'malformed-json-error',
  'malformed-sse-init',
  'malformed-sse-list',
  'malformed-sse-read',
  'malformed-sse-error',
]) {
  void test(`${mode} cannot expose provider text`, async () => {
    const result = await runHttp(mode);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid provider JSON response/);
    assert.doesNotMatch(result.stderr, /fixture-secret-123/);
  });
}
