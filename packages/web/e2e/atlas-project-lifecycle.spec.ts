// Atlas — project lifecycle controls on the project node's Settings tab (card c9b78d80, epic 9fe8cd4e).
// Decisions: docs/decisions/c9b78d80-atlas-project-lifecycle-on-settings.md.
//
// Card 5afd71bd retires /projects as an Atlas destination, and Atlas card 11's investigation found that
// five surfaces existed ONLY there. This spec is the witness that each of the five now WORKS from the
// project node's Settings tab, and that the classic page still has them with the switch off.
//
// Each ON leg exercises its control and asserts an observable BEFORE/AFTER on both sides — never just
// "the panel rendered". Where a write could plausibly land on the wrong project, a DECOY project is
// seeded and asserted untouched: "a project was renamed" passes against a surface scoped to whatever it
// happened to find.
//
// ⚠️ Locator discipline (project-memory `atlas-nav-labels-collide-with-exact-text-locators`): every
// Atlas nav label is a live page-wide exact-text match in BOTH shells, so PRESENCE is scoped to the
// `settings-section-project-lifecycle` wrapper (or to the tree, for a tree claim) and nothing here
// reaches for `.first()`. A seeded project NAME is not a nav label, but it IS drawn by both the tree and
// the page, so a name claim names which of the two it is about.
//
// ⚠️ The node tab row folds into a "More ⋯" menu at this viewport (card d4350286), so the Settings tab
// is reached through helpers/nodeTabs.ts — `getByTestId("atlas-tab-settings")` alone is not a complete
// way to reach a node tab and fails with a timeout that reads like a missing feature.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "./fixtures/daemon";
import { openNodeTab } from "./helpers/nodeTabs";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only, so a spec cannot pull `src/` in.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

/** The project tier's Settings node — the address this card's section lives at. */
const PROJECT_NODE = "/settings";

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test.
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Guarded, not unconditional: an unconditional setItem RE-PINS on every reload, which would make the
// archive/delete legs below measure the helper rather than the app (the project they archived would
// keep being re-pinned as active after it stopped existing).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const section = (page: Page) => page.getByTestId("settings-section-project-lifecycle");
/** The un-collapsed control body — the SAME component the classic page renders inside its disclosure. */
const fields = (page: Page) => section(page).getByTestId("project-manage-fields");
const nameField = (page: Page) => fields(page).getByPlaceholder("name", { exact: true });
const vaultField = (page: Page) => fields(page).getByPlaceholder(/^vault path/);

/** The tree's own label for a project row — the rename leg's first observable. */
const treeRow = (page: Page, name: string) =>
  page.getByTestId("atlas-tree").getByText(name, { exact: true });

type RestProject = { id: string; name: string; vaultPath: string; repoPath: string; referenceRepos?: string[]; repos?: { key: string; path: string }[] };

async function restProjects(baseURL: string): Promise<RestProject[]> {
  const res = await fetch(`${baseURL}/api/projects`);
  return (await res.json()) as RestProject[];
}
async function restProject(baseURL: string, id: string): Promise<RestProject | undefined> {
  return (await restProjects(baseURL)).find((p) => p.id === id);
}
async function restArchivedIds(baseURL: string): Promise<string[]> {
  const res = await fetch(`${baseURL}/api/projects/archived`);
  return ((await res.json()) as RestProject[]).map((p) => p.id);
}

/** Land on the project node's Settings tab by CLICKING the tab, not by navigating to its address. */
async function openSettingsTab(page: Page, baseURL: string) {
  await page.goto(baseURL + "/project");
  await openNodeTab(page, "settings");
  await expect(page, "the Settings tab is not the project Settings node's own address")
    .toHaveURL(new RegExp(`${PROJECT_NODE}$`));
  await expect(section(page), "the project node's Settings tab has no Project Lifecycle section")
    .toHaveCount(1);
}

