export const defaults = {
  worktrees: 26,
  staleRoots: 32,
  clutter: 1000,
  firstMinutes: 10,
  secondMinutes: 120,
  windowMinutes: 5,
  rssWindowMinutes: 40,
  intervalSeconds: 10,
  tolerance: 0.1,
  maintenanceLimitSeconds: 30,
};

const numeric = {
  '--worktrees': ['worktrees', 'integer', 1],
  '--stale-roots': ['staleRoots', 'integer', 0],
  '--clutter': ['clutter', 'integer', 0],
  '--first-minutes': ['firstMinutes', 'number', 0],
  '--second-minutes': ['secondMinutes', 'number', 0],
  '--window-minutes': ['windowMinutes', 'number', 0],
  '--rss-window-minutes': ['rssWindowMinutes', 'number', 0],
  '--interval-seconds': ['intervalSeconds', 'number', 0],
  '--tolerance': ['tolerance', 'number', 0],
  '--maintenance-limit-seconds': ['maintenanceLimitSeconds', 'number', 0],
};
const text = { '--app': 'app', '--json': 'json' };

export const usage = `Usage: npm run measure:footprint -- [options]

Launches a private Sail on a generated profile, samples it twice and checks that it stays flat.
Children are judged from the two samples. RSS is judged from two long windows, one after each sample
point, compared per phase (with and without child processes) because the footprint cycles.

  --app <path>                      Private "Sail E2E" bundle from "npm run build:e2e" (built when omitted)
  --json <file>                     Also write the result as JSON
  --worktrees <n>                   Linked worktrees in the profile (default ${defaults.worktrees})
  --stale-roots <n>                 Abandoned scratch roots for the startup sweep (default ${defaults.staleRoots})
  --clutter <n>                     Unrelated temporary entries the sweep must list (default ${defaults.clutter})
  --first-minutes <m>               First sample after launch (default ${defaults.firstMinutes})
  --second-minutes <m>              Second sample after launch (default ${defaults.secondMinutes})
  --window-minutes <m>              Trailing window each sample covers (default ${defaults.windowMinutes})
  --rss-window-minutes <m>          Width of each RSS comparison window, shortened to fit (default ${defaults.rssWindowMinutes})
  --interval-seconds <s>            Process sampling interval (default ${defaults.intervalSeconds})
  --tolerance <ratio>               Allowed drift of children between samples and of RSS between windows (default ${defaults.tolerance})
  --maintenance-limit-seconds <s>   Startup maintenance limit (default ${defaults.maintenanceLimitSeconds})
`;

function number(flag, value, kind, minimum) {
  const parsed = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(parsed))
    throw new Error(`${flag} needs a number`);
  if (kind === 'integer' && !Number.isInteger(parsed)) throw new Error(`${flag} needs an integer`);
  if (parsed < minimum) throw new Error(`${flag} must be at least ${minimum}`);
  return parsed;
}

export function parseOptions(argv) {
  const options = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    const [name, inline] = flag.split(/=(.*)/s, 2);
    const value = inline ?? argv[++index];
    if (numeric[name]) {
      const [key, kind, minimum] = numeric[name];
      options[key] = number(name, value, kind, minimum);
    } else if (text[name]) {
      if (!value) throw new Error(`${name} needs a value`);
      options[text[name]] = value;
    } else throw new Error(`Unknown option ${flag}`);
  }
  if (options.tolerance > 1) throw new Error('--tolerance is a ratio between 0 and 1');
  if (
    options.worktrees < 1 ||
    options.intervalSeconds <= 0 ||
    options.windowMinutes <= 0 ||
    options.rssWindowMinutes <= 0
  )
    throw new Error(
      '--worktrees, --interval-seconds, --window-minutes and --rss-window-minutes must be positive',
    );
  if (options.secondMinutes <= options.firstMinutes)
    throw new Error('--second-minutes must be later than --first-minutes');
  if (options.windowMinutes > options.firstMinutes)
    throw new Error('--window-minutes must not exceed --first-minutes');
  return options;
}

/** Rows of `ps -axo pid=,ppid=,rss=`. */
export function parseProcessTable(output) {
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    return match
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]) }]
      : [];
  });
}

