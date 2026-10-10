import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import process from 'node:process';

const mode = process.argv[2] ?? 'json';
const server = createServer(async (request, response) => {
  const parts = [];
  for await (const part of request) parts.push(part);
  const message = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (request.headers.authorization !== 'Bearer fixture-token') {
    response.writeHead(401).end();
    return;
  }
  if (message.method === 'notifications/initialized') {
    response.writeHead(202).end();
    return;
  }
  if (message.method !== 'initialize' && request.headers['mcp-protocol-version'] !== '2025-06-18') {
    response.writeHead(400).end();
    return;
  }
  let result;
  if (message.method === 'initialize') {
    result = {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'sail-http-fixture', version: '1.0.0' },
    };
  } else if (message.method === 'tools/list') {
    result = {
      tools: [
        { name: 'fixture_search', inputSchema: { type: 'object', properties: {} } },
        { name: 'fixture_error', inputSchema: { type: 'object', properties: {} } },
      ],
    };
  } else if (message.params.name === 'fixture_error') {
    result = { isError: true, content: [{ type: 'text', text: 'Request denied.' }] };
  } else {
    result = {
      content: [{ type: 'text', text: 'One bounded result.' }],
      structuredContent: {
        items: [{ sourceUri: 'file:///project/AGENTS.md', revision: 'abc123' }],
      },
    };
  }
  const phase =
    message.method === 'initialize'
      ? 'init'
      : message.method === 'tools/list'
        ? 'list'
        : message.params.name === 'fixture_error'
          ? 'error'
          : 'read';
  const malformed = mode === `malformed-json-${phase}` || mode === `malformed-sse-${phase}`;
  const reply = malformed
    ? `{"jsonrpc":"2.0","id":${message.id},"result":{"secret":"fixture-secret-123",}`
    : JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
  const headers = message.method === 'initialize' ? { 'mcp-session-id': 'fixture-session' } : {};
  if (message.method !== 'initialize' && request.headers['mcp-session-id'] !== 'fixture-session') {
    response.writeHead(400).end();
    return;
  }
  if (mode === 'sse' || mode === 'sse-open' || mode.startsWith('malformed-sse-')) {
    response.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
    response.write(`event: message\ndata: ${reply}\n\n`);
    if (mode !== 'sse-open') response.end();
  } else {
    response.writeHead(200, { ...headers, 'content-type': 'application/json' });
    response.end(reply);
  }
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`);
});
