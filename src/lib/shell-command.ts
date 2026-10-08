export type ShellStatus = 'running' | 'passed' | 'failed' | 'timed_out' | 'canceled';

export type ShellOutcome = {
  command: string;
  status: ShellStatus;
  code: number | null;
  output: string;
  durationMs?: number;
};

export type ShellRun = ShellOutcome & {
  id: string;
  directory: string;
  session: string | null;
  created: number;
};

export type ShellResult = {
  status: ShellStatus;
  code: number | null;
  output: string;
  durationMs: number;
};

export type ShellSegment = { type: 'text'; text: string } | { type: 'shell'; shell: ShellOutcome };

/** Characters of command output sent to the agent per command. */
export const SHELL_CONTEXT_LIMIT = 16 * 1024;

const TAG = 'user-shell-command';
const BLOCK = new RegExp(`<${TAG}>([\\s\\S]*?)</${TAG}>`, 'g');
const STATUSES: ShellStatus[] = ['running', 'passed', 'failed', 'timed_out', 'canceled'];

/** Returns the command for a `!` composer line, '' for a bare `!`, or null for a normal message. */
export function shellCommand(draft: string): string | null {
  const text = draft.trimStart();
  return text.startsWith('!') ? text.slice(1).trim() : null;
}

export function isShellDraft(draft: string): boolean {
  return shellCommand(draft) !== null;
}

function encode(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decode(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function clip(output: string): string {
  if (output.length <= SHELL_CONTEXT_LIMIT) return output;
  const omitted = output.length - SHELL_CONTEXT_LIMIT;
  return `[${omitted} earlier characters omitted]\n${output.slice(-SHELL_CONTEXT_LIMIT)}`;
}

/** Formats finished runs as tagged blocks the agent reads and the transcript renders as cards. */
export function shellContext(runs: ShellOutcome[]): string {
  return runs
    .filter((run) => run.status !== 'running')
    .map((run) =>
      [
        `<${TAG}>`,
        `<command>${encode(run.command)}</command>`,
        `<status>${run.status}</status>`,
        ...(run.code === null ? [] : [`<exit-code>${run.code}</exit-code>`]),
        ...(run.durationMs === undefined ? [] : [`<duration-ms>${run.durationMs}</duration-ms>`]),
        `<output>\n${encode(clip(run.output.trimEnd()))}\n</output>`,
        `</${TAG}>`,
      ].join('\n'),
    )
    .join('\n');
}

export function withShellContext(runs: ShellOutcome[], text: string): string {
  const context = shellContext(runs);
  return context ? `${context}\n\n${text}` : text;
}

function field(body: string, name: string): string | undefined {
  const value = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
  return value === undefined ? undefined : decode(value);
}

function parse(body: string): ShellOutcome | undefined {
  const command = field(body, 'command');
  const status = field(body, 'status') as ShellStatus | undefined;
  if (!command || !status || !STATUSES.includes(status)) return undefined;
  const code = field(body, 'exit-code');
  const duration = field(body, 'duration-ms');
  return {
    command,
    status,
    code: code && /^-?\d+$/.test(code) ? Number(code) : null,
    output: (field(body, 'output') ?? '').replace(/^\n/, '').replace(/\n$/, ''),
    ...(duration && /^\d+$/.test(duration) ? { durationMs: Number(duration) } : {}),
  };
}

export function splitShellCommands(text: string): ShellSegment[] {
  if (!text.includes(`<${TAG}>`)) return [{ type: 'text', text }];
  const segments: ShellSegment[] = [];
  let cursor = 0;
  const pushText = (end: number) => {
    const chunk = text.slice(cursor, end).trim();
    if (chunk) segments.push({ type: 'text', text: chunk });
  };
  for (const match of text.matchAll(BLOCK)) {
    const shell = parse(match[1]);
    if (!shell) continue;
    pushText(match.index);
    segments.push({ type: 'shell', shell });
    cursor = match.index + match[0].length;
  }
  if (!segments.some((segment) => segment.type === 'shell')) return [{ type: 'text', text }];
  pushText(text.length);
  return segments;
}

export function shellStatusLabel(run: ShellOutcome): string {
  if (run.status === 'running') return 'Running';
  if (run.status === 'timed_out') return 'Timed out';
  if (run.status === 'canceled') return 'Stopped';
  return run.code === null ? run.status : `Exit ${run.code}`;
}
