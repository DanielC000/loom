// Git-tab branch-list filter + worker-branch fold e2e (card a044b33b). A healthy Loom project
// accumulates a `loom/<id>` worker branch per dispatched card, so the raw `git branch` list becomes a
// wall of opaque hashes. The Branches pane now: pins the CURRENT branch at the top, folds the `loom/*`
// worker branches into a collapsed "worker branches (N)" disclosure, and filters every branch by name.
//
// This drives the real isolated daemon (`GET …/git/branches` off a genuine repo) — no mocking. It seeds a
// project whose repoPath is a real git repo with an initial commit plus a handful of human-named branches
// and a dozen `loom/*` worker branches, then exercises the two new interactive controls with a real
// before/after: the fold (a worker branch is ABSENT by default, then PRESENT after expanding) and the
// filter (typing narrows the visible list). Follows repository.spec.ts's on-disk repo-seeding template.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const seededDirs: string[] = [];
test.afterAll(() => {
  for (const dir of seededDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Human-named branches (the ones a human can actually scan for) and worker branches (`loom/<12-hex>`).
const NAMED_BRANCHES = ["agents-rename", "fix/harden-builddaemon", "feature/git-tab-filter"];
// Deterministic 12-hex names so assertions can target an exact branch button.
const WORKER_BRANCHES = Array.from({ length: 12 }, (_, i) => `loom/${(i + 1).toString(16).padStart(12, "0")}`);
// main (renamed below) + 3 named + 12 worker = 16 refs total in `git branch`.
const TOTAL_REFS = 1 + NAMED_BRANCHES.length + WORKER_BRANCHES.length;

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// Seed a project whose repoPath is a real git repo with an initial commit, a deterministic `main` current
// branch, three human-named branches, and a dozen `loom/*` worker branches — the "wall of refs" shape the
// card targets. Git identity is set as LOCAL repo config (hermetic — never leans on the host's global git).
async function seedBranchyProject(baseURL: string): Promise<{ id: string }> {
  const scratch = mkdtempSync(path.join(tmpdir(), "loom-branchfilter-e2e-"));
  seededDirs.push(scratch);
  const repoDir = path.join(scratch, "repo");
  const vaultDir = path.join(scratch, "vault");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args]);
  execFileSync("git", ["init", "-q", repoDir]);
  git("config", "user.email", "e2e@loom.test");
  git("config", "user.name", "Loom E2E");
  writeFileSync(path.join(repoDir, "README.md"), "# seed\n", "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: seed");
  git("branch", "-M", "main"); // deterministic current branch regardless of host init.defaultBranch
  for (const b of [...NAMED_BRANCHES, ...WORKER_BRANCHES]) git("branch", b);

  const res = await fetch(`${baseURL}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: uniq("branchy"), repoPath: repoDir, vaultPath: vaultDir }),
  });
  if (!res.ok) throw new Error(`POST /api/projects -> ${res.status}: ${await res.text()}`);
  const project = (await res.json()) as { id: string };
  return { id: project.id };
}

async function gotoGitTab(page: Page, baseURL: string, projectId: string) {
  await pinActiveProject(page, projectId);
  await page.goto(`${baseURL}/repository?tab=git`);
  // The Git body is mounted (its new-branch input is the distinctive marker used across repository.spec).
  await expect(page.getByPlaceholder("new-branch-name")).toBeVisible();
}

test.describe("git branch-list filter + worker fold (card a044b33b)", () => {
  test("worker branches are folded by default and the disclosure reveals them (observable before/after)", async ({ page, loomDaemon }) => {
    const { id } = await seedBranchyProject(loomDaemon.baseURL);
    await gotoGitTab(page, loomDaemon.baseURL, id);

    const branchesPane = page.locator('[data-git-pane="branches"]');
    // Current branch is pinned + prominent, and the human-named branches are visible by default.
    await expect(branchesPane.getByRole("button", { name: /^main$/ })).toBeVisible();
    await expect(branchesPane.getByText("current", { exact: true })).toBeVisible();
    await expect(branchesPane.getByRole("button", { name: "fix/harden-builddaemon" })).toBeVisible();
    // Honest total count is shown (no silent truncation).
    await expect(branchesPane.getByText(`${TOTAL_REFS} branches`)).toBeVisible();

    // The fold shows its count and, BEFORE expanding, its worker branches are absent from the DOM.
    const fold = branchesPane.getByRole("button", { name: `worker branches (${WORKER_BRANCHES.length})` });
    await expect(fold).toBeVisible();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    const sampleWorker = WORKER_BRANCHES[0];
    await expect(branchesPane.getByRole("button", { name: sampleWorker })).toHaveCount(0);

    // ACT: expand the disclosure.
    await fold.click();

    // AFTER (observable state change): the worker branch buttons are now present.
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(branchesPane.getByRole("button", { name: sampleWorker })).toBeVisible();
    await expect(branchesPane.getByRole("button", { name: WORKER_BRANCHES[11] })).toBeVisible();
  });

  test("the filter narrows the visible list — a named match survives, the rest are hidden", async ({ page, loomDaemon }) => {
    const { id } = await seedBranchyProject(loomDaemon.baseURL);
    await gotoGitTab(page, loomDaemon.baseURL, id);

    const branchesPane = page.locator('[data-git-pane="branches"]');
    const filter = branchesPane.getByPlaceholder("filter branches…");

    // BEFORE: both named branches present, the fold at full worker count.
    await expect(branchesPane.getByRole("button", { name: "fix/harden-builddaemon" })).toBeVisible();
    await expect(branchesPane.getByRole("button", { name: "agents-rename" })).toBeVisible();

    // ACT: filter to a substring that matches exactly one named branch.
    await filter.fill("harden");

    // AFTER: the matching named branch survives; the non-matching one is gone; the count reflects the match.
    await expect(branchesPane.getByRole("button", { name: "fix/harden-builddaemon" })).toBeVisible();
    await expect(branchesPane.getByRole("button", { name: "agents-rename" })).toHaveCount(0);
    await expect(branchesPane.getByText(`1 of ${NAMED_BRANCHES.length + WORKER_BRANCHES.length} match`)).toBeVisible();
    // The worker fold auto-opens under an active filter, and correctly reports zero matches for this query.
    await expect(branchesPane.getByRole("button", { name: WORKER_BRANCHES[0] })).toHaveCount(0);
    await expect(branchesPane.getByText(/no worker branches match/)).toBeVisible();
  });

  test("a worker-hash filter auto-expands the fold and surfaces the matching worker branch", async ({ page, loomDaemon }) => {
    const { id } = await seedBranchyProject(loomDaemon.baseURL);
    await gotoGitTab(page, loomDaemon.baseURL, id);

    const branchesPane = page.locator('[data-git-pane="branches"]');
    const filter = branchesPane.getByPlaceholder("filter branches…");
    const target = WORKER_BRANCHES[4]; // loom/000000000005

    // BEFORE: folded away, so the target worker branch is not in the DOM.
    await expect(branchesPane.getByRole("button", { name: target })).toHaveCount(0);

    // ACT: filter by the worker branch's hash suffix.
    await filter.fill(target.slice("loom/".length));

    // AFTER: the fold auto-expanded and the matching worker branch is now visible; named branches drop out.
    await expect(branchesPane.getByRole("button", { name: target })).toBeVisible();
    await expect(branchesPane.getByRole("button", { name: "agents-rename" })).toHaveCount(0);
  });
});
