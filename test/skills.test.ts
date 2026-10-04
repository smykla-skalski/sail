import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchingSkills,
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
  assert.deepEqual(matchingSkills(skills, 'Please /ship'), []);
});

void test('a selected skill resolves from a prompt with arguments', () => {
  assert.equal(promptSkill(skills, '/ship-issue https://example.com')?.id, 'one');
  assert.equal(promptSkill(skills, '/ship-issue')?.id, 'one');
  assert.equal(promptSkill(skills, '/ship-issues'), undefined);
});

void test('bundled skills fill missing names without replacing installed skills', () => {
  const bundled = [
    { name: 'ship-issue', description: 'Bundled', instructions: 'Run the gate' },
    { name: 'adversarial-test', description: 'Manual test', instructions: 'Test now' },
  ];
  const merged = mergeSkills(skills, bundled);
  assert.deepEqual(merged, [...skills, bundled[1]]);
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
