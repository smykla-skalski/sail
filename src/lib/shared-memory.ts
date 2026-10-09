export const memoryModes = ['off', 'sail', 'system'] as const;
export type MemoryMode = (typeof memoryModes)[number];

export const memoryKinds = [
  'decision',
  'constraint',
  'discovery',
  'preference',
  'handoff',
  'other',
] as const;
export type MemoryKind = (typeof memoryKinds)[number];

export type MemoryRecord = {
  id: string;
  content: string;
  kind: MemoryKind;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  provenance: { agent?: string; sessionId?: string };
  rating?: { value: -1 | 0 | 1; updatedAt: number };
  forgottenAt?: number;
};

export type MemorySearchResult = { memory: MemoryRecord; score: number };

export type MemoryStatus = {
  mode: MemoryMode;
  enabled: boolean;
  projectKey: string;
  count: number;
  forgottenCount: number;
};

export type MemoryProviderKind = 'local' | 'mem0Hosted' | 'mem0SelfHosted';

export type MemoryProviderStatus = {
  provider: MemoryProviderKind;
  endpoint?: string;
  configured: boolean;
  credentialStorage?: 'keychain' | 'memory';
  notice?: string;
};

export type MemoryAgentStatus = {
  id: 'claude' | 'codex' | 'opencode';
  name: string;
  detected: boolean;
  installed: boolean;
  healthy: boolean;
  detail: string;
};

export type MemoryAgentInstallPreview = {
  agent: MemoryAgentStatus['id'];
  path: string;
  before: string;
  after: string;
  changed: boolean;
};

export function parseMemoryMode(value: string | null | undefined): MemoryMode {
  return value === 'sail' || value === 'system' ? value : 'off';
}

export function parseMemoryTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

export function createSerialExecutor(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  return <T>(work: () => Promise<T>) => {
    const result = tail.then(work, work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export function exportMemories(records: MemoryRecord[]): string {
  return `${JSON.stringify(
    {
      format: 'sail-shared-memory',
      version: 1,
      exportedAt: new Date().toISOString(),
      memories: records,
    },
    null,
    2,
  )}\n`;
}
