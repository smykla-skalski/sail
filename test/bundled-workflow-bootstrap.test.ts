import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { bundledSkillReferences } from '../src/lib/bundled-skill-catalog.ts';

void test('cold reference delivery retains a runnable complete package after source deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sail-bundle-bootstrap-'));
  try {
    const managedPython = spawnSync('mise', ['which', 'python'], { encoding: 'utf8' });
    const python =
      process.env.SAIL_TEST_PYTHON ??
      (managedPython.status === 0 ? managedPython.stdout.trim() : 'python3');
    const source = join(root, 'materialized');
    const store = join(root, 'pins');
    const pin = JSON.parse(
      await readFile(new URL('../skills/sai-pin.json', import.meta.url), 'utf8'),
    );
    for (const name of bundledSkillReferences['ship-it']) {
      const relative =
        name === 'sai-pin.json'
          ? 'skills/sai-pin.json'
          : name === 'plugin.json'
            ? name
            : `skills/ship-it/${name.includes('/') || name === 'SKILL.md' ? name : `references/${name}`}`;
      const body = await readFile(new URL(`../${relative}`, import.meta.url));
      if (name !== 'sai-pin.json')
        assert.equal(createHash('sha256').update(body).digest('hex'), pin.files[relative], name);
      const destination = join(source, name === 'sai-pin.json' ? name : relative);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, body);
    }
    const run = (script: string, ...args: string[]) => {
      const result = spawnSync(python, ['-B', script, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    const bootstrap = join(source, 'skills/ship-it/scripts/plugin_pins.py');
    const supported = JSON.parse(run(bootstrap, 'supported'));
    assert.equal(typeof supported.supported, 'boolean');
    if (!supported.supported) {
      await assert.rejects(readdir(store), { code: 'ENOENT' });
      return;
    }
    const acquired = JSON.parse(
      run(
        bootstrap,
        '--store',
        store,
        'acquire',
        '--source',
        source,
        '--owner-pid',
        String(process.pid),
      ),
    );
    await rm(source, { recursive: true });
    const pinnedHelper = join(acquired.skillRoot, 'scripts/plugin_pins.py');
    assert.deepEqual(
      JSON.parse(await readFile(join(acquired.bundle, 'sai-pin.json'), 'utf8')),
      pin,
    );
    assert.equal(pin.files['skills/sai-pin.json'], undefined);
    const second = JSON.parse(
      run(
        pinnedHelper,
        '--store',
        store,
        'acquire',
        '--source',
        acquired.bundle,
        '--owner-pid',
        String(process.pid),
      ),
    );
    run(join(acquired.skillRoot, 'scripts/bookkeeping.py'), '--help');
    run(join(acquired.skillRoot, 'scripts/bookkeeping.py'), 'record-worker-event', '--help');
    const helper = join(acquired.skillRoot, 'scripts/bookkeeping.py');
    const created = JSON.parse(
      run(
        helper,
        'create',
        '--repository',
        process.cwd(),
        '--identity',
        'github.com/smykla-skalski/sail',
        '--source-json',
        JSON.stringify({
          sourceType: 'description',
          repository: 'github.com/smykla-skalski/sail',
          objective: 'cold recovery fixture',
          acceptanceCriteria: ['retain receipt'],
        }),
        '--title',
        'cold recovery fixture',
        '--source-url',
        'https://github.com/smykla-skalski/sail/issues/2',
        '--objective',
        'cold recovery fixture',
        '--criteria-json',
        '["retain receipt"]',
        '--checkpoint-dir',
        join(root, 'checkpoints'),
      ),
    );
    const command = (name: string, option: string, value: unknown) =>
      JSON.parse(
        run(helper, name, '--checkpoint', created.checkpoint, option, JSON.stringify(value)),
      );
    const issue = 'https://github.com/smykla-skalski/sail/issues/1';
    command('set-orchestration', '--orchestration-json', {
      umbrellaUrl: 'https://github.com/smykla-skalski/sail/issues/2',
      children: [{ issueUrl: issue, dependencies: [] }],
      nextAction: 'fixture dispatch',
    });
    command('record-orchestration-event', '--event-json', {
      eventId: 'dispatch',
      kind: 'dispatch',
      issueUrl: issue,
      dispatchId: 'worker-1',
      expectedRevision: null,
      data: {
        worker: 'native-1',
        worktree: process.cwd(),
        branch: 'fix/fixture',
        revision: 'a'.repeat(40),
      },
      nextAction: 'fixture recovery',
    });
    const readCheckpoint = async () => JSON.parse(await readFile(created.checkpoint, 'utf8'));
    const before = await readCheckpoint();
    const event = (kind: string, data: unknown, at: string) =>
      command('record-worker-event', '--event-json', { dispatchId: 'worker-1', kind, at, data });
    event(
      'register',
      { target: { issueUrl: issue }, owner: null, deadlineAt: '2026-10-16T00:10:00Z' },
      '2026-10-16T00:00:00Z',
    );
    event('bind-owner', { owner: 'native-1' }, '2026-10-16T00:00:01Z');
    event('started', {}, '2026-10-16T00:00:02Z');
    event(
      'result',
      { eventId: 'result-1', status: 'completed', checkpointPath: created.checkpoint },
      '2026-10-16T00:01:00Z',
    );
    const resumed = command('reconcile-workers', '--observation-json', {
      at: '2026-10-16T01:00:00Z',
    });
    assert.equal(resumed.workers[0].state, 'completed-but-undelivered');
    assert.equal(resumed.workers[0].deadlineExceeded, true);
    assert.equal(resumed.workers[0].ownerHeld, true);
    assert.equal(resumed.workers[0].result.eventId, 'result-1');
    event('acknowledge', { eventId: 'result-1' }, '2026-10-16T01:00:01Z');
    assert.equal(
      event('acknowledge', { eventId: 'result-1' }, '2026-10-16T01:00:01Z').applied,
      false,
    );
    const after = await readCheckpoint();
    for (const field of ['authorization', 'convergence', 'gateVerdicts', 'orchestration'])
      assert.deepEqual(after[field], before[field], field);
    assert.equal(after.workerRecovery.length, 1);
    const core = await readFile(join(acquired.skillRoot, 'SKILL.md'));
    assert.equal(
      createHash('sha256').update(core).digest('hex'),
      pin.files['skills/ship-it/SKILL.md'],
    );
    const live = JSON.parse(run(pinnedHelper, '--store', store, 'collect', '--limit', '3'));
    assert.ok(live);
    run(pinnedHelper, '--store', store, 'release', '--lease', acquired.lease);
    run(pinnedHelper, '--store', store, 'collect', '--limit', '3');
    assert.equal(await readFile(join(second.skillRoot, 'SKILL.md'), 'utf8'), core.toString());
    run(pinnedHelper, '--store', store, 'release', '--lease', second.lease);
    run(pinnedHelper, '--store', store, 'collect', '--limit', '3');
    await assert.rejects(readFile(join(acquired.skillRoot, 'SKILL.md')), { code: 'ENOENT' });
  } finally {
    const writableDirectories = async (directory: string): Promise<void> => {
      await chmod(directory, 0o700);
      for (const entry of await readdir(directory, { withFileTypes: true }))
        if (entry.isDirectory()) await writableDirectories(join(directory, entry.name));
    };
    await writableDirectories(root);
    await rm(root, { recursive: true, force: true });
  }
});
