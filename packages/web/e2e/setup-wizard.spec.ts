// Guided-onboarding WIZARD spec (onboarding C5) — proves the direction-B guided flow stands up a real,
// templated workspace end to end against the seeded, isolated daemon, WITHOUT spawning a real claude. The
// wizard is wired entirely to DB-writing setup REST (GET /api/setup/templates + /api/profiles, then
// createProject → applyTemplate) — applying a template inserts agent + task rows only, never a PTY, so the
// hermetic fixture's no-spawn guard stays satisfied (the whole flow is exercised here without a Start click).
//
// Since commit 5a873f6, POST /api/projects (and POST /api/setup/project-init) isGitRepo-validate the
// primary repoPath, so the wizard's Repository path field must be a REAL git repo — these specs read one
// off a fixture-seeded project (the fixture `git init`s each project's repoPath). That same real repo (and a
// second seeded one) doubles as a valid reference-repo target, since the validator only requires
// absolute + isGitRepo.
//
// Coverage — the DoD's observable acceptance path, driven through the UI from Entry A (/platform launcher):
//   1. The /platform launcher opens the wizard; the template gallery lists the two bundled presets with
//      their agent→profile rosters (role chips + the browser rig badge).
//   2. Pick "Software team" → fill the project step, bind a read-only reference repo → the review screen
//      shows the roster + the reference repo — and NOTHING is created until "Apply template".
//   3. Apply → the Done screen; the REST twin confirms the project persisted its `referenceRepos`.
//   4. A BAD reference-repo path surfaces the server's 400 validation error INLINE on the review screen,
//      and creates nothing.
//
// Entry B (the first-run welcome's "Start guided setup") mounts the SAME <SetupWizard> component with its
// own open-state; the welcome is gated on an EMPTY ordinary-project list (and the fixture pre-dismisses it),
// so it can't be driven on the shared, project-seeded worker daemon — this spec exercises the wizard itself
// via Entry A, which is the identical flow.
import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures/daemon";

// A seeded project's real on-disk repoPath + vaultPath (the fixture `git init`s repoPath). The wizard types
// these into its fields, which POST /api/projects now isGitRepo-validates — so they must be REAL paths.
async function realPaths(baseURL: string, projectId: string): Promise<{ repoPath: string; vaultPath: string }> {
  const list = (await (await fetch(`${baseURL}/api/projects`)).json()) as { id: string; repoPath: string; vaultPath: string }[];
  const p = list.find((x) => x.id === projectId)!;
  return { repoPath: p.repoPath, vaultPath: p.vaultPath };
}

test("the guided wizard stands up a templated workspace, binds a reference repo, and lands on its board", async ({ page, loomDaemon }) => {
  const suffix = randomUUID().slice(0, 8);
  const projectName = `wizard-e2e-${suffix}`;
  // Two real git repos on the daemon host: one to BIND as the primary repo, one to add as a read-only reference.
  const primary = await loomDaemon.createProject(`wizard-primary-${suffix}`);
  const sibling = await loomDaemon.createProject(`wizard-sibling-${suffix}`);
  const { repoPath, vaultPath } = await realPaths(loomDaemon.baseURL, primary.id);
  const { repoPath: refRepo } = await realPaths(loomDaemon.baseURL, sibling.id);

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

  // Screen 2 — the project step. Bind mode is the default; fill the required fields with the REAL repo path,
  // set a unique name, then bind a read-only reference repo (a distinct field from the primary repo).
  await expect(page.getByRole("heading", { name: "Point Loom at a project" })).toBeVisible();
  await page.getByLabel("Repository path").fill(repoPath);
  await page.getByLabel("Project name").fill(projectName);
  await page.getByLabel("Vault path").fill(vaultPath);
  // The reference-repos editor: empty state, then add + fill one row.
  await expect(page.getByText("None — this project reads only its primary repo.")).toBeVisible();
  await page.getByRole("button", { name: /Add reference repo/ }).click();
  await page.getByRole("textbox", { name: /Reference repo 1/ }).fill(refRepo);
  await page.getByRole("button", { name: "Continue →" }).click();

  // Screen 3 — review. The roster renders, the reference repo shows on the receipt, and nothing is created yet.
  await expect(page.getByRole("heading", { name: "Review & confirm" })).toBeVisible();
  await expect(page.getByText("Code Reviewer", { exact: false }).first()).toBeVisible();
  await expect(page.getByText(refRepo, { exact: false }).first()).toBeVisible();

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

  // REST twin — the observable result: the project exists, its full 6-agent set is present, AND the reference
  // repo persisted through createProject (the whole point of this card).
  const projects = (await (await fetch(`${loomDaemon.baseURL}/api/projects`)).json()) as { id: string; name: string; referenceRepos: string[] }[];
  const created = projects.find((p) => p.name === projectName);
  expect(created).toBeTruthy();
  expect(created!.referenceRepos).toContain(refRepo);
  const agents = (await (await fetch(`${loomDaemon.baseURL}/api/projects/${created!.id}/agents`)).json()) as { name: string }[];
  expect(agents.map((a) => a.name).sort()).toEqual(
    ["Bugfix", "Code Reviewer", "Dev", "Orchestrator", "QA Tester", "Web Designer"],
  );
});

