import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { checkBundledSkills } from '../scripts/check-bundled-skills.mjs';

void test('the complete bundle matches its immutable upstream pin', async () => {
  await checkBundledSkills();
  const pin = JSON.parse(
    await readFile(new URL('../skills/sai-pin.json', import.meta.url), 'utf8'),
  );
  assert.match(pin.revision, /^[a-f0-9]{40}$/);
  assert.deepEqual(Object.keys(pin.skills).toSorted(), [
    'adversarial-review',
    'adversarial-test',
    'ship-it',
  ]);
});

for (const change of ['modified', 'missing', 'extra', 'metadata'] as const) {
  void test(`bundle drift check rejects a ${change} file`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sail-skill-pin-'));
    try {
      await cp(new URL('../skills', import.meta.url), join(root, 'skills'), { recursive: true });
      await cp(new URL('../plugin.json', import.meta.url), join(root, 'plugin.json'));
      const core = join(root, 'skills/ship-it/SKILL.md');
      if (change === 'metadata') await writeFile(join(root, 'plugin.json'), '{}');
      else if (change === 'modified') await writeFile(core, 'locally edited');
      else if (change === 'missing') await unlink(core);
      else await writeFile(join(root, 'skills/ship-it/extra.md'), 'untracked rule');
      await assert.rejects(checkBundledSkills(root), /Bundled sai .* (?:drifted|differs)/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
