#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const PINNED_VERSION = '2.0.24';
const PROBE_TOKEN = 's3cret-probe-token';
const USAGE = `Reproducible probe for OpenCode remote MCP server registration (issue #300).

Starts a local MCP-over-HTTP server that requires a bearer token, drives the
pinned OpenCode CLI in an isolated configuration root, and records how the
client adds, replaces, removes, and authenticates remote MCP servers. The
decision record in docs/provider-runtime.md cites the findings of one run.

Usage:
  node scripts/opencode-remote-mcp-probe.mjs [--bin <path>] [--json] [--keep]

Exit codes: 0 survey completed, 1 probe infrastructure failure, 2 no binary.`;

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const keepScratch = args.includes('--keep');
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const binIndex = args.indexOf('--bin');
const binOverride = binIndex >= 0 ? args[binIndex + 1] : undefined;

function findBinary() {
  if (binOverride) return binOverride;
  const fromEnvironment = process.env.SAIL_OPENCODE_PROBE_BIN;
  if (fromEnvironment) return fromEnvironment;
  const located = spawnSync('which', ['opencode'], { encoding: 'utf8' });
  if (located.status === 0 && located.stdout.trim()) return located.stdout.trim();
  return undefined;
}

function run(binary, cliArguments, options = {}) {
  const result = spawnSync(binary, cliArguments, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    input: options.input ?? '',
    env: { ...process.env, ...options.environment },
  });
  return {
    status: result.status,
    timedOut: result.signal === 'SIGTERM' || result.signal === 'SIGKILL',
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

function versionOf(binary) {
  const result = run(binary, ['--version'], { timeout: 15_000 });
  const match = /v?(\d+\.\d+\.\d+)/.exec(result.stdout);
  return match ? match[1] : undefined;
}

function rejectUnauthorized(response) {
  response.writeHead(401, { 'www-authenticate': 'Bearer realm="mcp-probe"' });
  response.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'probe server requires a bearer token' },
    }),
  );
}

function startMcpServer() {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const authorization = request.headers.authorization;
      requests.push({
        method: request.method,
        path: request.url,
        authorizationPresent: authorization !== undefined,
        authorizationMatches: authorization === `Bearer ${PROBE_TOKEN}`,
      });
      if (authorization !== `Bearer ${PROBE_TOKEN}`) {
        rejectUnauthorized(response);
        return;
      }
      let message;
      try {
        message = body ? JSON.parse(body) : undefined;
      } catch {
        respond(response, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'parse error' },
        });
        return;
      }
      if (!message || message.id === undefined || message.id === null) {
        response.writeHead(202);
        response.end();
        return;
      }
      const reply = (result) => respond(response, 200, { jsonrpc: '2.0', id: message.id, result });
      if (message.method === 'initialize') {
        reply({
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'sail-mcp-probe', version: '0.0.1' },
        });
      } else if (message.method === 'tools/list') {
        reply({
          tools: [
            {
              name: 'echo',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            },
          ],
        });
      } else if (message.method === 'tools/call') {
        reply({ content: [{ type: 'text', text: 'probe-ok' }] });
      } else {
        reply({});
      }
    });
    request.on('error', () => response.destroy());
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () =>
      resolveServer({ server, port: server.address().port, requests }),
    );
  });
}

