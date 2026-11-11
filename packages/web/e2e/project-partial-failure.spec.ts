// Card 5ccd5ee3 — the project lifecycle's stale-startup-prompt warning (shown after a rename) is gated on the
// update mutation's success, and the component owning that mutation does not remount on a project switch —
// so a warning from renaming project A kept rendering after switching to project B. The fix scopes it to the
// project the save was for.
//
// Written against the classic Projects page; ported by card acbb6df6 to that page's successor, the project
// node's Settings tab (pages/Settings.tsx › ProjectLifecyclePanel), which owns the same mutation the same
// way. The card's other leg (the Projects page's own create form) was deleted with that form.
//
// Nothing here can cause a real claude spawn: a rename is a DB write only, and nothing reaches
// POST /api/agents/:id/sessions (startSession) — per project memory [[e2e-createproject-binds-a-real-repo-spawn-hazard]].
import { expect, test, type Page } from "./fixtures/daemon";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

const lifecycle = (page: Page) => page.getByTestId("settings-section-project-lifecycle");

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
  await page.goto(`${loomDaemon.baseURL}/settings`);
  await expect(lifecycle(page)).toBeVisible();

  // Rename A — triggers the stale-prompt lint (the agent's prompt still names the OLD name).
  await lifecycle(page).getByPlaceholder("name").fill(`${projectA.name}-renamed`);
  await lifecycle(page).getByRole("button", { name: "Save changes" }).click();

  // Sanity control: the warning DOES fire for the project it actually describes.
  await expect(page.getByText(/still reference the OLD value/)).toBeVisible();

  // Switch to project B IN PLACE — through the tree's own project row, then the node's Settings tab — so the
  // page never reloads and the lifecycle section's owner keeps its mutation state across the switch. Any
  // leak here comes from that state, not from a remount.
  await page.getByTestId("atlas-tree").getByRole("button", { name: projectB.name, exact: true }).click();
  await page.getByTestId("atlas-tab-settings").click();
  await expect(page).toHaveURL(/\/settings$/);
  // Identity: the section now shows B's own name, so the switch really happened.
  await expect(lifecycle(page).getByPlaceholder("name")).toHaveValue(projectB.name);

  // THE FIX: B has no stale prompts of its own — the warning must not render here.
  await expect(page.getByText(/still reference the OLD value/)).toHaveCount(0);
});
