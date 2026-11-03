// The WORKER-scoped context ratios on Settings (card 8276e1ea) — `orchestration.workerContextWarnRatio`
// and `orchestration.workerContextInterruptRatio`, the pair card dacc6d9e added to OrchestrationConfig
// with no UI of its own.
//
// Why these assertions and not "the two fields render": a NumField bound to the wrong config key renders
// perfectly — it draws a labelled input with a plausible placeholder either way. So every test here turns
// on an observable that a mis-bound or unsaved field CANNOT produce:
//   1. ROUND-TRIP — type into both, save, then read the STORED override straight back over REST and
//      confirm the two real key names carry the typed numbers (not the sibling manager keys next door),
//      then reload and confirm the inputs re-seed from that persisted override rather than client state.
//   2. CLAMP — save an interrupt ratio BELOW the warn ratio and confirm the interrupt field's own
//      "effective:" hint reads the WARN value. `resolveConfig`'s clamp is what produces that, so this is
//      the one assertion that proves the clamp sentence printed under the control is true rather than
//      decorative.
//   3. INHERIT — blank both and confirm the keys are DELETED from the override (fall back to the platform
//      default) instead of being persisted as 0, which would silently DISABLE both watchers.
//
// Builds on the shared `loomDaemon` fixture; settings-rotation-markers.spec.ts is the template (same
// pinActiveProject determinism note: the daemon is shared across specs, so each test pins its OWN seeded
// project active).
import { expect, test } from "./fixtures/daemon";

type Page = import("@playwright/test").Page;

const WARN_LABEL = "Worker warn @ ctx ratio";
const INTERRUPT_LABEL = "Worker interrupt @ ctx ratio";

// Platform defaults (packages/shared/src/config.ts PLATFORM_DEFAULTS.orchestration) — asserted rather
// than imported so a silent default change has to come through this spec.
const WARN_DEFAULT = "0.6";
const INTERRUPT_DEFAULT = "0.85";

// Same exact-label locator the sibling settings specs use: a field's <label> nests its Hint text, so
// getByLabel's accessible name is polluted by the hints.
function fieldLabel(page: Page, labelText: string) {
  return page.locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`);
}
function field(page: Page, labelText: string) {
  return fieldLabel(page, labelText).locator("input");
}

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

interface StoredRatios {
  workerContextWarnRatio?: number;
  workerContextInterruptRatio?: number;
  // Read alongside so a test can prove the write did NOT bleed into the adjacent manager pair.
  recycleAtContextRatio?: number;
  emergencyRecycleAtContextRatio?: number;
}

// Read the STORED override (not the resolved config) for one project — the same list endpoint the UI reads.
async function readStored(baseURL: string, projectId: string): Promise<StoredRatios> {
  const res = await fetch(`${baseURL}/api/projects`);
  const projects = (await res.json()) as Array<{ id: string; config?: { orchestration?: StoredRatios } }>;
  const orch = projects.find((p) => p.id === projectId)?.config?.orchestration ?? {};
  return {
    workerContextWarnRatio: orch.workerContextWarnRatio,
    workerContextInterruptRatio: orch.workerContextInterruptRatio,
    recycleAtContextRatio: orch.recycleAtContextRatio,
    emergencyRecycleAtContextRatio: orch.emergencyRecycleAtContextRatio,
  };
}

async function seedRatios(baseURL: string, projectId: string, config: StoredRatios): Promise<void> {
  const res = await fetch(`${baseURL}/api/projects/${projectId}/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: { orchestration: config } }),
  });
  if (!res.ok) throw new Error(`seed PATCH failed: ${res.status} ${await res.text()}`);
}

function projectSaveButton(page: Page) {
  return page.getByRole("button", { name: "Save", exact: true }).first();
}

