import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  WriteCounter,
  defaults,
  evaluate,
  formatReport,
  measureTree,
  median,
  parseOptions,
  parseProcessTable,
  rssWindows,
  snapshot,
  startupMaintenance,
} from '../scripts/footprint-measure.mjs';
import {
  createStaleScratchRoots,
  createTemporaryClutter,
  createWorktrees,
  deadOwnerIdentity,
  profileSettings,
  removePrivateRoot,
  scratchMarker,
} from '../scripts/footprint-profile.mjs';

const minute = 60_000;

function scratch(context: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'sail-footprint-test-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

await test('options default to the 26-worktree profile and 10-minute and 2-hour samples', () => {
  assert.deepEqual(parseOptions([]), defaults);
  assert.equal(defaults.worktrees, 26);
  assert.ok(defaults.staleRoots >= 30);
  assert.equal(defaults.firstMinutes, 10);
  assert.equal(defaults.secondMinutes, 120);
  assert.equal(defaults.tolerance, 0.1);
  assert.equal(defaults.rssWindowMinutes, 40);
  assert.equal(defaults.maintenanceLimitSeconds, 30);
});

await test('options accept both flag forms and reject unusable values', () => {
  const options = parseOptions(['--app', '/tmp/a.app', '--worktrees=3', '--second-minutes', '30']);
  assert.equal(options.app, '/tmp/a.app');
  assert.equal(options.worktrees, 3);
  assert.equal(options.secondMinutes, 30);
  assert.deepEqual(parseOptions(['--help']), { help: true });
  for (const argv of [
    ['--worktrees', 'many'],
    ['--worktrees', '2.5'],
    ['--worktrees'],
    ['--tolerance', '2'],
    ['--first-minutes', '20', '--second-minutes', '20'],
    ['--window-minutes', '11'],
    ['--rss-window-minutes', '0'],
    ['--bogus'],
  ])
    assert.throws(() => parseOptions(argv), undefined, argv.join(' '));
});

await test('the process tree counts descendants and sums their memory with the app', () => {
  const rows = parseProcessTable(
    [
      '  1     0  100',
      ' 10     1  2000',
      ' 11    10  300',
      ' 12    11  40',
      ' 13    10  5',
      ' 20     1  9000',
      ' 21    20  9000',
      'not a row',
    ].join('\n'),
  );
  assert.equal(rows.length, 7);
  assert.deepEqual(measureTree(rows, 10), { children: 3, rssBytes: (2000 + 300 + 40 + 5) * 1024 });
  assert.deepEqual(measureTree(rows, 21), { children: 0, rssBytes: 9000 * 1024 });
  assert.equal(measureTree(rows, 99), null);
});

await test('a parent loop in the process table does not hang the walk', () => {
  const rows = parseProcessTable('1 2 10\n2 1 10');
  assert.deepEqual(measureTree(rows, 1), { children: 1, rssBytes: 20 * 1024 });
});

await test('the median ignores a transient outlier', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 100, 2, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

await test('settings writes count new and replaced files but not the first look', () => {
  const counter = new WriteCounter();
  counter.observe(new Map([['settings.json', '1:100:10']]), 1000);
  counter.observe(new Map([['settings.json', '1:100:10']]), 2000);
  assert.deepEqual(counter.times, []);
  counter.observe(new Map([['settings.json', '2:200:10']]), 3000);
  counter.observe(
    new Map([
      ['settings.json', '2:200:10'],
      ['records/a.json', '9:300:5'],
    ]),
    4000,
  );
  counter.observe(new Map([['settings.json', '2:200:10']]), 5000);
  assert.deepEqual(counter.times, [3000, 4000]);
});

await test('a snapshot reports medians and per-minute rates over its trailing window only', () => {
  const samples = [
    { time: 1 * minute, children: 40, rssBytes: 9e9 },
    ...[6, 7, 8, 9, 10].map((at) => ({ time: at * minute, children: 3, rssBytes: 100 + at })),
    { time: 8.5 * minute, children: 30, rssBytes: 100 },
  ];
  const listings = [2 * minute, 6.5 * minute, 7 * minute, 11 * minute];
  const writes = [6 * minute, 9.9 * minute];
  const result = snapshot({ samples, listings, writes, at: 10 * minute, windowMs: 5 * minute });
  assert.equal(result.readings, 6);
  assert.equal(result.children, 3);
  assert.equal(result.listingsPerMinute, 2 / 5);
  assert.equal(result.settingsWritesPerMinute, 2 / 5);
});

await test('a snapshot without readings has no medians', () => {
  const result = snapshot({ samples: [], listings: [], writes: [], at: 10 * minute, windowMs: 1 });
  assert.equal(result.children, null);
  assert.equal(result.rssBytes, null);
});

const snap = (children: number | null, rssBytes: number | null, at: number) => ({
  at,
  readings: 30,
  children,
  rssBytes,
  listingsPerMinute: 0,
  settingsWritesPerMinute: 0,
});

const MB = 1024 * 1024;

type Phase = { children: number; rssMb: number };

/** One reading every 10 s from minute 1 to minute 120, shaped by `shape(minute)`. */
function series(shape: (minute: number) => Phase) {
  const samples = [];
  for (let at = minute; at <= 120 * minute; at += 10_000) {
    const { children, rssMb } = shape(at / minute);
    samples.push({ time: at, children, rssBytes: rssMb * MB });
  }
  return samples;
}

/** The measured cycle: 3 children and about 90 MB, then none and about 46 MB, every 40 minutes. */
const cycling =
  (activeMb: (minute: number) => number) =>
  (at: number): Phase =>
    at % 40 < 25 ? { children: 3, rssMb: activeMb(at) } : { children: 0, rssMb: 46 };

const verdictFor = (
  samples: ReturnType<typeof series>,
  overrides: { first?: [number | null, number]; elapsed?: number | null; tolerance?: number } = {},
) => {
  const [children, rssMb] = overrides.first ?? [3, 90];
  const elapsed = overrides.elapsed === undefined ? 1000 : overrides.elapsed;
  return evaluate({
    first: snap(children, rssMb * MB, 10 * minute),
    second: snap(children, rssMb * MB, 120 * minute),
    samples,
    launchedAt: 0,
    maintenance: elapsed === null ? null : { elapsedMs: elapsed },
    options: { ...defaults, ...(overrides.tolerance ? { tolerance: overrides.tolerance } : {}) },
  });
};

await test('a cycling footprint without growth passes whatever the cycle phase at each window', () => {
  const samples = series(cycling((at) => 78 + 18 * Math.sin(at)));
  const verdict = verdictFor(samples);
  assert.equal(verdict.rss.pass, true);
  assert.equal(verdict.pass, true);
  const [active, idle] = verdict.rss.windows.phases;
  assert.equal(active.compared, true);
  assert.equal(idle.compared, true);
  assert.ok(Math.abs(idle.ratio) < 0.001);
});

await test('the old single-sample comparison failed that same cycle', () => {
  const samples = series(cycling(() => 90));
  const at = (minuteMark: number) =>
    snapshot({ samples, listings: [], writes: [], at: minuteMark * minute, windowMs: 5 * minute });
  assert.ok(Math.abs(at(120).rssBytes! / at(10).rssBytes! - 1) > 0.1);
  assert.equal(verdictFor(samples).rss.pass, true);
});

await test('steady growth across the run fails in every phase', () => {
  const verdict = verdictFor(
    series((at) =>
      at % 40 < 25 ? { children: 3, rssMb: 90 + at * 0.5 } : { children: 0, rssMb: 46 + at * 0.25 },
    ),
  );
  assert.equal(verdict.rss.pass, false);
  assert.equal(verdict.pass, false);
  for (const phase of verdict.rss.windows.phases) assert.equal(phase.pass, false, phase.name);
});

await test('growth in one phase alone fails the run', () => {
  const verdict = verdictFor(
    series((at) => (at % 40 < 25 ? { children: 3, rssMb: 90 + at } : { children: 0, rssMb: 46 })),
  );
  const [active, idle] = verdict.rss.windows.phases;
  assert.equal(active.pass, false);
  assert.equal(idle.pass, true);
  assert.equal(verdict.rss.pass, false);
});

await test('the windows are two equal spans after the first sample point and ending at the second', () => {
  const windows = rssWindows({ samples: [], launchedAt: 0, options: defaults });
  assert.equal(windows.widthMinutes, 40);
  assert.deepEqual(windows.early, { from: 10 * minute, to: 50 * minute });
  assert.deepEqual(windows.late, { from: 80 * minute, to: 120 * minute });
});

await test('short runs shorten the windows so they never overlap', () => {
  const windows = rssWindows({
    samples: [],
    launchedAt: 0,
    options: { ...defaults, firstMinutes: 10, secondMinutes: 30 },
  });
  assert.equal(windows.widthMinutes, 10);
  assert.ok(windows.early.to <= windows.late.from);
});

await test('windows count only readings after launch inside their span', () => {
  const launchedAt = 5_000_000;
  const samples = [
    { time: launchedAt + 9 * minute, children: 0, rssBytes: 1 },
    ...[11, 30, 50].map((at) => ({
      time: launchedAt + at * minute,
      children: 0,
      rssBytes: 2 * MB,
    })),
    { time: launchedAt + 51 * minute, children: 0, rssBytes: 3 },
  ];
  const [, idle] = rssWindows({ samples, launchedAt, options: defaults }).phases;
  assert.equal(idle.early.readings, 3);
  assert.equal(idle.early.rssBytes, 2 * MB);
  assert.equal(idle.late.readings, 0);
});

await test('a phase with too few readings in either window is skipped, and no phase at all fails', () => {
  const idleOnly = series(() => ({ children: 0, rssMb: 46 }));
  const verdict = verdictFor(idleOnly, { first: [0, 46] });
  assert.equal(verdict.rss.windows.phases[0].compared, false);
  assert.equal(verdict.rss.windows.phases[1].compared, true);
  assert.equal(verdict.rss.pass, true);
  const none = verdictFor([]);
  assert.equal(none.rss.compared, 0);
  assert.equal(none.rss.pass, false);
  assert.equal(none.pass, false);
});

await test('the verdict applies the child and startup thresholds', () => {
  const flat = series(() => ({ children: 3, rssMb: 90 }));
  const cases = [
    { name: 'flat', first: [10, 90], elapsed: 29_999, pass: true },
    { name: 'children grew', second: 12, elapsed: 1000, pass: false },
    { name: 'children shrank', second: 8, elapsed: 1000, pass: false },
    { name: 'slow startup', elapsed: 30_000, pass: false },
    { name: 'no maintenance', elapsed: null, pass: false },
    { name: 'no readings', first: [null, 90], elapsed: 1000, pass: false },
    { name: 'idle from zero', first: [0, 90], second: 0, elapsed: 1, pass: true },
    { name: 'zero to one', first: [0, 90], second: 1, elapsed: 1, pass: false },
  ] as {
    name: string;
    first?: [number | null, number];
    second?: number;
    elapsed: number | null;
    pass: boolean;
  }[];
  for (const item of cases) {
    const first = item.first ?? [10, 90];
    const verdict = evaluate({
      first: snap(first[0], first[1] * MB, 10 * minute),
      second: snap(item.second ?? first[0], first[1] * MB, 120 * minute),
      samples: flat,
      launchedAt: 0,
      maintenance: item.elapsed === null ? null : { elapsedMs: item.elapsed },
      options: defaults,
    });
    assert.equal(verdict.pass, item.pass, item.name);
  }
});

await test('the tolerance is configurable for memory windows', () => {
  const grow = series((at) => ({ children: 3, rssMb: at < 60 ? 100 : 120 }));
  assert.equal(verdictFor(grow).rss.pass, false);
  assert.equal(verdictFor(grow, { tolerance: 0.25 }).rss.pass, true);
});

const finished = (timestampMs: number, elapsedMs: number) =>
  JSON.stringify({
    timestampMs,
    event: 'startup_maintenance_finished',
    details: { elapsedMs, scratchSweepMs: elapsedMs - 1 },
  });

await test('the maintenance duration comes from the last finished event after launch', () => {
  const log = [
    finished(1000, 5),
    JSON.stringify({ timestampMs: 5000, event: 'startup_maintenance_started', details: {} }),
    '{"timestampMs":6000,"event":"startup_maintenance_fini',
    finished(7000, 21_000),
    '',
  ].join('\n');
  assert.deepEqual(startupMaintenance(log, 4000), { elapsedMs: 21_000, scratchSweepMs: 20_999 });
  assert.equal(startupMaintenance(log, 8000), null);
  assert.equal(startupMaintenance('', 0), null);
});

await test('the latest finished event wins whatever the file order', () => {
  const log = [finished(9000, 50), finished(7000, 21_000)].join('\n');
  assert.deepEqual(startupMaintenance(log, 0)?.elapsedMs, 50);
});

await test('the report prints the windows, the phases, the difference and the verdicts', () => {
  const first = {
    ...snap(3, 0, 10 * minute),
    listingsPerMinute: 1.2,
    settingsWritesPerMinute: 0.4,
  };
  const second = {
    ...snap(3, 0, 120 * minute),
    listingsPerMinute: 0.2,
    settingsWritesPerMinute: 0.4,
  };
  const maintenance = { elapsedMs: 21_500, scratchSweepMs: 21_400 };
  const samples = series((at) => ({ children: 3, rssMb: at < 60 ? 150 : 156 }));
  const verdict = evaluate({
    first,
    second,
    samples,
    launchedAt: 0,
    maintenance,
    options: defaults,
  });
  const report = formatReport({
    first,
    second,
    verdict,
    maintenance,
    options: defaults,
    launchedAt: 0,
  });
  assert.match(report, /At 10\.0 min\s+At 120\.0 min\s+Difference/);
  assert.match(report, /Child processes\s+3\s+3\s+\+0/);
  assert.match(report, /ACP session listings \/ min\s+1\.2\s+0\.2\s+-1\.0/);
  assert.match(report, /two 40\.0-minute windows/);
  assert.match(report, /Phase\s+10\.0-50\.0 min\s+80\.0-120\.0 min\s+Difference\s+Change/);
  assert.match(report, /active\s+150\.0 MB \(240\)\s+156\.0 MB \(240\)\s+\+6\.0 MB\s+\+4\.0%/);
  assert.match(report, /idle\s+n\/a \(0\)\s+n\/a \(0\)\s+not compared\s+n\/a/);
  assert.match(report, /PASS\s+child processes \+0\.0%/);
  assert.match(report, /PASS\s+total RSS active \+4\.0% \(limit ±10%\)/);
  assert.match(report, /PASS\s+startup maintenance 21\.5 s \(limit 30 s\); scratchSweep 21400 ms/);
  assert.match(report, /RESULT: PASS$/);
});

await test('a failing report names the failed threshold', () => {
  const first = snap(3, 100, 10 * minute);
  const second = snap(9, 100, 120 * minute);
  const verdict = evaluate({
    first,
    second,
    samples: [],
    launchedAt: 0,
    maintenance: null,
    options: defaults,
  });
  const report = formatReport({
    first,
    second,
    verdict,
    maintenance: null,
    options: defaults,
    launchedAt: 0,
  });
  assert.match(report, /FAIL\s+child processes \+200\.0%/);
  assert.match(report, /FAIL\s+total RSS no phase had enough readings in both windows/);
  assert.match(report, /FAIL\s+startup maintenance did not finish/);
  assert.match(report, /RESULT: FAIL$/);
});

await test('the generated profile has the requested linked worktrees', (context) => {
  const root = scratch(context);
  const profile = createWorktrees(root, 4);
  assert.equal(profile.worktrees.length, 4);
  const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: profile.repository,
    encoding: 'utf8',
  }).stdout;
  for (const worktree of profile.worktrees) {
    assert.ok(listed.includes(`worktree ${worktree.path}`), worktree.path);
    assert.ok(existsSync(join(worktree.path, 'src/module-0/file-0.txt')));
  }
  const settings = profileSettings(profile);
  assert.equal(settings['sai-directory'], profile.repository);
  const catalog = JSON.parse(settings['sai-project-catalog']);
  assert.deepEqual(catalog.repositories, [profile.repository]);
  assert.deepEqual(catalog.worktrees[profile.repository], profile.worktrees);
});

