import { spawnSync } from 'node:child_process';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { recordedSpec } from './record-export.mjs';
import { repository } from './repository.mjs';

const maximumBytes = 1024 * 1024;

function recordingUrl(value) {
  const error = new Error('Specify an HTTP or HTTPS URL without credentials.');
  if (!/^https?:\/\//iu.test(value) || /[\u0000-\u0020\u007f\\]/u.test(value) || !URL.canParse(value)) {
    throw error;
  }
  const url = new URL(value);
  if (url.username || url.password) {
    throw error;
  }
  return url.href;
}

function destination(repo, spec, createParents = false) {
  const segments = spec.split('/');
  if (/[\u0000-\u001f\u007f\\:]/u.test(spec)
      || segments.some(segment => ['', '.', '..', '.git'].includes(segment.toLowerCase()))) {
    throw new Error('--spec must be a repository-relative file path without traversal.');
  }
  if (!/\.(?:spec|test)\.[cm]?[jt]s$/u.test(spec)) {
    throw new Error('--spec must end with a Playwright test filename such as .spec.mjs or .test.ts.');
  }

  const file = join(repo.root, spec);
  if (repo.metadata.some(path => file === path || file.startsWith(`${path}${sep}`))) {
    throw new Error('--spec must be outside Git metadata.');
  }
  let parent = repo.root;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    const entry = lstatSync(parent, { throwIfNoEntry: false });
    if (entry && !entry.isDirectory()) {
      throw new Error(`Expected a parent directory without symlinks at ${parent}.`);
    }
    if (!entry && createParents) {
      mkdirSync(parent);
    }
  }
  if (lstatSync(file, { throwIfNoEntry: false })) {
    throw new Error(`Choose a new --spec path. ${spec} already exists.`);
  }
  return file;
}

function readCodegen(path) {
  const error = new Error('Choose a non-empty regular Playwright codegen file no larger than 1 MiB.');
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry?.isFile() || entry.size === 0 || entry.size > maximumBytes) {
    throw error;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) {
      throw error;
    }
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length);
      if (count === 0) break;
      length += count;
    }
    if (length === 0 || length > maximumBytes) {
      throw error;
    }
    return bytes.toString('utf8', 0, length);
  } finally {
    closeSync(fd);
  }
}

function codegen(repo, url, channel) {
  const cli = join(repo, 'node_modules', '@playwright', 'test', 'cli.js');
  if (!statSync(cli, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Install the repository dependencies with npm ci and ensure @playwright/test is available.');
  }
  const temporary = mkdtempSync(join(tmpdir(), 'reprocue-record-'));
  try {
    const output = join(temporary, 'codegen.spec.mjs');
    const args = [cli, 'codegen', '--target=playwright-test', '--output', output];
    if (channel) {
      args.push(`--channel=${channel}`);
    }
    console.log('Record the steps in the Playwright browser, then close that browser window to save.');
    const result = spawnSync(process.execPath, [...args, url], {
      cwd: repo, stdio: 'inherit',
    });
    if (result.error) {
      throw new Error(`Could not start Playwright codegen. ${result.error.message}`);
    }
    if (result.status !== 0) {
      const installHint = channel
        ? 'Check that the selected browser channel is installed.'
        : 'Install Chromium with npx playwright install chromium if needed.';
      throw new Error(`Playwright codegen did not finish. See its output above. ${installHint}`);
    }
    return readCodegen(output);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function record(options, cwd = process.cwd()) {
  const url = recordingUrl(options.url);
  const repo = repository(cwd, 'Run record inside the Git repository where the scenario will be saved.');
  const file = destination(repo, options.spec);
  const source = options.fromCodegen
    ? readCodegen(resolve(cwd, options.fromCodegen))
    : codegen(repo.root, url, options.channel);
  const output = recordedSpec(source, { url, expectText: options.expectText });
  if (Buffer.byteLength(output) > maximumBytes) {
    throw new Error('The generated Playwright scenario exceeds 1 MiB. Record a shorter scenario.');
  }
  destination(repo, options.spec, true);
  writeFileSync(file, output, { flag: 'wx' });
  return file;
}
