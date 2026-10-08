import { bundledSkillChoices } from './bundled-skill-catalog';

export const bundledSkills = bundledSkillChoices(
  import.meta.glob<string>(
    [
      '../../skills/ship-it/SKILL.md',
      '../../skills/adversarial-review/SKILL.md',
      '../../skills/adversarial-test/SKILL.md',
    ],
    { query: '?raw', import: 'default', eager: true },
  ),
);
