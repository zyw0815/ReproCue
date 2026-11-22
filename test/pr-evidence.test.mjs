import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/pr-evidence.yml', import.meta.url), 'utf8');
const script = workflow.split('          script: |\n')[1].replace(/^ {12}/gm, '');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const run = new AsyncFunction('require', 'process', 'context', 'github', 'core', script);
const require = createRequire(import.meta.url);
const marker = '<!-- reprocue:pr-evidence -->';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'reprocue-comment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const report = {
    version: 1,
    spec: 'tests/reproduction.spec.mjs',
    verdict: 'verified',
    base: {
      commit: 'a'.repeat(40),
      status: 'assertion-failed',
      reason: '@someone [outside](https://example.invalid/)',
    },
    head: { commit: 'b'.repeat(40), status: 'passed' },
  };
  const eventPull = { number: 17, base: { sha: report.base.commit }, head: { sha: report.head.commit } };
  const currentPull = {
    ...structuredClone(eventPull),
    state: 'open',
    labels: [{ name: 'reprocue' }],
    body: `Description\r\nReproCue-Spec: ${report.spec}\r\n`,
  };
  const context = { repo: { owner: 'example', repo: 'application' }, runId: 32, payload: { pull_request: eventPull } };
  const env = { GITHUB_SERVER_URL: 'https://github.com', ARTIFACT_ID: '89', REPORT_PATH: join(directory, 'report.json') };
  const comments = [{ user: { login: 'someone' }, id: 1, body: `${marker}\nUser content` }];
  const writes = [];
  const notices = [];
  const github = {
    paginate: async () => comments,
    rest: {
      issues: {
        createComment: async input => writes.push({ operation: 'create', input }),
        updateComment: async input => writes.push({ operation: 'update', input }),
      },
      pulls: { get: async () => ({ data: currentPull }) },
    },
  };
  const core = { notice: message => notices.push(message) };
  return {
    report, currentPull, comments, writes, notices,
    publish() {
      writeFileSync(env.REPORT_PATH, JSON.stringify(report));
      return run(require, { env }, context, github, core);
    },
    publishSymlink() {
      const other = join(directory, 'other.json');
      writeFileSync(other, JSON.stringify(report));
      symlinkSync(other, env.REPORT_PATH);
      return run(require, { env }, context, github, core);
    },
  };
}

test('creates a compact comment with the evidence link and updates only the bot comment', async t => {
  const data = fixture(t);
  await data.publish();
  const [{ operation, input }] = data.writes;
  assert.equal(operation, 'create');
  assert.match(input.body, /Fix verified/);
  assert.match(input.body, /\| Before \| `a{12}` \| Assertion failed \|/);
  assert.match(input.body, /\| After \| `b{12}` \| Passed \|/);
  assert.match(input.body, /https:\/\/github\.com\/example\/application\/actions\/runs\/32\/artifacts\/89/);
  assert.doesNotMatch(input.body, /@someone|example\.invalid/);
  data.comments.push({ user: { login: 'github-actions[bot]' }, id: 2, body: input.body });
  await data.publish();
  assert.deepEqual(data.writes[1], { operation: 'update', input: { owner: 'example', repo: 'application', comment_id: 2, body: input.body } });
});

test('leaves the comment alone when the current pull request changed', async t => {
  const data = fixture(t);
  data.currentPull.head.sha = 'c'.repeat(40);
  await data.publish();
  assert.equal(data.writes.length, 0);
  assert.equal(data.notices.length, 1);
});

test('rejects evidence from different commits and inconsistent verdicts', async t => {
  const data = fixture(t);
  data.report.head.commit = 'c'.repeat(40);
  await assert.rejects(data.publish(), /does not match/);
  data.report.head.commit = 'b'.repeat(40);
  data.report.base.status = 'passed';
  await assert.rejects(data.publish(), /inconsistent/);
  assert.equal(data.writes.length, 0);
});

test('rejects a report stored as a symlink', async t => {
  const data = fixture(t);
  await assert.rejects(data.publishSymlink(), /regular ReproCue JSON report/);
  assert.equal(data.writes.length, 0);
});
