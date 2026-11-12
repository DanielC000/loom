// The Workspace node's `plan` KPI tile across BOTH plan shapes (card 9ccad269).
//
// The owner's own account stopped reporting a 5h window: Anthropic adjusted the plan so only the
// weekly limit exists. The wire says so honestly — `available:true` with `fiveHour: null` and real
// `sevenDay` data (shared/protocol.ts) — but the tile was hard-wired to the 5h window, so it read
// "—" with the sub-line "loading…" permanently. The only branch that ever stated a reason was
// `!available`, and this plan IS available, so nothing on the page said what had happened.
//
// WHY EACH LEG CAN ACTUALLY FAIL — the two payload legs are each other's contrast case, over the
// SAME tile and the SAME assertions:
//   (1) 5h PRESENT must still read the 5h window (label, figure, reset, fill). A "just show 7d
//       always" fix passes leg (2) and fails here, which is the regression this leg exists to catch.
//   (2) 5h NULL must read the WEEKLY window — a real figure and a real reset, never "loading…".
//       The pre-fix tile passes leg (1) verbatim and fails here on all four.
// Both select on `atlas-kpi-plan`, which pre-dates this card, so a full revert fails on the tile's
// CONTENT rather than on a missing testid — the control discriminates the mechanism, not the markup.
//
// The usage payload is route-intercepted, not seeded: the daemon's plan-usage poller reads the HOST's
// real OAuth credentials, so a hermetic fixture daemon has no seed path for it AND an un-intercepted
// read would render the operator's live account. Intercepting is what makes this spec hermetic.
import { expect, test, type Page } from "./fixtures/daemon";
import { cssColor } from "./helpers/themeToken";

// Figures chosen to be mutually distinguishable, so an assertion can never pass by reading the wrong
// window: no two are equal, and the two the tile can show sit in DIFFERENT tone bands (phosphor < 80
// ≤ amber < 95 ≤ red), so the tone assertions are not all satisfied by one colour.
const FIVE_HOUR_PCT = 41;   // phosphor
const SEVEN_DAY_PCT = 87;   // amber
const OPUS_PCT = 12;

// Resets whose `relativeResets` renderings are in DIFFERENT grammatical forms — "in 2h Nm" vs
// "in 3d 1h" — so a "resets …" assertion cannot be satisfied by the other window's countdown. Each
// carries ~10 minutes of slack above its own rounding boundary, so neither string moves while the
// test runs (and the route re-bases both on every 30s refetch anyway).
const FIVE_HOUR_RESET_MS = (2 * 60 + 10) * 60 * 1000;             // ~2h10m → "in 2h 9m"
const SEVEN_DAY_RESET_MS = ((3 * 24 + 1) * 60 + 10) * 60 * 1000;  // ~3d1h10m → "in 3d 1h"

// The tile's tones are `--loom-accent-fg` (healthy: ink) and `--loom-attn-text` (80%+), resolved from the live tokens at the
// assertion (`cssColor`): they differ per theme, so a literal would pin one theme only.

/** The two plan shapes, both `available:true`. `withFiveHour:false` is the owner's own account. */
function usagePayload(withFiveHour: boolean) {
  const now = Date.now();
  return {
    available: true,
    fetchedAt: new Date(now).toISOString(),
    fiveHour: withFiveHour
      ? { utilization: FIVE_HOUR_PCT, resetsAt: new Date(now + FIVE_HOUR_RESET_MS).toISOString() }
      : null,
    sevenDay: { utilization: SEVEN_DAY_PCT, resetsAt: new Date(now + SEVEN_DAY_RESET_MS).toISOString() },
    sevenDayOpus: { utilization: OPUS_PCT, resetsAt: new Date(now + SEVEN_DAY_RESET_MS).toISOString() },
    sevenDaySonnet: null,
    extraUsage: null,
  };
}

/** Registered BEFORE `goto`, so the component's very first fetch is already the fixture's. */
async function routeUsage(page: Page, withFiveHour: boolean) {
  await page.route("**/api/usage/limits", async (route) => {
    await route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(usagePayload(withFiveHour)),
    });
  });
}

async function gotoWorkspace(page: Page, baseURL: string, withFiveHour: boolean) {
  await routeUsage(page, withFiveHour);
  await page.goto(baseURL + "/home");
  await expect(page.getByTestId("atlas-kpi-deck")).toBeVisible();
}

