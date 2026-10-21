// The Board's REAL multi-select filters work on every Atlas board surface (card 5dcb5ae9, Atlas build
// plan P2-9: docs/plans/atlas-ui/03-decomposition.md row P2-9, closing parity gap §J.4).
//
// §J.4 was a gap in the round-4 MOCKUP, not in the built Atlas: `atlas.js`'s `wireBoardBar` wired only
// free-text search plus a SINGLE-select priority chip, with no lane filter at all. The built Atlas has
// nothing to re-implement — all four of its board surfaces mount the one `<Board>` (pages/Board.tsx),
// whose `FilterBar` renders unconditionally (there is no embed mode, no `hideFilters` prop, and the bar
// is styled entirely inline so no stylesheet can hide it per-context). So this spec is the WITNESS that
// each surface really does get the real `Set`-based filters — a different claim from "they share an
// import", and the only one worth asserting.
//
//   1. the project node's Overview tab   `/project?tab=overview`  (ProjectHome.tsx)
//   2. the project node's Deck tab       `/project?tab=deck`      (ProjectHome.tsx)
//   3. the Board node                    `/board`                 (nav.tsx NAV_PAGES)
//   4. the Platform node's Board tab     `/platform?tab=board`    (PlatformView.tsx)
//
// WHAT MAKES EACH LEG DISCRIMINATING — the mockup's single-select chip is the known-bad state every one
// of these is shaped to fail against, so none of them can pass for the wrong reason:
//   · MULTI-SELECT PRIORITY — after clicking P0 then P1, BOTH cards survive and BOTH chips read
//     `aria-pressed="true"`. A single-select chip leaves exactly ONE card and drops the first chip, so
//     it fails at two independent lines. Asserting only the COUNT would not discriminate here either:
//     the card TITLES are asserted, so "2 shown" can't be satisfied by the wrong two cards.
//   · MULTI-SELECT LANE — the two selected lanes are deliberately the ones holding the cards the
//     priority leg EXCLUDES, so its expected result set is the exact COMPLEMENT of the priority leg's.
//     A lane chip secretly wired to the priority filter (or vice versa) returns the other set and fails.
//   · THEY AND, THEY DO NOT OR — priority {P0,P1} with lanes {To Do, Inbox} leaves exactly the one card
//     in both. An OR would show three; a dimension that overwrote the other would show two.
//   · "N OF M SHOWN" — cross-checked at EVERY step against the number of card open-targets actually
//     rendered on that surface, so a count that drifts from the board it labels fails here instead of
//     agreeing with itself. `total` is also required to hold constant: the count is "of the whole
//     project", not "of what survived".
//   · ONE CLEAR RESETS BOTH — after one click every chip in BOTH dimensions reads `aria-pressed="false"`
//     and every card is back. The affordance's own absence while nothing is filtered is asserted too.
//
// Presence-first throughout (card 625d791c): a leading `toHaveCount(0)` is satisfied by a page that is
// merely still loading, so every pair asserts what must BE there before what must not. Every locator is
// scoped to the board container under test, never the page — nav labels collide with exact-text locators
// (project memory `atlas-nav-labels-collide-with-exact-text-locators`).
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import type { Locator } from "@playwright/test";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

// The default board layout (PLATFORM_DEFAULTS.kanbanColumns). Pinned as a constant so a change to it
// fails this spec loudly instead of quietly weakening the presence check into "whatever is on screen".
const DEFAULT_LANES = 7;

const VIEWPORT = { width: 1600, height: 1000 };

/**
 * The four seeded cards. Each is distinct in BOTH priority and lane, which is what lets one fixture
 * serve both multi-select dimensions — and the two dimensions' expected result sets are deliberately
 * DISJOINT (priority {P0,P1} ⇒ the first two; lanes {Inbox, Waiting} ⇒ the last two), so neither leg
 * can be satisfied by the other dimension's filter having been the one that actually fired.
 *
 * `label` is the chip's own accessible name on that dimension: `PRIORITY_META[p].label`
 * (components/priority.tsx) for priority, the column label (config.ts PLATFORM_DEFAULTS) for the lane.
 */
