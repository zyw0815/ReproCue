import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import checkpoint from '../src/checkpoint.cjs';
import { htmlReport } from '../src/report-html.mjs';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN+8AAAAASUVORK5CYII=', 'base64');
const attachment = { name: 'reprocue-checkpoint', contentType: 'image/png' };

test('accepts only one bounded PNG checkpoint in the Playwright evidence', t => {
  const root = mkdtempSync(join(tmpdir(), 'reprocue-checkpoint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'artifacts');
  mkdirSync(output);
  const copy = join(output, 'checkpoint.png');
  const outside = join(root, 'other.png');
  writeFileSync(copy, image);
  writeFileSync(outside, image);

  assert.deepEqual(checkpoint.pngAttachment([{ ...attachment, path: copy }], output), image);
  assert.deepEqual(checkpoint.pngAttachment([{ ...attachment, body: image }], output), image);
  assert.equal(checkpoint.pngAttachment([{ ...attachment, path: outside }], output), null);
  assert.equal(checkpoint.pngAttachment([{ ...attachment, body: Buffer.alloc(5 * 1024 * 1024 + 1) }], output), null);
  assert.equal(checkpoint.pngAttachment([attachment, attachment], output), null);
});

test('compares checkpoints safely and describes missing screenshots', () => {
  const report = {
    verdict: 'verified', summary: 'Before failed, after passed.', spec: '<script>alert(123)</script>', run: 'run-demo',
    base: { status: 'assertion-failed', reason: '\u001b[31mReceived <button>\u001b[0m', commit: 'old' },
    head: { status: 'passed', reason: 'Passed', commit: 'new' },
  };
  const html = htmlReport(report, { base: image });

  assert.match(html, /Fix verified/u);
  assert.match(html, /&lt;script&gt;alert\(123\)&lt;\/script&gt;/u);
  assert.match(html, /Received &lt;button&gt;/u);
  assert.doesNotMatch(html, /<script>|\u001b/u);
  assert.match(html, /<img src="data:image\/png;base64,[^"]+" alt="Before checkpoint">/u);
  assert.match(html, /No checkpoint captured for this revision/u);
  assert.match(html, /reprocue-checkpoint/u);
  assert.doesNotMatch(html, /script-src|<script[^>]*>/u);

  const completeHtml = htmlReport(report, { base: image, head: image });
  const script = completeHtml.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/u)[1];
  const hash = createHash('sha256').update(script).digest('base64');
  assert.ok(completeHtml.includes(`script-src 'sha256-${hash}'`));
  assert.doesNotMatch(script, /alert\(123\)|Received/u);
  assert.doesNotMatch(completeHtml, /[\t ]+$/mu);

  const differentSize = Buffer.from(image);
  differentSize.writeUInt32BE(2, 16);
  assert.doesNotMatch(htmlReport(report, { base: image, head: differentSize }), /data-view="overlay"/u);
});
