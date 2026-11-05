// Taskless guarded paths e2e (card 7e15ff89, follow-up to a880c391): edit the project's human-only
// `orchestration.tasklessGuardedPaths` list in Settings, save, reload, clear, reload.
//
// WHAT IS DRIVEN FOR REAL: the save is a click (the human config PATCH), every stored-state assertion reads the daemon
// back keyed to THIS spec's own project id, and the daemon-side rejection is the real daemon's answer to a body the
// editor would never send (rewritten in flight), so the text on screen is the daemon's own.
//
// WHAT THIS DOES NOT PROVE: that a taskless landing is actually refused. The fixture forbids real spawns; that half is
// packages/daemon/test/taskless-landing-guard.mjs.
import { expect, test, type Page } from "./fixtures/daemon";
import path from "node:path";

const shotDir = process.env.LOOM_E2E_SHOTS;
const shoot = async (target: Page | ReturnType<Page["locator"]>, name: string) => { if (shotDir) await target.screenshot({ path: path.join(shotDir, name) }); };

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function storedGuard(baseURL: string, projectId: string): Promise<unknown> {
  const projects = (await (await fetch(`${baseURL}/api/projects`)).json()) as Array<{ id: string; config?: { orchestration?: { tasklessGuardedPaths?: unknown } } }>;
  const row = projects.find((p) => p.id === projectId);
  if (!row) throw new Error(`project ${projectId} is not on this daemon — wrong daemon or wrong id`);
  return row.config?.orchestration?.tasklessGuardedPaths ?? null;
}

test.describe("Taskless guarded paths (card 7e15ff89)", () => {
  test("save a list, reload shows it, clear it, reload shows none", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("tgp-ui"));
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);

    const editor = page.getByTestId("taskless-guarded-paths-editor");
    const input = editor.getByTestId("taskless-guarded-paths-input");
    const save = editor.getByTestId("taskless-guarded-paths-save");
    await expect(input).toHaveValue("");
    await expect(editor.getByTestId("taskless-guarded-paths-count")).toHaveText("no guarded paths");
    await expect(save).toBeDisabled();
    expect(await storedGuard(loomDaemon.baseURL, project.id)).toBeNull();

    // An invalid line is refused before anything is sent, naming the line as typed.
    await input.fill("docs/**\n\n/abs/x");
    await expect(editor.getByTestId("taskless-guarded-paths-draft-error")).toHaveText('Line 3: must be repo-relative (no leading "/")');
    await expect(save).toBeDisabled();

    // Whitespace and blank lines are dropped on save.
    await input.fill("  packages/daemon/src/git/**  \n\n*.lock\n");
    await expect(editor.getByTestId("taskless-guarded-paths-count")).toHaveText("2 guarded paths");
    await expect(save).toBeEnabled();
    await shoot(page.getByTestId("taskless-guarded-paths-panel"), "taskless-guarded-paths-draft.png");
    await save.click();
    await expect(editor.getByText("saved", { exact: true })).toBeVisible();
    await expect(save).toBeDisabled();
    expect(await storedGuard(loomDaemon.baseURL, project.id)).toEqual(["packages/daemon/src/git/**", "*.lock"]);

    await page.reload();
    await expect(input).toHaveValue("packages/daemon/src/git/**\n*.lock");
    await expect(editor.getByTestId("taskless-guarded-paths-count")).toHaveText("2 guarded paths");
    await shoot(page.getByTestId("taskless-guarded-paths-panel"), "taskless-guarded-paths-saved.png");

    // Clear: an empty list unsets the key (no guard).
    await input.fill("");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(editor.getByText("saved", { exact: true })).toBeVisible();
    expect(await storedGuard(loomDaemon.baseURL, project.id)).toBeNull();
    await page.reload();
    await expect(input).toHaveValue("");
    await expect(editor.getByTestId("taskless-guarded-paths-count")).toHaveText("no guarded paths");
  });

  test("a daemon refusal is shown inline and stores nothing; a retry saves",async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("tgp-err"));
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);
    const editor = page.getByTestId("taskless-guarded-paths-editor");
    const input = editor.getByTestId("taskless-guarded-paths-input");

    // The daemon refusal path: intercept ONLY this editor's PATCH and make the daemon see a value it refuses (a
    // bare string), so the error text on screen is the daemon's own, not the editor's.
    await page.route(`**/api/projects/${project.id}/config`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await route.continue({ postData: JSON.stringify({ config: { orchestration: { tasklessGuardedPaths: "docs/**" } } }) });
    }, { times: 1 });
    await input.fill("docs/**");
    await editor.getByTestId("taskless-guarded-paths-save").click();
    const err = editor.getByTestId("taskless-guarded-paths-save-error");
    await expect(err).toContainText("tasklessGuardedPaths must be an array of glob strings");
    expect(await storedGuard(loomDaemon.baseURL, project.id)).toBeNull();
    await shoot(page.getByTestId("taskless-guarded-paths-panel"), "taskless-guarded-paths-daemon-error.png");

    // Retrying (no interception now) clears the error and stores the list.
    await editor.getByTestId("taskless-guarded-paths-save").click();
    await expect(editor.getByText("saved", { exact: true })).toBeVisible();
    await expect(err).toHaveCount(0);
    expect(await storedGuard(loomDaemon.baseURL, project.id)).toEqual(["docs/**"]);
  });
});
