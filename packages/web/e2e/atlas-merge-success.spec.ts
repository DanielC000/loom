// Card c2182f9d — a successful one-click merge is acknowledged. `MergeOutcome`
// (packages/web/src/components/reviewQueue.tsx) rendered the merge endpoint's `pending` and
// `rejected` outcomes and nothing at all for its green one, so "Merging…" went back to
// "Approve & merge" and the reader had no way to tell a landed merge from a click that never fired.
// The success line lives in that SHARED reader, which is why one branch had to reach two renderings
// — and why this spec measures BOTH rather than the one that is easier to seed.
//
// WHAT MAKES EACH LEG MORE THAN A RENDER CHECK:
//   * The click is EXERCISED with an observable BEFORE/AFTER: the success line is asserted ABSENT,
//     the click lands, the line appears. A bare "the line is visible" would also pass on a page that
//     had rendered it for some unrelated reason, and a bare "the button exists" proves nothing at all.
//   * The intercepted POST is read back. The spec asserts the URL the app actually issued names THIS
//     worker's session id, so the line that appeared is this row's own mutation result rather than
//     anything else on a shared daemon. That matters more here than on the sibling spec's branches:
//     `merged` carries NO per-run sentinel of its own and cannot (the green response has no `reason`
//     field to put one in), so the request identity plus the row scope IS the whole of its identity.
//   * The two PRE-EXISTING branches are re-driven on the SAME component instance, after the success
//     assertion. A success branch inserted at the wrong place in `MergeOutcome` does not announce
//     itself — it shows up as `rejected` or `still running` quietly going missing, so those are
//     asserted here rather than left to the sibling spec that first drove them.
//   * Mutual exclusion is asserted in both directions. Each outcome assertion pairs "this line is
//     visible" with "the other two are count 0", which is what the ordering of those three checks
//     actually guarantees — `pending` (merged:null) before the `!merged` refusal check (card 361520a0
//     Half Four), and the green check after both.
//   * No real merge runs, and no real claude spawns: the seeded worker has no worktree and the POST
//     never leaves the page, the same reason atlas-inline-merge.spec.ts and worker-diff-staletime
//     .spec.ts intercept their own endpoints.
//
// FIXTURE IDENTITY (load-bearing): the e2e daemon is SHARED across spec files, so a sibling spec's
// worker renders a byte-identical merge row and card. Every locator is scoped either to this test's
// own worker session id (the `data-session-id` hook, card ed0858dc) or to a per-run short prefix,
// never to a kind, a button label, or an outcome string alone.
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

// Writes only while the key is still absent: addInitScript re-runs on every navigation, so an
// unconditional write would re-pin on a reload and that leg would be measuring this helper instead
// of the app (measured on P1-4). Both surfaces here are project-FILTERED, so leaving the pick to
// whatever the shared daemon happens to hold would decide the fixture for us.
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

/** 8 chars, because both renderings derive a visible label from `id.slice(0, 8)` — a per-run prefix
 *  is what makes this worker's own card distinguishable ON SCREEN from a sibling spec's. */
const shortPrefix = () => `s${Math.random().toString(36).slice(2, 9)}`.slice(0, 8);

/**
 * A live manager + its live worker, and the `merge_request` audit row that makes the worker a
 * pending review. BOTH halves are required: `useAttention` keeps a merge item only while its
 * manager is live AND its worker is still in the live session feed (lib/attention.ts's `liveWorker`),
 * so a seeded event alone would produce nothing. Both sessions are `processState:"live"` DB rows via
 * the test-only seed verb — never startSession, which would spawn a real claude and trip this
 * fixture's no-spawn guard.
 */
async function seedPendingReview(loomDaemon: LoomDaemon) {
  const short = shortPrefix();
  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: `MergeOkMgr-${short}` });
  const wkr = await loomDaemon.seedLiveSession({
    project: mgr.project, agentId: mgr.agentId, role: "worker",
    id: `${short}-${randomUUID()}`,
    parentSessionId: mgr.sessionId, branch: `loom/merge-ok-${short}`,
    task: { title: `merge-ok-${short}` },
  });
  await loomDaemon.seedOrchestrationEvent({
    managerSessionId: mgr.sessionId, kind: "merge_request",
    workerSessionId: wkr.sessionId, taskId: wkr.taskId,
  });
  return { mgr, wkr, short, projectId: mgr.projectId };
}

