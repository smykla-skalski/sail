import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

type Ticket = { pid: number; state: 'queued' | 'running' };

function settingsPath(env: NodeJS.ProcessEnv): string {
  if (env.SAIL_RESOURCE_SETTINGS) {
    if (!isAbsolute(env.SAIL_RESOURCE_SETTINGS))
      throw new Error('SAIL_RESOURCE_SETTINGS must be an absolute path.');
    return env.SAIL_RESOURCE_SETTINGS;
  }
  if (env.SAIL_E2E_CONFIG_DIR) return join(env.SAIL_E2E_CONFIG_DIR, 'settings.json');
  const config =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
        : (env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  return join(config, 'sail', 'settings.json');
}

export function e2eJobLimit(env: NodeJS.ProcessEnv = process.env): number {
  const override = env.SAIL_E2E_JOB_LIMIT;
  let saved: unknown;
  if (override === undefined) {
    try {
      saved = JSON.parse(readFileSync(settingsPath(env), 'utf8'))['sai-e2e-job-limit'];
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') saved = undefined;
      else throw error;
    }
  }
  const value = override ?? saved;
  if (value === undefined) return 1;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || Number(value) > 32)
    throw new Error('E2E job limit must be an integer from 0 to 32.');
  return Number(value);
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

export class E2eJobQueue {
  private readonly directory: string;
  private readonly limitReader: () => number;
  private ticket = '';

  constructor(
    directory = process.env.SAIL_E2E_LIMIT_DIR ??
      join(tmpdir(), `sail-e2e-jobs-${process.getuid?.() ?? 'current-user'}`),
    limitReader: () => number = () => e2eJobLimit(),
  ) {
    this.directory = directory;
    this.limitReader = limitReader;
  }

  private lock(): Promise<() => void> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, '.lock');
    return new Promise((resolve, reject) => {
      const attempt = () => {
        try {
          mkdirSync(lock, { mode: 0o700 });
          writeFileSync(join(lock, 'pid'), String(process.pid));
          resolve(() => rmSync(lock, { recursive: true }));
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
            reject(error);
            return;
          }
          let owner = 0;
          try {
            owner = Number(readFileSync(join(lock, 'pid'), 'utf8'));
          } catch (cause) {
            if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) {
              reject(cause);
              return;
            }
          }
          try {
            if (!alive(owner) && Date.now() - statSync(lock).mtimeMs > 1000)
              rmSync(lock, { recursive: true });
          } catch (cause) {
            if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) {
              reject(cause);
              return;
            }
          }
          setTimeout(attempt, 50);
        }
      };
      attempt();
    });
  }

  private async locked<T>(action: () => T): Promise<T> {
    const unlock = await this.lock();
    try {
      return action();
    } finally {
      unlock();
    }
  }

  private tickets(): { path: string; ticket: Ticket }[] {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith('.json'))
      .toSorted()
      .flatMap((name) => {
        const path = join(this.directory, name);
        try {
          const ticket: unknown = JSON.parse(readFileSync(path, 'utf8'));
          if (
            !ticket ||
            typeof ticket !== 'object' ||
            !('pid' in ticket) ||
            typeof ticket.pid !== 'number' ||
            !('state' in ticket) ||
            (ticket.state !== 'queued' && ticket.state !== 'running')
          )
            return [];
          if (!alive(ticket.pid)) {
            rmSync(path);
            return [];
          }
          return [{ path, ticket }];
        } catch {
          return [];
        }
      });
  }

  async acquire(onWaiting?: (limit: number) => void): Promise<void> {
    await this.locked(() => {
      const counter = join(this.directory, 'next');
      const next = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 1;
      writeFileSync(counter, String(next));
      this.ticket = join(this.directory, `${String(next).padStart(16, '0')}-${randomUUID()}.json`);
      writeFileSync(
        this.ticket,
        JSON.stringify({ pid: process.pid, state: 'queued' } satisfies Ticket),
        {
          flag: 'wx',
        },
      );
    });
    return new Promise<void>((resolve, reject) => {
      const poll = () => {
        if (!this.ticket) {
          reject(new Error('Queued E2E job was cancelled.'));
          return;
        }
        void this.locked(() => {
          const tickets = this.tickets();
          const limit = this.limitReader();
          const running = tickets.filter((item) => item.ticket.state === 'running').length;
          const first = tickets.find((item) => item.ticket.state === 'queued');
          if (running < limit && first?.path === this.ticket) {
            writeFileSync(
              this.ticket,
              JSON.stringify({ pid: process.pid, state: 'running' } satisfies Ticket),
            );
            return true;
          }
          onWaiting?.(limit);
          return false;
        }).then((started) => {
          if (started) resolve();
          else setTimeout(poll, 250);
          return undefined;
        }, reject);
      };
      poll();
    });
  }

  release(): void {
    if (!this.ticket) return;
    rmSync(this.ticket, { force: true });
    this.ticket = '';
  }
}
