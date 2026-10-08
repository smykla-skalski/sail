import type { AgentPermission } from './acp.ts';

export type AcpPermissionIdentity = Pick<
  AgentPermission,
  'id' | 'sessionId' | 'generation' | 'fingerprint'
>;

export function acpPermissionIdentity(permission: AcpPermissionIdentity): string {
  return JSON.stringify([
    permission.sessionId,
    String(permission.id),
    permission.generation ?? null,
    permission.fingerprint ?? null,
  ]);
}

export function enqueueAcpPermission(
  permissions: readonly AgentPermission[],
  permission: AgentPermission,
): AgentPermission[] {
  const identity = acpPermissionIdentity(permission);
  return permissions.some((candidate) => acpPermissionIdentity(candidate) === identity)
    ? [...permissions]
    : [...permissions, permission];
}

export function removeResolvedAcpPermission(
  permissions: readonly AgentPermission[],
  resolved: AcpPermissionIdentity,
): AgentPermission[] {
  const identity = acpPermissionIdentity(resolved);
  return permissions.filter((permission) => acpPermissionIdentity(permission) !== identity);
}
