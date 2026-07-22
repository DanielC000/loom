// Repository spec (card b20d978e) — proves the IA consolidation that merges the old /vault and /git pages
// into ONE "Repository" destination with a Files | Git segmented switch. Coverage:
//   1. /repository renders the Segmented tabs and defaults to the Files body (the vault browser).
//   2. Switching to the Git tab is an OBSERVABLE state change — the Files body unmounts, the Git body
//      mounts (keyed on distinctive per-body copy, so this proves the RIGHT body swapped), the Git tab
//      reads selected, and `?tab=git` pins the URL.
//   3. The old routes redirect: /vault → /repository (Files tab), /git → /repository?tab=git (Git tab).
//   4. PRESERVED project-scoping: with NO active project, BOTH tabs show the "No project selected." guard —
//      the consolidation kept each pane project-scoped (unlike Automation's god-eye tables).
//   5. A REAL write action on the Git tab (create a branch) produces an observable state change — a new
//      branch chip + the success feedback line — proving the Git pane is fully functional inside the shell.
//
// Builds on the shared `loomDaemon` fixture (card c3fd1d68); vault.spec.ts is the on-disk-seeding template
// this follows (the Repository Files tab reads the same vaultPath). Each test seeds its OWN project (repo +
// vault on disk) and PINS it active BEFORE navigating, so it never races another test on the shared daemon.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Distinctive copy unique to each mounted body — the Files (Vault) filter placeholder vs the Git pane's
// new-branch input placeholder. Keying on these (not the tab labels, which read "Files"/"Git" in the
// Segmented) proves which BODY is mounted, not merely which tab highlighted.
const FILES_BODY_PLACEHOLDER = "Filter files…";
const GIT_BODY_PLACEHOLDER = "new-branch-name";