const SEED = [
  { slot: "p0todo", priority: "p0", priLabel: "Critical", columnKey: "todo", lane: "To Do" },
  { slot: "p1review", priority: "p1", priLabel: "High", columnKey: "review", lane: "Review" },
  { slot: "p2inbox", priority: "p2", priLabel: "Normal", columnKey: "inbox", lane: "Inbox" },
  { slot: "p3waiting", priority: "p3", priLabel: "Low", columnKey: "waiting", lane: "Waiting" },
] as const;

type Slot = (typeof SEED)[number]["slot"];
type SeededCards = Record<Slot, { id: string; title: string }>;

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Writes only while the key is still absent: addInitScript re-runs on every navigation, so an
// unconditional write would re-pin on a reload and that leg would measure this helper (card e47df20a).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** The four cards above, seeded into one project. Titles carry a sentinel so they cannot collide. */
async function seedCards(loomDaemon: LoomDaemon, projectId: string): Promise<SeededCards> {
  const out = {} as SeededCards;
  for (const s of SEED) {
    const title = uniq(`filtercard-${s.slot}-SENTINEL`);
    const task = await loomDaemon.createTask(projectId, { title, columnKey: s.columnKey, priority: s.priority });
    out[s.slot] = { id: task.id, title };
  }
  return out;
}

// A board lane is the `.loom-grid` wrapper inside `.loom-board-grid`, scoped through the grid so the
// Panels around it can never be counted as lanes (same idiom as board.spec.ts / atlas-board-dialog).
const lanesIn = (scope: Locator) => scope.locator(".loom-board-grid > .loom-grid");

// Every card's own open target — exactly one per rendered card (pages/Board.tsx `Card`, and `Column`
// renders `tasks.map` with no slicing), which is what makes counting these a sound cross-check on the
// bar's own "N of M shown". Located by the class rather than the title because a card renders its
// PARENT's title as a chip, so title text is not unique board text (card 1ae4f88c).
const openTargetsIn = (scope: Locator) => scope.locator(".loom-board-open");
const cardIn = (scope: Locator, title: string) => openTargetsIn(scope).filter({ hasText: title });

const searchIn = (scope: Locator) => scope.getByLabel("Search tasks by id, title, or description");
const priChip = (scope: Locator, label: string) => scope.getByRole("button", { name: `Filter by ${label} priority` });
const colChip = (scope: Locator, label: string) => scope.getByRole("button", { name: `Filter by ${label} column` });
const clearIn = (scope: Locator) => scope.getByRole("button", { name: "Clear filters" });
// The live count span. Matched by shape, not by a literal, so this locator cannot go stale against the
// numbers it is about to be asserted on.
const countIn = (scope: Locator) => scope.getByText(/^\d+ of \d+ shown$/);

/** Parse the bar's own "N of M shown" readout. */
async function readCount(scope: Locator): Promise<{ shown: number; total: number }> {
  const raw = (await countIn(scope).innerText()).trim();
  const m = /^(\d+) of (\d+) shown$/.exec(raw);
  expect(m, `the filter bar's count readout should be "N of M shown", got ${JSON.stringify(raw)}`).not.toBeNull();
  return { shown: Number(m![1]), total: Number(m![2]) };
}

/**
 * The count readout agrees with the board it labels, and `total` has not moved.
 *
 * `shown` is cross-checked against the number of card open-targets actually rendered — the assertion
 * that makes this a real check rather than the bar confirming its own arithmetic. `total` is the whole
 * project's card count, so it must hold constant across every filter step; a `total` that tracked the
 * filtered view would make "N of M" read "4 of 4" at every step and say nothing.
 */
async function assertCountAgreesWithBoard(scope: Locator, total: number, label: string) {
  // Both sides are read inside the SAME poll tick: polling the readout against a card count captured
  // once up front would compare a settled reading to a stale one while the 4s board query re-resolves.
  await expect.poll(async () => {
    const { shown } = await readCount(scope);
    const rendered = await openTargetsIn(scope).count();
    return shown === rendered ? "agree" : `readout says ${shown}, the board renders ${rendered}`;
  }, { message: `${label}: "N of M shown" should equal the cards actually rendered` }).toBe("agree");
  expect((await readCount(scope)).total, `${label}: the total is the whole project, not the filtered view`).toBe(total);
}

