import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/reprocue.mjs', import.meta.url));
const url = 'http://127.0.0.1:3000/upload';
const recorded = `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('${url}');
  await page.getByRole('button', { name: 'Upload' }).click();
});
`;

function directory(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'reprocue-record-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function record(cwd, ...args) {
  return spawnSync(process.execPath, [cli, 'record', ...args], { cwd, encoding: 'utf8', timeout: 10_000 });
}

test('imports a recording from the caller directory and writes the scenario at the Git root', t => {
  const repo = directory(t);
  git(repo, 'init', '--quiet');
  const cwd = join(repo, 'feature');
  mkdirSync(cwd);
  const input = join(cwd, 'recorded.js');
  writeFileSync(input, recorded);

  const result = record(cwd, url, '--spec', 'tests/upload.spec.mjs', '--from-codegen', 'recorded.js', '--expect-text', 'Upload failed');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote .*\/tests\/upload\.spec\.mjs/u);
  const output = readFileSync(join(repo, 'tests', 'upload.spec.mjs'), 'utf8');
  assert.match(output, /getByRole\('button'/u);
  assert.match(output, /ReproCue acceptance/u);
  assert.match(output, /Upload failed/u);
  assert.equal(readFileSync(input, 'utf8'), recorded);
});

test('runs the repository Playwright recorder and removes its temporary files on success and failure', t => {
  const repo = directory(t);
  git(repo, 'init', '--quiet');
  const playwright = join(repo, 'node_modules', '@playwright', 'test');
  mkdirSync(playwright, { recursive: true });
  writeFileSync(join(playwright, 'cli.js'), `
const { writeFileSync } = require('node:fs');
const [, , command, target, flag, output, ...options] = process.argv;
const url = options.at(-1);
writeFileSync('invocation.json', JSON.stringify([command, target, flag, output, ...options]));
writeFileSync(output, ${JSON.stringify(recorded)});
if (url.endsWith('/cancelled')) process.exitCode = 1;
`);

  const success = record(repo, url, '--spec', 'tests/upload.spec.mjs', '--expect-text', 'Upload failed');
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /close that browser window/u);
  const invoked = JSON.parse(readFileSync(join(repo, 'invocation.json'), 'utf8'));
  assert.deepEqual(invoked.slice(0, 3), ['codegen', '--target=playwright-test', '--output']);
  assert.equal(invoked[4], url);
  assert.equal(existsSync(dirname(invoked[3])), false);

  const edge = record(repo, url, '--spec', 'tests/edge.spec.mjs', '--expect-text', 'Upload failed', '--channel', 'msedge');
  assert.equal(edge.status, 0, edge.stderr);
  const edgeInvocation = JSON.parse(readFileSync(join(repo, 'invocation.json'), 'utf8'));
  assert.deepEqual(edgeInvocation.slice(4), ['--channel=msedge', url]);
  assert.equal(existsSync(dirname(edgeInvocation[3])), false);

  const failure = record(repo, `${url}/cancelled`, '--spec', 'tests/cancelled.spec.mjs', '--expect-text', 'Upload failed');
  assert.equal(failure.status, 2, failure.stderr);
  assert.match(failure.stderr, /codegen did not finish/u);
  const cancelled = JSON.parse(readFileSync(join(repo, 'invocation.json'), 'utf8'));
  assert.equal(existsSync(dirname(cancelled[3])), false);
  assert.equal(existsSync(join(repo, 'tests', 'cancelled.spec.mjs')), false);
});

test('rejects unsafe destinations before trying to record', t => {
  const repo = directory(t);
  const outside = directory(t);
  git(repo, 'init', '--quiet', '--separate-git-dir=metadata');
  symlinkSync(outside, join(repo, 'linked-tests'), 'dir');
  const existing = join(repo, 'existing.spec.mjs');
  writeFileSync(existing, 'keep this file');

  for (const [spec, message] of [
    ['../outside.spec.mjs', /without traversal/u],
    ['linked-tests/upload.spec.mjs', /without symlinks/u],
    ['existing.spec.mjs', /already exists/u],
    ['metadata/upload.spec.mjs', /outside Git metadata/u],
    ['tests/upload.mjs', /Playwright test filename/u],
  ]) {
    const result = record(repo, url, '--spec', spec);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, message);
  }
  assert.equal(readFileSync(existing, 'utf8'), 'keep this file');
  assert.equal(existsSync(join(outside, 'upload.spec.mjs')), false);
});

test('rejects credentialed URLs, non-Git directories and invalid codegen files', t => {
  const repo = directory(t);
  const spec = ['--spec', 'tests/upload.spec.mjs'];
  for (const target of ['file:///tmp/index.html', 'http://user:secret@localhost:3000/']) {
    const result = record(repo, target, ...spec);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /HTTP or HTTPS URL without credentials/u);
    assert.doesNotMatch(result.stderr, /secret/u);
  }
  const missingRepo = record(repo, url, ...spec);
  assert.equal(missingRepo.status, 2, missingRepo.stderr);
  assert.match(missingRepo.stderr, /inside the Git repository/u);

  git(repo, 'init', '--quiet');
  const channelOnImport = record(repo, url, ...spec, '--from-codegen', 'absent.js', '--channel', 'msedge');
  assert.equal(channelOnImport.status, 2, channelOnImport.stderr);
  assert.match(channelOnImport.stderr, /--channel applies to live recording only/u);
  writeFileSync(join(repo, 'large.js'), Buffer.alloc(1024 * 1024 + 1));
  symlinkSync(join(repo, 'large.js'), join(repo, 'linked.js'));
  for (const input of ['large.js', 'linked.js', 'absent.js']) {
    const result = record(repo, url, ...spec, '--from-codegen', input);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /regular Playwright codegen file no larger than 1 MiB/u);
  }
  assert.equal(existsSync(join(repo, 'tests')), false);
});

test('describes how to install the missing local recorder', t => {
  const repo = directory(t);
  git(repo, 'init', '--quiet');

  const result = record(repo, url, '--spec', 'tests/upload.spec.mjs');

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /npm ci.*@playwright\/test/u);
  assert.equal(existsSync(join(repo, 'tests')), false);
});
