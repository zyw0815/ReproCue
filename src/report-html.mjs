import { stripVTControlCharacters } from 'node:util';

const verdictLabels = {
  verified: 'Fix verified', 'still-failing': 'Still failing', 'not-reproduced': 'Bug not reproduced',
  regressed: 'Regression detected', inconclusive: 'Inconclusive',
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
  const reason = escape(revision.reason);
  const details = revision.status === 'passed'
    ? `<p>${reason}</p>`
    : `<details><summary>See verification details</summary><pre>${reason}</pre></details>`;
  return `<article class="revision">
  <header>
    <h2>${title}</h2>
    <span class="status ${tone}">${status}</span>
    <p>${kind} commit <code>${escape(revision.commit ?? 'Unavailable')}</code></p>
  </header>
  <div class="checkpoint">${image}</div>
  <div class="details">${details}</div>
</article>`;
}

export function htmlReport(report, checkpoints) {
  const verdict = verdictLabels[report.verdict] ?? verdictLabels.inconclusive;
  const missing = !checkpoints.base || !checkpoints.head;
  const checkpointHelp = missing
    ? '\n    <p>Attach an image/png named <code>reprocue-checkpoint</code> in the Playwright scenario to show a checkpoint.</p>'
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>ReproCue · ${verdict}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f1f4f8; color: #172438; font: 16px/1.5 system-ui, sans-serif; }
    main { max-width: 1260px; margin: auto; padding: clamp(20px, 4vw, 52px); }
    h1, h2, p { margin: 0; }
    h1 { font-size: clamp(2rem, 5vw, 3.5rem); letter-spacing: -.055em; }
    h2 { font-size: 1.4rem; letter-spacing: -.035em; }
    .brand { color: #314c70; font-weight: 700; }
    .scenario { margin: 14px 0 24px; color: #354862; }
    code { font-size: .86em; overflow-wrap: anywhere; }
    .revisions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .revision { overflow: hidden; background: white; border: 1px solid #d8e0eb; border-radius: 14px; }
    .revision header { display: grid; grid-template-columns: 1fr auto; gap: 6px 10px; align-items: center; padding: 15px 18px; }
    .revision header p { grid-column: 1 / -1; color: #435671; font-size: .92rem; }
    .status { padding: 4px 9px; border-radius: 6px; font-size: .85rem; font-weight: 700; }
    .passed { background: #dbf5e8; color: #13563a; }
    .failed { background: #fde7e5; color: #872f2a; }
    .inconclusive { background: #fff0cf; color: #61450d; }
    .checkpoint { display: grid; place-items: center; aspect-ratio: 16 / 10; padding: 12px; background: #e7edf5; text-align: center; color: #354862; }
    .checkpoint img { width: 100%; height: 100%; min-height: 0; object-fit: contain; object-position: center top; }
    .details { padding: 14px 18px; color: #30425b; }
    summary { cursor: pointer; font-weight: 600; }
    summary:focus-visible { outline: 2px solid #375d98; outline-offset: 3px; }
    pre { margin-bottom: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .82rem; }
    footer { display: grid; gap: 5px; margin-top: 18px; color: #435671; font-size: .92rem; }
    @media (max-width: 680px) { .revisions { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<main>
  <header>
    <p class="brand">ReproCue</p>
    <h1>${verdict}</h1>
    <p>${escape(report.summary, 1000)}</p>
    <p class="scenario">Scenario <code>${escape(report.spec, 500)}</code></p>
  </header>
  <section class="revisions" aria-label="Before and after evidence">
    ${panel('Before', 'Base', report.base, checkpoints.base)}
    ${panel('After', 'Head', report.head, checkpoints.head)}
  </section>
  <footer>${checkpointHelp}
    <p>Playwright traces and logs are included in <code>${escape(report.run)}/{base,head}/</code> in the evidence bundle.</p>
  </footer>
</main>
</body>
</html>
`;
}
