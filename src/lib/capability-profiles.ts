import capabilityPolicy from './capability-policy.json' with { type: 'json' };

export const capabilityProfiles = ['explore', 'review', 'build', 'release'] as const;
export type CapabilityProfile = (typeof capabilityProfiles)[number];
export type CapabilityRisk = 'low' | 'medium' | 'high' | 'unknown';

export const capabilityPolicyRevision = capabilityPolicy.revision;

export function capabilityProfileFromMetadata(
  metadata: { sailCapabilityProfile?: unknown } | null | undefined,
  fallback: CapabilityProfile,
): CapabilityProfile {
  const profile = metadata?.sailCapabilityProfile;
  return profile === 'explore' ||
    profile === 'review' ||
    profile === 'build' ||
    profile === 'release'
    ? profile
    : fallback;
}

export function capabilityProfileForRuntime(
  sessions: readonly { id: string; metadata?: { sailCapabilityProfile?: unknown } }[],
  activeSessionIDs: Iterable<string>,
  fallback: CapabilityProfile,
): CapabilityProfile | null {
  const active = new Set(activeSessionIDs);
  const profiles = new Set(
    sessions
      .filter((session) => active.has(session.id))
      .map((session) => capabilityProfileFromMetadata(session.metadata, fallback)),
  );
  if (profiles.size > 1) return null;
  return profiles.values().next().value ?? fallback;
}

export function exploreSessionMetadata(metadata: Record<string, unknown> | undefined) {
  return { ...metadata, saiHarness: true as const, sailCapabilityProfile: 'explore' as const };
}

export type PermissionPolicyDecision = {
  profile: CapabilityProfile;
  risk: CapabilityRisk;
  recommendation: 'allow' | 'deny' | 'interactive';
  optionId?: string;
  reason: string;
  policyRevision: string;
};

const destructive = [
  /(?:^|[/\\])\.ssh[/\\](?:id_(?:rsa|dsa|ecdsa|ed25519)|config)(?:$|[/\\])/i,
  /(?:^|[/\\])\.aws[/\\]credentials(?:$|[/\\])/i,
  /(?:^|[/\\])(?:\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials)(?:$|[/\\])/i,
  /(?:^|[/\\])\.gem[/\\]credentials(?:$|[/\\])/i,
  /(?:^|[/\\])\.docker[/\\]config\.json(?:$|[/\\])/i,
  /(?:^|[/\\])\.kube[/\\]config(?:$|[/\\])/i,
  /(?:^|[/\\])\.config[/\\](?:gh[/\\]hosts\.yml|glab-cli[/\\]config\.yml|gcloud[/\\]application_default_credentials\.json)(?:$|[/\\])/i,
  /(?:^|[/\\])(?:etc[/\\](?:shadow|gshadow|sudoers)|\.codex[/\\](?:auth\.json|config\.toml)|\.claude(?:\.json|[/\\]\.credentials\.json)|\.config[/\\]opencode[/\\]auth\.json)(?:$|[/\\])/i,
  /(?:^|[/\\])\.env(?:\.[^/\\]+)?(?:$|[/\\])/i,
  /(?:^|\s)(?:env\s+)?[A-Za-z_][A-Za-z0-9_]*=[^\n]*?\b(?:git|rg|grep|sed|cat|ls|find)\b/i,
  /\brg\b[^\n]*--(?:pre|hostname-bin)(?:=|\s)/i,
  /\bgit\b[^\n]*(?:-c\s+(?:diff\.external|diff\.[^.\s=]+\.textconv)=|--(?:ext-diff|textconv)\b)/i,
  /\brm\s+-[^\n]*r[^\n]*f\b/i,
  /\bgit\s+(?:reset\s+--hard|push\b[^\n]*--force)/i,
  /\bgit\s+branch\b[^\n]*(?:\s-[^-\s]*[dD][^-\s]*(?=\s|$)|\s--delete(?:=|\s|$))/i,
  /\b(?:kubectl|helm)\b[^\n]*\bdelete\b/i,
  /\bterraform\s+destroy\b/i,
  /\bdrop\s+(?:database|table)\b/i,
  /\bfind\b[^\n]*\s-(?:delete|exec(?:dir)?|ok(?:dir)?|fprint(?:0|f)?|fls)\b/i,
  /\b(?:publish|deploy|release|merge)\b/i,
  /\b(?:secret|credential|private[_ -]?key|access[_ -]?token)\b/i,
];

const readOnly = [
  /^(?:read|view|list|search|find|inspect|show|status|diff|log)\b/i,
  /^(?:rg\b|grep\b|cat\b|ls\b|find\b)/i,
];

