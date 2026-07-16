// Reference-repos editor e2e (reference-repos epic Phase 4, card f4888775) — the Projects page's
// "Manage project" collapsible now carries a repo-list editor for a project's `referenceRepos` (the
// read-only SIBLING repos, DISTINCT from the primary `repoPath`). This spec drives the full loop on the
// real isolated daemon: empty state → add + Save a VALID absolute git-repo path → confirm it PERSISTS
// through a reload → add a BAD path and confirm the server's 400 validation error surfaces INLINE (not an
// alert), leaving the already-saved good row intact.
//
// The VALID path is the seeded project's OWN repoPath — a real `git init` dir the fixture created — read
// back off GET /api/projects. The validator only requires absolute + isGitRepo, so reusing it is a
// legitimate existing git repo to bind as a reference. No real claude ever spawns (pure REST + UI).
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// Open the selected project's "Manage project" collapsible (where the reference-repos editor lives).
async function openManage(page: Page) {
  const toggle = page.getByRole("button", { name: /Manage project/ });
  await expect(toggle).toBeVisible();
  await toggle.click();
}

test.describe("reference-repos editor (card f4888775)", () => {
  test("view empty → add + save a valid repo → persists → bad path surfaces the server error inline", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`refrepos-${Date.now()}`);
    // The project's own repoPath is a real git repo on the daemon host — a valid reference-repo target.
    const list = await (await fetch(`${loomDaemon.baseURL}/api/projects`)).json() as { id: string; repoPath: string }[];
    const validPath = list.find((p) => p.id === project.id)!.repoPath;
    expect(validPath).toBeTruthy();

    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/projects`);
    await openManage(page);

    // Empty state: a quiet "none" line, NOT a phantom blank input row.
    await expect(page.getByText("No reference repos.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: /Reference repo 1/ })).toHaveCount(0);

    // Add a row, type the valid absolute git-repo path, and Save.
    await page.getByRole("button", { name: /Add repo/ }).click();
    const row1 = page.getByRole("textbox", { name: /Reference repo 1/ });
    await expect(row1).toBeVisible();
    await row1.fill(validPath);
    const saveBtn = page.getByRole("button", { name: /Save reference repos/ });
    await saveBtn.click();
    // Observable success: the server accepted it, local state syncs to saved, so Save goes disabled (not dirty).
    await expect(saveBtn).toBeDisabled();

    // PERSISTENCE: reload the page fresh and confirm the saved row round-tripped through the server.
    await page.goto(`${loomDaemon.baseURL}/projects`);
    await openManage(page);
    await expect(page.getByRole("textbox", { name: /Reference repo 1/ })).toHaveValue(validPath);
    // No lingering error, no phantom blank row.
    await expect(page.getByRole("alert")).toHaveCount(0);

    // BAD PATH: add a second row with a non-existent path, Save, and confirm the server's 400 surfaces inline.
    await page.getByRole("button", { name: /Add repo/ }).click();
    const badPath = "/no/such/loom/reference/repo/xyz";
    await page.getByRole("textbox", { name: /Reference repo 2/ }).fill(badPath);
    await page.getByRole("button", { name: /Save reference repos/ }).click();
    const err = page.getByRole("alert");
    await expect(err).toBeVisible();
    await expect(err).toContainText(badPath);
    await expect(err).toContainText(/not an existing git repository|absolute/);

    // The already-saved good row is untouched (the server rejects the whole array atomically — no partial write).
    await expect(page.getByRole("textbox", { name: /Reference repo 1/ })).toHaveValue(validPath);

    // Remove the bad row and confirm the error clears on edit.
    await page.getByRole("button", { name: /Remove reference repo 2/ }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: /Reference repo 2/ })).toHaveCount(0);
  });
});
