// The Atlas "Needs you" band's attention-row SHAPE — card d0d430d4, two pre-existing defects that
// shipped with P2-1's band layout (`fd99b2d7`) and were found by two later cards' eyeballs:
//   (1) the row's action overflowed the band. MEASURED on /home at 1600×1000 before the fix:
//       "Answer →" box ended at x=597 against a band body ending at x=576 — cut in half — and the ×
//       landed at 630, outside the panel (589) entirely.
//   (2) the row's text span collapsed to 0px wide and wrapped ONE CHARACTER PER LINE, rendering a
//       500px-tall row of invisible text that pushed the merge rows below a 300px panel's fold at
//       420px. `overflow:hidden` makes the span's automatic minimum size 0, so it absorbs all of the
//       flex shrink, and with no `white-space:nowrap` what is left wraps per character.
// Both are fixed by an OPT-IN `compact` shape on `AttentionRow`, passed by `AttentionList` alone —
// see docs/decisions/d0d430d4-atlas-band-attention-row-shape.md.
//
// WHAT MAKES EACH LEG MORE THAN A RENDER CHECK:
//   * The action is MEASURED against the band body's own box at BOTH widths, and then CLICKED, with
//     the shared Request modal appearing as the observable — "inside the panel" and "actually
//     reachable" are two different claims and a clipped button can still satisfy one of them.
//   * The text leg asserts a NON-ZERO width AND a one-line height AND `white-space: nowrap`. The
//     width is the half that fails if only `nowrap` is added (the span still shrinks to 0 and shows
//     nothing); the height is the half that fails if only the flex basis is fixed.
//   * The overflow sweep is the card's own sound check — `scrollWidth > clientWidth` over boxes whose
//     COMPUTED `overflow-x` is `visible`. Skipping boxes with an x-scrollable ancestor would be
//     vacuous here: the band body is `overflow-y:auto`, which forces its own `overflow-x` to `auto`.
//   * SWITCH OFF pins the CLASSIC row's DOM: the text span is still a DIRECT child of the row frame,
//     still wraps (`white-space: normal`), the `flex:1` spacer is still beside it, and the band's own
//     action line does not exist anywhere on the page. That shape is what `c2968651`'s decision record
//     forbids changing, and scoping the fix to the band is what this leg measures.
//
// FIXTURE IDENTITY (load-bearing): the e2e daemon is SHARED, so a sibling spec's pending Request
// renders a byte-identical row. Every locator is scoped to this run's own manager/worker session id
// via the `data-session-id` hook (card ed0858dc), or to a per-run sentinel title.
import { randomUUID } from "node:crypto";
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding. Hardcoded rather than imported: the e2e
// tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

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

const shortPrefix = () => `s${Math.random().toString(36).slice(2, 9)}`.slice(0, 8);

/**
 * A pending DECISION whose title is long enough to overflow a ~300px column on its own, plus a
 * pending review so the band also carries a FOOTER-bearing row (card c2968651's merge action).
 *
 * The merge half needs both a live manager AND a live worker: `useAttention` keeps a merge item only
 * while its manager is live and `liveWorker(workerSessionId)` holds (lib/attention.ts). Both are
 * `processState:"live"` DB rows via the test-only seed verb — never startSession, which would spawn a
 * real claude and trip this fixture's no-spawn guard.
 */
async function seedBandRows(loomDaemon: LoomDaemon) {
  const short = shortPrefix();
  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: `BandShape-${short}` });
  // ~110 characters: a realistic owner ask, and far past what any of these widths can show.
  const title = `Approve the ${short} rollout of the merge-gate cadence change across every bound project before the next landing`;
  await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, type: "decision", title,
    body: "Long-title fixture for the band row shape.", options: ["Approve", "Hold"],
  });
  const wkr = await loomDaemon.seedLiveSession({
    project: mgr.project, agentId: mgr.agentId, role: "worker",
    id: `${short}-${randomUUID()}`,
    parentSessionId: mgr.sessionId, branch: `loom/band-shape-${short}`,
    task: { title: `band-shape-${short}` },
  });
  await loomDaemon.seedOrchestrationEvent({
    managerSessionId: mgr.sessionId, kind: "merge_request",
    workerSessionId: wkr.sessionId, taskId: wkr.taskId,
  });
  return { mgr, wkr, short, title, projectId: mgr.projectId };
}

