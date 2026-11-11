// Card 826483a7 — the rate-limit loop breaker's four platform fields are reachable from Settings.
//
// Card dfef375f landed `rateLimit.loopBreakerMaxRecaps` / `loopBreakerQuickGapMs` /
// `loopBreakerBackoffBaseMs` / `loopBreakerBackoffCeilingMs` REST-ONLY: no control rendered them, so the
// only way to tune the mechanism that decides whether to STOP auto-resuming a capped session was a
// hand-written PATCH. These tests EXERCISE the new controls rather than reading the page — a render-only
// pass is identical whether the fields write their own keys or a neighbour's (the mis-bound-write-key
// hazard), and whether Save is reachable at all.
//
// @decision dfef375f — backoff base vs ceiling is a resolve-time CLAMP, never a validator rejection. Do
// not "fix" the third test into a 400-expecting one, and do not add a client-side rejection for it: that
// would block a save the daemon accepts. Reasoning: the `Math.min` in packages/shared/src/config.ts.
//
// That third test pins both halves against the same daemon: a single-field out-of-range entry IS rejected
// (the control proving this validator rejects at all), while the cross-field combination is accepted and
// resolves clamped.
//
// Runs against the shared `loomDaemon` fixture — its own scratch LOOM_HOME on an OS-assigned port, never
// the owner's :4317, serving the built bundle.
import { expect, test, type Page } from "./fixtures/daemon";

// Same locator discipline as settings-timing-rounding.spec.ts: pin the EXACT label span, then descend to
// the control. getByLabel is unusable here — each <label> nests its hint text into the accessible name.
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

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

