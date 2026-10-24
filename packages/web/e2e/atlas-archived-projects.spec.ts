// Atlas — the archived-projects tier on the Workspace node's Settings tab (card baca1835, epic 9fe8cd4e).
// Decisions: docs/decisions/baca1835-atlas-archived-projects-workspace-home.md.
//
// Card 5afd71bd retires /projects as an Atlas destination. This tier — restore, and permanent delete —
// was the LAST of the six surfaces living only there (card c9b78d80 re-homed the other five), and the
// one whose loss would have been worst: a soft-archived project with no second home is invisible AND
// unrestorable, which silently turns a reversible archive into a permanent delete. This spec is the
// witness that it now works from the Workspace node, with the switch off changing nothing.
//
// Each ON leg asserts an observable on BOTH sides of the act, never just "the panel rendered". Every
// absence claim is paired with a POSITIVE control on the same surface — a project that stays in the
// tree, a row that stays in the list — because this daemon is SHARED across the specs in a worker: a
// bare "the row is gone" holds just as well against a tree that drew nothing and a list that was
// emptied by someone else.
//
// ⚠️ Scoping: the archived list is daemon-global, so a sibling spec's own archived project legitimately
// shows up in it. Every row locator here is keyed to THIS leg's project name (the Restore/Delete
// buttons carry a per-row aria-label for exactly that), and nothing asserts the list is empty.
//
// ⚠️ The Workspace node's tab row folds into a "More ⋯" menu at this viewport (card d4350286), so the
// Settings tab is reached through helpers/nodeTabs.ts — `getByTestId("atlas-tab-settings")` alone is
// not a complete way to reach a node tab and fails with a timeout that reads like a missing feature.
import { expect, test, type Page } from "./fixtures/daemon";
import { openNodeTab } from "./helpers/nodeTabs";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only, so a spec cannot pull `src/` in.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

/** The Workspace node's Settings tab — a `?tab=` on the node's own path (card 41eab0eb). */
const WORKSPACE_SETTINGS = "/home?tab=settings";

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test.
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Guarded, not unconditional: an unconditional setItem RE-PINS on every reload, which would make a
// "the row left the tree" leg measure the helper rather than the app.
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const section = (page: Page) => page.getByTestId("settings-section-archived-projects");
/** The un-collapsed list body — the SAME component the classic rail renders inside its disclosure. */
const list = (page: Page) => section(page).getByTestId("archived-projects-list");
const archivedRow = (page: Page, name: string) => list(page).getByText(name, { exact: true });
const restoreButton = (page: Page, name: string) => list(page).getByRole("button", { name: `Restore ${name}` });
const deleteButton = (page: Page, name: string) =>
  list(page).getByRole("button", { name: `Delete ${name} permanently` });

/** The tree's own label for a project row — the other half of every before/after below. */
const treeRow = (page: Page, name: string) =>
  page.getByTestId("atlas-tree").getByText(name, { exact: true });

type RestProject = { id: string; name: string };

async function restProjects(baseURL: string): Promise<RestProject[]> {
  const res = await fetch(`${baseURL}/api/projects`);
  return (await res.json()) as RestProject[];
}
async function restArchivedIds(baseURL: string): Promise<string[]> {
  const res = await fetch(`${baseURL}/api/projects/archived`);
  return ((await res.json()) as RestProject[]).map((p) => p.id);
}
/**
 * Soft-archive off the daemon's own route — the same write the project node's "Archive (reversible)"
 * button fires. Seeded rather than re-driven through that button on purpose: this spec is about where
 * the ARCHIVED tier lives, and card c9b78d80's own spec already owns the button.
 */
