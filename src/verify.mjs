import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const reporter = fileURLToPath(new URL('./playwright-reporter.cjs', import.meta.url));
const outputMarker = 'ReproCue output v1\n';
const gitEnv = { ...process.env };
for (const variable of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) {
  delete gitEnv[variable];
}

function git(cwd, ...args) {
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    });
  } catch (error) {
    throw new Error(error.stderr?.toString().trim() || error.message);
  }
}

function stat(path) {
  return lstatSync(path, { throwIfNoEntry: false });
}

function ensureDirectory(path) {
  const entry = stat(path);
  if (entry) {
    if (!entry.isDirectory() || realpathSync(path) !== path) {
      throw new Error(`Expected a directory without symlinks: ${path}`);
    }
    return;
  }
  ensureDirectory(dirname(path));
  mkdirSync(path);
}

function within(directory, path) {
  const suffix = relative(directory, path);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function openOutput(repo, value) {
  const output = resolve(repo, value);
  const gitDir = realpathSync(git(repo, 'rev-parse', '--absolute-git-dir').toString().trim());
  const commonDir = realpathSync(resolve(repo, git(repo, 'rev-parse', '--git-common-dir').toString().trim()));
  if (within(output, repo) || [gitDir, commonDir].some(dir => within(dir, output))) {
    throw new Error('--output must be a dedicated directory outside Git metadata.');
  }
  ensureDirectory(output);
  const marker = join(output, '.reprocue-output');
  if (readdirSync(output).length === 0) {
    writeFileSync(marker, outputMarker, { flag: 'wx' });
  }
  if (!stat(marker)?.isFile() || readFileSync(marker, 'utf8') !== outputMarker) {
    throw new Error('--output must be empty or have been created by ReproCue.');
  }
  return output;
}

function specContents(repo, head, spec) {
  if (spec.split('/').some(segment => !segment || ['.', '..', '.git'].includes(segment.toLowerCase()))
      || /[\u0000-\u001f\\:]/u.test(spec)) {
    throw new Error('--spec must be a repository-relative file path without traversal.');
  }
  const entry = git(repo, 'ls-tree', '-z', '--full-tree', head, '--', `:(literal)${spec}`).toString();
  const match = /^100(?:644|755) blob ([a-f0-9]+)\t/u.exec(entry);
  if (!match || entry.slice(match[0].length) !== `${spec}\0`) {
    throw new Error(`Commit ${head} does not contain a regular scenario file at ${spec}.`);
  }
  return git(repo, 'cat-file', 'blob', match[1]);
}

function stageSpec(worktree, spec, content) {
  const path = join(worktree, spec);
  ensureDirectory(dirname(path));
  const entry = stat(path);
  if (entry && !entry.isFile()) {
    throw new Error(`Cannot place the scenario over a non-regular entry: ${spec}.`);
  }
  if (entry) {
    rmSync(path);
  }
  writeFileSync(path, content, { flag: 'wx' });
  return path;
}

function logged(file, args, cwd, log, env, timeout) {
  const fd = openSync(log, 'wx');
  try {
    return spawnSync(file, args, {
      cwd, env, timeout, stdio: ['ignore', fd, fd],
    });
  } finally {
    closeSync(fd);
  }
}

function classify(resultPath, execution, expectedFile) {
  if (execution.error || execution.signal) {
    return { status: 'inconclusive', reason: `Playwright stopped before it could report: ${execution.error?.message ?? execution.signal}.` };
  }
  if (!stat(resultPath)?.isFile()) {
    return { status: 'inconclusive', reason: 'Playwright did not write its result. See playwright.log and check the test configuration.' };
  }
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  if (result.errors.length) {
    return { status: 'inconclusive', reason: result.errors[0] };
  }
  if (result.tests.length !== 1) {
    return { status: 'inconclusive', reason: 'Select one scenario in one Playwright project, using --project if needed.' };
  }
  const [test] = result.tests;
  if (test.file !== expectedFile || test.expectedStatus !== 'passed' || !test.acceptanceObserved) {
    return { status: 'inconclusive', reason: test.error ?? 'Run one ordinary test with an expect() inside one ReproCue acceptance step.' };
  }
  if (test.status === 'passed' && result.status === 'passed' && execution.status === 0) {
    return { status: 'passed', reason: 'Acceptance assertion passed.', test: test.title, assertions: test.passedAssertions };
  }
  if (test.status === 'failed' && test.acceptanceFailed && result.status === 'failed' && execution.status === 1) {
    return { status: 'assertion-failed', reason: test.error, test: test.title, assertions: test.failedAssertions };
  }
  return { status: 'inconclusive', reason: test.error ?? `Playwright reported ${test.status}.` };
}

function runSide(repo, worktree, evidence, commit, options, content) {
  mkdirSync(evidence);
  const side = { commit, status: 'inconclusive', reason: '' };
  let created = false;
  try {
    git(repo, 'worktree', 'add', '--detach', worktree, commit);
    created = true;
    if (!stat(join(worktree, 'package-lock.json'))?.isFile()) {
      throw new Error('A regular package-lock.json at the repository root is required.');
    }
    const env = { ...gitEnv, CI: 'true' };
    const install = logged('npm', ['ci', '--include=dev'], worktree, join(evidence, 'npm.log'), env, 300_000);
    if (install.status !== 0) {
      throw new Error(`npm ci failed. See npm.log${install.error ? ` (${install.error.message})` : ''}.`);
    }
    const cli = join(worktree, 'node_modules', '@playwright', 'test', 'cli.js');
    if (!stat(cli)?.isFile()) {
      throw new Error('Install @playwright/test in both revisions and commit the npm lockfile.');
    }
    const scenario = stageSpec(worktree, options.spec, content);
    const resultPath = join(evidence, 'playwright.json');
    const escaped = options.spec.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const args = [
      cli, 'test', `(?:^|/)${escaped}$`, `--reporter=${reporter}`,
      `--output=${join(evidence, 'artifacts')}`, '--trace=on', '--workers=1', '--retries=0',
      '--repeat-each=1', '--forbid-only', '--global-timeout=120000',
    ];
    if (options.project) {
      args.push(`--project=${options.project}`);
    }
    const execution = logged(process.execPath, args, worktree, join(evidence, 'playwright.log'), {
      ...env, REPROCUE_RESULT_FILE: resultPath,
    }, 150_000);
    Object.assign(side, classify(resultPath, execution, scenario));
  } catch (error) {
    side.reason = error.message;
  } finally {
    if (created) {
      try {
        git(repo, 'worktree', 'remove', '--force', worktree);
      } catch (error) {
        side.status = 'inconclusive';
        side.reason = `Could not remove the temporary worktree: ${error.message}`;
      }
    }
  }
  return side;
}

export function verdict(base, head) {
  if (base.status === 'inconclusive' || head.status === 'inconclusive') {
    return ['inconclusive', 'One or both revisions could not complete the same acceptance test.'];
  }
  if (JSON.stringify(base.test) !== JSON.stringify(head.test)) {
    return ['inconclusive', 'The two revisions selected different Playwright tests or projects.'];
  }
  if (base.status === 'assertion-failed' && head.status === 'passed') {
    if (!base.assertions.every(location => head.assertions.includes(location))) {
      return ['inconclusive', 'The head revision did not pass every source assertion that failed on base.'];
    }
    return ['verified', 'The same acceptance assertion failed on base and passed on head.'];
  }
  if (base.status === 'assertion-failed') {
    return ['still-failing', 'An acceptance assertion failed on both revisions.'];
  }
  if (head.status === 'assertion-failed') {
    return ['regressed', 'An acceptance assertion passed on base and failed on head.'];
  }
  return ['not-reproduced', 'Both revisions passed, so the baseline did not reproduce the bug.'];
}

function markdown(report) {
  const safe = value => stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/[&<>|]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;' })[character])
    .replace(/[\\`*_\[\]~]/gu, '\\$&').trim().slice(0, 500);
  const row = (name, side) => `| ${name} | ${side.commit ?? 'Unavailable'} | ${side.status} | ${safe(side.reason)} |`;
  return [
    '## ReproCue', '', `**${report.verdict}**. ${safe(report.summary)}`, '',
    `Scenario: ${safe(report.spec)}`, '', '| Revision | Commit | Status | Evidence |',
    '| --- | --- | --- | --- |', row('Base', report.base), row('Head', report.head), '',
    `Playwright traces and execution logs: \`${report.run}/{base,head}/\`.`, '',
    'Open a trace with `npx playwright show-trace <path/to/trace.zip>`.', '',
  ].join('\n');
}

export function verify(options, cwd = process.cwd()) {
  const repo = realpathSync(git(cwd, 'rev-parse', '--show-toplevel').toString().replace(/\n$/u, ''));
  const output = openOutput(repo, options.output);
  const evidence = mkdtempSync(join(output, 'run-'));
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'reprocue-'));
  const report = {
    version: 1, spec: options.spec, run: relative(output, evidence),
    base: { commit: null, status: 'inconclusive', reason: 'Not run.' },
    head: { commit: null, status: 'inconclusive', reason: 'Not run.' },
  };
  try {
    for (const side of ['base', 'head']) {
      report[side].commit = git(repo, 'rev-parse', '--verify', '--end-of-options', `${options[side]}^{commit}`).toString().trim();
    }
    if (report.base.commit === report.head.commit) {
      throw new Error('--base and --head must resolve to different commits.');
    }
    const content = specContents(repo, report.head.commit, options.spec);
    for (const side of ['base', 'head']) {
      report[side] = runSide(repo, join(temporary, side), join(evidence, side), report[side].commit, options, content);
    }
    [report.verdict, report.summary] = verdict(report.base, report.head);
  } catch (error) {
    report.verdict = 'inconclusive';
    report.summary = error.message;
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }

  const reportPath = join(output, 'report.json');
  writeFileSync(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(join(evidence, 'report.md'), markdown(report), { flag: 'wx' });
  renameSync(join(evidence, 'report.json'), reportPath);
  renameSync(join(evidence, 'report.md'), join(output, 'report.md'));
  return { report, reportPath };
}
