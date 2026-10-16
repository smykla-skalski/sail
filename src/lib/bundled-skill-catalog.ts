import { progressiveSkillInstructions, type SkillChoice } from './skills.ts';

export const bundledSkillNames = ['ship-it', 'adversarial-review', 'adversarial-test'] as const;

export type BundledSkillName = (typeof bundledSkillNames)[number];

// Must match the include_str! lists in src-tauri/src/browser_agent.rs and the files under skills/.
export const bundledSkillReferences = {
  'ship-it': [
    'plugin.json',
    'authorization.md',
    'branch.md',
    'capabilities.json',
    'capabilities.md',
    'checkpoint.md',
    'ci-triage.md',
    'ci-triage.schema.json',
    'claims.md',
    'completion.md',
    'convergence-policy.json',
    'convergence.md',
    'evidence.md',
    'explore.md',
    'fallbacks.md',
    'handoff.md',
    'helper-loading.md',
    'implementation.md',
    'inputs.md',
    'orchestration.md',
    'pr-loop.md',
    'publish.md',
    'release-policy.json',
    'release.md',
    'replay-trace.schema.json',
    'replay.md',
    'review.md',
    'risk-policy.json',
    'risk.md',
    'roles.json',
    'roles.md',
    'sail.md',
    'scripts/bookkeeping.py',
    'scripts/checkpoint_state.py',
    'scripts/ci_triage.py',
    'scripts/convergence.py',
    'scripts/copilot_quota.py',
    'scripts/copilot_review.py',
    'scripts/delivery_benchmark.py',
    'scripts/handoff.py',
    'scripts/hosted_wait.py',
    'scripts/replay_failures.py',
    'scripts/telemetry.py',
    'scripts/test_copilot_quota.py',
    'scripts/test_copilot_review.py',
    'scripts/test_replay_failures.py',
    'scripts/test_telemetry.py',
    'scripts/token_cost.py',
    'scripts/validation_reuse.py',
    'small-code-policy.json',
    'telemetry-v1.schema.json',
    'telemetry-v2.schema.json',
    'telemetry-v3.schema.json',
    'telemetry.md',
    'telemetry.schema.json',
    'test.md',
    'validation-reuse.md',
    'worker-events.md',
    'worker-rules.md',
  ],
  'adversarial-review': ['code-adversary.md', 'findings-adversary.md', 'workflow.md'],
  'adversarial-test': ['test-adversary.md', 'workflow.md'],
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
