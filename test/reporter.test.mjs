import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Reporter from '../src/playwright-reporter.cjs';

const failure = { message: 'Retry button is disabled', stack: 'assertion stack' };
const hookError = { message: 'Cleanup failed', stack: 'cleanup stack' };
const failedAssertion = {
  category: 'expect', error: failure, steps: [],
  location: { file: '/repo/retry.spec.mjs', line: 12, column: 11 },
};
const acceptance = { category: 'test.step', title: 'ReproCue acceptance', steps: [failedAssertion] };
const cleanup = { category: 'hook', error: hookError, steps: [] };

function reportTest(t, steps, errors) {
  const output = mkdtempSync(join(tmpdir(), 'reprocue-reporter-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const path = join(output, 'result.json');
  const previous = process.env.REPROCUE_RESULT_FILE;
  process.env.REPROCUE_RESULT_FILE = path;
  try {
    const reporter = new Reporter();
    reporter.onTestEnd({
      titlePath: () => ['', 'chromium', 'retry.spec.mjs', 'shows a retry'],
      location: { file: '/repo/retry.spec.mjs' },
      expectedStatus: 'passed',
    }, {
      status: 'failed', steps, errors, error: errors[0],
    });
    reporter.onEnd({ status: 'failed' });
    return JSON.parse(readFileSync(path, 'utf8')).tests[0];
  } finally {
    if (previous === undefined) {
      delete process.env.REPROCUE_RESULT_FILE;
    } else {
      process.env.REPROCUE_RESULT_FILE = previous;
    }
  }
}

test('captures a failing assertion inside the named acceptance step', t => {
  const recorded = reportTest(t, [acceptance], [failure]);
  assert.equal(recorded.acceptanceObserved, true);
  assert.equal(recorded.acceptanceFailed, true);
  assert.deepEqual(recorded.failedAssertions, ['12:11']);
});

test('does not mistake a failing setup assertion for a reproduced bug', t => {
  const recorded = reportTest(t, [failedAssertion], [failure]);
  assert.equal(recorded.acceptanceObserved, false);
  assert.equal(recorded.acceptanceFailed, false);
});

test('does not accept an assertion plus an independent afterEach failure', t => {
  const recorded = reportTest(t, [acceptance, cleanup], [failure, hookError]);
  assert.equal(recorded.acceptanceObserved, true);
  assert.equal(recorded.acceptanceFailed, false);
});
