// Done-lane render cap (card 7da27eb5, decision record docs/decisions/7da27eb5-done-lane-render-cap.md).
// The terminal lane renders DONE_LANE_PAGE (50) cards and reveals the rest behind a "Show N more" button;
// the cap is applied AFTER the board's own search/priority/column filter, so a search for an OLD done card
// sitting far outside the first page still surfaces it.
//
// Every assertion here is on the RENDERED DOM (`.loom-board-card` inside the lane's own `.loom-grid`
// subtree), never on the response — the whole point of the card is that the payload was never the cost.
//
// Mutant proofs run while writing this spec (both keep the API, per the card's DoD):
//  · `const visible = tasks` (cap removed, DONE_LANE_PAGE still exported/used nowhere) ⇒ the
//    "renders exactly 50" assertion goes RED with 61 cards rendered.
//  · cap applied BEFORE the filter (slice in Board's `shownTasks.filter(...)` chain instead of in Column)
//    ⇒ the "search still finds the oldest done card" assertion goes RED: the card is filtered out of a
//    set that was already sliced to the 50 newest, so the lane renders 0 and the header reads (0).
//
// Follows board.spec.ts's determinism pattern: each test seeds its OWN project and PINS it active via
// addInitScript before navigating, so it never races another test's project on the shared worker daemon.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

// Mirrors Board.tsx's DONE_LANE_PAGE. Deliberately duplicated rather than imported: the spec must fail if
// the production constant moves without this being reconsidered, which an import would silently hide.
const DONE_LANE_PAGE = 50;

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// Same lane locator board.spec.ts uses: `.loom-grid` is used ONLY by board columns on this route, and the
// header label is an exact-text match, so this resolves to exactly one element per lane.
function lane(page: Page, label: string) {
  return page.locator(".loom-grid").filter({ has: page.getByText(label, { exact: true }) });
}

const doneCards = (page: Page) => lane(page, "Done").locator(".loom-board-card");

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * Seed a project whose Done lane holds ONE deliberately-oldest card plus `recent` newer ones.
 *
 * The Done lane sorts `byRecentlyDone` (updatedAt desc), so the oldest card sorts LAST and is what the
 * cap must hide. Creating it first and then sleeping puts every later card at a strictly greater
 * updatedAt — without that sleep two cards minted inside the same millisecond tie, and the tie-break
 * falls through position (also Date.now()) to a random uuid, which would make this card's rank
 * non-deterministic and the spec flaky.
 */
async function seedDoneLane(
  loomDaemon: { createProject: (n?: string) => Promise<{ id: string }>; createTask: (p: string, t: { title: string; columnKey?: string }) => Promise<{ id: string }> },
  recent: number,
) {
  const project = await loomDaemon.createProject(uniq("board-done-cap"));
  const oldestTitle = uniq("OLDESTDONE-archaeology");
  await loomDaemon.createTask(project.id, { title: oldestTitle, columnKey: "done" });
  await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < recent; i++) {
    await loomDaemon.createTask(project.id, { title: `fix(daemon): recent landed card ${i}`, columnKey: "done" });
  }
  return { project, oldestTitle, total: recent + 1 };
}