/** The stored `rateLimit` override group, as the daemon currently holds it. */
async function storedRateLimit(baseURL: string): Promise<Record<string, number>> {
  const res = await fetch(`${baseURL}/api/platform/config`);
  const body = (await res.json()) as { override?: { rateLimit?: Record<string, number> } };
  return body.override?.rateLimit ?? {};
}
/** The RESOLVED `rateLimit` group — override merged over the platform defaults, clamps applied. */
async function resolvedRateLimit(baseURL: string): Promise<Record<string, number>> {
  const res = await fetch(`${baseURL}/api/platform/config`);
  const body = (await res.json()) as { resolved?: { rateLimit?: Record<string, number> } };
  return body.resolved?.rateLimit ?? {};
}
async function patchRateLimit(baseURL: string, rateLimit: Record<string, number>) {
  return fetch(`${baseURL}/api/platform/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rateLimit }),
  });
}

// The four controls, with the unit each is entered in and a value distinct from BOTH the platform default
// and its siblings — so a read-back can only match if each control wrote its OWN key (a swapped pair, or a
// write bleeding into a neighbour, lands a different number than the one asserted).
const QUICK_GAP = { label: "Quick re-cap gap (s)", typed: "90", ms: 90_000 };
const BACKOFF_BASE = { label: "Backoff base (m)", typed: "10", ms: 600_000 };
const BACKOFF_CEILING = { label: "Backoff ceiling (m)", typed: "120", ms: 7_200_000 };
const MAX_RECAPS = { label: "Max consecutive re-caps", typed: "5", value: 5 };

test("the loop-breaker controls render with their shared bounds, and a save persists all four (card 826483a7)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-loop-breaker-save-${Date.now()}`);
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/home?tab=settings`);

  // The loop breaker gets its OWN section label, not four more cells under "Rate Limits": those fields
  // tune how long one ordinary park waits, these decide whether to stop retrying at all.
  await expect(globalSection(page).getByText("Rate-limit Loop Breaker")).toBeVisible();

  // Each ms field states its permitted range UP FRONT, in the unit it is entered in — the point of card
  // 0a5d61c9, asserted per-field here so the hint is provably driven per-field and not one reused pair.
  // Both backoff fields read in MINUTES on purpose: shown in hours their shared 60_000 floor renders
  // "min 0.016666666666666666h", and base-vs-ceiling stops being comparable at a glance.
  await expect(box(page, QUICK_GAP.label).getByText("min 1s · max 3600s")).toBeVisible();
  await expect(box(page, BACKOFF_BASE.label).getByText("min 1m · max 1440m")).toBeVisible();
  await expect(box(page, BACKOFF_CEILING.label).getByText("min 1m · max 1440m")).toBeVisible();
  // The plain count has no unit to translate, so it states its range in its own note instead.
  await expect(box(page, MAX_RECAPS.label).getByText(/Whole number, 1-20\./)).toBeVisible();

  // BEFORE: whatever an earlier spec in this worker-scoped daemon left behind, none of it is our values.
  // Snapshot-compared rather than asserted empty — the fixture daemon is shared across specs.
  const before = await storedRateLimit(loomDaemon.baseURL);
  expect(before.loopBreakerQuickGapMs ?? null).not.toBe(QUICK_GAP.ms);
  expect(before.loopBreakerMaxRecaps ?? null).not.toBe(MAX_RECAPS.value);

  await field(page, QUICK_GAP.label).fill(QUICK_GAP.typed);
  await field(page, BACKOFF_BASE.label).fill(BACKOFF_BASE.typed);
  await field(page, BACKOFF_CEILING.label).fill(BACKOFF_CEILING.typed);
  await field(page, MAX_RECAPS.label).fill(MAX_RECAPS.typed);

  // Editing the fields is what makes the form dirty — a control bound to no state leaves Save disabled.
  await expect(globalSave(page)).toBeEnabled();
  await globalSave(page).click();

  // AFTER (persisted): each key carries ITS OWN value, in canonical ms. Asserted as a whole object rather
  // than key-by-key `toMatchObject`, and with the two plain-count NEIGHBOURS pinned too, so a write
  // bleeding into an adjacent key cannot pass (the discriminating control for a NumField is a mis-bound
  // write key, not a missing field).
  await expect
    .poll(async () => {
      const rl = await storedRateLimit(loomDaemon.baseURL);
      return {
        loopBreakerQuickGapMs: rl.loopBreakerQuickGapMs ?? null,
        loopBreakerBackoffBaseMs: rl.loopBreakerBackoffBaseMs ?? null,
        loopBreakerBackoffCeilingMs: rl.loopBreakerBackoffCeilingMs ?? null,
        loopBreakerMaxRecaps: rl.loopBreakerMaxRecaps ?? null,
        exhaustedThresholdPct: rl.exhaustedThresholdPct ?? null,
      };
    }, { message: "the loop-breaker controls never persisted their own keys" })
    .toEqual({
      loopBreakerQuickGapMs: QUICK_GAP.ms,
      loopBreakerBackoffBaseMs: BACKOFF_BASE.ms,
      loopBreakerBackoffCeilingMs: BACKOFF_CEILING.ms,
      loopBreakerMaxRecaps: MAX_RECAPS.value,
      // Untouched by this save: the one plain-count key sharing the rateLimit group's PATCH shape, and so
      // the most likely victim of a mis-bound write from the Max-consecutive-re-caps control beside it.
      exhaustedThresholdPct: before.exhaustedThresholdPct ?? null,
    });

  // And it round-trips: a reload re-seeds each field from the stored ms in its OWN unit.
  await page.reload();
  await expect(field(page, QUICK_GAP.label)).toHaveValue(QUICK_GAP.typed);
  await expect(field(page, BACKOFF_BASE.label)).toHaveValue(BACKOFF_BASE.typed);
  await expect(field(page, BACKOFF_CEILING.label)).toHaveValue(BACKOFF_CEILING.typed);
  await expect(field(page, MAX_RECAPS.label)).toHaveValue(MAX_RECAPS.typed);

  // Blanking a field clears it back to inherit rather than stranding the last-saved value (the per-field
  // `null` clear sentinel) — exercised on the plain count, whose own control is the one added by hand.
  await field(page, MAX_RECAPS.label).fill("");
  await expect(globalSave(page)).toBeEnabled();
  await globalSave(page).click();
  await expect
    .poll(async () => (await storedRateLimit(loomDaemon.baseURL)).loopBreakerMaxRecaps ?? null)
    .toBe(null);
  // Cleared to inherit, not to zero: the resolved value is the platform default again.
  expect((await resolvedRateLimit(loomDaemon.baseURL)).loopBreakerMaxRecaps).toBe(3);
});

test("an out-of-range loop-breaker entry blocks Save, stated in the field's own unit (card 826483a7)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-loop-breaker-bounds-${Date.now()}`);
  await pinActiveProject(page, project.id);

  // POSITIVE CONTROL: the message the user would read without a client-side bound — a raw MILLISECOND
  // ceiling under a field labelled in minutes. Captured against the same daemon, before touching the UI.
  const overPatch = await patchRateLimit(loomDaemon.baseURL, { loopBreakerBackoffCeilingMs: 90_000_000 });
  expect(overPatch.status).toBe(400);
  expect(await overPatch.text()).toMatch(/86400000/);

  await page.goto(`${loomDaemon.baseURL}/home?tab=settings`);
  const ceilingBox = box(page, BACKOFF_CEILING.label);
  const ceiling = field(page, BACKOFF_CEILING.label);

  // BEFORE: no inline error on the field.
  await expect(ceilingBox.getByRole("alert")).toHaveCount(0);
  // Whatever this field loaded with — an earlier spec in this worker-scoped daemon may have saved a value,
  // and so may a CI retry of this very test. The recovery value below is derived from it so that it is
  // always a genuine CHANGE: Save is gated on the form being dirty as well as error-free, so re-typing the
  // stored value would leave it disabled for a reason this test is not about.
  const ceilingLoaded = await ceiling.inputValue();
  const ceilingRecovered = ceilingLoaded === "77" ? "88" : "77";

  // AFTER: the same value the REST control above was told "<=86400000" about now reads in MINUTES,
  // inline, and blocks Save — so the raw-ms message is never what the user sees.
  await ceiling.fill("1500");
  await expect(ceilingBox.getByRole("alert")).toHaveText("must be between 1m and 1440m");
  await expect(globalSave(page)).toBeDisabled();
  // The blocked Save names the offending field rather than failing silently.
  await expect(globalSection(page).getByText("Backoff ceiling (m) must be between 1m and 1440m").last()).toBeVisible();
  await expect(globalSection(page).getByText(/<=\s*86400000/)).toHaveCount(0);

  // The floor end is caught too, not just the ceiling — and the seconds-floored sibling reports in ITS
  // unit, proving the bound is read per-field rather than one pair shared across the panel.
  await ceiling.fill("0.5");
  await expect(ceilingBox.getByRole("alert")).toHaveText("must be between 1m and 1440m");
  const quickGap = field(page, QUICK_GAP.label);
  const quickGapBefore = await quickGap.inputValue();
  await quickGap.fill("5000");
  await expect(box(page, QUICK_GAP.label).getByRole("alert")).toHaveText("must be between 1s and 3600s");

  // AFTER (recovered): back in range → both errors clear and Save is reachable again. The guard rejects
  // out-of-range entries, it does not wedge the form.
  await quickGap.fill(quickGapBefore);
  await ceiling.fill(ceilingRecovered);
  await expect(ceilingBox.getByRole("alert")).toHaveCount(0);
  await expect(box(page, QUICK_GAP.label).getByRole("alert")).toHaveCount(0);
  await expect(globalSave(page)).toBeEnabled();
});

