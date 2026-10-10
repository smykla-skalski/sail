import type { AgentAvailability } from './acp';
import type { ValidationSettings } from './cross-validation';
import type { ModelRoutingSettings } from './model-routing';
import type { MergeOwner } from './issue-shipping';
import type { ShipArchiveDelay } from './ship-archive';
import type { ThemePreference } from './theme';
import type { ResourceKind } from './resource-limits';
import type {
  NotificationPreference,
  NotificationPrefs,
  NotificationType,
} from './notification-prefs';

export const settingsRequest = 'sail:settings-request';
export const settingsState = 'sail:settings-state';
export const settingsAction = 'sail:settings-action';

export type SettingsSnapshot = {
  theme: ThemePreference;
  binaryPath: string;
  directory: string;
  agents: AgentAvailability[];
  agentsError: string;
  crossValidation: ValidationSettings;
  modelRouting: ModelRoutingSettings;
  notificationPrefs: NotificationPrefs;
  notificationSound: boolean;
  autoCopyEnabled: boolean;
  personalPostTurnChecks: string[];
  agentWorktreesEnabled: boolean;
  agentTerminalsEnabled: boolean;
  agentStatusEnabled: boolean;
  agentThreadListEnabled: boolean;
  agentMessagesEnabled: boolean;
  mergeOwner: MergeOwner;
  shipArchiveDelay: ShipArchiveDelay;
  contextHandoffThreshold: number;
  resourceLimits: Record<ResourceKind | 'e2e', number>;
};

export type SettingsAction =
  | { type: 'theme'; value: ThemePreference }
  | { type: 'binary'; value: string }
  | { type: 'notification-pref'; notification: NotificationType; value: NotificationPreference }
  | { type: 'notification-sound'; value: boolean }
  | { type: 'auto-copy'; value: boolean }
  | { type: 'personal-post-turn-checks'; value: string[] }
  | { type: 'agent-worktrees'; value: boolean }
  | { type: 'agent-terminals'; value: boolean }
  | { type: 'agent-status'; value: boolean }
  | { type: 'agent-thread-list'; value: boolean }
  | { type: 'agent-messages'; value: boolean }
  | { type: 'merge-owner'; value: MergeOwner }
  | { type: 'ship-archive-delay'; value: ShipArchiveDelay }
  | { type: 'context-handoff-threshold'; value: number }
  | { type: 'resource-limit'; kind: ResourceKind | 'e2e'; value: number }
  | { type: 'detect-agents' }
  | { type: 'cross-validation'; value: ValidationSettings }
  | { type: 'model-routing'; value: ModelRoutingSettings };
