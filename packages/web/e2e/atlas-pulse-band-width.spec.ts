// The Atlas dashboard band's TRACK BUDGET — card b4442d27, the band-layout half of the defect card
// a7957bde closed the row half of. WHY the weights are what they are, every before/after figure, and
// the alternatives that were rejected: docs/decisions/b4442d27-atlas-pulse-band-track-budget.md.
// This header covers only what each leg here asserts and how it can fail.
//
// @decision b4442d27 — the band's fifth track is Pulse on both nodes and its appetite is additive.
// Never flatten it back toward 1fr, never remove its 300px floor, and never buy Pulse width by
// wrapping the band to a second row.
//
//   * The KIND's box is no longer what limits it — asserted as "within half a pixel of the text's own
//     natural width" AND over an absolute floor. The floor alone would pass on a column just wide
//     enough for a SHORT kind; the fit assertion alone would pass on a fixture whose kinds are all
//     short. The fixture seeds `worker_merge_confirm` (144px at 12px mono) for exactly that reason.
//     ⚠️ Natural width comes from a CANVAS text metric in the element's own resolved font, NOT from
//     `scrollWidth`: for an ellipsised `overflow:hidden` flex item, `scrollWidth`, `clientWidth` and
//     a `Range` ALL report the already-ellipsised integer width and are blind to a sub-pixel clip.
//     The 0.5px tolerance is sized to admit a measured 0.031px flex-shrink residue that is NOT this
//     card's to fix, while still failing the 82px clip it closed — both explained in the record.
//   * The project CHIP is off its floor. This is the leg that discriminates a real budget from a
//     token widening: the chip shrinks 1000x harder than the kind, so it only leaves min-content once
//     the kind is ALREADY satisfied — a direct read on surplus, not on fit.
//   * The band is still ONE ROW — the alternative this card rejected. The row-count collector is
//     shown able to return >1 at 1100px, where the band's own `auto-fit` fold genuinely wraps it;
//     without that leg "one row" could never fail.
//   * The 300px FLOOR binds at the narrow end. At 1280 Pulse's proportional share is ~291px, so a
//     reading at or above 300 is the floor doing work rather than the weight.
//   * SWITCH OFF renders no band at all, so none of this can have leaked into the classic Overview.
//
// FIXTURE IDENTITY (load-bearing): the Workspace Pulse feed is the CROSS-PROJECT god-eye stream, so a
// sibling spec's rows interleave with this run's. Every row measurement is scoped by this run's own
// worker session id, read off the row's DETAIL column text, and the population is pinned with a count
// of the rows that survived that filter against the total in the band. The detail column is the right
// hook rather than the project chip because the chip only exists on ONE of the two nodes (below).
import { randomUUID } from "node:crypto";
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding. Hardcoded rather than imported: the e2e
// tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

// The kind the fixture seeds, and its measured natural width at the row's 12px mono. The spec never
// asserts this literal — it asserts "not clipped" — but the floor below is chosen against it.
const SEEDED_KIND = "worker_merge_confirm";
/** The kind must clear this. Pre-fix it measured 34px at 1280, 62 at 1440, 144 at 1920. */
const KIND_MIN = 100;
/** The chip is measured as CONTENT width — its box minus its 10px padding and 2px border — so its
 *  min-content floor is a clean ZERO, which is what it measured pre-fix at 1280, 1440 AND 1920: a
 *  12px bordered box rendering no project name at all. Post-fix it measures ~22 / ~61 / ~78. This
 *  floor is set for what 1280 can give; the card's own width, 1440, is held to CHIP_MIN_1440. */
const CHIP_MIN = 16;
/** 1440 is the width the card was filed against, so it is asserted harder than the general floor:
 *  0px of chip content before, 43.36px measured after. Set below that with margin for fixture
 *  variation (the chip's natural width tracks the project NAME), and still 36× clear of the real
 *  defect boundary, which is a literal zero. */
const CHIP_MIN_1440 = 36;
/** `.loom-atlas-band`'s own declared floor for the Pulse track. */
const PULSE_TRACK_FLOOR = 300;

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Writes only while the key is still absent: addInitScript re-runs on every navigation, so an
// unconditional write would re-pin on a reload and the leg would be measuring this helper.
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

