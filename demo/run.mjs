import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const demoDirectory = fileURLToPath(new URL('.', import.meta.url));
const projectDirectory = resolve(demoDirectory, '..');
const fixtureDirectory = join(demoDirectory, 'fixture');
const spec = 'tests/retry.spec.mjs';

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status === null) {
    throw new Error(`${command} terminated (${result.signal}).`);
  }
  return result.status;
}

function prepare(directory) {
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length !== 0) {
    throw new Error(`Demo repository directory must be empty: ${directory}`);
  }

  const gitEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  function git(...args) {
    const status = run('git', args, directory, gitEnv);
    if (status !== 0) throw new Error(`git ${args[0]} exited with status ${status}.`);
  }

  for (const name of ['index.html', 'package.json', 'package-lock.json', 'upload.js']) {
    copyFileSync(join(fixtureDirectory, name), join(directory, name));
  }
  copyFileSync(join(demoDirectory, 'before-fix.js'), join(directory, 'upload-error.js'));

  git('init', '--initial-branch=main', '--template=');
  git('config', 'user.name', 'Demo Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgSign', 'false');
  git('config', 'core.hooksPath', join(directory, '.git', 'demo-hooks'));
  git('add', '--', 'index.html', 'package.json', 'package-lock.json', 'upload.js', 'upload-error.js');
  git('commit', '-m', 'Add the image upload page');
  git('tag', 'before-fix');

  copyFileSync(join(fixtureDirectory, 'upload-error.js'), join(directory, 'upload-error.js'));
  mkdirSync(join(directory, 'tests'));
  copyFileSync(join(fixtureDirectory, spec), join(directory, spec));
  git('add', '--', 'upload-error.js', spec);
  git('commit', '-m', 'Allow retry after a failed upload');
  git('tag', 'after-fix');
}

function runDemo() {
  const destination = mkdtempSync(join(tmpdir(), 'reprocue-demo-'));
  try {
    prepare(destination);

    const demoOutput = join(projectDirectory, '.reprocue', 'demo');
    const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const env = {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: browserCache && browserCache !== '0'
        ? resolve(browserCache)
        : join(projectDirectory, '.reprocue', 'browsers'),
    };
    const dependencies = run('npm', ['ci', '--no-audit', '--no-fund'], destination, env);
    if (dependencies !== 0) return dependencies;

    const browser = run('npm', ['exec', '--', 'playwright', 'install', 'chromium'], destination, env);
    if (browser !== 0) return browser;

    mkdirSync(demoOutput, { recursive: true });
    const output = mkdtempSync(join(demoOutput, 'run-'));
    const result = run(process.execPath, [
      join(projectDirectory, 'bin', 'reprocue.mjs'), 'verify',
      '--base', 'before-fix', '--head', 'after-fix', '--spec', spec, '--output', output,
    ], destination, env);

    console.log(`Evidence directory: ${output}`);
    return result;
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.exitCode = runDemo();
  } else if (args.length === 2 && args[0] === '--prepare') {
    prepare(resolve(args[1]));
  } else {
    throw new Error('Usage: node demo/run.mjs [--prepare <empty-directory>]');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
