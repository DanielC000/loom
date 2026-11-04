// The board's done-lane SERVER window (card a483cbec, record docs/decisions/a483cbec-board-done-lane-window.md).
// Sibling of board-done-lane-cap.spec.ts, which covers the pure client-side render cap (card 7da27eb5)
// this builds on: that spec still owns "the cap is applied AFTER the filter". This one owns the part that
// is new — the unrendered done cards are no longer FETCHED at all while the board is unfiltered.
//
// Unlike its sibling, these assertions deliberately read BOTH layers: the rendered DOM *and* the actual
// request URLs, because "the lane shows 50 cards" is true of the old render cap too. What distinguishes
// this change is which bytes crossed the wire, so a DOM-only spec here would pass against a build that
// quietly reverted the window.
//
// Mutant proofs run while writing this spec (each keeps the API, per the card's DoD):
//  · `const doneLimit = doneWindow` in Board.tsx (i.e. send the window even while filtering) ⇒ "a filter
//    switches to the full set and finds the oldest done card" goes RED: the request keeps `?doneLimit=50`
//    and the oldest card never arrives, so the lane renders 0 matches.
//  · `doneTotal: window.length` in the gateway route (the true total broken, every other key intact) ⇒
//    "the header count is the server's TRUE total" goes RED with (50) instead of (61), and the reveal
//    button vanishes because `hidden` computes to 0.
import { expect, test } from "./fixtures/daemon";
import type { Page, Request } from "@playwright/test";

// Mirrors Board.tsx's DONE_LANE_PAGE, deliberately duplicated for the same reason its sibling spec
// duplicates it: the spec must fail if the production constant moves without this being reconsidered.
const DONE_LANE_PAGE = 50;

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

function lane(page: Page, label: string) {
  return page.locator(".loom-grid").filter({ has: page.getByText(label, { exact: true }) });
}
const doneCards = (page: Page) => lane(page, "Done").locator(".loom-board-card");

/** Every board-route URL this page has requested, in order — the wire-level half of each assertion. */
function recordBoardRequests(page: Page, projectId: string) {
  const urls: string[] = [];
  page.on("request", (r: Request) => {
    const u = new URL(r.url());
    if (u.pathname === `/api/projects/${projectId}/board`) urls.push(u.search);
  });
  return urls;
}
const lastBoardRequest = (urls: string[]) => urls[urls.length - 1];

/**
 * Seed a done lane with ONE deliberately-oldest card plus `recent` newer ones. Same shape (and the same
 * 50 ms gap, for the same reason) as board-done-lane-cap.spec.ts's own seeder: the lane sorts by
 * `updatedAt` desc, and two cards minted inside one millisecond tie-break through a random uuid, which
 * would make the oldest card's rank — the thing every "is it outside the window" assertion rests on —
 * non-deterministic.
 */
async function seedDoneLane(
  loomDaemon: { createProject: (n?: string) => Promise<{ id: string }>; createTask: (p: string, t: { title: string; columnKey?: string }) => Promise<{ id: string }> },
  recent: number,
) {
  const project = await loomDaemon.createProject(uniq("board-done-window"));
  const oldestTitle = uniq("OLDESTDONE-archaeology");
  await loomDaemon.createTask(project.id, { title: oldestTitle, columnKey: "done" });
  await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < recent; i++) {
    await loomDaemon.createTask(project.id, { title: `fix(daemon): recent landed card ${i}`, columnKey: "done" });
  }
  return { project, oldestTitle, total: recent + 1 };
}