const planTile = (page: Page) => page.getByTestId("atlas-kpi-plan");

/**
 * The hairline fill's width, as a number. Read off the inline `style` rather than the computed box so
 * it is the RATIO the tile derived, not a pixel width that depends on the column — and so an absent
 * fill (what the pre-fix tile rendered on a weekly-only plan: `fill: undefined` draws no track at
 * all) fails loudly on the count assertion beside it rather than silently comparing NaN.
 */
async function fillPct(page: Page): Promise<number> {
  const fill = planTile(page).locator(".loom-kpi-fill");
  await expect(fill).toHaveCount(1);
  return Number((await fill.evaluate((el) => (el as HTMLElement).style.width)).replace("%", ""));
}

test.describe("Workspace plan tile — both plan shapes (card 9ccad269)", () => {
  test("5h present: the tile reads the 5h window, unchanged", async ({ page, loomDaemon }) => {
    await gotoWorkspace(page, loomDaemon.baseURL, true);
    const tile = planTile(page);

    // `toHaveText` retries, so the label assertion is also the settle: it cannot read "Plan 5h"
    // until the usage query has actually landed. (The deck sentence-cases the "plan 5h" source label.)
    await expect(tile.locator(".loom-kpi-label")).toHaveText("Plan 5h");
    await expect(tile.locator(".loom-kpi-value")).toHaveText(`${Math.round(FIVE_HOUR_PCT)}%`);
    // The 5h countdown, not the weekly one — the two render different grammatical forms, so a
    // weekly reset ("in 3d 1h") cannot satisfy this.
    await expect(tile.locator(".loom-kpi-sub")).toHaveText(/^resets in 2h \d+m$/);
    // 41% is under 80, so the figure stays healthy ink and the fill is the 5h ratio, not the weekly one.
    await expect(tile.locator(".loom-kpi-value")).toHaveCSS("color", await cssColor(page, "--loom-accent-fg"));
    expect(await fillPct(page)).toBeCloseTo(FIVE_HOUR_PCT, 3);

    // The pop-over lists every window the plan reports, 5h first, and names the 5h reset.
    await tile.click();
    const pop = page.getByTestId("atlas-kpi-pop-plan");
    await expect(pop).toContainText("5h session");
    await expect(pop).toContainText("7d weekly");
    await expect(pop).toContainText(/5h resets in 2h \d+m\./);
  });

  test("5h absent: the tile falls back to the weekly window, never 'loading…'", async ({ page, loomDaemon }) => {
    await gotoWorkspace(page, loomDaemon.baseURL, false);
    const tile = planTile(page);

    // All four of these are what the pre-fix tile got wrong: it read "plan 5h" / "—" / "loading…"
    // with no fill at all, forever, on a payload that was `available:true` the whole time.
    await expect(tile.locator(".loom-kpi-label")).toHaveText("Plan 7d");
    await expect(tile.locator(".loom-kpi-value")).toHaveText(`${Math.round(SEVEN_DAY_PCT)}%`);
    await expect(tile.locator(".loom-kpi-sub")).toHaveText("resets in 3d 1h");
    // Asserted explicitly as well as implied by the line above: "loading…" was the actual symptom,
    // so a future regression that reintroduced it should fail on its own name, not by inference.
    await expect(tile.locator(".loom-kpi-sub")).not.toContainText("loading");
    // 87% is in the attn band — so this also proves the tone is derived from the window actually
    // shown, not left muted the way the absent-5h branch used to leave it.
    await expect(tile.locator(".loom-kpi-value")).toHaveCSS("color", await cssColor(page, "--loom-attn-text"));
    expect(await fillPct(page)).toBeCloseTo(SEVEN_DAY_PCT, 3);

    // The pop-over omits the 5h row (there is no such window) and still names a reset — the weekly
    // one. Dropping the foot with the 5h window left a plan with no stated reset at all.
    await tile.click();
    const pop = page.getByTestId("atlas-kpi-pop-plan");
    await expect(pop).toContainText("7d weekly");
    await expect(pop).not.toContainText("5h session");
    await expect(pop).toContainText("7d resets in 3d 1h");
  });
});
