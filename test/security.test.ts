import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { safeMarkdownHref } from '../src/lib/markdown.ts';

function config(path: string) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

await test('desktop probe uses the release content policy', () => {
  const release = config('../src-tauri/tauri.conf.json');
  const desktop = config('../src-tauri/tauri.e2e.conf.json');
  assert.deepEqual(desktop.app.security.devCsp, release.app.security.csp);
  assert.equal(release.app.security.csp['object-src'], "'none'");
  assert.equal(release.app.security.csp['frame-src'], "'none'");
  assert.equal(release.app.security.csp['connect-src'].includes('http://localhost:1420'), false);
  assert.equal(release.app.security.csp['connect-src'], 'ipc: http://ipc.localhost');
});

await test('agent Markdown cannot navigate to executable or local URLs', () => {
  for (const href of [
    'javascript:alert(1)',
    ' java\nscript:alert(1)',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'file:///etc/passwd',
    'tauri://localhost',
    'vbscript:msgbox(1)',
    '//attacker.example/path',
  ]) {
    assert.equal(safeMarkdownHref(href), null, href);
  }
});
