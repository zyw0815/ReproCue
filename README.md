# ReproCue

Run the same Playwright test before and after a proposed bug fix. ReproCue records which commits were tested, shows whether the behavior changed, and keeps screenshots and browser traces with the result.

## Try the demo

Run the demo on macOS or Linux with Git, Node.js 22 or newer, and npm. It installs Playwright Chromium if needed and creates a disposable Git repository with two commits. In the first, a failed image upload leaves the page spinning. In the second, the user sees an error and can retry.

```sh
npm run demo
```

Use the printed evidence directory to open `report.html` in your browser. The demo shows a screenshot from each revision at the same point in the test. Open a saved `trace.zip` with the [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer) to inspect the full sequence.

## Verify a fix in your repository

Both Git revisions need `@playwright/test` and a root `package-lock.json`. Install the browsers your test uses before verification with `npm ci` and `npx playwright install`. If the revisions use different Playwright versions, install the browsers for both versions. Use a single self-contained spec and commit it on the proposed branch. Keep any shared fixtures or imports available at both revisions.

Put the assertion that represents the fix in a step named `ReproCue acceptance`. Leave navigation, setup and other prerequisites outside that step, so setup failures remain inconclusive.

```js
import { expect, test } from '@playwright/test';

test('shows a retry after an upload fails', async ({ page }) => {
  // Reproduce a failed upload here using your application and test data.
  await test.step('ReproCue acceptance', async () => {
    await expect(page.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });
});
```

For a visual comparison, capture the same point in each run with the test's `testInfo` argument. Give the PNG attachment the name `reprocue-checkpoint`. When the point comes after an assertion, you can capture it in a `finally` block so a failing assertion still leaves a screenshot.

```js
await testInfo.attach('reprocue-checkpoint', {
  body: await page.screenshot(),
  contentType: 'image/png',
});
```

From your application repository, invoke the CLI from a ReproCue checkout.

```sh
node /path/to/ReproCue/bin/reprocue.mjs verify \
  --base origin/develop \
  --head HEAD \
  --spec tests/retry.spec.mjs \
  --output .reprocue
```

ReproCue reads the committed spec from `--head` and runs it in a detached worktree for each revision. The caller's branch and uncommitted files stay in place. The comparison uses the two requested commits. Select one Playwright project with `--project` if more than one project would run the spec.

| Result | Meaning | Exit code |
| --- | --- | --- |
| Verified | The acceptance assertion failed on the base and passed on the head. | `0` |
| Still failing | The acceptance assertion failed on both revisions. | `1` |
| Not reproduced | The base and head both passed. | `1` |
| Regressed | The base passed and the head failed the acceptance assertion. | `1` |
| Inconclusive | The run could not establish an outcome, for example because setup failed or the acceptance step never ran. | `2` |

The output contains `report.html`, `report.md`, `report.json`, and any screenshots and browser traces collected for each revision. The HTML report opens on its own and embeds the screenshots. Use test data for scenarios you plan to share as workflow artifacts.

## Add a pull request check

1. Copy the [example workflow](examples/reprocue.yml) to `.github/workflows/reprocue.yml` in your application repository. The development example uses `develop` for the ReproCue Action and its PR reporting workflow. For a fixed preview, pin both references to the same reviewed commit.
2. Commit one self-contained Playwright spec on the fix branch, with a `ReproCue acceptance` step as described above.
3. Put exactly one `ReproCue-Spec` line in the PR description. Use the spec's path from the repository root.

   ```text
   ReproCue-Spec: tests/retry.spec.mjs
   ```

4. Apply the `reprocue` label to opt in. Create the label in your repository the first time. While the label is present, the check also runs when you push another commit or edit the PR description.

For a same-repository PR, the reporting job adds or updates one **ReproCue verification** comment in **Conversation**. It shows both outcomes and links to the evidence. The job has permission to write PR comments and runs separately from the read-only test job.

From **Checks → Summary**, you can see the verdict, both commit SHAs, and any assertion errors. Open the `reprocue-evidence` artifact and then open `report.html` in a browser to compare the screenshots. Fork PRs use the Checks summary and artifact.

The [separate example repository](https://github.com/zyw0815/ReproCue-example) shows this setup on the upload demo.

## Publish a public demo report

The upload demo has a [direct browser report](https://zyw0815.github.io/ReproCue-example/reports/pr-6/1284476e7f12735a832f856f23f986feb0ae0517/) linked from its [pull request](https://github.com/zyw0815/ReproCue-example/pull/6). The published file includes both screenshots.

1. Choose a report whose screenshot and assertion details can be public, such as a synthetic fixture.
2. Put that run's standalone HTML under `docs/reports/pr-<number>/<head-sha>/index.html`. Choose the branch containing `docs/` and the `/docs` folder as the GitHub Pages source. The example publishes from `develop`.
3. Once the page is live, add the HTTPS URL to the PR conversation. Keep the original Actions artifact available for browser traces.

See [Contributing](CONTRIBUTING.md) for the issue and branch workflow.
