import type { AgentAvailability } from './acp';
import type { SetupReport } from './onboarding';
import type { ValidationSettings } from './cross-validation';

export const settingsRequest = 'sail:settings-request';
export const settingsState = 'sail:settings-state';
export const settingsAction = 'sail:settings-action';

export type SettingsSnapshot = {
  theme: 'light' | 'dark';
  binaryPath: string;
  activeBinary: string;
  runtimeState: 'starting' | 'connected' | 'error';
  runtimeError: string;
  directory: string;
  setup: SetupReport | null;
  setupLoading: boolean;
  setupError: string;
  busy: boolean;
  agents: AgentAvailability[];
  agentsError: string;
  crossValidation: ValidationSettings;
  notificationsEnabled: boolean;
  notificationSound: boolean;
  personalPostTurnChecks: string[];
  agentWorktreesEnabled: boolean;
  agentTerminalsEnabled: boolean;
  agentStatusEnabled: boolean;
  agentThreadListEnabled: boolean;
  agentMessagesEnabled: boolean;
  contextHandoffThreshold: number;
};

export type SettingsAction =
  | { type: 'theme'; value: 'light' | 'dark' }
  | { type: 'binary'; value: string }
  | { type: 'notifications'; value: boolean }
  | { type: 'notification-sound'; value: boolean }
  | { type: 'personal-post-turn-checks'; value: string[] }
  | { type: 'agent-worktrees'; value: boolean }
  | { type: 'agent-terminals'; value: boolean }
  | { type: 'agent-status'; value: boolean }
  | { type: 'agent-thread-list'; value: boolean }
  | { type: 'agent-messages'; value: boolean }
  | { type: 'context-handoff-threshold'; value: number }
  | { type: 'detect-agents' }
  | { type: 'cross-validation'; value: ValidationSettings }
  | { type: 'restart-setup' };
