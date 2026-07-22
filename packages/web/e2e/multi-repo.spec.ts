// Multi-repo epic 49136451, PHASE 3 e2e — the human half of multi-repo, driven end-to-end on the real
// isolated daemon: register a second writable repo through the UI (until this phase it was REST-only, so
// registering a repo meant hand-rolling a curl), then route a card at it and see the board say so.
//
// Two halves, and the SECOND is the one that protects everyone else:
//   1. A project WITH a registry: register a repo → it persists → a bad entry surfaces the server's
//      first-offender validation error INLINE → create a card targeting the repo → the board card shows
//      the repo badge → retarget the card back to primary in the drawer and the badge disappears.
//   2. A project with NO registry: NO picker anywhere, NO badge. This is the zero-UI-tax requirement —
//      the overwhelmingly common single-repo project must not pay a single pixel for a feature it
//      doesn't use.
//
// The VALID repo path is the seeded project's OWN repoPath (a real `git init` dir the fixture made), read
// back off GET /api/projects — the validator requires absolute + an existing git repo, and it rejects a
// path that ALIASES the project's own repoPath, so this spec creates a SECOND project purely to borrow
// its repo dir as a distinct, real git repo to register. No real claude ever spawns (pure REST + UI).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// Open the selected project's "Manage project" collapsible (where the registry editor lives, directly
// below the reference-repos editor).
async function openManage(page: Page) {
  const toggle = page.getByRole("button", { name: /Manage project/ });
  await expect(toggle).toBeVisible();
  await toggle.click();
}

async function repoPathOf(baseURL: string, projectId: string): Promise<string> {
  const list = await (await fetch(`${baseURL}/api/projects`)).json() as { id: string; repoPath: string }[];
  const p = list.find((x) => x.id === projectId);
  expect(p?.repoPath).toBeTruthy();
  return p!.repoPath;
}

