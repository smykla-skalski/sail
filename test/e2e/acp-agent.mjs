import { createInterface } from 'node:readline';
import process from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sessions = new Map();
const permissions = new Map();
const activePrompts = new Map();
const steerWaiters = new Map();
const terminalRequests = new Map();
let terminalSupport = false;
let nextTerminalRequest = 3000;
const agent = process.argv[2];
let authenticated = agent !== 'codex';
let nextSession = 0;
const sessionRun = process.env.SAIL_ACP_TEST_UNIQUE_SESSIONS ? `-${process.pid}` : '';
let nextPermission = 1000;

function send(message) {
  if ('result' in message || 'error' in message)
    for (const [sessionId, promptId] of activePrompts)
      if (promptId === message.id) activePrompts.delete(sessionId);
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function update(sessionId, value) {
  send({ method: 'session/update', params: { sessionId, update: value } });
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
  ];
  return session?.noEffort ? options.slice(0, 1) : options;
}

const availableCommands = [
  { name: 'ship-issue', description: 'Implement and ship a GitHub issue' },
  { name: 'review', description: 'Review a change' },
  ...Array.from({ length: 10 }, (_, index) => ({
    name: `fixture-${index}`,
    description: `Fixture command ${index}`,
  })),
];

function requestPermission(sessionId, text, promptId) {
  const id = ++nextPermission;
  permissions.set(id, { sessionId, text, promptId });
  send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { toolCallId: 'review', title: 'Run test action' },
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
          sessionCapabilities: { resume: {}, subagents: {} },
        },
        authMethods: agent === 'codex' ? [{ id: 'chat-gpt', name: 'ChatGPT' }] : [],
        _meta: { steering: { supported: true } },
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
    const sessionId = `${agent}-test${sessionRun}-${++nextSession}`;
    sessions.set(sessionId, {
      cwd: message.params.cwd,
      history: [],
      config: { model: 'test', effort: 'medium' },
    });
    update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands });
    setTimeout(
      () =>
        send({
          id: message.id,
          result: { sessionId, configOptions: configOptions(sessionId), availableCommands },
        }),
      1000,
    );
  } else if (message.method === 'session/resume') {
    const session = sessions.get(message.params.sessionId);
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
    const session = sessions.get(message.params.sessionId);
    if (!session) send({ id: message.id, error: { code: -1, message: 'Session missing' } });
    else {
      for (const item of session.history)
        update(item.sessionId ?? message.params.sessionId, item.update ?? item);
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
    activePrompts.set(sessionId, message.id);
    const text = message.params.prompt[0].text;
    if (text === 'Agent interrupted') {
      send({ id: message.id, result: { stopReason: 'cancelled' } });
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
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'review',
      title: 'Run test action',
      status: 'pending',
    });
    if (text.startsWith('Delayed'))
      setTimeout(() => requestPermission(sessionId, text, message.id), 1500);
    else requestPermission(sessionId, text, message.id);
  } else if (message.method === 'session/cancel') {
    for (const [id, pending] of permissions) {
      if (pending.sessionId === message.params.sessionId) {
        permissions.delete(id);
        const finish = () =>
          send({
            id: pending.promptId,
            result: { stopReason: pending.text === 'Cancel ignored' ? 'end_turn' : 'cancelled' },
          });
        if (pending.text === 'Slow cancel') setTimeout(finish, 5000);
        else finish();
      }
    }
  } else if (message.id != null && permissions.has(message.id)) {
    const pending = permissions.get(message.id);
    permissions.delete(message.id);
    update(pending.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'review',
      status: 'completed',
    });
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
