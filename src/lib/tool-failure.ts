import { toolCommand, toolInput } from './tool-display.ts';

export function toolFailurePrompt(
  name: string,
  input: unknown,
  error: string,
  output: string,
): string {
  const command = toolCommand(input);
  const action = toolInput(input);
  return [
    `Fix the failed ${name} action. Inspect the cause, make the needed change, and verify it.`,
    command && `Command:\n${command}`,
    action && `Input:\n${action}`,
    `Error:\n${error}`,
    output && `Output:\n${output}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function appendToolFailureDraft(draft: string, request: string): string {
  return draft.includes(request) ? draft : [draft.trim(), request].filter(Boolean).join('\n\n');
}

export function openCodeErrorDetails(error: {
  type: string;
  message: string;
  response?: { body: string };
}): string {
  const message = error.message.trim() || error.type || 'Tool failed';
  const body = error.response?.body.trim();
  return body && !message.includes(body) ? `${message}\n\n${body}` : message;
}

export function reportedHookIdentity(metadata: Record<string, unknown> | undefined): string | null {
  for (const field of ['plugin', 'hook']) {
    const value = metadata?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
