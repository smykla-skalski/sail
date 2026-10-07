import { bundledSkillChoices } from './bundled-skill-catalog';
import shipIt from '../../skills/ship-it/SKILL.md?raw';
import review from '../../skills/adversarial-review/SKILL.md?raw';
import manualTest from '../../skills/adversarial-test/SKILL.md?raw';

export const bundledSkills = bundledSkillChoices({
  'ship-it': shipIt,
  'adversarial-review': review,
  'adversarial-test': manualTest,
});
