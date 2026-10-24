// Mission Control's god-eye ACTIVITY feed at narrow widths (card a7957bde).
//
// Three separate defects met at 420px, and they are NOT one defect wearing three hats — the card
// attributed the page overflow to the event row, and a causal control disproved that before any fix
// was written (see docs/decisions/a7957bde-mission-control-activity-row-narrow-widths.md):
//   1. The four `Stat` tiles sat in a fixed 364px flex row that could neither wrap nor shrink. THAT is
//      what pushed `documentElement.scrollWidth` to 453 against a 420 viewport.
//   2. `.loom-mc-split` held its 1.4fr/1fr two-column grid at every width, leaving the Activity track
//      101px — narrower than the event row's own un-shrinkable timestamp.
//   3. `EventRow` (components/fleet.tsx) gave its project chip and kind columns `flexShrink: 0` with no
//      overflow, so the row overflowed its own box instead of ellipsizing — the same shape card
//      f51d3068 fixed in `ReplayEvent`, and the one the card actually named.
//
// `EventRow` is shared by six mounts, so the row claim is re-made on the Atlas Workspace Pulse band —
// the other god-eye feed that passes `projectName` — rather than assumed to carry across.
import { expect, test, type Locator, type Page } from "./fixtures/daemon";
import { FIT_CHECK_KINDS } from "./helpers/replayRow";

// lib/atlasUi.ts owns this key and the "1" = on encoding. Hardcoded because the e2e tsconfig covers
// `e2e/` only and cannot pull `src/` in (same reason atlas-wave-replay.spec.ts hardcodes it).
const ATLAS_KEY = "loom.atlasUi";

/** The widest chip the shrink cascade can leave before the kind is allowed to give anything at all. */
const CHIP_SPENT_PX = 14;

type RowGeom = {
  project: string;
  kind: string;
  /** Row content past its own box. > 0 means the row overflowed rather than ellipsized. */
  rowOverflow: number;
  /** px of each column's text hidden by its own ellipsis. */
  timeClipped: number;
  chipClipped: number;
  kindClipped: number;
  /** The chip's rendered inner width — how much it has left to give. */
  chipWidth: number;
  timeText: string;
  /** px the timestamp's edges sit outside its row's box. > 0 means cut. */
  timePast: number;
};

async function rowGeometry(scope: Locator): Promise<RowGeom[]> {
  return scope.getByTestId("activity-event").evaluateAll((rows) =>
    rows.map((row) => {
      const pick = (id: string) => row.querySelector(`[data-testid="activity-event-${id}"]`);
      const time = pick("time")!;
      const chip = pick("project");
      const kind = pick("kind")!;
      const r = row.getBoundingClientRect();
      const t = time.getBoundingClientRect();
      return {
        project: (chip?.textContent ?? "").trim(),
        kind: (kind.textContent ?? "").trim(),
        rowOverflow: Math.round(row.scrollWidth - row.clientWidth),
        timeClipped: Math.round(time.scrollWidth - time.clientWidth),
        chipClipped: chip ? Math.round(chip.scrollWidth - chip.clientWidth) : 0,
        kindClipped: Math.round(kind.scrollWidth - kind.clientWidth),
        chipWidth: chip ? chip.clientWidth : 0,
        timeText: (time.textContent ?? "").trim(),
        timePast: Math.round(Math.max(t.right - r.right, r.left - t.left)),
      };
    }));
}

/**
 * The row's own guarantee, asserted on EVERY rendered row (the god-eye feed is cross-project, so a
 * sibling spec's rows ride along — holding the claim over the superset is strictly stronger).
 *
 * `mine` pins the population so none of this is vacuous: an empty feed satisfies "every row fits", and
 * a feed carrying only a sibling's short kinds would never have been red pre-fix. Each leg is separately
 * falsifiable — the row-overflow leg is what `flexShrink: 0` broke, the timestamp legs rule out a row
 * that fits only because the time ellipsized or rendered empty, and the ordering leg is the one that
 * catches flattened shrink weights (which fit the row just fine while eating the primary scan token).
 */
async function expectRowShrinkPriority(scope: Locator, mine: string, label: string) {
  const rows = await rowGeometry(scope);
  const ours = rows.filter((r) => r.project === mine);
  expect(ours.length, `${label}: the feed rendered ${ours.length} rows for this spec's own project, not ` +
    `the ${FIT_CHECK_KINDS.length} seeded — every claim below would be vacuous`)
    .toBeGreaterThanOrEqual(FIT_CHECK_KINDS.length);

  const overflowing = rows.filter((r) => r.rowOverflow > 0);
  expect(overflowing, `${label}: ${overflowing.length} of ${rows.length} rows push content past their own ` +
    `box instead of ellipsizing — worst ${Math.max(0, ...rows.map((r) => r.rowOverflow))}px. ` +
    JSON.stringify(overflowing.slice(0, 3))).toHaveLength(0);

  const empty = rows.filter((r) => r.timeText === "");
  expect(empty, `${label}: ${empty.length} rows rendered an EMPTY timestamp, so their fit proves nothing`)
    .toHaveLength(0);

  const cutTime = rows.filter((r) => r.timeClipped > 0 || r.timePast > 0);
  expect(cutTime, `${label}: ${cutTime.length} rows cut their timestamp. It is the one column a reader ` +
    `cannot reconstruct from its neighbours, so it must never be what gives: ` +
    JSON.stringify(cutTime.slice(0, 3))).toHaveLength(0);

  // THE ORDERING. Measured rather than derived: flexbox distributes a deficit proportionally to
  // shrink x base, not as a strict cascade, so the weights alone do not prove the order.
  const outOfOrder = rows.filter((r) => r.kindClipped > 0 && r.chipWidth > CHIP_SPENT_PX);
  expect(outOfOrder, `${label}: ${outOfOrder.length} rows ellipsize the event KIND while the project ` +
    `chip still has width to give (> ${CHIP_SPENT_PX}px). The chip is recoverable from the row's ` +
    `siblings and its hover title; the kind is the row's primary scan token, so it gives LAST: ` +
    JSON.stringify(outOfOrder.slice(0, 3))).toHaveLength(0);
}