/**
 * THE INSTRUMENT. Captures every `POST /api/sessions/:id/merge` the app actually issues and serves a
 * canned verdict, so the assertions read real client traffic rather than a proxy signal. A RegExp,
 * not a glob: the route must match the merge endpoint and only it.
 */
async function interceptMerge(page: Page, reply: () => Record<string, unknown>) {
  const hits: { url: string; method: string }[] = [];
  await page.route(/\/api\/sessions\/[^/]+\/merge$/, async (route) => {
    hits.push({ url: route.request().url(), method: route.request().method() });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reply()) });
  });
  return hits;
}

/** The POST the app issued went to THIS worker's merge endpoint. Read from the captured request, not
 *  inferred from the rendering — this is what makes "the line came from this row" a measurement. */
function expectMergePost(hits: { url: string; method: string }[], n: number, workerId: string) {
  expect(hits).toHaveLength(n);
  const last = hits[n - 1]!;
  expect(last.method).toBe("POST");
  expect(new URL(last.url).pathname).toBe(`/api/sessions/${workerId}/merge`);
}

/** The green response shape, as the daemon really returns it: `merged:true` with NO `reason` — the
 *  field is set only by the still-running branch (the REST route) and by a refusal. Replying with a
 *  `reason` here would exercise a shape nothing produces, so the success line is deliberately
 *  asserted against a response that carries nothing but the verdict. */
const MERGED_OK = { merged: true, pending: false } as const;

