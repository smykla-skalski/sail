import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sessions = new Map();
const claudeDefaults = { model: 'test', effort: 'medium' };
const delayedSessionDirectories = new Set();
const permissions = new Map();
const elicitations = new Map();
const questionOption = (label, description, preview) => ({
  const: label,
  title: label,
  ...(description ? { description } : {}),
  ...(preview ? { _meta: { '_claude/askUserQuestionOption': { preview } } } : {}),
});
const activePrompts = new Map();
const steerWaiters = new Map();
const terminalRequests = new Map();
let terminalSupport = false;
let nextTerminalRequest = 3000;
const agent = process.argv[2];
let authenticated = agent !== 'codex';
let nextSession = 0;
// A provider can run under several capability profiles in separate processes.
const sessionRun = `-${process.pid}`;
let nextPermission = 1000;

function send(message) {
  if ('result' in message || 'error' in message)
    for (const [sessionId, promptId] of activePrompts)
      if (promptId === message.id) activePrompts.delete(sessionId);
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

const externalSessionsFile = '.acp-external-sessions.json';

function externalSessions(cwd) {
  const file = join(cwd, externalSessionsFile);
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')).map((item) => Object.assign({}, item, { cwd }));
}

function adoptExternalSession(sessionId, cwd) {
  if (sessions.has(sessionId) || typeof cwd !== 'string') return;
  const external = externalSessions(cwd).find((item) => item.sessionId === sessionId);
  if (!external) return;
  sessions.set(sessionId, {
    cwd,
    history: [],
    config: { model: 'test', effort: 'medium' },
    fingerprint: sessionFingerprint({ cwd, mcpServers: [] }),
    mcpServers: [],
    title: external.title,
    updated: Date.parse(external.updatedAt) || Date.now(),
  });
}

function update(sessionId, value) {
  send({ method: 'session/update', params: { sessionId, update: value } });
}

const backgroundWork = new Map();

function trackWork(sessionId, cancel) {
  const work = backgroundWork.get(sessionId) ?? new Set();
  work.add(cancel);
  backgroundWork.set(sessionId, work);
  return () => work.delete(cancel);
}

function recordUpdate(sessionId, target, value) {
  sessions.get(sessionId).history.push({ sessionId: target, update: value });
  update(target, value);
}

function sessionFingerprint(params) {
  const servers = (params.mcpServers ?? []).toSorted((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify({ cwd: params.cwd, mcpServers: servers });
}

function restartSession(sessionId, counted) {
  const session = sessions.get(sessionId);
  const interruptsWork =
    activePrompts.has(sessionId) || (backgroundWork.get(sessionId)?.size ?? 0) > 0;
  if (counted || interruptsWork) {
    const file = join(session.cwd, 'acp-restarts.txt');
    const count = existsSync(file) ? Number(readFileSync(file, 'utf8')) || 0 : 0;
    writeFileSync(file, `${count + 1}\n`);
  }
  for (const cancel of backgroundWork.get(sessionId) ?? []) cancel();
  backgroundWork.delete(sessionId);
  const promptId = activePrompts.get(sessionId);
  if (promptId !== undefined) send({ id: promptId, result: { stopReason: 'cancelled' } });
}

function attachLikeClaudeAdapter(sessionId, params) {
  const session = sessions.get(sessionId);
  const next = sessionFingerprint(params);
  const codexRestartsOnLoad = agent === 'codex' && session.cwd.includes('sail-restart-on-load');
  if (!session.evicted && session.fingerprint !== undefined) {
    const changed = session.fingerprint !== next;
    if (changed || codexRestartsOnLoad) restartSession(sessionId, changed);
  }
  session.evicted = false;
  session.fingerprint = next;
  session.mcpServers = params.mcpServers ?? [];
}

function callWorktreeList(server, callback) {
  const child = spawn(server.command, server.args ?? [], {
    env: {
      ...process.env,
      ...Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])),
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let output = '';
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    child.kill();
    callback(result);
  };
  child.stdout.on('data', (chunk) => {
    output += chunk;
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line);
        if (response.id === 2)
          finish(response.result?.isError ? 'Worktree tool failed' : 'Worktree tool works');
      } catch {
        continue;
      }
    }
  });
  child.on('error', () => finish('Worktree tool failed'));
  setTimeout(() => finish('Worktree tool timed out'), 10_000);
  const request = (id, method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  request(2, 'tools/call', { name: 'worktree_list', arguments: {} });
}

function terminalRequest(method, params, callback) {
  const id = ++nextTerminalRequest;
  terminalRequests.set(id, callback);
  send({ id, method, params });
}

