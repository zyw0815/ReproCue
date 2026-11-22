import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verdict } from '../src/verify.mjs';

const cli = fileURLToPath(new URL('../bin/reprocue.mjs', import.meta.url));

function repository(t) {
  const cwd = mkdtempSync(join(realpathSync(tmpdir()), 'reprocue-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  git('init', '--quiet');
  git('config', 'user.name', 'ReproCue fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('commit', '--quiet', '--allow-empty', '-m', 'Baseline');
  writeFileSync(join(cwd, 'tracked.txt'), 'Proposed patch');
  git('add', 'tracked.txt');
  git('commit', '--quiet', '-m', 'Patch');
  return { cwd, git };
}

function verify(cwd, ...extra) {
  return spawnSync(process.execPath, [
    cli, 'verify', '--base', 'HEAD~1', '--head', 'HEAD', ...extra,
  ], { cwd, encoding: 'utf8' });
}

test('rejects a traversal spec and leaves the checked-out files untouched', t => {
  const { cwd, git } = repository(t);
  writeFileSync(join(cwd, 'tracked.txt'), 'Uncommitted work');
  const status = git('status', '--porcelain', '--untracked-files=no');
  const execution = verify(cwd, '--spec', '../outside.spec.mjs');
  const report = JSON.parse(readFileSync(join(cwd, '.reprocue', 'report.json'), 'utf8'));
  assert.equal(execution.status, 2);
  assert.match(report.summary, /without traversal/u);
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), status);
  assert.equal(readFileSync(join(cwd, 'tracked.txt'), 'utf8'), 'Uncommitted work');
});

test('rejects an output path pointing into Git metadata or through a symlink', t => {
  const { cwd } = repository(t);
  symlinkSync(join(cwd, '.git'), join(cwd, 'linked-output'), 'dir');
  for (const output of ['.git/evidence', 'linked-output/evidence']) {
    const execution = verify(cwd, '--spec', 'tracked.txt', '--output', output);
    assert.equal(execution.status, 2);
    assert.match(execution.stderr, /Git metadata|without symlinks/u);
  }
  assert.equal(existsSync(join(cwd, '.git', 'evidence')), false);
});

test('leaves no comparison worktrees when neither revision can install Playwright', t => {
  const { cwd, git } = repository(t);
  const worktrees = git('worktree', 'list', '--porcelain');
  const execution = verify(cwd, '--spec', 'tracked.txt');
  assert.equal(execution.status, 2);
  const report = JSON.parse(readFileSync(join(cwd, '.reprocue', 'report.json'), 'utf8'));
  assert.match(report.base.reason, /package-lock\.json/u);
  assert.match(report.head.reason, /package-lock\.json/u);
  assert.match(readFileSync(join(cwd, '.reprocue', 'report.html'), 'utf8'), /No checkpoint captured/u);
  assert.equal(git('worktree', 'list', '--porcelain'), worktrees);
});

test('requires the head to pass the assertion location that failed on base', () => {
  const title = ['chromium', 'retry.spec.mjs', 'shows a retry'];
  const base = { status: 'assertion-failed', test: title, assertions: ['12:11'] };
  const different = { status: 'passed', test: title, assertions: ['15:11'] };
  const matching = { status: 'passed', test: title, assertions: ['12:11', '15:11'] };

  assert.equal(verdict(base, different)[0], 'inconclusive');
  assert.equal(verdict(base, matching)[0], 'verified');
});