async function archiveViaRest(baseURL: string, id: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/projects/${id}`, { method: "DELETE" });
  expect(res.ok, `seeding the archive of ${id} failed: ${res.status} ${await res.text()}`).toBe(true);
}

/**
 * A queued dialog responder. The permanent delete in this frame is a native `window.prompt` (the row
 * has no panel to render an inline reveal in), so the confirm's whole behaviour is observable only
 * through the dialogs: `prompt` is answered with the next queued string, `alert` is dismissed, and
 * every message is recorded so the COPY can be asserted rather than assumed.
 */
function dialogs(page: Page) {
  const seen: { type: string; message: string }[] = [];
  const answers: string[] = [];
  page.on("dialog", (d) => {
    seen.push({ type: d.type(), message: d.message() });
    if (d.type() === "prompt") void d.accept(answers.shift() ?? "");
    else void d.accept();
  });
  const only = (type: string) => seen.filter((s) => s.type === type);
  return { seen, answer: (v: string) => answers.push(v), only };
}

/** Land on the Workspace node's Settings tab by CLICKING the tab, not by navigating to its address. */
async function openWorkspaceSettingsTab(page: Page, baseURL: string) {
  await page.goto(baseURL + "/home");
  await openNodeTab(page, "settings");
  await expect(page, "the Settings tab is not an address on the Workspace node")
    .toHaveURL(/\/home\?tab=settings$/);
  await expect(section(page), "the Workspace node's Settings tab has no Archived projects section")
    .toHaveCount(1);
}

test.describe("Atlas archived projects on the Workspace node (card baca1835)", () => {
  test("an archived project is listed here, and Restore puts it back into the tree", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`archived-restore-${Date.now()}`);
    // Never archived, so "the archived project left the tree" cannot be satisfied by a tree that drew
    // no project rows at all.
    const keep = await loomDaemon.createProject(`archived-restore-keep-${Date.now()}`);
    // `keep` is the ACTIVE project, so archiving `project` is not also a selection change — this leg
    // is about the list and the tree, not about where the active scope goes.
    await pinProject(page, keep.id);
    await seedAtlasOn(page);

    // BEFORE — reached by the TAB, so the affordance that gets a reader here is exercised rather than
    // the address merely rendering. The project is a live tree row and is NOT in the archived list.
    await openWorkspaceSettingsTab(page, loomDaemon.baseURL);
    await expect(treeRow(page, project.name), "the tree has no row for the project about to be archived")
      .toHaveCount(1);
    await expect(archivedRow(page, project.name),
      "the project is already in the archived list, before anything archived it").toHaveCount(0);

    await archiveViaRest(loomDaemon.baseURL, project.id);
    expect(await restArchivedIds(loomDaemon.baseURL), "the seeded archive never took").toContain(project.id);

    // AFTER the archive — a reload is what republishes both lists (neither query polls), and then the
    // row is in the panel and gone from the tree.
    await page.goto(loomDaemon.baseURL + WORKSPACE_SETTINGS);
    await expect(section(page), "the Workspace node's Settings tab has no Archived projects section")
      .toHaveCount(1);
    await expect(archivedRow(page, project.name),
      "the archived project is not listed on the Workspace node — it is now unreachable").toHaveCount(1);
    await expect(treeRow(page, project.name), "the archived project is still a row in the tree").toHaveCount(0);
    await expect(treeRow(page, keep.name),
      "the tree drew no project rows, so the absence above proves nothing").toHaveCount(1);

    // RESTORE — live, with no reload: the mutation invalidates both lists, so the row leaves the panel
    // and the project reappears in the tree on the very same page. ⭐ This is the capability the card
    // exists for; without it an archive under Atlas is a one-way door.
    await restoreButton(page, project.name).click();
    await expect(archivedRow(page, project.name),
      "the restored project is still listed as archived").toHaveCount(0);
    await expect(treeRow(page, project.name),
      "Restore did not bring the project back into the tree").toHaveCount(1);
    // And the store agrees, on both sides of the move.
    await expect.poll(() => restArchivedIds(loomDaemon.baseURL),
      { message: "the restore never left the archived list" }).not.toContain(project.id);
    expect((await restProjects(loomDaemon.baseURL)).map((p) => p.id),
      "the restored project is not back in the live project list").toContain(project.id);
  });

  test("permanent delete keeps its typed-name confirm, and then the project is gone", async ({ page, loomDaemon }) => {
    // A throwaway project — this leg destroys it, cascade and all.
    const doomed = await loomDaemon.createProject(`archived-doomed-${Date.now()}`);
    // Archived too, and never deleted: it keeps the list non-empty, so the final absence is not
    // satisfied by a panel that stopped rendering rows.
    const keep = await loomDaemon.createProject(`archived-doomed-keep-${Date.now()}`);
    await pinProject(page, (await loomDaemon.createProject(`archived-doomed-active-${Date.now()}`)).id);
    await seedAtlasOn(page);
    await archiveViaRest(loomDaemon.baseURL, doomed.id);
    await archiveViaRest(loomDaemon.baseURL, keep.id);

    const d = dialogs(page);
    await page.goto(loomDaemon.baseURL + WORKSPACE_SETTINGS);
    await expect(archivedRow(page, doomed.name), "the project to delete is not in the archived list")
      .toHaveCount(1);

    // ⭐ WRONG NAME — this is the leg that makes it a confirm rather than a second click. Without it,
    // "a prompt appeared" holds for a prompt that accepts anything at all.
    d.answer(`${doomed.name}-not-quite`);
    await deleteButton(page, doomed.name).click();
    await expect.poll(() => d.only("prompt").length,
      { message: "the delete asked for no confirmation at all" }).toBe(1);
    const asked = d.only("prompt")[0]!.message;
    expect(asked, "the delete confirm no longer names the project").toContain(doomed.name);
    expect(asked, "the delete confirm no longer states the cascade").toMatch(/PERMANENTLY delete/);
    expect(asked, "the delete confirm no longer lists what goes with it").toMatch(/agents, sessions, tasks/);
    expect(asked, "the delete confirm no longer says it cannot be undone").toMatch(/CANNOT be undone/);
    // ⭐ THE WITNESS, and it must come before the two absence claims below. The mismatch notice is the
    // one observable that fires on the REFUSAL branch and only on it, so polling for it is what makes
    // "nothing was destroyed" falsifiable — a build that drops the name comparison never reaches this
    // line, instead of racing a bare read of a store a delete is already on its way to. (A fixed wait
    // in its place would pass for the wrong reason every run: CLAUDE.md's unfalsifiable-negative shape.)
    await expect.poll(() => d.only("alert").length,
      { message: "a name that did not match was silently ACCEPTED — the refusal branch never ran, so nothing held the delete back" })
      .toBe(1);
    expect(d.only("alert")[0]!.message, "the mismatch notice no longer says what went wrong")
      .toMatch(/did not match/);
    // And nothing was destroyed.
    expect(await restArchivedIds(loomDaemon.baseURL),
      "a WRONG name deleted the project anyway").toContain(doomed.id);
    await expect(archivedRow(page, doomed.name),
      "a WRONG name removed the row from the list").toHaveCount(1);

    // EXACT NAME — armed, and the cascade runs.
    d.answer(doomed.name);
    await deleteButton(page, doomed.name).click();
    await expect(archivedRow(page, doomed.name),
      "the permanently deleted project is still in the archived list").toHaveCount(0);
    await expect(archivedRow(page, keep.name),
      "the panel rendered no rows at all, so the absence above proves nothing").toHaveCount(1);
    await expect.poll(() => restArchivedIds(loomDaemon.baseURL),
      { message: "the permanent delete never left the archived list" }).not.toContain(doomed.id);
    expect((await restProjects(loomDaemon.baseURL)).map((p) => p.id),
      "a permanently deleted project is back in the live project list").not.toContain(doomed.id);
    // Exactly two prompts over the whole leg: the refused one and the accepted one. A third would mean
    // the component re-asked after it had already been answered.
    expect(d.only("prompt").length, "the delete prompted more times than it was clicked").toBe(2);
  });

  test("with the switch OFF the classic Projects footer still owns the tier, and classic Settings does not grow it", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`archived-off-${Date.now()}`);
    await pinProject(page, (await loomDaemon.createProject(`archived-off-active-${Date.now()}`)).id);
    await archiveViaRest(loomDaemon.baseURL, project.id);
    // No seedAtlasOn: OFF is the default.

    await page.goto(loomDaemon.baseURL + "/projects");
    await expect(page.locator(".loom-rail"), "the classic shell did not render").toBeVisible();
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);
    // Collapsed on mount, exactly as before this card split the frame off the body — the list is absent
    // until the disclosure is opened, which is itself the assertion.
    await expect(page.getByTestId("archived-projects-list"),
      "the classic Archived disclosure is no longer collapsed on mount").toHaveCount(0);
    const disclosure = page.getByRole("button", { name: /Archived ·/ });
    await expect(disclosure, "the classic Projects rail lost its Archived footer").toBeVisible();
    await disclosure.click();

    const body = page.getByTestId("archived-projects-list");
    await expect(body, "opening the classic Archived disclosure rendered no list").toHaveCount(1);
    await expect(body.getByText(project.name, { exact: true })).toBeVisible();
    await expect(body.getByRole("button", { name: `Restore ${project.name}` })).toBeVisible();
    await expect(body.getByRole("button", { name: `Delete ${project.name} permanently` })).toBeVisible();
    // And it still collapses again.
    await disclosure.click();
    await expect(page.getByTestId("archived-projects-list"),
      "the classic Archived disclosure no longer collapses").toHaveCount(0);

    // The classic Settings page did NOT grow a second copy of the tier: the section is atlasOnly, so a
    // reader who never opted into Atlas keeps exactly one permanent-delete site for an archived project.
    await page.goto(loomDaemon.baseURL + "/settings");
    await expect(page.locator("main [data-testid^='settings-section-']").first(),
      "the classic Settings page rendered no sections, so the absence below proves nothing").toBeVisible();
    await expect(section(page),
      "the classic Settings page grew the Atlas-only Archived projects section").toHaveCount(0);
    await expect(page.locator("main").getByText("Archived projects", { exact: true }),
      "the classic Settings page still shows the Archived projects label").toHaveCount(0);
    await expect(page.locator("main").getByTestId("archived-projects-list"),
      "the classic Settings page grew a second archived-projects list").toHaveCount(0);

    // And the Workspace node's own Settings surface is an Atlas address: LegacyShell mounts none of
    // them, so under the classic shell it renders no Settings at all rather than a second one.
    await page.goto(loomDaemon.baseURL + "/workspace-settings");
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.locator("main [data-testid^='settings-section-']"),
      "the Atlas-only workspace Settings address rendered Settings under the classic shell").toHaveCount(0);
  });
});
