import type { AgentTool } from './acp.ts';
import { klaudiushRules } from './klaudiush.ts';
import { toolCommand, toolInput } from './tool-display.ts';

export interface AcpToolFailure {
  kind: 'hook' | 'tool';
  action: string;
  rule: string | null;
  reason: string;
  output: string;
}

function field(value: unknown, names: string[]): string | null {
  if (!value || typeof value !== 'object') return null;
  for (const name of names) {
    const found: unknown = Reflect.get(value, name);
    if (typeof found === 'string' && found.trim()) return found.trim();
    if (found && typeof found === 'object') {
      const nested: unknown = Reflect.get(found, 'name');
      if (typeof nested === 'string' && nested.trim()) return nested.trim();
    }
  }
  return null;
}

export function acpToolFailure(tool: AgentTool): AcpToolFailure | null {
  if (!/fail|error|reject/i.test(tool.status)) return null;
  const raw = tool.output;
  const rawText = typeof raw === 'string' ? raw : toolInput(raw);
  const output = [tool.content, rawText]
    .filter(Boolean)
    .filter((part, index, all) => all.indexOf(part) === index)
    .join('\n')
    .trim();
  const rules = klaudiushRules(output);
  const hookName = field(raw, ['hookName', 'hook_name', 'hook']);
  const ruleName = field(raw, ['ruleName', 'rule_name', 'rule']);
  const hookEvidence =
    /\b(?:PreToolUse|PostToolUse)\b|(?:blocked|denied|rejected|failed) by (?:a )?hook|hook (?:blocked|denied|rejected|failed)/i.test(
      output,
    );
  const kind = rules.length || hookName || ruleName || hookEvidence ? 'hook' : 'tool';
  const rule = rules.length ? rules.map((item) => item.code).join(', ') : (ruleName ?? hookName);
  const reason = rules.length
    ? rules.map((item) => item.reason).join('; ')
    : (field(raw, ['reason', 'error', 'message', 'stderr', 'stdout']) ??
      output
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) ??
      'The action failed without a reason from the agent.');
  return {
    kind,
    action: toolCommand(tool.input) ?? tool.title,
    rule: kind === 'hook' ? rule : null,
    reason: reason.slice(0, 1000),
    output: output.slice(0, 4000),
  };
}

export function fixAcpToolFailurePrompt(failure: AcpToolFailure): string {
  return [
    `Fix the ${failure.kind === 'hook' ? 'hook-blocked action' : 'failed tool action'} below. Follow the reported rule and explain the fix.`,
    `Action: ${failure.action}`,
    ...(failure.rule ? [`Rule or hook: ${failure.rule}`] : []),
    `Reason: ${failure.reason}`,
    ...(failure.output ? [`Output:\n${failure.output}`] : []),
  ].join('\n\n');
}
