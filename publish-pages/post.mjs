import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const marker = '<!-- reprocue:pr-evidence -->';
const sha = /^[0-9a-f]{40}$/u;
const repositoryName = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/u;

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function readPublication(file, repository) {
  const entry = lstatSync(file);
  if (!entry.isFile() || entry.size > 16_384) {
    throw new Error('Expected a regular publication record up to 16 KiB.');
  }
  const publication = JSON.parse(readFileSync(file, 'utf8'));
  if (!publication || !repositoryName.test(repository) || publication.repository !== repository ||
      !positiveInteger(publication.pullRequest) || !positiveInteger(publication.runId) ||
      !positiveInteger(publication.attempt) ||
      typeof publication.base !== 'string' || !sha.test(publication.base) ||
      typeof publication.head !== 'string' || !sha.test(publication.head) ||
      typeof publication.spec !== 'string' || publication.spec.length === 0 ||
      publication.spec.length > 1024 || /[\u0000-\u001f\u007f]/u.test(publication.spec)) {
    throw new Error('Invalid ReproCue publication record.');
  }
  const path = `reports/pr-${publication.pullRequest}/${publication.head}/` +
    `${publication.runId}-${publication.attempt}/index.html`;
  if (publication.reportPath !== path) {
    throw new Error('The published report path does not match the approved run.');
  }
  return publication;
}

function publishedUrl(pageUrl, reportPath) {
  const root = new URL(pageUrl);
  if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash ||
      !/^[A-Za-z0-9.-]+$/u.test(root.hostname) ||
      !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]*$/u.test(root.pathname)) {
    throw new Error('Expected a plain HTTPS GitHub Pages site URL.');
  }
  root.pathname = root.pathname.replace(/\/?$/u, '/');
  return new URL(reportPath.slice(0, -'index.html'.length), root).href;
}

function github(endpoint, { body, method = 'GET', paginate = false } = {}) {
  const args = ['api', '--method', method, endpoint];
  if (paginate) args.push('--paginate', '--slurp');
  if (body !== undefined) args.push('--input', '-');
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body),
    maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
  }));
}

export function publishReportComment({ file, pageUrl, repository }, api = github) {
  const publication = readPublication(file, repository);
  const { base, head, spec, pullRequest, runId, reportPath } = publication;
  const url = publishedUrl(pageUrl, reportPath);
  const endpoint = `repos/${repository}`;
  const repo = api(endpoint);
  if (repo.visibility !== 'public' || repo.full_name !== repository) {
    throw new Error('Public report links require a public repository.');
  }
  const comments = `${endpoint}/issues/${pullRequest}/comments`;
  const existing = api(comments, { paginate: true }).flat().find(comment =>
    comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(marker + '\n'),
  );
  const current = api(`${endpoint}/pulls/${pullRequest}`);
  const declaredSpec = (current.body ?? '').split('\n')
    .filter(line => line.startsWith('ReproCue-Spec:'))
    .map(line => line.slice('ReproCue-Spec:'.length).trim());
  if (current.state !== 'open' || current.base.repo?.full_name !== repository ||
      current.head.repo?.full_name !== repository || current.base.sha !== base ||
      current.head.sha !== head || declaredSpec.length !== 1 || declaredSpec[0] !== spec ||
      !current.labels.some(label => label.name === 'reprocue')) {
    throw new Error('The pull request changed after approval. Its comment was left as-is.');
  }

  const specHash = createHash('sha256').update(spec).digest('hex');
  const body = [
    marker,
    `<!-- reprocue:public-report:${base}:${head}:${specHash} -->`,
    '### ReproCue · Fix verified',
    '',
    '| Revision | Commit | Outcome |',
    '| --- | --- | --- |',
    `| Before | \`${base.slice(0, 12)}\` | Assertion failed |`,
    `| After | \`${head.slice(0, 12)}\` | Passed |`,
    '',
    `[View the before-and-after comparison](${url})`,
    '',
    `[Open the verification run and browser traces](https://github.com/${repository}/actions/runs/${runId})`,
  ].join('\n');
  if (existing && existing.body !== body) {
    api(`${endpoint}/issues/comments/${existing.id}`, { method: 'PATCH', body: { body } });
  } else if (!existing) {
    api(comments, { method: 'POST', body: { body } });
  }
  return url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { REPROCUE_PUBLICATION_FILE, REPROCUE_PAGE_URL, GITHUB_REPOSITORY, GITHUB_OUTPUT, GH_TOKEN } = process.env;
  if (!(REPROCUE_PUBLICATION_FILE && REPROCUE_PAGE_URL && GITHUB_REPOSITORY && GITHUB_OUTPUT && GH_TOKEN)) {
    throw new Error('Missing ReproCue publication environment.');
  }
  const url = publishReportComment({
    file: REPROCUE_PUBLICATION_FILE, pageUrl: REPROCUE_PAGE_URL, repository: GITHUB_REPOSITORY,
  });
  appendFileSync(GITHUB_OUTPUT, `report-url=${url}\n`);
  console.log(`Published ReproCue comparison: ${url}`);
}
