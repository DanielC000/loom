// Card 2b7826f4 (Atlas audit B, findings B-04 + I-03): the review surface's Files/Diff region.
//   * B-04: at a phone width the two-column Files/Diff grid clipped the Diff column off-screen, so a
//     diff could not be opened. Narrow, the region is now one column and the duplicate Files list goes.
//   * I-03: a diff of 3 files or fewer opens fully; a Files-list click expands that file and scrolls to
//     it; the summary verb no longer reads "Adds 2 files (1 new)" for one new + one edited file.
//
// The seeded worker has no worktree, so GET /api/sessions/:id/diff is served a canned unified diff by
// `page.route` (same instrument as worker-diff-staletime.spec.ts). No real claude spawns.
//
// FIXTURE IDENTITY: the e2e daemon is shared across spec files. Every patch carries a per-run sentinel
// directory, and the page is opened at THIS worker's own /review/<id>, so a sibling's review can never
// satisfy an assertion here.
import { randomUUID } from "node:crypto";
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `+export const ${tag}${i} = ${i};`);

const modifiedBlock = (path: string, n: number) => [
  `diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`,
  `@@ -1,1 +1,${n + 1} @@`, " const keep = 1;", ...lines(n, "m"),
];
const newBlock = (path: string, n: number) => [
  `diff --git a/${path} b/${path}`, "new file mode 100644", "index 0000000..3333333", "--- /dev/null", `+++ b/${path}`,
  `@@ -0,0 +1,${n} @@`, ...lines(n, "n"),
];

async function seedWorker(loomDaemon: LoomDaemon) {
  const short = `r${Math.random().toString(36).slice(2, 9)}`.slice(0, 8);
  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: `ReviewLayoutMgr-${short}` });
  const wkr = await loomDaemon.seedLiveSession({
    project: mgr.project, agentId: mgr.agentId, role: "worker", id: `${short}-${randomUUID()}`,
    parentSessionId: mgr.sessionId, branch: `loom/review-layout-${short}`,
    task: { title: `review-layout-${short}` },
  });
  return { short, workerId: wkr.sessionId };
}

/** Serve `patch` as THIS worker's diff; every other worker's /diff passes through untouched. */
async function serveDiff(page: Page, workerId: string, patch: string[], stat: { files: number; ins: number }) {
  await page.route(`**/api/sessions/${workerId}/diff`, (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ filesChanged: stat.files, insertions: stat.ins, deletions: 0, patch: patch.join("\n") + "\n", uncommitted: false }),
  }));
}

const block = (page: Page, path: string) => page.locator(`[id="file-${path}"]`);
const isOpen = async (page: Page, path: string) => (await block(page, path).locator('button[title="Collapse"]').count()) === 1;

test.describe("review surface Files/Diff region (card 2b7826f4)", () => {
  test("a 2-file diff opens fully, and its headline says Changes, not Adds", async ({ page, loomDaemon }) => {
    const { short, workerId } = await seedWorker(loomDaemon);
    const dir = `src/${short}`;
    const added = `${dir}/coupon.ts`, edited = `${dir}/total.ts`;
    await serveDiff(page, workerId, [...newBlock(added, 18), ...modifiedBlock(edited, 14)], { files: 2, ins: 32 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${loomDaemon.baseURL}/review/${workerId}`);

    // Presence first, on THIS fixture's own sentinel paths.
    await expect(block(page, added)).toBeVisible();
    await expect(block(page, edited)).toBeVisible();
    // The area roll-up takes the top-level dir, so the headline names `src`, not the sentinel; the
    // sentinel blocks above are what pin this page to THIS fixture.
    await expect(page.getByText("Changes 2 files in src (1 new).", { exact: true })).toBeVisible();
    await expect(page.getByText(/^Adds 2 files/)).toHaveCount(0);
    expect(await isOpen(page, added)).toBe(true);
    expect(await isOpen(page, edited)).toBe(true);
  });

  test("a 6-file diff starts collapsed, and a Files-list click expands that file and scrolls to it", async ({ page, loomDaemon }) => {
    const { short, workerId } = await seedWorker(loomDaemon);
    const dir = `src/${short}`;
    const paths = ["a", "b", "c", "d", "e", "f"].map((x) => `${dir}/${x}.ts`);
    await serveDiff(page, workerId, paths.flatMap((p) => modifiedBlock(p, 4)), { files: 6, ins: 24 });
    // A short viewport, so the last file's block starts below the fold and a scroll is observable.
    await page.setViewportSize({ width: 1440, height: 560 });
    await page.goto(`${loomDaemon.baseURL}/review/${workerId}`);

    const target = paths[5]!;
    await expect(block(page, target)).toBeAttached();
    for (const p of paths) expect(await isOpen(page, p), `${p} starts collapsed`).toBe(false);

    const filesList = page.getByTestId("review-files").locator(".rv-files-list");
    await expect(filesList).toBeVisible();
    // BEFORE: the target block is below the fold.
    const before = await block(page, target).boundingBox();
    expect(before && before.y).toBeGreaterThan(560);

    await filesList.getByRole("button", { name: new RegExp(`${target.replace(/[./]/g, "\\$&")}`) }).click();

    // AFTER: open, and scrolled into view.
    await expect(block(page, target).locator('button[title="Collapse"]')).toHaveCount(1);
    await expect.poll(async () => {
      const b = await block(page, target).boundingBox();
      return !!b && b.y >= 0 && b.y < 560;
    }).toBe(true);
    for (const p of paths.slice(0, 5)) expect(await isOpen(page, p), `${p} stays collapsed`).toBe(false);
  });

  test("at a phone width the region is one column, the diff fits on screen, and a file opens", async ({ page, loomDaemon }) => {
    const { short, workerId } = await seedWorker(loomDaemon);
    const dir = `src/${short}`;
    const paths = ["a", "b", "c", "d"].map((x) => `${dir}/${x}.ts`);
    await serveDiff(page, workerId, paths.flatMap((p) => modifiedBlock(p, 4)), { files: 4, ins: 16 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${loomDaemon.baseURL}/review/${workerId}`);

    const first = paths[0]!;
    await expect(block(page, first)).toBeAttached();
    // The duplicate Files list is dropped; the Diff headers carry the same rows.
    // Attached first: toBeHidden alone would also pass for a list that was never rendered at all.
    const filesList = page.getByTestId("review-files").locator(".rv-files-list");
    await expect(filesList).toBeAttached();
    await expect(filesList).toBeHidden();

    await block(page, first).scrollIntoViewIfNeeded();
    for (const p of paths) {
      const b = await block(page, p).boundingBox();
      expect(b, `${p} has a box`).not.toBeNull();
      expect(b!.x, `${p} left edge on screen`).toBeGreaterThanOrEqual(0);
      expect(b!.x + b!.width, `${p} right edge on screen`).toBeLessThanOrEqual(390);
    }

    expect(await isOpen(page, first)).toBe(false);
    await block(page, first).locator('button[title="Expand"]').click();
    await expect(block(page, first).locator('button[title="Collapse"]')).toHaveCount(1);
  });
});