test("an unconfigured seat shows both ratios inheriting the platform default", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`worker-ctx-render-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  // FIXTURE IDENTITY: a field bound to a DIFFERENT project (or a sibling worker's daemon) would not show
  // an empty override, so assert the unconfigured shape itself rather than mere presence.
  expect(await readStored(loomDaemon.baseURL, project.id)).toEqual({
    workerContextWarnRatio: undefined,
    workerContextInterruptRatio: undefined,
    recycleAtContextRatio: undefined,
    emergencyRecycleAtContextRatio: undefined,
  });

  // Blank input + the platform default in the placeholder = "inherit", which is what an unset key means.
  await expect(field(page, WARN_LABEL)).toHaveValue("");
  await expect(field(page, INTERRUPT_LABEL)).toHaveValue("");
  await expect(field(page, WARN_LABEL)).toHaveAttribute("placeholder", `inherit (${WARN_DEFAULT})`);
  await expect(field(page, INTERRUPT_LABEL)).toHaveAttribute("placeholder", `inherit (${INTERRUPT_DEFAULT})`);
  await expect(fieldLabel(page, WARN_LABEL)).toContainText(`effective: ${WARN_DEFAULT}`);
  await expect(fieldLabel(page, INTERRUPT_LABEL)).toContainText(`effective: ${INTERRUPT_DEFAULT}`);

  // The 0-disables escape and the clamp are stated AT the controls — a reader setting a safety floor has
  // to be told that 0 turns the watcher off rather than meaning "trigger immediately".
  await expect(fieldLabel(page, WARN_LABEL)).toContainText("0 disables");
  await expect(fieldLabel(page, INTERRUPT_LABEL)).toContainText("0 disables");
  // The clamp sentence names the warn ratio BY NAME, not by position. That is deliberate: this grid is
  // 3-up at desktop width and single-column when narrow, so the warn field is sometimes LEFT of the
  // interrupt field and sometimes above it — a positional phrase ("the ratio above", which the adjacent
  // manager pair still uses) is only true at one of those widths.
  await expect(fieldLabel(page, INTERRUPT_LABEL)).toContainText("clamped to never sit below the warn ratio");
  // Still assert the pair reads warn-then-interrupt, in whichever direction this width lays them out.
  const warnBox = await fieldLabel(page, WARN_LABEL).boundingBox();
  const interruptBox = await fieldLabel(page, INTERRUPT_LABEL).boundingBox();
  if (!warnBox || !interruptBox) throw new Error("a worker-ratio field has no layout box");
  const warnComesFirst = warnBox.y < interruptBox.y || (warnBox.y === interruptBox.y && warnBox.x < interruptBox.x);
  expect(warnComesFirst, `warn at (${warnBox.x},${warnBox.y}) must read before interrupt at (${interruptBox.x},${interruptBox.y})`).toBe(true);
});

test("ROUND-TRIP: both ratios persist under their own keys and re-seed on reload", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`worker-ctx-save-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  // BEFORE (observable): neither key is in the stored override.
  const before = await readStored(loomDaemon.baseURL, project.id);
  expect(before.workerContextWarnRatio).toBeUndefined();
  expect(before.workerContextInterruptRatio).toBeUndefined();
  await expect(field(page, WARN_LABEL)).toHaveValue("");

  await field(page, WARN_LABEL).fill("0.5");
  await field(page, INTERRUPT_LABEL).fill("0.75");

  const save = projectSaveButton(page);
  await expect(save).toBeEnabled(); // the edit registered as dirty — a read-only field would leave it disabled
  await save.click();

  // AFTER (observable #1): the STORED override carries both typed numbers, under the REAL key names. The
  // adjacent manager pair stays unset, which is what rules out a mis-bound field writing its neighbour.
  await expect
    .poll(async () => await readStored(loomDaemon.baseURL, project.id))
    .toEqual({
      workerContextWarnRatio: 0.5,
      workerContextInterruptRatio: 0.75,
      recycleAtContextRatio: undefined,
      emergencyRecycleAtContextRatio: undefined,
    });

  // AFTER (observable #2): a full reload re-seeds from the persisted override, not optimistic client state.
  await page.reload();
  await expect(field(page, WARN_LABEL)).toHaveValue("0.5");
  await expect(field(page, INTERRUPT_LABEL)).toHaveValue("0.75");
  // The effective hints follow the saved values, so the resolved config really changed too.
  await expect(fieldLabel(page, WARN_LABEL)).toContainText("effective: 0.5");
  await expect(fieldLabel(page, INTERRUPT_LABEL)).toContainText("effective: 0.75");
});

test("CLAMP: an interrupt ratio saved below the warn ratio resolves UP to it", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`worker-ctx-clamp-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  // An interrupt floor sitting UNDER the warn floor is incoherent, so resolveConfig raises it. The raw
  // value is still stored as typed — the clamp is a resolve-time read, not a write-time rewrite — so the
  // input and its own effective hint DISAGREE, and that disagreement is the whole observable.
  await field(page, WARN_LABEL).fill("0.7");
  await field(page, INTERRUPT_LABEL).fill("0.5");
  await projectSaveButton(page).click();

  await expect
    .poll(async () => await readStored(loomDaemon.baseURL, project.id))
    .toMatchObject({ workerContextWarnRatio: 0.7, workerContextInterruptRatio: 0.5 });

  await page.reload();
  await expect(field(page, INTERRUPT_LABEL)).toHaveValue("0.5"); // stored as typed
  await expect(fieldLabel(page, INTERRUPT_LABEL)).toContainText("effective: 0.7"); // but resolves to the warn floor
  // Control on the same element: the un-clamped number must NOT be what takes effect.
  await expect(fieldLabel(page, INTERRUPT_LABEL)).not.toContainText("effective: 0.5");
});

test("INHERIT: blanking a configured ratio deletes the key rather than storing 0", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`worker-ctx-clear-${Date.now()}`);
  await seedRatios(loomDaemon.baseURL, project.id, {
    workerContextWarnRatio: 0.4,
    workerContextInterruptRatio: 0.9,
  });
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  // BEFORE (observable): the seeded override really is what the fields are showing.
  await expect(field(page, WARN_LABEL)).toHaveValue("0.4");
  await expect(field(page, INTERRUPT_LABEL)).toHaveValue("0.9");

  await field(page, WARN_LABEL).fill("");
  await field(page, INTERRUPT_LABEL).fill("");
  await projectSaveButton(page).click();

  // AFTER: both keys are GONE from the override. Storing 0 instead would read as "disabled" and silently
  // switch off both watchers for this project — the failure this assertion exists to catch.
  await expect
    .poll(async () => await readStored(loomDaemon.baseURL, project.id))
    .toEqual({
      workerContextWarnRatio: undefined,
      workerContextInterruptRatio: undefined,
      recycleAtContextRatio: undefined,
      emergencyRecycleAtContextRatio: undefined,
    });

  await page.reload();
  await expect(field(page, WARN_LABEL)).toHaveValue("");
  await expect(fieldLabel(page, WARN_LABEL)).toContainText(`effective: ${WARN_DEFAULT}`);
  await expect(fieldLabel(page, INTERRUPT_LABEL)).toContainText(`effective: ${INTERRUPT_DEFAULT}`);
});
