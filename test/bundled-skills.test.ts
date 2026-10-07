import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  bundledSkillChoices,
  bundledSkillNames,
  bundledSkillReferences,
} from '../src/lib/bundled-skill-catalog.ts';
import { mergeSkills, resolveSkillPrompt } from '../src/lib/skills.ts';

const skillPath = (skill: string, path = '') =>
  new URL(`../skills/${skill}/${path}`, import.meta.url);
const read = (skill: string, path: string) => readFileSync(skillPath(skill, path), 'utf8');
const shipItCore = read('ship-it', 'SKILL.md');
const bundled = bundledSkillChoices({
  'ship-it': shipItCore,
  'adversarial-review': read('adversarial-review', 'SKILL.md'),
  'adversarial-test': read('adversarial-test', 'SKILL.md'),
});

function filesOnDisk(skill: string): string[] {
  return ['references', 'scripts'].flatMap((directory) => {
    const path = skillPath(skill, `${directory}/`);
    if (!existsSync(path)) return [];
    return readdirSync(path)
      .filter((name) => !name.startsWith('.'))
      .map((name) => (directory === 'scripts' ? `scripts/${name}` : name));
  });
}

function rustShipItReferences(): Array<[string, string]> {
  const source = readFileSync(
    new URL('../src-tauri/src/browser_agent.rs', import.meta.url),
    'utf8',
  );
  return [...source.matchAll(/\(\s*"([^"]+)",\s*ship_it_file!\("([^"]+)"\),?\s*\)/g)].map(
    (match) => [match[1], match[2]],
  );
}

void test('every embedded skill file is listed once for skill_reference', () => {
  for (const skill of bundledSkillNames) {
    const listed = [...bundledSkillReferences[skill]];
    assert.equal(new Set(listed).size, listed.length, `${skill} lists a reference twice`);
    assert.deepEqual(listed.toSorted(), filesOnDisk(skill).toSorted(), skill);
  }
});

void test('the Rust bridge embeds the same ship-it references under the same names', () => {
  const embedded = rustShipItReferences();
  assert.deepEqual(
    embedded.map(([name]) => name),
    [...bundledSkillReferences['ship-it']],
  );
  for (const [name, path] of embedded)
    assert.equal(path, name.startsWith('scripts/') ? name : `references/${name}`);
});

void test('every file the ship-it workflow links to is bundled', () => {
  const listed = new Set<string>(bundledSkillReferences['ship-it']);
  const documents = [
    ['SKILL.md', shipItCore],
    ...[...listed]
      .filter((name) => name.endsWith('.md'))
      .map((name) => [`references/${name}`, read('ship-it', `references/${name}`)]),
  ];
  for (const [document, text] of documents) {
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      assert.ok(listed.has(target.replace(/^references\//, '')), `${document} links ${target}`);
    }
    for (const [script] of text.matchAll(/scripts\/[\w-]+\.py/g))
      assert.ok(listed.has(script), `${document} runs ${script}`);
  }
});

void test('the bundled ship-it prompt carries Sail mode and the merge-owner rule', () => {
  const prompt = resolveSkillPrompt(mergeSkills([], bundled), '/ship-it https://x.test/o/r/1');
  assert.match(prompt, /Follow this bundled Sail skill/);
  assert.match(prompt, /^## Sail mode$/m);
  assert.match(prompt, /stages `implementing`, `reviewing`, `testing`, `pull_request`, `ci`/);
  assert.match(prompt, /`task_checkpoint_update`/);
  assert.match(prompt, /`task_evidence_record`/);
  assert.match(prompt, /`validation_gate`/);
  assert.match(prompt, /Available references: inputs\.md, .*scripts\/telemetry\.py\./);
  assert.doesNotMatch(prompt, /# Durable ship-it checkpoint/);

  const mergeOwner = /\*\*Merge owner:\*\*.*$/m.exec(shipItCore)?.[0] ?? '';
  assert.match(mergeOwner, /"You merge" rule/);
  assert.match(mergeOwner, /Stop at a mergeable pull request/);
  assert.match(mergeOwner, /do not post a merge comment or run a merge command/);
  assert.match(mergeOwner, /Report `awaiting_merge` through `ship_progress`/);
  assert.match(
    mergeOwner,
    /Repository instructions such as `AGENTS\.md`.*take precedence over this rule/,
  );
  assert.match(mergeOwner, /Without the rule, merge through the resolved release policy/);
  assert.match(mergeOwner, /delivery mismatch .* is the expected handoff, not a stop/);
  assert.match(mergeOwner, /terminal delivery takeover from `claims\.md`/);
  const checkpoint = /\*\*Checkpoint:\*\*.*$/m.exec(shipItCore)?.[0] ?? '';
  assert.match(
    checkpoint,
    /stop on a revision or delivery mismatch, except the merge-owner handoff/,
  );
  const gateRouting = /\*\*Gate routing:\*\*.*$/m.exec(shipItCore)?.[0] ?? '';
  assert.match(gateRouting, /CI triage uses a fresh native subagent/);
  assert.match(gateRouting, /`mechanism: inline` and `independence: not-applicable`/);
});

void test('an installed ship-it skill keeps Sail stage reporting without the bundled contract', () => {
  const installed = [{ id: 'native', name: 'ship-it', description: 'Installed' }];
  const merged = mergeSkills(installed, bundled);
  assert.equal(
    merged.find((skill) => skill.name === 'ship-it'),
    installed[0],
  );
  const prompt = resolveSkillPrompt(merged, '/ship-it #42');
  assert.match(prompt, /Sail progress reporting/);
  assert.match(prompt, /stages implementing, reviewing, testing, pull_request, ci, and merging/);
  assert.doesNotMatch(prompt, /Follow this bundled Sail skill/);
  assert.doesNotMatch(prompt, /## Sail mode/);
});
