import { OpenCode, type OpenCodeClient } from '@opencode/client';

export const OPENCODE_VERSION = '2.0.24';

export type { OpenCodeClient };
export type { SessionInfo, SessionMessageInfo } from '@opencode/client';

export interface RuntimeInfo {
  url: string;
  password: string;
  binaryPath: string;
}

export function compatibleOpenCodeVersion(version: string): boolean {
  return version === OPENCODE_VERSION;
}

export function connect(info: RuntimeInfo): OpenCodeClient {
  return OpenCode.make({
    baseUrl: info.url,
    headers: { authorization: `Basic ${btoa(`opencode:${info.password}`)}` },
  });
}
