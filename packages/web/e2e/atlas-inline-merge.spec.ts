// Atlas parity gap (a) + (c) — card c2968651. The Needs-you band renders a pending review as a
// COMPACT row (a band column is ~300px; the Review-queue card grid is minmax(340px,1fr)), so P2-1
// left its only affordance a deep-link to /review/:id. This spec measures the inline
// "Approve & merge" that closes that, and the two exits the `worst context` pop-over gained in place
// of the round-4 mockup's un-wireable "Recycle Dev" / "Adjust threshold" buttons.
//
// WHAT MAKES EACH LEG MORE THAN A RENDER CHECK:
//   * The MERGE click is EXERCISED, not just drawn. The POST is intercepted, so the spec reads the
//     real URL the app issued and asserts it names THIS worker's session id — that is what proves
//     the button is on the same `api.mergeWorker` write path as the full Review queue, rather than
//     merely existing. The canned reply then drives an observable BEFORE/AFTER: the outcome line is
//     absent, the click lands, the line appears carrying a per-run sentinel reason. Both outcome
//     branches are driven (`rejected` and the still-running `pending`), because those two are the
//     pair a single `!merged` check would collapse (card 361520a0 Half Four).
//   * Interception is also why no real merge runs: the seeded worker has no worktree, exactly as
//     worker-diff-staletime.spec.ts intercepts /diff for the same reason. No real claude spawns.
//   * SWITCH OFF asserts the classic Overview KEEPS its own rich card and its own merge button —
//     it does NOT assert "no merge button in classic", which would be false (that button has always
//     been there) and would fail. The OFF polarity is scoped to the compact action's own test id.
//
// FIXTURE IDENTITY (load-bearing): the e2e daemon is SHARED across spec files, so a sibling spec's
// worker renders a byte-identical merge row. Every locator here is scoped either to this test's own
// worker session id (the `data-session-id` hook card ed0858dc added for exactly this) or to a
// per-run sentinel string, never to kind or button text alone.
import { randomUUID } from "node:crypto";
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Writes only while the key is still absent: addInitScript re-runs on every navigation, `reload()`
// included, so an unconditional write would re-pin on a reload and that leg would be measuring this
// helper instead of the app (measured on P1-4). The band is project-FILTERED at the project node, so
// leaving the pick to whatever the shared daemon happens to hold would decide the fixture for us.
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

/** 8 chars, because the UI renders `id.slice(0, 8)` — a per-run prefix is what makes this worker's
 *  own card distinguishable ON SCREEN from a sibling spec's (the fixture's own `id` doc says so). */
const shortPrefix = () => `m${Math.random().toString(36).slice(2, 9)}`.slice(0, 8);

/**
 * A live manager + its live worker, and the `merge_request` audit row that makes the worker a
 * pending review. Both halves are required: `useAttention` keeps a merge item only while its
 * manager is live AND its worker is still in the live session feed (lib/attention.ts's `liveWorker`),
 * so a seeded event alone would produce nothing. Both sessions are `processState:"live"` DB rows via
 * the test-only seed verb — never startSession, which would spawn a real claude and trip this
 * fixture's no-spawn guard.
 */
async function seedPendingReview(loomDaemon: LoomDaemon) {
  const short = shortPrefix();
  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: `InlineMergeMgr-${short}` });
  const wkr = await loomDaemon.seedLiveSession({
    project: mgr.project, agentId: mgr.agentId, role: "worker",
    id: `${short}-${randomUUID()}`,
    parentSessionId: mgr.sessionId, branch: `loom/inline-merge-${short}`,
    task: { title: `inline-merge-${short}` },
  });
  await loomDaemon.seedOrchestrationEvent({
    managerSessionId: mgr.sessionId, kind: "merge_request",
    workerSessionId: wkr.sessionId, taskId: wkr.taskId,
  });
  return { mgr, wkr, short, projectId: mgr.projectId };
}

/**
 * THE INSTRUMENT for the write path. Captures every `POST /api/sessions/:id/merge` the app actually
 * issues and serves a canned verdict, so the assertions below read real client traffic rather than a
 * proxy signal. A RegExp, not a glob: the route must match the merge endpoint and only it.
 */
async function interceptMerge(page: Page, reply: () => Record<string, unknown>) {
  const hits: { url: string; method: string }[] = [];
  await page.route(/\/api\/sessions\/[^/]+\/merge$/, async (route) => {
    hits.push({ url: route.request().url(), method: route.request().method() });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reply()) });
  });
  return hits;
}

/** This worker's own merge row, scoped by the session id it is ABOUT — never by kind or text. */
const mergeRow = (page: Page, container: string, workerId: string) =>
  page.getByTestId(container).locator(`[data-testid="attention-row"][data-session-id="${workerId}"]`);

