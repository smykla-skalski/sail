export const reefCanarySettingKey = 'sai-reef-canary-percent';

export function parseReefCanaryPercent(value: string | null): number | null {
  if (value === null || value === 'off') return null;
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(value)) return null;
  const percent = Number(value);
  return percent <= 100 ? percent : null;
}
