// The Run Replay event row's geometry, read for card f51d3068 — the timestamp must never be the column
// that gets cut. Shared because the row (`ReplayEvent`, components/auditReplay.tsx) is mounted by BOTH
// surfaces that carry wave replay, so the claim has to be made identically on each: the Atlas Workspace
// node's Replay tab and classic Mission Control's own collapsible section.
//
// ⛔ Addressed by `audit-replay-event-time`, NEVER by the row's nth `<span>`. The `Dot` primitive renders
// as a `<span>` too, so a positional read silently points one column off and still returns a plausible
// box. Decisions: docs/decisions/f51d3068-replay-row-timestamp-never-the-cut-column.md.
import { expect, type Locator } from "../fixtures/daemon";

export type RowFit = {
  /** px the timestamp's right edge sits PAST the row's right edge. Negative = inside, which is the pass. */
  overflow: number;
  /** px the timestamp's left edge sits BEFORE the row's left edge. Negative = inside. */
  underflow: number;
  /** The timestamp's own text clipping: > 0 means it rendered an ellipsis rather than the whole time. */
  textClipped: number;
  /** The rendered timestamp string, so a row that fits because it is EMPTY is distinguishable. */
  text: string;
};

/** Every event row's timestamp fit, in render order. */
export async function rowFits(scope: Locator): Promise<RowFit[]> {
  return scope.getByTestId("audit-replay-event").evaluateAll((rows) =>
    rows.map((row) => {
      const time = row.querySelector('[data-testid="audit-replay-event-time"]')!;
      const r = row.getBoundingClientRect();
      const t = time.getBoundingClientRect();
      return {
        overflow: Math.round(t.right - r.right),
        underflow: Math.round(r.left - t.left),
        textClipped: Math.round(time.scrollWidth - time.clientWidth),
        text: (time.textContent ?? "").trim(),
      };
    }));
}

/**
 * THE CARD'S CLAIM, measured rather than eyeballed: at `label` width, every row's timestamp box sits
 * inside its own row's box and renders its whole text.
 *
 * Each leg is falsifiable on its own and none is vacuous: `expectedRows` pins the population (an empty
 * stream would satisfy "every row fits"), the non-empty text check rules out a row that fits because the
 * timestamp rendered nothing, and `textClipped` rules out one that fits because it ellipsized itself
 * instead of being cut by the row — all three are ways the box check alone could pass for the wrong
 * reason. Pre-fix this went red at the `overflow` leg by 94px (Atlas) / 154px (Mission Control).
 */
export async function expectTimestampInsideRow(scope: Locator, expectedRows: number, label: string) {
  const fits = await rowFits(scope);
  expect(fits, `${label}: the replay stream rendered ${fits.length} rows, not the ${expectedRows} seeded — ` +
    `"every row's timestamp fits" would be vacuous`).toHaveLength(expectedRows);

  const empty = fits.filter((f) => f.text === "");
  expect(empty, `${label}: ${empty.length} rows rendered an EMPTY timestamp, so their fit proves nothing`)
    .toHaveLength(0);

  const cut = fits.filter((f) => f.overflow > 0 || f.underflow > 0);
  expect(cut, `${label}: ${cut.length} of ${fits.length} rows push their timestamp outside the row's own ` +
    `box — worst ${Math.max(0, ...fits.map((f) => f.overflow))}px past the right edge. The timestamp is the ` +
    `one column a reader cannot reconstruct from its neighbours, so it must not be what gets cut: ` +
    JSON.stringify(cut.slice(0, 3))).toHaveLength(0);

  const clipped = fits.filter((f) => f.textClipped > 0);
  expect(clipped, `${label}: ${clipped.length} rows fit only because the timestamp ellipsized its own ` +
    `text: ${JSON.stringify(clipped.slice(0, 3))}`).toHaveLength(0);
}

/**
 * The event kinds seeded for the fit check — the real vocabulary `eventTone`/`detailLine` switch on,
 * including the LONGEST names in it (`session_recovery_abandoned`, `worker_report_undelivered`,
 * `build_gate_retry_attempt`). The long ones are the point: they are what consumed the row's width and
 * pushed the timestamp off, so a shorter sample would have passed pre-fix and proved nothing.
 */
export const FIT_CHECK_KINDS = [
  "merge_request", "merge_done", "worker_report", "idle_report", "recycle_complete",
  "worker_stuck", "merge_rejected", "deploy", "build_gate_retry", "session_recovered",
  "session_recovery_abandoned", "worker_report_undelivered", "build_gate_retry_attempt",
  "schedule_fire_deferred", "merge_landing_started",
];
