const { writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { pngAttachment } = require('./checkpoint.cjs');

function errorText(error) {
  return error.message ?? error.value ?? 'Unknown Playwright error';
}

function fingerprint(error) {
  return JSON.stringify([error.message, error.value, error.stack]);
}

function acceptanceSteps(steps, spec, seen, inside = false) {
  for (const step of steps) {
    const marker = step.category === 'test.step' && step.title === 'ReproCue acceptance';
    if (marker) {
      seen.markers += 1;
    }
    if (inside && step.category === 'expect') {
      seen.assertions += 1;
      const { file, line, column } = step.location ?? {};
      if (file === spec && Number.isInteger(line) && Number.isInteger(column)) {
        const location = `${line}:${column}`;
        if (step.error) {
          seen.errors.add(fingerprint(step.error));
          seen.failed.add(location);
        } else {
          seen.passed.add(location);
        }
      }
    }
    if (step.error && !inside && !marker && step.category !== 'test.step') {
      seen.otherFailure = true;
    }
    acceptanceSteps(step.steps, spec, seen, inside || marker);
  }
  return seen;
}

module.exports = class ReproCueReporter {
  errors = [];
  tests = [];
  checkpoint = null;

  onError(error) {
    this.errors.push(errorText(error));
  }

  onTestEnd(test, result) {
    if (this.tests.length > 1) {
      return;
    }
    const { markers, assertions, errors, otherFailure, passed, failed } = acceptanceSteps(result.steps, test.location.file, {
      markers: 0, assertions: 0, errors: new Set(), otherFailure: false,
      passed: new Set(), failed: new Set(),
    });
    this.tests.push({
      title: test.titlePath().slice(1),
      file: test.location.file,
      status: result.status,
      expectedStatus: test.expectedStatus,
      acceptanceObserved: markers === 1 && assertions > 0,
      acceptanceFailed: !otherFailure && result.errors.length > 0 && result.errors.every(error => errors.has(fingerprint(error))),
      passedAssertions: [...passed],
      failedAssertions: [...failed],
      error: result.error ? errorText(result.error) : null,
    });
    if (this.tests.length === 1) {
      const evidence = dirname(process.env.REPROCUE_RESULT_FILE);
      this.checkpoint = pngAttachment(result.attachments, join(evidence, 'artifacts'));
    }
  }

  onEnd(result) {
    const output = process.env.REPROCUE_RESULT_FILE;
    writeFileSync(output, JSON.stringify({
      status: result.status,
      errors: this.errors,
      tests: this.tests,
    }));
    if (this.tests.length === 1 && this.checkpoint) {
      try {
        writeFileSync(join(dirname(output), 'checkpoint.png'), this.checkpoint, { flag: 'wx' });
      } catch {
        // The verdict can still be reported without a checkpoint.
      }
    }
  }
};
