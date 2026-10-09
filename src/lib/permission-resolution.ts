import { automaticPermissionPolicy, type PermissionPolicyDecision } from './capability-profiles.ts';

export function assertAutomaticPermissionAllowed(
  input: Parameters<typeof automaticPermissionPolicy>[0],
  optionId: string,
): void {
  const policy = automaticPermissionPolicy(input);
  if (policy.recommendation !== 'allow' || policy.optionId !== optionId)
    throw new Error('Permission resource changed before automatic approval.');
}

type PermissionRequestBase = {
  key: string;
  generation: string | number;
  policy: PermissionPolicyDecision;
};

export type AutomaticPermissionRequest = PermissionRequestBase & {
  respond: (optionId: string) => Promise<boolean | void>;
  record: (optionId: string) => void;
};

export type ManualPermissionRequest = PermissionRequestBase & {
  optionId: string | null;
  respond: (optionId: string | null) => Promise<void>;
  record: (optionId: string | null) => void;
};

export function permissionChoiceForPolicy(
  policy: PermissionPolicyDecision,
  options: { optionId: string; kind: string }[],
  optionId: string | null,
): string | null {
  const selected = options.find((option) => option.optionId === optionId);
  if (policy.recommendation !== 'deny' || optionId === null || selected?.kind.startsWith('reject'))
    return optionId;
  return (
    options.find(
      (option) => option.optionId === policy.optionId && option.kind.startsWith('reject'),
    )?.optionId ??
    options.find((option) => option.kind.startsWith('reject'))?.optionId ??
    null
  );
}

export class AutomaticPermissionResolver {
  readonly #inFlight = new Map<string, Promise<boolean>>();
  readonly #completed = new Set<string>();

  resolve(request: AutomaticPermissionRequest | ManualPermissionRequest): Promise<boolean> {
    if ('optionId' in request) return this.#resolve(request, request.optionId);
    if (request.policy.recommendation === 'interactive' || !request.policy.optionId)
      return Promise.resolve(false);
    return this.#resolve(request, request.policy.optionId);
  }

  #resolve<Option extends string | null>(
    request: PermissionRequestBase & {
      respond: (optionId: Option) => Promise<boolean | void>;
      record: (optionId: Option) => void;
    },
    optionId: Option,
  ): Promise<boolean> {
    const identity = JSON.stringify([request.key, request.generation]);
    if (this.#completed.has(identity)) return Promise.resolve(true);
    const existing = this.#inFlight.get(identity);
    if (existing) return existing;
    const resolution = request
      .respond(optionId)
      .then((resolved) => {
        if (resolved === false) return false;
        request.record(optionId);
        this.#completed.add(identity);
        if (this.#completed.size > 512) {
          const oldest = this.#completed.values().next().value;
          if (oldest !== undefined) this.#completed.delete(oldest);
        }
        return true;
      })
      .finally(() => this.#inFlight.delete(identity));
    this.#inFlight.set(identity, resolution);
    return resolution;
  }
}

export const permissionResolver = new AutomaticPermissionResolver();
