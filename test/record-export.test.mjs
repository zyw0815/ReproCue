import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordedSpec } from '../src/record-export.mjs';

const url = 'http://localhost:3000/upload';
const openUpload = `  await page.goto('${url}');`;
const click = "  await page.getByRole('button', { name: 'Upload' }).click();";
const retryVisible = "  await expect(page.getByText('Upload failed. Try again.')).toBeVisible();";

function recording(...actions) {
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    "test('test', async ({ page }) => {",
    ...actions,
    '});',
    '',
  ].join('\n');
}

test('replays literal same-origin navigation against each revision and preserves codegen options and actions', () => {
  const expectText = 'Keep "quoted" text, \\ and \'\n${literal}';
  const source = recording(
    "  await page.goto('http://localhost:3000/a\\'b?q=%23%22#target');",
    click,
    '  await page.goto("http://localhost:3000//other.example/path");',
  ).replace("test('test'", "test.use({\n  viewport: {\n    width: 1280,\n    height: 720\n  }\n});\n\ntest('test'");
  const output = recordedSpec(source, { url, expectText });

  assert.ok(output.includes("  await page.goto(\"/a'b?q=%23%22#target\");"));
  assert.ok(output.includes('  await page.goto("/.//other.example/path");'));
  assert.equal(new URL('/.//other.example/path', 'http://localhost:4000').href, 'http://localhost:4000//other.example/path');
  assert.ok(output.includes(click));
  assert.ok(output.includes('test.use({\n  viewport: {\n    width: 1280,'));
  assert.ok(output.includes(`await expect(page.getByText(${JSON.stringify(expectText)}, { exact: true })).toBeVisible();`));
});

test('keeps earlier assertions in setup and marks the final Inspector assertion', () => {
  const setup = "  await expect(page.getByRole('heading')).toHaveText('Upload');";
  const source = recording(openUpload, setup, click, retryVisible);
  const output = recordedSpec(`\uFEFF${source.replaceAll('\n', '\r\n')}`, { url });
  const marker = output.indexOf("test.step('ReproCue acceptance'");
  assert.ok(marker > output.indexOf(setup));
  assert.ok(output.indexOf(retryVisible.trimStart()) > marker);
  assert.ok(output.startsWith('\uFEFF'));
  assert.equal(output.replaceAll('\r\n', '').includes('\n'), false);
});

test('keeps a multiline Inspector ARIA snapshot intact', () => {
  const snapshot = [
    "  await expect(page.getByRole('region')).toMatchAriaSnapshot(`",
    '    - heading "Upload failed"',
    '    - text: |',
    "      await page.goto('http://documentation.example/');",
    '    `);',
  ];
  const source = recording(openUpload, click, ...snapshot);
  const output = recordedSpec(source, { url });
  assert.ok(output.indexOf('.toMatchAriaSnapshot(') > output.indexOf("test.step('ReproCue acceptance'"));
  assert.ok(output.includes(snapshot.join('\n')));
});

test('rejects missing acceptance, unsupported navigation and invalid or multiple recordings', () => {
  const exportActions = (...actions) => recordedSpec(recording(...actions), { url });
  assert.throws(() => exportActions(openUpload, click), /Finish the recording.*Inspector assertion/);
  assert.throws(() => exportActions(click, retryVisible), /include a page navigation/);
  assert.throws(() => exportActions("  await page.goto('http://elsewhere.test/');", retryVisible), /recording origin/);
  assert.throws(() => exportActions("  await page.goto('blob:http://localhost:3000/file');", retryVisible), /recording origin/);
  assert.throws(() => exportActions('  await page.goto(process.env.RECORDING_URL);', retryVisible), /single literal URL/);
  assert.throws(() => exportActions(openUpload, '    await page.goto(process.env.RECORDING_URL);', retryVisible), /single literal URL/);
  assert.throws(() => exportActions(openUpload, "  await page1.getByText('Upload').click();", retryVisible), /one browser page/);
  assert.throws(() => exportActions(openUpload, '  await expect(page.getByText("Upload"));'), /Inspector assertion/);
  assert.throws(() => exportActions(openUpload, '  await page.getByText(.);', retryVisible), /invalid JavaScript/);
  const source = recording(openUpload, retryVisible);
  assert.throws(() => recordedSpec(source + source, { url }), /one test/);
  assert.throws(() => recordedSpec(source, { url, expectText: '   ' }), /non-blank text/);
  const fixedOrigin = source.replace("test('test'", `test.use({ baseURL: '${url}' });\n\ntest('test'`);
  assert.throws(() => recordedSpec(fixedOrigin, { url }), /Configure baseURL in the Playwright project/);
});

test('captures the checkpoint after either assertion outcome without masking failures', async () => {
  const harness = `
    let run;
    let assertionError;
    const test = (_title, callback) => { run = callback; };
    test.step = (_title, callback) => callback();
    const expect = () => ({
      async toBeVisible() { if (assertionError) throw assertionError; },
    });
    export function replay(page, testInfo, failure) {
      assertionError = failure;
      return run({ page }, testInfo);
    }
  `;
  const source = recordedSpec(recording(openUpload, retryVisible), { url });
  const body = source.slice(source.indexOf('\n'));
  const { replay } = await import(`data:text/javascript,${encodeURIComponent(harness + body)}`);
  const calls = [];
  const image = Buffer.from('PNG data');
  const page = {
    async goto() {},
    getByText() {},
    async screenshot() { return image; },
  };
  const testInfo = { async attach(...args) { calls.push(args); } };
  const failure = new Error('acceptance failed');

  await replay(page, testInfo);
  await assert.rejects(replay(page, testInfo, failure), error => error === failure);
  assert.deepEqual(calls, Array(2).fill(['reprocue-checkpoint', { body: image, contentType: 'image/png' }]));
  page.screenshot = async () => { throw new Error('screenshot failed'); };
  await replay(page, testInfo);
  await assert.rejects(replay(page, testInfo, failure), error => error === failure);
  assert.equal(calls.length, 2);
});
