export interface SkillChoice {
  name: string;
  description: string;
  id?: string;
  instructions?: string;
}

export const sailGateRules: Record<string, string> = {
  'ship-it':
    'Sail gate rule: run the Code Adversary, Findings Adversary, and Test Adversary in separate fresh subagent sessions, in order.',
  'adversarial-review':
    'Sail gate rule: run the Code Adversary and Findings Adversary in separate fresh subagent sessions, in order.',
  'adversarial-test': 'Sail gate rule: run the Test Adversary in a fresh subagent session.',
};

const failedGateRule =
  'If a required fresh session cannot launch, pause and report the failed gate and reason in this thread. Never run a gate inline. This overrides any inline fallback in an installed skill.';

export function mergeSkills(installed: SkillChoice[], bundled: SkillChoice[]): SkillChoice[] {
  const native = new Map(installed.map((skill) => [skill.name.toLowerCase(), skill]));
  const bundledNames = new Set(bundled.map((skill) => skill.name.toLowerCase()));
  return [
    ...bundled.map((skill) => native.get(skill.name.toLowerCase()) ?? skill),
    ...installed.filter((skill) => !bundledNames.has(skill.name.toLowerCase())),
  ];
}

export function resolveSkillPrompt(skills: SkillChoice[], text: string): string {
  const skill = promptSkill(skills, text);
  if (!skill) return text;
  const rule = sailGateRules[skill.name.toLowerCase()];
  const gate = rule ? `\n\n${rule} ${failedGateRule}` : '';
  return skill.instructions
    ? `${text}${gate}\n\nFollow this bundled Sail skill:\n\n${skill.instructions}`
    : `${text}${gate}`;
}

export function skillQuery(draft: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(draft);
  return match?.[1].toLowerCase() ?? null;
}

export function matchingSkills(skills: SkillChoice[], draft: string): SkillChoice[] {
  const query = skillQuery(draft);
  if (query === null) return [];
  return skills.filter((skill) => skill.name.toLowerCase().includes(query)).slice(0, 12);
}

export function promptSkill(skills: SkillChoice[], text: string): SkillChoice | undefined {
  const name = /^\/([^\s/]+)(?:\s|$)/.exec(text)?.[1];
  return skills.find((skill) => skill.name.toLowerCase() === name?.toLowerCase());
}
