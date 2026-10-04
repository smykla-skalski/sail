import { toolCommand, toolInput } from './tool-display.ts';

export function toolFailurePrompt(
  name: string,
  input: unknown,
  error: string,
  output: string,
): string {
  const action = toolCommand(input) ?? toolInput(input);
  return [
    `Fix the failed ${name} action. Inspect the cause, make the needed change, and verify it.`,
    action && `Action:\n${action}`,
    `Error:\n${error}`,
    output && `Output:\n${output}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function reportedHookIdentity(metadata: Record<string, unknown> | undefined): string | null {
  for (const field of ['plugin', 'hook']) {
    const value = metadata?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
