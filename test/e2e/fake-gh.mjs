import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const directory = process.env.SAIL_E2E_FAKE_GH_DIR;
const statePath = directory && join(directory, 'state.json');

function state() {
  return statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
}

function log(entry) {
  if (directory) appendFileSync(join(directory, 'calls.jsonl'), `${JSON.stringify(entry)}\n`);
}

function answer(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
  process.exit(0);
}

const pull = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(
  args.find((arg) => arg.startsWith('repos/')) ?? '',
);
const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? '';
const fixture = state();

if (fixture.pulls) {
  if (args[0] === 'repo' && args[1] === 'view')
    answer({ nameWithOwner: fixture.repository ?? 'fixture/repo', isFork: false });
  if (args[0] === 'pr' && args[1] === 'list') {
    const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const wanted = option('--head');
    const repository = option('--repo') ?? fixture.repository;
    const wantedState = option('--state') ?? 'open';
    answer(
      Object.entries(fixture.pulls)
        .filter(
          ([key, found]) =>
            (!repository || key.split('#')[0] === repository) &&
            (wantedState === 'all' ||
              (wantedState === 'merged'
                ? found.merged
                : found.state === wantedState && !found.merged)) &&
            (!wanted ||
              wanted === found.branch ||
              wanted === `${key.split('/')[0]}:${found.branch}`),
        )
        .map(([key, found]) => ({
          number: Number(key.split('#')[1]),
          url: `https://github.com/${key.replace('#', '/pull/')}`,
          state: found.merged ? 'MERGED' : found.state.toUpperCase(),
          mergedAt: found.merged ? '2026-01-01T00:00:00Z' : null,
          headRefName: found.branch,
          headRepositoryOwner: { login: key.split('/')[0] },
          headRefOid: found.head,
          statusCheckRollup: [],
        })),
    );
  }
  if (
    args[0] === 'api' &&
    /^repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(endpoint) &&
    args.includes('--jq')
  ) {
    const filter = args[args.indexOf('--jq') + 1];
    answer(filter === '.title' ? 'Fixture issue' : 'open');
  }
  if (args[0] === 'api' && method === 'GET' && pull) {
    const found = fixture.pulls[`${pull[1]}#${pull[2]}`];
    if (!found) {
      process.stderr.write('Not Found\n');
      process.exit(1);
    }
    answer({
      state: found.state,
      merged: found.merged,
      draft: found.draft,
      mergeable: true,
      head: { sha: found.head, ref: found.branch, repo: { full_name: pull[1] } },
      base: { ref: 'main', repo: { full_name: pull[1] } },
    });
  }
  if (args[0] === 'api' && method === 'POST' && /\/issues\/\d+\/comments$/.test(endpoint)) {
    log({
      method,
      endpoint,
      fields: args.filter((arg) => arg.includes('=') && !arg.startsWith('repos/')),
    });
    answer({ id: 1 });
  }
  if (args[0] === 'api' && method === 'PATCH' && pull) {
    const key = `${pull[1]}#${pull[2]}`;
    const fields = args.filter((arg) => arg.includes('=') && !arg.startsWith('repos/'));
    log({ method, endpoint, fields });
    if (fixture.pulls[key]?.reopenRefused) {
      process.stderr.write('HTTP 422: Pull request cannot be reopened\n');
      process.exit(1);
    }
    if (fixture.pulls[key] && fields.includes('state=open')) {
      fixture.pulls[key].state = 'open';
      writeFileSync(statePath, JSON.stringify(fixture));
    }
    answer({ state: fixture.pulls[key]?.state ?? 'closed' });
  }
  if (args[0] === 'api' && method === 'PUT' && /\/pulls\/\d+\/merge$/.test(endpoint)) {
    log({
      method,
      endpoint,
      fields: args.filter((arg) => arg.includes('=') && !arg.startsWith('repos/')),
    });
    answer({ merged: true });
  }
}

if (process.env.SAIL_E2E_GH_ALLOW_REAL !== '1') {
  process.stderr.write(`Fake gh fixture has no response for ${JSON.stringify(args)}\n`);
  process.exit(1);
}

const search = (process.env.PATH ?? '')
  .split(delimiter)
  .filter((entry) => entry && entry !== process.env.SAIL_E2E_FAKE_GH_BIN);
const real = search.map((entry) => join(entry, 'gh')).find((candidate) => existsSync(candidate));
if (!real) {
  process.stderr.write('gh is not installed\n');
  process.exit(127);
}
const result = spawnSync(real, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