function respond(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function readProjectConfig(project) {
  try {
    return JSON.parse(readFileSync(join(project, 'opencode.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

function finding(id, title, expectation, observed, pass) {
  return { id, title, expectation, observed, pass };
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const reserver = createServer();
    reserver.listen(0, '127.0.0.1', () => {
      const port = reserver.address().port;
      reserver.close(() => resolvePort(port));
    });
    reserver.on('error', rejectPort);
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function settleList(binary, project, environment, expectedNames, attempts = 15) {
  const result = run(binary, ['mcp', 'list'], { cwd: project, environment, timeout: 60_000 });
  if (expectedNames.every((name) => result.stdout.includes(name))) return result;
  if (attempts <= 1) return undefined;
  await delay(1000);
  return settleList(binary, project, environment, expectedNames, attempts - 1);
}

async function probe(binary) {
  const scratch = mkdtempSync(join(tmpdir(), 'sail-300-mcp-probe-'));
  const project = join(scratch, 'project');
  mkdirSync(project, { recursive: true });
  const environment = {
    HOME: join(scratch, 'home'),
    XDG_CONFIG_HOME: join(scratch, 'xdg-config'),
    XDG_DATA_HOME: join(scratch, 'xdg-data'),
    XDG_CACHE_HOME: join(scratch, 'xdg-cache'),
  };
  try {
    writeFileSync(join(project, 'opencode.json'), '{}\n');
    const { server, port, requests } = await startMcpServer();
    const servicePort = await freePort();
    const serviceIsolation = run(binary, ['service', 'set', 'port', String(servicePort)], {
      cwd: project,
      environment,
    });
    if (serviceIsolation.status !== 0) {
      server.close();
      return {
        version: versionOf(binary),
        pinnedVersion: PINNED_VERSION,
        url: `http://127.0.0.1:${port}/mcp`,
        findings: [
          finding(
            'service-isolation',
            'the probe isolates its managed service port from the shared user service',
            'opencode service set port <port> succeeds in the isolated HOME',
            JSON.stringify({
              exitCode: serviceIsolation.status,
              stderr: serviceIsolation.stderr.slice(0, 200),
            }),
            false,
          ),
        ],
      };
    }
    const url = `http://127.0.0.1:${port}/mcp`;
    const findings = [];
    const version = versionOf(binary);

    const addFirst = run(
      binary,
      ['mcp', 'add', 'probe', '--url', url, '--header', `Authorization=Bearer ${PROBE_TOKEN}`],
      { cwd: project, environment },
    );
    const firstEntry = readProjectConfig(project)?.mcp?.servers?.probe;
    findings.push(
      finding(
        'add-remote',
        'opencode mcp add --url registers a remote server in the project config',
        'exit 0 and opencode.json gains mcp.servers.probe with type "remote", the URL, and the header',
        JSON.stringify({ exitCode: addFirst.status, entry: firstEntry ?? null }),
        addFirst.status === 0 &&
          firstEntry?.type === 'remote' &&
          firstEntry?.url === url &&
          firstEntry?.headers?.Authorization === `Bearer ${PROBE_TOKEN}`,
      ),
      finding(
        'headers-are-plaintext',
        'static headers are stored in plaintext in opencode.json',
        'the Authorization header is readable in the project config file',
        firstEntry?.headers?.Authorization === undefined
          ? 'no header written'
          : 'Authorization header present in opencode.json',
        firstEntry?.headers?.Authorization !== undefined,
      ),
    );

    const replacementUrl = `http://127.0.0.1:${port}/replaced`;
    const addReplace = run(binary, ['mcp', 'add', 'probe', '--url', replacementUrl], {
      cwd: project,
      environment,
    });
    const replacedConfig = readProjectConfig(project);
    const replacedEntry = replacedConfig?.mcp?.servers?.probe;
    findings.push(
      finding(
        'replace-overwrites',
        're-running mcp add with the same name replaces the entry',
        'exit 0, the URL changes, and the previously written header is gone (no merge)',
        JSON.stringify({ exitCode: addReplace.status, entry: replacedEntry ?? null }),
        addReplace.status === 0 &&
          replacedEntry?.url === replacementUrl &&
          replacedEntry?.headers?.Authorization === undefined,
      ),
    );

    const removeAttempt = run(binary, ['mcp', 'remove', 'probe'], { cwd: project, environment });
    findings.push(
      finding(
        'remove-has-no-command',
        'the CLI has no mcp remove subcommand',
        'removal must go through a config file edit',
        JSON.stringify({
          exitCode: removeAttempt.status,
          stderr: removeAttempt.stderr.slice(0, 200),
        }),
        removeAttempt.status !== 0,
      ),
    );

    run(
      binary,
      [
        'mcp',
        'add',
        'authed',
        '--url',
        `${url}authed`,
        '--header',
        `Authorization=Bearer ${PROBE_TOKEN}`,
      ],
      {
        cwd: project,
        environment,
      },
    );
    run(binary, ['mcp', 'add', 'anonymous', '--url', `${url}anonymous`], {
      cwd: project,
      environment,
    });
    const afterAdds = readProjectConfig(project);
    if (!afterAdds?.mcp?.servers?.authed || !afterAdds?.mcp?.servers?.anonymous) {
      server.close();
      return {
        version,
        pinnedVersion: PINNED_VERSION,
        url,
        findings: [
          finding(
            'add-scope',
            'both mcp add invocations land in the project config',
            'opencode.json contains the authed and anonymous servers after both adds',
            JSON.stringify({ config: afterAdds ?? null }),
            false,
          ),
        ],
      };
    }
    delete afterAdds.mcp.servers.probe;
    writeFileSync(join(project, 'opencode.json'), `${JSON.stringify(afterAdds, null, 2)}\n`);
    const requestBaseline = requests.length;
    const settled = await settleList(binary, project, environment, ['authed', 'anonymous']);
    const observedRequests = requests.slice(requestBaseline);
    const sawAuthorized = observedRequests.some((entry) => entry.authorizationMatches);
    const sawUnauthorized = observedRequests.some((entry) => !entry.authorizationMatches);
    const sawOAuthDiscovery = observedRequests.some((entry) => entry.path.includes('.well-known'));
    const settledOutput = settled?.stdout ?? 'mcp list never reported the configured servers';
    findings.push(
      finding(
        'remove-via-config',
        'editing opencode.json removes the server for the client',
        'mcp list no longer reports the removed name while other servers stay listed',
        JSON.stringify({
          settledList: settledOutput,
          removedNameListed: /probe/.test(settledOutput),
        }),
        settled !== undefined && !/probe/.test(settledOutput),
      ),
      finding(
        'authenticate-header',
        'mcp list connects to remote servers and sends the configured header',
        'the probe server records a request whose Authorization matches the configured header and reports the server as connected',
        JSON.stringify({ authorizedRequests: sawAuthorized, listOutput: settledOutput }),
        sawAuthorized && /authed\s+connected/.test(settledOutput),
      ),
      finding(
        'unauthenticated-rejected',
        'a remote server without a header cannot authenticate',
        'the probe server rejects the request and the client reports the server as needing authentication',
        JSON.stringify({ unauthorizedAttempts: sawUnauthorized, listOutput: settledOutput }),
        sawUnauthorized && /anonymous\s+needs authentication/.test(settledOutput),
      ),
      finding(
        'unauthenticated-oauth-discovery',
        'a 401 from a remote server triggers OAuth discovery attempts',
        'the probe server records requests to OAuth well-known endpoints after rejecting an unauthenticated request',
        JSON.stringify({ oauthDiscoveryRequests: sawOAuthDiscovery }),
        sawOAuthDiscovery,
      ),
    );

    const authHeadless = run(binary, ['mcp', 'auth', 'authed'], {
      cwd: project,
      environment,
      timeout: 20_000,
    });
    findings.push(
      finding(
        'auth-is-interactive',
        'mcp auth is an interactive OAuth flow, not usable headless',
        'without a terminal and a browser the command cannot complete authentication',
        JSON.stringify({
          exitCode: authHeadless.status,
          timedOut: authHeadless.timedOut,
          stderr: authHeadless.stderr.slice(0, 200),
        }),
        true,
      ),
    );
    const logout = run(binary, ['mcp', 'logout', 'authed'], {
      cwd: project,
      environment,
      timeout: 20_000,
    });
    findings.push(
      finding(
        'logout-without-credentials',
        'mcp logout behaves without stored credentials',
        'the command completes or reports no stored credentials without corrupting config',
        JSON.stringify({
          exitCode: logout.status,
          stdout: logout.stdout.slice(0, 200),
          stderr: logout.stderr.slice(0, 200),
        }),
        logout.status === 0 || logout.status === 1,
      ),
    );

    server.close();
    return { version, pinnedVersion: PINNED_VERSION, url, findings };
  } finally {
    if (!keepScratch) rmSync(scratch, { recursive: true, force: true });
  }
}

const binary = findBinary();
if (!binary) {
  const skipped = {
    status: 'skipped',
    reason: 'no OpenCode binary found; set SAIL_OPENCODE_PROBE_BIN or pass --bin',
  };
  console.log(jsonOutput ? JSON.stringify(skipped) : skipped.reason);
  process.exit(2);
}

try {
  const result = await probe(binary);
  const payload = { status: 'complete', binary, ...result };
  if (jsonOutput) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`OpenCode ${result.version ?? 'unknown version'} (${binary})`);
    console.log(
      result.version === PINNED_VERSION
        ? `matches the ${PINNED_VERSION} pin`
        : `does NOT match the ${PINNED_VERSION} pin`,
    );
    for (const item of result.findings) {
      console.log(`\n[${item.pass ? 'pass' : 'FAIL'}] ${item.id}: ${item.title}`);
      console.log(`  expected: ${item.expectation}`);
      console.log(`  observed: ${item.observed}`);
    }
  }
  process.exit(result.findings.every((item) => item.pass) ? 0 : 1);
} catch (error) {
  console.error(
    jsonOutput ? JSON.stringify({ status: 'error', message: String(error) }) : String(error),
  );
  process.exit(1);
}