type Box = { x: number; y: number; w: number; h: number; right: number; bottom: number };

/**
 * Measures the band body, this run's own decision row, and the card's SOUND overflow sweep over that
 * row's subtree. Returns plain numbers so a failure message carries the measurement, not a selector.
 */
async function measureBand(page: Page, managerSessionId: string) {
  return page.evaluate((mgrId) => {
    const box = (el: Element | null): Box | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        right: Math.round(r.right), bottom: Math.round(r.bottom),
      };
    };
    const panel = document.querySelector('[data-testid="atlas-band-needs"]');
    const body = panel?.querySelector(".loom-bandbody") ?? null;
    const row = panel?.querySelector(`[data-testid="attention-row"][data-session-id="${mgrId}"]`) ?? null;
    const text = row?.querySelector('[data-testid="attention-row-text"]') ?? null;
    // THE CARD'S OWN CHECK: a box whose computed overflow-x is `visible` cannot scroll, so content
    // wider than its client box is genuinely spilling. Scoped to this run's own row subtree, because
    // the shared daemon's other rows are not this card's to pass or fail.
    const spilling: { tag: string; testid: string; scrollWidth: number; clientWidth: number }[] = [];
    for (const el of [row, ...(row ? Array.from(row.querySelectorAll("*")) : [])]) {
      if (!el) continue;
      if (getComputedStyle(el).overflowX !== "visible") continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        spilling.push({
          tag: el.tagName, testid: (el as HTMLElement).dataset?.testid ?? "",
          scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
        });
      }
    }
    return {
      body: box(body), row: box(row), text: box(text),
      textWhiteSpace: text ? getComputedStyle(text).whiteSpace : null,
      spilling,
    };
  }, managerSessionId);
}