/**
 * A live manager + worker and six Pulse rows under them.
 *
 * The project name is deliberately long enough to give the chip a real natural width (~88px): a
 * chip whose own content already fits in 12px could never show this card's defect, and "the chip is
 * off its floor" would pass vacuously.
 */
async function seedPulseRows(loomDaemon: LoomDaemon) {
  const short = `s${Math.random().toString(36).slice(2, 9)}`.slice(0, 8);
  const project = await loomDaemon.createProject(`pulsewidth-${short}`);
  const mgr = await loomDaemon.seedLiveSession({ project, role: "manager", agentName: `PulseWidthMgr-${short}` });
  const wkr = await loomDaemon.seedLiveSession({
    project, agentId: mgr.agentId, role: "worker",
    id: `${short}-${randomUUID()}`, parentSessionId: mgr.sessionId,
    branch: `loom/pulse-width-${short}`, task: { title: `pulse-width-${short}` },
  });
  for (let i = 0; i < 6; i++) {
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: mgr.sessionId, kind: SEEDED_KIND,
      workerSessionId: wkr.sessionId, taskId: wkr.taskId,
    });
  }
  // The identity hook every row measurement filters on — `EventRow` renders `w:<first 8 of the
  // worker session id>` into its detail column on both nodes.
  const ownRow = `w:${wkr.sessionId.slice(0, 8)}`;
  return { project, projectId: mgr.projectId, projectName: project.name, mgr, wkr, short, ownRow };
}

type BandReading = {
  /** Distinct `offsetTop`s across the band's children — 1 while the band is one row. */
  rows: number;
  /** Every band panel's own column width, keyed by its testid suffix. */
  panels: Record<string, number>;
  pulseBody: number | null;
  /** One entry per row whose detail names THIS run's own worker. `chip` is null on the project node,
   *  which renders no project chip at all — see `assertPulseIsReadable`. Widths are CONTENT-box and
   *  fractional; `*Text` is the canvas metric of the same string in that element's own resolved font. */
  own: { time: number; chip: number | null; chipText: number | null; kind: number; kindText: number }[];
  /** Total rows in the band, this run's and every sibling's — the population `own` was filtered from. */
  allRows: number;
};

/** Reads the band's geometry and this run's own Pulse rows. Plain numbers, so a failure message
 *  carries the measurement rather than a selector. */
async function readBand(page: Page, detailNeedle: string, bandSelector: string): Promise<BandReading> {
  return page.evaluate(([needle, sel]) => {
    const band = document.querySelector(sel);
    const panels: Record<string, number> = {};
    for (const el of Array.from(band?.children ?? [])) {
      const id = (el as HTMLElement).dataset?.testid ?? "";
      if (id.startsWith("atlas-band-")) panels[id.slice("atlas-band-".length)] = Math.round(el.getBoundingClientRect().width);
    }
    const pulse = band?.querySelector('[data-testid="atlas-band-pulse"]') ?? null;
    const body = pulse?.querySelector(".loom-bandbody") ?? null;
    const allRows = Array.from(pulse?.querySelectorAll('[data-testid="activity-event"]') ?? []);
    // The natural width of an element's own text, in its own resolved font, independent of layout and
    // of any ellipsis the layout has already applied.
    const textW = (el: Element | null) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx) return null;
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      return Math.round(ctx.measureText(el.textContent ?? "").width * 1e4) / 1e4;
    };
    const contentW = (el: Element | null) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const bor = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      return Math.round((el.getBoundingClientRect().width - pad - bor) * 1e4) / 1e4;
    };
    const own: BandReading["own"] = [];
    for (const row of allRows) {
      const detail = row.querySelector('[data-testid="activity-event-detail"]');
      // The row CLIPS the detail to 0px at narrow widths, but its text content is still there — so
      // this identity filter is unaffected by the very geometry the spec is measuring.
      if (!(detail?.textContent ?? "").includes(needle)) continue;
      const chip = row.querySelector('[data-testid="activity-event-project"]');
      const kind = row.querySelector('[data-testid="activity-event-kind"]');
      const time = row.querySelector('[data-testid="activity-event-time"]');
      own.push({
        time: contentW(time) ?? -1,
        chip: contentW(chip), chipText: textW(chip),
        kind: contentW(kind) ?? -1, kindText: textW(kind) ?? -1,
      });
    }
    return {
      rows: band ? new Set(Array.from(band.children).map((c) => Math.round((c as HTMLElement).offsetTop))).size : -1,
      panels,
      pulseBody: body ? Math.round(body.getBoundingClientRect().width) : null,
      own, allRows: allRows.length,
    };
  }, [detailNeedle, bandSelector] as const);
}