test.describe("multi-repo registry + card routing (card ebb50819)", () => {
  test("register a repo via the UI → bad entry errors inline → route a card at it → board shows the badge", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`multirepo-${Date.now()}`);
    // A second project only so we can borrow its repo dir: a real git repo that is NOT this project's
    // own repoPath (which the validator rejects as an alias of primary).
    const donor = await loomDaemon.createProject(`multirepo-donor-${Date.now()}`);
    const secondRepoPath = await repoPathOf(loomDaemon.baseURL, donor.id);

    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/projects`);
    await openManage(page);

    // Empty state: a quiet "none" line, NOT a phantom blank row.
    await expect(page.getByText("No registered repos.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: /Repo 1 key/ })).toHaveCount(0);

    // ── BAD ENTRY FIRST: the reserved "primary" key. Proves the server's FIRST-OFFENDER message reaches
    // the user verbatim rather than being collapsed into a generic "invalid repos".
    await page.getByRole("button", { name: /Register repo/ }).click();
    await page.getByRole("textbox", { name: /Repo 1 key/ }).fill("primary");
    await page.getByRole("textbox", { name: /Repo 1 path/ }).fill(secondRepoPath);
    await page.getByRole("button", { name: /Save registered repos/ }).click();
    const err = page.getByRole("alert");
    await expect(err).toBeVisible();
    await expect(err).toContainText(/reserved/);
    await expect(err).toContainText(/primary/);

    // ── VALID ENTRY: correcting the key clears the stale error, and Save persists.
    await page.getByRole("textbox", { name: /Repo 1 key/ }).fill("api");
    await expect(page.getByRole("alert")).toHaveCount(0); // an edit clears the error it referred to
    const saveBtn = page.getByRole("button", { name: /Save registered repos/ });
    await saveBtn.click();
    // Observable success: the server accepted it and local state resynced to what was STORED, so Save
    // goes disabled (not dirty). This also proves the canonicalized-path resync — the server stores a
    // realpath'd form, so without the resync `dirty` would never settle and Save would stay enabled.
    await expect(saveBtn).toBeDisabled();

    // PERSISTENCE: reload fresh and confirm the row round-tripped through the server.
    await page.goto(`${loomDaemon.baseURL}/projects`);
    await openManage(page);
    await expect(page.getByRole("textbox", { name: /Repo 1 key/ })).toHaveValue("api");
    await expect(page.getByRole("alert")).toHaveCount(0);

    // ── ROUTE A CARD AT THE NEW REPO. The picker exists only because this project now has a registry.
    await page.goto(`${loomDaemon.baseURL}/board`);
    const picker = page.getByLabel("Target repo");
    await expect(picker).toBeVisible();
    await expect(picker).toHaveValue(""); // defaults to primary
    await picker.selectOption("api");
    const title = `routed to api ${Date.now()}`;
    await page.getByPlaceholder("new task title").fill(title);
    await page.getByRole("button", { name: /Add to Inbox/ }).click();

    // The board card carries the repo badge naming its non-primary target.
    const card = page.locator(".loom-board-card").filter({ hasText: title });
    await expect(card).toBeVisible();
    await expect(card.getByTitle(/Targets the "api" repo/)).toBeVisible();
    await expect(card).toContainText("api");

    // ── EXERCISE THE DRAWER PICKER: retarget the card back to primary and watch the badge disappear.
    // A render-only check wouldn't prove the control does anything; this is a real observable state
    // change, round-tripped through the server and back onto the board.
    await card.getByText(title).click();
    const drawerPicker = page.getByRole("dialog").getByLabel("Target repo");
    await expect(drawerPicker).toBeVisible();
    await expect(drawerPicker).toHaveValue("api");
    // The resolved absolute path of the selected repo is shown — the "which repo did this land on"
    // answer, without a per-card git scan.
    await expect(page.getByRole("dialog")).toContainText(secondRepoPath);
    await drawerPicker.selectOption("");
    await page.getByRole("dialog").getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByRole("dialog").getByText("saved")).toBeVisible();
    await page.keyboard.press("Escape");

    // Badge gone: the card now targets primary.
    await expect(card.getByTitle(/Targets the "api" repo/)).toHaveCount(0);

    // ── GIT PAGE: the registered repo appears with its key, and expanding it lazily loads a real log
    // through the index-by-construction route (the client never sends a host path).
    //
    // The fixture creates each project's repo with a bare `git init` and NO commits, and `git log` on a
    // commitless repo errors — so give this one a real commit first, or the assertion below would be
    // testing an empty-repo edge case rather than the route. The identity is passed per-invocation
    // instead of relying on the host's global git config: a test that leans on ambient identity passes on
    // a configured dev box and fails on a clean CI runner.
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", secondRepoPath, "-c", "user.email=e2e@loom.test", "-c", "user.name=Loom E2E", ...args]);
    writeFileSync(path.join(secondRepoPath, "README.md"), "registered repo\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "chore: seed the registered repo");

    await page.goto(`${loomDaemon.baseURL}/git`);
    const repoToggle = page.getByRole("button").filter({ hasText: secondRepoPath });
    await expect(repoToggle).toBeVisible();
    await expect(repoToggle).toContainText("api");
    await expect(repoToggle).toContainText("no gate"); // registered without a gate command
    // Collapsed by default (enabled:open) — the log request fires only on expand.
    const logRequest = page.waitForResponse((r) => /\/git\/repos\/0\/log$/.test(r.url()));
    await repoToggle.click();
    expect((await logRequest).status()).toBe(200);
    await expect(page.getByText("chore: seed the registered repo")).toBeVisible();

    // SECURITY: the route resolves an INDEX into the project's own repos[] server-side — it never accepts
    // a host path. An out-of-range index is a clean 404, not a throw, and never reaches GitReader.
    const oob = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/git/repos/9/log`);
    expect(oob.status).toBe(404);
    const notAnIndex = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/git/repos/abc/log`);
    expect(notAnIndex.status).toBe(404);
  });

  // A card can outlive the registry entry it targets: removing an entry is refused only while a LIVE
  // worktree session holds the card, so a human can legitimately de-register a repo that finished cards
  // still point at. Two things must survive that, and neither did before the code review caught it:
  // an unrelated edit (title) must still save, and the picker must not claim the card targets `primary`.
  test("a card whose repo was de-registered stays editable, and the picker says so", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`stalerepo-${Date.now()}`);
    const donor = await loomDaemon.createProject(`stalerepo-donor-${Date.now()}`);
    const donorRepo = await repoPathOf(loomDaemon.baseURL, donor.id);

    // Register `legacy`, file a card against it, then de-register it — via REST, since this is about the
    // resulting STATE, not about re-driving the editor UI (covered above).
    const patch = async (repos: unknown[]) => {
      const r = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ repos }),
      });
      expect(r.ok).toBeTruthy();
    };
    await patch([{ key: "legacy", path: donorRepo }]);
    const task = await loomDaemon.createTask(project.id, { title: "card on a doomed repo", columnKey: "inbox" });
    const setKey = await fetch(`${loomDaemon.baseURL}/api/tasks/${task.id}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoKey: "legacy" }),
    });
    expect(setKey.ok).toBeTruthy();
    await patch([]); // de-register it out from under the card

    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/board`);
    const card = page.locator(".loom-board-card").filter({ hasText: "card on a doomed repo" });
    await expect(card).toBeVisible();
    await card.getByText("card on a doomed repo").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // With the registry now EMPTY the picker isn't rendered at all — but the card still carries the key,
    // so the real assertion here is that an unrelated edit still saves rather than 400ing on a repoKey
    // the client never meant to change.
    await dialog.getByRole("textbox").first().fill("card on a doomed repo (renamed)");
    await dialog.getByRole("button", { name: /^Save$/ }).click();
    await expect(dialog.getByText("saved")).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveCount(0);

    // And the server kept the stale key rather than the save silently clearing it to primary.
    const after = await (await fetch(`${loomDaemon.baseURL}/api/tasks/${task.id}`)).json() as { title: string; repoKey: string | null };
    expect(after.title).toBe("card on a doomed repo (renamed)");
    expect(after.repoKey).toBe("legacy");

    // Now re-register a DIFFERENT repo so the picker renders again while the card's own key is orphaned:
    // it must offer the stale key as an explicit, labelled option instead of falling back to `primary`.
    await patch([{ key: "current", path: donorRepo }]);
    await page.goto(`${loomDaemon.baseURL}/board`);
    await page.locator(".loom-board-card").filter({ hasText: "doomed repo" }).getByText("doomed repo").click();
    const picker = page.getByRole("dialog").getByLabel("Target repo");
    await expect(picker).toBeVisible();
    await expect(picker).toHaveValue("legacy"); // NOT "" — the control must not claim `primary`
    await expect(page.getByRole("dialog")).toContainText("no longer registered");
  });

  test("a single-repo project renders NO repo picker and NO badge — zero UI tax", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`singlerepo-${Date.now()}`);
    await loomDaemon.createTask(project.id, { title: `ordinary card ${Date.now()}`, columnKey: "inbox" });

    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/board`);

    // The board loaded (the card is there) — so the absence below is a real absence, not an unloaded page.
    const card = page.locator(".loom-board-card").first();
    await expect(card).toBeVisible();

    // No picker on the new-task row.
    await expect(page.getByLabel("Target repo")).toHaveCount(0);
    // No badge on any card.
    await expect(page.getByTitle(/Targets the/)).toHaveCount(0);

    // And none in the drawer either.
    await card.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByLabel("Target repo")).toHaveCount(0);
    await expect(page.getByRole("dialog").getByText("Repo", { exact: true })).toHaveCount(0);
  });
});
