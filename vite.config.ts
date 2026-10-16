import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  // Keep mount and dynamically loaded components on the same Svelte runtime during dev startup.
  optimizeDeps: { exclude: ['svelte', '@smykla-skalski/sui'] },
  clearScreen: false,
  server: { host: '127.0.0.1', strictPort: true, port: 1420 },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: { target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13' },
});
