// Header project-picker e2e (card dbc78201) — the owner's ask: in the header's project dropdown, sort
// projects that currently have ≥1 live session to the TOP and MARK them (a restrained live dot + count);
// the idle rest below. The picker is a custom dropdown (App.tsx › ActiveProjectControl), not a native
// <select>, precisely so it can render the design-system live Dot next to an active project.
//
// Seeding (the no-real-claude invariant): the ACTIVE project gets a `processState:"live"` session row via
// seedLiveSession (POST /internal/test/seed → insertSession, never startSession → no `[pty] spawn`); the
// IDLE project is a bare createProject with no sessions. The auto fixture archives the seeded session after
// the test, so a sibling spec never inherits a stray live row. All menu assertions are scoped to the
// role="listbox" popover so the trigger button's own copy of the active project's name can't be mistaken
// for a menu option.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

test.describe("header project picker — active-session sort + marker (card dbc78201)", () => {
  test("a project with a live session sorts above an idle one and shows the live marker", async ({ page, loomDaemon }) => {
    // One live manager session → its project is "active"; a second, session-less project is "idle".
    const activeName = `picker-active-${Date.now()}`;
    const idleName = `picker-idle-${Date.now()}`;
    const live = await loomDaemon.seedLiveSession({ project: await loomDaemon.createProject(activeName), role: "manager", agentName: "PickMgr" });
    const idle = await loomDaemon.createProject(idleName);

    // Pin the active project so the trigger shows a known name, then open the dropdown.
    await pinActiveProject(page, live.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);

    // The trigger's accessible name is the active project's name (it renders that name as its label).
    const trigger = page.getByRole("button", { name: new RegExp(activeName) });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();

    const activeOption = menu.getByRole("option", { name: new RegExp(activeName) });
    const idleOption = menu.getByRole("option", { name: new RegExp(idleName) });
    await expect(activeOption).toBeVisible();
    await expect(idleOption).toBeVisible();

    // MARKER: the active project's option carries the live-session count marker; the idle one does not.
    await expect(activeOption.getByTitle(/1 live session/)).toBeVisible();
    await expect(idleOption.getByTitle(/live session/)).toHaveCount(0);

    // SORT: the active (marked) project renders ABOVE the idle one (lower y = higher on screen). The idle
    // project sits below the entire live group regardless of how many other projects exist on the shared
    // daemon, so this holds without pinning the full list order.
    const yActive = (await activeOption.boundingBox())!.y;
    const yIdle = (await idleOption.boundingBox())!.y;
    expect(yActive).toBeLessThan(yIdle);

    // Selecting the idle project still works (the custom dropdown drives setProjectId) and closes the menu.
    await idleOption.click();
    await expect(menu).toHaveCount(0);
    // The trigger now reflects the newly-selected idle project (and shows no live marker for it).
    await expect(page.getByRole("button", { name: new RegExp(idle.name) })).toBeVisible();
  });
});
