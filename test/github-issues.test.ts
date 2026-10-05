import assert from 'node:assert/strict';
import test from 'node:test';
import { branchSlug, issueBranch, worktreeBranchName } from '../src/lib/github-issues.ts';

await test('free text becomes a valid 64-character branch name', () => {
  assert.equal(branchSlug('  Fix łódź / login: errors!  '), 'fix-lodz-login-errors');
  assert.equal(branchSlug('Straße æø'), 'strasse-aeo');
  assert.equal(branchSlug('修复'), 'u4fee-u590d');
  assert.equal(branchSlug('---'), '');
  assert.equal(branchSlug('A'.repeat(80)), 'a'.repeat(64));
});

await test('worktree names preserve valid branch spelling', () => {
  assert.equal(worktreeBranchName('  foo_bar  '), 'foo_bar');
  assert.equal(worktreeBranchName('FeatureABC'), 'FeatureABC');
  assert.equal(worktreeBranchName('HEAD'), 'head');
  assert.equal(worktreeBranchName('Fix login errors!'), 'fix-login-errors');
});

await test('issue branch keeps its number and a safe title slug', () => {
  assert.equal(
    issueBranch({ number: 80, title: 'Fix: agent / worktree!' }),
    'issue-80-fix-agent-worktree',
  );
  assert.equal(issueBranch({ number: 81, title: '  Żółć café  ' }), 'issue-81-zolc-cafe');
  assert.equal(issueBranch({ number: 82, title: '🚀 🎉' }), 'issue-82');
});

await test('issue branch fits the native 64-character limit', () => {
  const branch = issueBranch({ number: 123456789, title: 'word-'.repeat(30) });
  assert.equal(branch.length, 64);
  assert.match(branch, /^issue-123456789-[a-z0-9-]+[a-z0-9]$/);
});
