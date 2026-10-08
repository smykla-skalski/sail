import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  matchingSkills,
  insertSkill,
  mergeSkills,
  promptSkill,
  progressiveSkillInstructions,
  resolveSkillPrompt,
  skillQuery,
} from '../src/lib/skills.ts';
import { validationSettingsKey } from '../src/lib/cross-validation.ts';
import { slashCommands } from '../src/lib/slash-commands.ts';

const shipItCore = readFileSync(new URL('../skills/ship-it/SKILL.md', import.meta.url), 'utf8');
const convergence = readFileSync(
  new URL('../skills/ship-it/references/convergence.md', import.meta.url),
  'utf8',
);
const convergencePolicy = JSON.parse(
  readFileSync(
    new URL('../skills/ship-it/references/convergence-policy.json', import.meta.url),
    'utf8',
  ),
);
const prLoop = readFileSync(
  new URL('../skills/ship-it/references/pr-loop.md', import.meta.url),
  'utf8',
);
const shipItOpenAi = readFileSync(
  new URL('../skills/ship-it/agents/openai.yaml', import.meta.url),
  'utf8',
);

const skills = [
  { id: 'one', name: 'ship-issue', description: 'Ship a GitHub issue' },
  { id: 'two', name: 'review', description: 'Review code' },
];

void test('progressive skills keep references discoverable without injecting their bodies', () => {
  const instructions = progressiveSkillInstructions('ship-it', 'compact core', [
    'inputs.md',
    'pr-loop.md',
  ]);
  assert.match(instructions, /^compact core/);
  assert.match(instructions, /inputs\.md, pr-loop\.md/);
  assert.match(instructions, /skill_reference/);
  assert.match(instructions, /SHA-256/);
  assert.doesNotMatch(instructions, /reference body/);
});

void test('ship-it uses one bounded convergence contract across delivery phases', () => {
  assert.match(
    shipItCore,
    /Before validation, read \[references\/convergence\.md\]\(references\/convergence\.md\) and \[references\/convergence-policy\.json\]/,
  );
  assert.match(shipItCore, /validation exceeds the convergence budget/);
  assert.match(prLoop, /consumes its remaining fix\/cycle budget/);
  assert.match(prLoop, /Never reset its counters for CI or hosted feedback/);

  const bounded = convergencePolicy.modes.bounded;
  assert.equal(convergencePolicy.default_mode, 'bounded');
  assert.equal(bounded.max_elapsed_minutes, 90);
  assert.deepEqual(
    [bounded.review.code_adversary_passes, bounded.review.findings_challenge_passes],
    [1, 1],
  );
  assert.equal(bounded.review.max_cycles, 2);
  assert.equal(bounded.fixes.max_passes, 1);
  assert.equal(bounded.full_quality_gate_runs, 1);
  assert.deepEqual(bounded.review.rereview_triggers, [
    'security',
    'data-loss',
    'destructive-concurrency',
    'unresolved-acceptance',
  ]);
  assert.equal(bounded.later_non_blocking_findings, 'follow-up-issue');

  assert.match(
    convergence,
    /one Code Adversary pass followed by one independent Findings challenge/,
  );
  assert.match(convergence, /at most one fix pass/);
  assert.match(
    convergence,
    /complete local quality gate once against the final candidate revision/,
  );
  assert.match(convergence, /a second review cycle or 90 elapsed minutes would be exceeded/);
  assert.match(convergence, /convert later non-blocking findings into follow-up issues/);
  assert.match(convergence, /repository-required check, mandatory human approval/);
});

void test('exhaustive review is explicit and Copilot is never a delivery gate', () => {
  assert.equal(convergencePolicy.modes.exhaustive.activation, 'explicit-user-request');
  assert.match(
    convergence,
    /only when the user's current request explicitly asks for exhaustive review/,
  );
  assert.match(convergence, /never bypasses repository checks/);
  assert.match(convergence, /Never wait for Copilot/);
  assert.equal(convergencePolicy.copilot.wait, false);
  assert.doesNotMatch(shipItCore, /CI or Copilot is pending/);
  assert.doesNotMatch(shipItOpenAi, /Copilot review/);
});

void test('slash matches names and closes after arguments begin', () => {
  assert.equal(skillQuery('/'), '');
  assert.deepEqual(matchingSkills(skills, '/SHIP'), [skills[0]]);
  assert.deepEqual(matchingSkills(skills, '/ship-issue '), []);
  assert.deepEqual(matchingSkills(skills, 'Please /ship'), [skills[0]]);
  assert.equal(insertSkill('Please /ship', skills[0]), 'Please /ship-issue ');
});

void test('a selected skill resolves from a prompt with arguments', () => {
  assert.equal(promptSkill(skills, '/ship-issue https://example.com')?.id, 'one');
  assert.equal(promptSkill(skills, '/ship-issue')?.id, 'one');
  assert.equal(promptSkill(skills, '/SHIP-ISSUE #42')?.id, 'one');
  assert.equal(promptSkill(skills, '/ship-issues'), undefined);
  assert.equal(promptSkill(skills, 'Please /review this')?.id, 'two');
  assert.equal(promptSkill(skills, '/review then /ship-issue')?.id, 'two');
  assert.equal(promptSkill(skills, 'What does `/review` do?'), undefined);
  assert.equal(promptSkill(skills, 'What does `/review\\` do?'), undefined);
  assert.equal(promptSkill(skills, '\\\\` /review `'), undefined);
  assert.equal(promptSkill(skills, '\\` /review')?.id, 'two');
  assert.equal(promptSkill(skills, 'Explain this:\n```\n/review\n```'), undefined);
  assert.equal(
    promptSkill(skills, 'Explain this:\n```\n/review\n```\nThen /ship-issue')?.id,
    'one',
  );
  assert.equal(promptSkill(skills, 'A stray ` mark\nPlease /review')?.id, 'two');
  assert.equal(promptSkill(skills, 'Example:\n    /review'), undefined);
  assert.equal(promptSkill(skills, 'Example:\n```\n/review\n```js\n/review\n```'), undefined);
  assert.equal(promptSkill(skills, 'Example:\n> /review'), undefined);
  assert.equal(promptSkill(skills, '> Example\n/review'), undefined);
  assert.equal(promptSkill(skills, '> Example\n\n/review')?.id, 'two');
});