function runTerminal(sessionId, text, promptId) {
  if (!terminalSupport) {
    send({ id: promptId, error: { code: -1, message: 'Client terminal support missing' } });
    return;
  }
  const stop = text.includes('stop');
  const script = stop
    ? 'echo started; sleep 30; echo done'
    : 'echo started; sleep 1; echo finished; exit 7';
  terminalRequest(
    'terminal/create',
    { sessionId, command: '/bin/sh', args: ['-c', script], outputByteLimit: 1024 },
    ({ result, error }) => {
      if (error) {
        send({ id: promptId, error });
        return;
      }
      const terminalId = result.terminalId;
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: `terminal-${terminalId}`,
        title: 'Run terminal fixture',
        status: 'in_progress',
        content: [{ type: 'terminal', terminalId }],
      });
      terminalRequest('terminal/wait_for_exit', { sessionId, terminalId }, ({ result: status }) => {
        terminalRequest('terminal/output', { sessionId, terminalId }, ({ result: output }) => {
          update(sessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId: `terminal-${terminalId}`,
            status: 'completed',
            content: [
              { type: 'terminal', terminalId },
              {
                type: 'content',
                content: { type: 'text', text: `${output.output}\n${JSON.stringify(status)}` },
              },
            ],
          });
          terminalRequest('terminal/release', { sessionId, terminalId }, () => {
            send({ id: promptId, result: { stopReason: 'end_turn' } });
          });
        });
      });
    },
  );
}

