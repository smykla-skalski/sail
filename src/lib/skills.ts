export interface SkillChoice {
  name: string;
  description: string;
  id?: string;
  instructions?: string;
}

export function progressiveSkillInstructions(
  name: string,
  core: string,
  references: string[],
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
    'Run the Code Adversary, Findings Adversary, and Test Adversary in this Ship It session with the implementation agent and model.',
  'adversarial-review':
    'Run the Code Adversary and Findings Adversary in this session with the implementation agent and model.',
  'adversarial-test':
    'Run the Test Adversary in this session with the implementation agent and model.',
};

const failedGateRule =
  'If a required fresh session cannot launch, pause and report the failed gate and reason in this thread. Never run a gate inline. This overrides any inline fallback in an installed skill.';

const shipProgressStageRule =
  'Sail progress reporting: call ship_progress with { stage, status: "running" } before implementing, reviewing, testing, opening the pull request, waiting on CI, and merging. Use stages implementing, reviewing, testing, pull_request, ci, and merging respectively. When work cannot continue, call ship_progress with { stage, status: "blocked", reason } before explaining the blocker.';

const shipProgressInlineVerdictRule =
  'After each completed Code Adversary, Findings Adversary, or Test Adversary pass, call ship_progress with { gate, verdict, reason? } using gates code-adversary, findings-adversary, or test-adversary and the actual verdict.';

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
      : { choices: [], strictDifferentModel: false };
  const policy =
    rule && typeof localStorage !== 'undefined'
      ? `\n\n${validationInstructions(settings, currentModel)}`
      : '';
  const gate = rule
    ? settings.choices.length || settings.strictDifferentModel
      ? `\n\n${rule} ${failedGateRule}${policy}`
      : `\n\nSail default gate rule: ${defaultGateRules[skill.name.toLowerCase()]} Do not call validation_gate or require agent coordination.${policy}`
    : '';
  const reporting =
    skill.name.toLowerCase() === 'ship-it'
      ? `\n\n${shipProgressStageRule}${
          settings.choices.length || settings.strictDifferentModel
            ? ''
            : ` ${shipProgressInlineVerdictRule}`
        }`
      : '';
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