void test('nested list fences hide code until a valid indented closing fence', () => {
  const prompt = [
    '- Outer item',
    '  - ```text',
    '    /review',
    '    - ```',
    '    /review',
    '    ```js',
    '    /review',
    '    ```   ',
    '  /ship-issue #42',
  ].join('\n');
  assert.deepEqual(
    slashCommands(prompt).map((command) => command.name),
    ['ship-issue'],
  );
  assert.equal(promptSkill(skills, prompt)?.id, 'one');

  const continuation = '- Item\n  ```\n  /review\n  ```\n/review';
  assert.deepEqual(
    slashCommands(continuation).map((command) => command.name),
    ['review'],
  );

  const deepList = '- Outer\n    - ```\n      /review\n      ```\n      /ship-issue';
  assert.deepEqual(
    slashCommands(deepList).map((command) => command.name),
    ['ship-issue'],
  );

  const outdented = '- Item\n  ```\n  /review\n/review';
  assert.deepEqual(
    slashCommands(outdented).map((command) => command.name),
    ['review'],
  );
});

void test('bundled skills fill missing names without replacing installed skills', () => {
  const bundled = [
    { name: 'ship-issue', description: 'Bundled', instructions: 'Run the gate' },
    { name: 'adversarial-test', description: 'Manual test', instructions: 'Test now' },
  ];
  const merged = mergeSkills(skills, bundled);
  assert.deepEqual(merged, [skills[0], bundled[1], skills[1]]);
  assert.equal(resolveSkillPrompt(merged, '/ship-issue #42'), '/ship-issue #42');
  assert.match(resolveSkillPrompt(merged, '/adversarial-test --base main'), /Test now/);
  assert.equal(resolveSkillPrompt(merged, '/unknown'), '/unknown');
});

void test('an installed shipping skill defaults gates to the implementation session', () => {
  const installed = [{ id: 'old', name: 'ship-it', description: 'Installed' }];
  const merged = mergeSkills(installed, [
    { name: 'ship-it', description: 'Bundled', instructions: 'Bundle content' },
  ]);
  assert.deepEqual(merged, installed);
  const prompt = resolveSkillPrompt(merged, '/ship-it #42');
  assert.match(prompt, /Sail default gate rule/);
  assert.match(prompt, /Do not call validation_gate/);
  assert.match(prompt, /Sail progress reporting/);
  assert.match(prompt, /stage, status: "running"/);
  assert.match(prompt, /stages implementing, reviewing, testing, pull_request, ci, and merging/);
  assert.match(prompt, /After each completed Code Adversary/);
  assert.match(prompt, /gate, verdict, reason/);
});

void test('bundled choices stay visible with many installed skills and mixed case', () => {
  const installed = [
    { id: 'old', name: 'Ship-It', description: 'Installed' },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: String(index),
      name: `skill-${index}`,
      description: '',
    })),
  ];
  const bundled = [
    { name: 'ship-it', description: 'Bundled', instructions: 'Bundle content' },
    { name: 'adversarial-review', description: 'Bundled', instructions: 'Review content' },
    { name: 'adversarial-test', description: 'Bundled', instructions: 'Test content' },
  ];
  const merged = mergeSkills(installed, bundled);
  assert.deepEqual(
    matchingSkills(merged, '/')
      .slice(0, 3)
      .map((skill) => skill.name),
    ['Ship-It', 'adversarial-review', 'adversarial-test'],
  );
  assert.equal(matchingSkills(merged, '/').length, 15);
  assert.equal(matchingSkills(merged, '/').at(-1)?.name, 'skill-11');
  assert.match(resolveSkillPrompt(merged, '/Ship-It #42'), /Sail default gate rule/);
  assert.match(resolveSkillPrompt(merged, '/SHIP-IT #42'), /Sail default gate rule/);
});

void test('a configured validation pool retains fresh session gates', () => {
  const original = globalThis.localStorage;
  const values = new Map([
    [
      validationSettingsKey,
      JSON.stringify({
        choices: [{ agent: 'codex', model: 'gpt-5.6-luna' }],
        strictDifferentModel: false,
      }),
    ],
  ]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null },
  });
  try {
    const installed = [{ id: 'old', name: 'ship-it', description: 'Installed' }];
    const prompt = resolveSkillPrompt(installed, '/ship-it #42');
    assert.match(prompt, /Never run a gate inline/);
    assert.doesNotMatch(prompt, /After each completed Code Adversary/);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
  }
});

void test('standalone gates require only their own fresh sessions', () => {
  const installed = [
    { id: 'review', name: 'adversarial-review', description: '' },
    { id: 'test', name: 'adversarial-test', description: '' },
  ];
  const review = resolveSkillPrompt(installed, '/adversarial-review');
  const manualTest = resolveSkillPrompt(installed, '/adversarial-test');
  assert.match(review, /Code Adversary and Findings Adversary/);
  assert.doesNotMatch(review, /Test Adversary/);
  assert.match(manualTest, /Test Adversary/);
  assert.doesNotMatch(manualTest, /Code Adversary/);
});