test("the Done lane renders only the first page, and 'Show N more' reveals the rest", async ({ page, loomDaemon }) => {
  // 61 done cards => 50 rendered, 11 hidden.
  const { project, total } = await seedDoneLane(loomDaemon, DONE_LANE_PAGE + 10);
  expect(total).toBe(61);
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/board`);

  await expect(lane(page, "Done")).toBeVisible();
  // THE CAP: exactly one page is in the DOM, not all 61.
  await expect(doneCards(page)).toHaveCount(DONE_LANE_PAGE);

  // THE HEADER COUNT stays honest about the full set — it must not follow the slice.
  await expect(lane(page, "Done").getByText(`(${total})`, { exact: true })).toBeVisible();

  // THE REVEAL is a real control with an observable before/after, not just a rendered affordance.
  const more = page.getByRole("button", { name: `Show ${total - DONE_LANE_PAGE} more cards in Done` });
  await expect(more).toBeVisible();
  await more.click();
  await expect(doneCards(page)).toHaveCount(total);
  // One-way by design: once revealed there is nothing left to hide, so the button is gone.
  await expect(more).toHaveCount(0);
  // ...and the count was already the true one, so it does not change when the lane expands.
  await expect(lane(page, "Done").getByText(`(${total})`, { exact: true })).toBeVisible();
});

test("a search for the OLDEST done card still finds it, though the cap hides it by default", async ({ page, loomDaemon }) => {
  const { project, oldestTitle, total } = await seedDoneLane(loomDaemon, DONE_LANE_PAGE + 10);
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/board`);

  // Precondition: the target card is genuinely OUTSIDE the first page, so this test can only pass
  // because filtering runs before the cap — not because the card happened to be visible anyway.
  await expect(doneCards(page)).toHaveCount(DONE_LANE_PAGE);
  await expect(lane(page, "Done").getByText(oldestTitle, { exact: true })).toHaveCount(0);

  // Filter FIRST, cap second: the match is pulled out of the full set, so it renders.
  await page.getByLabel("Search tasks by id, title, or description").fill(oldestTitle);
  await expect(lane(page, "Done").getByText(oldestTitle, { exact: true })).toBeVisible();
  await expect(doneCards(page)).toHaveCount(1);
  // The header count reflects what MATCHED, and there is nothing hidden behind a reveal.
  await expect(lane(page, "Done").getByText("(1)", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Show \d+ more cards? in Done$/ })).toHaveCount(0);

  // Clearing the search restores the capped view (the cap is a render concern, not a filter one).
  await page.getByLabel("Clear search").click();
  await expect(doneCards(page)).toHaveCount(DONE_LANE_PAGE);
  await expect(lane(page, "Done").getByText(`(${total})`, { exact: true })).toBeVisible();
});

test("a LIVE lane is never capped, even past the done lane's page size", async ({ page, loomDaemon }) => {
  // The cap is gated on the TERMINAL role; a live lane with more than DONE_LANE_PAGE cards renders whole.
  const project = await loomDaemon.createProject(uniq("board-live-uncapped"));
  const live = DONE_LANE_PAGE + 5;
  for (let i = 0; i < live; i++) {
    await loomDaemon.createTask(project.id, { title: `live card ${i} — in progress`, columnKey: "in_progress" });
  }
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/board`);

  await expect(lane(page, "In Progress").locator(".loom-board-card")).toHaveCount(live);
  await expect(lane(page, "In Progress").getByText(`(${live})`, { exact: true })).toBeVisible();
  // No reveal anywhere on the board — nothing is hidden on a board with no done cards at all.
  await expect(page.getByRole("button", { name: /^Show \d+ more cards? in / })).toHaveCount(0);
});

test("the Done lane's reveal survives the board's 4s poll", async ({ page, loomDaemon }) => {
  // The reveal is lane-local component state, and the lane's React key is stable across a refetch — so a
  // poll re-renders the lane rather than remounting it. Without that, an expanded lane would silently
  // snap back to 50 cards every 4 seconds, which is worse than not having the control at all.
  const { project, total } = await seedDoneLane(loomDaemon, DONE_LANE_PAGE + 10);
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/board`);

  await page.getByRole("button", { name: `Show ${total - DONE_LANE_PAGE} more cards in Done` }).click();
  await expect(doneCards(page)).toHaveCount(total);

  // Prove a poll actually landed in this window rather than just waiting out the clock: a card created
  // now must appear, which can only happen via a refetch.
  const latecomer = uniq("POLLWITNESS-landed");
  await loomDaemon.createTask(project.id, { title: latecomer, columnKey: "done" });
  await expect(lane(page, "Done").getByText(latecomer, { exact: true })).toBeVisible({ timeout: 15_000 });
  // Still expanded across that refetch, now including the new card.
  await expect(doneCards(page)).toHaveCount(total + 1);
});
