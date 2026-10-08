import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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
      head: { sha: found.head },
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
  if (args[0] === 'api' && method === 'PUT' && /\/pulls\/\d+\/merge$/.test(endpoint)) {
    log({
      method,
      endpoint,
      fields: args.filter((arg) => arg.includes('=') && !arg.startsWith('repos/')),
    });
    answer({ merged: true });
  }
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
