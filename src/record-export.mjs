import { Script } from 'node:vm';

const quoted = String.raw`(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
const testStart = new RegExp(`^test\\(${quoted}, async \\(\\{ page \\}\\) => \\{$`);
const navigation = new RegExp(`^  await page\\.goto\\((${quoted})\\);$`);
const navigationLike = /^ +await page\d*\s*(?:\.\s*goto\b|\[\s*['"]goto['"]\s*\])/;
const playwrightImport = /^import \{ test, expect(?:, devices)? \} from ['"]@playwright\/test['"];$/;
const assertion = /^  await expect\(page\./;
const inspectorMatcher = /\)\.(?:not\.)?to[A-Z]\w*\(/;
const codegenAction = /^  (?:await page\.|page\.once\('dialog',|const download\d*(?:Promise)? = )/;
const unsupported = 'Use unedited Playwright Test codegen output with one test and one browser page.';

function recordedPath(line, origin) {
  const literal = line.match(navigation)?.[1];
  if (!literal) {
    throw new Error('Recorded page.goto() must use a single literal URL.');
  }

  let address;
  try {
    // Codegen uses JSON escaping with single-quoted JavaScript strings.
    const inner = literal.slice(1, -1).replace(/\\.|"/g, token => {
      if (token === "\\'") return "'";
      if (token === '"') return '\\"';
      return token;
    });
    address = new URL(JSON.parse(`"${inner}"`));
  } catch {
    throw new Error('Recorded page.goto() contains an invalid URL literal.');
  }
  if (!['http:', 'https:'].includes(address.protocol)
      || address.origin !== origin || address.username || address.password) {
    throw new Error('Each recorded page.goto() must use the recording origin without credentials.');
  }

  const path = address.href.slice(origin.length);
  // A leading double slash would otherwise change the host during replay.
  return path.startsWith('//') ? `/.${path}` : path;
}

export function recordedSpec(source, { url, expectText }) {
  const invalidUrl = 'Record from an HTTP or HTTPS URL without credentials.';
  if (!URL.canParse(url)) {
    throw new Error(invalidUrl);
  }
  const recording = new URL(url);
  if (!['http:', 'https:'].includes(recording.protocol) || recording.username || recording.password) {
    throw new Error(invalidUrl);
  }
  if (expectText !== undefined && (typeof expectText !== 'string' || !expectText.trim())) {
    throw new Error('Supply non-blank text with --expect-text.');
  }

  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.slice(bom.length).trim().split(/\r?\n/);
  const testIndex = lines.findIndex(line => testStart.test(line));
  const options = lines.slice(1, testIndex).join('\n').trim();
  if (testIndex < 1 || !playwrightImport.test(lines[0]) || lines.at(-1) !== '});'
      || (options && !/^test\.use\(\{(?:[^\n]*|\n(?: {2,}[^\n]*\n|\n)*)\}\);$/.test(options))) {
    throw new Error(unsupported);
  }
  if (/(?:\bbaseURL|['"]baseURL['"])\s*:/.test(options)) {
    throw new Error('Configure baseURL in the Playwright project so each revision can supply its own server.');
  }

  const actions = lines.slice(testIndex + 1, -1);
  let lastAction = -1;
  let lastLine = -1;
  let hasNavigation = false;
  let inSnapshot = false;
  for (const [index, line] of actions.entries()) {
    if (!line.trim()) continue;
    lastLine = index;

    if (inSnapshot) {
      inSnapshot = !/^ {4,}`\);$/.test(line);
      continue;
    }
    if (navigationLike.test(line)) {
      actions[index] = `  await page.goto(${JSON.stringify(recordedPath(line, recording.origin))});`;
      hasNavigation = true;
    }
    // Multiline options and dialog handlers are indented by Codegen.
    if (lastAction >= 0 && /^(?: {4}|  [}\]])/.test(line)) continue;
    if (!codegenAction.test(line) && !assertion.test(line)) {
      throw new Error(unsupported);
    }
    lastAction = index;
    inSnapshot = assertion.test(line) && line.endsWith('.toMatchAriaSnapshot(`');
  }
  if (!hasNavigation) {
    throw new Error('The recording must include a page navigation.');
  }
  if (inSnapshot || !actions[lastLine].trimEnd().endsWith(';')) {
    throw new Error(unsupported);
  }

  let acceptance;
  if (expectText !== undefined) {
    acceptance = [`      await expect(page.getByText(${JSON.stringify(expectText)}, { exact: true })).toBeVisible();`];
  } else {
    if (!assertion.test(actions[lastAction]) || !inspectorMatcher.test(actions[lastAction])) {
      throw new Error('Finish the recording with a Playwright Inspector assertion or use --expect-text.');
    }
    acceptance = actions.splice(lastAction, lastLine - lastAction + 1);
    acceptance[0] = `    ${acceptance[0]}`;
  }
  while (actions.length && !actions.at(-1).trim()) actions.pop();

  lines[testIndex] = lines[testIndex].replace(/\(\{ page \}\) => \{$/, '({ page }, testInfo) => {');
  const body = [
    ...lines.slice(1, testIndex + 1),
    ...actions,
    '',
    "  await test.step('ReproCue acceptance', async () => {",
    '    try {',
    ...acceptance,
    '    } finally {',
    '      try {',
    "        await testInfo.attach('reprocue-checkpoint', {",
    '          body: await page.screenshot({ timeout: 2_000 }),',
    "          contentType: 'image/png',",
    '        });',
    '      } catch {',
    '        // Evidence capture is optional. Keep the assertion result.',
    '      }',
    '    }',
    '  });',
    '});',
    '',
  ].join(newline);
  try {
    // Compile the JavaScript without its known import to check syntax without running the test.
    new Script(`'use strict';${newline}${body}`);
  } catch {
    throw new Error(`The recording contains invalid JavaScript. ${unsupported}`);
  }
  return `${bom}${lines[0]}${newline}${body}`;
}
