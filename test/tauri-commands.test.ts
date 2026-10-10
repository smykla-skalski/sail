import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path: string): string {
  return readFileSync(new URL(`../src-tauri/${path}`, import.meta.url), 'utf8');
}

await test('every Tauri command has a generated permission and capability', () => {
  const handler = source('src/lib.rs').match(/generate_handler!\[([\s\S]*?)\]/)?.[1];
  const manifest = source('build.rs').match(/\.commands\(&\[([\s\S]*?)\]\)/)?.[1];
  assert.ok(handler);
  assert.ok(manifest);

  const commands = handler
    .split(',')
    .map((entry) => entry.trim().split('::').at(-1))
    .filter((entry): entry is string => !!entry);
  const generated = new Set([...manifest.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
  const allowed = new Set<string>();
  for (const name of ['default', 'browser', 'settings']) {
    const capability: unknown = JSON.parse(source(`capabilities/${name}.json`));
    assert.ok(capability && typeof capability === 'object' && 'permissions' in capability);
    assert.ok(Array.isArray(capability.permissions));
    for (const permission of capability.permissions) {
      if (typeof permission === 'string' && permission.startsWith('allow-'))
        allowed.add(permission);
    }
  }

  const e2eConfig = JSON.parse(source('tauri.e2e.conf.json'));
  const e2eCapabilities: unknown = e2eConfig.app.security.capabilities;
  assert.ok(Array.isArray(e2eCapabilities));
  for (const capability of e2eCapabilities) {
    if (!capability || typeof capability !== 'object' || !('permissions' in capability)) continue;
    assert.ok(Array.isArray(capability.permissions));
    for (const permission of capability.permissions) {
      if (typeof permission === 'string' && permission.startsWith('allow-'))
        allowed.add(permission);
    }
  }

  for (const command of commands) {
    assert.ok(generated.has(command), `${command} has no generated permission`);
    assert.ok(allowed.has(`allow-${command.replaceAll('_', '-')}`), `${command} is not allowed`);
  }
});
