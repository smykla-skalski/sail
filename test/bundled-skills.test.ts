import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { z } from 'zod';
import {
  bundledSkillChoices,
  bundledSkillCorePath,
  bundledSkillNames,
  bundledSkillReferences,
} from '../src/lib/bundled-skill-catalog.ts';
import { mergeSkills, resolveSkillPrompt } from '../src/lib/skills.ts';

const skillPath = (skill: string, path = '') =>
  new URL(`../skills/${skill}/${path}`, import.meta.url);
const read = (skill: string, path: string) => readFileSync(skillPath(skill, path), 'utf8');
const shipItCore = read('ship-it', 'SKILL.md');
const cores = Object.fromEntries(
  bundledSkillNames.map((name) => [bundledSkillCorePath(name), read(name, 'SKILL.md')]),
);
const bundled = bundledSkillChoices(cores);
const sailModeRule = (label: string) =>
  new RegExp(`\\*\\*${label}:\\*\\*.*$`, 'm').exec(shipItCore)?.[0] ?? '';
const quotedValues = (list: string) => [...list.matchAll(/"([^"]+)"/g)].map(([, value]) => value);

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

void test('Vite loads bundled-skills.ts with each skill on its own core', async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, watch: null, hmr: false },
  });
  try {
    const loaded = z
      .object({
        bundledSkills: z.array(z.object({ name: z.string(), instructions: z.string() })),
      })
      .parse(await server.ssrLoadModule('/src/lib/bundled-skills.ts'));
    assert.deepEqual(
      loaded.bundledSkills.map((skill) => skill.name),
      [...bundledSkillNames],
    );
    for (const skill of loaded.bundledSkills) {
      assert.ok(skill.instructions.startsWith(read(skill.name, 'SKILL.md')), skill.name);
      assert.match(skill.instructions, new RegExp(`Detailed ${skill.name} references`));
    }
  } finally {
    await server.close();
  }
  assert.throws(
    () => bundledSkillChoices({ ...cores, [bundledSkillCorePath('adversarial-test')]: undefined }),
    /bundled adversarial-test skill core is missing/,
  );
});

void test('the bundled ship-it records which upstream release it matches', () => {
  assert.match(
    shipItCore,
    /upstream: smykla-skalski\/sai plugins\/ship-it 1\.4\.33 with Sail mode/,
  );
});

