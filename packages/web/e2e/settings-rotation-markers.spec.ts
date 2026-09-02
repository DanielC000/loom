// Rotation-config Settings surface (card 2830748c) — proves the human/REST path is genuinely SYMMETRIC.
//
// Why this spec is shaped around REMOVAL rather than "the panel renders": the additive-only guard
// (mcp/platform.ts's applyAdditiveOnlyRotationGuard, reached via mergeConfigOverride on every AGENT-facing
// config write) makes `orchestration.rotationMarkers` grow-only and `rotationLiveCommitmentsFloor`
// rise-only for a manager/setup agent. The config docs name the human REST path as the escape hatch, and
// until this panel existed the owner had no route to it. So the load-bearing assertions here are exactly
// the operations an agent is FORBIDDEN to perform:
//   1. SHRINK — remove one marker from a seeded 3-marker set and lower the floor, then read the stored
//      override straight back over REST (2 markers, lower floor) and confirm a reload re-seeds it.
//   2. CLEAR — remove the remaining markers and blank the heading; the keys are DELETED from the override
//      (inherit the platform default) rather than persisted empty.
// A render-only check would pass against a read-only panel, so it would not test the card at all.
//
// Builds on the shared `loomDaemon` fixture; settings.spec.ts is the template (same pinActiveProject
// determinism note: the daemon is shared across specs, so each test pins its OWN seeded project active).
import { expect, test } from "./fixtures/daemon";

type Page = import("@playwright/test").Page;

// Same exact-label locator settings.spec.ts uses: a field's <label> nests its Hint text, so getByLabel's
// accessible name is polluted. The marker rows carry explicit aria-labels instead and are located directly.
function field(page: Page, labelText: string) {
  return page.locator(`label:has(> span:text-is(${JSON.stringify(labelText)}))`).locator("input, select, textarea");
}

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

interface StoredRotation {
  rotationMarkers?: Array<{ token: string; caseSensitive?: boolean; note?: string }>;
  rotationLiveCommitmentsHeading?: string;
  rotationLiveCommitmentsFloor?: number;
}

// Read the STORED override (not the resolved config) for one project — the same list endpoint the UI reads.
async function readStored(baseURL: string, projectId: string): Promise<StoredRotation> {
  const res = await fetch(`${baseURL}/api/projects`);
  const projects = (await res.json()) as Array<{ id: string; config?: { orchestration?: StoredRotation } }>;
  const orch = projects.find((p) => p.id === projectId)?.config?.orchestration;
  return {
    rotationMarkers: orch?.rotationMarkers,
    rotationLiveCommitmentsHeading: orch?.rotationLiveCommitmentsHeading,
    rotationLiveCommitmentsFloor: orch?.rotationLiveCommitmentsFloor,
  };
}