/**
 * One board surface, end to end: the real multi-select filters are present, both dimensions
 * multi-select independently, they AND, and one clear resets everything.
 *
 * `exactTotal` is the project's known card count where the population is known (a freshly-created
 * project holds exactly the four seeded cards). The reserved Platform home is SHARED with every other
 * spec on this worker's daemon, so that leg passes `null` and asserts only the foreign-card-proof
 * facts: this spec's own four cards' visibility, that `shown` strictly narrows, and that the readout
 * keeps agreeing with the rendered board. Nothing is asserted there that a sibling spec's leftover
 * card could move.
 */
async function assertMultiSelectFilters(
  scope: Locator,
  cards: SeededCards,
  label: string,
  exactTotal: number | null,
) {
  // ── PRESENCE: the surface, its whole board, all four cards, and the real bar are all really here…
  await expect(scope, `${label}: the board surface`).toBeVisible();
  await expect(lanesIn(scope), `${label}: the whole board`).toHaveCount(DEFAULT_LANES);
  for (const s of SEED) {
    await expect(cardIn(scope, cards[s.slot].title), `${label}: the seeded ${s.slot} card`).toBeVisible();
  }
  await expect(searchIn(scope), `${label}: the search field`).toBeVisible();
  for (const s of SEED) {
    await expect(priChip(scope, s.priLabel), `${label}: the ${s.priLabel} priority chip`).toBeVisible();
    await expect(colChip(scope, s.lane), `${label}: the ${s.lane} lane chip`).toBeVisible();
  }
  await expect(countIn(scope), `${label}: the "N of M shown" readout`).toBeVisible();

  const total = (await readCount(scope)).total;
  if (exactTotal !== null) {
    expect(total, `${label}: a freshly-seeded project holds exactly the four seeded cards`).toBe(exactTotal);
    await expect(countIn(scope)).toHaveText(`${exactTotal} of ${exactTotal} shown`);
  }
  await assertCountAgreesWithBoard(scope, total, `${label}: unfiltered`);
  // …and only THEN that nothing is filtered yet.
  await expect(clearIn(scope), `${label}: "Clear filters" appears only once a filter is active`).toHaveCount(0);

  // ── LEG 1. MULTI-SELECT PRIORITY: P0, then P0+P1 together. ──────────────────────────────────────
  await priChip(scope, "Critical").click();
  await expect(priChip(scope, "Critical")).toHaveAttribute("aria-pressed", "true");
  await expect(cardIn(scope, cards.p0todo.title), `${label}: P0 alone keeps the P0 card`).toBeVisible();
  await expect(cardIn(scope, cards.p1review.title), `${label}: P0 alone drops the P1 card`).toHaveCount(0);
  // The one-chip reading is captured so the two-chip reading below is shown to be a real WIDENING of
  // the result set. Without it, "2 shown" could be the first chip having been replaced by the second.
  const onePri = (await readCount(scope)).shown;
  await assertCountAgreesWithBoard(scope, total, `${label}: P0 only`);

  await priChip(scope, "High").click();
  // THE multi-select assertion. A single-select chip fails BOTH of these lines: the first chip would
  // have been dropped, and only one of the two cards would survive.
  await expect(priChip(scope, "Critical"),
    `${label}: the first priority chip STAYS on — a single-select would have dropped it`).toHaveAttribute("aria-pressed", "true");
  await expect(priChip(scope, "High")).toHaveAttribute("aria-pressed", "true");
  await expect(cardIn(scope, cards.p0todo.title), `${label}: P0+P1 keeps the P0 card`).toBeVisible();
  await expect(cardIn(scope, cards.p1review.title), `${label}: P0+P1 keeps the P1 card`).toBeVisible();
  // …and it is genuinely narrowing, not merely showing everything: the unselected priorities are gone.
  await expect(cardIn(scope, cards.p2inbox.title), `${label}: P0+P1 drops the P2 card`).toHaveCount(0);
  await expect(cardIn(scope, cards.p3waiting.title), `${label}: P0+P1 drops the P3 card`).toHaveCount(0);
  expect((await readCount(scope)).shown,
    `${label}: adding a second priority WIDENS the result set (${onePri} → more)`).toBeGreaterThan(onePri);
  await assertCountAgreesWithBoard(scope, total, `${label}: P0+P1`);
  if (exactTotal !== null) await expect(countIn(scope)).toHaveText(`2 of ${exactTotal} shown`);

  // A lane the filter emptied says so, rather than reading as a broken blank — the filtered-empty
  // state is a second, independent observable that the filter really is in force on THIS surface.
  await expect(scope.getByText("no matches").first(), `${label}: a filtered-empty lane says so`).toBeVisible();

  await clearIn(scope).click();
  await expect(countIn(scope), `${label}: clearing the priority filter restores the board`).toHaveText(`${total} of ${total} shown`);
  await expect(priChip(scope, "Critical")).toHaveAttribute("aria-pressed", "false");
  await expect(priChip(scope, "High")).toHaveAttribute("aria-pressed", "false");

  // ── LEG 2. MULTI-SELECT LANE: Inbox, then Inbox+Waiting — the COMPLEMENT of leg 1's result set. ──
  await colChip(scope, "Inbox").click();
  await expect(colChip(scope, "Inbox")).toHaveAttribute("aria-pressed", "true");
  await expect(cardIn(scope, cards.p2inbox.title), `${label}: Inbox alone keeps the Inbox card`).toBeVisible();
  await expect(cardIn(scope, cards.p3waiting.title), `${label}: Inbox alone drops the Waiting card`).toHaveCount(0);
  const oneCol = (await readCount(scope)).shown;
  await assertCountAgreesWithBoard(scope, total, `${label}: Inbox only`);

  await colChip(scope, "Waiting").click();
  await expect(colChip(scope, "Inbox"),
    `${label}: the first lane chip STAYS on — the mockup had no lane filter at all, let alone a multi-select one`).toHaveAttribute("aria-pressed", "true");
  await expect(colChip(scope, "Waiting")).toHaveAttribute("aria-pressed", "true");
  await expect(cardIn(scope, cards.p2inbox.title), `${label}: Inbox+Waiting keeps the Inbox card`).toBeVisible();
  await expect(cardIn(scope, cards.p3waiting.title), `${label}: Inbox+Waiting keeps the Waiting card`).toBeVisible();
  // The complement: the two cards leg 1 kept are exactly the two this leg must drop. A lane chip wired
  // to the priority filter would have returned leg 1's set here and fails on these two lines.
  await expect(cardIn(scope, cards.p0todo.title), `${label}: Inbox+Waiting drops the To Do card`).toHaveCount(0);
  await expect(cardIn(scope, cards.p1review.title), `${label}: Inbox+Waiting drops the Review card`).toHaveCount(0);
  expect((await readCount(scope)).shown,
    `${label}: adding a second lane WIDENS the result set (${oneCol} → more)`).toBeGreaterThan(oneCol);
  await assertCountAgreesWithBoard(scope, total, `${label}: Inbox+Waiting`);
  if (exactTotal !== null) await expect(countIn(scope)).toHaveText(`2 of ${exactTotal} shown`);

  // ── LEG 3. THE TWO DIMENSIONS AND, THEY DO NOT OR. ──────────────────────────────────────────────
  // priority {P0,P1} ∧ lanes {To Do, Inbox} ⇒ only the P0/To Do card is in both.
  // An OR would show three (P0/To Do, P1/Review, P2/Inbox); one dimension overwriting the other, two.
  await priChip(scope, "Critical").click();
  await priChip(scope, "High").click();
  await colChip(scope, "Waiting").click(); // off — lanes become {Inbox}
  await colChip(scope, "To Do").click();   // on  — lanes become {Inbox, To Do}
  await expect(cardIn(scope, cards.p0todo.title), `${label}: the one card in both sets survives`).toBeVisible();
  for (const s of ["p1review", "p2inbox", "p3waiting"] as const) {
    await expect(cardIn(scope, cards[s].title),
      `${label}: ${s} matches only ONE dimension, so an AND must drop it`).toHaveCount(0);
  }
  await assertCountAgreesWithBoard(scope, total, `${label}: P0+P1 AND To Do+Inbox`);
  if (exactTotal !== null) await expect(countIn(scope)).toHaveText(`1 of ${exactTotal} shown`);

  // ── LEG 4. ONE CLEAR RESETS BOTH DIMENSIONS. ────────────────────────────────────────────────────
  await clearIn(scope).click();
  await expect(countIn(scope), `${label}: one clear restores the whole board`).toHaveText(`${total} of ${total} shown`);
  for (const s of SEED) {
    await expect(priChip(scope, s.priLabel), `${label}: the ${s.priLabel} chip is off after clear`).toHaveAttribute("aria-pressed", "false");
    await expect(colChip(scope, s.lane), `${label}: the ${s.lane} chip is off after clear`).toHaveAttribute("aria-pressed", "false");
    await expect(cardIn(scope, cards[s.slot].title), `${label}: ${s.slot} is back after clear`).toBeVisible();
  }
  await assertCountAgreesWithBoard(scope, total, `${label}: after clear`);
  // The affordance itself is gone again — it is rendered only while a filter is active.
  await expect(clearIn(scope), `${label}: "Clear filters" disappears once nothing is filtered`).toHaveCount(0);
}

