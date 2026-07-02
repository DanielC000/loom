// Vault-viewer spec (card 3006be3a) — drives the real vault browser (/vault) against the isolated,
// seeded daemon and asserts the on-disk Markdown notes both LIST in the folder tree and RENDER (markdown
// → rendered DOM, not raw source). Builds on the shared `loomDaemon` fixture (card c3fd1d68);
// board.spec.ts / settings.spec.ts are the multi-test / active-project templates this follows.
//
// The seeding wrinkle (why this spec does NOT use `loomDaemon.createProject`): the vault viewer reads
// notes from the project's `vaultPath` ON DISK (daemon `vault/browser.ts` → GET /api/projects/:id/vault),
// and the fixture's createProject makes an EMPTY vault dir and never exposes its path. So each test seeds
// its OWN temp dirs here in Node (this spec runs in the Playwright Node process, same machine as the
// daemon), WRITES real `.md` note files into the vault dir, then POSTs the project itself with `vaultPath`
// pointed at that seeded dir. The repo dir is git-init'd to mirror the fixture's createProject (the POST
// itself only requires the three paths be present — it does not validate them on disk).
//
// Determinism note (same as board/settings): the vault viewer is scoped to the ACTIVE project
// (localStorage `loom.projectId`, see lib/activeProject.tsx), and the worker-scoped daemon is SHARED
// across the specs in this file — so more than one project exists on it and the auto-resolved "first
// project" is not stable. Every test therefore seeds its OWN project + notes and PINS it active via
// addInitScript BEFORE navigating, so it never races another test's project. Because the viewer reads
// only the pinned project's vaultPath, the tree contains exactly the notes that test seeded.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Temp vault/repo roots seeded across this spec, torn down together at the end (the fixture only cleans
// its own scratch; the dirs we mkdtemp here are ours to remove).
const seededDirs: string[] = [];

test.afterAll(() => {
  for (const dir of seededDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => {
    localStorage.setItem("loom.projectId", id);
    localStorage.setItem("loom.setupWelcomeDismissed", "1"); // belt-and-braces: never let a welcome modal cover the UI
  }, projectId);
}

// Seed a project whose vaultPath is a real on-disk dir containing `notes` (relative path → markdown text),
// then POST it. Returns the created project id + the vault dir (so a test can add/inspect files if needed).
async function seedVaultProject(
  baseURL: string,
  notes: Record<string, string>,
): Promise<{ id: string; vaultDir: string }> {
  const scratch = mkdtempSync(path.join(tmpdir(), "loom-vault-e2e-"));
  seededDirs.push(scratch);
  const repoDir = path.join(scratch, "repo");
  const vaultDir = path.join(scratch, "vault");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  execFileSync("git", ["init", "-q", repoDir]); // mirror the fixture's createProject; the vault viewer itself needs no git

  for (const [rel, content] of Object.entries(notes)) {
    const abs = path.join(vaultDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  const res = await fetch(`${baseURL}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: uniq("vault"), repoPath: repoDir, vaultPath: vaultDir }),
  });
  if (!res.ok) throw new Error(`POST /api/projects -> ${res.status}: ${await res.text()}`);
  const project = (await res.json()) as { id: string };
  return { id: project.id, vaultDir };
}

// A tree row (file or folder) is a `.loom-tree-row` <button>; its accessible name carries the entry's name.
function treeRow(page: Page, name: string) {
  return page.locator("button.loom-tree-row").filter({ hasText: name });
}

test("lists a seeded root note and RENDERS its markdown (not raw source)", async ({ page, loomDaemon }) => {
  const heading = uniq("Welcome-Heading");
  const boldWord = uniq("emphatic");
  const note = `# ${heading}\n\nThis note has a **${boldWord}** word and a list:\n\n- one\n- two\n`;
  const { id } = await seedVaultProject(loomDaemon.baseURL, { "Welcome.md": note });
  await pinActiveProject(page, id);

  await page.goto(`${loomDaemon.baseURL}/vault`);

  // LISTS: the note surfaces as a file row in the tree.
  await expect(treeRow(page, "Welcome.md")).toBeVisible();

  // Open it and prove it RENDERED, not dumped as source:
  await treeRow(page, "Welcome.md").click();

  //  (a) the `# Heading` became a real heading element (text WITHOUT the leading `#`)…
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  //  (b) `**bold**` became a <strong>…
  await expect(page.locator("strong", { hasText: boldWord })).toBeVisible();
  //  (c) `- one/- two` became real list items…
  await expect(page.getByRole("listitem").filter({ hasText: "one" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "two" })).toBeVisible();
  //  (d) and the raw markdown tokens are NOWHERE on the page (if the viewer showed source, `# <heading>`
  //      and `**bold**` would appear verbatim — the rendered DOM strips them).
  await expect(page.getByText(`# ${heading}`)).toHaveCount(0);
  await expect(page.getByText(`**${boldWord}**`)).toHaveCount(0);
});

test("a note in a subfolder is reachable by expanding the folder, and renders", async ({ page, loomDaemon }) => {
  const heading = uniq("Nested-Note-Heading");
  const note = `# ${heading}\n\nA note that lives one folder deep.\n`;
  const { id } = await seedVaultProject(loomDaemon.baseURL, { "Design/Spec.md": note });
  await pinActiveProject(page, id);

  await page.goto(`${loomDaemon.baseURL}/vault`);

  // The folder lists, but its child is collapsed (the tree starts fully collapsed) — the nested note row is
  // not yet in the DOM, and its rendered heading is absent.
  await expect(treeRow(page, "Design")).toBeVisible();
  await expect(treeRow(page, "Spec.md")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: heading })).toHaveCount(0);

  // Expand the folder → the child note row appears.
  await treeRow(page, "Design").click();
  await expect(treeRow(page, "Spec.md")).toBeVisible();

  // Open it → it renders.
  await treeRow(page, "Spec.md").click();
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
});

test("the file filter narrows the tree to a matching note", async ({ page, loomDaemon }) => {
  const alpha = uniq("Alpha");
  const bravo = uniq("Bravo");
  const { id } = await seedVaultProject(loomDaemon.baseURL, {
    [`${alpha}.md`]: `# ${alpha}\n\nfirst note\n`,
    [`${bravo}.md`]: `# ${bravo}\n\nsecond note\n`,
  });
  await pinActiveProject(page, id);

  await page.goto(`${loomDaemon.baseURL}/vault`);

  // BEFORE: both notes list.
  await expect(treeRow(page, `${alpha}.md`)).toBeVisible();
  await expect(treeRow(page, `${bravo}.md`)).toBeVisible();

  // Filter by the first note's name (the tree restricts to path-substring matches — Vault.tsx `visible`).
  await page.getByPlaceholder("Filter files…").fill(alpha);

  // AFTER: only the matching note survives; the other is filtered out.
  await expect(treeRow(page, `${alpha}.md`)).toBeVisible();
  await expect(treeRow(page, `${bravo}.md`)).toHaveCount(0);

  // Clearing the filter restores the full tree.
  await page.getByPlaceholder("Filter files…").fill("");
  await expect(treeRow(page, `${bravo}.md`)).toBeVisible();
});
