import process from 'node:process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function checkBundledSkills(root = fileURLToPath(new URL('..', import.meta.url))) {
  const pin = JSON.parse(await readFile(resolve(root, 'skills/sai-pin.json'), 'utf8'));
  /** @type {string[]} */
  const actual = Object.keys(pin.metadata);
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) {
          if (basename(dirname(path)) !== '__pycache__' || !entry.name.endsWith('.pyc'))
            actual.push(relative(root, path).replaceAll('\\', '/'));
        } else throw new Error(`Unsupported bundled skill entry: ${path}`);
      }),
    );
  }
  await Promise.all(Object.keys(pin.skills).map((name) => visit(resolve(root, 'skills', name))));
  const expected = Object.keys(pin.files).toSorted();
  if (JSON.stringify(actual.toSorted()) !== JSON.stringify(expected))
    throw new Error('Bundled sai file list differs from skills/sai-pin.json');
  await Promise.all(
    expected.map(async (path) => {
      const digest = createHash('sha256')
        .update(await readFile(resolve(root, path)))
        .digest('hex');
      if (digest !== pin.files[path]) throw new Error(`Bundled sai file drifted: ${path}`);
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkBundledSkills();
}