function configOptions(sessionId) {
  const session = sessions.get(sessionId);
  const config = session?.config ?? { model: 'test', effort: 'medium' };
  const options = [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: config.model,
      options: [
        { value: 'test', name: 'Test model' },
        { value: 'fast', name: 'Fast model' },
        { value: 'broken', name: 'Reject model' },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      type: 'select',
      currentValue: config.effort,
      options: [
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      currentValue: config.mode ?? (agent === 'opencode' ? 'build' : 'default'),
      options: [
        agent === 'opencode'
          ? { value: 'build', name: 'Build' }
          : { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ];
  return session?.noEffort ? options.slice(0, 1) : options;
}

function applyClaudeDefaults(sessionId) {
  if (agent !== 'claude') return;
  const session = sessions.get(sessionId);
  if (session) session.config = { ...session.config, ...claudeDefaults };
}

const availableCommands = [
  { name: 'ship-issue', description: 'Implement and ship a GitHub issue' },
  { name: 'review', description: 'Review a change' },
  ...Array.from({ length: 10 }, (_, index) => ({
    name: `fixture-${index}`,
    description: `Fixture command ${index}`,
  })),
];

function requestPermission(sessionId, text, promptId, parent, toolCallId = 'review') {
  const id = ++nextPermission;
  permissions.set(id, { sessionId, text, promptId, parent, toolCallId });
  send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { toolCallId, title: 'Run test action' },
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!message.method && terminalRequests.has(message.id)) {
    terminalRequests.get(message.id)(message);
    terminalRequests.delete(message.id);
    continue;
  }
  if (message.method === 'initialize') {
    terminalSupport = message.params.clientCapabilities?.terminal === true;
    const subagents = message.params.clientCapabilities?.subagents;
    if (!subagents || typeof subagents !== 'object' || Array.isArray(subagents)) {
      send({ id: message.id, error: { code: -1, message: 'Client subagent support missing' } });
      continue;
    }
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {
            resume: {},
            subagents: {},
            ...(agent === 'opencode' ? { list: {} } : {}),
          },
        },
        authMethods: agent === 'codex' ? [{ id: 'chat-gpt', name: 'ChatGPT' }] : [],
        _meta:
          agent === 'opencode'
            ? { 'opencode/child-session-updates': true }
            : { steering: { supported: true } },
      },
    });
  } else if (message.method === 'authenticate') {
    authenticated = message.params.methodId === 'chat-gpt';
    send({ id: message.id, result: {} });
  } else if (message.method === 'session/new') {
    if (!authenticated) {
      send({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
      continue;
    }
    const sessionId = `${agent === 'opencode' ? 'ses_' : `${agent}-`}test${sessionRun}-${++nextSession}`;
    sessions.set(sessionId, {
      cwd: message.params.cwd,
      history: [],
      config: { model: 'test', effort: 'medium' },
      fingerprint: sessionFingerprint(message.params),
      mcpServers: message.params.mcpServers ?? [],
    });
    update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands });
    const delayFirstAttentionSession =
      message.params.cwd.includes('sail-attention-') &&
      !delayedSessionDirectories.has(message.params.cwd);
    if (delayFirstAttentionSession) delayedSessionDirectories.add(message.params.cwd);
    setTimeout(
      () =>
        send({
          id: message.id,
          result: { sessionId, configOptions: configOptions(sessionId), availableCommands },
        }),
      delayFirstAttentionSession ? 3000 : 1000,
    );
  } else if (message.method === 'session/list') {
    const pageSize = 2;
    const cwd = message.params.cwd;
    const known = [...sessions.entries()]
      .filter(([, session]) => !cwd || session.cwd === cwd)
      .map(([sessionId, session]) => ({
        sessionId,
        cwd: session.cwd,
        title: session.title ?? sessionId,
        updatedAt: new Date(session.updated ?? Date.now()).toISOString(),
      }));
    const outside = cwd
      ? externalSessions(cwd).filter((item) => !sessions.has(item.sessionId))
      : [];
    const all = [...known, ...outside];
    const start = Number(message.params.cursor ?? 0);
    send({
      id: message.id,
      result: {
        sessions: all.slice(start, start + pageSize),
        nextCursor: start + pageSize < all.length ? String(start + pageSize) : null,
      },
    });
  } else if (message.method === 'session/resume') {
    adoptExternalSession(message.params.sessionId, message.params.cwd);
    applyClaudeDefaults(message.params.sessionId);
    const session = sessions.get(message.params.sessionId);
    if (session) attachLikeClaudeAdapter(message.params.sessionId, message.params);
    if (!session) send({ id: message.id, error: { code: -1, message: 'Session missing' } });
    else
      send({
        id: message.id,
        result: {
          sessionId: message.params.sessionId,
          configOptions: configOptions(message.params.sessionId),
          availableCommands,
        },
      });
  } else if (message.method === 'session/load') {
    adoptExternalSession(message.params.sessionId, message.params.cwd);
    applyClaudeDefaults(message.params.sessionId);
    const session = sessions.get(message.params.sessionId);
    if (session) attachLikeClaudeAdapter(message.params.sessionId, message.params);
    if (!session) send({ id: message.id, error: { code: -1, message: 'Session missing' } });
    else {
      await session.history.reduce(
        (previous, item) =>
          previous.then(() => {
            update(item.sessionId ?? message.params.sessionId, item.update ?? item);
            return new Promise((resolve) => setTimeout(resolve, 0));
          }),
        Promise.resolve(),
      );
      send({
        id: message.id,
        result: {
          sessionId: message.params.sessionId,
          configOptions: configOptions(message.params.sessionId),
          availableCommands,
        },
      });
    }
  } else if (message.method === 'session/set_config_option') {
    const { sessionId, configId, value } = message.params;
    if (value === 'broken') {
      send({ id: message.id, error: { code: -1, message: 'Model change rejected' } });
      continue;
    }
    sessions.get(sessionId).config[configId] = value;
    send({ id: message.id, result: { configOptions: configOptions(sessionId) } });
  } else if (message.method === '_session/steering') {
    const { sessionId } = message.params;
    if (sessions.get(sessionId).newTurnSteer) {
      const status = (type) =>
        update(sessionId, {
          sessionUpdate: 'session_info_update',
          _meta: { codex: { threadStatus: { type } } },
        });
      status('idle');
      send({ id: activePrompts.get(sessionId), result: { stopReason: 'end_turn' } });
      setTimeout(() => {
        status('active');
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Detached steering turn started.' },
        });
        send({ id: message.id, result: { outcome: 'startedNewTurn' } });
        setTimeout(() => {
          writeFileSync(
            join(sessions.get(sessionId).cwd, 'steer-attribution.txt'),
            'steered edit\n',
          );
          status('idle');
        }, 1500);
      }, 200);
      continue;
    }
    if (!activePrompts.has(sessionId)) {
      send({ id: message.id, result: { outcome: 'promptRequired' } });
      continue;
    }
    if (sessions.get(sessionId).holdSteerResponse) continue;
    const reply = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `Steered: ${message.params.prompt[0].text}` },
    };
    sessions.get(sessionId).history.push(reply);
    update(sessionId, reply);
    steerWaiters.get(sessionId)?.();
    setTimeout(() => send({ id: message.id, result: { outcome: 'injected' } }), 200);
  } else if (message.method === 'session/prompt') {
    const { sessionId } = message.params;
    if (sessions.get(sessionId)?.evicted) {
      send({ id: message.id, error: { code: -32002, message: `Session not found: ${sessionId}` } });
      continue;
    }
    activePrompts.set(sessionId, message.id);
    const text = message.params.prompt[0].text;
    if (text === 'Ask structured question') {
      const id = ++nextPermission;
      elicitations.set(id, { sessionId, promptId: message.id });
      send({
        id,
        method: 'elicitation/create',
        params: {
          sessionId,
          mode: 'form',
          message: 'Choose the delivery approach',
          requestedSchema: {
            type: 'object',
            title: 'Delivery approach',
            properties: { approach: { type: 'string', enum: ['safe', 'fast'], default: 'safe' } },
            required: ['approach'],
          },
        },
      });
      continue;
    }
    if (text === 'Ask user questions') {
      const id = ++nextPermission;
      elicitations.set(id, { sessionId, promptId: message.id, ask: true });
      send({
        id,
        method: 'elicitation/create',
        params: {
          sessionId,
          mode: 'form',
          message: 'Please answer the following questions.',
          requestedSchema: {
            type: 'object',
            properties: {
              question_0: {
                type: 'string',
                title: 'Storage',
                description: 'Which storage engine should the cache use?',
                oneOf: [
                  questionOption(
                    'Postgres (Recommended)',
                    'Durable, already deployed, and covered by backups.',
                    'CREATE TABLE cache (\n  key text PRIMARY KEY,\n  value jsonb NOT NULL\n);',
                  ),
                  questionOption('Redis', 'Fastest reads, but adds a service to operate.'),
                  questionOption('In memory', 'No setup; lost on restart.'),
                ],
              },
              question_0_custom: {
                type: 'string',
                title: 'Other',
                description:
                  'Type your own answer, or add a note to the option you chose above (optional).',
              },
              question_1: {
                type: 'array',
                title: 'Rollout',
                description: 'Which rollout steps should run?',
                items: {
                  anyOf: [
                    questionOption('Feature flag', 'Ship dark, then enable per project.'),
                    questionOption('Metrics', 'Record hit rate and latency.'),
                    questionOption('Docs', 'Document the new setting.'),
                  ],
                },
              },
              question_1_custom: {
                type: 'string',
                title: 'Other',
                description: 'Type your own answer to add to your selection above (optional).',
              },
            },
          },
        },
      });
      continue;
    }
    if (text === 'Agent interrupted') {
      send({ id: message.id, result: { stopReason: 'cancelled' } });
      continue;
    }
    if (text === 'Agent error interrupted') {
      send({ id: message.id, error: { code: -1, message: 'Step interrupted' } });
      continue;
    }
    if (
      text === 'Agent text interrupted' ||
      text === 'Agent text interrupted error' ||
      text === 'Agent text interrupted unrelated error'
    ) {
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'interrupted-step-tool',
        title: 'Read task',
        status: 'in_progress',
      });
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Step inter' },
      });
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'interrupted-step-tool',
        status: 'completed',
      });
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'rupted' },
      });
      if (text === 'Agent text interrupted error')
        send({ id: message.id, error: { code: -1, message: 'Step interrupted' } });
      else if (text === 'Agent text interrupted unrelated error')
        send({ id: message.id, error: { code: -1, message: 'Model unavailable' } });
      else send({ id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text === 'Discuss interruption') {
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'The previous step was interrupted, then recovered.' },
      });
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text === 'Continue after interruption') {
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Step interrupted' },
      });
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'recovery-tool',
        title: 'Continue work',
        status: 'in_progress',
      });
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'recovery-tool',
        status: 'completed',
      });
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text.startsWith('Gate prompt model unavailable')) {
      send({ id: message.id, error: { code: -1, message: 'Model x is unavailable' } });
      continue;
    }
    if (text === 'Detached steer follow-up') {
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text === 'Steer new-turn demo') {
      sessions.get(sessionId).newTurnSteer = true;
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: `steer-new-turn-${message.id}`,
        title: 'Finish before steering starts a new turn',
        status: 'in_progress',
      });
      setTimeout(
        () =>
          update(sessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId: `steer-new-turn-${message.id}`,
            status: 'completed',
          }),
        1500,
      );
      continue;
    }
    if (text === 'Steer demo' || text === 'Steer parallel demo') {
      const parallel = text === 'Steer parallel demo';
      const finish = () => {
        steerWaiters.delete(sessionId);
        clearTimeout(fallback);
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `${text} finished.` },
        });
        send({ id: message.id, result: { stopReason: 'end_turn' } });
      };
      const fallback = setTimeout(finish, 30_000);
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: `steer-${message.id}`,
        title: parallel ? 'First parallel tool' : 'Wait for steer',
        status: 'in_progress',
      });
      if (parallel)
        update(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: `steer-second-${message.id}`,
          title: 'Second parallel tool',
          status: 'in_progress',
        });
      setTimeout(() => {
        update(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: `steer-${message.id}`,
          status: 'completed',
        });
        if (parallel) {
          update(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'First parallel tool finished.' },
          });
          setTimeout(() => {
            update(sessionId, {
              sessionUpdate: 'tool_call_update',
              toolCallId: `steer-second-${message.id}`,
              status: 'completed',
            });
            steerWaiters.set(sessionId, () => setTimeout(finish, 3000));
          }, 2000);
        } else steerWaiters.set(sessionId, () => setTimeout(finish, 3000));
      }, 3000);
      continue;
    }
    if (text === 'Steer no-response demo') {
      sessions.get(sessionId).holdSteerResponse = true;
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: `steer-no-response-${message.id}`,
        title: 'Complete before steering replies',
        status: 'in_progress',
      });
      setTimeout(() => {
        update(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: `steer-no-response-${message.id}`,
          status: 'completed',
        });
        setTimeout(() => {
          sessions.get(sessionId).holdSteerResponse = false;
          send({ id: message.id, result: { stopReason: 'end_turn' } });
        }, 1000);
      }, 1500);
      continue;
    }
    if (text === 'Steer no-response follow-up') {
      const reply = {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Done: Steer no-response follow-up' },
      };
      sessions.get(sessionId).history.push(reply);
      update(sessionId, reply);
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text === 'Prompt failure') {
      setTimeout(
        () => send({ id: message.id, error: { code: -1, message: 'Fixture prompt failed' } }),
        1500,
      );
      continue;
    }
    if (text.startsWith('Ship gate fixture')) {
      setTimeout(() => send({ id: message.id, result: { stopReason: 'end_turn' } }), 8000);
      continue;
    }
    if (text.startsWith('Clipboard fixture')) {
      const image = message.params.prompt.find((part) => part.type === 'image');
      const paths = text.split('Attached files (read these paths):\n')[1]?.split('\n') ?? [];
      const files = paths.map((path) => readFileSync(path, 'utf8')).join('|');
      const reply = {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Clipboard received: ${text}; file contents: ${files}; image: ${image?.mimeType ?? 'none'}`,
        },
      };
      sessions.get(sessionId).history.push(reply);
      update(sessionId, reply);
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text === 'Disable effort') {
      sessions.get(sessionId).noEffort = true;
      update(sessionId, {
        sessionUpdate: 'config_option_update',
        configOptions: configOptions(sessionId),
      });
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text.startsWith('Terminal:')) {
      runTerminal(sessionId, text, message.id);
      continue;
    }
    const user = { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } };
    sessions.get(sessionId).history.push(user);
    update(sessionId, user);
    if (text === 'Plan revision fixture' || text === 'Slow plan revision fixture') {
      const plan =
        agent === 'codex'
          ? {
              sessionUpdate: 'plan_update',
              plan: { markdown: '# Initial plan\n\n- inspect the current flow' },
            }
          : {
              sessionUpdate: 'tool_call',
              toolCallId: `exit-plan-${message.id}`,
              title: 'ExitPlanMode',
              status: 'completed',
              input: { plan: '# Initial plan\n\n- inspect the current flow' },
            };
      recordUpdate(sessionId, sessionId, plan);
      setTimeout(
        () => {
          if (activePrompts.get(sessionId) === message.id)
            send({ id: message.id, result: { stopReason: 'end_turn' } });
        },
        text === 'Slow plan revision fixture' ? 15_000 : 750,
      );
      continue;
    }
    if (
      ['Add retries', 'Fail native revision', 'Cancel native revision', 'No revised plan'].includes(
        text,
      )
    ) {
      if (text === 'Fail native revision') {
        send({ id: message.id, error: { code: -1, message: 'Fixture revision failed' } });
        continue;
      }
      if (text === 'No revised plan') {
        send({ id: message.id, result: { stopReason: 'end_turn' } });
        continue;
      }
      if (text === 'Cancel native revision') {
        continue;
      }
      const plan =
        agent === 'codex'
          ? {
              sessionUpdate: 'plan_update',
              plan: { markdown: '# Revised plan\n\n- add retries' },
            }
          : {
              sessionUpdate: 'tool_call_update',
              toolCallId: `exit-plan-${message.id}`,
              title: 'ExitPlanMode',
              status: 'completed',
              input: { plan: '# Revised plan\n\n- add retries' },
            };
      recordUpdate(sessionId, sessionId, plan);
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text === 'Long turn' || text === 'Sidebar performance turn') {
      const intervalMs = text === 'Sidebar performance turn' ? 2000 : 400;
      let part = 0;
      const interval = setInterval(() => {
        part += 1;
        recordUpdate(sessionId, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `part-${part} ` },
        });
        if (part < 60) return;
        stop();
        clearInterval(interval);
        send({ id: message.id, result: { stopReason: 'end_turn' } });
        // Slow enough that six thread switches still leave the turn running.
      }, intervalMs);
      const stop = trackWork(sessionId, () => clearInterval(interval));
      continue;
    }
    if (text === 'Flood turn') {
      const { cwd } = sessions.get(sessionId);
      const say = (value) => recordUpdate(sessionId, sessionId, value);
      const chunk = (value) =>
        say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
      const tool = (id, title) =>
        say({
          sessionUpdate: 'tool_call',
          toolCallId: `${id}-${message.id}`,
          title,
          status: 'completed',
        });
      chunk('Flood waiting.');
      let phase = 'waiting';
      const finish = (reason) => {
        stop();
        clearInterval(poll);
        chunk(` Flood ${reason}.`);
        send({ id: message.id, result: { stopReason: 'end_turn' } });
      };
      const started = Date.now();
      const poll = setInterval(() => {
        if (Date.now() - started > 120_000) return finish('timed out');
        if (phase === 'waiting' && existsSync(join(cwd, 'flood-go.txt'))) {
          phase = 'sent';
          for (let index = 1; index <= 90; index += 1) {
            chunk(`msg-${index} `);
            tool(`flood-step-${index}`, `Flood step ${index}`);
          }
          for (let index = 1; index <= 40; index += 1) chunk(`long-${index} ${'x'.repeat(990)} `);
          tool('flood-burst', 'Flood burst');
          for (let index = 1; index <= 2600; index += 1) chunk(`f-${index} `);
          writeFileSync(join(cwd, 'flood-sent.txt'), 'sent\n');
        } else if (phase === 'sent' && existsSync(join(cwd, 'flood-release.txt')))
          finish('finished');
      }, 100);
      const stop = trackWork(sessionId, () => clearInterval(poll));
      continue;
    }
    if (text === 'Automatic policy') {
      const toolCallId = `format-${message.id}`;
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Format notes',
        status: 'pending',
      });
      const id = ++nextPermission;
      permissions.set(id, { sessionId, text, promptId: message.id, toolCallId });
      send({
        id,
        method: 'session/request_permission',
        params: {
          sessionId,
          // A medium-risk action that Sail's policy settles without asking.
          toolCall: { toolCallId, title: 'Format notes', action: 'format' },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });
      continue;
    }
    if (text === 'Background task') {
      recordUpdate(sessionId, sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Background task started.' },
      });
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      const timer = setTimeout(() => {
        stop();
        recordUpdate(sessionId, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' Background task finished.' },
        });
      }, 6000);
      const stop = trackWork(sessionId, () => clearTimeout(timer));
      continue;
    }
    if (text === 'Second live subagent') {
      const child = `${sessionId}:second-child`;
      update(sessionId, {
        sessionUpdate: 'subagent_spawned',
        name: 'explore',
        task: 'Inspect second delegation',
        capabilities: {},
        subagentSessionId: child,
      });
      update(child, {
        sessionUpdate: 'tool_call',
        toolCallId: 'second-read',
        title: 'Read second fixture',
        status: 'in_progress',
      });
      let streamed = 0;
      const stream = setInterval(() => {
        streamed += 1;
        recordUpdate(sessionId, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `second-${streamed} ` },
        });
      }, 250);
      const timer = setTimeout(() => {
        stop();
        clearInterval(stream);
        update(sessionId, {
          sessionUpdate: 'subagent_state_update',
          subagentSessionId: child,
          state: 'completed',
        });
        recordUpdate(sessionId, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Second subagent finished.' },
        });
        send({ id: message.id, result: { stopReason: 'end_turn' } });
      }, 8000);
      const stop = trackWork(sessionId, () => {
        clearTimeout(timer);
        clearInterval(stream);
      });
      continue;
    }
    if (text === 'Live native subagent') {
      const child = `${sessionId}:live-child`;
      const replayed = `${sessionId}:replay-subagent:toolu_live`;
      const spawned = {
        sessionUpdate: 'subagent_spawned',
        name: 'explore',
        task: 'Inspect live delegation',
        capabilities: {},
      };
      sessions
        .get(sessionId)
        .history.push({ sessionId, update: { ...spawned, subagentSessionId: replayed } });
      update(sessionId, { ...spawned, subagentSessionId: child });
      update(child, {
        sessionUpdate: 'tool_call',
        toolCallId: 'live-read',
        title: 'Read live fixture',
        status: 'in_progress',
      });
      let part = 0;
      const stream = setInterval(() => {
        part += 1;
        recordUpdate(sessionId, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `live-${part} ` },
        });
      }, 250);
      const timer = setTimeout(() => {
        stop();
        clearInterval(stream);
        update(sessionId, {
          sessionUpdate: 'subagent_state_update',
          subagentSessionId: child,
          state: 'completed',
        });
        sessions.get(sessionId).history.push({
          sessionId,
          update: {
            sessionUpdate: 'subagent_state_update',
            subagentSessionId: replayed,
            state: 'completed',
          },
        });
        recordUpdate(sessionId, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Live subagent finished.' },
        });
        send({ id: message.id, result: { stopReason: 'end_turn' } });
      }, 6000);
      const stop = trackWork(sessionId, () => {
        clearTimeout(timer);
        clearInterval(stream);
      });
      continue;
    }
    if (text === 'Check tools') {
      const [server] = sessions.get(sessionId).mcpServers;
      callWorktreeList(server, (result) => {
        recordUpdate(sessionId, sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: result },
        });
        send({ id: message.id, result: { stopReason: 'end_turn' } });
      });
      continue;
    }
    if (text === 'Evict session') {
      recordUpdate(sessionId, sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Session evicted.' },
      });
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      sessions.get(sessionId).evicted = true;
      continue;
    }
    if (text === 'Native subagents') {
      const child = `${sessionId}:child`;
      const grandchild = `${sessionId}:grandchild`;
      const remember = (target, value) => {
        sessions.get(sessionId).history.push({ sessionId: target, update: value });
        update(target, value);
      };
      remember(sessionId, {
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: child,
        name: 'explore',
        task: 'Inspect native delegation',
        prompt: 'Inspect the child path',
        capabilities: {},
      });
      remember(child, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Child transcript stays separate.' },
      });
      remember(child, {
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: grandchild,
        name: 'reader',
        task: 'Inspect nested delegation',
        capabilities: {},
      });
      remember(grandchild, {
        sessionUpdate: 'tool_call',
        toolCallId: 'nested-read',
        title: 'Read nested fixture',
        status: 'completed',
      });
      remember(child, {
        sessionUpdate: 'subagent_state_update',
        subagentSessionId: grandchild,
        state: 'disconnected',
      });
      remember(sessionId, {
        sessionUpdate: 'subagent_state_update',
        subagentSessionId: child,
        state: 'completed',
      });
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text === 'Native child permission') {
      const child = `${sessionId}:permission-child`;
      update(sessionId, {
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: child,
        name: 'worker',
        task: 'Needs approval',
        capabilities: {},
      });
      update(child, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Child waits for approval.' },
      });
      requestPermission(child, text, message.id, sessionId);
      continue;
    }
    if (text === 'Native interrupted subagent') {
      const child = `${sessionId}:interrupted-child`;
      const remember = (target, value) => {
        sessions.get(sessionId).history.push({ sessionId: target, update: value });
        update(target, value);
      };
      remember(sessionId, {
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: child,
        name: 'worker',
        task: 'Inspect interrupted delegation',
        capabilities: {},
      });
      remember(child, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Step interrupted' },
      });
      remember(sessionId, {
        sessionUpdate: 'subagent_state_update',
        subagentSessionId: child,
        state: 'completed',
      });
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text === 'Post-hook failure demo') {
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: `post-hook-${message.id}`,
        title: 'Publish package',
        status: 'pending',
        rawInput: { command: 'npm publish' },
      });
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: `post-hook-${message.id}`,
        status: 'failed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'PostToolUse:Bash says: Audit check failed' },
          },
        ],
      });
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text === 'Hook failure demo') {
      const record = (value) => {
        sessions.get(sessionId).history.push(value);
        update(sessionId, value);
      };
      record({
        sessionUpdate: 'tool_call',
        toolCallId: `hook-${message.id}`,
        title: 'Commit changes',
        status: 'pending',
        rawInput: { command: 'git commit -m test' },
      });
      record({
        sessionUpdate: 'tool_call_update',
        toolCallId: `hook-${message.id}`,
        status: 'failed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'PreToolUse:Bash says: ❌ GIT010: Old reason' },
          },
        ],
      });
      record({
        sessionUpdate: 'tool_call_update',
        toolCallId: `hook-${message.id}`,
        status: 'failed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'PreToolUse:Bash says: ❌ GIT010: Add -s -S flags' },
          },
        ],
      });
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text.includes('Fix the hook-blocked action below.')) {
      const reply = {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I will add the required flags.' },
      };
      sessions.get(sessionId).history.push(reply);
      update(sessionId, reply);
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text === 'Activity demo' || text === 'Activity failure demo') {
      const failureDemo = text === 'Activity failure demo';
      const record = (value) => {
        sessions.get(sessionId).history.push(value);
        update(sessionId, value);
      };
      const tool = (name, status, content) => ({
        sessionUpdate: status === 'in_progress' ? 'tool_call' : 'tool_call_update',
        toolCallId: `demo-${message.id}-${name}`,
        title: name,
        status,
        ...(name === 'Run checks' && status === 'in_progress'
          ? { rawInput: { command: 'npm test' } }
          : {}),
        ...(name === 'Run checks' && status === 'completed'
          ? { rawOutput: { stdout: content } }
          : content
            ? { content: [{ type: 'content', content: { type: 'text', text: content } }] }
            : {}),
      });
      record({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'I’ll inspect the files, run checks, and summarize the result.',
        },
      });
      setTimeout(() => record(tool('Read files', 'in_progress')), 300);
      setTimeout(
        () =>
          record(
            tool(
              'Read files',
              failureDemo ? 'failed' : 'completed',
              failureDemo ? 'Could not read the first path.' : 'Found 12 source files.',
            ),
          ),
        1300,
      );
      setTimeout(() => record(tool('Search references', 'in_progress')), 1600);
      if (failureDemo)
        setTimeout(
          () =>
            record({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'The first read failed. I’m searching another path.' },
            }),
          1900,
        );
      setTimeout(() => record(tool('Search references', 'completed', 'Found 4 references.')), 2600);
      setTimeout(() => record(tool('Run checks', 'in_progress')), 2900);
      setTimeout(() => record(tool('Run checks', 'completed', 'All checks passed.')), 3900);
      setTimeout(() => {
        record({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: failureDemo
              ? 'I recovered from the read failure. The tool details are available above.'
              : 'The checks passed. The tool details are available above.',
          },
        });
        send({ id: message.id, result: { stopReason: 'end_turn' } });
      }, 4200);
      continue;
    }
    // Each turn gets its own tool call id, as real agents do.
    const toolCallId = `review-${message.id}`;
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'Run test action',
      status: 'pending',
    });
    if (text.startsWith('Delayed'))
      setTimeout(() => requestPermission(sessionId, text, message.id, undefined, toolCallId), 1500);
    else requestPermission(sessionId, text, message.id, undefined, toolCallId);
  } else if (message.method === 'session/cancel') {
    const activePromptId = activePrompts.get(message.params.sessionId);
    const awaitingPermission = [...permissions.values()].some(
      (pending) => pending.sessionId === message.params.sessionId,
    );
    // A turn waiting on a permission ends through that permission's cancel handling below.
    if (activePromptId !== undefined && !awaitingPermission) {
      send({ id: activePromptId, result: { stopReason: 'cancelled' } });
      continue;
    }
    for (const [id, pending] of permissions) {
      if (pending.sessionId === message.params.sessionId) {
        permissions.delete(id);
        const finish = () => {
          if (pending.text === 'Crash on cancel') process.exit(0);
          if (pending.text === 'Cancel error')
            send({ id: pending.promptId, error: { code: -1, message: 'Step interrupted' } });
          else
            send({
              id: pending.promptId,
              result: { stopReason: pending.text === 'Cancel ignored' ? 'end_turn' : 'cancelled' },
            });
        };
        if (pending.text === 'Slow cancel') setTimeout(finish, 5000);
        else finish();
      }
    }
  } else if (message.id != null && elicitations.has(message.id)) {
    const pending = elicitations.get(message.id);
    elicitations.delete(message.id);
    const text =
      message.result?.action !== 'accept'
        ? message.result?.action
        : pending.ask
          ? `Answers: ${JSON.stringify(message.result.content)}`
          : `Selected: ${message.result.content?.approach}`;
    update(pending.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
    send({ id: pending.promptId, result: { stopReason: 'end_turn' } });
  } else if (message.id != null && permissions.has(message.id)) {
    const pending = permissions.get(message.id);
    permissions.delete(message.id);
    update(pending.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: pending.toolCallId,
      status: 'completed',
    });
    if (pending.parent) {
      // The child keeps working after the answer, as a real one does.
      update(pending.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Child continues.' },
      });
      continue;
    }
    const text =
      message.result?.outcome?.optionId === 'allow'
        ? pending.text === 'Long answer'
          ? Array.from({ length: 100 }, (_, index) => `Answer line ${index}`).join('\n')
          : pending.text === 'Link example'
            ? '[Example](https://example.com/path) [Section](#section) [Unsafe](javascript:alert(1))'
            : `Done: ${pending.text}`
        : 'Rejected';
    const finish = () => {
      const reply = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
      sessions.get(pending.sessionId).history.push(reply);
      update(pending.sessionId, reply);
      send({ id: pending.promptId, result: { stopReason: 'end_turn' } });
    };
    if (pending.text === 'Delayed completion') setTimeout(finish, 1000);
    else finish();
  }
}