void test('the bundled ship-it prompt carries Sail mode and the merge-owner rule', () => {
  const prompt = resolveSkillPrompt(mergeSkills([], bundled), '/ship-it https://x.test/o/r/1');
  assert.match(prompt, /Follow this bundled Sail skill/);
  assert.match(prompt, /^## Sail mode$/m);
  assert.match(prompt, /stages `implementing`, `reviewing`, `testing`, `pull_request`, `ci`/);
  assert.match(prompt, /`task_checkpoint_update`/);
  assert.match(prompt, /`task_evidence_record`/);
  assert.match(prompt, /`validation_gate`/);
  assert.match(prompt, /Available references: inputs\.md, .*scripts\/test_telemetry\.py\./);
  assert.match(prompt, /publish\.md/);
  assert.match(prompt, /scripts\/bookkeeping\.py/);
  assert.doesNotMatch(prompt, /# Durable ship-it checkpoint/);
  assert.match(shipItCore, /They extend the phases, hard stops and references\./);

  const owner = sailModeRule('Merge owner');
  assert.match(
    owner,
    /Repository instructions such as `AGENTS\.md`.*that state who merges take precedence over Sail's "You merge" rule in either direction/,
  );
  assert.match(owner, /structured release policy has no merge-owner field/);
  assert.match(owner, /says how to merge, not who merges/);
  assert.match(owner, /When the repository says nothing about who merges, Sail's prompt decides/);
  assert.match(owner, /without it you merge through the resolved release policy/);

  const handoff = sailModeRule('Merge handoff');
  assert.match(handoff, /stop at a mergeable pull request/);
  assert.match(handoff, /`git rev-parse HEAD` equals the PR `headRefOid`/);
  assert.match(
    handoff,
    /`task_checkpoint_read` reports `reconciliation\.revisionMatches` and `evidence\.readiness\.ready`/,
  );
  assert.match(handoff, /Do not post a merge comment or run a merge command/);
  assert.match(
    handoff,
    /Report `awaiting_merge` through `ship_progress` when its schema lists that value; otherwise Sail marks the open pull request as awaiting merge/,
  );
  assert.match(
    handoff,
    /delivery mismatch from `task_checkpoint_read` and a source issue closed by this pull request are the expected handoff, not stops/,
  );
  assert.match(handoff, /you acquired your own `claims\.md` claim and it has expired/i);
  assert.match(handoff, /terminal delivery takeover from `claims\.md`/);
  assert.match(handoff, /A claim Sail holds is never taken over or released by the worker/);

  const claims = sailModeRule('Claims');
  assert.match(claims, /Sail holds a visible claim with an exact claim ID for this task/);
  assert.match(claims, /do not renew, take over or release Sail's claim; Sail does/);
  assert.match(claims, /Without such a prompt, follow `claims\.md`/);
  assert.match(
    claims,
    /active, unexpired `sail-claim:v1` marker on the issue is a conflicting claim/,
  );

  const checkpoint = sailModeRule('Checkpoint');
  assert.match(checkpoint, /stop on a revision or delivery mismatch, except the merge handoff/);
  assert.match(checkpoint, /keeping the last phase before `complete`, with `status: blocked`/);
  const gateRouting = sailModeRule('Gate routing');
  assert.match(
    gateRouting,
    /`code-adversary\.md` and `findings-adversary\.md` from `adversarial-review`/,
  );
  assert.match(gateRouting, /apply only when Sail's gate rule requires a gate session/);
  assert.match(gateRouting, /CI triage uses a fresh native subagent/);
  assert.match(gateRouting, /`mechanism: inline` and `independence: not-applicable`/);
  const progress = sailModeRule('Progress');
  assert.match(progress, /NEEDS_FIXES, FAIL and CI fix rounds stay `running`/);
  assert.match(progress, /when the convergence budget stops the run, report `status: "blocked"`/);
  assert.match(shipItCore, /When they reject it because Sail does not track this thread/);
  assert.match(
    readFileSync(skillPath('sail', 'SKILL.md'), 'utf8'),
    /delivery-state mismatch, unless\s+the user merged a pull request you left mergeable for them/,
  );
});

void test('Sail mode names only Ship tool fields and values the tools accept', () => {
  const bridge = readFileSync(
    new URL('../src-tauri/src/browser_agent.rs', import.meta.url),
    'utf8',
  );
  const schema =
    /"stage":\{"type":"string","enum":\[([^\]]+)\]\},\s*"status":\{"type":"string","enum":\[([^\]]+)\]\}/.exec(
      bridge,
    );
  assert.ok(schema, 'ship_progress schema not found');
  assert.match(bridge, /"untestedCriteria":\{"type":"array"/);
  const evidenceFields = /"task_evidence_record",\s*"[^"]*",\s*"([^"]+)"/.exec(bridge);
  assert.ok(evidenceFields, 'task_evidence_record fields not found');
  const evidence = sailModeRule('Evidence');
  for (const field of evidenceFields[1].split(',').filter((name) => name.startsWith('expected')))
    assert.match(evidence, new RegExp(`\`${field}\``), field);
  assert.match(
    bridge,
    /"validation_policy",\s*"[^"]*",\s*"risk"/,
    'validation_policy tool missing',
  );
  const risk = sailModeRule('Risk and Sail gates');
  assert.match(risk, /call `validation_policy` with that level before validation/);
  assert.match(risk, /do not set `requiredGates` yourself/);
  const progress = sailModeRule('Progress');
  const stages = /using stages (.*?) and `([a-z_]+)`\./.exec(progress);
  assert.ok(stages, 'stage list not found');
  assert.deepEqual(
    [...[...stages[1].matchAll(/`([a-z_]+)`/g)].map(([, stage]) => stage), stages[2]],
    quotedValues(schema[1]).filter((stage) => stage !== 'awaiting_merge'),
  );
  assert.ok(quotedValues(schema[1]).includes('awaiting_merge'));
  for (const [, status] of progress.matchAll(/status: "([a-z_]+)"/g))
    assert.ok(quotedValues(schema[2]).includes(status), status);
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