// Seed a configured rotation set over the human REST PATCH — the state the guard protects, and the
// precondition the whole card rests on (an UNCONFIGURED seat has nothing to release).
async function seedRotation(baseURL: string, projectId: string, config: StoredRotation): Promise<void> {
  const res = await fetch(`${baseURL}/api/projects/${projectId}/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: { orchestration: config } }),
  });
  if (!res.ok) throw new Error(`seed PATCH failed: ${res.status} ${await res.text()}`);
}

const SEEDED = {
  rotationMarkers: [
    { token: "LIVE COMMITMENTS", note: "the numbered section itself" },
    { token: "capQueued", caseSensitive: true },
    { token: "gate cap is 2" },
  ],
  rotationLiveCommitmentsHeading: "LIVE COMMITMENTS",
  rotationLiveCommitmentsFloor: 12,
} satisfies StoredRotation;

const markerToken = (page: Page, i: number) => page.getByLabel(`Marker ${i} token`);
const EMPTY_STATE = "No protected markers";

test("renders a configured seat's rotation markers", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`rotation-render-${Date.now()}`);
  await seedRotation(loomDaemon.baseURL, project.id, SEEDED);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  await expect(page.getByText("Resume Doc Rotation", { exact: true })).toBeVisible();
  // FIXTURE IDENTITY: assert the seeded tokens themselves, not just "some rows rendered" — a panel bound to
  // a different project (or to the platform default's empty list) fails here loudly instead of looking fine.
  await expect(markerToken(page, 1)).toHaveValue("LIVE COMMITMENTS");
  await expect(markerToken(page, 2)).toHaveValue("capQueued");
  await expect(markerToken(page, 3)).toHaveValue("gate cap is 2");
  await expect(markerToken(page, 4)).toHaveCount(0); // exactly 3 — no phantom fourth row
  await expect(page.getByLabel("Marker 2 case-sensitive")).toBeChecked();
  await expect(page.getByLabel("Marker 1 case-sensitive")).not.toBeChecked();
  await expect(field(page, "Live-commitments heading")).toHaveValue("LIVE COMMITMENTS");
  await expect(field(page, "Numbered-item floor")).toHaveValue("12");
  // The asymmetry is stated AT the control — that sentence is the card's whole reason for existing.
  await expect(page.getByText(/additive-only/)).toBeVisible();
});

test("SHRINK: removing a marker and lowering the floor persists (the agent-forbidden edit)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`rotation-shrink-${Date.now()}`);
  await seedRotation(loomDaemon.baseURL, project.id, SEEDED);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);

  // BEFORE (observable): 3 seeded markers, floor 12, in the STORE.
  expect(await readStored(loomDaemon.baseURL, project.id)).toMatchObject({
    rotationMarkers: SEEDED.rotationMarkers,
    rotationLiveCommitmentsFloor: 12,
  });
  await expect(markerToken(page, 2)).toHaveValue("capQueued");

  // Remove the middle marker and lower the floor — both are refused on every agent config path.
  await page.getByLabel("Remove marker 2").click();
  await expect(markerToken(page, 2)).toHaveValue("gate cap is 2"); // list re-indexed, row really gone
  await field(page, "Numbered-item floor").fill("8");

  // The weakening notice names BOTH losses before the save commits — the only warning the owner gets.
  const notice = page.getByRole("status").filter({ hasText: "weakens the rotation guard" });
  await expect(notice).toContainText('marker "capQueued" removed');
  await expect(notice).toContainText("floor lowered 12 to 8");

  const projectSave = page.getByRole("button", { name: "Save", exact: true }).first();
  await expect(projectSave).toBeEnabled();
  await projectSave.click();

  // AFTER (observable #1): the STORED override actually SHRANK — 2 markers, floor lowered. This is the
  // round-trip the card exists to provide; an agent's identical patch would have been silently re-grown.
  await expect
    .poll(async () => (await readStored(loomDaemon.baseURL, project.id)).rotationMarkers?.map((m) => m.token))
    .toEqual(["LIVE COMMITMENTS", "gate cap is 2"]);
  expect((await readStored(loomDaemon.baseURL, project.id)).rotationLiveCommitmentsFloor).toBe(8);

  // AFTER (observable #2): a full reload re-seeds from the persisted override, not optimistic client state.
  await page.reload();
  await expect(markerToken(page, 1)).toHaveValue("LIVE COMMITMENTS");
  await expect(markerToken(page, 2)).toHaveValue("gate cap is 2");
  await expect(markerToken(page, 3)).toHaveCount(0);
  await expect(field(page, "Numbered-item floor")).toHaveValue("8");
  // The notice is gone once the shrink IS the saved state — it warns about a pending change, not a fact.
  await expect(page.getByRole("status").filter({ hasText: "weakens the rotation guard" })).toHaveCount(0);
});

test("CLEAR: emptying the markers and heading deletes the keys (inherit, not stored-empty)", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`rotation-clear-${Date.now()}`);
  await seedRotation(loomDaemon.baseURL, project.id, SEEDED);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);
  await expect(markerToken(page, 1)).toHaveValue("LIVE COMMITMENTS");

  // Remove every row from the top — index 1 each time, since the list re-indexes after each removal.
  for (let i = 0; i < SEEDED.rotationMarkers.length; i++) await page.getByLabel("Remove marker 1").click();
  await expect(page.getByText(EMPTY_STATE)).toBeVisible();
  await field(page, "Live-commitments heading").fill("");

  await page.getByRole("button", { name: "Save", exact: true }).first().click();

  // AFTER: the keys are ABSENT from the stored override (inherit the platform default), not persisted as an
  // empty array / empty string — the same blank-means-inherit contract every other field on this page
  // follows. `resume_doc_check` then reports this seat as configured:false again, which is the honest state.
  await expect
    .poll(async () => {
      const stored = await readStored(loomDaemon.baseURL, project.id);
      return {
        markers: stored.rotationMarkers ?? "absent",
        heading: stored.rotationLiveCommitmentsHeading ?? "absent",
      };
    })
    .toEqual({ markers: "absent", heading: "absent" });

  await page.reload();
  await expect(page.getByText(EMPTY_STATE)).toBeVisible();
  await expect(field(page, "Live-commitments heading")).toHaveValue("");
});

test("ADD: a new marker round-trips, and case-sensitive is stored only when set", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`rotation-add-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/settings`);
  // BEFORE: a freshly seeded project has no rotation config at all — the unconfigured empty state.
  await expect(page.getByText(EMPTY_STATE)).toBeVisible();

  await page.getByRole("button", { name: "＋ Add marker" }).click();
  await markerToken(page, 1).fill("DO NOT DROP");
  await page.getByLabel("Marker 1 note").fill("owner directive");
  await page.getByRole("button", { name: "＋ Add marker" }).click();
  await markerToken(page, 2).fill("capQueued");
  await page.getByLabel("Marker 2 case-sensitive").check();

  await page.getByRole("button", { name: "Save", exact: true }).first().click();

  // Growing the set is not a weakening — no notice for an add-only edit.
  await expect(page.getByRole("status").filter({ hasText: "weakens the rotation guard" })).toHaveCount(0);
  await expect
    .poll(async () => (await readStored(loomDaemon.baseURL, project.id)).rotationMarkers)
    .toEqual([
      { token: "DO NOT DROP", note: "owner directive" },
      { token: "capQueued", caseSensitive: true },
    ]);
});
