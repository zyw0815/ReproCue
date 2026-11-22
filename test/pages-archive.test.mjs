import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const archiveScript = fileURLToPath(new URL('../publish-pages/archive.sh', import.meta.url));

test('keeps previous Pages reports and leaves the default branch checkout intact', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'reprocue-pages-test-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const repository = join(temporary, 'repository');
  const remote = join(temporary, 'remote.git');
  const runner = join(temporary, 'runner');
  mkdirSync(join(repository, 'docs'), { recursive: true });
  mkdirSync(runner);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(temporary, 'init', '--bare', remote);
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.name', 'Test');
  git(repository, 'config', 'user.email', 'test@example.com');
  git(repository, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repository, 'docs', 'index.html'), 'Previous public report');
  git(repository, 'add', 'docs/index.html');
  git(repository, 'commit', '-m', 'Seed site');
  git(repository, 'remote', 'add', 'origin', remote);
  git(repository, 'push', 'origin', 'main');
  const initialHead = git(repository, 'rev-parse', 'HEAD');

  const sha = 'a'.repeat(40);
  const firstPath = `reports/pr-6/${sha}/12-1/index.html`;
  const secondPath = `reports/pr-6/${sha}/13-1/index.html`;
  const report = join(temporary, 'report.html');
  const output = join(temporary, 'output');
  function archive(reportPath, contents) {
    writeFileSync(output, '');
    writeFileSync(report, contents);
    return spawnSync('bash', [archiveScript], {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        GITHUB_WORKSPACE: repository,
        RUNNER_TEMP: runner,
        REPROCUE_REPORT_PATH: reportPath,
        REPROCUE_REPORT_FILE: report,
        REPROCUE_SEED_DIRECTORY: 'docs',
      },
    });
  }

  const first = archive(firstPath, 'First report');
  assert.equal(first.status, 0, first.stderr);
  const second = archive(secondPath, 'Second report');
  assert.equal(second.status, 0, second.stderr);
  const site = readFileSync(output, 'utf8').match(/^site-path=(.+)$/m)?.[1];
  assert.equal(readFileSync(join(site, 'index.html'), 'utf8'), 'Previous public report');
  assert.equal(readFileSync(join(site, firstPath), 'utf8'), 'First report');
  assert.equal(readFileSync(join(site, secondPath), 'utf8'), 'Second report');
  assert.equal(git(repository, 'rev-parse', 'HEAD'), initialHead);
  assert.equal(git(repository, 'status', '--porcelain'), '');

  const previousSnapshot = git(remote, 'rev-parse', 'reprocue-pages');
  const repeat = archive(secondPath, 'Second report');
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(git(remote, 'rev-parse', 'reprocue-pages'), previousSnapshot);
  const overwrite = archive(secondPath, 'Different report');
  assert.notEqual(overwrite.status, 0);
  assert.match(overwrite.stderr, /Different content is already archived/u);
  assert.equal(git(remote, 'rev-parse', 'reprocue-pages'), previousSnapshot);

  git(repository, 'remote', 'set-url', 'origin', join(temporary, 'unavailable.git'));
  const unavailable = archive(secondPath, 'Second report');
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /Could not read the Pages archive branch/u);
});