const requestActionKeys = new Set(['action', 'cmd', 'command', 'name']);
const requestNestedKeys = new Set([
  'arguments',
  'input',
  'metadata',
  'parameters',
  'params',
  'rawInput',
  'toolCall',
]);
const requestMetadataKeys = new Set([
  'content',
  'description',
  'id',
  'kind',
  'locations',
  'message',
  'output',
  'rawoutput',
  'status',
  'title',
  'toolcallid',
]);
const requestResourceKeys = new Set([
  'cwd',
  'directory',
  'directories',
  'file',
  'filename',
  'filenames',
  'filepath',
  'filepaths',
  'files',
  'path',
  'paths',
  'resource',
  'resources',
  'save',
  'canonicalresources',
  'target',
  'targets',
  'uri',
  'uris',
]);

export function openCodePermissionToolCall(request: {
  action: string;
  message?: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    action: request.action,
    message: request.message,
    resources: request.resources,
    save: request.save,
    metadata: request.metadata,
  };
}

function normalizedRequestKey(key: string): string {
  return key.replaceAll(/[-_]/g, '').toLowerCase();
}

const mutating = [
  /^(?:write|edit|create|update|apply|install|format|build|test|lint|check)\b/i,
  /\bgit\s+(?:diff|show|log)\b[^\n]*--output(?:=|\s)/i,
  /\bsed\b[^\n]*(?:\s-[^-\s]*i[^\s]*|\s--in-place(?:=|\s|$))/i,
  /\b(?:apply_patch|git\s+(?:add|commit|rebase|cherry-pick)|npm\s+(?:install|ci)|cargo\s+(?:fmt|test|clippy|build))\b/i,
];

const executesProjectCode = [
  /^(?:install|build|test)\b/i,
  /\b(?:npm|pnpm|bun)\s+(?:install|ci|test|start|stop|restart|run(?:-script)?)\b/i,
  /\byarn\s+(?:install|test|run)\b/i,
  /\bcargo\s+(?:test|build)\b/i,
];

function requestOversized(toolCall: unknown): boolean {
  let detail: string;
  try {
    detail = JSON.stringify(toolCall ?? '');
  } catch {
    detail = '';
  }
  return detail.length > 16_384;
}

function requestCandidates(toolCall: unknown): string[] {
  const candidates: string[] = [];
  const visit = (value: unknown, root = false): void => {
    if (typeof value === 'string') {
      if (root) candidates.push(value.slice(0, 16_384).trim());
      return;
    }
    if (Array.isArray(value)) {
      if (value.every((item) => typeof item === 'string'))
        candidates.push(value.join(' ').slice(0, 16_384).trim());
      else value.forEach((item) => visit(item));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (requestActionKeys.has(key) && typeof item === 'string')
        candidates.push(item.slice(0, 16_384).trim());
      else if (requestActionKeys.has(key) && Array.isArray(item)) visit(item, true);
      else if (requestNestedKeys.has(key)) visit(item, true);
    }
  };
  visit(toolCall, true);
  return candidates;
}

function requestShellCommands(toolCall: unknown): string[] {
  const commands: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const command = value.slice(0, 16_384).trim();
      if (/^(?:rg|grep|cat|ls|find)\b/i.test(command)) commands.push(command);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'cmd' || key === 'command') && typeof item === 'string')
        commands.push(item.slice(0, 16_384).trim());
      else if (['arguments', 'input', 'parameters', 'params', 'rawInput', 'toolCall'].includes(key))
        visit(item);
    }
  };
  visit(toolCall);
  return commands;
}

export function permissionResourceCandidates(toolCall: unknown): string[] {
  const candidates: string[] = [];
  const visit = (value: unknown, collect = false): void => {
    if (typeof value === 'string') {
      if (collect) candidates.push(value.slice(0, 16_384).trim());
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, collect));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      visit(item, collect || requestResourceKeys.has(normalizedRequestKey(key)));
    }
  };
  visit(toolCall);
  return candidates;
}

function containsUnrecognizedNestedValue(value: unknown, actionsRecognized = true): boolean {
  if (Array.isArray(value))
    return value.some((item) => containsUnrecognizedNestedValue(item, actionsRecognized));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => {
    const normalizedKey = normalizedRequestKey(key);
    if (requestActionKeys.has(key))
      return (
        !actionsRecognized ||
        (typeof item !== 'string' &&
          (!Array.isArray(item) ||
            !item.length ||
            !item.every((entry) => typeof entry === 'string')))
      );
    if (requestResourceKeys.has(normalizedKey)) return false;
    if (requestMetadataKeys.has(normalizedKey))
      return !!item && typeof item === 'object' && containsUnrecognizedNestedValue(item, false);
    if (requestNestedKeys.has(key)) return containsUnrecognizedNestedValue(item, actionsRecognized);
    return true;
  });
}

