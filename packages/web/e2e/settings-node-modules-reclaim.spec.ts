// Disk Reclaim panel in Settings (card 08ac5925) — the owner-facing surface for card 1008e305's two
// human-only loopback routes. Until this panel existed the only way to invoke the reclaim was `curl`
// with a `loom open` bearer token.
//
// WHY THE DESTRUCTIVE HALF IS DRIVEN THROUGH `page.route`, NOT THE REAL ENDPOINT:
// `POST /api/worktrees/reclaim-node-modules` PERMANENTLY DELETES `node_modules` directories from the
// host it runs on. There is no dry-run mode and no undo. Firing it for real from a test would mean
// first manufacturing a genuine candidate — a worktree on disk with a real node_modules and an
// all-dead session set — and then destroying it, on whatever machine the suite happens to run on. So
// the POST is INTERCEPTED here: the request body is asserted (that is the half the UI actually owns)
// and a synthetic result is fulfilled back. Nothing is ever deleted by this spec.
// The same reasoning applies in reverse to the GET, which is read-only: the first test below drives it
// UNMOCKED against the real daemon so the wiring is proven end to end, and only the cases that need
// candidate data to exist are fulfilled. (gates.spec.ts makes the same split for the same shape of
// reason — its in-memory GateSemaphore registry has no seed path.)
//
// The three properties under test are the ones the card says are most likely to be got wrong:
//   (1) DoD-4 — paths round-trip VERBATIM. The server matches `worktreePaths` by exact string equality
//       against Windows paths; a re-joined or re-cased variant silently lands in `noLongerEligible` and
//       the owner sees a no-op with no error. The fixture paths below are deliberately adversarial.
//   (2) DoD-3 — a null `bytesReclaimed` is an UNKNOWN, not a measured zero. A wedged removal can have
//       destroyed a real fraction of a tree and still report null; rendering "0 bytes" would tell the
//       owner nothing happened when something did. Asserted both per-row and on the run headline.
//   (3) DoD-2 — the delete is reachable ONLY through an armed confirm that names what it will delete,
//       and cancelling backs out cleanly (an observable before/after, not a render check).
//
// Builds on the shared `loomDaemon` fixture; settings.spec.ts is the template.
import { expect, test } from "./fixtures/daemon";

type Page = import("@playwright/test").Page;
type Route = import("@playwright/test").Route;

const LIST_ENDPOINT = "**/api/worktrees/node-modules-reclaimable*";
const RECLAIM_ENDPOINT = "**/api/worktrees/reclaim-node-modules";

// Deliberately adversarial paths: a lowercase drive letter on one and an uppercase one on the other,
// backslash separators throughout, and a trailing segment that a naive `path.join`/normalise round-trip
// would happily rewrite. If the panel ever reconstructs a path instead of echoing the response's own
// string, the body assertion below fails on the exact byte that changed.
const PATH_A = "c:\\Users\\owner\\.loom-worktrees\\proj-alpha\\Aa11Bb22";
const PATH_B = "C:\\Users\\owner\\.loom-worktrees\\proj-beta\\Cc33Dd44";

function candidate(worktreePath: string, projectName: string, ageHours: number) {
  return {
    worktreePath,
    nodeModulesPath: `${worktreePath}\\node_modules`,
    sessionId: `sess-${projectName}`,
    taskId: null,
    projectId: `proj-${projectName}`,
    projectName,
    lastActivityAt: new Date(Date.now() - ageHours * 3_600_000).toISOString(),
    ageHours,
  };
}

const TWO_CANDIDATES = {
  count: 2,
  entries: [candidate(PATH_A, "Alpha Project", 30), candidate(PATH_B, "Beta Project", 96)],
};

async function fulfilListing(page: Page, body: unknown): Promise<void> {
  await page.route(LIST_ENDPOINT, (route) => route.fulfill({ json: body }));
}

/** Arm the POST interceptor: captures the request body, fulfils `result`, never reaches the daemon. */
async function interceptReclaim(page: Page, result: unknown): Promise<{ body: () => unknown }> {
  let captured: unknown;
  await page.route(RECLAIM_ENDPOINT, (route: Route) => {
    captured = route.request().postDataJSON();
    return route.fulfill({ json: result });
  });
  return { body: () => captured };
}

