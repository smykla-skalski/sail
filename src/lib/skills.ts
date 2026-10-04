export interface SkillChoice {
  name: string;
  description: string;
  id?: string;
  instructions?: string;
}

export const sailGateRule =
  'Sail gate rule: run the Code Adversary, Findings Adversary, and Test Adversary in separate fresh subagent sessions, in order. If a fresh session cannot launch, pause shipping and report the failed gate and reason in this thread. Never run a gate inline. This overrides any inline fallback in an installed skill.';

export function mergeSkills(installed: SkillChoice[], bundled: SkillChoice[]): SkillChoice[] {
  const names = new Set(installed.map((skill) => skill.name.toLowerCase()));
  return [...installed, ...bundled.filter((skill) => !names.has(skill.name.toLowerCase()))];
}

export function resolveSkillPrompt(skills: SkillChoice[], text: string): string {
  const skill = promptSkill(skills, text);
  if (!skill) return text;
  const gate = ['ship-it', 'adversarial-review', 'adversarial-test'].includes(skill.name)
    ? `\n\n${sailGateRule}`
    : '';
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
  return skills.find((skill) => skill.name === name);
}
