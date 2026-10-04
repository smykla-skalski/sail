export interface SkillChoice {
  name: string;
  description: string;
  id?: string;
  instructions?: string;
}

export function mergeSkills(installed: SkillChoice[], bundled: SkillChoice[]): SkillChoice[] {
  const names = new Set(installed.map((skill) => skill.name.toLowerCase()));
  return [...installed, ...bundled.filter((skill) => !names.has(skill.name.toLowerCase()))];
}

export function resolveSkillPrompt(skills: SkillChoice[], text: string): string {
  const skill = promptSkill(skills, text);
  if (!skill?.instructions) return text;
  return `${text}\n\nFollow this bundled Sail skill:\n\n${skill.instructions}`;
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