/** The app plus every descendant: `children` excludes the app, `rssBytes` includes it. */
export function measureTree(rows, rootPid) {
  const byParent = Map.groupBy(rows, (row) => row.ppid);
  const own = rows.find((row) => row.pid === rootPid);
  if (!own) return null;
  const seen = new Set([rootPid]);
  const pending = [rootPid];
  let rssKb = own.rssKb;
  while (pending.length > 0) {
    for (const child of byParent.get(pending.pop()) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      rssKb += child.rssKb;
      pending.push(child.pid);
    }
  }
  return { children: seen.size - 1, rssBytes: rssKb * 1024 };
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const inWindow = (time, end, window) => time > end - window && time <= end;

/**
 * Counts changes between polls of a set of files. Writes go through a temporary file and a rename,
 * so a write shows as a new inode or modification time; several writes between two polls count once.
 */
export class WriteCounter {
  #previous;
  times = [];

  observe(files, now) {
    if (this.#previous) {
      for (const [path, signature] of files)
        if (this.#previous.get(path) !== signature) this.times.push(now);
    }
    this.#previous = files;
  }
}

/** One snapshot: medians of the process samples and event rates over the trailing window. */
export function snapshot({ samples, listings, writes, at, windowMs }) {
  const recent = samples.filter((sample) => inWindow(sample.time, at, windowMs));
  const perMinute = (times) =>
    (times.filter((time) => inWindow(time, at, windowMs)).length * 60_000) / windowMs;
  return {
    at,
    readings: recent.length,
    children: median(recent.map((sample) => sample.children)),
    rssBytes: median(recent.map((sample) => sample.rssBytes)),
    listingsPerMinute: perMinute(listings),
    settingsWritesPerMinute: perMinute(writes),
  };
}

function drift(first, second, tolerance) {
  if (first === null || second === null)
    return { first, second, delta: null, ratio: null, pass: false };
  const delta = second - first;
  const ratio = first === 0 ? (delta === 0 ? 0 : Number.POSITIVE_INFINITY) : delta / first;
  return { first, second, delta, ratio, pass: Math.abs(ratio) <= tolerance };
}

/** A phase needs this many readings in both windows to be compared. */
export const minimumPhaseReadings = 3;

const phaseNames = [
  ['active', (sample) => sample.children > 0],
  ['idle', (sample) => sample.children === 0],
];

/**
 * Two non-overlapping windows of the same width, one right after the first sample point and one
 * ending at the second. Medians are taken per phase, because the app alternates between running
 * with child processes and idling without them and the two phases differ in size by about 2x.
 */
export function rssWindows({ samples, launchedAt, options }) {
  const half = (options.secondMinutes - options.firstMinutes) / 2;
  const widthMinutes = Math.min(options.rssWindowMinutes, half);
  const width = widthMinutes * 60_000;
  const early = { from: options.firstMinutes * 60_000 };
  early.to = early.from + width;
  const late = { to: options.secondMinutes * 60_000 };
  late.from = late.to - width;
  const phases = phaseNames.map(([name, belongs]) => {
    const readings = (window) =>
      samples.filter(
        (sample) => belongs(sample) && inWindow(sample.time - launchedAt, window.to, width),
      );
    const summary = (window) => {
      const found = readings(window);
      return { readings: found.length, rssBytes: median(found.map((sample) => sample.rssBytes)) };
    };
    return { name, early: summary(early), late: summary(late) };
  });
  return { widthMinutes, early, late, phases };
}

function judgeRss(windows, tolerance) {
  const phases = windows.phases.map((phase) => {
    const compared =
      phase.early.readings >= minimumPhaseReadings && phase.late.readings >= minimumPhaseReadings;
    return {
      ...phase,
      compared,
      ...(compared
        ? drift(phase.early.rssBytes, phase.late.rssBytes, tolerance)
        : { delta: null, ratio: null, pass: true }),
    };
  });
  const comparedCount = phases.filter((phase) => phase.compared).length;
  return {
    windows: { ...windows, phases },
    compared: comparedCount,
    pass: comparedCount > 0 && phases.every((phase) => phase.pass),
  };
}

/** The details of the latest `startup_maintenance_finished` event at or after `since`, or null. */
export function startupMaintenance(log, since = 0) {
  let finished = null;
  let latest = -1;
  for (const line of log.split('\n')) {
    if (!line.includes('startup_maintenance_finished')) continue;
    const event = parseLine(line);
    if (
      event?.event === 'startup_maintenance_finished' &&
      event.timestampMs >= since &&
      event.timestampMs > latest &&
      typeof event.details?.elapsedMs === 'number'
    ) {
      finished = event.details;
      latest = event.timestampMs;
    }
  }
  return finished;
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function evaluate({ first, second, samples, launchedAt, maintenance, options }) {
  const children = drift(first.children, second.children, options.tolerance);
  const rss = judgeRss(rssWindows({ samples, launchedAt, options }), options.tolerance);
  const limitMs = options.maintenanceLimitSeconds * 1000;
  const elapsedMs = maintenance?.elapsedMs ?? null;
  const startup = { elapsedMs, limitMs, pass: elapsedMs !== null && elapsedMs < limitMs };
  return { children, rss, startup, pass: children.pass && rss.pass && startup.pass };
}

const fixed = (value, digits = 1) => (value === null ? 'n/a' : value.toFixed(digits));
const signed = (value, digits = 1) =>
  value === null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
const megabytes = (bytes) => (bytes === null ? 'n/a' : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const mark = (pass) => (pass ? 'PASS' : 'FAIL');
const gap = (a, b, scale = 1) => (a === null || b === null ? null : (b - a) / scale);
const minutes = (ms) => `${fixed(ms / 60_000)} min`;

function table(header, rows) {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column].length)),
  );
  return [header, ...rows].map((cells) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]))
      .join('  ')
      .trimEnd(),
  );
}

