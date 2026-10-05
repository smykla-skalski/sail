import type { SkillChoice } from './skills';
import shipIt from '../../skills/ship-it/SKILL.md?raw';
import shipInputs from '../../skills/ship-it/references/inputs.md?raw';
import shipFallbacks from '../../skills/ship-it/references/fallbacks.md?raw';
import shipPrLoop from '../../skills/ship-it/references/pr-loop.md?raw';
import review from '../../skills/adversarial-review/SKILL.md?raw';
import codeAdversary from '../../skills/adversarial-review/references/code-adversary.md?raw';
import findingsAdversary from '../../skills/adversarial-review/references/findings-adversary.md?raw';
import manualTest from '../../skills/adversarial-test/SKILL.md?raw';
import testAdversary from '../../skills/adversarial-test/references/test-adversary.md?raw';

export const bundledSkills: SkillChoice[] = [
  {
    name: 'ship-it',
    description: 'Implement, review, test, and ship one change',
    instructions: [
      shipIt,
      'Reference: inputs.md',
      shipInputs,
      'Reference: fallbacks.md',
      shipFallbacks,
      'Reference: pr-loop.md',
      shipPrLoop,
    ].join('\n\n'),
  },
  {
    name: 'adversarial-review',
    description: 'Review a change in two fresh opposed sessions',
    instructions: [
      review,
      'Code Adversary mandate:',
      codeAdversary,
      'Findings Adversary mandate:',
      findingsAdversary,
    ].join('\n\n'),
  },
  {
    name: 'adversarial-test',
    description: 'Manually test a change in a fresh session',
    instructions: [manualTest, 'Test Adversary mandate:', testAdversary].join('\n\n'),
  },
];
