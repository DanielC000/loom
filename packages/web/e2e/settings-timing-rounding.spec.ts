// Card 0a5d61c9 — the Settings timing fields convert to WHOLE milliseconds, and every daemon-global ms
// field states its bound in the unit it is entered in.
//
// Two defects, both only visible by EXERCISING a control (a render-only pass reads perfectly fine either
// way, and the second one fails as a *disabled* button):
//   1. `Number(s) * UNIT_MS[unit]` with no rounding. Every server-side ms validator is `.int()`, so
//      `16.1` in a seconds field sent 16100.000000000002 and came back 400 "Expected integer". The fix is
//      ONE rounding helper (`src/lib/msUnits.ts` › msFromUnit) that every timing field routes through.
//   2. The daemon-global grid passed no `bounds`, so an out-of-range entry round-tripped to a 400 quoting
//      the raw MILLISECOND limit under an s/m/h label — the confusion card 48365fda fixed for the three
//      PER-PROJECT timeouts only.
//
// Both are proved with a POSITIVE CONTROL against the same daemon in the same test: the unrounded float
// and the raw-ms bound are each pushed over REST directly, and the 400 they produce is what the UI is
// shown no longer to generate. Without that, "it saved" would not distinguish the fix from a server that
// had quietly started accepting floats.
//
// Runs against the shared `loomDaemon` fixture — its own scratch LOOM_HOME on an OS-assigned port, never
// the owner's :4317, serving the built bundle (no dev-server proxy to point at the wrong daemon).
import { expect, test } from "./fixtures/daemon";

// Same locator discipline as settings.spec.ts: pin the EXACT label span, then descend to the control.
// getByLabel is unusable here — each <label> nests its hint text into the accessible name.
function field(page: import("@playwright/test").Page, labelText: string) {
  return page
    .locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`)
    .locator("input, select, textarea");
}
function box(page: import("@playwright/test").Page, labelText: string) {
  return page.locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`);
}
async function pinActiveProject(page: import("@playwright/test").Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

/** The platform override as the daemon currently stores it. */
async function platformOverride(baseURL: string): Promise<Record<string, Record<string, number> | number>> {
  const res = await fetch(`${baseURL}/api/platform/config`);
  const body = (await res.json()) as { override?: Record<string, Record<string, number> | number> };
  return body.override ?? {};
}

test("a fractional daemon-global timing entry saves as a WHOLE millisecond integer (card 0a5d61c9)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-rounding-global-${Date.now()}`);
  await pinActiveProject(page, project.id);

  // POSITIVE CONTROL, before touching the UI: the server really does reject the unrounded product, so a
  // green save below cannot be a server that silently started tolerating floats.
  const floatPatch = await fetch(`${loomDaemon.baseURL}/api/platform/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timeouts: { gitPushMs: 16.1 * 1000 } }),
  });
  expect(floatPatch.status).toBe(400);
  expect(await floatPatch.text()).toMatch(/int/i);
  // And identity: the rejected PATCH changed NOTHING, so the read-back at the end is provably our write.
  // Snapshot-compared rather than asserted empty -- the fixture daemon is worker-SCOPED, so an earlier spec
  // in the same worker may already have written a platform override (and the PATCH handler's own deep merge
  // can leave an emptied group behind as `{}` rather than deleting the key).
  const beforeFloat = JSON.stringify(await platformOverride(loomDaemon.baseURL));
  expect(JSON.stringify(await platformOverride(loomDaemon.baseURL))).toBe(beforeFloat);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  // Three fields, three different display units — each entered with a value whose raw product is a float:
  //   16.1 s  -> 16100.000000000002
  //   16.1 m  -> 966000.0000000001
  //   1.1 h   -> 3960000.0000000005
  const gitPush = field(page, "Git push (s)");
  const usageCadence = field(page, "Usage-sample cadence (m) · restart required");
  const recency = field(page, "Recency window (h)");
  await expect(gitPush).toBeVisible();

  // BEFORE: the global form is clean (the LAST "saved" marker is the global section's) and no range error
  // is showing anywhere.
  await expect(page.getByText("saved", { exact: true }).last()).toBeVisible();
  await expect(box(page, "Git push (s)").getByRole("alert")).toHaveCount(0);

  await gitPush.fill("16.1");
  await usageCadence.fill("16.1");
  await recency.fill("1.1");

  // AFTER (form state): the entries are in range, so no inline error and Save is reachable.
  await expect(box(page, "Git push (s)").getByRole("alert")).toHaveCount(0);
  const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
  await expect(globalSave).toBeEnabled();
  await globalSave.click();

  // AFTER (persisted): exact whole-ms integers. The pre-fix code sent the floats above and 400'd here.
  await expect
    .poll(async () => {
      const ov = await platformOverride(loomDaemon.baseURL);
      return [
        (ov.timeouts as Record<string, number> | undefined)?.gitPushMs ?? null,
        ov.usageSampleIntervalMs ?? null,
        (ov.rateLimit as Record<string, number> | undefined)?.recencyWindowMs ?? null,
      ];
    })
    .toEqual([16_100, 966_000, 3_960_000]);

  // The save genuinely succeeded (no inline server error left on the form) and the form is clean again.
  await expect(page.getByText("saved", { exact: true }).last()).toBeVisible();

  // And it round-trips: a reload re-seeds each field from the stored ms in its OWN unit.
  await page.reload();
  await expect(field(page, "Git push (s)")).toHaveValue("16.1");
  await expect(field(page, "Usage-sample cadence (m) · restart required")).toHaveValue("16.1");
  await expect(field(page, "Recency window (h)")).toHaveValue("1.1");
});

test("a fractional PER-PROJECT timeout saves as a whole millisecond too (the applyMs path, card 0a5d61c9)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-rounding-project-${Date.now()}`);
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);

  const gate = field(page, "Gate command timeout (s)");
  await expect(gate).toBeVisible();
  await gate.fill("16.1");

  const projectSave = page.getByRole("button", { name: "Save", exact: true }).first();
  await expect(box(page, "Gate command timeout (s)").getByRole("alert")).toHaveCount(0);
  await expect(projectSave).toBeEnabled();
  await projectSave.click();

  await expect
    .poll(async () => {
      const res = await fetch(`${loomDaemon.baseURL}/api/projects`);
      const projects = (await res.json()) as Array<{ id: string; config?: { orchestration?: { gateCommandTimeoutMs?: number } } }>;
      // Identity: resolve OUR seeded project, never "the first one" — the daemon is shared across specs.
      return projects.find((p) => p.id === project.id)?.config?.orchestration?.gateCommandTimeoutMs ?? null;
    })
    .toBe(16_100);
});

