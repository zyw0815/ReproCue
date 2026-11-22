import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import checkpoint from '../src/checkpoint.cjs';
import { htmlReport } from '../src/report-html.mjs';
import { verdict } from '../src/verify.mjs';

const sha = /^[a-f0-9]{40}$/u;
const artifactName = 'reprocue-evidence';

function positiveInteger(value, label) {
  const number = Number(value);
  if (!/^[1-9][0-9]*$/u.test(String(value)) || !Number.isSafeInteger(number)) {
    throw new Error(`Expected a positive integer for ${label}.`);
  }
  return number;
}

export function validatePublication({ repository, ref, pullRequest, runId }, repo, pull, run) {
  if (repo.full_name !== repository || repo.visibility !== 'public' || repo.private !== false) {
    throw new Error('Publish reports only from a public repository.');
  }
  if (ref !== `refs/heads/${repo.default_branch}`) {
    throw new Error('Run publication from the repository default branch.');
  }
  if (pull.number !== pullRequest || pull.state !== 'open' || pull.head?.repo?.full_name !== repository ||
      pull.base?.repo?.full_name !== repository || !pull.labels?.some(label => label.name === 'reprocue')) {
    throw new Error('Select an open, same-repository pull request with the reprocue label.');
  }
  const declarations = (pull.body ?? '').split('\n')
    .filter(line => line.startsWith('ReproCue-Spec:'))
    .map(line => line.slice('ReproCue-Spec:'.length).trim());
  if (declarations.length !== 1 || !declarations[0] || declarations[0].length > 1024) {
    throw new Error('The pull request must declare exactly one ReproCue-Spec path.');
  }
  const base = pull.base.sha;
  const head = pull.head.sha;
  if (!sha.test(base) || !sha.test(head) || base === head) {
    throw new Error('Expected distinct pull request commit SHAs.');
  }
  if (run.id !== runId || run.event !== 'pull_request' || run.status !== 'completed' ||
      run.conclusion !== 'success' || run.repository?.full_name !== repository ||
      run.head_repository?.full_name !== repository || run.head_sha !== head ||
      (run.head_branch && run.head_branch !== pull.head.ref) ||
      (run.pull_requests?.length && !run.pull_requests.some(item => item.number === pullRequest))) {
    throw new Error('Select a successful pull request run for the current head commit.');
  }
  const attempt = positiveInteger(run.run_attempt, 'run attempt');
  return {
    repository, pullRequest, base, head, spec: declarations[0], runId, attempt,
    reportPath: `reports/pr-${pullRequest}/${head}/${runId}-${attempt}/index.html`,
  };
}

function regularEvidenceFile(root, filename, maxBytes) {
  const path = join(root, filename);
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry?.isFile() || entry.size > maxBytes || realpathSync(path) !== path) {
    throw new Error(`Expected a regular evidence file within its size limit: ${filename}`);
  }
  return path;
}

export function renderApprovedEvidence(directory, publication) {
  const root = realpathSync(directory);
  const file = regularEvidenceFile(root, 'report.json', 1024 * 1024);
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const { base, head } = report ?? {};
  if (report?.version !== 1 || report.verdict !== 'verified' || report.spec !== publication.spec ||
      base?.commit !== publication.base || head?.commit !== publication.head ||
      base.status !== 'assertion-failed' || head.status !== 'passed' ||
      typeof report.summary !== 'string' || typeof base.reason !== 'string' || typeof head.reason !== 'string' ||
      typeof report.run !== 'string' || !/^run-[A-Za-z0-9]+$/u.test(report.run)) {
    throw new Error('The selected artifact must contain a verified ReproCue report for the current PR revisions and scenario.');
  }
  for (const revision of [base, head]) {
    if (!Array.isArray(revision.test) || !revision.test.length || !revision.test.every(part => typeof part === 'string') ||
        !Array.isArray(revision.assertions) || !revision.assertions.length ||
        !revision.assertions.every(location => typeof location === 'string' && /^[0-9]+:[0-9]+$/u.test(location))) {
      throw new Error('Expected matching acceptance test and assertion locations.');
    }
  }
  const [confirmed, summary] = verdict(base, head);
  if (confirmed !== 'verified') {
    throw new Error('The new revision did not pass the same assertion that failed on the base.');
  }
  const screenshots = {};
  for (const side of ['base', 'head']) {
    const filename = `${report.run}/${side}/checkpoint.png`;
    if (report[side].checkpoint !== filename) {
      throw new Error(`Expected the ${side} Playwright checkpoint.`);
    }
    const path = regularEvidenceFile(root, filename, 5 * 1024 * 1024);
    screenshots[side] = checkpoint.readPng(path);
    if (!screenshots[side]) {
      throw new Error(`The ${side} checkpoint is not a valid bounded PNG.`);
    }
  }
  return htmlReport({ ...report, summary }, screenshots);
}

function gh(args, description) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error(`Could not ${description}. Check GitHub access and retry.`);
  }
}

function main() {
  const {
    GH_TOKEN, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_OUTPUT, GITHUB_REF, GITHUB_REPOSITORY, RUNNER_TEMP,
    REPROCUE_PR, REPROCUE_RUN_ID,
  } = process.env;
  if (GITHUB_EVENT_NAME !== 'workflow_dispatch' || !GH_TOKEN ||
      !/^[\w.-]+\/[\w.-]+$/u.test(GITHUB_REPOSITORY ?? '')) {
    throw new Error('Use the trusted manual GitHub workflow to publish evidence.');
  }
  const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8'));
  if (event.repository?.full_name !== GITHUB_REPOSITORY) {
    throw new Error('The publication must target the workflow repository.');
  }
  const pullRequest = positiveInteger(REPROCUE_PR, 'pull request');
  const runId = positiveInteger(REPROCUE_RUN_ID, 'verification run');
  const root = `repos/${GITHUB_REPOSITORY}`;
  const api = path => JSON.parse(gh(['api', path], 'read the selected pull request or workflow run'));
  const params = { repository: GITHUB_REPOSITORY, ref: GITHUB_REF, pullRequest, runId };
  const repo = api(root);
  const publication = validatePublication(params, repo, api(`${root}/pulls/${pullRequest}`), api(`${root}/actions/runs/${runId}`));

  const temporary = realpathSync(RUNNER_TEMP);
  const evidence = mkdtempSync(join(temporary, 'reprocue-download-'));
  gh(['run', 'download', String(runId), '--repo', GITHUB_REPOSITORY, '--name', artifactName, '--dir', evidence],
    'download the verification artifact');
  const html = renderApprovedEvidence(evidence, publication);
  const current = validatePublication(params, repo, api(`${root}/pulls/${pullRequest}`), api(`${root}/actions/runs/${runId}`));
  if (JSON.stringify(current) !== JSON.stringify(publication)) {
    throw new Error('The selected PR or verification attempt changed during preparation.');
  }

  const staged = mkdtempSync(join(temporary, 'reprocue-publication-'));
  const reportFile = join(staged, 'report.html');
  const publicationFile = join(staged, 'publication.json');
  writeFileSync(reportFile, html, { flag: 'wx' });
  writeFileSync(publicationFile, `${JSON.stringify(publication)}\n`, { flag: 'wx' });
  appendFileSync(GITHUB_OUTPUT, `report-path=${publication.reportPath}\nreport-file=${reportFile}\npublication-file=${publicationFile}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`ReproCue publication: ${error.message.replace(/[\r\n]+/gu, ' ')}`);
    process.exitCode = 1;
  }
}