/** Takes the reading twice and requires agreement before asserting: the band's tracks settle
 *  sub-pixel for a beat after mount, and an unsettled reading reports a change that never happened
 *  ([[atlas-ui-switch-and-shell-p1-0]] gotcha 2). */
async function settledBand(page: Page, detailNeedle: string, bandSelector: string, at: string) {
  let reading = await readBand(page, detailNeedle, bandSelector);
  await expect.poll(async () => {
    const next = await readBand(page, detailNeedle, bandSelector);
    const same = JSON.stringify(next) === JSON.stringify(reading);
    reading = next;
    return same;
  }, { message: `the band layout never settled at ${at}` }).toBe(true);
  return reading;
}

/**
 * `expectChip` is the node split, measured rather than assumed: `EventRow` takes `projectName` only
 * at the CROSS-PROJECT mount, so the Workspace band's rows carry a project chip and the project
 * node's rows have no chip element at all (every row there already belongs to the one project on
 * screen). Asserting a chip on the project node would fail against a deliberate absence.
 */
function assertPulseIsReadable(m: BandReading, at: string, expectChip: boolean, chipMin = CHIP_MIN) {
  // POPULATION FIRST: a measurement over zero rows passes every assertion below (card 625d791c).
  expect(m.own.length, `${at}: this run's own Pulse rows, filtered from ${m.allRows} rows in the band`)
    .toBeGreaterThanOrEqual(6);

  for (const [i, r] of m.own.entries()) {
    const where = `${at} row ${i}`;
    // INSTRUMENT CONTROL FIRST: the canvas metric must return the fixture kind's real natural width.
    // A broken font/metric read returns 0 and would make every "it fits" assertion below vacuous.
    expect.soft(r.kindText, `${where}: canvas natural width of "${SEEDED_KIND}" — the instrument itself`)
      .toBeGreaterThanOrEqual(140);
    // The kind's box is no longer the constraint — both halves, for the reason in this file's header.
    expect.soft(r.kind, `${where}: event kind box width (needs ${SEEDED_KIND} at ~144px)`).toBeGreaterThanOrEqual(KIND_MIN);
    expect.soft(r.kindText - r.kind, `${where}: event kind short by (box ${r.kind} of ${r.kindText} of text)`)
      .toBeLessThanOrEqual(0.5);
    // The chip off its ~10px min-content floor — the surplus read.
    if (expectChip) {
      expect.soft(r.chip, `${where}: project chip content width (its floor is ~0px of content; natural ${r.chipText})`)
        .toBeGreaterThanOrEqual(chipMin);
    } else {
      expect.soft(r.chip, `${where}: the project-scoped feed must render no project chip`).toBeNull();
    }
    // The timestamp never gives at all, per card a7957bde's record — so a "fix" that bought the kind by
    // shrinking the one column that must not shrink fails here rather than passing quietly.
    expect.soft(r.time, `${where}: timestamp width — it must never shrink`).toBeGreaterThanOrEqual(60);
  }
}

