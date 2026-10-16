export function acpSessionOwner(sessionId: string | null): string | null {
  if (!sessionId) return null;
  const match =
    /^(?:sail-profile:(?:explore|review|build|release):)?sail-owned:([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}):/.exec(
      sessionId,
    );
  return match?.[1] ?? null;
}
