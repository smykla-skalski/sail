import { progressiveSkillInstructions, type SkillChoice } from './skills';
import shipIt from '../../skills/ship-it/SKILL.md?raw';
import review from '../../skills/adversarial-review/SKILL.md?raw';
import manualTest from '../../skills/adversarial-test/SKILL.md?raw';

export const bundledSkills: SkillChoice[] = [
  {
    name: 'ship-it',
    description: 'Implement, review, test, and ship one change',
    instructions: progressiveSkillInstructions('ship-it', shipIt, [
      'inputs.md',
      'convergence.md',
      'fallbacks.md',
      'pr-loop.md',
    ]),
  },
  {
    name: 'adversarial-review',
    description: 'Review a change in two fresh opposed sessions',
    instructions: progressiveSkillInstructions('adversarial-review', review, [
      'code-adversary.md',
      'findings-adversary.md',
    ]),
  },
  {
    name: 'adversarial-test',
    description: 'Manually test a change in a fresh session',
    instructions: progressiveSkillInstructions('adversarial-test', manualTest, [
      'test-adversary.md',
    ]),
  },
];