test("the wizard surfaces the server's reference-repo validation error inline and creates nothing", async ({ page, loomDaemon }) => {
  const suffix = randomUUID().slice(0, 8);
  const projectName = `wizard-badref-${suffix}`;
  // A real primary repo so validation REACHES the reference-repo check (repoPath is validated first).
  const primary = await loomDaemon.createProject(`wizard-badref-primary-${suffix}`);
  const { repoPath, vaultPath } = await realPaths(loomDaemon.baseURL, primary.id);
  const badRef = "/no/such/loom/wizard/reference/repo/xyz";

  await page.goto(`${loomDaemon.baseURL}/platform`);
  await page.getByRole("button", { name: /Start guided setup/ }).click();

  // Start empty keeps it minimal — the createProject call is what validates the reference repos.
  await page.getByRole("button", { name: /Start with an empty project/ }).click();
  await page.getByRole("button", { name: "Continue →" }).click();

  await page.getByLabel("Repository path").fill(repoPath);
  await page.getByLabel("Project name").fill(projectName);
  await page.getByLabel("Vault path").fill(vaultPath);
  await page.getByRole("button", { name: /Add reference repo/ }).click();
  await page.getByRole("textbox", { name: /Reference repo 1/ }).fill(badRef);
  await page.getByRole("button", { name: "Continue →" }).click();

  // Apply fails — the server's 400 reason surfaces INLINE on the review screen (not a bare `-> 400`),
  // announced via role="alert". It names the offending path AND the validation reason.
  await expect(page.getByRole("heading", { name: "Review & confirm" })).toBeVisible();
  await page.getByRole("button", { name: "Apply template →" }).click();
  const err = page.getByRole("alert");
  await expect(err).toBeVisible();
  await expect(err).toContainText(badRef);
  await expect(err).toContainText(/not an existing git repository|absolute/);

  // Nothing was created — the create 400'd atomically, so no project row exists.
  const projects = (await (await fetch(`${loomDaemon.baseURL}/api/projects`)).json()) as { name: string }[];
  expect(projects.some((p) => p.name === projectName)).toBe(false);
});

test("the wizard's Start-empty path registers a project with no agents", async ({ page, loomDaemon }) => {
  const suffix = randomUUID().slice(0, 8);
  const projectName = `wizard-empty-${suffix}`;
  // A real git repo for the primary repoPath (now isGitRepo-validated on POST /api/projects).
  const primary = await loomDaemon.createProject(`wizard-empty-primary-${suffix}`);
  const { repoPath, vaultPath } = await realPaths(loomDaemon.baseURL, primary.id);

  await page.goto(`${loomDaemon.baseURL}/platform`);
  await page.getByRole("button", { name: /Start guided setup/ }).click();

  // Choose the subtle "Start empty" escape hatch, then walk through the project step.
  await page.getByRole("button", { name: /Start with an empty project/ }).click();
  await page.getByRole("button", { name: "Continue →" }).click();

  await page.getByLabel("Repository path").fill(repoPath);
  await page.getByLabel("Project name").fill(projectName);
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
