// The Atlas dashboard band's TRACK BUDGET — card b4442d27, the band-layout half of the defect card
// a7957bde closed the row half of. WHY the weights are what they are, every before/after figure, and
// the alternatives that were rejected: docs/decisions/b4442d27-atlas-pulse-band-track-budget.md.
// This header covers only what each leg here asserts and how it can fail.
//
// @decision b4442d27 — the band's fifth track is Pulse on both nodes and its appetite is additive.
// Never flatten it back toward 1fr, never remove its 308px floor, and never buy Pulse width by
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
//   * The 308px FLOOR binds at the narrow end. At 1280 Pulse's proportional share is ~291px, so a
//     reading at or above 308 is the floor doing work rather than the weight.
//   * Every run measures the WIDEST 12h timestamp (card 6ba79d7c): the describe pins `locale` and a
//     runtime-computed `timezoneId` (`widestTimestampTimezone`), and each row asserts the pin took.
//     Unpinned, the chip reading tracked the wall clock — 22.11px at a one-digit hour, 14.92 at two.
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
const PULSE_TRACK_FLOOR = 308;

/**
 * The browser timezone that puts the seeded events' LOCAL hour on 11 — card 6ba79d7c.
 *
 * WHY: `EventRow` renders its never-shrinking timestamp with `toLocaleTimeString()`, and in en-US's
 * 12h format an hour of 10, 11 or 12 is one glyph wider than 1–9 (+7.2031px at 12px mono). The chip
 * pays that width 1:1, so unpinned this leg measured whatever the WALL CLOCK said: green for 18 hours
 * a day, red at 14.92px for the other 6. Pinning it measures the WIDEST timestamp every run.
 *
 * Hour 11 rather than 10 or 12 because the seeds land seconds after this is computed: a rollover
 * moves 11 to 12, which is still two digits. `Etc/GMT` names are fixed-offset (no DST) and their sign
 * is INVERTED (`Etc/GMT-5` is UTC+5); offsets land in [-11, +12], all valid names.
 */
function widestTimestampTimezone(now = new Date()): string {
  let offset = (11 - now.getUTCHours() + 24) % 24;
  if (offset > 12) offset -= 24;
  return offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
}
/** What `widestTimestampTimezone` must produce on screen — asserted, so a broken pin fails loudly. */
const WIDE_TIMESTAMP = /^1[0-2]:\d\d:\d\d [AP]M$/;

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
  own: { time: number; timeText: string; chip: number | null; chipText: number | null; kind: number; kindText: number }[];
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
        time: contentW(time) ?? -1, timeText: (time?.textContent ?? "").trim(),
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
    // FIXTURE CONTROL: the timezone pin really produced the widest 12h timestamp (card 6ba79d7c).
    // Without it every width below is a reading of the wall clock, not of the layout.
    expect.soft(r.timeText, `${where}: timestamp must be the two-digit-hour worst case`).toMatch(WIDE_TIMESTAMP);
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
  // The worst-case timestamp, not the wall clock's — see `widestTimestampTimezone`.
  test.use({ locale: "en-US", timezoneId: widestTimestampTimezone() });
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

    // ── THE 308px FLOOR, at the width where it actually binds. Pulse's proportional share at 1280
    //    is ~291px, so a reading at or above 308 is the floor, not the 1.9fr weight. At 1920 the
    //    weight alone is far past it, which is why this is asserted at the narrow end only.
    const pulseAt = (width: number) => byWidth.get(width)?.panels.pulse ?? -1;
    expect.soft(pulseAt(1280), "1280px: the Pulse track's declared 308px floor")
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

  // 🔴 THE PROJECT NODE HAS NO BAND, AND ITS PULSE IS NOW PAID IN FULL. This leg used to assert
  // that the project node's band gave Pulse the same budgeted track the Workspace node's does —
  // "one grid, two nodes". Card 269f46ef removed that band on the owner's instruction and made
  // Pulse a FULL-WIDTH card there, so the claim's subject is gone and its premise with it.
  //
  // It is replaced rather than deleted, because the replacement is the stronger reading: this
  // record's own central measurement is that `EventRow` needs 479px for all four columns at natural
  // width and the band could only budget it 321px at 1440. A full-width card is the first
  // composition that clears that number, so the leg asserts the thing the budget was a compromise
  // FOR — every column at its natural width, no shrink anywhere — rather than re-checking a
  // compromise the node no longer makes.
  test("switch ON: the project node's Pulse is a full-width card, so no EventRow column is short at all", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const seeded = await seedPulseRows(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.projectId);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/project");

    // Presence of the node's own primary surface first, so the band's absence below is a loaded
    // page's real shape rather than one that has not rendered.
    await expect(page.getByTestId("atlas-overview-roster")).toBeVisible();
    await expect(page.getByTestId("atlas-banddisc-bar")).toHaveCount(0);
    await expect(page.getByTestId("atlas-dashboard-band")).toHaveCount(0);

    const pulse = page.getByTestId("atlas-band-pulse");
    await expect(pulse).toBeVisible();
    await expect(pulse.getByTestId("activity-event").first()).toBeVisible();

    // The card really is the content column's full width — the comparison that makes "full-width"
    // a measurement and not a label. Against the roster above it, which is the same single-column
    // row rhythm; a Pulse that had quietly gone back into a two-up footer would be ~half of it.
    const widths = await page.evaluate(() => {
      const of = (id: string) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        return el ? Math.round(el.getBoundingClientRect().width) : -1;
      };
      return { pulse: of("atlas-band-pulse"), roster: of("atlas-overview-roster") };
    });
    expect(widths.pulse, `pulse ${widths.pulse}px vs roster ${widths.roster}px`).toBe(widths.roster);
    expect(widths.pulse, "the content column at 1440 inside the Atlas frame").toBeGreaterThan(1000);

    // …and with that width, NO column of the event row is short of its natural text — not the kind
    // (which the band left 1/32px short at every width, this record's own §"the kind still loses
    // its last glyph"), and not the detail (151px short at 1440 in the band, 22px at 1920). This is
    // the first composition in the app where that is true, and it is why the leg is worth keeping.
    const shortfalls = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="atlas-band-pulse"] [data-testid="activity-event"]');
      if (!row) return null;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const out: { text: string; box: number; natural: number }[] = [];
      for (const el of Array.from(row.children) as HTMLElement[]) {
        const text = (el.textContent ?? "").trim();
        if (!text) continue;
        const cs = getComputedStyle(el);
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const box = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        out.push({ text, box, natural: ctx.measureText(text).width });
      }
      return out;
    });
    expect(shortfalls, "no event row to measure").not.toBeNull();
    expect(shortfalls!.length, "the event row's own columns").toBeGreaterThan(1);
    const tooNarrow = shortfalls!.filter((c) => c.natural - c.box > 0.5)
      .map((c) => `${JSON.stringify(c.text)}: ${c.box.toFixed(2)}px box vs ${c.natural.toFixed(2)}px natural`);
    expect(tooNarrow, "a Pulse column is still short of its natural width at full card width").toEqual([]);
  });
});
