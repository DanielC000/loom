// Card 5ccd5ee3 — Projects.tsx's "New project" flow (create → columns → agent-seed) and its
// stale-startup-prompt warning had two related bugs:
//   1. createProject does create → (optional) columns → (optional) agent-seed as one mutation; a later
//      step failing left the already-created project un-invalidated in the ["projects"] cache, AND the
//      obvious retry (same form, still filled — the mutation has no meta.inlineError, so the failure
//      surfaces via the global window.alert, not inline) re-ran createProject from scratch, creating a
//      SECOND project on the same repo.
//   2. The stale-startup-prompt warning (shown after a rename) is gated on `updateProject.isSuccess`,
//      but `updateProject` lives in the parent Projects component, which does not remount on project
//      switch — only the project's own "Manage project" panel does (key={selectedProject.id}) — so a
//      warning from renaming project A kept rendering after switching to project B.
//
// Neither spec below can cause a real claude spawn: creating a project/agent is a DB write only (no PTY,
// same as the setup-wizard specs' own header note), and nothing here reaches POST /api/agents/:id/sessions
// (startSession) — per project memory [[e2e-createproject-binds-a-real-repo-spawn-hazard]].
import { expect, test, type Page } from "./fixtures/daemon";

function collectDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on("dialog", (d) => { seen.push(d.message()); void d.accept(); });
  return seen;
}

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

async function openManage(page: Page) {
  const toggle = page.getByRole("button", { name: /Manage project/ });
  await expect(toggle).toBeVisible();
  await toggle.click();
}

test("a partial createProject failure (agent-seed step) invalidates the list and retry resumes without duplicating the project", async ({ page, loomDaemon }) => {
  const stamp = Date.now();
  // A real git repo on the daemon host (the seed project's own repoPath) to bind the NEW project to —
  // two projects sharing one repo is deliberately legitimate (the card's own ruling: no server-side
  // duplicate-repo guard), so reusing it here is realistic, not a workaround.
  const repoSeed = await loomDaemon.createProject(`projpage-repo-${stamp}`);
  const repoList = (await (await fetch(`${loomDaemon.baseURL}/api/projects`)).json()) as { id: string; repoPath: string }[];
  const repoPath = repoList.find((p) => p.id === repoSeed.id)!.repoPath;
  const projectName = `projpage-new-${stamp}`;

  // Fail the agent-seed step (POST .../agents) while letting createProject itself through — the project
  // is real before this ever fires.
  let failAgentCreate = true;
  await page.route("**/api/projects/*/agents", async (route) => {
    if (route.request().method() !== "POST" || !failAgentCreate) return route.fallback();
    await route.fulfill({
      status: 500, contentType: "application/json",
      body: JSON.stringify({ error: "forced agent-seed failure (card 5ccd5ee3)" }),
    });
  });

  const dialogs = collectDialogs(page);
  await page.goto(`${loomDaemon.baseURL}/projects`);
  await page.getByRole("button", { name: /New project/ }).click();
  await page.getByPlaceholder("name").fill(projectName);
  await page.getByPlaceholder("repo path").fill(repoPath);
  const createBtn = page.getByRole("button", { name: "Create project" });
  await createBtn.click();

  // createProject has NO meta.inlineError, so the failure surfaces via the global MutationCache alert,
  // not an inline message — confirm it actually reached the user (never silent).
  await expect.poll(() => dialogs.length, { message: "the failure must surface to the user at all" }).toBeGreaterThan(0);
  expect(dialogs[0]).toContain("forced agent-seed failure (card 5ccd5ee3)");

  // BEFORE any retry: the project already exists server-side AND the ["projects"] cache was invalidated
  // the instant createProject returned — visible in the rail right now, by BOTH name and repoPath.
  // Scoped to a rail ROW specifically (`aria-pressed` is ListRow's own marker) — the bare project name
  // also appears elsewhere on the page (e.g. the header's project picker), which would otherwise make a
  // plain getByText ambiguous.
  await expect(page.locator("button[aria-pressed]").filter({ hasText: projectName })).toBeVisible();
  const afterFail = (await (await fetch(`${loomDaemon.baseURL}/api/projects`)).json()) as { name: string; repoPath: string }[];
  expect(afterFail.filter((p) => p.name === projectName)).toHaveLength(1);
  expect(afterFail.filter((p) => p.repoPath === repoPath && p.name === projectName)).toHaveLength(1);

  // Retry — the create form is still filled (the failure never cleared it). Same inputs must resume the
  // already-created project (only re-run the agent-seed step), never call createProject a second time.
  failAgentCreate = false;
  await expect(createBtn).toBeEnabled();
  await createBtn.click();

  // Observable success: the create form closes (onSuccess clears `creating`). Matched against BOTH the
  // idle and pending button labels ("Create project" / "Creating…") — the button's accessible name
  // flips to "Creating…" the instant it's clicked, so asserting only the idle label's absence would be
  // satisfied immediately on click, long before the mutation (all 5 awaited agent-create calls) settles.
  await expect(page.getByRole("button", { name: /^(Create project|Creating…)$/ })).toHaveCount(0);

  // No duplicate — checked by BOTH name and repoPath.
  const afterRetry = (await (await fetch(`${loomDaemon.baseURL}/api/projects`)).json()) as { id: string; name: string; repoPath: string }[];
  expect(afterRetry.filter((p) => p.name === projectName)).toHaveLength(1);
  expect(afterRetry.filter((p) => p.repoPath === repoPath && p.name === projectName)).toHaveLength(1);

  // The retry actually re-ran (and this time completed) the agent-seed step — all 5 starter agents exist.
  const created = afterRetry.find((p) => p.name === projectName)!;
  const agents = (await (await fetch(`${loomDaemon.baseURL}/api/projects/${created.id}/agents`)).json()) as { name: string }[];
  expect(agents).toHaveLength(5);
});

test("renaming a project's stale-prompt warning does not leak onto the next selected project", async ({ page, loomDaemon }) => {
  const stamp = Date.now();
  const projectA = await loomDaemon.createProject(`stalewarn-a-${stamp}`);
  const projectB = await loomDaemon.createProject(`stalewarn-b-${stamp}`);

  // An agent on A whose startupPrompt names A's OLD name in the exact load-bearing path-segment shape
  // the server's lint matches (prompt-lint.ts matchesStaleName's own documented example, "Projects/<name>/…").
  const agentRes = await fetch(`${loomDaemon.baseURL}/api/projects/${projectA.id}/agents`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Orchestrator", startupPrompt: `Projects/${projectA.name}/Orchestrator Log.md` }),
  });
  expect(agentRes.ok).toBe(true);

  await pinActiveProject(page, projectA.id);
  await page.goto(`${loomDaemon.baseURL}/projects`);
  await openManage(page);

  // Rename A — triggers the stale-prompt lint (the agent's prompt still names the OLD name).
  await page.getByPlaceholder("name").fill(`${projectA.name}-renamed`);
  await page.getByRole("button", { name: "Save changes" }).click();

  // Sanity control: the warning DOES fire for the project it actually describes.
  await expect(page.getByText(/still reference the OLD value/)).toBeVisible();

  // Switch to project B and re-open ITS OWN Manage panel — it remounts via key={selectedProject.id}, so
  // `open` resets to collapsed; any leak here comes from the PARENT's `updateProject` mutation state, not
  // this panel's own local state.
  await page.getByRole("button", { name: projectB.name, exact: true }).click();
  await openManage(page);

  // THE FIX: B has no stale prompts of its own — the warning must not render here.
  await expect(page.getByText(/still reference the OLD value/)).toHaveCount(0);
});
