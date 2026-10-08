import assert from 'node:assert/strict';
import test from 'node:test';
import { copyCompletedSelection, resetAutoCopy } from '../src/lib/auto-copy.ts';

function environment(
  options: {
    text?: string;
    collapsed?: boolean;
    inInput?: boolean;
    clipboard?: boolean;
    clipboardFails?: boolean;
    now?: () => number;
  } = {},
) {
  const written: string[] = [];
  let execCopies = 0;
  const env = {
    readSelection: () =>
      options.collapsed
        ? null
        : { text: options.text ?? 'selected text', editable: options.inInput ?? false },
    writeText:
      options.clipboard === false
        ? undefined
        : async (text: string) => {
            if (options.clipboardFails) throw new Error('denied');
            written.push(text);
          },
    execCommandCopy: () => {
      execCopies++;
      return true;
    },
    now: options.now ?? (() => 0),
  };
  return { env, written, execCopies: () => execCopies };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

void test('select-to-copy off copies nothing and announces nothing', async () => {
  resetAutoCopy();
  const { env, written, execCopies } = environment();
  let announced = 0;
  copyCompletedSelection({ enabled: false, oncopied: () => announced++ }, env);
  await settle();
  assert.deepEqual(written, []);
  assert.equal(execCopies(), 0);
  assert.equal(announced, 0);
});

void test('select-to-copy on copies the selection and announces once it is written', async () => {
  resetAutoCopy();
  const { env, written } = environment({ text: 'hello world' });
  let announced = 0;
  copyCompletedSelection({ enabled: true, oncopied: () => announced++ }, env);
  assert.equal(announced, 0);
  await settle();
  assert.deepEqual(written, ['hello world']);
  assert.equal(announced, 1);
});

void test('a failed clipboard write does not announce', async () => {
  resetAutoCopy();
  const { env } = environment({ clipboardFails: true });
  let announced = 0;
  copyCompletedSelection({ enabled: true, oncopied: () => announced++ }, env);
  await settle();
  assert.equal(announced, 0);
});

for (const options of [{ collapsed: true }, { text: '   ' }, { inInput: true }]) {
  void test(`ignores the selection ${JSON.stringify(options)}`, async () => {
    resetAutoCopy();
    const { env, written } = environment(options);
    let announced = 0;
    copyCompletedSelection({ enabled: true, oncopied: () => announced++ }, env);
    await settle();
    assert.deepEqual(written, []);
    assert.equal(announced, 0);
  });
}

void test('pointer and key releases of one gesture copy and announce once', async () => {
  resetAutoCopy();
  let time = 1000;
  const { env, written } = environment({ now: () => time });
  let announced = 0;
  const options = { enabled: true, oncopied: () => announced++ };
  copyCompletedSelection(options, env);
  time += 50;
  copyCompletedSelection(options, env);
  await settle();
  assert.equal(written.length, 1);
  assert.equal(announced, 1);

  time += 5000;
  copyCompletedSelection(options, env);
  await settle();
  assert.equal(written.length, 2);
  assert.equal(announced, 2);
});

void test('falls back to the copy command when the async clipboard is missing', () => {
  resetAutoCopy();
  const { env, execCopies } = environment({ clipboard: false });
  let announced = 0;
  copyCompletedSelection({ enabled: true, oncopied: () => announced++ }, env);
  assert.equal(execCopies(), 1);
  assert.equal(announced, 1);
});
