export function needsChildSummary(
  child: { id: string; time: { updated: number } },
  active: readonly string[],
  observed: ReadonlyMap<string, number>,
): boolean {
  return active.includes(child.id) || observed.get(child.id) !== child.time.updated;
}