test.describe("the Board's multi-select filters on every Atlas board surface (card 5dcb5ae9)", () => {
  // ── 1 + 2. The project node's two tabs ──────────────────────────────────────────────────────────
  test("switch ON: the project node's Overview and Deck tabs both carry the real multi-select filters", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("atlasfilt-project"));
    const cards = await seedCards(loomDaemon, project.id);

    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.setViewportSize(VIEWPORT);

    const embed = page.getByTestId("atlas-board-embed");

    await page.goto(`${loomDaemon.baseURL}/project?tab=overview`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await assertMultiSelectFilters(embed, cards, "project node · Overview", SEED.length);

    // The Deck tab is the board-FIRST read of the same node — a different layout above the same
    // `<Board>`, and a separate mount, so its filter state starts fresh and is asserted from scratch.
    await page.goto(`${loomDaemon.baseURL}/project?tab=deck`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await assertMultiSelectFilters(embed, cards, "project node · Deck", SEED.length);
  });

  // ── 3. The Board node ───────────────────────────────────────────────────────────────────────────
  test("switch ON: the Board node carries the real multi-select filters", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("atlasfilt-boardnode"));
    const cards = await seedCards(loomDaemon, project.id);

    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.setViewportSize(VIEWPORT);
    await page.goto(`${loomDaemon.baseURL}/board`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();

    await assertMultiSelectFilters(page.locator("main"), cards, "Board node", SEED.length);
  });

  // ── 4. The Platform node's own Board tab ────────────────────────────────────────────────────────
  test("switch ON: the Platform node's Board tab carries the real multi-select filters", async ({ page, loomDaemon }) => {
    // The Platform node's board is the reserved home's, never the active project's (card fa3bb729) —
    // so the cards have to be seeded THERE, and removed after: that board is shared with every other
    // spec on this worker's daemon (card 1d3192dc trap 1). Being shared is also why this leg passes
    // `exactTotal: null` — see assertMultiSelectFilters' own doc.
    const res = await fetch(`${loomDaemon.baseURL}/api/setup/home`, { headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` } });
    expect(res.ok, `GET /api/setup/home -> ${res.status}`).toBe(true);
    const home = (await res.json()) as { project: { id: string; name: string } };
    expect(home.project.name, "the reserved home this leg seeds into").toBe("Platform");

    const cards = await seedCards(loomDaemon, home.project.id);
    // A SECOND project, pinned active, so "the Platform board's filters narrowed the Platform board"
    // cannot be satisfied by the active project's board having been rendered here instead.
    const other = await loomDaemon.createProject(uniq("atlasfilt-zulu"));

    try {
      await seedAtlasOn(page);
      await pinProject(page, other.id);
      await page.setViewportSize(VIEWPORT);
      await page.goto(`${loomDaemon.baseURL}/platform?tab=board`);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();

      await assertMultiSelectFilters(page.getByTestId("platform-panel-board"), cards, "Platform node · Board", null);
    } finally {
      for (const s of SEED) {
        await fetch(`${loomDaemon.baseURL}/api/tasks/${cards[s.slot].id}`, { method: "DELETE" }).catch(() => {});
      }
    }
  });

  // ── The other polarity ──────────────────────────────────────────────────────────────────────────
  test("switch OFF: the classic board's filters are untouched", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("atlasfilt-classic"));
    const cards = await seedCards(loomDaemon, project.id);

    await pinProject(page, project.id); // no seedAtlasOn — OFF is the default
    await page.setViewportSize(VIEWPORT);
    await page.goto(`${loomDaemon.baseURL}/board`);

    // PRESENCE: the classic shell is really the one that mounted…
    await expect(page.locator(".loom-rail")).toBeVisible();
    // …and nothing Atlas is in the document, so this leg cannot be measuring the Atlas frame.
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);

    await assertMultiSelectFilters(page.locator("main"), cards, "classic Board page", SEED.length);
  });
});
