import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, optimizeDeps, resolveConfig } from 'vite';

void test('dev startup keeps mounting and lazy components on one Svelte runtime', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'sail-svelte-runtime-'));
  const options = {
    root: fileURLToPath(new URL('..', import.meta.url)),
    cacheDir: join(scratch, 'cache'),
    logLevel: 'silent' as const,
    optimizeDeps: { entries: [], noDiscovery: true },
    server: { middlewareMode: true as const, watch: null, hmr: false as const },
  };
  try {
    await writeFile(
      join(scratch, '.sail-scratch-root'),
      process.env.SAIL_SCRATCH_OWNER_IDENTITY ?? '',
    );
    const config = await resolveConfig(options, 'serve');
    const metadata = await optimizeDeps(config, true);

    assert.equal(metadata.optimized.svelte, undefined);
    assert.equal(metadata.optimized['svelte/internal/client'], undefined);
    assert.equal(metadata.optimized['@smykla-skalski/sui'], undefined);

    const server = await createServer(options);
    try {
      const main = await server.transformRequest('/src/main.ts');
      const app = await server.transformRequest('/src/App.svelte');
      const button = await server.transformRequest(
        '/node_modules/@smykla-skalski/sui/dist/components/Button.svelte',
      );

      assert.ok(main);
      assert.ok(app);
      assert.ok(button);
      assert.match(
        main.code,
        /import \{ mount \} from "[^"\n]*\/node_modules\/svelte\/src\/index-client\.js/,
      );
      const runtimeImport =
        /from "([^"\n]*\/node_modules\/svelte\/src\/internal\/client\/index\.js[^"\n]*)"/;
      const appRuntime = runtimeImport.exec(app.code)?.[1];
      const buttonRuntime = runtimeImport.exec(button.code)?.[1];
      assert.ok(appRuntime);
      assert.equal(buttonRuntime, appRuntime);
    } finally {
      await server.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