test.describe("one-click merge success is acknowledged (card c2182f9d)", () => {
  // Card 3059ce95: `commitSubject` is named in the success line when the daemon sends one. Unlike
  // `merged` (no per-run sentinel of its own — the real daemon's green response carries no `reason`
  // to put one in), the subject itself embeds this run's short prefix, so a match proves the line
  // came from THIS row's own mutation, not merely "a" success line somewhere on a shared daemon.
  test("switch ON: a subject in the merge response is named; its absence still renders bare `merged`", async ({ page, loomDaemon }) => {
    test.setTimeout(150_000);
    const seeded = await seedPendingReview(loomDaemon);
    const subject = `fix(web): land merge-ok-${seeded.short}`;
    let reply: Record<string, unknown> = { ...MERGED_OK };
    const hits = await interceptMerge(page, () => reply);

    await seedAtlasOn(page);
    await pinProject(page, seeded.projectId);
    await page.goto(loomDaemon.baseURL + "/home");

    const action = page.getByTestId(`atlas-band-merge-${seeded.wkr.sessionId}`);
    await expect(action).toBeVisible();
    const goButton = page.getByTestId(`atlas-band-merge-go-${seeded.wkr.sessionId}`);

    const bareMergedLine = action.getByText("merged", { exact: true });
    const mergedWithSubjectLine = action.getByText(`merged — ${subject}`, { exact: true });

    // ── NO subject on the response ⇒ the bare line, exactly as before this card.
    await expect(bareMergedLine).toHaveCount(0);
    await goButton.click();
    await expect(bareMergedLine).toBeVisible();
    await expect(mergedWithSubjectLine).toHaveCount(0);
    expectMergePost(hits, 1, seeded.wkr.sessionId);

    // ── A subject on the response ⇒ the enriched line, and the bare exact-match line is gone (it is
    //    a DIFFERENT string, not a superset) — re-driven on the SAME mount, so this also proves the
    //    enrichment doesn't leak into a mount that got no subject.
    reply = { merged: true, pending: false, commitSubject: subject };
    await goButton.click();
    await expect(mergedWithSubjectLine).toBeVisible();
    await expect(bareMergedLine).toHaveCount(0);
    expectMergePost(hits, 2, seeded.wkr.sessionId);
  });

  test("switch OFF: the classic Review queue card names a subject the same way", async ({ page, loomDaemon }) => {
    test.setTimeout(150_000);
    const seeded = await seedPendingReview(loomDaemon);
    const subject = `fix(web): land merge-ok-${seeded.short}`;
    let reply: Record<string, unknown> = { ...MERGED_OK };
    const hits = await interceptMerge(page, () => reply);

    await pinProject(page, seeded.projectId);
    await page.goto(loomDaemon.baseURL + "/overview");

    const card = page.locator("main div")
      .filter({ hasText: `w:${seeded.short}` }).filter({ hasText: "Approve & merge" }).last();
    const goButton = card.getByRole("button", { name: "Approve & merge" });
    await expect(goButton).toBeVisible();

    const bareMergedLine = card.getByText("merged", { exact: true });
    const mergedWithSubjectLine = card.getByText(`merged — ${subject}`, { exact: true });

    await expect(bareMergedLine).toHaveCount(0);
    await goButton.click();
    await expect(bareMergedLine).toBeVisible();
    await expect(mergedWithSubjectLine).toHaveCount(0);
    expectMergePost(hits, 1, seeded.wkr.sessionId);

    reply = { merged: true, pending: false, commitSubject: subject };
    await goButton.click();
    await expect(mergedWithSubjectLine).toBeVisible();
    await expect(bareMergedLine).toHaveCount(0);
    expectMergePost(hits, 2, seeded.wkr.sessionId);
  });
  test("switch ON: the Atlas band row confirms a merge, and still reads both other outcomes", async ({ page, loomDaemon }) => {
    // One node load and three merge round-trips is past the 30s default.
    test.setTimeout(150_000);
    const seeded = await seedPendingReview(loomDaemon);
    const rejectedReason = `gate-red-${seeded.short}`;
    const pendingReason = `gate-running-${seeded.short}`;
    let reply: Record<string, unknown> = { ...MERGED_OK };
    const hits = await interceptMerge(page, () => reply);

    await seedAtlasOn(page);
    await pinProject(page, seeded.projectId);
    await page.goto(loomDaemon.baseURL + "/home");

    // ── PRESENCE FIRST. The row is really here, and it is THIS worker's: a bare "the action exists"
    //    on a still-loading page would pass with nothing on screen (card 625d791c).
    const row = page.getByTestId("atlas-band-needs")
      .locator(`[data-testid="attention-row"][data-session-id="${seeded.wkr.sessionId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-kind", "MERGE REQUEST");

    // Scoped to the compact action's own container — `MergeOutcome` renders INSIDE it, so this is
    // the element the shared reader actually writes into on this surface.
    const action = page.getByTestId(`atlas-band-merge-${seeded.wkr.sessionId}`);
    await expect(action).toBeVisible();
    const goButton = page.getByTestId(`atlas-band-merge-go-${seeded.wkr.sessionId}`);

    // `exact` throughout: each outcome is ONE span whose whole text is the line, so an exact match
    // can only be that span — a substring match would also hit every ancestor and trip strict mode.
    // It is also what keeps `merged` off the card's own "diff unavailable (no branch / merged)".
    const mergedLine = action.getByText("merged", { exact: true });
    const rejectedLine = action.getByText(`rejected — ${rejectedReason}`, { exact: true });
    const pendingLine = action.getByText(`still running — ${pendingReason}`, { exact: true });

    // ── BEFORE: no outcome line of any kind, and nothing has been issued.
    await expect(mergedLine).toHaveCount(0);
    await expect(rejectedLine).toHaveCount(0);
    await expect(pendingLine).toHaveCount(0);
    expect(hits).toHaveLength(0);

    // ── AFTER: THE CARD'S SUBJECT. A green verdict is acknowledged in the row itself, instead of the
    //    button silently returning to its own label.
    await goButton.click();
    await expect(mergedLine).toBeVisible();
    await expect(rejectedLine).toHaveCount(0);
    await expect(pendingLine).toHaveCount(0);
    expectMergePost(hits, 1, seeded.wkr.sessionId);

    // ── THE REFUSAL BRANCH, on this same mount — unchanged by the success branch landing above it.
    reply = { merged: false, pending: false, reason: rejectedReason };
    await goButton.click();
    await expect(rejectedLine).toBeVisible();
    await expect(mergedLine).toHaveCount(0);
    expectMergePost(hits, 2, seeded.wkr.sessionId);

    // ── THE STILL-RUNNING BRANCH. `pending` (merged:null) is a RUNNING gate, not a refusal, and is
    //    checked before `!merged` for that reason (card 361520a0 Half Four). It must also not be
    //    swallowed by a green check that read `merged !== false` instead of `merged === true`.
    reply = { merged: null, pending: true, reason: pendingReason };
    await goButton.click();
    await expect(pendingLine).toBeVisible();
    await expect(mergedLine).toHaveCount(0);
    await expect(rejectedLine).toHaveCount(0);
    expectMergePost(hits, 3, seeded.wkr.sessionId);
  });

  test("switch OFF: the classic Review queue card confirms the same merge, and gains no band row", async ({ page, loomDaemon }) => {
    test.setTimeout(150_000);
    const seeded = await seedPendingReview(loomDaemon);
    const rejectedReason = `gate-red-${seeded.short}`;
    const pendingReason = `gate-running-${seeded.short}`;
    let reply: Record<string, unknown> = { ...MERGED_OK };
    const hits = await interceptMerge(page, () => reply);

    // Deliberately NO seedAtlasOn — off is the default, and seeding it off would re-clear the key on
    // every navigation for a reason unrelated to the app (measured on P1-0).
    await pinProject(page, seeded.projectId);
    await page.goto(loomDaemon.baseURL + "/overview");

    // ── PRESENCE: classic renders THIS worker as the rich Review-queue card it always did. The
    //    `w:<short>` label is this worker's own (the seeded id's first 8 chars), so the card the rest
    //    of this leg talks about is unambiguously ours on a shared daemon.
    await expect(page.locator("main").getByText(`w:${seeded.short}`, { exact: true })).toBeVisible();
    // The card is the deepest element holding BOTH this worker's id label and a merge button: inside
    // the Panel, the identity row has the id without the buttons and the action row has the buttons
    // without the id, so nothing smaller satisfies both. Locators come back in DOCUMENT order and an
    // ancestor precedes its descendants, so `.last()` is that deepest match — `.first()` would be
    // `main`, which on a shared daemon could pair my id with a sibling spec's button.
    const card = page.locator("main div")
      .filter({ hasText: `w:${seeded.short}` }).filter({ hasText: "Approve & merge" }).last();
    const goButton = card.getByRole("button", { name: "Approve & merge" });
    await expect(goButton).toBeVisible();

    const mergedLine = card.getByText("merged", { exact: true });
    const rejectedLine = card.getByText(`rejected — ${rejectedReason}`, { exact: true });
    const pendingLine = card.getByText(`still running — ${pendingReason}`, { exact: true });

    // ── BEFORE / AFTER, same shape as the Atlas leg. This is the half that proves the success branch
    //    reached the CLASSIC rendering too, from the one shared reader rather than a second copy.
    await expect(mergedLine).toHaveCount(0);
    expect(hits).toHaveLength(0);
    await goButton.click();
    await expect(mergedLine).toBeVisible();
    await expect(rejectedLine).toHaveCount(0);
    await expect(pendingLine).toHaveCount(0);
    expectMergePost(hits, 1, seeded.wkr.sessionId);

    // ── BOTH OTHER BRANCHES, unchanged here as well — the classic card reads the identical component,
    //    so a mis-ordered insertion would surface on this surface too and is asserted on it.
    reply = { merged: false, pending: false, reason: rejectedReason };
    await goButton.click();
    await expect(rejectedLine).toBeVisible();
    await expect(mergedLine).toHaveCount(0);
    expectMergePost(hits, 2, seeded.wkr.sessionId);

    reply = { merged: null, pending: true, reason: pendingReason };
    await goButton.click();
    await expect(pendingLine).toBeVisible();
    await expect(mergedLine).toHaveCount(0);
    await expect(rejectedLine).toHaveCount(0);
    expectMergePost(hits, 3, seeded.wkr.sessionId);

    // ── THE OFF POLARITY IS STILL STRUCTURAL. The shared success branch reaching the classic card
    //    must not have brought the compact band action — or the band row shape — with it. This is
    //    scoped to what card c2968651 built, not to "no merge button in classic", which has always
    //    been false (that button is the one clicked above).
    await expect(page.getByTestId(`atlas-band-merge-${seeded.wkr.sessionId}`)).toHaveCount(0);
    await expect(page.getByTestId(`atlas-band-merge-go-${seeded.wkr.sessionId}`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="attention-row"][data-session-id="${seeded.wkr.sessionId}"]`)).toHaveCount(0);
  });
});