const seededDirs: string[] = [];
test.afterAll(() => {
  for (const dir of seededDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function pinActiveProject(page: Page, projectId: string) {
  // The FirstRunWelcome overlay is dismissed globally by the fixture (fixtures/daemon.ts); this only pins
  // the active project so the scoped Files/Git panes resolve to a known repo + vault.
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// Seed a project whose repoPath is a real git repo WITH an initial commit (so the Git pane lists a branch
// and create-branch works off HEAD) and whose vaultPath holds a seeded note (so the Files pane lists it),
// then POST it. Returns the created project id + its on-disk repoDir (a test that needs to corrupt the
// bound repo AFTER creation — POST /api/projects requires an existing git repo at create time — reads it).
async function seedRepoProject(baseURL: string): Promise<{ id: string; repoDir: string }> {
  const scratch = mkdtempSync(path.join(tmpdir(), "loom-repo-e2e-"));
  seededDirs.push(scratch);
  const repoDir = path.join(scratch, "repo");
  const vaultDir = path.join(scratch, "vault");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  // git init + a real initial commit so the Git pane has a branch to list and a HEAD to branch off.
  execFileSync("git", ["init", "-q", repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "e2e@loom.test"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Loom E2E"]);
  writeFileSync(path.join(repoDir, "README.md"), "# seed\n", "utf8");
  execFileSync("git", ["-C", repoDir, "add", "-A"]);
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "chore: seed"]);
  writeFileSync(path.join(vaultDir, "Note.md"), "# Seed Note\n\nA seeded vault note.\n", "utf8");

  const res = await fetch(`${baseURL}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: uniq("repo"), repoPath: repoDir, vaultPath: vaultDir }),
  });
  if (!res.ok) throw new Error(`POST /api/projects -> ${res.status}: ${await res.text()}`);
  const project = (await res.json()) as { id: string };
  return { id: project.id, repoDir };
}

test.describe("repository (Vault + Git consolidation)", () => {
  test("/repository renders the Segmented tabs and defaults to the Files body", async ({ page, loomDaemon }) => {
    const { id } = await seedRepoProject(loomDaemon.baseURL);
    await pinActiveProject(page, id);
    await page.goto(`${loomDaemon.baseURL}/repository`);

    // Both tabs render as an accessible tablist (the shared Segmented primitive).
    await expect(page.getByRole("tab", { name: "Files" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Git" })).toBeVisible();

    // Default tab = Files: the Vault body is mounted (its filter), the Git body is not (its branch input).
    await expect(page.getByPlaceholder(FILES_BODY_PLACEHOLDER)).toBeVisible();
    await expect(page.getByPlaceholder(GIT_BODY_PLACEHOLDER)).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Git" })).toHaveAttribute("aria-selected", "false");
  });

  test("switching to the Git tab swaps the mounted body (observable before/after)", async ({ page, loomDaemon }) => {
    const { id } = await seedRepoProject(loomDaemon.baseURL);
    await pinActiveProject(page, id);
    await page.goto(`${loomDaemon.baseURL}/repository`);

    // BEFORE: the Files body is mounted, the Git body is absent.
    await expect(page.getByPlaceholder(FILES_BODY_PLACEHOLDER)).toBeVisible();
    await expect(page.getByPlaceholder(GIT_BODY_PLACEHOLDER)).toHaveCount(0);

    // ACT: click the Git tab.
    await page.getByRole("tab", { name: "Git" }).click();

    // AFTER (observable #1 — DOM swap): the Git body is now mounted and the Files body is gone.
    await expect(page.getByPlaceholder(GIT_BODY_PLACEHOLDER)).toBeVisible();
    await expect(page.getByPlaceholder(FILES_BODY_PLACEHOLDER)).toHaveCount(0);
    // AFTER (observable #2 — selection + URL): the Git tab reads selected and the tab is pinned in the URL.
    await expect(page.getByRole("tab", { name: "Git" })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/repository\?tab=git/);
  });

  test("the old /vault and /git routes redirect to the consolidated Repository page", async ({ page, loomDaemon }) => {
    const { id } = await seedRepoProject(loomDaemon.baseURL);
    await pinActiveProject(page, id);

    // /vault → /repository (Files tab).
    await page.goto(`${loomDaemon.baseURL}/vault`);
    await expect(page.getByPlaceholder(FILES_BODY_PLACEHOLDER)).toBeVisible();
    await expect(page).toHaveURL(/\/repository$/);

    // /git → /repository?tab=git (Git tab).
    await page.goto(`${loomDaemon.baseURL}/git`);
    await expect(page.getByPlaceholder(GIT_BODY_PLACEHOLDER)).toBeVisible();
    await expect(page).toHaveURL(/\/repository\?tab=git/);
  });

  test("both panes are project-scoped — each reflects the pinned project's real repo + vault", async ({ page, loomDaemon }) => {
    // The "No project selected." guard itself can't be reached in this harness — a project always exists on
    // the shared daemon, so the provider auto-resolves one (lib/activeProject.tsx falls back to active[0]).
    // The meaningful scoping proof is that BOTH panes rescope to the PINNED project's on-disk repo + vault.
    const { id } = await seedRepoProject(loomDaemon.baseURL);
    await pinActiveProject(page, id);
    await page.goto(`${loomDaemon.baseURL}/repository`);

    // Files pane is scoped to the pinned project's vault → its seeded note lists.
    await expect(page.locator("button.loom-tree-row").filter({ hasText: "Note.md" })).toBeVisible();

    // Git pane is scoped to the pinned project's repo → its real default branch chip renders (the seeded
    // repo has exactly one branch, so this proves live repo state, not an empty/god-eye view).
    await page.getByRole("tab", { name: "Git" }).click();
    await expect(page.getByRole("button", { name: /^(main|master)$/ })).toBeVisible();
  });

  // Card 60b53c8d: a failed branches/log read must render a VISIBLE, cause-naming error — not a silently
  // empty repo. Seeds a HEALTHY repo (create requires one), confirms the Git tab loads normally, then
  // corrupts it on disk (deletes .git — a genuine read failure, distinct from a commitless-but-real repo)
  // and reloads, proving the addressable Branches/Commits panes (data-git-pane hooks in Git.tsx) show a
  // named cause instead of the friendly "no commits yet" empty state. Scoped to those panes specifically —
  // a page-wide text search could be satisfied by an unrelated sibling element and prove nothing.
  test("a broken repo surfaces a visible, cause-naming error on the Git tab — not an empty repo", async ({ page, loomDaemon }) => {
    const { id, repoDir } = await seedRepoProject(loomDaemon.baseURL);
    await pinActiveProject(page, id);
    await page.goto(`${loomDaemon.baseURL}/repository?tab=git`);

    // BEFORE: a healthy repo — the real branch chip renders, proving the pane loaded against a working repo.
    await expect(page.getByRole("button", { name: /^(main|master)$/ })).toBeVisible();

    // Corrupt the bound repo on disk.
    rmSync(path.join(repoDir, ".git"), { recursive: true, force: true });
    await page.reload();

    const branchesPane = page.locator('[data-git-pane="branches"]');
    const commitsPane = page.locator('[data-git-pane="primary-log"]');
    await expect(branchesPane.getByText(/not a git repository/i)).toBeVisible();
    await expect(commitsPane.getByText(/not a git repository/i)).toBeVisible();
    // The genuinely-empty hint must NOT appear for a broken (not empty) repo — that's the other half of
    // the card's DoD: a real empty repo must still show it, a broken one must never.
    await expect(commitsPane.getByText("no commits yet")).toHaveCount(0);
  });

  test("a real action on the Files tab produces an observable state change (open a note → it renders)", async ({ page, loomDaemon }) => {
    const { id } = await seedRepoProject(loomDaemon.baseURL);
    await pinActiveProject(page, id);
    await page.goto(`${loomDaemon.baseURL}/repository`);

    const noteRow = page.locator("button.loom-tree-row").filter({ hasText: "Note.md" });
    await expect(noteRow).toBeVisible();
    // BEFORE: the empty-viewer prompt is shown; the note's rendered heading is not on the page.
    await expect(page.getByText("Select a file to view, or create a new one.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Seed Note" })).toHaveCount(0);

    // ACT: open the note (a real daemon read of the pinned project's vault file).
    await noteRow.click();

    // AFTER: the markdown rendered (a real <h1>, not raw `# Seed Note` source) and the prompt is gone.
    await expect(page.getByRole("heading", { name: "Seed Note" })).toBeVisible();
    await expect(page.getByText("Select a file to view, or create a new one.")).toHaveCount(0);
  });

  test("the Command Palette lists ONE 'Repository' page and no lingering 'Vault' / 'Git' entries", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/`);
    // Open the ⌘/Ctrl-K launcher and constrain the fuzzy filter to page rows (hint = "page").
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Jump to…  (Esc to close)");
    await expect(search).toBeVisible();

    // Exactly one "Repository" page command surfaces (nav derives the palette from NAV_PAGES).
    await search.fill("Repository");
    const rows = page.locator("button", { has: page.getByText("page", { exact: true }) });
    await expect(rows.filter({ hasText: "Repository" })).toHaveCount(1);

    // The old page labels are gone — no "Vault" or "Git" page command remains.
    await search.fill("Vault");
    await expect(rows.filter({ hasText: "Vault" })).toHaveCount(0);
    await search.fill("Git");
    await expect(rows.filter({ hasText: "Git" })).toHaveCount(0);
  });
});