test.describe("Atlas project lifecycle on the Settings tab (card c9b78d80)", () => {
  test("rename: the tree row and the page head both follow, and a decoy project does not", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`lifecycle-rename-${Date.now()}`);
    const decoy = await loomDaemon.createProject(`lifecycle-rename-decoy-${Date.now()}`);
    await pinProject(page, project.id);
    await seedAtlasOn(page);

    // Reached by the TAB, so the affordance is exercised rather than the address merely rendering.
    await openSettingsTab(page, loomDaemon.baseURL);

    // BEFORE — both of the card's named observables carry the OLD name.
    await expect(treeRow(page, project.name), "the tree has no row for the pinned project").toHaveCount(1);
    await expect(page.getByTestId("atlas-breadcrumb"), "the page head does not name the pinned project")
      .toContainText(project.name);
    await expect(nameField(page)).toHaveValue(project.name);

    const renamed = `${project.name}-renamed`;
    const save = fields(page).getByRole("button", { name: "Save changes" });
    await expect(save, "Save changes is enabled before anything was edited").toBeDisabled();
    await nameField(page).fill(renamed);
    await expect(save, "editing the name did not make Save changes dirty").toBeEnabled();
    await save.click();

    // AFTER — the tree row label and the page head both move, with no reload.
    await expect(treeRow(page, renamed), "the tree row label did not follow the rename").toHaveCount(1);
    await expect(treeRow(page, project.name), "the tree still carries the OLD project name").toHaveCount(0);
    await expect(page.getByTestId("atlas-breadcrumb"), "the page head did not follow the rename")
      .toContainText(renamed);
    // And the store agrees, for THIS project only — the decoy is what makes the line above mean "the
    // active project" rather than "a project".
    await expect.poll(async () => (await restProject(loomDaemon.baseURL, project.id))?.name,
      { message: "the rename never persisted" }).toBe(renamed);
    expect((await restProject(loomDaemon.baseURL, decoy.id))?.name,
      "the rename reached the decoy project too").toBe(decoy.name);
  });

  test("vaultPath: the saved value round-trips, and the stale-startup-prompt lint still rides the save", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`lifecycle-vault-${Date.now()}`);
    const oldVault = (await restProject(loomDaemon.baseURL, project.id))?.vaultPath;
    expect(oldVault, "the seeded project has no vaultPath to move").toBeTruthy();

    // An agent whose startupPrompt quotes the OLD vault path — the exact state the lint exists for
    // (card 0597e092). Without it the warning can never fire and "the lint still shows" is vacuous.
    const agentName = "Vault Citing Agent";
    const res = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: agentName, startupPrompt: `Read the notes under ${oldVault} before you start.` }),
    });
    expect(res.ok, `seeding the vault-citing agent failed: ${res.status}`).toBe(true);

    // A real directory OUTSIDE the project's repo — the daemon's containment check compares the whole
    // {repoPath, vaultPath, repos} triple, so a vault nested in the repo would be refused.
    const scratch = mkdtempSync(path.join(process.env.LOOM_SCRATCH_DIR ?? tmpdir(), "loom-lifecycle-vault-"));
    const newVault = path.join(scratch, "vault");
    // A plain directory, deliberately NOT a git repo: the daemon's containment check realpaths the path
    // (so it has to exist) and refuses a vault nested in a code repo.
    mkdirSync(newVault, { recursive: true });
    try {
      await pinProject(page, project.id);
      await seedAtlasOn(page);
      await page.goto(loomDaemon.baseURL + PROJECT_NODE);
      await expect(section(page)).toHaveCount(1);

      await expect(vaultField(page)).toHaveValue(oldVault!);
      await vaultField(page).fill(newVault);
      await fields(page).getByRole("button", { name: "Save changes" }).click();

      // The lint is WARN-only and renders only when an agent actually still cites the old value — so
      // this assertion is simultaneously "the warning shows where it did" and "it names the agent".
      const warning = fields(page).getByText(/these agent startup prompts still reference the OLD value/);
      await expect(warning, "the stale-startup-prompt lint did not ride the vaultPath save").toBeVisible();
      await expect(fields(page).getByText(agentName, { exact: false }),
        "the lint fired but does not name the agent whose prompt is stale").toBeVisible();

      // ROUND-TRIP: through the store, and through a fresh load of the page.
      await expect.poll(async () => (await restProject(loomDaemon.baseURL, project.id))?.vaultPath,
        { message: "the new vaultPath never persisted" }).toBe(newVault);
      await page.goto(loomDaemon.baseURL + PROJECT_NODE);
      await expect(vaultField(page), "the saved vaultPath did not round-trip into a fresh load")
        .toHaveValue(newVault);
      // A fresh load is a fresh mutation state, so the WARN-only lint is correctly gone again.
      await expect(fields(page).getByText(/these agent startup prompts still reference the OLD value/),
        "the stale-prompt warning survived a reload, so it is not scoped to the save that produced it")
        .toHaveCount(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("reference repos: a mirror is added and removed, both read back off the store", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`lifecycle-refrepo-${Date.now()}`);
    // The project's own repoPath is a real git repo on the daemon host — a valid reference target, and
    // all the validator asks for (absolute + isGitRepo).
    const validPath = (await restProject(loomDaemon.baseURL, project.id))?.repoPath;
    expect(validPath, "the seeded project has no repoPath to use as a reference repo").toBeTruthy();
    await pinProject(page, project.id);
    await seedAtlasOn(page);
    await page.goto(loomDaemon.baseURL + PROJECT_NODE);
    await expect(section(page)).toHaveCount(1);

    // BEFORE: the quiet empty line, never a phantom blank row.
    await expect(fields(page).getByText("No reference repos.")).toBeVisible();
    expect((await restProject(loomDaemon.baseURL, project.id))?.referenceRepos ?? [],
      "the seeded project already carries reference repos").toEqual([]);

    await fields(page).getByRole("button", { name: /Add repo/ }).click();
    const row1 = fields(page).getByRole("textbox", { name: /Reference repo 1/ });
    await expect(row1).toBeVisible();
    await row1.fill(validPath!);
    const saveRefs = fields(page).getByRole("button", { name: /Save reference repos/ });
    await saveRefs.click();
    // Observable on both sides: the editor settles clean (local rows resynced from the server), and the
    // store carries the row.
    await expect(saveRefs, "the reference-repos editor never settled after a successful save").toBeDisabled();
    await expect.poll(async () => (await restProject(loomDaemon.baseURL, project.id))?.referenceRepos ?? [],
      { message: "the reference repo never persisted" }).toEqual([validPath]);

    // REMOVE — the other half of the loop, so this leg is not an add-only claim.
    await fields(page).getByRole("button", { name: /Remove reference repo 1/ }).click();
    await expect(fields(page).getByRole("textbox", { name: /Reference repo 1/ })).toHaveCount(0);
    await fields(page).getByRole("button", { name: /Save reference repos/ }).click();
    await expect.poll(async () => (await restProject(loomDaemon.baseURL, project.id))?.referenceRepos ?? [],
      { message: "removing the reference repo never persisted" }).toEqual([]);
    await expect(fields(page).getByText("No reference repos.")).toBeVisible();
  });

  test("repo registry: an entry is registered and removed, both read back off the store", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`lifecycle-registry-${Date.now()}`);
    await pinProject(page, project.id);
    await seedAtlasOn(page);
    await page.goto(loomDaemon.baseURL + PROJECT_NODE);
    await expect(section(page)).toHaveCount(1);

    // A SECOND real git repo — the validator refuses an entry that aliases this project's own primary
    // repoPath, so the reference-repos leg's trick of reusing it does not transfer here.
    const scratch = mkdtempSync(path.join(process.env.LOOM_SCRATCH_DIR ?? tmpdir(), "loom-lifecycle-registry-"));
    const sideRepo = path.join(scratch, "side-repo");
    execFileSync("git", ["init", "-q", sideRepo]);
    try {
      await expect(fields(page).getByText("No registered repos.")).toBeVisible();
      expect((await restProject(loomDaemon.baseURL, project.id))?.repos ?? [],
        "the seeded project already carries a repo registry").toEqual([]);

      await fields(page).getByRole("button", { name: /Register repo/ }).click();
      await fields(page).getByRole("textbox", { name: /Repo 1 key/ }).fill("side");
      await fields(page).getByRole("textbox", { name: /Repo 1 path/ }).fill(sideRepo);
      const saveRegistry = fields(page).getByRole("button", { name: /Save registered repos/ });
      await saveRegistry.click();
      await expect(saveRegistry, "the registry editor never settled after a successful save").toBeDisabled();
      // The server stores the CANONICALIZED path, so the key is what this asserts on; the path is only
      // required to be non-empty, since a realpath'd value legitimately differs from what was typed.
      await expect.poll(async () => ((await restProject(loomDaemon.baseURL, project.id))?.repos ?? []).map((r) => r.key),
        { message: "the registry entry never persisted" }).toEqual(["side"]);
      expect(((await restProject(loomDaemon.baseURL, project.id))?.repos ?? [])[0]?.path,
        "the registry entry persisted with no path").toBeTruthy();

      await fields(page).getByRole("button", { name: /Remove repo 1/ }).click();
      await expect(fields(page).getByRole("textbox", { name: /Repo 1 key/ })).toHaveCount(0);
      await fields(page).getByRole("button", { name: /Save registered repos/ }).click();
      await expect.poll(async () => (await restProject(loomDaemon.baseURL, project.id))?.repos ?? [],
        { message: "removing the registry entry never persisted" }).toEqual([]);
      await expect(fields(page).getByText("No registered repos.")).toBeVisible();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("archive: the confirm is asked, and the project leaves the tree", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`lifecycle-archive-${Date.now()}`);
    // A second project, so the tree is non-empty afterwards — a tree that rendered NO project rows would
    // satisfy the absence below for the wrong reason.
    const keep = await loomDaemon.createProject(`lifecycle-archive-keep-${Date.now()}`);
    await pinProject(page, project.id);
    await seedAtlasOn(page);

    const prompts: string[] = [];
    page.on("dialog", (d) => { prompts.push(d.message()); void d.accept(); });

    await page.goto(loomDaemon.baseURL + PROJECT_NODE);
    await expect(section(page)).toHaveCount(1);
    await expect(treeRow(page, project.name), "the tree has no row for the project about to be archived")
      .toHaveCount(1);

    await fields(page).getByRole("button", { name: /Archive \(reversible\)/ }).click();

    // The archive confirm is a native confirm, and it still names the project and says it is reversible.
    await expect.poll(() => prompts.length, { message: "archiving asked for no confirmation at all" })
      .toBeGreaterThan(0);
    expect(prompts.join("\n"), "the archive confirm no longer names the project").toContain(project.name);
    expect(prompts.join("\n"), "the archive confirm no longer says it is reversible").toMatch(/restored later/);

    // AFTER: the row is gone from the tree, the project is in the archived list, and the tree still
    // draws the project that was kept.
    await expect(treeRow(page, project.name), "the archived project is still a row in the tree")
      .toHaveCount(0);
    await expect(treeRow(page, keep.name), "the tree rendered no project rows, so the absence above proves nothing")
      .toHaveCount(1);
    await expect.poll(() => restArchivedIds(loomDaemon.baseURL),
      { message: "the project never reached the archived list" }).toContain(project.id);
    expect((await restProjects(loomDaemon.baseURL)).map((p) => p.id),
      "the archived project is still in the live project list").not.toContain(project.id);
  });

  test("permanent delete: the typed-name confirm must be passed, and then the project is gone", async ({ page, loomDaemon }) => {
    // A throwaway project — this leg destroys it, cascade and all.
    const doomed = await loomDaemon.createProject(`lifecycle-doomed-${Date.now()}`);
    const keep = await loomDaemon.createProject(`lifecycle-doomed-keep-${Date.now()}`);
    await pinProject(page, doomed.id);
    await seedAtlasOn(page);
    await page.goto(loomDaemon.baseURL + PROJECT_NODE);
    await expect(section(page)).toHaveCount(1);

    // The confirm STEP: the destructive button is a reveal, not the action.
    const reveal = fields(page).getByRole("button", { name: /Delete permanently/ });
    await expect(reveal).toBeVisible();
    await expect(fields(page).getByRole("button", { name: "Delete forever" }),
      "the irreversible action is reachable without passing a confirm step").toHaveCount(0);
    await reveal.click();

    // The confirm names the cascade and the project, and asks for the name back.
    const confirmCopy = fields(page).getByText(/Permanently delete this project and ALL of it/);
    await expect(confirmCopy, "the delete confirm no longer states the cascade").toBeVisible();
    await expect(confirmCopy, "the delete confirm no longer says it cannot be undone")
      .toContainText(/Cannot be undone/);

    const confirmBox = fields(page).getByPlaceholder(doomed.name);
    const forever = fields(page).getByRole("button", { name: "Delete forever" });
    // ⭐ The gate is what makes this a confirm rather than a second click: empty is refused, and so is a
    // WRONG name. Without the wrong-name leg, "the confirm exists" holds for any box at all.
    await expect(forever, "Delete forever is live before the name was typed").toBeDisabled();
    await confirmBox.fill(`${doomed.name}-not-quite`);
    await expect(forever, "Delete forever accepted a name that does not match").toBeDisabled();
    await confirmBox.fill(doomed.name);
    await expect(forever, "the exact project name did not arm Delete forever").toBeEnabled();
    await forever.click();

    // GONE — from the live list, from the archived list (this is not an archive), and from the tree.
    await expect.poll(async () => (await restProjects(loomDaemon.baseURL)).map((p) => p.id),
      { message: "the permanently deleted project is still in the project list" }).not.toContain(doomed.id);
    expect(await restArchivedIds(loomDaemon.baseURL),
      "a permanent delete left the project in the ARCHIVED list, which would make it recoverable")
      .not.toContain(doomed.id);
    await expect(treeRow(page, doomed.name), "the deleted project is still a row in the tree").toHaveCount(0);
    await expect(treeRow(page, keep.name), "the tree rendered no project rows, so the absence above proves nothing")
      .toHaveCount(1);
  });

  test("with the switch OFF the classic page keeps all five, and classic Settings does not grow them", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`lifecycle-off-${Date.now()}`);
    await pinProject(page, project.id);
    // No seedAtlasOn: OFF is the default.

    // The classic Projects page still owns these controls, behind its own "Manage project" disclosure.
    await page.goto(loomDaemon.baseURL + "/projects");
    await expect(page.locator(".loom-rail"), "the classic shell did not render").toBeVisible();
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);
    // Collapsed by default, as it always was — the body is absent until the disclosure is opened.
    await expect(page.getByTestId("project-manage-fields"),
      "the classic Manage project disclosure is no longer collapsed on mount").toHaveCount(0);
    const manage = page.getByRole("button", { name: /Manage project/ });
    await expect(manage).toBeVisible();
    await manage.click();
    const body = page.getByTestId("project-manage-fields");
    await expect(body, "the classic Manage project disclosure rendered no control body").toHaveCount(1);
    // All five surfaces, in the frame they have always had.
    await expect(body.getByPlaceholder("name", { exact: true })).toBeVisible();
    await expect(body.getByPlaceholder(/^vault path/)).toBeVisible();
    await expect(body.getByText("No reference repos.")).toBeVisible();
    await expect(body.getByText("No registered repos.")).toBeVisible();
    await expect(body.getByRole("button", { name: /Archive \(reversible\)/ })).toBeVisible();
    await expect(body.getByRole("button", { name: /Delete permanently/ })).toBeVisible();
    // The draft survives a collapse — the state lives above the disclosure, as it did before this card
    // split the frame off the body.
    await body.getByPlaceholder("name", { exact: true }).fill(`${project.name}-draft`);
    await manage.click();
    await expect(page.getByTestId("project-manage-fields")).toHaveCount(0);
    await manage.click();
    await expect(page.getByTestId("project-manage-fields").getByPlaceholder("name", { exact: true }),
      "collapsing the classic disclosure discarded a half-typed rename").toHaveValue(`${project.name}-draft`);

    // And the classic Settings page did NOT grow a second copy of them: the section is atlasOnly.
    await page.goto(loomDaemon.baseURL + PROJECT_NODE);
    await expect(page.locator("main [data-testid^='settings-section-']").first(),
      "the classic Settings page rendered no sections, so the absence below proves nothing").toBeVisible();
    await expect(section(page),
      "the classic Settings page grew the Atlas-only Project Lifecycle section").toHaveCount(0);
    await expect(page.locator("main").getByText("Project Lifecycle", { exact: true }),
      "the classic Settings page still shows the Project Lifecycle label").toHaveCount(0);
    await expect(page.locator("main").getByTestId("project-manage-fields"),
      "the classic Settings page grew a second project-lifecycle control body").toHaveCount(0);
  });
});
