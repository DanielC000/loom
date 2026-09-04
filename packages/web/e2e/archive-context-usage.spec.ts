// Archive session-card context usage (card ec5e64ab) — the owner's ask: "sessions cards in archive
// should also show the context usage of the session." Each ArchiveRow now carries a `context` chip
// rendered by the SAME components/fleet `ContextUsage` the live Mission Control rows use, so the two
// surfaces can never drift on how occupancy is computed.
//
// WHAT THIS SPEC LOCKS DOWN — all three distinguishable ContextUsage states:
// - NULL ("never measured"): an archived session that completed no turn has `ctxInputTokens === null`.
//   That is "no measurement", NOT zero, and rendering it as an empty meter or `0%` would be a
//   plausible-looking, confidently-wrong artifact on a surface nobody double-checks. Regression guard:
//   the dash IS rendered, and no `0%` / `input tokens ·` reading is.
// - MEASURED POSITIVE: a real `ctxInputTokens` renders its meter + `NN%` + `N.Nk` token count.
// - MEASURED ZERO (card b449be97 — the discriminating case): `ctxInputTokens === 0` renders a REAL `0%`
//   meter, never the dash. This is the assertion that actually distinguishes `== null` from a naive
//   `if (!ctxInputTokens)` falsy guard — a mutation that collapses `0` into "unmeasured" passes the
//   NULL case above trivially (both render the dash) and would only be caught here.
//
// Seeding: `/internal/test/seed`'s `liveSessions[]` carries a `ctxInputTokens` field (card b449be97;
// previously absent, so only the NULL case above was seedable — see that card for the daemon-side gap
// this closed). `model` is a synthetic id ("test-model-e2e") matching none of `CONTEXT_WINDOW_BY_MODEL`,
// so it resolves to `DEFAULT_CONTEXT_WINDOW` (200k) deterministically — the expected `%`/`k` values below
// are derived from that, not magic numbers: 50,000 / 200,000 = 25%, 50.0k; 0 / 200,000 = 0%, 0.0k.
//
// Seeding (the no-real-claude invariant): seedLiveSession → POST /internal/test/seed → insertSession
// (never startSession, so no `[pty] spawn`), then archiveSeededSessions stamps archived_at so the row
// leaves the live rail and lands on the Archive page — exactly the shape a real session reaches on
// exit. Each test uses its own fresh project and holds exactly ONE session, so the Archive list has
// exactly one card and page-scoped assertions are unambiguous (the header count asserts identity first).
// Cleanup: the `autoIsolation` auto fixture (fixtures/daemon.ts) archives every seeded session after
// EVERY test automatically — the project's standing rule for a shared e2e daemon — so no per-spec
// afterEach is needed here (consistent with every other spec using seedLiveSession).
import { expect, test } from "./fixtures/daemon";

const SEED_MODEL = "test-model-e2e"; // resolves to DEFAULT_CONTEXT_WINDOW (200_000) — see header comment

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

  test("a measured session renders its meter, percent, and token count", async ({ page, loomDaemon }) => {
    const agentName = `ArchiveCtxMeasured${Date.now()}`;
    const seeded = await loomDaemon.seedLiveSession({
      project: await loomDaemon.createProject(`archive-ctx-measured-${Date.now()}`),
      role: "worker",
      agentName,
      model: SEED_MODEL,
      ctxInputTokens: 50_000,
    });
    await loomDaemon.archiveSeededSessions();

    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), seeded.projectId);
    await page.goto(`${loomDaemon.baseURL}/archive`);

    // IDENTITY FIRST.
    await expect(page.getByText("Archived sessions (1)")).toBeVisible();
    await expect(page.getByText(agentName)).toBeVisible();

    // PRESENT: the measured branch's own title (50,000 / 200,000 = 25%, 50.0k — see header comment),
    // plus the rendered `%`/`k` text nodes.
    await expect(page.getByTitle("50,000 input tokens · 25% of the 200k window")).toBeVisible();
    await expect(page.getByText("25%", { exact: true })).toBeVisible();
    await expect(page.getByText("50.0k", { exact: true })).toBeVisible();

    // ABSENT: this session HAS a measurement, so the never-measured dash must not render.
    await expect(page.getByTitle(/^Never measured/)).toHaveCount(0);
  });

  test("a measured ZERO renders a real 0% meter, never the never-measured dash", async ({ page, loomDaemon }) => {
    const agentName = `ArchiveCtxZero${Date.now()}`;
    const seeded = await loomDaemon.seedLiveSession({
      project: await loomDaemon.createProject(`archive-ctx-zero-${Date.now()}`),
      role: "worker",
      agentName,
      model: SEED_MODEL,
      ctxInputTokens: 0,
    });
    await loomDaemon.archiveSeededSessions();

    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), seeded.projectId);
    await page.goto(`${loomDaemon.baseURL}/archive`);

    // IDENTITY FIRST.
    await expect(page.getByText("Archived sessions (1)")).toBeVisible();
    await expect(page.getByText(agentName)).toBeVisible();

    // PRESENT: a real 0% meter — this is the discriminating assertion (see header comment). A naive
    // `if (!ctxInputTokens)` guard collapses this measured zero into the unmeasured dash instead.
    await expect(page.getByTitle("0 input tokens · 0% of the 200k window")).toBeVisible();
    await expect(page.getByText("0%", { exact: true })).toBeVisible();
    await expect(page.getByText("0.0k", { exact: true })).toBeVisible();

    // ABSENT: a MEASURED zero is not the same as "never measured" — the dash must not render here.
    await expect(page.getByTitle(/^Never measured/)).toHaveCount(0);
  });
});
