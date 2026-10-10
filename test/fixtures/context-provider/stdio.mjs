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
    reply.result = {
      protocolVersion: mode === 'wrong-version' ? '2024-11-05' : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'sail-fixture', version: '1.0.0' },
    };
  } else if (message.method === 'tools/list') {
    reply.result = {
      tools: [
        { name: 'fixture_search', inputSchema: { type: 'object', properties: {} } },
        { name: 'fixture_error', inputSchema: { type: 'object', properties: {} } },
      ],
    };
  } else if (message.method === 'tools/call' && message.params.name === 'fixture_error') {
    reply.result = { isError: true, content: [{ type: 'text', text: 'Request denied.' }] };
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
}
