import {
  permissionResourceCandidates,
  type PermissionPolicyDecision,
} from './capability-profiles.ts';
import { toolCommand } from './tool-display.ts';

export type PermissionChoice = {
  id: string;
  label: string;
  tone: 'primary' | 'secondary' | 'danger';
  /** True for choices that save an approval beyond this one request. */
  always: boolean;
};

export type PermissionDetails = {
  toolCallId: string | null;
  command: string | null;
  files: string[];
};

/** A saved approval is only offered for reviewed low and medium risk actions. */
export function mayAlwaysAllow(policy: PermissionPolicyDecision | undefined): boolean {
  return policy?.risk === 'low' || policy?.risk === 'medium';
}

/** ACP options for one request; always-allow kinds and denied allows are removed. */
export function acpPermissionChoices(
  options: { optionId: string; name: string; kind: string }[],
  policy: PermissionPolicyDecision | undefined,
): PermissionChoice[] {
  return options
    .filter((option) => {
      if (!option.kind.startsWith('allow')) return true;
      if (policy?.recommendation === 'deny') return false;
      return option.kind !== 'allow_always' || mayAlwaysAllow(policy);
    })
    .map((option) => ({
      id: option.optionId,
      label: option.name,
      tone: option.kind.startsWith('allow') ? 'primary' : 'secondary',
      always: option.kind === 'allow_always',
    }));
}

export function openCodePermissionChoices(
  policy: PermissionPolicyDecision | undefined,
): PermissionChoice[] {
  const choices: PermissionChoice[] = [];
  if (policy?.recommendation !== 'deny') {
    choices.push({ id: 'once', label: 'Allow once', tone: 'primary', always: false });
    if (mayAlwaysAllow(policy))
      choices.push({ id: 'always', label: 'Allow always', tone: 'secondary', always: true });
  }
  choices.push({ id: 'reject', label: 'Reject', tone: 'secondary', always: false });
  return choices;
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

/** Exact command, files and tool call id the request refers to. */
export function acpPermissionDetails(toolCall: unknown): PermissionDetails {
  const id = field(toolCall, 'toolCallId');
  const command =
    [field(toolCall, 'rawInput'), field(toolCall, 'input'), field(toolCall, 'arguments'), toolCall]
      .map((value) => toolCommand(value))
      .find((value) => value !== null) ?? null;
  return {
    toolCallId: typeof id === 'string' ? id : null,
    command,
    files: [...new Set(permissionResourceCandidates(toolCall))].filter(
      (file) => file && file !== command,
    ),
  };
}

export function openCodePermissionDetails(request: {
  action: string;
  resources: string[];
  source?: { type: string; messageID: string; id: string };
}): PermissionDetails {
  const shell = request.action === 'bash' || request.action === 'shell';
  return {
    toolCallId: request.source ? `${request.source.messageID}:${request.source.id}` : null,
    command: shell ? (request.resources[0] ?? null) : null,
    files: shell ? request.resources.slice(1) : request.resources,
  };
}

/** One-line reason shown for an automated decision, or null when a person decides. */
export function automatedDecisionNote(
  policy: PermissionPolicyDecision | undefined,
  outcome: 'allowed' | 'rejected',
): string | null {
  if (!policy || policy.recommendation === 'interactive') return null;
  return `${outcome === 'allowed' ? 'Allowed' : 'Rejected'} by policy: ${policy.reason}`;
}
