// Card 7663eeb4 — the two Rate Limits fields whose policy floor is sub-hour now state it legibly.
//
// "Default backoff" (floor 60_000ms) and "Deadline, no reset" (floor 600_000ms) were entered in HOURS, so
// MsField rendered their shared PLATFORM_MS_BOUNDS floor as "min 0.016666666666666666h" / "min
// 0.16666666666666666h" — in the always-on range hint AND in the inline out-of-range error. A figure like
// that reads as a broken hint rather than a policy minimum, which is the opposite of what card 48365fda
// put the hint there for. Both fields now read in MINUTES, the unit their bounds render whole in and the
// one their sibling "Deadline after reset" already used.
//
// Card cb6a51b8 then closed the one field this spec could originally only assert AROUND — Connections →
// "Rate limit window", a hand-written MsField call site (not a GLOBAL_FIELDS entry) whose own 1000ms floor
// rendered "min 0.016666666666666666m" — so every absence assertion here is now section-wide rather than
// scoped to the Rate Limits grid, and that field's own hint and inline error are asserted in seconds.
//
// These EXERCISE the controls rather than reading the page: a render-only pass cannot tell a field that
// writes its own key from one bleeding into a neighbour (the mis-bound-write-key hazard), and cannot tell
// a reachable Save from a disabled one. test/ms-units.mjs pins the same unit choice statically, against
// the GLOBAL_FIELDS literal; this pins what the browser actually renders and persists.
//
// Runs against the shared `loomDaemon` fixture — its own scratch LOOM_HOME on an OS-assigned port, never
// the owner's :4317, serving the built bundle.
import { expect, test, type Page } from "./fixtures/daemon";

// Same locator discipline as settings-loop-breaker.spec.ts: pin the EXACT label span, then descend to the
// control. getByLabel is unusable here — each <label> nests its hint text into the accessible name.
function field(page: Page, labelText: string) {
  return page
    .locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`)
    .locator("input, select, textarea");
}
function box(page: Page, labelText: string) {
  return page.locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`);
}
// Scoped to the Global/Daemon section's own wrapper rather than a page-wide `.last()`: this page renders
// several Save buttons, and `.last()` is a bet on declaration order (see atlas-first-run-states.spec.ts).
const globalSection = (page: Page) => page.getByTestId("settings-section-global-daemon");
const globalSave = (page: Page) => globalSection(page).getByRole("button", { name: "Save", exact: true });
// Every absence assertion below is scoped to the WHOLE daemon-global section — every bounded ms field the
// page renders here, not the five in one grid. It was deliberately narrowed to the "Rate Limits" grid
// under card 7663eeb4, because this same section held a field outside that card's scope with the very
// same defect: Connections → "Rate limit window", whose own 1000ms floor rendered as
// "min 0.016666666666666666m" while the field read in minutes (a hand-written MsField call site, not a
// GLOBAL_FIELDS entry, so the static scan in test/ms-units.mjs could not see it either), and a
// section-wide assertion would have been red for someone else's field. Card cb6a51b8 moved that field to
// seconds and widened the static scan to cover hand-written call sites, so the narrowing is spent.

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

/** The stored `rateLimit` override group, as the daemon currently holds it. */
async function storedRateLimit(baseURL: string): Promise<Record<string, number>> {
  const res = await fetch(`${baseURL}/api/platform/config`);
  const body = (await res.json()) as { override?: { rateLimit?: Record<string, number> } };
  return body.override?.rateLimit ?? {};
}

// The two fields this card moved, with a typed value in MINUTES that is distinct from the platform
// default (300m / 360m) and from each other — so a read-back can only match if each control wrote its own
// key. The hint is the rendered proof of the unit choice: in hours these would read "min
// 0.016666666666666666h · max 24h" and "min 0.16666666666666666h · max 48h".
const BACKOFF = { label: "Default backoff (m)", hint: "min 1m · max 1440m", typed: "45", ms: 2_700_000 };
const NO_RESET = { label: "Deadline, no reset (m)", hint: "min 10m · max 2880m", typed: "600", ms: 36_000_000 };
// Card cb6a51b8 — the hand-written MsField call site that carried the same sub-unit-floor defect. A
// different panel and a different config group from the two above (so its save round-trip is pinned where
// the rest of the connections group is, in settings.spec.ts), but the same section, and the field that
// forced the narrowing the comment above describes. In minutes its hint read
// "min 0.016666666666666666m · max 60m".
const CONN_WINDOW = { label: "Rate limit window (s)", hint: "min 1s · max 3600s", error: "must be between 1s and 3600s" };
// The repeating-decimal signature of the defect, in any of these fields' own floors. Asserted ABSENT from
// the daemon-global section — but only after the hints above are asserted PRESENT, so an empty or
// unrendered section can never read as "the illegible figure is gone".
const ILLEGIBLE = /0\.0166|0\.1666/;

