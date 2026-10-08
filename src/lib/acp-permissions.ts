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

export function acpPermissionActivitySourceId(
  id: string | number,
  generation?: string | number,
  fingerprint?: string,
): string {
  return JSON.stringify([String(id), generation ?? null, fingerprint ?? null]);
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

export function reconcileRejectedAcpPermission(
  permissions: readonly AgentPermission[],
  rejected: AcpPermissionIdentity,
  pending: readonly AcpPermissionIdentity[],
): AgentPermission[] {
  const identity = acpPermissionIdentity(rejected);
  return pending.some((permission) => acpPermissionIdentity(permission) === identity)
    ? [...permissions]
    : permissions.filter((permission) => acpPermissionIdentity(permission) !== identity);
}

export async function fencedAcpPermissionInventory<T>(
  load: () => Promise<T[]>,
  revision: () => number,
  active: () => boolean,
): Promise<T[] | null> {
  if (!active()) return null;
  const startedAt = revision();
  const pending = await load();
  if (!active()) return null;
  return startedAt === revision() ? pending : fencedAcpPermissionInventory(load, revision, active);
}
