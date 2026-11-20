#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { verify } from '../src/verify.mjs';

const usage = 'Usage: reprocue verify --base <ref> --head <ref> --spec <file> [--output <dir>] [--project <name>]';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      spec: { type: 'string' },
      output: { type: 'string', default: '.reprocue' },
      project: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(usage);
  } else {
    if (positionals.length !== 1 || positionals[0] !== 'verify') {
      throw new Error('Expected the verify command.');
    }
    if (Object.values(values).some(value => value === '') || !values.base || !values.head || !values.spec) {
      throw new Error('Specify non-empty --base, --head and --spec values.');
    }

    const { report, reportPath } = verify(values);
    console.log(`ReproCue: ${report.verdict}. ${report.summary}`);
    console.log(`Report: ${reportPath}`);
    process.exitCode = report.verdict === 'verified' ? 0 : report.verdict === 'inconclusive' ? 2 : 1;
  }
} catch (error) {
  console.error(`ReproCue: ${error.message}`);
  console.error(usage);
  process.exitCode = 2;
}