export function formatReport({ first, second, verdict, maintenance, options, launchedAt }) {
  const rows = [
    [
      'Child processes',
      fixed(first.children, 0),
      fixed(second.children, 0),
      signed(gap(first.children, second.children), 0),
    ],
    [
      'ACP session listings / min',
      fixed(first.listingsPerMinute),
      fixed(second.listingsPerMinute),
      signed(second.listingsPerMinute - first.listingsPerMinute),
    ],
    [
      'Settings file writes / min',
      fixed(first.settingsWritesPerMinute),
      fixed(second.settingsWritesPerMinute),
      signed(second.settingsWritesPerMinute - first.settingsWritesPerMinute),
    ],
  ];
  const header = [
    'Metric',
    `At ${minutes(first.at - launchedAt)}`,
    `At ${minutes(second.at - launchedAt)}`,
    'Difference',
  ];
  const percent = (check) => (check.ratio === null ? 'n/a' : `${signed(check.ratio * 100)}%`);
  const limit = `limit ±${options.tolerance * 100}%`;
  const { windows } = verdict.rss;
  const span = (window) => `${fixed(window.from / 60_000)}-${fixed(window.to / 60_000)} min`;
  const phaseRows = windows.phases.map((phase) => [
    phase.name,
    `${megabytes(phase.early.rssBytes)} (${phase.early.readings})`,
    `${megabytes(phase.late.rssBytes)} (${phase.late.readings})`,
    phase.compared
      ? `${signed(gap(phase.early.rssBytes, phase.late.rssBytes, 1024 * 1024))} MB`
      : 'not compared',
    phase.compared ? percent(phase) : 'n/a',
  ]);
  const phases = Object.entries(maintenance ?? {})
    .filter(([name]) => name.endsWith('Ms') && name !== 'elapsedMs')
    .map(([name, value]) => `${name.slice(0, -2)} ${value} ms`)
    .join(', ');
  const elapsed =
    verdict.startup.elapsedMs === null
      ? 'did not finish'
      : `${(verdict.startup.elapsedMs / 1000).toFixed(1)} s`;
  const rssDetail = verdict.rss.compared
    ? `${verdict.rss.windows.phases
        .filter((phase) => phase.compared)
        .map((phase) => `${phase.name} ${percent(phase)}`)
        .join(', ')} (${limit})`
    : 'no phase had enough readings in both windows';
  return [
    ...table(header, rows),
    '',
    `Child counts and rates are medians over the ${options.windowMinutes} minutes before each sample (${first.readings} and ${second.readings} readings).`,
    '',
    `Total RSS: median per phase over two ${fixed(windows.widthMinutes)}-minute windows (readings in brackets); active means the app has child processes.`,
    ...table(['Phase', span(windows.early), span(windows.late), 'Difference', 'Change'], phaseRows),
    '',
    `${mark(verdict.children.pass)}  child processes ${percent(verdict.children)} (${limit})`,
    `${mark(verdict.rss.pass)}  total RSS ${rssDetail}`,
    `${mark(verdict.startup.pass)}  startup maintenance ${elapsed} (limit ${verdict.startup.limitMs / 1000} s)${phases ? `; ${phases}` : ''}`,
    '',
    verdict.pass ? 'RESULT: PASS' : 'RESULT: FAIL',
  ].join('\n');
}
