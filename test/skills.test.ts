import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchingSkills,
  insertSkill,
  mergeSkills,
  promptSkill,
  resolveSkillPrompt,
  skillQuery,
} from '../src/lib/skills.ts';

const skills = [
  { id: 'one', name: 'ship-issue', description: 'Ship a GitHub issue' },
  { id: 'two', name: 'review', description: 'Review code' },
];

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

void test('an installed shipping skill still receives the fresh session gate', () => {
  const installed = [{ id: 'old', name: 'ship-it', description: 'Installed' }];
  const merged = mergeSkills(installed, [
    { name: 'ship-it', description: 'Bundled', instructions: 'Bundle content' },
  ]);
  assert.deepEqual(merged, installed);
  assert.match(resolveSkillPrompt(merged, '/ship-it #42'), /Never run a gate inline/);
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
  assert.match(resolveSkillPrompt(merged, '/Ship-It #42'), /Never run a gate inline/);
  assert.match(resolveSkillPrompt(merged, '/SHIP-IT #42'), /Never run a gate inline/);
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
