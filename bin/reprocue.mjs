#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { record } from '../src/record.mjs';
import { verify } from '../src/verify.mjs';

const usage = [
  'Usage: reprocue verify --base <ref> --head <ref> --spec <file> [--output <dir>] [--project <name>]',
  '       reprocue record <url> --spec <file> [--expect-text <text>] [--channel <name> | --from-codegen <file>]',
].join('\n');

function runVerify(args) {
  const { values, positionals } = parseArgs({
    args,
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
      throw new Error('Expected the verify or record command.');
    }
    if (Object.values(values).some(value => value === '') || !values.base || !values.head || !values.spec) {
      throw new Error('Specify non-empty --base, --head and --spec values.');
    }

    const { report, reportPath } = verify(values);
    console.log(`ReproCue: ${report.verdict}. ${report.summary}`);
    console.log(`Report: ${reportPath}`);
    process.exitCode = report.verdict === 'verified' ? 0 : report.verdict === 'inconclusive' ? 2 : 1;
  }
}

function runRecord(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      spec: { type: 'string' },
      'expect-text': { type: 'string' },
      channel: { type: 'string' },
      'from-codegen': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (positionals.length !== 1 || !positionals[0] || !values.spec || Object.values(values).includes('')) {
    throw new Error('Specify one URL and a non-empty --spec path. Optional values must also be non-empty.');
  }
  if (values.channel && values['from-codegen']) {
    throw new Error('--channel applies to live recording only.');
  }

  const path = record({
    url: positionals[0],
    spec: values.spec,
    expectText: values['expect-text'],
    channel: values.channel,
    fromCodegen: values['from-codegen'],
  });
  console.log(`ReproCue: wrote ${path}`);
  console.log('Review the scenario before committing it on the proposed branch, then use reprocue verify.');
}

try {
  const args = process.argv.slice(2);
  if (args[0] === 'record') {
    runRecord(args.slice(1));
  } else {
    runVerify(args);
  }
} catch (error) {
  console.error(`ReproCue: ${error.message}`);
  console.error(usage);
  process.exitCode = 2;
}