test("the sub-hour-floor rate-limit fields state their bounds in minutes, and a save persists both (card 7663eeb4)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-rl-units-save-${Date.now()}`);
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/home?tab=settings`);

  // The panel loaded (GET /api/platform/config) — "Rate Limits" only appears once it has.
  await expect(globalSection(page).getByText("Rate Limits", { exact: true })).toBeVisible();

  // Each field states its permitted range up front, in the unit it is entered in, and both halves read as
  // whole minutes. Asserted per-field so the hint is provably driven per-field, not one reused pair.
  await expect(box(page, BACKOFF.label).getByText(BACKOFF.hint)).toBeVisible();
  await expect(box(page, NO_RESET.label).getByText(NO_RESET.hint)).toBeVisible();
  // The hand-written Connections call site states its own range in SECONDS (card cb6a51b8). Asserted
  // PRESENT, not merely not-illegible: an absence assertion proves no bad figure is on the page, never
  // that the good one rendered. Its panel neighbour states a DIFFERENT range in the same unit, so the
  // hint is provably read per-field rather than one pair reused down the panel.
  await expect(box(page, CONN_WINDOW.label).getByText(CONN_WINDOW.hint)).toBeVisible();
  await expect(box(page, "Request timeout (s)").getByText("min 1s · max 120s")).toBeVisible();

  // ...and nowhere in the whole daemon-global section does the old repeating decimal survive. This is the
  // regression guard: switching any of these fields back to its old unit puts that figure straight back
  // on the page. The section locator is asserted to resolve FIRST — a `toHaveCount(0)` against a locator
  // that matches no element at all passes for the wrong reason, which is the one way this could go
  // quietly vacuous.
  await expect(globalSection(page)).toHaveCount(1);
  await expect(globalSection(page).getByText(ILLEGIBLE)).toHaveCount(0);

  // The sibling that was already in minutes is untouched — the point was to make the two deadline fields
  // one comparable pair, not to re-unit the whole panel. "Recency window" deliberately KEEPS hours (its
  // 0..24h bounds render whole, and the span it describes is read in hours).
  await expect(box(page, "Deadline after reset (m)").getByText("min 1m · max 1440m")).toBeVisible();
  await expect(box(page, "Recency window (h)").getByText("min 0h · max 24h")).toBeVisible();

  // BEFORE: whatever an earlier spec in this worker-scoped daemon left behind, none of it is our values.
  // Snapshot-compared rather than asserted empty — the fixture daemon is shared across specs.
  const before = await storedRateLimit(loomDaemon.baseURL);
  expect(before.defaultBackoffMs ?? null).not.toBe(BACKOFF.ms);
  expect(before.deadlineNoResetMs ?? null).not.toBe(NO_RESET.ms);

  await field(page, BACKOFF.label).fill(BACKOFF.typed);
  await field(page, NO_RESET.label).fill(NO_RESET.typed);

  // The typed minutes are converted, not echoed: the `effective:` hint reads back in the same unit.
  await expect(globalSave(page)).toBeEnabled();
  await globalSave(page).click();

  // AFTER (persisted): each key carries ITS OWN value, in canonical ms. Asserted as a whole object with
  // every same-group NEIGHBOUR pinned to what it held before, so a write bleeding sideways cannot pass —
  // `toMatchObject` on just the two touched keys would be blind to exactly that.
  await expect
    .poll(async () => {
      const rl = await storedRateLimit(loomDaemon.baseURL);
      return {
        defaultBackoffMs: rl.defaultBackoffMs ?? null,
        deadlineNoResetMs: rl.deadlineNoResetMs ?? null,
        deadlineAfterResetMs: rl.deadlineAfterResetMs ?? null,
        recencyWindowMs: rl.recencyWindowMs ?? null,
        resetBufferMs: rl.resetBufferMs ?? null,
        exhaustedThresholdPct: rl.exhaustedThresholdPct ?? null,
      };
    }, { message: "the minute-unit rate-limit fields never persisted their own keys" })
    .toEqual({
      defaultBackoffMs: BACKOFF.ms,
      deadlineNoResetMs: NO_RESET.ms,
      // Untouched by this save: re-sent from the form's own loaded state, so they must come back
      // unchanged. The whole rateLimit group rides one PATCH, which is what makes them real victims.
      deadlineAfterResetMs: before.deadlineAfterResetMs ?? null,
      recencyWindowMs: before.recencyWindowMs ?? null,
      resetBufferMs: before.resetBufferMs ?? null,
      exhaustedThresholdPct: before.exhaustedThresholdPct ?? null,
    });

  // And it round-trips: a reload re-seeds each field from the stored ms IN MINUTES. 2_700_000ms coming
  // back as "45" is what proves the display unit is read from the same table on both directions — in
  // hours the same stored value would re-seed as "0.75".
  await page.reload();
  await expect(field(page, BACKOFF.label)).toHaveValue(BACKOFF.typed);
  await expect(field(page, NO_RESET.label)).toHaveValue(NO_RESET.typed);
  await expect(box(page, BACKOFF.label).getByText(`effective: ${BACKOFF.typed}m`)).toBeVisible();
  await expect(box(page, NO_RESET.label).getByText(`effective: ${NO_RESET.typed}m`)).toBeVisible();

  // Blanking clears back to inherit rather than stranding the last-saved value, and the placeholder then
  // names the platform default in the field's own unit — 300m, the figure the hour label used to show as 5.
  await field(page, BACKOFF.label).fill("");
  await expect(globalSave(page)).toBeEnabled();
  await globalSave(page).click();
  await expect
    .poll(async () => (await storedRateLimit(loomDaemon.baseURL)).defaultBackoffMs ?? null)
    .toBe(null);
  await expect(field(page, BACKOFF.label)).toHaveAttribute("placeholder", "inherit (300m)");
});

test("an out-of-range entry on either field is reported in minutes, never raw ms (card 7663eeb4)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-rl-units-bounds-${Date.now()}`);
  await pinActiveProject(page, project.id);

  // POSITIVE CONTROL: the message the user would read without a client-side bound — the raw MILLISECOND
  // floor, under a field measured in minutes. Captured against the same daemon, before touching the UI.
  const rejected = await fetch(`${loomDaemon.baseURL}/api/platform/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rateLimit: { deadlineNoResetMs: 60_000 } }),
  });
  expect(rejected.status).toBe(400);
  expect(await rejected.text()).toMatch(/600000/);

  await page.goto(`${loomDaemon.baseURL}/home?tab=settings`);
  const noResetBox = box(page, NO_RESET.label);
  const noReset = field(page, NO_RESET.label);

  // BEFORE: no inline error on the field.
  await expect(noResetBox.getByRole("alert")).toHaveCount(0);
  // Whatever this field loaded with — an earlier spec in this worker-scoped daemon may have saved a value,
  // and so may a CI retry of this very test. The recovery value is derived from it so that it is always a
  // genuine CHANGE: Save is gated on the form being dirty as well as error-free, so re-typing the stored
  // value would leave it disabled for a reason this test is not about.
  const loaded = await noReset.inputValue();
  const recovered = loaded === "77" ? "88" : "77";

  // AFTER: the same 60_000ms the REST control above was told ">=600000" about is "1" minute here, and the
  // inline error states the floor as 10m — the figure the hint shows, not 0.16666666666666666h and not a
  // millisecond count.
  await noReset.fill("1");
  await expect(noResetBox.getByRole("alert")).toHaveText("must be between 10m and 2880m");
  await expect(globalSave(page)).toBeDisabled();
  // The blocked Save names the offending field, and neither message leaks raw ms or the old decimal.
  await expect(globalSection(page).getByText(`${NO_RESET.label} must be between 10m and 2880m`).last()).toBeVisible();
  await expect(globalSection(page).getByText(/600000/)).toHaveCount(0);
  await expect(globalSection(page)).toHaveCount(1);
  await expect(globalSection(page).getByText(ILLEGIBLE)).toHaveCount(0);

  // The other field reports its OWN floor, 1m — so the bound is read per-field rather than one pair
  // shared across the panel (the two share a unit, NOT a range).
  const backoff = field(page, BACKOFF.label);
  const backoffLoaded = await backoff.inputValue();
  await backoff.fill("0.5");
  await expect(box(page, BACKOFF.label).getByRole("alert")).toHaveText("must be between 1m and 1440m");

  // AFTER (recovered): back in range → both errors clear and Save is reachable again. The guard rejects
  // out-of-range entries, it does not wedge the form.
  await backoff.fill(backoffLoaded);
  await noReset.fill(recovered);
  await expect(box(page, BACKOFF.label).getByRole("alert")).toHaveCount(0);
  await expect(noResetBox.getByRole("alert")).toHaveCount(0);
  await expect(globalSave(page)).toBeEnabled();

  // Card cb6a51b8 — the hand-written Connections call site, held to the same standard: its inline error
  // quotes the SAME seconds figures its hint shows, and it blocks the SAME Save as the grid fields above
  // (one form, one `globalRangeErrors` list). The 1000ms floor is NOT also asserted absent as a raw
  // figure here the way 600000 is above: "1000" is too short a token to assert absent across a section
  // full of unrelated numbers, and would red for a reason this card is not about.
  const connWindow = field(page, CONN_WINDOW.label);
  const connLoaded = await connWindow.inputValue();
  await connWindow.fill("0.5");
  await expect(box(page, CONN_WINDOW.label).getByRole("alert")).toHaveText(CONN_WINDOW.error);
  await expect(globalSave(page)).toBeDisabled();
  await expect(globalSection(page).getByText(`${CONN_WINDOW.label} ${CONN_WINDOW.error}`).last()).toBeVisible();
  // The repeating decimal stays absent while that error is actually on screen — the one moment the old
  // minute-unit rendering would have put it into the error as well as the hint.
  await expect(globalSection(page).getByText(ILLEGIBLE)).toHaveCount(0);
  // Recovered: the form is still dirty from `recovered` above, so an enabled Save here proves the error
  // cleared rather than merely that nothing was typed.
  await connWindow.fill(connLoaded);
  await expect(box(page, CONN_WINDOW.label).getByRole("alert")).toHaveCount(0);
  await expect(globalSave(page)).toBeEnabled();
});