await test('stale scratch roots look abandoned to the startup sweep', (context) => {
  const temporary = scratch(context);
  const owner = deadOwnerIdentity();
  const [pid, started] = owner.split(' ').map(Number);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.ok(started > 0);
  const now = Date.now();
  const roots = createStaleScratchRoots(temporary, 3, owner, now);
  assert.equal(roots.length, 3);
  for (const root of roots) {
    assert.match(root, /sail-footprint-stale-\d{3}$/);
    assert.equal(readFileSync(join(root, scratchMarker), 'utf8'), owner);
    const idle = now - 2 * 60 * 60 * 1000;
    for (const path of [root, join(root, 'build'), join(root, 'build/unit-0/object-0.o')])
      assert.ok(statSync(path).mtimeMs < idle, path);
    assert.ok(!existsSync(join(root, '.git')));
  }
});

await test('temporary clutter adds the requested number of unrelated entries', (context) => {
  const temporary = scratch(context);
  mkdirSync(join(temporary, 'keep'));
  createTemporaryClutter(temporary, 7);
  assert.equal(
    [...Array(7).keys()].filter((index) => existsSync(join(temporary, `clutter-${index}`))).length,
    7,
  );
  assert.ok(existsSync(join(temporary, 'keep')));
});

await test('the fixture repository ignores the user git signing configuration', (context) => {
  const root = scratch(context);
  const config = join(root, 'gitconfig');
  writeFileSync(config, '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /usr/bin/false\n');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  context.after(() => {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  });
  assert.equal(createWorktrees(join(root, 'profile'), 1).worktrees.length, 1);
});

await test('a private root holding a write-only quarantine from a killed sweep is removed', (context) => {
  const base = scratch(context);
  const root = join(base, 'sail-footprint-abc123');
  const quarantine = join(root, 'run/tmp/sail-cleanup-private-x/hidden/deep');
  mkdirSync(quarantine, { recursive: true });
  writeFileSync(join(quarantine, 'file'), 'x');
  chmodSync(join(root, 'run/tmp/sail-cleanup-private-x'), 0o300);
  removePrivateRoot(root, base);
  assert.equal(existsSync(root), false);
});

await test('only footprint roots directly under the base are removed', (context) => {
  const base = scratch(context);
  const other = join(base, 'sail-other');
  const nested = join(base, 'nested/sail-footprint-abc123');
  mkdirSync(other);
  mkdirSync(nested, { recursive: true });
  assert.throws(() => removePrivateRoot(other, base), /Refusing/);
  assert.throws(() => removePrivateRoot(nested, base), /Refusing/);
  assert.ok(existsSync(other) && existsSync(nested));
});
