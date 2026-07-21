// Memory spec (card 7ea6ce71) — proves the read-only, per-project memory explorer page (/memory) renders
// real project_memory data and its interactions are observable. Coverage:
//   1. Pinned "always in context" entries render as cards up top; the all-entries list + recall/sort tabs render.
//   2. Search filters the list to matching entries (observable before/after — the row count narrows, the
//      pinned section is suppressed, and the "N of M" header count updates).
//   3. The sort Segmented reorders the list (observable — the first row changes between Recall and Title).
//   4. Clicking an entry opens the note-detail panel (observable — the read-only footer + the entry's key
//      chip + its rendered markdown/[[wikilink]] appear where they weren't before).
//   5. Empty state — a project whose fleet has written no memory shows "No Memory yet".
//   6. Memory is a primary header tab (the owner-approved placement).
//
// Builds on the shared `loomDaemon` fixture (card c3fd1d68). project_memory has NO REST/agent write path
// (writing stays the memory MCP's job), so each test seeds via the fixture's `seedProjectMemory` (the
// test-only POST /internal/test/seed → db.upsertProjectMemory + real retrieval-bumps). Each test seeds its
// OWN project and PINS it active BEFORE navigating, so it never races another test on the shared daemon.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

async function pinActiveProject(page: Page, projectId: string) {
  // The FirstRunWelcome overlay is dismissed globally by the fixture; this only pins the active project so
  // the scoped /memory read resolves to the project we seeded.
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// A realistic Memory corpus: two pinned "always in context" entries + two unpinned. Recall counts + titles
// are chosen so Recall-order and Title-order have DIFFERENT first rows (Zephyr@30 vs Alpha alphabetically),
// and "junction" appears in exactly one entry's body so a content search narrows to one.
const ENTRIES = [
  { key: "commit-identity", title: "Commit Identity", pinned: true, retrievalCount: 18,
    text: "### Rule\nAuthor with a plain **git commit** — no `-c` overrides. See [[conventional-commits]]." },
  { key: "reserved-home", title: "Reserved Platform Home", pinned: true, retrievalCount: 9,
    text: "### Fact\nThe reserved Platform home is seeded on the CORE path." },
  { key: "zephyr-gate", title: "Zephyr Gate", pinned: false, retrievalCount: 30,
    text: "### Gotcha\nThe daemon gate is heavy — sequence dispatches." },
  { key: "alpha-convention", title: "Alpha Convention", pinned: false, retrievalCount: 5,
    text: "### Note\nA junction hazard: never symlink a live worktree before removing it." },
];

async function seedAndOpen(page: Page, loomDaemon: { baseURL: string; createProject: (n?: string) => Promise<{ id: string }>; seedProjectMemory: (p: string, e: typeof ENTRIES) => Promise<string[]> }) {
  const project = await loomDaemon.createProject();
  await loomDaemon.seedProjectMemory(project.id, ENTRIES);
  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/memory`);
  return project;
}

test.describe("memory (per-project memory explorer)", () => {
  test("renders pinned cards, the all-entries list, and the sort tabs", async ({ page, loomDaemon }) => {
    await seedAndOpen(page, loomDaemon);

    // Pinned "always in context" section renders (its hint + the "always" tag on a pinned card).
    await expect(page.getByText("always in agent context")).toBeVisible();
    await expect(page.getByText("always", { exact: true }).first()).toBeVisible();

    // The all-entries list + its three sort tabs (the shared Segmented primitive).
    await expect(page.getByText("All entries")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Recall" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Recent" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Title" })).toBeVisible();

    // One row per entry (four seeded).
    await expect(page.locator(".memory-row")).toHaveCount(4);
  });

  test("search filters the list to matching entries (observable before/after)", async ({ page, loomDaemon }) => {
    await seedAndOpen(page, loomDaemon);

    // BEFORE: all four rows, and the pinned section is present.
    await expect(page.locator(".memory-row")).toHaveCount(4);
    await expect(page.getByText("always in agent context")).toBeVisible();

    // ACT: search a word that appears in ONLY one entry's body.
    await page.getByLabel("Search Memory").fill("junction");

    // AFTER: exactly one row (the matching entry), the header count reads "1 of 4", and the pinned section
    // is suppressed while filtering.
    await expect(page.locator(".memory-row")).toHaveCount(1);
    await expect(page.locator(".memory-row").first()).toContainText("Alpha Convention");
    await expect(page.getByText("1 of 4")).toBeVisible();
    await expect(page.getByText("always in agent context")).toHaveCount(0);
  });

  test("the sort Segmented reorders the list (Recall vs Title changes the first row)", async ({ page, loomDaemon }) => {
    await seedAndOpen(page, loomDaemon);

    // Default sort = Recall → the highest-recall entry (Zephyr Gate @ 30) leads.
    await expect(page.getByRole("tab", { name: "Recall" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".memory-row").first()).toContainText("Zephyr Gate");

    // ACT: switch to Title → alphabetical, so "Alpha Convention" now leads.
    await page.getByRole("tab", { name: "Title" }).click();

    await expect(page.getByRole("tab", { name: "Title" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".memory-row").first()).toContainText("Alpha Convention");
  });

  test("clicking an entry opens the read-only note-detail with rendered markdown + wikilinks", async ({ page, loomDaemon }) => {
    await seedAndOpen(page, loomDaemon);

    // BEFORE: no detail panel — its read-only footer + the rendered wikilink label (detail-body only, since
    // list rows show just title+key) are absent.
    await expect(page.getByText(/Read-only — written/)).toHaveCount(0);
    await expect(page.getByText("conventional-commits")).toHaveCount(0);

    // ACT: open the pinned "Commit Identity" entry from the list.
    await page.locator(".memory-row").filter({ hasText: "Commit Identity" }).click();

    // AFTER: the detail panel mounts — the read-only footer, the injection-state chip, and the rendered
    // [[wikilink]] label (proving the markdown renderer ran, not raw source) all appear.
    await expect(page.getByText(/Read-only — written/)).toBeVisible();
    await expect(page.getByText("always-injected")).toBeVisible();
    await expect(page.getByText("conventional-commits")).toBeVisible();
  });

  test("empty state — a project with no Memory shows the 'No Memory yet' prompt", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject();
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/memory`);

    await expect(page.getByRole("heading", { name: "No Memory yet" })).toBeVisible();
    await expect(page.getByText(/hasn.t written any memory/)).toBeVisible();
  });

  test("Memory is a primary header tab", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/`);
    await expect(page.getByRole("link", { name: /Memory/ })).toBeVisible();
  });
});
