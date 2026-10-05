export function checkState(check: { state: string }): 'failing' | 'passing' | 'pending' {
  if (
    [
      'FAILURE',
      'ERROR',
      'TIMED_OUT',
      'CANCELLED',
      'ACTION_REQUIRED',
      'STALE',
      'STARTUP_FAILURE',
    ].includes(check.state)
  )
    return 'failing';
  if (['SUCCESS', 'EXPECTED', 'NEUTRAL', 'SKIPPED'].includes(check.state)) return 'passing';
  return 'pending';
}