test.describe("Atlas inline merge actions (card c2968651)", () => {
  test("switch ON: the band's merge row merges through the real write path, at both levels", async ({ page, loomDaemon }) => {
    // Two node loads, two outcome branches, and a /review round-trip is past the 30s default.
    test.setTimeout(150_000);
    const seeded = await seedPendingReview(loomDaemon);
    const rejectedReason = `gate-red-${seeded.short}`;
    const pendingReason = `gate-running-${seeded.short}`;
    let reply: Record<string, unknown> = { merged: false, pending: false, reason: rejectedReason };
    const hits = await interceptMerge(page, () => reply);

    await seedAtlasOn(page);
    await pinProject(page, seeded.projectId);
    await page.goto(loomDaemon.baseURL + "/home");

    // ── PRESENCE FIRST. The row is really here, and it is THIS worker's: a bare "the action
    //    exists" on a still-loading page would pass with nothing on screen (card 625d791c).
    const row = mergeRow(page, "atlas-band-needs", seeded.wkr.sessionId);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-kind", "MERGE REQUEST");

    // The compact action is in the row — and the generic "Open" is NOT, because the footer's own
    // "Review →" replaced it rather than stacking a second copy of the same navigation.
    const action = page.getByTestId(`atlas-band-merge-${seeded.wkr.sessionId}`);
    await expect(action).toBeVisible();
    await expect(action.getByRole("button", { name: "Review →" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Open" })).toHaveCount(0);

    // `exact` throughout: the outcome is ONE span whose whole text is the line, so an exact match
    // can only be that span — a substring match would also hit every ancestor and trip strict mode.
    const rejectedLine = row.getByText(`rejected — ${rejectedReason}`, { exact: true });
    const pendingLine = row.getByText(`still running — ${pendingReason}`, { exact: true });

    // ── THE WRITE PATH. BEFORE: no outcome line anywhere in this row.
    await expect(rejectedLine).toHaveCount(0);
    await expect(pendingLine).toHaveCount(0);
    expect(hits).toHaveLength(0);

    await page.getByTestId(`atlas-band-merge-go-${seeded.wkr.sessionId}`).click();

    // AFTER: the row renders the REJECTED branch, carrying the reason the daemon replied with — so
    // the click reached a mutation whose result is actually read, not a button that only disables.
    await expect(rejectedLine).toBeVisible();

    // …and it went to THIS worker's merge endpoint. This is the half that makes "same write path as
    // the full Review queue" a measurement: same route, same method, this worker's id in the path.
    expect(hits).toHaveLength(1);
    const first = hits[0]!;
    expect(first.method).toBe("POST");
    expect(new URL(first.url).pathname).toBe(`/api/sessions/${seeded.wkr.sessionId}/merge`);

    // ── THE OTHER OUTCOME BRANCH. `pending` (merged:null) is a still-RUNNING gate, not a refusal —
    //    the pair a single `!merged` check would report as "rejected" with no reason to doubt it.
    reply = { merged: null, pending: true, reason: pendingReason };
    await page.getByTestId(`atlas-band-merge-go-${seeded.wkr.sessionId}`).click();
    await expect(pendingLine).toBeVisible();
    await expect(rejectedLine).toHaveCount(0);
    expect(hits).toHaveLength(2);

    // ── THE SAME ACTION IN THE `needs you` POP-OVER. One AttentionList feeds four mounts (the band
    //    panel and the KPI pop-over, at each level), so this is the claim that wiring it once
    //    reached all of them — asserted, not assumed.
    await page.getByTestId("atlas-kpi-needs").click();
    const pop = page.getByTestId("atlas-kpi-pop-needs");
    await expect(pop).toBeVisible();
    await expect(mergeRow(page, "atlas-kpi-pop-needs", seeded.wkr.sessionId)).toBeVisible();
    await expect(pop.locator(`[data-testid="atlas-band-merge-go-${seeded.wkr.sessionId}"]`)).toBeVisible();
    await page.getByTestId("atlas-kpi-close-needs").click();
    await expect(pop).toHaveCount(0);

    // ── THE PROJECT NODE carries it too (its band is the project-filtered twin of the same list).
    await page.goto(loomDaemon.baseURL + "/project");
    const projRow = mergeRow(page, "atlas-band-needs", seeded.wkr.sessionId);
    await expect(projRow).toBeVisible();
    await expect(page.getByTestId(`atlas-band-merge-${seeded.wkr.sessionId}`)).toBeVisible();

    // ── "Review →" is still the way to the full diff — the verification path stays reachable in one
    //    click, which is why it, and not the merge, is the row's primary button.
    await page.getByTestId(`atlas-band-merge-${seeded.wkr.sessionId}`)
      .getByRole("button", { name: "Review →" }).click();
    await expect(page).toHaveURL(new RegExp(`/review/${seeded.wkr.sessionId}$`));
    // No further merge requests were issued by the navigation itself.
    expect(hits).toHaveLength(2);
  });

  test("switch ON: the worst-context pop-over exits to the session and to the threshold", async ({ page, loomDaemon }) => {
    // A session that actually REPORTS context, so the pop-over has a row at all. `model` is passed
    // alongside so the expected % is derivable from `contextWindowForModel` rather than a magic
    // number: 200_000 of a 1M window is 20%.
    const short = shortPrefix();
    const mgr = await loomDaemon.seedLiveSession({
      role: "manager", agentName: `CtxExit-${short}`,
      model: "claude-sonnet-4-5", ctxInputTokens: 200_000,
    });
    await seedAtlasOn(page);
    await pinProject(page, mgr.projectId);
    await page.goto(loomDaemon.baseURL + "/project");

    const tile = page.getByTestId("atlas-kpi-context");
    await expect(tile).toBeVisible();
    await tile.click();
    const pop = page.getByTestId("atlas-kpi-pop-context");
    await expect(pop).toBeVisible();

    // THE ROW'S EXIT — the agent's name is now the link to the session that owns the real controls.
    // Scoped to this test's own agent name, since the pop-over lists every reporting session.
    const sessionLink = pop.getByRole("link", { name: `CtxExit-${short}` });
    await expect(sessionLink).toBeVisible();
    await expect(sessionLink).toHaveAttribute("href", `/session/${mgr.sessionId}`);

    // THE THRESHOLD EXIT — the footer names the ratio these meters are read against (the platform
    // default 0.80 ⇒ "80%", resolved through resolveConfig, not hardcoded in the page) and links to
    // where that number is actually edited. This is what replaced the mockup's "Adjust threshold":
    // the field is a numeric config, so it is a form, not a button.
    await expect(pop.locator(".loom-bandfoot").filter({ hasText: /hand off at \d+%/ })).toBeVisible();
    await expect(pop.getByRole("link", { name: /change it in Settings/ })).toHaveAttribute("href", "/settings");

    // A REGRESSION GUARD, not a proof: no control in here claims to recycle. There is no human
    // recycle write path (lib/api.ts has resume/stop and no recycle), and a stop+resume pair wearing
    // that label would misname what the click does — see this card's decision record.
    await expect(pop.getByRole("button", { name: /recycl/i })).toHaveCount(0);

    // The row's own figure is the DERIVED one — 200k against this model's 1M window — so the
    // pop-over is reading real state, not drawing a meter at a fixed width. The turn count rides
    // the same span and is not what this asserts, hence the partial match.
    await expect(pop.locator(".loom-meterrow-v").filter({ hasText: "20%" })).toBeVisible();
  });

  test("switch OFF: the classic Overview keeps its own rich card, and the compact action is nowhere", async ({ page, loomDaemon }) => {
    const seeded = await seedPendingReview(loomDaemon);
    // Deliberately NO seedAtlasOn — off is the default, and seeding it off would re-clear the key on
    // every navigation for a reason unrelated to the app (measured on P1-0).
    await pinProject(page, seeded.projectId);
    await page.goto(loomDaemon.baseURL + "/overview");

    // ── PRESENCE: classic renders THIS worker as the rich Review-queue card it always did. The
    //    `w:<short>` label is this worker's own (the seeded id's first 8 chars), so the card the
    //    rest of this leg talks about is unambiguously ours on a shared daemon.
    await expect(page.locator("main").getByText(`w:${seeded.short}`, { exact: true })).toBeVisible();
    // The card is the deepest element holding BOTH this worker's id label and a merge button: inside
    // the Panel, the identity row has the id without the buttons and the action row has the buttons
    // without the id, so nothing smaller satisfies both. Locators come back in DOCUMENT order and an
    // ancestor precedes its descendants, so `.last()` is that deepest match — `.first()` would be
    // `main`, which on a shared daemon could pair my id with a sibling spec's button.
    const classicCard = page.locator("main div")
      .filter({ hasText: `w:${seeded.short}` }).filter({ hasText: "Approve & merge" }).last();
    await expect(classicCard.getByRole("button", { name: "Approve & merge" })).toBeVisible();
    await expect(classicCard.getByRole("button", { name: "Review →" })).toBeVisible();

    // ── ABSENCE, scoped to what this card BUILT. Not "no merge button in classic" — classic has had
    //    one all along, on the card asserted above; this is the compact band action's own test id.
    await expect(page.getByTestId(`atlas-band-merge-${seeded.wkr.sessionId}`)).toHaveCount(0);
    await expect(page.getByTestId(`atlas-band-merge-go-${seeded.wkr.sessionId}`)).toHaveCount(0);
    // And classic still routes a merge request to that card rather than to an attention row at all,
    // so the footer-bearing row shape cannot appear here even in principle.
    await expect(page.locator(`[data-testid="attention-row"][data-session-id="${seeded.wkr.sessionId}"]`)).toHaveCount(0);
    await expect(page.getByTestId("atlas-kpi-deck")).toHaveCount(0);
  });
});
