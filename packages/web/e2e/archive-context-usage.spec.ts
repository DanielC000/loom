// Archive session-card context usage (card ec5e64ab) — the owner's ask: "sessions cards in archive
// should also show the context usage of the session." Each ArchiveRow now carries a `context` chip
// rendered by the SAME components/fleet `ContextUsage` the live Mission Control rows use, so the two
// surfaces can never drift on how occupancy is computed.
//
// WHAT THIS SPEC LOCKS DOWN — the NEVER-MEASURED case, which is the one that fails silently. An
// archived session that completed no turn has `ctxInputTokens === null`; that is "no measurement",
// NOT zero, and rendering it as an empty meter or `0%` would be a plausible-looking, confidently-wrong
// artifact on a surface nobody double-checks. The card names that failure class explicitly, so the
// regression guard here is: the dash IS rendered, and no `0%` / `input tokens ·` reading is.
//
// COVERAGE BOUND (deliberate, not an oversight): the MEASURED half (a real `ctxInputTokens` → meter +
// `NN%` + `N.Nk`) is NOT covered here, because `/internal/test/seed` has no `ctxInputTokens` field —
// `liveSessions[]` accepts id/projectId/agentId/role/parent/task/title/busy/branch/model/processState
// and pty geometry, and nothing else writes ctx_input_tokens outside the pty's own onContextStats.
// Seeding a measured value would mean extending that daemon route, which is outside this card's
// packages/web-only scope. The measured half was verified by hand against the live daemon instead.
//
// Seeding (the no-real-claude invariant): seedLiveSession → POST /internal/test/seed → insertSession
// (never startSession, so no `[pty] spawn`), then archiveSeededSessions stamps archived_at so the row
// leaves the live rail and lands on the Archive page — exactly the shape a real session reaches on
// exit. The project is brand new and holds exactly ONE session, so the Archive list has exactly one
// card and page-scoped assertions are unambiguous (the header count asserts that identity first).
import { expect, test } from "./fixtures/daemon";

test.describe("Archive session cards — context usage (card ec5e64ab)", () => {
  test("a never-measured archived session shows an explicit dash, never 0%", async ({ page, loomDaemon }) => {
    const agentName = `ArchiveCtx${Date.now()}`;
    const seeded = await loomDaemon.seedLiveSession({
      project: await loomDaemon.createProject(`archive-ctx-${Date.now()}`),
      role: "worker",
      agentName,
    });
    // Archive it — sessions auto-archive on exit, so this is how a row reaches the Archive page.
    await loomDaemon.archiveSeededSessions();

    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), seeded.projectId);
    await page.goto(`${loomDaemon.baseURL}/archive`);

    // IDENTITY FIRST: this fresh project holds exactly one archived row, so everything below is
    // unambiguously about the session this test seeded and not about a sibling spec's leftovers.
    await expect(page.getByText("Archived sessions (1)")).toBeVisible();
    await expect(page.getByText(agentName)).toBeVisible();

    // PRESENT: the never-measured treatment — an explicit dash carrying the "not the same as 0%"
    // explanation. This also proves the title-scoped locator below actually resolves on this page,
    // so the absence assertions that follow are not silently passing on a broken selector.
    const unmeasured = page.getByTitle(/^Never measured/);
    await expect(unmeasured).toBeVisible();
    await expect(unmeasured).toHaveText("—");

    // ABSENT: no measured reading is fabricated for a row that has none. `input tokens ·` is the
    // measured branch's own title, and `0%` is the specific wrong rendering this card exists to
    // prevent — neither may appear anywhere on the archived card.
    await expect(page.getByTitle(/input tokens ·/)).toHaveCount(0);
    await expect(page.getByText("0%", { exact: true })).toHaveCount(0);
  });
});
