import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { repository } from './repository.mjs';

const workflow = new URL('../examples/reprocue.yml', import.meta.url);
const extensions = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'];
const entry = path => lstatSync(path, { throwIfNoEntry: false });

function workflowDirectory({ root, metadata }) {
  const github = join(root, '.github');
  const directory = join(github, 'workflows');
  const target = join(directory, 'reprocue.yml');
  if (metadata.some(path => target === path || target.startsWith(`${path}${sep}`))) {
    throw new Error('The workflow must be outside Git metadata.');
  }
  for (const path of [github, directory]) {
    const existing = entry(path);
    if (existing && !existing.isDirectory()) {
      throw new Error(`Expected a directory without symlinks: ${path}`);
    }
  }
  return directory;
}

export function init({ ref } = {}, cwd = process.cwd()) {
  const { root, metadata } = repository(cwd, 'Run init inside the Git repository you want to configure.');
  if (ref !== undefined && (!/^[a-z\d][a-z\d._/-]{0,127}$/iu.test(ref)
      || ref.includes('..') || ref.split('/').some(part => !part || part.startsWith('.')
        || part.endsWith('.') || part.endsWith('.lock')))) {
    throw new Error('Specify a Git tag, commit SHA or branch name with --ref.');
  }

  const manifest = join(root, 'package.json');
  if (!entry(manifest)?.isFile() || !entry(join(root, 'package-lock.json'))?.isFile()) {
    throw new Error('ReproCue needs package.json and package-lock.json at the Git repository root.');
  }
  const { devDependencies, dependencies } = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!devDependencies?.['@playwright/test'] && !dependencies?.['@playwright/test']) {
    throw new Error('Install @playwright/test in the application repository with npm install -D @playwright/test.');
  }

  const warnings = [];
  const config = extensions.map(ext => join(root, `playwright.config.${ext}`)).find(path => entry(path)?.isFile());
  const source = config ? readFileSync(config, 'utf8') : '';
  if (!source.includes('baseURL') || !source.includes('webServer')) {
    warnings.push('Check that Playwright defines baseURL and webServer for relative browser recordings.');
  }

  const directory = workflowDirectory({ root, metadata });
  const target = ['reprocue.yml', 'reprocue.yaml'].map(name => join(directory, name))
    .find(path => entry(path));
  if (target) {
    if (!entry(target)?.isFile()) {
      throw new Error(`Expected a regular workflow file: ${target}`);
    }
    return { path: target, created: false, warnings };
  }

  const path = join(directory, 'reprocue.yml');
  let template = readFileSync(workflow, 'utf8');
  if (ref) {
    template = template.replace(/(zyw0815\/ReproCue(?:\/\.github\/workflows\/pr-evidence\.yml)?@)[^\s]+/gu, `$1${ref}`);
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, template, { flag: 'wx' });
  return { path, created: true, warnings };
}
