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

async function run(
  config: object,
  secret = 'fixture-secret-123',
  environment: Record<string, string> = {},
  startupTimeoutMs = 30_000,
) {
  const directory = mkdtempSync(join(tmpdir(), 'sail-context-conformance-'));
  const transport = (config as { transport?: { type: string; args?: string[] } }).transport;
  const provider =
    transport?.type === 'stdio'
      ? spawn(
          process.execPath,
          [
            fixture,
            transport.args?.[1] === 'requires-credential'
              ? 'valid'
              : (transport.args?.[1] ?? 'valid'),
            '--listen',
          ],
          {
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          },
        )
      : null;
  const closed = provider
    ? new Promise<void>((resolveClosed) => provider.once('close', () => resolveClosed()))
    : Promise.resolve();
  try {
    let readyConfig = config;
    if (provider) {
      const port = await new Promise<number>((resolveReady, rejectReady) => {
        const timer = setTimeout(
          () => rejectReady(new Error('Provider fixture did not become ready')),
          startupTimeoutMs,
        );
        const finish = (error?: Error, value?: number) => {
          clearTimeout(timer);
          provider.removeListener('error', failed);
          provider.removeListener('exit', exited);
          if (error) rejectReady(error);
          else resolveReady(value!);
        };
        const failed = (error: Error) => finish(error);
        const exited = (code: number | null) =>
          finish(new Error(`Provider fixture exited before readiness: ${code}`));
        provider.once('error', failed);
        provider.once('exit', exited);
        provider.once('message', (message: { port: number }) => finish(undefined, message.port));
      });
      readyConfig = {
        ...config,
        transport: {
          ...transport,
          command: process.execPath,
          args: [
            resolve('test/fixtures/context-provider/relay.mjs'),
            String(port),
            transport.args?.[1],
          ],
        },
      };
    }
    const path = join(directory, 'profile.json');
    writeFileSync(path, JSON.stringify(readyConfig));
    return spawnSync(process.execPath, [runner, '--config', path], {
      encoding: 'utf8',
      env: { ...process.env, ...environment, SAIL_CONFORMANCE_SECRET: secret },
      timeout: 10_000,
    });
  } finally {
    provider?.kill('SIGKILL');
    await closed;
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const secret of ['ab"cd', 'ab\\cd', 'ab\ncd', 'ab\u0001cd']) {
  void test(`rejects decoded secret echo ${JSON.stringify(secret)}`, async () => {
    const result = await run(profile('echo-secret'), secret);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error response exposes the secret/);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /Request denied/);
  });
}

for (const secret of ['ab"cd', 'ab\\cd', 'ab\ncd', 'ab\u0001cd']) {
  void test(`rejects JSON-encoded secret echo ${JSON.stringify(secret)}`, async () => {
    const result = await run(profile('echo-encoded-secret'), secret);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error response exposes the secret/);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /Request denied/);
  });
}

for (const secret of ['ab"cd', 'ab\\cd', 'ab\ncd', 'ab\u0001cd']) {
  void test(`rejects JSON-encoded secret in error object key ${JSON.stringify(secret)}`, async () => {
    const result = await run(profile('echo-encoded-key-secret'), secret);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error response exposes the secret/);
    assert.equal(result.stdout, '');
  });
}

for (const [mode, secret] of [
  ['echo-numeric-secret', '123'],
  ['echo-boolean-secret', 'true'],
] as const) {
  void test(`rejects ${mode} in an error field`, async () => {
    const result = await run(profile(mode), secret);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error response exposes the secret/);
    assert.equal(result.stdout, '');
  });
}

void test('rejects an error probe that does not send the secret', async () => {
  const config = profile();
  config.errorProbe.arguments = {};
  const result = await run(config);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Error probe arguments must include \$SECRET/);
  assert.equal(result.stdout, '');
});

void test('rejects an unadvertised error probe tool', async () => {
  const result = await run(profile('missing-error-tool'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Error probe tool is not advertised/);
  assert.equal(result.stdout, '');
});

void test('passes a named credential to a stdio provider', async () => {
  const config = profile('requires-credential');
  config.transport.environment = { SAIL_PROVIDER_TOKEN: 'SAIL_CONFORMANCE_TOKEN' };
  const result = await run(config, 'fixture-secret-123', {
    SAIL_CONFORMANCE_TOKEN: 'fixture-token',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'pass');
});

void test('rejects an unset stdio credential source', async () => {
  const config = profile();
  config.transport.environment = { SAIL_PROVIDER_TOKEN: 'SAIL_CONFORMANCE_UNSET_TOKEN' };
  const result = await run(config);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Stdio environment SAIL_CONFORMANCE_UNSET_TOKEN is unset/);
});

void test('does not match a secret against the JSON-RPC envelope', async () => {
  const result = await run(profile(), '2');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'pass');
});

for (const mode of [
  'trailing-stdout',
  'delayed-trailing-stdout',
  'late-trailing-stdout',
  'late-trailing-fragment',
]) {
  void test(`rejects ${mode} after the final response`, async () => {
    const result = await run(profile(mode));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Non-MCP output on provider stdout/);
    assert.equal(result.stdout, '');
  });
}

void test('rejects a string false isError in the error probe', async () => {
  const result = await run(profile('string-false-error'));
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Error probe did not return a valid JSON-RPC error or true isError flag/,
  );
  assert.equal(result.stdout, '');
});

void test('rejects a string JSON-RPC error field', async () => {
  const result = await run(profile('string-rpc-error'));
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Error probe did not return a valid JSON-RPC error or true isError flag/,
  );
  assert.equal(result.stdout, '');
});

void test('accepts a valid JSON-RPC error object', async () => {
  const result = await run(profile('valid-rpc-error'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'pass');
});

void test('offline stdio provider passes the versioned profile', async () => {
  const result = await run(profile());
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
  void test(`rejects ${mode}`, async () => {
    const result = await run(profile(mode));
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(reason));
    assert.doesNotMatch(result.stderr, /fixture-secret-123/);
  });
}

void test('rejects unsupported profile versions', async () => {
  const result = await run({ ...profile(), version: 2 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported conformance profile version/);
});

void test('inherited object properties cannot satisfy provenance', async () => {
  const config = profile('wrong-revision');
  config.probe.sourcePointer = '/constructor/name';
  config.probe.revisionPointer = '/constructor/name';
  config.probe.expectedSource = 'Object';
  config.probe.expectedRevision = 'Object';

  const result = await run(config);

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

void test('HTTP rejects an error reply without JSON-RPC 2.0', async () => {
  const result = await runHttp('missing-error-jsonrpc');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid error probe JSON-RPC response/);
  assert.equal(result.stdout, '');
});

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

void test('a ready but hung provider still hits the request deadline', async () => {
  const result = await run(profile('hung'));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Provider request timed out/);
});

void test('failed fixture readiness stops its owned provider', async () => {
  await assert.rejects(
    run(profile('never-ready'), 'fixture-secret-123', {}, 100),
    /Provider fixture did not become ready/,
  );
});
