import type { SpawnReceipt } from './agent-results.ts';
import type { ActivityHistoryEvent } from './activity-history.ts';
import { activityState } from './activity-state.ts';
import type { PostTurnCheck } from './post-turn-checks.ts';

export type WorkspaceActivitySection = 'now' | 'needs-input' | 'recent';
export type WorkspaceActivityKind = 'tool' | 'child' | 'decision' | 'check';

export type WorkspaceActivityItem = {
  id: string;
  sourceId: string;
  kind: WorkspaceActivityKind;
  section: WorkspaceActivitySection;
  title: string;
  detail: string;
  status: string;
  updated: number;
};

export type WorkspaceToolActivity = {
  id: string;
  title: string;
  status: string;
  updated?: number;
};

export type WorkspaceDecisionActivity = {
  id: string;
  title: string;
  detail: string;
};

function normalizedStatus(status: string): string {
  return activityState(status).state;
}

function section(status: string): WorkspaceActivitySection {
  if (status === 'waiting' || status === 'failed') return 'needs-input';
  if (status === 'working' || status === 'queued' || status === 'starting') return 'now';
  return 'recent';
}

function childDetail(receipt: SpawnReceipt): string {
  if (!receipt.targetId || !receipt.targetDirectory) return 'Thread target not confirmed';
  if (receipt.activity) return receipt.activity;
  if (receipt.result) return 'Result preserved';
  if (receipt.error) return receipt.error;
  return receipt.state;
}

export function workspaceActivityItems(input: {
  tools?: WorkspaceToolActivity[];
  children?: SpawnReceipt[];
  decisions?: WorkspaceDecisionActivity[];
  checks?: PostTurnCheck[];
  recentLimit?: number;
}): WorkspaceActivityItem[] {
  const tools = (input.tools ?? []).map((tool, index): WorkspaceActivityItem => {
    const status = normalizedStatus(tool.status);
    return {
      id: `tool:${tool.id}`,
      sourceId: tool.id,
      kind: 'tool',
      section: section(status),
      title: tool.title,
      detail:
        status === 'working'
          ? 'Tool is running'
          : status === 'queued'
            ? 'Tool is queued'
            : `Tool ${status}`,
      status,
      updated: Number.isFinite(tool.updated) ? (tool.updated ?? 0) : index + 1,
    };
  });
  const children = (input.children ?? []).map((receipt): WorkspaceActivityItem => {
    const status = normalizedStatus(receipt.state);
    return {
      id: `child:${receipt.receiptId}`,
      sourceId: receipt.receiptId,
      kind: 'child',
      section: section(status),
      title: receipt.prompt ?? `${receipt.provider} subagent`,
      detail: childDetail(receipt),
      status,
      updated: Number.isFinite(receipt.updated) ? receipt.updated : 0,
    };
  });
  const decisions = (input.decisions ?? []).map((decision): WorkspaceActivityItem => ({
    id: `decision:${decision.id}`,
    sourceId: decision.id,
    kind: 'decision',
    section: 'needs-input',
    title: decision.title,
    detail: decision.detail,
    status: 'waiting',
    updated: Number.MAX_SAFE_INTEGER,
  }));
  const checks = (input.checks ?? []).map((check): WorkspaceActivityItem => {
    const status =
      check.status === 'running'
        ? 'working'
        : check.status === 'passed'
          ? 'completed'
          : check.status === 'canceled'
            ? 'interrupted'
            : 'failed';
    return {
      id: `check:${check.id}`,
      sourceId: check.id,
      kind: 'check',
      section: section(status),
      title: check.command,
      detail: `${check.source} check · ${check.status.replace('_', ' ')}`,
      status,
      updated: Number.isFinite(check.updated) ? check.updated : 0,
    };
  });
  const items = [...decisions, ...tools, ...children, ...checks].toSorted(
    (left, right) => right.updated - left.updated || left.title.localeCompare(right.title),
  );
  const recentLimit = Math.max(0, input.recentLimit ?? 12);
  let recent = 0;
  return items.filter((item) => item.section !== 'recent' || recent++ < recentLimit);
}

export function activitySectionItems(
  items: WorkspaceActivityItem[],
  selected: WorkspaceActivitySection,
): WorkspaceActivityItem[] {
  return items.filter((item) => item.section === selected);
}

export function activityHistoryWithoutLiveItems(
  items: WorkspaceActivityItem[],
  events: ActivityHistoryEvent[],
  agent?: string,
  sessionId?: string,
): ActivityHistoryEvent[] {
  const visible = new Set(
    items.map((item) =>
      item.kind === 'child'
        ? `subagent:${item.sourceId}`
        : `${item.kind}:${agent ?? ''}:${sessionId ?? ''}:${item.sourceId}`,
    ),
  );
  return events.filter(
    (event) =>
      !visible.has(
        event.kind === 'subagent'
          ? `subagent:${event.sourceId}`
          : `${event.kind}:${event.agent ?? ''}:${event.sessionId ?? ''}:${event.sourceId}`,
      ),
  );
}