test.describe("Atlas dashboard band track budget (card b4442d27)", () => {
  test("switch ON: at 1280, 1440 and 1920 the Workspace Pulse band stops being what limits the event kind, keeps the project chip off its floor, and stays one band row", async ({ page, loomDaemon }) => {
    // Three viewports plus a fold control, each a full navigation.
    test.setTimeout(240_000);
    const seeded = await seedPulseRows(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.projectId);

    const byWidth = new Map<number, BandReading>();
    for (const width of [1280, 1440, 1920]) {
      const at = `${width}px`;
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(loomDaemon.baseURL + "/home");

      const pulse = page.getByTestId("atlas-band-pulse");
      await expect(pulse, `the Pulse band is missing at ${at}`).toBeVisible();
      await expect(pulse.getByTestId("activity-event").first(), `the Pulse band rendered no rows at ${at}`).toBeVisible();

      const m = await settledBand(page, seeded.ownRow, ".loom-atlas-band", at);
      byWidth.set(width, m);

      // 1440 is the card's own width, so it is held to the stricter chip reading.
      assertPulseIsReadable(m, at, true, width === 1440 ? CHIP_MIN_1440 : CHIP_MIN);

      // ── THE BAND IS STILL A BAND. Five panels, one row — the layout this card deliberately did
      //    NOT reach for (see the header). The fold control below proves this can read > 1.
      expect.soft(Object.keys(m.panels).sort(), `${at}: the band's five panels`)
        .toEqual(["gates", "needs", "operators", "plan", "pulse"]);
      expect.soft(m.rows, `${at}: distinct band rows — the band must stay one line at desktop widths`).toBe(1);

      // ── Pulse is the WIDEST track, which is the budget's whole shape: it is the only panel here
      //    whose appetite is additive (72px timestamp + chip + kind + detail) rather than a list
      //    that ellipsises against a title tooltip.
      const trackW = (key: string) => m.panels[key] ?? -1;
      for (const other of ["needs", "operators", "gates", "plan"]) {
        expect.soft(trackW("pulse"), `${at}: Pulse track vs the ${other} track`).toBeGreaterThan(trackW(other));
      }
    }

    // ── THE 300px FLOOR, at the width where it actually binds. Pulse's proportional share at 1280
    //    is ~291px, so a reading at or above 300 is the floor, not the 1.9fr weight. At 1920 the
    //    weight alone is far past it, which is why this is asserted at the narrow end only.
    const pulseAt = (width: number) => byWidth.get(width)?.panels.pulse ?? -1;
    expect.soft(pulseAt(1280), "1280px: the Pulse track's declared 300px floor")
      .toBeGreaterThanOrEqual(PULSE_TRACK_FLOOR);
    // And the budget really is width-responsive above the floor, not a fixed column.
    expect.soft(pulseAt(1920), `1920px: Pulse vs its 1440px width (${pulseAt(1440)}) — the track still grows`)
      .toBeGreaterThan(pulseAt(1440));

    // ── THE POSITIVE CONTROL for the one-row collector. At 1100px the band's own `auto-fit` fold
    //    (`max-width: 1180px`) genuinely wraps it, so `rows` must read > 1 here. Without this leg
    //    `toBe(1)` above could be passing on a collector that can only ever return 1.
    await page.setViewportSize({ width: 1100, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-band-pulse")).toBeVisible();
    const folded = await settledBand(page, seeded.ownRow, ".loom-atlas-band", "1100px");
    expect(folded.rows, "1100px: the band's own auto-fit fold must wrap it — this is what proves the " +
      "one-row assertions above are falsifiable").toBeGreaterThan(1);
  });

  test("switch ON: the project node's band gets the same Pulse budget — one grid, two nodes", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedPulseRows(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.projectId);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/project");

    // The project node folds its band behind a disclosure (card 44f725fe) and it opens by default;
    // unfold it if this fixture's stored state has it shut, so the leg measures the band either way.
    const bar = page.getByTestId("atlas-banddisc-bar");
    await expect(bar).toBeVisible();
    if ((await bar.getAttribute("aria-expanded")) !== "true") await bar.click();
    await expect(page.getByTestId("atlas-dashboard-band")).toBeVisible();

    const pulse = page.getByTestId("atlas-band-pulse");
    await expect(pulse).toBeVisible();
    await expect(pulse.getByTestId("activity-event").first()).toBeVisible();

    const m = await settledBand(page, seeded.ownRow, "#atlas-dashboard-band", "project node @1440px");
    // No chip on this node — the feed is project-scoped. The KIND is what this leg carries over.
    assertPulseIsReadable(m, "project node @1440px", false);
    expect.soft(m.rows, "project node @1440px: the band must stay one line").toBe(1);
  });

  test("switch OFF: the classic Overview renders no dashboard band at all, so the budget cannot have leaked into it", async ({ page, loomDaemon }) => {
    const seeded = await seedPulseRows(loomDaemon);
    // Deliberately NO seedAtlasOn — off is the default, and seeding it off would re-clear the key on
    // every navigation for a reason unrelated to the app (measured on P1-0).
    await pinProject(page, seeded.projectId);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/overview");

    // PRESENCE of the classic page first: an absence claim on a page that never loaded is vacuous.
    await expect(page.getByTestId("atlas-board-embed")).toHaveCount(0);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator(".loom-atlas-band")).toHaveCount(0);
    await expect(page.getByTestId("atlas-band-pulse")).toHaveCount(0);
  });
});
