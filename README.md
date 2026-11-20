# ReproCue

Run the same Playwright test before and after a proposed bug fix. ReproCue records which commits were tested, shows whether the behavior changed, and keeps the browser traces with the result.

## Try the demo

Run the demo on macOS or Linux with Git, Node.js 22 or newer, and npm. It installs Playwright Chromium if needed and creates a disposable Git repository with two commits. In the first, a failed image upload leaves the page spinning. In the second, the user sees an error and can retry.

```sh
npm run demo
```

Use the printed evidence directory to find `report.md` under `.reprocue/demo/`. Open a saved `trace.zip` with the [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer).

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

The output contains `report.md`, `report.json` and any browser traces collected for each revision. Use test data for scenarios you plan to share as workflow artifacts.

## Add a pull request check

Copy the [example workflow](examples/reprocue.yml) to `.github/workflows/reprocue.yml` in your application repository. Set the spec path to the committed test and pin ReproCue to the revision you want to run. The example uses the PR's base and head commits. Look for the verdict in the GitHub Actions job summary linked from the PR's checks, and download the report and traces from the run artifacts.

See [Contributing](CONTRIBUTING.md) for the issue and branch workflow.
