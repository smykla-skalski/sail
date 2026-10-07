import type { AgentTool } from './acp.ts';
import { klaudiushRules } from './klaudiush.ts';
import { toolCommand, toolInput } from './tool-display.ts';

export interface AcpToolFailure {
  kind: 'hook' | 'post-hook' | 'tool';
  event: string | null;
  action: string;
  rule: string | null;
  reason: string;
  output: string;
}

function field(value: unknown, names: string[], nestedNames = ['name']): string | null {
  if (!value || typeof value !== 'object') return null;
  for (const name of names) {
    const found: unknown = Reflect.get(value, name);
    if (typeof found === 'string' && found.trim()) return found.trim();
    if (found && typeof found === 'object') {
      for (const nestedName of nestedNames) {
        const nested: unknown = Reflect.get(found, nestedName);
        if (typeof nested === 'string' && nested.trim()) return nested.trim();
      }
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
  const hookPhase = field(raw, ['hookPhase', 'hook_phase', 'hookEvent', 'hook_event']);
  const postHook = /PostToolUse:\w+ says:/i.test(output) || /PostToolUse/i.test(hookPhase ?? '');
  const hookEvidence =
    /PreToolUse:\w+ says:|(?:blocked|denied|rejected|failed) by (?:a )?hook|hook (?:blocked|denied|rejected|failed)/i.test(
      output,
    );
  const kind = postHook
    ? 'post-hook'
    : rules.length || hookName || ruleName || hookEvidence
      ? 'hook'
      : 'tool';
  const rule = rules.length ? rules.map((item) => item.code).join(', ') : (ruleName ?? hookName);
  const reason = rules.length
    ? rules.map((item) => item.reason).join('; ')
    : (field(
        raw,
        ['reason', 'error', 'message', 'stderr', 'output', 'stdout'],
        ['reason', 'message', 'name'],
      ) ??
      [tool.content, typeof raw === 'string' ? raw : '']
        .filter(Boolean)
        .join('\n')
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) ??
      'The action failed without a reason from the agent.');
  return {
    kind,
    event: kind === 'tool' ? null : hookPhase,
    action: kind === 'tool' ? (toolCommand(tool.input) ?? tool.title) : tool.title,
    rule: kind === 'tool' ? null : rule,
    reason: reason.slice(0, 1000),
    output: output.slice(0, 4000),
  };
}

export function fixAcpToolFailurePrompt(failure: AcpToolFailure): string {
  const instruction =
    failure.kind === 'post-hook'
      ? 'Review the post-action hook failure below. Check the action result before retrying it, then address the hook failure.'
      : failure.kind === 'hook'
        ? 'Fix the hook-blocked action below. Follow the reported rule and explain the fix.'
        : 'Fix the failed tool action below. Use the failure details to diagnose it and explain the fix.';
  return [
    instruction,
    `Action: ${failure.action}`,
    ...(failure.rule ? [`Rule or hook: ${failure.rule}`] : []),
    `Reason: ${failure.reason}`,
    ...(failure.output ? [`Output:\n${failure.output}`] : []),
  ].join('\n\n');
}

export function prepareAcpFailureDraft(
  draft: string,
  prepared: Map<string, string>,
  toolId: string,
  failure: AcpToolFailure,
): string {
  const prompt = fixAcpToolFailurePrompt(failure);
  const previous = prepared.get(toolId);
  prepared.set(toolId, prompt);
  if (draft.includes(prompt)) return draft;
  if (previous && draft.includes(previous)) return draft.replace(previous, prompt);
  return draft.trim() ? `${draft}\n\n${prompt}` : prompt;
}