test("an unfiltered board fetches ONE window, and the header count is the server's TRUE total", async ({ page, loomDaemon }) => {
  const { project, total } = await seedDoneLane(loomDaemon, DONE_LANE_PAGE + 10); // 61 done
  expect(total).toBe(61);
  await pinActiveProject(page, project.id);
  const urls = recordBoardRequests(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/board`);

  await expect(doneCards(page)).toHaveCount(DONE_LANE_PAGE);
  // THE WIRE: the board asked for a window, not the whole lane.
  expect(lastBoardRequest(urls)).toBe(`?doneLimit=${DONE_LANE_PAGE}`);
  // THE PAYLOAD actually honoured it — the 11 oldest cards are not merely unrendered, they never arrived.
  // Read against the SAME daemon the page is talking to, and against the unwindowed response as its own
  // control, so "the window is smaller" can't pass just because the fixture is small.
  const both = await page.evaluate(async ([id, limit]) => {
    type Board = { tasks: { columnKey: string }[]; doneTotal?: number };
    const win: Board = await (await fetch(`/api/projects/${id}/board?doneLimit=${limit}`)).json();
    const full: Board = await (await fetch(`/api/projects/${id}/board`)).json();
    const done = (b: Board) => b.tasks.filter((t) => t.columnKey === "done").length;
    return { winDone: done(win), fullDone: done(full), winTotal: win.doneTotal, fullTotal: full.doneTotal, fullTasks: full.tasks.length };
  }, [project.id, String(DONE_LANE_PAGE)] as const);
  expect(both.winDone).toBe(DONE_LANE_PAGE);
  expect(both.fullDone).toBe(total);          // the control: unwindowed still ships every done card
  expect(both.winTotal).toBe(total);
  expect(both.fullTotal).toBeUndefined();     // absent, not zero, on the default response

  // THE HEADER COUNT is the server's total, NOT the window length — the single most load-bearing
  // assertion here: a count that followed the window would read (50) forever and make this look like
  // data loss. 7da27eb5's own render cap could satisfy the DOM count off `tasks.length`; this one
  // can only come from `doneTotal`.
  await expect(lane(page, "Done").getByText(`(${total})`, { exact: true })).toBeVisible();
  // ...and the filter readout still counts the WHOLE board (it is about the filter, never about what the
  // lane renders or what was fetched), read against the unwindowed response's own task count above.
  await expect(page.getByText(`${both.fullTasks} of ${both.fullTasks} shown`, { exact: true })).toBeVisible();
});

test("'Show N more' is a real refetch of the next page, with a loading state on the button", async ({ page, loomDaemon }) => {
  const { project, total } = await seedDoneLane(loomDaemon, DONE_LANE_PAGE + 10); // 61 done, 11 behind the reveal
  await pinActiveProject(page, project.id);
  const urls = recordBoardRequests(page, project.id);

  // Hold the NEXT window open long enough for the loading state to be observable rather than racing it.
  // The window bump is the only request this delays, so the first paint is untouched.
  let releaseSecondWindow = () => {};
  const held = new Promise<void>((resolve) => { releaseSecondWindow = resolve; });
  await page.route(`**/api/projects/${project.id}/board?doneLimit=100`, async (route) => {
    await held;
    await route.continue();
  });

  await page.goto(`${loomDaemon.baseURL}/board`);
  await expect(doneCards(page)).toHaveCount(DONE_LANE_PAGE);

  const more = page.getByRole("button", { name: `Show ${total - DONE_LANE_PAGE} more cards in Done` });
  await expect(more).toBeVisible();
  await more.click();

  // THE LOADING STATE, while the refetch is genuinely in flight.
  const busy = page.getByRole("button", { name: `Showing ${total - DONE_LANE_PAGE} more cards in Done` });
  await expect(busy).toBeVisible();
  await expect(busy).toBeDisabled();
  await expect(busy).toHaveAttribute("aria-busy", "true");
  // NO FLASH OF AN EMPTY LANE: the page it already had is still rendered under the pending fetch.
  await expect(doneCards(page)).toHaveCount(DONE_LANE_PAGE);
  await expect(lane(page, "Done").getByText(`(${total})`, { exact: true })).toBeVisible();

  releaseSecondWindow();

  // THE REFETCH landed, and it was a real request for a BIGGER window — not a client-side unhide.
  await expect(doneCards(page)).toHaveCount(total);
  expect(lastBoardRequest(urls)).toBe(`?doneLimit=${DONE_LANE_PAGE * 2}`);
  expect(urls).toContain(`?doneLimit=${DONE_LANE_PAGE}`);
  // Nothing left behind the reveal, so the button is gone; the count never moved.
  await expect(page.getByRole("button", { name: /more cards in Done$/ })).toHaveCount(0);
  await expect(lane(page, "Done").getByText(`(${total})`, { exact: true })).toBeVisible();
});

test("a filter drops the window, fetches the full set, and finds the OLDEST done card", async ({ page, loomDaemon }) => {
  const { project, oldestTitle, total } = await seedDoneLane(loomDaemon, DONE_LANE_PAGE + 10);
  await pinActiveProject(page, project.id);
  const urls = recordBoardRequests(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/board`);

  // Precondition: the target card is genuinely outside the window, so this can only pass because the
  // filter dropped `doneLimit` — not because the card happened to be fetched anyway.
  await expect(doneCards(page)).toHaveCount(DONE_LANE_PAGE);
  expect(lastBoardRequest(urls)).toBe(`?doneLimit=${DONE_LANE_PAGE}`);
  await expect(lane(page, "Done").getByText(oldestTitle, { exact: true })).toHaveCount(0);

  await page.getByLabel("Search tasks by id, title, or description").fill(oldestTitle);

  // 7da27eb5's load-bearing invariant, now one layer deeper: the window has to come OFF the request,
  // or no amount of client-side filtering could ever reach this card.
  await expect(lane(page, "Done").getByText(oldestTitle, { exact: true })).toBeVisible();
  await expect(doneCards(page)).toHaveCount(1);
  expect(lastBoardRequest(urls)).toBe("");
  await expect(lane(page, "Done").getByText("(1)", { exact: true })).toBeVisible();

  // Clearing it goes back to the window — and back to the server's true total.
  await page.getByLabel("Clear search").click();
  await expect(doneCards(page)).toHaveCount(DONE_LANE_PAGE);
  await expect(lane(page, "Done").getByText(`(${total})`, { exact: true })).toBeVisible();
  await expect.poll(() => lastBoardRequest(urls)).toBe(`?doneLimit=${DONE_LANE_PAGE}`);
});

test("the 4s poll keeps polling the CURRENT window, not the first one", async ({ page, loomDaemon }) => {
  // A revealed window has to survive the poll, and the poll has to keep asking for the window the user
  // is actually looking at. Under the old client-only cap this was free (one request shape forever);
  // with the window in the query key it is a real property worth pinning.
  const { project, total } = await seedDoneLane(loomDaemon, DONE_LANE_PAGE + 10);
  await pinActiveProject(page, project.id);
  const urls = recordBoardRequests(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/board`);

  await page.getByRole("button", { name: `Show ${total - DONE_LANE_PAGE} more cards in Done` }).click();
  await expect(doneCards(page)).toHaveCount(total);
  const atReveal = urls.length;

  // Prove a poll actually landed rather than just waiting out the clock: a card created now must appear,
  // which can only happen via a refetch.
  const latecomer = uniq("POLLWITNESS-landed");
  await loomDaemon.createTask(project.id, { title: latecomer, columnKey: "done" });
  await expect(lane(page, "Done").getByText(latecomer, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(doneCards(page)).toHaveCount(total + 1);

  // Every request AFTER the reveal carried the bumped window — the poll did not snap back to page one.
  const afterReveal = urls.slice(atReveal);
  expect(afterReveal.length).toBeGreaterThan(0);
  expect(afterReveal.every((s) => s === `?doneLimit=${DONE_LANE_PAGE * 2}`)).toBe(true);
});
