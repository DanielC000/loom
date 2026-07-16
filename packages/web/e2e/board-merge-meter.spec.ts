// Board merge-gate hairline meter spec (card 7b7fa6d — Direction C). A worker bound to a board card can
// carry a `pendingMerge` op (surfaced on /api/sessions from the in-memory PendingOpRegistry); the card
// renders a 2px hairline at its BOTTOM edge — an amber oscilloscope SWEEP while the gate runs, a solid
// full-width FILL once settled (phosphor merged / red failed) — plus a live M:SS timer on the worker row.
//
// `pendingMerge` lives in the registry (no DB / test-seam to seed a real running merge op without a real
// worker+manager+gate), so — exactly as the DoD sanctions — this exercises the RENDER by injecting a
// SYNTHETIC pendingMerge into the /api/sessions response via a Playwright route intercept (the frontend's
// own data layer). Each lifecycle state is driven by flipping the injected state and re-fetching, and every
// assertion is an OBSERVABLE before/after diff (a distinct element, a state-specific fill color, a ticking
// timer) — not just "the page renders". Builds on the shared `loomDaemon` fixture; board.spec.ts is the
// board-interaction template this follows.
import { expect, test } from "./fixtures/daemon";
import type { Locator, Page } from "@playwright/test";
import path from "node:path";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// Opt-in visual capture (mirrors board.spec.ts): unset in CI, so this is a no-op there. Set LOOM_E2E_SHOTS
// to a dir to persist the running/merged/failed card shots for a visual review of the hairline treatment.
const shotDir = process.env.LOOM_E2E_SHOTS;
const shoot = async (card: Locator, name: string) => { if (shotDir) await card.screenshot({ path: path.join(shotDir, name) }); };

// The board card wrapper carries `.loom-board-card`; filter by its title span so one card resolves.
function cardByTitle(page: Page, title: string) {
  return page.locator(".loom-board-card").filter({ has: page.getByText(title, { exact: true }) });
}

// Token rgb values (styles/global.css :root) — asserting the fill's computed color is the strongest
// observable that the card actually switched terminal state, not merely that some bar is present.
const AMBER_RGB = "255, 178, 62"; // --loom-amber #ffb23e (the running sweep gradient)
const PHOSPHOR_RGB = "46, 230, 110"; // --loom-phosphor #2ee66e (merged fill)
const RED_RGB = "255, 92, 92"; // --loom-red #ff5c5c (failed fill)

type MergeState = "running" | "done" | "failed" | null;

