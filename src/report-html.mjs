import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';

const styles = readFileSync(new URL('./report.css', import.meta.url), 'utf8').trimEnd();
const comparisonScript = readFileSync(new URL('./report-comparison.js', import.meta.url), 'utf8').replace(/\r\n?/gu, '\n');
const scriptHash = createHash('sha256').update(comparisonScript).digest('base64');

const verdictLabels = {
  verified: ['Fix verified', 'passed', '✓'],
  'still-failing': ['Still failing', 'failed', '!'],
  'not-reproduced': ['Bug not reproduced', 'inconclusive', '?'],
  regressed: ['Regression detected', 'failed', '!'],
  inconclusive: ['Inconclusive', 'inconclusive', '?'],
};

const sideLabels = {
  passed: ['Passed', 'passed'],
  'assertion-failed': ['Assertion failed', 'failed'],
  inconclusive: ['Inconclusive', 'inconclusive'],
};

function escape(value, limit = 8000) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return stripVTControlCharacters(String(value ?? '')).slice(0, limit)
    .replace(/[&<>"']/gu, character => entities[character]);
}

function panel(title, kind, revision, checkpoint) {
  const [status, tone] = sideLabels[revision.status] ?? sideLabels.inconclusive;
  const image = checkpoint
    ? `<img src="data:image/png;base64,${checkpoint.toString('base64')}" alt="${title} checkpoint">`
    : '<p>No checkpoint captured for this revision.</p>';
  const commit = revision.commit ? escape(revision.commit, 12) : 'Unavailable';
  return `<article class="revision ${kind}">
    <header class="revision-header">
      <h3>${title}</h3>
      <span class="status ${tone}">${status}</span>
      <span class="commit">${kind} · <code>${commit}</code></span>
    </header>
    <div class="checkpoint">${image}</div>
  </article>`;
}

function details(title, revision) {
  const [status] = sideLabels[revision.status] ?? sideLabels.inconclusive;
  return `<details>
    <summary><strong>${title}</strong> · ${status}</summary>
    <div class="detail-content">
      <p>Commit <code>${escape(revision.commit ?? 'Unavailable', 64)}</code></p>
      <pre>${escape(revision.reason)}</pre>
    </div>
  </details>`;
}

function overlayAvailable({ base, head }) {
  // PNG width and height are stored together in the IHDR fields.
  return base?.length >= 24 && head?.length >= 24
    && base.subarray(16, 24).equals(head.subarray(16, 24));
}

export function htmlReport(report, checkpoints) {
  const [verdict, tone, symbol] = verdictLabels[report.verdict] ?? verdictLabels.inconclusive;
  const showOverlay = overlayAvailable(checkpoints);
  const missing = !checkpoints.base || !checkpoints.head;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';${showOverlay ? ` script-src 'sha256-${scriptHash}';` : ''} base-uri 'none'; form-action 'none'">
  <title>ReproCue · ${verdict}</title>
  <style>
${styles}
  </style>
</head>
<body>
<main>
  <header class="masthead">
    <span class="brand">ReproCue</span>
    <a href="#details">Assertion details</a>
  </header>
  <section class="outcome" aria-labelledby="verdict">
    <h1 id="verdict"><span class="verdict-icon ${tone}" aria-hidden="true">${symbol}</span>${verdict}</h1>
    <p>${escape(report.summary, 1000)}</p>
    <p class="scenario"><strong>Scenario</strong> <code>${escape(report.spec, 500)}</code></p>
  </section>
  <section class="comparison" aria-labelledby="comparison-title">
    <div class="section-heading">
      <h2 id="comparison-title">Visual comparison</h2>${showOverlay ? `
      <div class="view-controls" role="group" aria-label="Comparison view" hidden>
        <button type="button" data-view="side" aria-pressed="true">Side by side</button>
        <button type="button" data-view="overlay" aria-pressed="false">Overlay</button>
      </div>` : ''}
    </div>
    <div class="shots">
      ${panel('Before', 'base', report.base, checkpoints.base)}
      ${panel('After', 'head', report.head, checkpoints.head)}
    </div>${showOverlay ? `
    <div class="overlay-controls" hidden>
      <span aria-hidden="true">After</span>
      <input type="range" aria-label="Reveal before screenshot" aria-valuetext="50% before" min="0" max="100" value="50">
      <span aria-hidden="true">Before</span>
    </div>` : ''}${missing ? `
    <p class="hint">Attach an image/png named <code>reprocue-checkpoint</code> in the Playwright scenario to show a checkpoint.</p>` : ''}
  </section>
  <section class="assertions" aria-labelledby="details">
    <h2 id="details">Details</h2>
    ${details('Before', report.base)}
    ${details('After', report.head)}
  </section>
  <footer>
    <p>Playwright traces and logs are included in <code>${escape(report.run)}/{base,head}/</code> in the evidence bundle.</p>
  </footer>
</main>${showOverlay ? `
<script type="text/javascript">${comparisonScript}</script>` : ''}
</body>
</html>
`;
}
