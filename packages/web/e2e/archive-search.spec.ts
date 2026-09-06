// Archive server-side search (card b9161ad2) — Archive.tsx's search used to be CLIENT-side over
// whatever pages happened to be loaded, so a match sitting past the loaded pages was invisible ("I know
// that session exists but search says nothing", a silent symptom with no error). Search is now pushed
// server-side (`?q=` on GET /api/projects/:id/archive) so it reaches the full archived set.
//
// This spec drives the real UI (typing into the search box, reading the rendered rows/counts) rather
// than asserting against the API directly — the db/REST layer (limit/offset/total-under-filter/bounded
// payload/LIKE-escaping) is already covered exhaustively by packages/daemon/test/all-archived-sessions.mjs
// (section K); this spec's job is to prove the wiring end to end: typing a query actually narrows what
// renders, the header count reflects the filtered total, and clearing the query restores everything.
import { expect, test } from "./fixtures/daemon";

test.describe("Archive search (card b9161ad2)", () => {
  test("typing a search query filters server-side by agent name; clearing restores the full list", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`archive-search-${Date.now()}`);
    const matchName = `ZephyrAgent${Date.now()}`;
    const otherName = `OtherAgent${Date.now()}`;
    await loomDaemon.seedLiveSession({ project, role: "worker", agentName: matchName });
    await loomDaemon.seedLiveSession({ project, role: "worker", agentName: otherName });
    await loomDaemon.archiveSeededSessions();

    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
    await page.goto(`${loomDaemon.baseURL}/archive`);

    // Both rows present before searching.
    await expect(page.getByText("Archived sessions (2)")).toBeVisible();
    await expect(page.getByText(matchName)).toBeVisible();
    await expect(page.getByText(otherName)).toBeVisible();

    // Search narrows to the matching row only — header count reflects the FILTERED total, not the
    // project's full 2 (this is the server-side `total` under an active `?q=`, not a client re-filter).
    await page.getByPlaceholder("Search id · agent · role · task · branch…").fill("zephyr");
    await expect(page.getByText("Archived sessions (1)")).toBeVisible();
    await expect(page.getByText(matchName)).toBeVisible();
    await expect(page.getByText(otherName)).toHaveCount(0);

    // Clearing the query restores the full, unfiltered list — the empty/blank `q` case behaves exactly
    // as no `q` at all.
    await page.getByPlaceholder("Search id · agent · role · task · branch…").fill("");
    await expect(page.getByText("Archived sessions (2)")).toBeVisible();
    await expect(page.getByText(otherName)).toBeVisible();
  });

  test("a query matching nothing renders the explicit no-match message, not the empty-archive message", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`archive-search-nomatch-${Date.now()}`);
    await loomDaemon.seedLiveSession({ project, role: "worker", agentName: `Agent${Date.now()}` });
    await loomDaemon.archiveSeededSessions();

    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);
    await page.goto(`${loomDaemon.baseURL}/archive`);
    await expect(page.getByText("Archived sessions (1)")).toBeVisible();

    await page.getByPlaceholder("Search id · agent · role · task · branch…").fill("no-such-session-exists-anywhere");
    await expect(page.getByText("Archived sessions (0)")).toBeVisible();
    await expect(page.getByText("No archived sessions match “no-such-session-exists-anywhere”.")).toBeVisible();
    // The DIFFERENT empty-archive message (no rows at all, not searching) must not render here — a
    // regression that swaps the two conditions would be silent otherwise (both read as "nothing shown").
    await expect(page.getByText("No archived sessions in this project.", { exact: false })).toHaveCount(0);
  });
});