function containsUnrecognizedNestedInput(toolCall: unknown): boolean {
  return containsUnrecognizedNestedValue(toolCall);
}

export function permissionReadResources(toolCall: unknown): string[] {
  return [
    ...permissionResourceCandidates(toolCall),
    ...commandResourceCandidates(requestCandidates(toolCall)),
  ];
}

function containsUnparsedShellResource(candidates: string[]): boolean {
  return candidates.some((candidate) => {
    if (
      /\$(?:'|"|\{|[A-Za-z_])|%[A-Za-z_][A-Za-z0-9_]*%/.test(candidate) ||
      /(?:^|\s)(?:[^\s'"`]+)?(?:'[^']*'|"[^"`$]*")[^\s]/.test(candidate)
    )
      return true;
    let quote: "'" | '"' | null = null;
    for (const character of candidate) {
      if (quote) {
        if (character === quote) quote = null;
        else if (quote === '"' && (character === '$' || character === '`')) return true;
      } else if (character === "'" || character === '"') quote = character;
      else if ('\\*?[{'.includes(character)) return true;
    }
    return quote !== null;
  });
}

function containsCompoundShellSyntax(candidates: string[]): boolean {
  return candidates.some((candidate) => /(?:&&|\|\||[;&|<>`]|\$\(|\n|\r)/.test(candidate));
}

function searchCommandResources(command: 'rg' | 'grep', args: string[]): string[] {
  const valueOptions = new Set(
    command === 'rg'
      ? [
          '-e',
          '--regexp',
          '-f',
          '--file',
          '-g',
          '--glob',
          '--iglob',
          '-t',
          '--type',
          '--type-add',
          '--type-clear',
          '--encoding',
          '--engine',
          '--max-depth',
          '--sort',
          '--sortr',
        ]
      : ['-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '-B', '-C'],
  );
  const flags =
    command === 'rg'
      ? /^(?:--files|--hidden|--no-ignore|--follow|--no-messages|-[nHhilLsuUv]+)$/
      : /^(?:--recursive|--line-number|--ignore-case|--invert-match|-[rRnHhilLsv]+)$/;
  const resources: string[] = [];
  const positional: string[] = [];
  let explicitPattern = false;
  let filesMode = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    const separator = token.indexOf('=');
    const option = separator < 0 ? token : token.slice(0, separator);
    if (valueOptions.has(option)) {
      const value = separator < 0 ? args[++index] : token.slice(separator + 1);
      if (!value) return [...resources, ...positional];
      if (option === '-e' || option === '--regexp' || option === '-f' || option === '--file')
        explicitPattern = true;
      if (option === '-f' || option === '--file') resources.push(value);
      continue;
    }
    if (token === '--files') filesMode = true;
    else if (token.startsWith('-') && !flags.test(token))
      return [
        ...resources,
        ...positional,
        ...args.slice(index + 1).filter((item) => !item.startsWith('-')),
      ];
    else if (!token.startsWith('-')) positional.push(token);
  }
  return [...resources, ...(filesMode || explicitPattern ? positional : positional.slice(1))];
}

function commandResourceCandidates(candidates: string[]): string[] {
  const explicit = candidates
    .flatMap((candidate) => [
      ...candidate.matchAll(
        /(?:^|[\s=])["']?((?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)[/\\][^\s"']*|(?:https?|file):\/\/[^\s"']+|[A-Za-z]:[/\\][^\s"']+|\/[^\s"']+|\.\.[/\\][^\s"']*)/gi,
      ),
    ])
    .map((match) => match[1]);
  const operands = candidates.flatMap((candidate) => {
    const tokens = (candidate.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
      token.replace(/^(['"])(.*)\1$/, '$2'),
    );
    const command = tokens[0]?.toLowerCase();
    const args = tokens.slice(1);
    const positional = args.filter((token) => !token.startsWith('-'));
    if (command === 'cat' || command === 'ls') return positional;
    if (command === 'find') return positional.slice(0, 1);
    if (command === 'rg' || command === 'grep') return searchCommandResources(command, args);
    return [];
  });
  return [...new Set([...explicit, ...operands])];
}

function normalizePath(value: string): { absolute: boolean; path: string } | null {
  let path = value.trim().replace(/^['"]|['"]$/g, '');
  if (!path) return null;
  if (/^(?:\$HOME|\$\{HOME\}|%USERPROFILE%)(?:[/\\]|$)/i.test(path)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    if (!path.toLowerCase().startsWith('file://')) return null;
    try {
      const file = new URL(path);
      if (file.hostname && file.hostname !== 'localhost') return null;
      path = decodeURIComponent(file.pathname);
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    } catch {
      return null;
    }
  }
  path = path.replaceAll('\\', '/');
  if (/^~[^/\\]*(?:[/\\]|$)/.test(path)) return null;
  const drive = /^[A-Za-z]:\//.exec(path)?.[0].slice(0, 2).toLowerCase() ?? '';
  const absolute = path.startsWith('/') || !!drive;
  const segments: string[] = [];
  for (const segment of path.slice(drive ? 2 : 0).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return null;
      segments.pop();
    } else segments.push(segment);
  }
  return { absolute, path: `${drive}${absolute ? '/' : ''}${segments.join('/')}` };
}

function trustedResource(resource: string, workspace?: string): boolean {
  const candidate = normalizePath(resource);
  if (!candidate) return false;
  if (!candidate.absolute) return true;
  if (!workspace) return false;
  const root = normalizePath(workspace);
  if (!root?.absolute) return false;
  const candidatePath = /^[a-z]:\//.test(candidate.path)
    ? candidate.path.toLowerCase()
    : candidate.path;
  const rootPath = /^[a-z]:\//.test(root.path) ? root.path.toLowerCase() : root.path;
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

export function classifyPermission(
  toolCall: unknown,
  title: string,
  workspace?: string,
  resourceTrust?: { trusted: boolean; canonicalResources: string[] },
): CapabilityRisk {
  void title;
  const oversized = requestOversized(toolCall);
  const candidates = requestCandidates(toolCall);
  const shellCommands = requestShellCommands(toolCall);
  const resources = permissionResourceCandidates(toolCall);
  const riskCandidates = [
    ...candidates,
    ...resources,
    ...(resourceTrust?.canonicalResources ?? []),
  ];
  if (oversized) return 'high';
  if (riskCandidates.some((candidate) => destructive.some((pattern) => pattern.test(candidate))))
    return 'high';
  if (containsCompoundShellSyntax(candidates)) return 'unknown';
  if (containsUnparsedShellResource(candidates)) return 'unknown';
  if (
    candidates.some((candidate) =>
      [...readOnly, ...mutating].some((pattern) => pattern.test(candidate)),
    ) &&
    containsUnrecognizedNestedInput(toolCall)
  )
    return 'unknown';
  if (
    candidates.some((candidate) => executesProjectCode.some((pattern) => pattern.test(candidate)))
  )
    return 'high';
  if (candidates.some((candidate) => mutating.some((pattern) => pattern.test(candidate))))
    return 'medium';
  if (
    candidates.length > 0 &&
    candidates.every((candidate) => readOnly.some((pattern) => pattern.test(candidate)))
  ) {
    if (shellCommands.length > 0) return 'unknown';
    const readResources = [...resources, ...commandResourceCandidates(candidates)];
    if (readResources.length > 0 && !resourceTrust) return 'unknown';
    if (resourceTrust && !resourceTrust.trusted) return 'unknown';
    if (readResources.some((resource) => !trustedResource(resource, workspace))) return 'unknown';
    return 'low';
  }
  return 'unknown';
}

export function permissionOutcome(
  options: { optionId: string; kind: string }[],
  selectedOptionId: string,
): 'completed' | 'rejected' {
  return options
    .find((candidate) => candidate.optionId === selectedOptionId)
    ?.kind.startsWith('reject')
    ? 'rejected'
    : 'completed';
}

export function conflictingCapabilityProfiles(
  active: Iterable<CapabilityProfile>,
  requested: CapabilityProfile,
): CapabilityProfile[] {
  return [...new Set(active)].filter((profile) => profile !== requested).toSorted();
}

export function settledOpenCodePermissions<T extends { sessionID: string }>(
  pending: readonly T[],
  selected: T,
  decision: 'once' | 'always' | 'reject',
): T[] {
  return decision === 'reject'
    ? pending.filter((request) => request.sessionID === selected.sessionID)
    : [selected];
}

export async function withCapabilityProfileReservation<T>(
  reserve: () => Promise<() => void>,
  action: () => Promise<T>,
): Promise<T> {
  const release = await reserve();
  try {
    return await action();
  } finally {
    release();
  }
}

export async function holdCapabilityProfileReservation<T>(
  release: () => void,
  completion: Promise<T>,
): Promise<T> {
  try {
    return await completion;
  } finally {
    release();
  }
}

export class CapabilityProfileReservationCoordinator {
  #configurationGeneration = 0;
  readonly #active = new Map<
    string,
    {
      profile: CapabilityProfile;
      count: number;
      configured: Promise<void>;
      configurationGeneration: number;
    }
  >();

  beginConfigurationGeneration(): void {
    this.#configurationGeneration++;
  }

  async reserve(
    path: string,
    profile: CapabilityProfile,
    configure: () => Promise<void>,
  ): Promise<() => void> {
    const reserved = this.#active.get(path);
    if (reserved && reserved.profile !== profile)
      throw new Error(
        `Wait for the pending ${reserved.profile} OpenCode launch before switching to the ${profile} capability profile.`,
      );
    const configured =
      reserved?.configurationGeneration === this.#configurationGeneration
        ? reserved.configured
        : Promise.resolve().then(configure);
    this.#active.set(path, {
      profile,
      count: (reserved?.count ?? 0) + 1,
      configured,
      configurationGeneration: this.#configurationGeneration,
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const current = this.#active.get(path);
      if (!current || current.profile !== profile) return;
      if (current.count === 1) this.#active.delete(path);
      else this.#active.set(path, { ...current, count: current.count - 1 });
    };
    try {
      await configured;
      return release;
    } catch (cause) {
      release();
      throw cause;
    }
  }
}

function oneShotOption(
  options: { optionId: string; kind: string }[],
  kind: 'allow_once' | 'reject_once',
): string | undefined {
  return options.find((candidate) => candidate.kind === kind)?.optionId;
}

function rejectOption(options: { optionId: string; kind: string }[]): string | undefined {
  return (
    oneShotOption(options, 'reject_once') ??
    options.find((candidate) => candidate.kind.startsWith('reject'))?.optionId
  );
}

export function permissionPolicy(input: {
  profile: CapabilityProfile;
  workspace?: string;
  title: string;
  toolCall: unknown;
  options: { optionId: string; kind: string }[];
  resourceTrust?: { trusted: boolean; canonicalResources: string[] };
}): PermissionPolicyDecision {
  const risk = classifyPermission(
    input.toolCall,
    input.title,
    input.workspace,
    input.resourceTrust,
  );
  const base = {
    profile: input.profile,
    risk,
    policyRevision: capabilityPolicyRevision,
  };
  if (risk === 'unknown' || risk === 'high')
    return {
      ...base,
      recommendation: 'interactive',
      reason:
        risk === 'unknown'
          ? 'The action does not match a reviewed policy rule.'
          : 'High-risk actions always require a person.',
    };

  const permitted = risk === 'low' || input.profile === 'build' || input.profile === 'release';
  if (permitted) {
    const optionId = oneShotOption(input.options, 'allow_once');
    if (optionId)
      return {
        ...base,
        recommendation: 'allow',
        optionId,
        reason: `${risk}-risk action is enabled for the ${input.profile} profile.`,
      };
  } else {
    const optionId = rejectOption(input.options);
    if (optionId)
      return {
        ...base,
        recommendation: 'deny',
        optionId,
        reason: `Medium-risk action is disabled for the ${input.profile} profile.`,
      };
  }
  return {
    ...base,
    recommendation: 'interactive',
    reason: 'The provider did not offer a safe automatic response option.',
  };
}

export function automaticPermissionPolicy(
  input: Parameters<typeof permissionPolicy>[0],
): PermissionPolicyDecision {
  const decision = permissionPolicy(input);
  if (decision.recommendation === 'allow' && permissionReadResources(input.toolCall).length > 0)
    return {
      ...decision,
      recommendation: 'interactive',
      optionId: undefined,
      reason: 'Path-based reads require approval because the provider opens the path later.',
    };
  return decision;
}

export function capabilityProfileForPhase(phase?: string): CapabilityProfile {
  if (phase === 'explore') return 'explore';
  if (phase === 'review' || phase === 'test') return 'review';
  if (phase === 'pr' || phase === 'complete') return 'release';
  return 'build';
}

export function permissionDecisionTitle(
  title: string,
  decision: PermissionPolicyDecision,
  outcome?: 'completed' | 'rejected',
): string {
  const action =
    outcome === 'rejected'
      ? 'Rejected'
      : outcome === 'completed'
        ? 'Allowed'
        : decision.recommendation === 'allow'
          ? 'Allowed by policy'
          : decision.recommendation === 'deny'
            ? 'Denied by policy'
            : 'Awaiting approval';
  return `${decision.profile} · ${decision.risk} risk · policy ${decision.policyRevision} — ${action}: ${decision.reason} — ${title}`;
}
