import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import process from 'node:process';
import test from 'node:test';
import { z } from 'zod';
import { run } from '../scripts/opencode-probe-runner.mjs';

await test('probe child can call the parent HTTP fixture while its command runs', async (t) => {
  const server = createServer((_request, response) => response.end('fixture-response'));
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = z.object({ port: z.number() }).parse(server.address());

  const result = await run(
    process.execPath,
    [
      '-e',
      'fetch(process.argv[1]).then(r => r.text()).then(t => process.stdout.write(t))',
      `http://127.0.0.1:${port}`,
    ],
    { timeout: 10_000 },
  );

  assert.deepEqual(result, { status: 0, timedOut: false, stdout: 'fixture-response', stderr: '' });
});

await test('probe runner captures Unicode output and a nonzero child exit', async () => {
  const result = await run(process.execPath, [
    '-e',
    "process.stdout.write('│ stdout'); process.stderr.write('│ stderr'); process.exitCode = 7",
  ]);

  assert.deepEqual(result, { status: 7, timedOut: false, stdout: '│ stdout', stderr: '│ stderr' });
});

await test('probe runner terminates a child that exceeds its deadline', async () => {
  const result = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeout: 100,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.status, null);
});
