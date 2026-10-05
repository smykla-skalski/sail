import process from 'node:process';

export function privatePort(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value))
    throw new Error('Set TAURI_WEBDRIVER_PORT to a fresh private port.');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4445)
    throw new Error('TAURI_WEBDRIVER_PORT must be a private port (1024–65535, excluding 4445).');
  return port;
}

type Endpoint = { port?: number; hostname?: string; 'tauri:options'?: { embeddedPort?: number } };

export function assertPrivateEndpoint(
  port: number,
  config: Endpoint,
  capabilities: Endpoint | Endpoint[],
) {
  if (privatePort(process.env.TAURI_WEBDRIVER_PORT) !== port)
    throw new Error('Direct evaluation port changed after configuration.');
  for (const endpoint of [config, ...[capabilities].flat()]) {
    if (endpoint.port !== undefined && endpoint.port !== port)
      throw new Error('WDIO port must equal TAURI_WEBDRIVER_PORT.');
    if (endpoint.hostname !== undefined && endpoint.hostname !== '127.0.0.1')
      throw new Error('Private app must use 127.0.0.1.');
    const embedded = endpoint['tauri:options']?.embeddedPort;
    if (embedded !== undefined && embedded !== port)
      throw new Error('Embedded port must equal TAURI_WEBDRIVER_PORT.');
  }
}

// Constructors fail before WDIO starts services; hook errors can be swallowed.
export class PrivateEndpointGuard {
  private port: number;
  constructor(options: { port: number }, capabilities: Endpoint | Endpoint[], config: Endpoint) {
    assertPrivateEndpoint(options.port, config, capabilities);
    this.port = options.port;
  }

  beforeSession(config: Endpoint, capabilities: Endpoint) {
    assertPrivateEndpoint(this.port, config, capabilities);
  }
}
