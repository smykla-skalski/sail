export interface SkillChoice {
  name: string;
  description: string;
  id?: string;
  instructions?: string;
}

export function progressiveSkillInstructions(
  name: string,
  core: string,
  references: readonly string[],
): string {
  return [
    core,
    '## Sail references',
    `Detailed ${name} references are bundled offline but omitted from this prompt.`,
    `Available references: ${references.join(', ')}.`,
    'Load a reference only when the core workflow calls for it with the Sail MCP `skill_reference` tool.',
    'The tool response identifies the exact bundled content by SHA-256, and the tool call remains visible in the task transcript.',
  ].join('\n\n');
}
import { getSetting } from './settings.ts';
import { slashCommands, visibleCommandText } from './slash-commands.ts';
import {
  parseValidationSettings,
  validationInstructions,
  validationSettingsKey,
} from './cross-validation.ts';

export const sailGateRules: Record<string, string> = {
  'ship-it':
    'Sail gate rule: run the Code Adversary, Findings Adversary, and Test Adversary in separate fresh subagent sessions, in order.',
  'adversarial-review':
    'Sail gate rule: run the Code Adversary and Findings Adversary in separate fresh subagent sessions, in order.',
  'adversarial-test': 'Sail gate rule: run the Test Adversary in a fresh subagent session.',
};

const defaultGateRules: Record<string, string> = {
  'ship-it':
    'Run the Code Adversary, Findings Adversary, and Test Adversary through validation_gate, each in its own fresh subagent session.',
  'adversarial-review':
    'Run the Code Adversary and Findings Adversary through validation_gate in separate fresh subagent sessions.',
  'adversarial-test': 'Run the Test Adversary through validation_gate in a fresh subagent session.',
};

const failedGateRule =
  'If a required fresh session cannot launch, pause and report the failed gate and reason in this thread. Never run a gate inline. This overrides any inline fallback in an installed skill.';

const shipProgressStageRule =
  'Sail progress reporting: call ship_progress with { stage, status: "running" } before implementing, reviewing, testing, opening the pull request, waiting on CI, and merging. Use stages implementing, reviewing, testing, pull_request, ci, and merging respectively. When the user merges and the pull request is mergeable, call ship_progress with { stage: "awaiting_merge", status: "running" } and stop. When work cannot continue, call ship_progress with { stage, status: "blocked", reason } before explaining the blocker.';

export function mergeSkills(installed: SkillChoice[], bundled: SkillChoice[]): SkillChoice[] {
  const native = new Map(installed.map((skill) => [skill.name.toLowerCase(), skill]));
  const bundledNames = new Set(bundled.map((skill) => skill.name.toLowerCase()));
  return [
    ...bundled.map((skill) => native.get(skill.name.toLowerCase()) ?? skill),
    ...installed.filter((skill) => !bundledNames.has(skill.name.toLowerCase())),
  ];
}

export function resolveSkillPrompt(
  skills: SkillChoice[],
  text: string,
  currentModel?: string,
): string {
  const skill = promptSkill(skills, text);
  if (!skill) return text;
  const rule = sailGateRules[skill.name.toLowerCase()];
  const settings =
    typeof localStorage !== 'undefined'
      ? parseValidationSettings(getSetting(validationSettingsKey))
      : { choices: [] };
  const policy =
    rule && typeof localStorage !== 'undefined'
      ? `\n\n${validationInstructions(settings, currentModel)}`
      : '';
  const gate = rule
    ? `\n\nSail gate rule: ${defaultGateRules[skill.name.toLowerCase()]} ${failedGateRule}${policy}`
    : '';
  const reporting = skill.name.toLowerCase() === 'ship-it' ? `\n\n${shipProgressStageRule}` : '';
  return skill.instructions
    ? `${text}${gate}${reporting}\n\nFollow this bundled Sail skill:\n\n${skill.instructions}`
    : `${text}${gate}${reporting}`;
}

export function skillQuery(draft: string): string | null {
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(visibleCommandText(draft));
  return match?.[1].toLowerCase() ?? null;
}

export function insertSkill(draft: string, skill: SkillChoice): string {
  return draft.replace(/(?:^|(?<=\s))\/[^\s/]*$/, `/${skill.name} `);
}

export function matchingSkills(skills: SkillChoice[], draft: string): SkillChoice[] {
  const query = skillQuery(draft);
  if (query === null) return [];
  const matches = skills.filter((skill) => skill.name.toLowerCase().includes(query));
  const gateCount = matches.filter((skill) => sailGateRules[skill.name.toLowerCase()]).length;
  return matches.slice(0, 12 + gateCount);
}

export function promptSkill(skills: SkillChoice[], text: string): SkillChoice | undefined {
  for (const command of slashCommands(text)) {
    const skill = skills.find((item) => item.name.toLowerCase() === command.name.toLowerCase());
    if (skill) return skill;
  }
  return undefined;
}