/** Seed the real kind vocabulary, serially — the long names are what consume the row's width. */
async function seedActivity(
  loomDaemon: { seedOrchestrationEvent: (e: { managerSessionId: string; kind: string; workerSessionId?: string; taskId?: string }) => Promise<string> },
  managerSessionId: string,
) {
  for (const kind of FIT_CHECK_KINDS) await loomDaemon.seedOrchestrationEvent({ managerSessionId, kind });
  // One row with a non-empty DETAIL column, so the column that is supposed to give FIRST actually has
  // something to give — without it the cascade's first step is never exercised.
  await loomDaemon.seedOrchestrationEvent({
    managerSessionId, kind: "worker_report",
    workerSessionId: "7cb59094-c7d2-417e-be43-d91bf7ee47fa", taskId: "a7957bde-8224-4e12-a1d2-cb1cfb511ddc",
  });
}

async function pageWidth(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

test.describe("Mission Control's activity feed at narrow widths (card a7957bde)", () => {
  test("at 420 the page does not scroll sideways and the activity row ellipsizes in priority order; 1440 is untouched",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const proj = await loomDaemon.createProject(`mc-activity-${Date.now()}`);
      const mgr = await loomDaemon.seedLiveSession({ project: proj, role: "manager", agentName: "ActivityMgr" });
      await seedActivity(loomDaemon, mgr.sessionId);

      // ── 420: the narrow case the card is about ────────────────────────────────────────────────
      await page.setViewportSize({ width: 420, height: 900 });
      await page.goto(`${loomDaemon.baseURL}/`);
      const main = page.locator("main");
      await expect(main.getByTestId("activity-event").first(),
        "the god-eye activity feed rendered no rows at 420px").toBeVisible();

      // (1) The page itself. Pre-fix this read 453 against a 420 viewport.
      const narrow = await pageWidth(page);
      expect(narrow.scrollWidth,
        `Mission Control scrolls sideways at 420px: documentElement.scrollWidth ${narrow.scrollWidth} ` +
        `against a ${narrow.clientWidth}px viewport`).toBeLessThanOrEqual(narrow.clientWidth);

      // (2) The element that actually caused it — asserted directly, so a future regression names the
      //     stat strip rather than pointing the next reader back at the activity row the card blamed.
      const stripPast = await page.getByTestId("mc-stat-strip").evaluate((el) =>
        Math.round(el.getBoundingClientRect().right - document.documentElement.clientWidth));
      expect(stripPast, `the four Stat tiles sit ${stripPast}px past the right edge at 420px — they must ` +
        `wrap, not hold one fixed row`).toBeLessThanOrEqual(0);

      // (3) The row's own guarantee.
      await expectRowShrinkPriority(main, proj.name, "classic Mission Control @420");

      // ── 1440: the control. The desktop layout was already correct, so this leg is what catches a fix
      //    that buys the narrow case by spending the wide one.
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${loomDaemon.baseURL}/`);
      await expect(main.getByTestId("activity-event").first()).toBeVisible();

      const wide = await pageWidth(page);
      expect(wide.scrollWidth).toBeLessThanOrEqual(wide.clientWidth);
      await expectRowShrinkPriority(main, proj.name, "classic Mission Control @1440");

      // At 1440 the Activity column is wide enough that NOTHING gives — the row renders every column at
      // full content width. That is the pre-fix 1440 rendering, pinned so it stays unchanged.
      const wideRows = (await rowGeometry(main)).filter((r) => r.project === proj.name);
      const giving = wideRows.filter((r) => r.kindClipped > 0);
      expect(giving, `at 1440 the event kind should never be ellipsized — the column has room. ` +
        JSON.stringify(giving.slice(0, 3))).toHaveLength(0);
    });

  test("the Atlas Workspace Pulse band mounts the same row and keeps the same guarantee at 420 and 1440",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      await page.addInitScript((key) => {
        try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
      }, ATLAS_KEY);
      const proj = await loomDaemon.createProject(`atlas-activity-${Date.now()}`);
      const mgr = await loomDaemon.seedLiveSession({ project: proj, role: "manager", agentName: "PulseMgr" });
      await seedActivity(loomDaemon, mgr.sessionId);

      // 1440 is the TIGHTER case here, not the looser one: the band lays five panels across one row, so
      // the Pulse column is ~170px wide against the ~354px it gets at 420 in a single column.
      for (const width of [1440, 420]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${loomDaemon.baseURL}/home`);
        const pulse = page.getByTestId("atlas-band-pulse");
        await expect(pulse, `the Pulse band is missing at ${width}px`).toBeVisible();
        await expect(pulse.getByTestId("activity-event").first(),
          `the Pulse band rendered no rows at ${width}px`).toBeVisible();
        await expectRowShrinkPriority(pulse, proj.name, `Atlas Pulse band @${width}px`);
      }
    });
});
