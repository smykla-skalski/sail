#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const PROTOCOL_VERSION = '2025-06-18';
const MAX_MESSAGE_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;

class ConformanceError extends Error {}

function assert(condition, message) {
  if (!condition) throw new ConformanceError(message);
}

function parseProviderJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ConformanceError('Invalid provider JSON response.');
  }
}

function pointer(value, path) {
  assert(typeof path === 'string' && path.startsWith('/'), 'Invalid provenance pointer.');
  let current = value;
  for (const part of path.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function validateConfig(config) {
  assert(config?.version === 1, 'Unsupported conformance profile version; expected 1.');
  assert(
    config.transport?.type === 'stdio' || config.transport?.type === 'streamable-http',
    'Unsupported transport.',
  );
  if (config.transport.type === 'stdio') {
    assert(
      typeof config.transport.command === 'string' && config.transport.command.length > 0,
      'Missing stdio command.',
    );
    assert(
      Array.isArray(config.transport.args) &&
        config.transport.args.every((arg) => typeof arg === 'string'),
      'Invalid stdio arguments.',
    );
    assert(
      config.transport.environment === undefined ||
        (config.transport.environment &&
          typeof config.transport.environment === 'object' &&
          !Array.isArray(config.transport.environment)),
      'Invalid stdio environment mapping.',
    );
    for (const [name, environment] of Object.entries(config.transport.environment ?? {})) {
      assert(/^[A-Z][A-Z0-9_]*$/.test(name), 'Invalid stdio environment name.');
      assert(
        typeof environment === 'string' && /^[A-Z][A-Z0-9_]*$/.test(environment),
        'Invalid stdio source environment name.',
      );
      assert(process.env[environment], `Stdio environment ${environment} is unset.`);
    }
  } else {
    const url = new URL(config.transport.url);
    assert(
      url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)),
      'Remote HTTP requires HTTPS; local loopback may use HTTP.',
    );
    assert(!url.username && !url.password, 'URL credentials are not supported.');
    assert(
      !url.search && !url.hash,
      'HTTP endpoint URL must not contain query or fragment values.',
    );
    assert(
      config.transport.headerEnvironment === undefined ||
        (config.transport.headerEnvironment &&
          typeof config.transport.headerEnvironment === 'object' &&
          !Array.isArray(config.transport.headerEnvironment)),
      'Invalid HTTP header environment mapping.',
    );
    for (const [header, environment] of Object.entries(config.transport.headerEnvironment ?? {})) {
      assert(
        /^[A-Za-z][A-Za-z0-9-]*$/.test(header) &&
          !['host', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version'].includes(
            header.toLowerCase(),
          ),
        'Invalid managed HTTP header.',
      );
      assert(
        typeof environment === 'string' && /^[A-Z][A-Z0-9_]*$/.test(environment),
        'Invalid HTTP header environment name.',
      );
      assert(process.env[environment], `HTTP header environment ${environment} is unset.`);
    }
  }
  assert(
    typeof config.probe?.tool === 'string' && config.probe.tool.length > 0,
    'Missing read-only probe tool.',
  );
  assert(
    config.probe.arguments &&
      typeof config.probe.arguments === 'object' &&
      !Array.isArray(config.probe.arguments),
    'Invalid probe arguments.',
  );
  assert(
    typeof config.probe.sourcePointer === 'string' &&
      typeof config.probe.revisionPointer === 'string',
    'Missing provenance pointers.',
  );
  assert(
    typeof config.probe.expectedSource === 'string' && config.probe.expectedSource.length > 0,
    'Missing expected source.',
  );
  assert(
    typeof config.probe.expectedRevision === 'string' && config.probe.expectedRevision.length > 0,
    'Missing expected revision.',
  );
  assert(
    typeof config.errorProbe?.tool === 'string' && config.errorProbe.tool.length > 0,
    'Missing error probe tool.',
  );
  assert(
    config.errorProbe.arguments &&
      typeof config.errorProbe.arguments === 'object' &&
      !Array.isArray(config.errorProbe.arguments),
    'Invalid error probe arguments.',
  );
  assert(
    typeof config.errorProbe.secretEnvironment === 'string' &&
      /^[A-Z][A-Z0-9_]*$/.test(config.errorProbe.secretEnvironment),
    'Invalid error probe secret environment name.',
  );
  return config;
}

