import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderApprovedEvidence, validatePublication } from '../publish-pages/prepare.mjs';

const repository = 'owner/example';
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const spec = 'tests/upload-error.spec.mjs';
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN+8AAAAASUVORK5CYII=', 'base64');

function approval() {
  return {
    params: { repository, ref: 'refs/heads/main', pullRequest: 8, runId: 914 },
    repo: { full_name: repository, visibility: 'public', private: false, default_branch: 'main' },
    pull: {
      number: 8, state: 'open', body: `Fix the upload\nReproCue-Spec: ${spec}\r\n`, labels: [{ name: 'reprocue' }],
      base: { sha: base, repo: { full_name: repository } },
      head: { sha: head, ref: 'fix/upload', repo: { full_name: repository } },
    },
    run: {
      id: 914, event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: head, head_branch: 'fix/upload',
      repository: { full_name: repository }, head_repository: { full_name: repository }, run_attempt: 2, pull_requests: [],
    },
  };
}

function validate({ params, repo, pull, run }) {
  return validatePublication(params, repo, pull, run);
}

function evidence(t) {
  const directory = mkdtempSync(join(tmpdir(), 'reprocue-pages-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scenario = ['', 'upload-error.spec.mjs', 'An upload failure can be retried'];
  const revision = { test: scenario, assertions: ['4:10'] };
  const report = {
    version: 1, spec, run: 'run-Test123', verdict: 'verified', summary: 'Fix confirmed',
    base: { ...revision, commit: base, status: 'assertion-failed', reason: '<script>untrusted()</script>', checkpoint: 'run-Test123/base/checkpoint.png' },
    head: { ...revision, commit: head, status: 'passed', reason: 'Passed', checkpoint: 'run-Test123/head/checkpoint.png' },
  };
  const json = join(directory, 'report.json');
  writeFileSync(json, JSON.stringify(report));
  for (const side of ['base', 'head']) {
    mkdirSync(join(directory, report.run, side), { recursive: true });
    writeFileSync(join(directory, report[side].checkpoint), image);
  }
  return { directory, json, report, publication: validate(approval()) };
}

test('binds an approved same-repository run to an immutable PR and attempt path', () => {
  assert.deepEqual(validate(approval()), {
    repository, pullRequest: 8, base, head, spec, runId: 914, attempt: 2,
    reportPath: `reports/pr-8/${head}/914-2/index.html`,
  });
});

test('rejects a private repository, fork, stale run, or conflicting PR association', () => {
  const cases = [
    [data => { data.repo.private = true; }, /public repository/u],
    [data => { data.params.ref = 'refs/heads/develop'; }, /default branch/u],
    [data => { data.pull.head.repo.full_name = 'fork/example'; }, /same-repository/u],
    [data => { data.pull.labels = []; }, /reprocue label/u],
    [data => { data.pull.body += `ReproCue-Spec: ${spec}`; }, /exactly one/u],
    [data => { data.run.head_sha = base; }, /current head/u],
    [data => { data.run.pull_requests = [{ number: 9 }]; }, /current head/u],
    [data => { data.run.conclusion = 'failure'; }, /successful pull request run/u],
  ];
  for (const [update, message] of cases) {
    const data = approval();
    update(data);
    assert.throws(() => validate(data), message);
  }
});

test('renders only trusted HTML from the approved evidence and embeds both PNGs', t => {
  const { directory, publication } = evidence(t);
  writeFileSync(join(directory, 'report.html'), '<script>alsoUntrusted()</script>');
  const html = renderApprovedEvidence(directory, publication);
  assert.match(html, /Fix verified/u);
  assert.match(html, /&lt;script&gt;untrusted\(\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<script>|alsoUntrusted/u);
  assert.equal(html.split(image.toString('base64')).length - 1, 2);
});

test('rejects evidence for a stale base or a different passing assertion', t => {
  const { directory, json, report, publication } = evidence(t);
  assert.throws(() => renderApprovedEvidence(directory, { ...publication, base: 'c'.repeat(40) }), /current PR revisions/u);
  report.head.assertions = ['6:8'];
  writeFileSync(json, JSON.stringify(report));
  assert.throws(() => renderApprovedEvidence(directory, publication), /same assertion/u);
});

test('rejects a checkpoint outside the artifact or reached through a symlink', t => {
  const { directory, json, report, publication } = evidence(t);
  const original = report.head.checkpoint;
  report.head.checkpoint = '../other.png';
  writeFileSync(json, JSON.stringify(report));
  assert.throws(() => renderApprovedEvidence(directory, publication), /head Playwright checkpoint/u);

  report.head.checkpoint = original;
  writeFileSync(json, JSON.stringify(report));
  const other = join(directory, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'checkpoint.png'), image);
  const parent = join(directory, report.run, 'head');
  rmSync(parent, { recursive: true });
  symlinkSync(other, parent);
  assert.throws(() => renderApprovedEvidence(directory, publication), /regular evidence file/u);
});

test('reports artifact download errors without exposing a signed URL', t => {
  const { directory } = evidence(t);
  const { repo, pull, run } = approval();
  const eventPath = join(directory, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ repository: repo }));
  writeFileSync(join(directory, 'gh'), `#!/usr/bin/env node
if (process.argv[2] === 'run') {
  console.error('https://example.invalid/report.zip?sig=fixture-secret');
  process.exit(1);
}
const path = process.argv[3];
console.log(JSON.stringify(path.includes('/pulls/') ? ${JSON.stringify(pull)}
  : path.includes('/actions/runs/') ? ${JSON.stringify(run)} : ${JSON.stringify(repo)}));
`, { mode: 0o755 });
  const script = fileURLToPath(new URL('../publish-pages/prepare.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH}`,
      GH_TOKEN: 'test-token',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: repository,
      GITHUB_OUTPUT: join(directory, 'output'),
      RUNNER_TEMP: directory,
      REPROCUE_PR: '8',
      REPROCUE_RUN_ID: '914',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not download the verification artifact/u);
  assert.doesNotMatch(result.stderr, /fixture-secret/u);
});
