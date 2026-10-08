export const sidebarDefaultWidth = 248;
export const sidebarRailWidth = 64;
export const sidebarMinWidth = 180;
export const sidebarMaxWidth = 560;
// Below this a drag snaps to the icon rail instead of a cramped text list.
const railSnapWidth = 120;

export function parseSidebarWidth(value: string | null): number {
  const width = Number(value);
  return value?.trim() && Number.isFinite(width) && width > 0
    ? clampSidebarWidth(width)
    : sidebarDefaultWidth;
}

export function clampSidebarWidth(width: number, max = sidebarMaxWidth): number {
  if (width < railSnapWidth) return sidebarRailWidth;
  return Math.min(Math.max(sidebarMinWidth, max), Math.max(sidebarMinWidth, Math.round(width)));
}

export function sidebarIsRail(width: number): boolean {
  return width <= sidebarRailWidth;
}

// Keyboard steps cannot land in the dead zone between rail and minimum list width.
export function stepSidebarWidth(current: number, delta: number, max = sidebarMaxWidth): number {
  if (sidebarIsRail(current)) return delta > 0 ? sidebarMinWidth : sidebarRailWidth;
  const next = current + delta;
  return next < sidebarMinWidth ? sidebarRailWidth : clampSidebarWidth(next, max);
}
