import { progressiveSkillInstructions, type SkillChoice } from './skills.ts';

export const bundledSkillNames = ['ship-it', 'adversarial-review', 'adversarial-test'] as const;

export type BundledSkillName = (typeof bundledSkillNames)[number];

// Must match the include_str! lists in src-tauri/src/browser_agent.rs and the files under skills/.
export const bundledSkillReferences = {
  'ship-it': [
    'inputs.md',
    'explore.md',
    'branch.md',
    'implementation.md',
    'review.md',
    'test.md',
    'pr-loop.md',
    'completion.md',
    'orchestration.md',
    'capabilities.md',
    'capabilities.json',
    'roles.md',
    'roles.json',
    'checkpoint.md',
    'claims.md',
    'telemetry.md',
    'telemetry.schema.json',
    'telemetry-v1.schema.json',
    'evidence.md',
    'risk.md',
    'risk-policy.json',
    'release.md',
    'release-policy.json',
    'convergence.md',
    'convergence-policy.json',
    'ci-triage.md',
    'ci-triage.schema.json',
    'fallbacks.md',
    'scripts/ci_triage.py',
    'scripts/telemetry.py',
  ],
  'adversarial-review': ['code-adversary.md', 'findings-adversary.md'],
  'adversarial-test': ['test-adversary.md'],
} as const satisfies Record<BundledSkillName, readonly string[]>;

const descriptions: Record<BundledSkillName, string> = {
  'ship-it': 'Ship a change or coordinate an approved plan',
  'adversarial-review': 'Review a change in two fresh opposed sessions',
  'adversarial-test': 'Manually test a change in a fresh session',
};

export function bundledSkillCorePath(name: BundledSkillName): string {
  return `../../skills/${name}/SKILL.md`;
}

export function bundledSkillChoices(cores: Partial<Record<string, string>>): SkillChoice[] {
  return bundledSkillNames.map((name) => {
    const core = cores[bundledSkillCorePath(name)];
    if (core === undefined) throw new Error(`The bundled ${name} skill core is missing.`);
    return {
      name,
      description: descriptions[name],
      instructions: progressiveSkillInstructions(name, core, bundledSkillReferences[name]),
    };
  });
}
