import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function repository(cwd, message) {
  const env = { ...process.env };
  for (const variable of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) {
    delete env[variable];
  }
  const gitPath = (...args) => execFileSync('git', ['rev-parse', ...args], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000,
  }).replace(/\n$/u, '');
  try {
    return {
      root: realpathSync(gitPath('--show-toplevel')),
      metadata: [
        realpathSync(gitPath('--absolute-git-dir')),
        realpathSync(resolve(cwd, gitPath('--git-common-dir'))),
      ],
    };
  } catch {
    throw new Error(message);
  }
}