test("a board card's merge hairline sweeps while running, fills solid on settle, and ticks a live timer", async ({ page, loomDaemon }) => {
  // A worker bound to a card in Review (the lane a merge fires from), with a branch so the branch chip
  // renders alongside the merge state — mirrors the real merging card.
  const mergeTitle = `merging-card-${Date.now()}`;
  const seeded = await loomDaemon.seedLiveSession({
    role: "worker",
    branch: "loom/mrg1",
    task: { title: mergeTitle, columnKey: "review" },
  });
  // A SECOND, non-merging worker card in the same project/lane — the footprint baseline.
  const plainTitle = `plain-card-${Date.now()}`;
  await loomDaemon.seedLiveSession({
    project: seeded.project,
    role: "worker",
    branch: "loom/pln1",
    task: { title: plainTitle, columnKey: "review" },
  });
  await pinActiveProject(page, seeded.projectId);

  // Inject a synthetic pendingMerge onto the merging worker's /api/sessions row. `mergeState` is the
  // mutable lifecycle knob; `startedAt` sits ~15s in the past so the running timer reads a non-zero M:SS
  // and visibly climbs. Only the ONE seeded worker gets a pendingMerge; every other row passes through.
  let mergeState: MergeState = "running";
  const startedAt = new Date(Date.now() - 15_000).toISOString();
  await page.route("**/api/sessions", async (route) => {
    const resp = await route.fetch();
    const sessions = (await resp.json()) as Array<{ taskId?: string | null }>;
    const patched = sessions.map((s) =>
      s.taskId === seeded.taskId && mergeState
        ? { ...s, pendingMerge: { opId: "e2e-merge-op", state: mergeState, startedAt } }
        : s);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(patched) });
  });

  await page.goto(`${loomDaemon.baseURL}/board`);

  const card = cardByTitle(page, mergeTitle);
  await expect(card).toBeVisible();

  // ── RUNNING: the oscilloscope sweep is present (settled fill is NOT), the pill reads "merging", the
  //    branch chip yields to the merge pill (compactness), and the sweep is drawn with the amber token. ──
  const sweep = card.locator(".loom-merge-sweep");
  await expect(sweep).toBeVisible();
  await expect(card.locator(".loom-merge-fill")).toHaveCount(0);
  await expect(card.getByText("merging", { exact: true })).toBeVisible();
  await expect(card.getByText("loom/mrg1", { exact: true })).toHaveCount(0); // branch hidden during merge
  expect(await sweep.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(AMBER_RGB);

  // The live timer ticks: capture M:SS, wait past a second boundary, and assert it ADVANCED.
  const timer = card.getByText(/^\d+:\d{2}$/);
  await expect(timer).toBeVisible();
  const toSecs = (t: string) => { const [m, s] = t.split(":").map(Number); return m * 60 + s; };
  const t1 = toSecs((await timer.textContent()) ?? "0:00");
  await expect.poll(async () => toSecs((await timer.textContent()) ?? "0:00"), { timeout: 4000 }).toBeGreaterThan(t1);
  await shoot(card, "merge-running.png");

  // ── FOOTPRINT: the merging card must be no materially taller than a plain worker card (the hairline is
  //    an absolute 2px overlay; the timer shares the existing worker row). Compare their box heights. ──
  const mergeBox = await card.boundingBox();
  const plainBox = await cardByTitle(page, plainTitle).boundingBox();
  expect(mergeBox).not.toBeNull();
  expect(plainBox).not.toBeNull();
  expect(Math.abs(mergeBox!.height - plainBox!.height)).toBeLessThanOrEqual(4);

  // ── MERGED (op-state "done"): flip the injection, re-fetch, and the hairline SETTLES to a solid
  //    phosphor fill; the sweep is gone and the pill now reads "merged". ──
  mergeState = "done";
  await page.reload();
  const fill = card.locator(".loom-merge-fill");
  await expect(fill).toBeVisible();
  await expect(card.locator(".loom-merge-sweep")).toHaveCount(0);
  await expect(card.getByText("merged", { exact: true })).toBeVisible();
  expect(await fill.evaluate((el) => getComputedStyle(el).backgroundColor)).toContain(PHOSPHOR_RGB);
  await shoot(card, "merge-merged.png");

  // ── FAILED: a solid RED fill + "failed" pill — a distinct terminal state from merged. ──
  mergeState = "failed";
  await page.reload();
  const failFill = card.locator(".loom-merge-fill");
  await expect(failFill).toBeVisible();
  await expect(card.getByText("failed", { exact: true })).toBeVisible();
  expect(await failFill.evaluate((el) => getComputedStyle(el).backgroundColor)).toContain(RED_RGB);
  await shoot(card, "merge-failed.png");

  // ── SETTLE-EVICTION: when the op leaves the registry (pendingMerge → null), the card reverts to the
  //    normal worker-status row — no hairline at all. ──
  mergeState = null;
  await page.reload();
  await expect(card).toBeVisible();
  await expect(card.locator(".loom-merge-fill")).toHaveCount(0);
  await expect(card.locator(".loom-merge-sweep")).toHaveCount(0);
  // …and the branch chip returns now that the merge pill is gone.
  await expect(card.getByText("loom/mrg1", { exact: true })).toBeVisible();
});
