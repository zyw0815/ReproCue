import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publishReportComment } from '../publish-pages/post.mjs';

const marker = '<!-- reprocue:pr-evidence -->';
const repository = 'example/application';
const endpoint = `repos/${repository}`;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'reprocue-published-comment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const publication = {
    repository, pullRequest: 17, base: 'a'.repeat(40), head: 'b'.repeat(40),
    spec: 'tests/reproduction.spec.mjs', runId: 32, attempt: 2,
  };
  publication.reportPath = `reports/pr-17/${publication.head}/32-2/index.html`;
  const repo = { full_name: repository, visibility: 'public' };
  const pr = {
    state: 'open', number: 17,
    base: { sha: publication.base, repo: { full_name: repository } },
    head: { sha: publication.head, repo: { full_name: repository } },
    body: `Description\r\nReproCue-Spec: ${publication.spec}\r\n`,
    labels: [{ name: 'reprocue' }],
  };
  const comments = [{ user: { login: 'someone' }, id: 1, body: `${marker}\nUser content` }];
  const calls = [];
  const api = (path, options) => {
    calls.push({ path, options });
    if (options?.method) return {};
    if (path === endpoint) return repo;
    if (path === `${endpoint}/pulls/17`) return pr;
    assert.equal(path, `${endpoint}/issues/17/comments`);
    assert.equal(options.paginate, true);
    return [comments];
  };
  return {
    directory, publication, repo, pr, comments, calls,
    writes: () => calls.filter(call => call.options?.method),
    publish(pageUrl = 'https://example.github.io/application') {
      const file = join(directory, 'publication.json');
      writeFileSync(file, JSON.stringify(publication));
      return publishReportComment({ file, pageUrl, repository }, api);
    },
  };
}

test('publishes the exact comparison on one bot comment and makes repeat publication idempotent', t => {
  const data = fixture(t);
  const url = data.publish();
  assert.equal(url, `https://example.github.io/application/reports/pr-17/${'b'.repeat(40)}/32-2/`);
  const [first] = data.writes();
  assert.equal(first.path, `${endpoint}/issues/17/comments`);
  assert.equal(first.options.method, 'POST');
  const body = first.options.body.body;
  assert.ok(body.includes(`[View the before-and-after comparison](${url})`));
  assert.match(body, /https:\/\/github\.com\/example\/application\/actions\/runs\/32/u);
  data.comments.push({ user: { login: 'github-actions[bot]' }, id: 8, body });
  assert.equal(data.publish(), url);
  assert.equal(data.writes().length, 1);

  data.publication.attempt = 3;
  data.publication.reportPath = data.publication.reportPath.replace('/32-2/', '/32-3/');
  assert.ok(data.publish().endsWith('/32-3/'));
  const [, update] = data.writes();
  assert.equal(update.path, `${endpoint}/issues/comments/8`);
  assert.equal(update.options.method, 'PATCH');
});

test('rejects a different current base, head, repository, scenario, or approval label', t => {
  const changes = [
    pr => { pr.base.sha = 'c'.repeat(40); },
    pr => { pr.head.sha = 'c'.repeat(40); },
    pr => { pr.head.repo.full_name = 'example/fork'; },
    pr => { pr.body = 'ReproCue-Spec: tests/other.spec.mjs'; },
    pr => { pr.labels = []; },
  ];
  for (const change of changes) {
    const data = fixture(t);
    change(data.pr);
    assert.throws(() => data.publish(), /pull request changed/u);
    assert.equal(data.writes().length, 0);
  }
  const data = fixture(t);
  data.repo.visibility = 'private';
  assert.throws(() => data.publish(), /public repository/u);
  assert.equal(data.writes().length, 0);
});

test('rejects a report path or a Pages URL that could alter the rendered link', t => {
  const data = fixture(t);
  for (const url of ['http://example.github.io', 'https://user@example.github.io/', 'https://example.github.io/path)']) {
    assert.throws(() => data.publish(url), /plain HTTPS/u);
  }
  data.publication.reportPath = '../index.html';
  assert.throws(() => data.publish(), /path does not match/u);
  assert.equal(data.calls.length, 0);
});

test('the existing verification workflow retains a matching approval and clears it for a different verdict', async t => {
  const data = fixture(t);
  data.publish();
  data.comments.push({ user: { login: 'github-actions[bot]' }, id: 8, body: data.writes()[0].options.body.body });
  const workflow = readFileSync(new URL('../.github/workflows/pr-evidence.yml', import.meta.url), 'utf8');
  const script = workflow.split('          script: |\n')[1].replace(/^ {12}/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const run = new AsyncFunction('require', 'process', 'context', 'github', 'core', script);
  const report = {
    version: 1, spec: data.publication.spec, verdict: 'verified',
    base: { commit: data.publication.base, status: 'assertion-failed' },
    head: { commit: data.publication.head, status: 'passed' },
  };
  const process = { env: {
    REPORT_PATH: join(data.directory, 'report.json'), GITHUB_SERVER_URL: 'https://github.com', ARTIFACT_ID: '5',
  } };
  const context = { repo: { owner: 'example', repo: 'application' }, runId: 33, payload: { pull_request: data.pr } };
  const updates = [];
  const github = {
    paginate: async () => data.comments,
    rest: {
      pulls: { get: async () => ({ data: data.pr }) },
      issues: { updateComment: async input => updates.push(input) },
    },
  };
  const core = { notice() {} };
  const verify = async () => {
    writeFileSync(process.env.REPORT_PATH, JSON.stringify(report));
    await run(createRequire(import.meta.url), process, context, github, core);
  };
  await verify();
  assert.equal(updates.length, 0);
  report.verdict = 'still-failing';
  report.head.status = 'assertion-failed';
  await verify();
  assert.equal(updates.length, 1);
  assert.doesNotMatch(updates[0].body, /public-report|after comparison/u);
});
