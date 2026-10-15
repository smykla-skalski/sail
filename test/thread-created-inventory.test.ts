import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  createSidebarListingClock,
  mergeSidebarRefreshPaths,
} from '../src/lib/sidebar-inventory.ts';

const app = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
const script = app.slice(app.indexOf('>') + 1, app.indexOf('</script>'));
const parsed = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
const names = new Set(['createAgentThread', 'createPaneThread', 'refreshCreatedThreadInventory']);
const handlers = parsed.statements
  .filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ''))
  .map((node) => node.getText(parsed))
  .join('\n');
assert.equal(handlers.match(/function /g)?.length, 3);
const compiled = ts.transpileModule(handlers, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
}).outputText;

for (const pane of ['main', 'split']) {
  for (const directory of ['/repo', '/outside']) {
    void test(`${pane} thread creation lists only ${directory} and preserves the startup focus clock`, () => {
      const clock = createSidebarListingClock();
      const directories = ['/repo', '/other'];
      clock.plan(directories, null, 0);
      const outside = new Set<string>();
      const scheduled: { delay: number; paths: string[] }[] = [];
      const context = {
        acpAgent: 'opencode',
        directory,
        acpThread: null,
        paneLayout: {},
        sidebarDirectoryKey: JSON.stringify(directories),
        sidebarInventoryOutside: outside,
        saveAgentThread() {},
        rememberRecentThread() {},
        invalidatePaneSelection() {},
        migrateDiffComments() {},
        diffCommentKey: () => '',
        updatePane: () => ({}),
        savePaneLayout() {},
        scheduleSidebarInventoryRefresh(delay: number, paths: string[]) {
          scheduled.push({ delay, paths: Array.from(paths) });
        },
        thread: { agent: 'opencode', directory, sessionId: 'new', updated: 1, title: 'New' },
      };
      runInNewContext(
        `${compiled}\n${pane === 'main' ? 'createAgentThread(thread)' : "createPaneThread('right', thread)"}`,
        context,
      );
      assert.deepEqual(scheduled, [{ delay: 250, paths: [directory] }]);
      assert.equal(outside.has(directory), directory === '/outside');
      assert.deepEqual(
        clock.plan(
          directories,
          mergeSidebarRefreshPaths(undefined, scheduled[0].paths),
          1000,
          outside,
        ),
        [directory],
      );
      assert.equal(clock.focusRefreshDue(1001), false);
    });
  }
}