async function boundedResponse(response) {
  const reader = response.body?.getReader();
  assert(reader, 'Empty HTTP response.');
  const chunks = [];
  let size = 0;
  async function readNext() {
    const { done, value } = await reader.read();
    if (done) return;
    size += value.length;
    assert(size <= MAX_MESSAGE_BYTES, 'HTTP response exceeds 64 KiB.');
    chunks.push(value);
    await readNext();
  }
  try {
    await readNext();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseSseEvent(event) {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  return data ? parseProviderJson(data) : undefined;
}

async function readSseResponse(response, id) {
  const reader = response.body?.getReader();
  assert(reader, 'Empty SSE response.');
  const decoder = new TextDecoder();
  let buffer = '';
  let size = 0;
  async function readNext() {
    const { done, value } = await reader.read();
    if (done) throw new ConformanceError('SSE response did not include the matching request ID.');
    size += value.length;
    assert(size <= MAX_MESSAGE_BYTES, 'SSE response exceeds 64 KiB.');
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replaceAll('\r\n', '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const message = parseSseEvent(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (message?.id === id) return message;
    }
    return readNext();
  }
  try {
    return await readNext();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function httpTransport(url, headerEnvironment) {
  let sessionId;
  let initialized = false;
  async function send(message) {
    const headers = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    for (const [header, environment] of Object.entries(headerEnvironment ?? {})) {
      headers[header] = process.env[environment];
    }
    if (initialized) headers['mcp-protocol-version'] = PROTOCOL_VERSION;
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    if (message.method === 'initialize') {
      sessionId = response.headers.get('mcp-session-id') ?? undefined;
      assert(!sessionId || /^[\x21-\x7e]+$/.test(sessionId), 'Invalid HTTP session ID.');
    }
    if (message.method === 'notifications/initialized') initialized = true;
    if (message.id === undefined) {
      assert(response.status === 202, 'HTTP notification was not accepted with 202.');
      return undefined;
    }
    assert(response.ok, `HTTP request failed with status ${response.status}.`);
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.startsWith('text/event-stream')) return readSseResponse(response, message.id);
    assert(contentType.startsWith('application/json'), 'Unexpected HTTP response content type.');
    return parseProviderJson(await boundedResponse(response));
  }
  return { send, async close() {} };
}

function stdioTransport(command, args, environment) {
  const child = spawn(command, args, {
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.fromEntries(
      ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT', 'WINDIR']
        .filter((name) => process.env[name])
        .map((name) => [name, process.env[name]])
        .concat(
          Object.entries(environment ?? {}).map(([name, source]) => [name, process.env[source]]),
        ),
    ),
  });
  const pending = new Map();
  let buffer = '';
  let failed;
  const fail = (error) => {
    failed = error;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', (code) => fail(new ConformanceError(`Provider exited with status ${code}.`)));
  child.stdin.on('error', fail);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES)
        return fail(new ConformanceError('Stdio response exceeds 64 KiB.'));
      if (!line.trim()) continue;
      try {
        const message = parseProviderJson(line);
        assert(message.jsonrpc === '2.0', 'Invalid JSON-RPC message on stdout.');
        const waiting = pending.get(message.id);
        if (waiting) {
          pending.delete(message.id);
          clearTimeout(waiting.timer);
          waiting.resolve(message);
        }
      } catch {
        fail(new ConformanceError('Non-MCP output on provider stdout.'));
      }
    }
    if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES)
      fail(new ConformanceError('Stdio response exceeds 64 KiB.'));
  });
  child.stderr.resume();
  return {
    async send(message) {
      if (failed) throw failed;
      const encoded = `${JSON.stringify(message)}\n`;
      assert(Buffer.byteLength(encoded) <= MAX_MESSAGE_BYTES, 'Request exceeds 64 KiB.');
      if (message.id === undefined) {
        child.stdin.write(encoded);
        return undefined;
      }
      return new Promise((resolveMessage, reject) => {
        const timer = setTimeout(() => {
          pending.delete(message.id);
          reject(new ConformanceError('Provider request timed out.'));
        }, TIMEOUT_MS);
        pending.set(message.id, { resolve: resolveMessage, reject, timer });
        child.stdin.write(encoded);
      });
    },
    async close() {
      if (child.exitCode !== null) return;
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
    },
  };
}

function result(message, id) {
  assert(message?.jsonrpc === '2.0' && message.id === id, 'Invalid JSON-RPC response ID.');
  if (message.error) throw new ConformanceError('Provider returned a JSON-RPC error.');
  assert(message.result && typeof message.result === 'object', 'Missing JSON-RPC result.');
  return message.result;
}