test("backoff base above its ceiling is accepted and CLAMPED, never rejected (card dfef375f round 2 item 7)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-loop-breaker-clamp-${Date.now()}`);
  await pinActiveProject(page, project.id);

  // CONTROL FIRST, in this same test so it holds under `--grep` too: this validator DOES reject a
  // single-field violation on the very key the combination below uses. Without it, the 200 that follows
  // would be indistinguishable from an endpoint that validates nothing.
  const singleField = await patchRateLimit(loomDaemon.baseURL, { loopBreakerBackoffBaseMs: 90_000_000 });
  expect(singleField.status).toBe(400);

  // The two values below are each INDIVIDUALLY in range (1m..1440m) — only their COMBINATION is wrong,
  // which is why no single-field bound check can catch it and why the UI must not pretend one does.
  const combo = await patchRateLimit(loomDaemon.baseURL, {
    loopBreakerBackoffBaseMs: 86_400_000, // 1440m, exactly the max
    loopBreakerBackoffCeilingMs: 1_800_000, // 30m
  });
  expect(combo.status).toBe(200);

  // Stored as written (both halves survive verbatim — the clamp is applied at RESOLVE time, so a later
  // save of the ceiling alone can still lift the base back up without the human re-entering it)...
  const stored = await storedRateLimit(loomDaemon.baseURL);
  expect(stored.loopBreakerBackoffBaseMs).toBe(86_400_000);
  expect(stored.loopBreakerBackoffCeilingMs).toBe(1_800_000);
  // ...but RESOLVED clamped to the ceiling, which is the value the daemon actually backs off by.
  const resolved = await resolvedRateLimit(loomDaemon.baseURL);
  expect(resolved.loopBreakerBackoffCeilingMs).toBe(1_800_000);
  expect(resolved.loopBreakerBackoffBaseMs).toBe(1_800_000);

  await page.goto(`${loomDaemon.baseURL}/home?tab=settings`);

  // The page does not hide the disagreement: the input shows what was entered, while the `effective:`
  // hint beneath it shows the clamped value the daemon will really use.
  await expect(field(page, BACKOFF_BASE.label)).toHaveValue("1440");
  await expect(box(page, BACKOFF_BASE.label).getByText("effective: 30m")).toBeVisible();
  // No inline error and Save is not blocked — the combination is legal, it is merely clamped.
  await expect(box(page, BACKOFF_BASE.label).getByRole("alert")).toHaveCount(0);
  // And the field says WHY, naming the ceiling rather than its position on screen (the Settings
  // positional-hint trap: "the field above" is true at one viewport width, if any).
  await expect(box(page, BACKOFF_BASE.label)
    .getByText(/Clamped to never exceed the backoff ceiling\./)).toBeVisible();

  // The LIVE advisory states the clamped figure, and it tracks the FORM, not the stored override — the
  // `effective:` hints above cannot do this (they read what is saved, so they do not move while typing).
  const clampNote = globalSection(page).getByTestId("loop-breaker-clamp-note");
  await expect(clampNote).toBeVisible();
  await expect(clampNote).toContainText("no more than 30m");
  // It is a status, not an error: Save stays reachable for a combination the daemon accepts.
  await expect(clampNote).toHaveAttribute("role", "status");

  // Raising the ceiling alone lifts the base back to what was stored all along — the clamp never
  // overwrote it, so the human does not have to re-enter a value they already saved.
  const ceiling = field(page, BACKOFF_CEILING.label);
  await ceiling.fill("1440");
  // The advisory clears as soon as the combination is legal again, BEFORE any save — proof it is driven
  // by the live form rather than the stored override.
  await expect(clampNote).toHaveCount(0);
  await expect(globalSave(page)).toBeEnabled();
  await globalSave(page).click();
  await expect
    .poll(async () => (await resolvedRateLimit(loomDaemon.baseURL)).loopBreakerBackoffBaseMs)
    .toBe(86_400_000);
});
