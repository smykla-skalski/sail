import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';
import { privatePort, PrivateEndpointGuard } from './e2e-isolation.ts';

await test('private desktop runner rejects fallback and malformed ports without connecting', () => {
  for (const value of [undefined, '', '4445', '0', '1023', '65536', '50000junk', '5e4', '-1'])
    assert.throws(() => privatePort(value));
  assert.equal(privatePort('53063'), 53063);
});

await test('runner fails before service initialization when either endpoint differs', () => {
  const saved = process.env.TAURI_WEBDRIVER_PORT;
  process.env.TAURI_WEBDRIVER_PORT = '53063';
  try {
    const options = { port: 53063 };
    const config = { port: 53063, hostname: '127.0.0.1' };
    assert.doesNotThrow(() => new PrivateEndpointGuard(options, [{}], config));
    for (const override of [
      { port: 53064 },
      { port: 4445 },
      { hostname: 'example.test' },
      { 'tauri:options': { embeddedPort: 53064 } },
    ]) {
      assert.throws(() => new PrivateEndpointGuard(options, [override], config));
      assert.throws(() => new PrivateEndpointGuard(options, {}, { ...config, ...override }));
    }
    process.env.TAURI_WEBDRIVER_PORT = '53064';
    assert.throws(() => new PrivateEndpointGuard(options, {}, config));
    delete process.env.TAURI_WEBDRIVER_PORT;
    assert.throws(() => new PrivateEndpointGuard(options, {}, config));
  } finally {
    if (saved === undefined) delete process.env.TAURI_WEBDRIVER_PORT;
    else process.env.TAURI_WEBDRIVER_PORT = saved;
  }
});
