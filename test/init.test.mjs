import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/reprocue.mjs', import.meta.url));
const setupTemplate = readFileSync(new URL('../examples/reprocue.yml', import.meta.url), 'utf8');

function app(t) {
  const path = mkdtempSync(join(tmpdir(), 'reprocue-init-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: path });
  writeFileSync(join(path, 'package.json'), '{"devDependencies":{"@playwright/test":"1.61.0"}}');
  writeFileSync(join(path, 'package-lock.json'), '{}');
  return path;
}

function init(cwd, ...args) {
  return spawnSync(process.execPath, [cli, 'init', ...args], { cwd, encoding: 'utf8', timeout: 10_000 });
}

test('generates the example workflow once from an application subdirectory', t => {
  const repo = app(t);
  const cwd = join(repo, 'tests');
  mkdirSync(cwd);
  writeFileSync(join(repo, 'playwright.config.mjs'), 'export default { webServer: {}, use: { baseURL: "http://localhost:3000" } };');

  const first = init(cwd);
  const workflow = join(repo, '.github', 'workflows', 'reprocue.yml');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.equal(readFileSync(workflow, 'utf8'), setupTemplate);

  writeFileSync(workflow, '# existing workflow');
  const again = init(cwd);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /found existing workflow/u);
  assert.equal(readFileSync(workflow, 'utf8'), '# existing workflow');
});

test('pins both references and flags an app configuration that needs review', t => {
  const repo = app(t);
  const ref = 'ab12'.repeat(10);
  const result = init(repo, '--ref', ref);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /baseURL and webServer/u);
  const workflow = readFileSync(join(repo, '.github', 'workflows', 'reprocue.yml'), 'utf8');
  assert.equal(workflow.split(`@${ref}`).length - 1, 2);
  assert.match(workflow, /ref: \$\{\{ github.event.pull_request.head.sha \}\}/u);
});

test('rejects invalid refs and missing requirements before writing a workflow', t => {
  const repo = app(t);
  for (const ref of ['feature..next', 'branch\nsteps:', '']) {
    const invalid = init(repo, '--ref', ref);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /Git tag, commit SHA or branch name/u);
  }
  writeFileSync(join(repo, 'package.json'), '{}');
  const dependency = init(repo);
  assert.equal(dependency.status, 2);
  assert.match(dependency.stderr, /npm install -D @playwright\/test/u);
  assert.equal(existsSync(join(repo, '.github')), false);
});

test('keeps an existing YAML workflow and refuses a redirect outside the repository', t => {
  const repo = app(t);
  const other = app(t);
  const github = join(repo, '.github');
  symlinkSync(other, github, 'dir');
  const linked = init(repo);
  assert.equal(linked.status, 2);
  assert.match(linked.stderr, /directory without symlinks/u);
  assert.equal(existsSync(join(other, 'workflows')), false);

  rmSync(github);
  mkdirSync(join(github, 'workflows'), { recursive: true });
  const existing = join(github, 'workflows', 'reprocue.yaml');
  writeFileSync(existing, '# configured');
  assert.equal(init(repo).status, 0);
  assert.equal(readFileSync(existing, 'utf8'), '# configured');
  assert.equal(existsSync(join(github, 'workflows', 'reprocue.yml')), false);
});
