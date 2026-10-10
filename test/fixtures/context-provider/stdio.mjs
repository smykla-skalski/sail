import { createInterface } from 'node:readline';
import process from 'node:process';

const mode = process.argv[2] ?? 'valid';
const output = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'notifications/initialized') continue;
  if (mode === 'invalid-stdout') {
    process.stdout.write('ready\n');
    continue;
  }
  const reply = { jsonrpc: '2.0', id: message.id };
  if (message.method === 'initialize') {
    if (mode === 'requires-credential' && process.env.SAIL_PROVIDER_TOKEN !== 'fixture-token') {
      reply.error = { code: -32000, message: 'Credential required.' };
      output(reply);
      continue;
    }
    reply.result = {
      protocolVersion:
        mode === 'wrong-version'
          ? '2024-11-05'
          : mode === 'secret-version'
            ? 'fixture-secret-123'
            : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'sail-fixture', version: '1.0.0' },
    };
  } else if (message.method === 'tools/list') {
    if (mode === 'secret-error-code') {
      reply.error = { code: 'fixture-secret-123', message: 'Request denied.' };
      output(reply);
      continue;
    }
    reply.result = {
      tools: [
        { name: 'fixture_search', inputSchema: { type: 'object', properties: {} } },
        ...(mode === 'missing-error-tool'
          ? []
          : [{ name: 'fixture_error', inputSchema: { type: 'object', properties: {} } }]),
      ],
    };
  } else if (message.method === 'tools/call' && message.params.name === 'fixture_error') {
    reply.result = {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            mode === 'echo-secret'
              ? `Request denied: ${message.params.arguments.secret}`
              : mode === 'echo-encoded-secret'
                ? `Request denied: ${JSON.stringify({ secret: message.params.arguments.secret })}`
                : 'Request denied.',
        },
      ],
    };
    if (mode === 'echo-encoded-key-secret')
      reply.result['_meta'] = {
        [JSON.stringify(message.params.arguments.secret).slice(1, -1)]: 'fixture marker',
      };
    if (mode === 'echo-numeric-secret') reply.result.code = Number(message.params.arguments.secret);
    if (mode === 'echo-boolean-secret')
      reply.result.flag = message.params.arguments.secret === 'true';
  } else if (message.method === 'tools/call') {
    reply.result = {
      content: [{ type: 'text', text: 'One bounded result.' }],
      structuredContent: {
        items: [{ sourceUri: 'file:///project/AGENTS.md', revision: 'abc123' }],
      },
    };
    if (mode === 'oversized') reply.result.content[0].text = 'x'.repeat(70_000);
    if (mode === 'wrong-revision') reply.result.structuredContent.items[0].revision = 'stale';
  } else {
    reply.error = { code: -32601, message: 'Method not found.' };
  }
  output(reply);
  if (message.method === 'tools/call' && message.params.name === 'fixture_error') {
    if (mode === 'trailing-stdout') process.stdout.write('ready\n');
    if (mode === 'delayed-trailing-stdout') setTimeout(() => process.stdout.write('ready\n'), 10);
  }
}
