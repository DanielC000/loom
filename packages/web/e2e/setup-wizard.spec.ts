// Guided-onboarding WIZARD spec (onboarding C5) — proves the direction-B guided flow stands up a real,
// templated workspace end to end against the seeded, isolated daemon, WITHOUT spawning a real claude. The
// wizard is wired entirely to DB-writing setup REST (GET /api/setup/templates + /api/profiles, then
// createProject → applyTemplate) — applying a template inserts agent + task rows only, never a PTY, so the
// hermetic fixture's no-spawn guard stays satisfied (the whole flow is exercised here without a Start click).
//
// Coverage — the DoD's observable acceptance path, driven through the UI from Entry A (/platform launcher):
//   1. The /platform launcher opens the wizard; the template gallery lists the two bundled presets with
//      their agent→profile rosters (role chips + the browser rig badge).
//   2. Pick "Software team" → fill the project step → the review screen shows the full roster, the starter
//      card, and the browser-rig one-time-install advisory — and NOTHING is created until "Apply template".
//   3. Apply → the Done screen shows the AUTHORITATIVE created counts (6 agents · 1 card) from the apply
//      response — the wizard itself spawns no agent.
//   4. "Go to the board" lands on /board with the seeded starter card visible — and the REST twin confirms
//      the new project exists with its full 6-agent set actually present (the observable result, not just
//      that screens rendered).
//
// Entry B (the first-run welcome's "Start guided setup") mounts the SAME <SetupWizard> component with its
// own open-state; the welcome is gated on an EMPTY ordinary-project list (and the fixture pre-dismisses it),
// so it can't be driven on the shared, project-seeded worker daemon — this spec exercises the wizard itself
// via Entry A, which is the identical flow.
import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures/daemon";

test("the guided wizard stands up a templated workspace and lands on its board", async ({ page, loomDaemon }) => {
  const suffix = randomUUID().slice(0, 8);
  const projectName = `wizard-e2e-${suffix}`;
  // Arbitrary paths — POST /api/projects registers the row without touching disk, so the wizard's
  // createProject call succeeds against these (matching the existing Projects "New project" contract).
  const repoPath = `/tmp/loom-wizard-e2e/${projectName}`;
  const vaultPath = `/tmp/loom-wizard-e2e/${projectName}-vault`;

  await page.goto(`${loomDaemon.baseURL}/platform`);

  // Entry A — the guided-setup launcher on the Platform page opens the wizard overlay.
  await page.getByRole("button", { name: /Start guided setup/ }).click();

  // Screen 1 — the template gallery lists both bundled presets with their rosters. Pick the software team.
  await expect(page.getByRole("heading", { name: "Choose your team" })).toBeVisible();
  const softwareCard = page.getByRole("radio", { name: /Software team/ });
  await expect(softwareCard).toBeVisible();
  await expect(page.getByRole("radio", { name: /Solo builder/ })).toBeVisible();
  await softwareCard.click();
  await page.getByRole("button", { name: "Continue →" }).click();

  // Screen 2 — the project step. Bind mode is the default; fill the three required fields.
  await expect(page.getByRole("heading", { name: "Point Loom at a project" })).toBeVisible();
  await page.getByLabel("Repository path").fill(repoPath);
  // The name auto-derives from the repo path's last segment — assert it, then leave it (it's unique).
  await expect(page.getByLabel("Project name")).toHaveValue(projectName);
  await page.getByLabel("Vault path").fill(vaultPath);
  await page.getByRole("button", { name: "Continue →" }).click();

  // Screen 3 — review. The full roster + the browser-rig advisory render; nothing is created yet.
  await expect(page.getByRole("heading", { name: "Review & confirm" })).toBeVisible();
  await expect(page.getByText(projectName, { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Code Reviewer", { exact: false }).first()).toBeVisible();
  // The browser rigs (QA Tester + Web Designer) drive the one-time-install advisory.
  await expect(page.getByText("npx playwright install chromium", { exact: false })).toBeVisible();

  // At this point NOTHING has been created — the project must not exist server-side until Apply.
  const preApply = await (await fetch(`${loomDaemon.baseURL}/api/projects`)).json();
  expect((preApply as { name: string }[]).some((p) => p.name === projectName)).toBe(false);

  // Apply — createProject THEN applyTemplate, both DB writes (no PTY spawn).
  await page.getByRole("button", { name: "Apply template →" }).click();

  // Screen 4 — Done. The authoritative created counts from the apply response (6 agents · 1 card).
  await expect(page.getByRole("heading", { name: `${projectName} is ready` })).toBeVisible();
  await expect(page.getByText("6", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("agents created", { exact: false })).toBeVisible();

  // "Go to the board" lands on the NEW project's board with its seeded starter card visible.
  await page.getByRole("button", { name: "Go to the board →" }).click();
  await expect(page).toHaveURL(/\/board$/);
  await expect(page.getByText("Get oriented in this project", { exact: false })).toBeVisible();

  // REST twin — the observable result: the project exists with its full 6-agent set actually present.
  const projects = (await (await fetch(`${loomDaemon.baseURL}/api/projects`)).json()) as { id: string; name: string }[];
  const created = projects.find((p) => p.name === projectName);
  expect(created).toBeTruthy();
  const agents = (await (await fetch(`${loomDaemon.baseURL}/api/projects/${created!.id}/agents`)).json()) as { name: string }[];
  expect(agents.map((a) => a.name).sort()).toEqual(
    ["Bugfix", "Code Reviewer", "Dev", "Orchestrator", "QA Tester", "Web Designer"],
  );
});

test("the wizard's Start-empty path registers a project with no agents", async ({ page, loomDaemon }) => {
  const suffix = randomUUID().slice(0, 8);
  const projectName = `wizard-empty-${suffix}`;
  const repoPath = `/tmp/loom-wizard-e2e/${projectName}`;
  const vaultPath = `/tmp/loom-wizard-e2e/${projectName}-vault`;

  await page.goto(`${loomDaemon.baseURL}/platform`);
  await page.getByRole("button", { name: /Start guided setup/ }).click();

  // Choose the subtle "Start empty" escape hatch, then walk through the project step.
  await page.getByRole("button", { name: /Start with an empty project/ }).click();
  await page.getByRole("button", { name: "Continue →" }).click();

  await page.getByLabel("Repository path").fill(repoPath);
  await page.getByLabel("Vault path").fill(vaultPath);
  await page.getByRole("button", { name: "Continue →" }).click();

  // Review shows the empty-project note (no roster, no template).
  await expect(page.getByText("No template — a blank project.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Apply template →" }).click();

  // Done — zero agents; the Orchestrator spawn shortcut is absent (nothing to spawn).
  await expect(page.getByRole("heading", { name: `${projectName} is ready` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Spawn the Orchestrator" })).toHaveCount(0);

  // REST twin: the project exists with no agents.
  const projects = (await (await fetch(`${loomDaemon.baseURL}/api/projects`)).json()) as { id: string; name: string }[];
  const created = projects.find((p) => p.name === projectName);
  expect(created).toBeTruthy();
  const agents = (await (await fetch(`${loomDaemon.baseURL}/api/projects/${created!.id}/agents`)).json()) as unknown[];
  expect(agents).toEqual([]);
});