test.describe("Atlas Needs-you band row shape (card d0d430d4)", () => {
  test("switch ON: at 1600×1000 and 420px the action sits inside the band, the long title is one visible line, and the merge footer stays in view", async ({ page, loomDaemon }) => {
    // Two viewports, a modal round-trip and a /review-free click path are past the 30s default.
    test.setTimeout(150_000);
    const seeded = await seedBandRows(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, seeded.projectId);

    for (const viewport of [{ width: 1600, height: 1000 }, { width: 420, height: 900 }] as const) {
      const at = `${viewport.width}x${viewport.height}`;
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(loomDaemon.baseURL + "/home");

      // ── PRESENCE FIRST, and it is THIS run's row: a measurement on a still-loading page would
      //    "pass" against nothing (card 625d791c).
      const band = page.getByTestId("atlas-band-needs");
      await expect(band, at).toBeVisible();
      const row = band.locator(`[data-testid="attention-row"][data-session-id="${seeded.mgr.sessionId}"]`);
      await expect(row, at).toBeVisible();
      await expect(row, at).toHaveAttribute("data-kind", "DECISION NEEDED");
      // The full ask is still reachable without the row rendering it — the truncation below is a
      // display decision, not a loss of the text. (`decisionAttentionText` prefixes the routing
      // target, so this is a containment check, not an equality one.)
      await expect(row.getByTestId("attention-row-text"), at)
        .toHaveAttribute("title", new RegExp(`${seeded.short} rollout of the merge-gate cadence change`));

      const answer = row.getByRole("button", { name: "Answer →" });
      await expect(answer, at).toBeVisible();

      // Layout settles sub-pixel for a beat after mount; take the reading twice and require agreement
      // before asserting on it ([[atlas-ui-switch-and-shell-p1-0]] gotcha 2 — an unsettled "before"
      // reports a change that never happened).
      let m = await measureBand(page, seeded.mgr.sessionId);
      await expect.poll(async () => {
        const next = await measureBand(page, seeded.mgr.sessionId);
        const same = JSON.stringify(next.row) === JSON.stringify(m.row) && JSON.stringify(next.text) === JSON.stringify(m.text);
        m = next;
        return same;
      }, { message: `band layout never settled at ${at}` }).toBe(true);

      const body = m.body!;
      const rowBox = m.row!;
      const textBox = m.text!;
      expect(body, at).not.toBeNull();

      // ── DEFECT (1): the action's BOUNDING BOX lies inside the band. Before the fix this ran 21px
      //    past `body.right` at 1600. Both edges, because a box can escape either way.
      const answerBox = (await answer.boundingBox())!;
      expect(answerBox, at).not.toBeNull();
      expect.soft(Math.round(answerBox.x), `${at}: action left edge vs band body left ${body.x}`).toBeGreaterThanOrEqual(body.x);
      expect.soft(Math.round(answerBox.x + answerBox.width), `${at}: action right edge vs band body right ${body.right}`).toBeLessThanOrEqual(body.right);
      // The dismiss × is the control that escaped FURTHEST before the fix (to 630, past the panel).
      const dismissBox = (await row.getByRole("button", { name: "Dismiss this alert" }).boundingBox())!;
      expect.soft(Math.round(dismissBox.x + dismissBox.width), `${at}: dismiss right edge vs band body right ${body.right}`).toBeLessThanOrEqual(body.right);

      // …and nothing in the row spills horizontally at all, by the card's own sound check.
      expect.soft(m.spilling, `${at}: boxes with overflow-x:visible whose scrollWidth exceeds clientWidth`).toEqual([]);

      // ── DEFECT (2): one line, with text actually ON it. 0px wide and 486px tall was the bug.
      expect.soft(m.textWhiteSpace, `${at}: the title must not wrap`).toBe("nowrap");
      expect.soft(textBox.w, `${at}: rendered title width`).toBeGreaterThan(40);
      expect.soft(textBox.h, `${at}: rendered title height — one 12px mono line is ~18px`).toBeLessThanOrEqual(24);
      // The row is the head line plus its action line, not a 500px column of single characters.
      expect.soft(rowBox.h, `${at}: row height`).toBeLessThanOrEqual(80);
      // And the row never widens past its column.
      expect.soft(rowBox.right, `${at}: row right edge vs band body right ${body.right}`).toBeLessThanOrEqual(body.right);

      // ── THE SHAPE ITSELF, not just its absence of symptoms. Measured while writing this card: a
      //    control that moved the actions back onto the head line left every assertion above GREEN,
      //    because the head line's own `flex-wrap` catches them — so "nothing is clipped" does NOT
      //    discriminate the stacked shape from a ragged wrapped one. These two lines do: the action
      //    cluster is its own element, and it sits strictly BELOW the title's line box.
      await expect(row.getByTestId("attention-row-actions"), at).toHaveCount(1);
      await expect(row.getByTestId("attention-row-actions").getByRole("button", { name: "Answer →" }), at).toHaveCount(1);
      expect.soft(Math.round(answerBox.y), `${at}: action top vs title bottom ${textBox.bottom}`).toBeGreaterThanOrEqual(textBox.bottom);

      // ── CLICKABLE, not merely un-clipped. The shared Request modal appearing IS the observable:
      //    `AttentionList` routes a questionId row through `useOpenRequest`, never a navigation.
      const urlBefore = page.url();
      await answer.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog, at).toBeVisible();
      await expect(dialog.getByText(seeded.title, { exact: true }), at).toBeVisible();
      expect(page.url(), at).toBe(urlBefore);
      await page.keyboard.press("Escape");
      await expect(dialog, at).toHaveCount(0);

      // ── THE FOOTER ROW still carries its own action (card c2968651). The band body scrolls and the
      //    shared daemon can put sibling rows above mine, so scroll it in first and then require it
      //    to be genuinely inside the body's clip box — that is the fold defect 420px exhibited.
      const mergeRow = band.locator(`[data-testid="attention-row"][data-session-id="${seeded.wkr.sessionId}"]`);
      await expect(mergeRow, at).toBeVisible();
      await mergeRow.scrollIntoViewIfNeeded();
      const mergeGo = page.getByTestId(`atlas-band-merge-go-${seeded.wkr.sessionId}`);
      await expect(mergeGo, at).toBeVisible();
      const goBox = (await mergeGo.boundingBox())!;
      const bodyNow = (await measureBand(page, seeded.mgr.sessionId)).body!;
      expect.soft(Math.round(goBox.y), `${at}: merge footer top vs band body top ${bodyNow.y}`).toBeGreaterThanOrEqual(bodyNow.y - 1);
      expect.soft(Math.round(goBox.y + goBox.height), `${at}: merge footer bottom vs band body bottom ${bodyNow.bottom}`).toBeLessThanOrEqual(bodyNow.bottom + 1);
      expect.soft(Math.round(goBox.x + goBox.width), `${at}: merge footer right vs band body right ${bodyNow.right}`).toBeLessThanOrEqual(bodyNow.right);
    }

    // ── THE OTHER MOUNTS. One `AttentionList` feeds four of them, so `compact` reaching the band
    //    panel does not by itself prove it reached the KPI pop-over. Asserted, not assumed.
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(loomDaemon.baseURL + "/home");
    await page.getByTestId("atlas-kpi-needs").click();
    const pop = page.getByTestId("atlas-kpi-pop-needs");
    await expect(pop).toBeVisible();
    const popRow = pop.locator(`[data-testid="attention-row"][data-session-id="${seeded.mgr.sessionId}"]`);
    await expect(popRow).toBeVisible();
    await expect(popRow.getByTestId("attention-row-actions")).toHaveCount(1);
    await expect(popRow.getByTestId("attention-row-text")).toHaveCSS("white-space", "nowrap");
  });

  test("switch OFF: the classic Overview keeps the one-line row — direct-child text that still wraps, its spacer, and no action line", async ({ page, loomDaemon }) => {
    const seeded = await seedBandRows(loomDaemon);
    // Deliberately NO seedAtlasOn — off is the default, and seeding it off would re-clear the key on
    // every navigation for a reason unrelated to the app (measured on P1-0).
    await pinProject(page, seeded.projectId);
    await page.goto(loomDaemon.baseURL + "/overview");

    const row = page.locator(`[data-testid="attention-row"][data-session-id="${seeded.mgr.sessionId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-kind", "DECISION NEEDED");
    await expect(row.getByRole("button", { name: "Answer →" })).toBeVisible();

    // ── THE SHAPE `c2968651`'s record forbids changing, read off the real DOM. The text span is a
    //    DIRECT child of the row frame (no wrapper), the `flex:1` spacer is its direct sibling, and
    //    the frame is still a centred single row.
    const classic = await page.evaluate((mgrId) => {
      const el = document.querySelector(`[data-testid="attention-row"][data-session-id="${mgrId}"]`) as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      const kids = Array.from(el.children) as HTMLElement[];
      const textIdx = kids.findIndex((k) => k.dataset.testid === "attention-row-text");
      const text = textIdx >= 0 ? kids[textIdx] : null;
      const spacer = textIdx >= 0 ? kids[textIdx + 1] : null;
      return {
        flexDirection: cs.flexDirection, alignItems: cs.alignItems,
        textIsDirectChild: textIdx >= 0,
        textWhiteSpace: text ? getComputedStyle(text).whiteSpace : null,
        textFlex: text ? getComputedStyle(text).flex : null,
        spacerFlexGrow: spacer ? getComputedStyle(spacer).flexGrow : null,
        spacerIsEmpty: spacer ? spacer.textContent === "" && spacer.children.length === 0 : null,
      };
    }, seeded.mgr.sessionId);

    expect(classic).not.toBeNull();
    expect(classic!.flexDirection).toBe("row");
    expect(classic!.alignItems).toBe("center");
    // No wrapper was inserted around the row's children — the text measures against the frame itself.
    expect(classic!.textIsDirectChild).toBe(true);
    // The band's two style changes did NOT leak here: classic text still wraps and keeps `flex: auto`.
    expect(classic!.textWhiteSpace).toBe("normal");
    expect(classic!.textFlex).toBe("0 1 auto");
    // The `flex: 1` spacer is still the text's immediate sibling, which is what pushes the actions right.
    expect(classic!.spacerFlexGrow).toBe("1");
    expect(classic!.spacerIsEmpty).toBe(true);

    // ── ABSENCE, scoped to what this card BUILT. Page-wide: no classic surface may render the band's
    //    stacked action line, and `MergeGateAttention` borrows this same row on this same page.
    await expect(page.getByTestId("attention-row-actions")).toHaveCount(0);
    // Classic still routes a merge request to the rich Review card, never to an attention row, so the
    // footer-bearing shape cannot appear here even in principle (card c2968651).
    await expect(page.locator(`[data-testid="attention-row"][data-session-id="${seeded.wkr.sessionId}"]`)).toHaveCount(0);
  });
});