async function run(config) {
  const transport =
    config.transport.type === 'stdio'
      ? stdioTransport(
          config.transport.command,
          config.transport.args,
          config.transport.environment,
        )
      : httpTransport(config.transport.url, config.transport.headerEnvironment);
  const checks = [];
  let id = 0;
  async function request(method, params = {}) {
    id += 1;
    return transport.send({ jsonrpc: '2.0', id, method, params });
  }
  try {
    const initialized = result(
      await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'sail-context-conformance', version: '1.0.0' },
      }),
      id,
    );
    assert(
      initialized.protocolVersion === PROTOCOL_VERSION,
      `Unsupported MCP protocol version; expected ${PROTOCOL_VERSION}.`,
    );
    assert(initialized.capabilities?.tools, 'Provider does not advertise tools.');
    checks.push('initialize');
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    async function listTools(cursor, page, tools) {
      const listed = result(await request('tools/list', cursor ? { cursor } : {}), id);
      assert(Array.isArray(listed.tools), 'tools/list did not return tools.');
      tools.push(...listed.tools);
      assert(tools.length <= 128, 'Provider advertises too many tools.');
      if (listed.nextCursor === undefined) return tools;
      assert(
        typeof listed.nextCursor === 'string' && listed.nextCursor.length > 0,
        'Invalid tools/list cursor.',
      );
      assert(page < 16, 'tools/list exceeds 16 pages.');
      return listTools(listed.nextCursor, page + 1, tools);
    }
    const tools = await listTools(undefined, 1, []);
    assert(
      new Set(tools.map((tool) => tool.name)).size === tools.length,
      'Provider advertises duplicate tool names.',
    );
    assert(
      tools.every((tool) => typeof tool.name === 'string' && tool.inputSchema?.type === 'object'),
      'Provider has an invalid tool definition.',
    );
    assert(
      tools.some((tool) => tool.name === config.probe.tool),
      'Probe tool is not advertised.',
    );
    assert(
      tools.some((tool) => tool.name === config.errorProbe.tool),
      'Error probe tool is not advertised.',
    );
    checks.push('capabilities');

    const called = result(
      await request('tools/call', { name: config.probe.tool, arguments: config.probe.arguments }),
      id,
    );
    assert(!called.isError, 'Read-only probe returned an error.');
    assert(
      Buffer.byteLength(JSON.stringify(called)) <= MAX_MESSAGE_BYTES,
      'Tool result exceeds 64 KiB.',
    );
    if (Array.isArray(called.structuredContent?.items))
      assert(called.structuredContent.items.length <= 20, 'Tool result exceeds 20 items.');
    assert(
      pointer(called, config.probe.sourcePointer) === config.probe.expectedSource,
      'Tool result source provenance differs from the fixture.',
    );
    assert(
      pointer(called, config.probe.revisionPointer) === config.probe.expectedRevision,
      'Tool result revision provenance differs from the fixture.',
    );
    checks.push('bounded-result', 'provenance');

    const secret = process.env[config.errorProbe.secretEnvironment];
    assert(secret, 'Error probe secret environment variable is unset.');
    let insertedSecret = false;
    const insertSecret = (value) => {
      if (typeof value === 'string') {
        if (value.includes('$SECRET')) insertedSecret = true;
        return value.replaceAll('$SECRET', secret);
      }
      if (Array.isArray(value)) return value.map(insertSecret);
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, insertSecret(item)]),
        );
      return value;
    };
    const errorArguments = insertSecret(config.errorProbe.arguments);
    assert(insertedSecret, 'Error probe arguments must include $SECRET.');
    id += 1;
    const error = await transport.send({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: config.errorProbe.tool,
        arguments: errorArguments,
      },
    });
    assert(error?.id === id && (error.error || error.result?.isError), 'Error probe did not fail.');
    const containsSecretText = (text) =>
      text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1));
    const containsSecret = (value) => {
      if (typeof value === 'string') return containsSecretText(value);
      if (Array.isArray(value)) return value.some(containsSecret);
      if (value && typeof value === 'object')
        return Object.entries(value).some(
          ([key, item]) => containsSecretText(key) || containsSecret(item),
        );
      return false;
    };
    assert(!containsSecret(error), 'Error response exposes the secret.');
    checks.push('error', 'secret-redaction');
    return { status: 'pass', profileVersion: 1, protocolVersion: PROTOCOL_VERSION, checks };
  } finally {
    await transport.close();
  }
}

async function main() {
  assert(
    process.argv.length === 4 && process.argv[2] === '--config',
    'Usage: node scripts/context-provider-conformance.mjs --config FILE',
  );
  let config;
  try {
    config = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8'));
  } catch {
    throw new ConformanceError('Cannot read a valid conformance profile JSON file.');
  }
  validateConfig(config);
  const report = await run(config);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  const message = error instanceof ConformanceError ? error.message : 'Conformance run failed.';
  process.stderr.write(`${JSON.stringify({ status: 'fail', message })}\n`);
  process.exitCode = 1;
});