test.describe("Settings › Disk Reclaim (card 08ac5925)", () => {
  test("the read-only listing is wired to the REAL endpoint end to end", async ({ page, loomDaemon }) => {
    // UNMOCKED on purpose — the GET reclaims nothing, so the safe half of this feature is proven against
    // the real daemon rather than a fixture. The panel's own heading count is asserted against the
    // response body, so this fails loudly if the panel ever renders a different source than it fetched.
    const listed = page.waitForResponse(
      (r) => r.url().includes("/api/worktrees/node-modules-reclaimable") && r.request().method() === "GET",
    );
    await page.goto(`${loomDaemon.baseURL}/settings`);

    const res = await listed;
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { count: number; entries: unknown[] };
    expect(body.entries).toHaveLength(body.count);

    await expect(page.getByText("Disk Reclaim", { exact: true })).toBeVisible();
    await expect(page.getByText(`Reclaimable worktrees (${body.count})`)).toBeVisible();
    // This daemon has a scratch LOOM_HOME and never spawns a real worker, so no worktree exists to
    // reclaim — the empty state is the correct rendering, and it must not look like a broken panel.
    expect(body.count).toBe(0);
    await expect(page.getByText(/Nothing to reclaim/)).toBeVisible();
    // The honest statement about sizes — the GET carries none, so the panel must not imply it does.
    await expect(page.getByText(/measured as each tree is removed/)).toBeVisible();
  });

  test("the confirm step names what it will delete, and cancelling backs out cleanly", async ({ page, loomDaemon }) => {
    await fulfilListing(page, TWO_CANDIDATES);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    // FIXTURE IDENTITY: the fulfilled candidates are on screen, not the real (empty) listing.
    await expect(page.getByText("Reclaimable worktrees (2)")).toBeVisible();
    await expect(page.getByText(PATH_A, { exact: true })).toBeVisible();
    await expect(page.getByText("Alpha Project")).toBeVisible();
    await expect(page.getByText("idle 30h")).toBeVisible(); // < 48h renders in hours
    await expect(page.getByText("idle 4d")).toBeVisible(); // 96h renders in days

    const armed = page.getByRole("status").filter({ hasText: "Permanently delete" });
    const deleteFor = (n: number) => page.getByRole("button", { name: `Delete node_modules from ${n} worktrees` });

    // BEFORE: nothing selected ⇒ the destructive button exists but is unreachable, and no confirm exists.
    await expect(deleteFor(0)).toBeDisabled();
    await expect(armed).toHaveCount(0);

    await page.getByLabel(`Select ${PATH_A}`).check();
    await page.getByRole("button", { name: "Delete node_modules from 1 worktree" }).click();

    // AFTER: the confirm is armed and states the count, the permanence, and the exact path.
    await expect(armed).toBeVisible();
    await expect(armed).toContainText("Permanently delete node_modules from 1 worktree on this machine");
    await expect(armed).toContainText("This cannot be undone");
    await expect(armed).toContainText(PATH_A);
    await expect(armed).not.toContainText(PATH_B); // only what was actually selected
    await expect(armed).toContainText(/Branches, commits and the worktrees themselves are left untouched/);

    // Cancel: the confirm is gone, the selection survives, and the primary button is back — an observable
    // state change in both directions, not just "the dialog closed".
    await armed.getByRole("button", { name: "Keep it" }).click();
    await expect(armed).toHaveCount(0);
    await expect(page.getByLabel(`Select ${PATH_A}`)).toBeChecked();
    await expect(page.getByRole("button", { name: "Delete node_modules from 1 worktree" })).toBeEnabled();
  });

  test("the POST carries the listing's own path strings verbatim, at the listing's own minAgeHours", async ({ page, loomDaemon }) => {
    await fulfilListing(page, TWO_CANDIDATES);
    const post = await interceptReclaim(page, {
      candidatesConsidered: 2, removed: 2, bytesReclaimed: 432_100_000, sizeTruncatedCount: 0,
      noLongerEligible: 0, missing: 0, wedged: 0, leftOnDisk: 0,
      results: [
        { worktreePath: PATH_A, projectId: "proj-a", projectName: "Alpha Project", taskId: null, outcome: "removed", bytesReclaimed: 400_000_000 },
        { worktreePath: PATH_B, projectId: "proj-b", projectName: "Beta Project", taskId: null, outcome: "removed", bytesReclaimed: 32_100_000 },
      ],
    });
    await page.goto(`${loomDaemon.baseURL}/settings`);

    // Move the idle threshold off its default so the assertion below can actually distinguish "the
    // panel sent the value it listed at" from "the panel happened to send the default".
    await page.getByLabel("Minimum idle hours").fill("7");
    await expect(page.getByText("Reclaimable worktrees (2)")).toBeVisible();

    await page.getByRole("button", { name: "Select all 2" }).click();
    await page.getByRole("button", { name: "Delete node_modules from 2 worktrees" }).click();
    await page.getByRole("button", { name: "Delete 2 node_modules directories" }).click();

    await expect(page.getByText(/Cleared 2 of 2/)).toBeVisible();
    // THE ASSERTION THIS TEST EXISTS FOR: byte-identical paths, in the listing's own strings, and the
    // same minAgeHours the listing was read at (the POST re-derives eligibility at whatever it is given,
    // so a mismatch would make every requested path ineligible).
    expect(post.body()).toEqual({ minAgeHours: 7, worktreePaths: [PATH_A, PATH_B] });
  });

  test("a null bytesReclaimed renders as UNKNOWN, never as zero", async ({ page, loomDaemon }) => {
    await fulfilListing(page, TWO_CANDIDATES);
    await interceptReclaim(page, {
      candidatesConsidered: 2, removed: 1, bytesReclaimed: 412_000_000, sizeTruncatedCount: 0,
      noLongerEligible: 0, missing: 0, wedged: 1, leftOnDisk: 0,
      results: [
        { worktreePath: PATH_A, projectId: "proj-a", projectName: "Alpha Project", taskId: null, outcome: "removed", bytesReclaimed: 412_000_000 },
        // The case the card is about: force-killed mid-removal. Part of this tree may genuinely be gone.
        { worktreePath: PATH_B, projectId: "proj-b", projectName: "Beta Project", taskId: null, outcome: "wedged", bytesReclaimed: null },
      ],
    });
    await page.goto(`${loomDaemon.baseURL}/settings`);

    await page.getByRole("button", { name: "Select all 2" }).click();
    await page.getByRole("button", { name: "Delete node_modules from 2 worktrees" }).click();
    await page.getByRole("button", { name: "Delete 2 node_modules directories" }).click();

    const removedRow = page.locator('[data-testid="reclaim-row"][data-outcome="removed"]');
    const wedgedRow = page.locator('[data-testid="reclaim-row"][data-outcome="wedged"]');

    // The measured one reports a real figure against its own path...
    await expect(removedRow).toContainText(PATH_A);
    await expect(removedRow).toContainText("Freed 393 MB");
    // ...and the null one says UNKNOWN in those words, with the reason — a different row, different words.
    await expect(wedgedRow).toContainText(PATH_B);
    await expect(wedgedRow).toContainText("Interrupted");
    await expect(wedgedRow).toContainText("Freed: unknown");
    await expect(wedgedRow).toContainText(/part of this tree may already be deleted/);

    // The headline keeps the two facts separate rather than folding the unknown into the total.
    await expect(page.getByText(/Cleared 1 of 2 · freed 393 MB · 1 interrupted, amount freed unknown/)).toBeVisible();

    // NEGATIVE CONTROL, and the whole point of the card's DoD-3: nowhere in the whole readout — headline
    // or rows — does a null freed amount get rendered as a quantity of zero.
    const readout = await page.getByTestId("reclaim-result").innerText();
    expect(readout).not.toMatch(/\b0 (B|KB|MB|GB)\b/);
    expect(readout).not.toMatch(/0 bytes/);
    // POSITIVE CONTROL for that pattern: it DOES match the shape it is meant to catch, so a zero-hit
    // above is a real absence rather than a broken regex.
    expect("Freed 0 MB").toMatch(/\b0 (B|KB|MB|GB)\b/);
  });

  test("an all-wedged run never prints a bytes figure in its headline", async ({ page, loomDaemon }) => {
    // The specific regression the card warns about: `removed === 0` sums to `bytesReclaimed: 0`, which a
    // naive headline would render as "freed 0 B" — asserting nothing happened, when a wedged removal may
    // have destroyed a real fraction of the tree.
    await fulfilListing(page, { count: 1, entries: [candidate(PATH_B, "Beta Project", 50)] });
    await interceptReclaim(page, {
      candidatesConsidered: 1, removed: 0, bytesReclaimed: 0, sizeTruncatedCount: 0,
      noLongerEligible: 0, missing: 0, wedged: 1, leftOnDisk: 0,
      results: [{ worktreePath: PATH_B, projectId: "proj-b", projectName: "Beta Project", taskId: null, outcome: "wedged", bytesReclaimed: null }],
    });
    await page.goto(`${loomDaemon.baseURL}/settings`);

    await page.getByLabel(`Select ${PATH_B}`).check();
    await page.getByRole("button", { name: "Delete node_modules from 1 worktree" }).click();
    await page.getByRole("button", { name: "Delete 1 node_modules directory" }).click();

    const headline = page.getByText(/Nothing was cleared · 1 interrupted, amount freed unknown/);
    await expect(headline).toBeVisible();
    await expect(page.getByText(/freed 0/)).toHaveCount(0);
  });

  test("a truncated measurement is reported as a lower bound, not as the total", async ({ page, loomDaemon }) => {
    await fulfilListing(page, { count: 1, entries: [candidate(PATH_A, "Alpha Project", 30)] });
    await interceptReclaim(page, {
      candidatesConsidered: 1, removed: 1, bytesReclaimed: 1_500_000_000, sizeTruncatedCount: 1,
      noLongerEligible: 0, missing: 0, wedged: 0, leftOnDisk: 0,
      results: [{ worktreePath: PATH_A, projectId: "proj-a", projectName: "Alpha Project", taskId: null, outcome: "removed", bytesReclaimed: 1_500_000_000 }],
    });
    await page.goto(`${loomDaemon.baseURL}/settings`);

    await page.getByLabel(`Select ${PATH_A}`).check();
    await page.getByRole("button", { name: "Delete node_modules from 1 worktree" }).click();
    await page.getByRole("button", { name: "Delete 1 node_modules directory" }).click();

    await expect(page.getByText(/Cleared 1 of 1 · freed at least 1\.4 GB/)).toBeVisible();
    await expect(page.getByText(/the total above is a lower bound/)).toBeVisible();
  });
});