test("daemon-global timing fields state their bound in the DISPLAYED unit and block an out-of-range entry (card 0a5d61c9)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`settings-global-bounds-${Date.now()}`);
  await pinActiveProject(page, project.id);

  // POSITIVE CONTROL: this is the message the user used to read — a raw millisecond ceiling under a field
  // labelled in seconds. Captured here so the UI assertions below are measured against the real thing.
  const overPatch = await fetch(`${loomDaemon.baseURL}/api/platform/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timeouts: { gitPushMs: 900_000 } }),
  });
  expect(overPatch.status).toBe(400);
  expect(await overPatch.text()).toMatch(/600000/);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  // DoD — the permitted range is visible in the field's OWN unit before anything goes wrong. Three units,
  // three different shared bounds, so the hint is provably driven per-field rather than one reused pair.
  const gitPushBox = box(page, "Git push (s)");
  await expect(gitPushBox.getByText("min 1s · max 600s")).toBeVisible();
  await expect(box(page, "Recency window (h)").getByText("min 0h · max 24h")).toBeVisible();
  await expect(box(page, "Context watch (s)").getByText("min 5s · max 3600s")).toBeVisible();
  await expect(box(page, "Update-check cadence (h) · restart required").getByText("min 1h · max 24h")).toBeVisible();

  const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();
  const gitPush = field(page, "Git push (s)");

  // BEFORE: no error, Save merely not-dirty.
  await expect(gitPushBox.getByRole("alert")).toHaveCount(0);

  // AFTER: the same 900s the REST control above was told "<=600000" about now reads in SECONDS, inline,
  // and blocks Save — so the raw-ms message is never what the user sees.
  await gitPush.fill("900");
  await expect(gitPushBox.getByRole("alert")).toHaveText("must be between 1s and 600s");
  await expect(globalSave).toBeDisabled();
  // The blocked Save names the offending field rather than failing silently.
  await expect(page.getByText("Git push (s) must be between 1s and 600s").last()).toBeVisible();
  await expect(page.getByText(/<=\s*600000/)).toHaveCount(0);

  // The floor end is caught too, not just the ceiling.
  await gitPush.fill("0.5");
  await expect(gitPushBox.getByRole("alert")).toHaveText("must be between 1s and 600s");
  await expect(globalSave).toBeDisabled();

  // AFTER (recovered): back in range → the error clears, Save is reachable, and it actually persists —
  // the guard rejects out-of-range entries, it does not wedge the form.
  await gitPush.fill("45");
  await expect(gitPushBox.getByRole("alert")).toHaveCount(0);
  await expect(globalSave).toBeEnabled();
  await globalSave.click();
  await expect
    // Read the ONE key this test writes, never the whole group -- see the shared-daemon note above.
    .poll(async () => ((await platformOverride(loomDaemon.baseURL)).timeouts as Record<string, number> | undefined)?.gitPushMs ?? null)
    .toBe(45_000);

  // A non-seconds field reports in ITS unit, not translated into seconds or left in ms.
  const recency = field(page, "Recency window (h)");
  const recencyBefore = await recency.inputValue();
  await recency.fill("30");
  await expect(box(page, "Recency window (h)").getByRole("alert")).toHaveText("must be between 0h and 24h");
  await expect(globalSave).toBeDisabled();
  // Restored to whatever it held on load (never assumed blank) -- the inline error clears.
  await recency.fill(recencyBefore);
  await expect(box(page, "Recency window (h)").getByRole("alert")).toHaveCount(0);
});
