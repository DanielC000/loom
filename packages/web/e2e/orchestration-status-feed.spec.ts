// C6 of the WS delta-push umbrella (1efde4ba): the orchestration-STATUS feed moved from two
// `refetchInterval` polls of `GET /api/orchestration/status` (MissionControl @2s, Sidebar @4s) onto the
// app-wide `/ws/fleet` socket that C4 already owns, fed by the `status` broadcast C5 emits on every
// `OrchestrationControl.pause()/resume()`.
//
// WHY THIS SPEC IS SHAPED THE WAY IT IS. The card's own DoD-4 rejects a render-only eyeball as evidence,
// and it is right to: "renders clean, no console errors" cannot tell a LIVE feed from a DEAD one, and the
// specific regression this card must design against — a fallback poll left running while connected —
// leaves every screen looking perfectly correct. So the spec asserts a CONJUNCTION that only a live feed
// can satisfy:
//
//   the paused-state in the UI CHANGES from a real server-side mutation
//   AND zero /api/orchestration/status requests are issued across that change.
//
// Either half alone is worthless. A dead feed can still show the right state (the seed fetched it). A
// zero request count can equally mean "nothing polls" or "my counter is broken" — a zero is what BOTH
// return. Together they are only jointly satisfiable by a socket that actually delivered the mutation.
//
// FALSIFIABILITY. Assertion 2 below is a did-NOT-happen claim gated by a dwell, which is unfalsifiable in
// a single trial: a window that expires before the bad thing happens is indistinguishable from the bad
// thing never happening. Two things make it falsifiable here, and neither is "the dwell feels long
// enough":
//   1. THE CROSS-BUILD POSITIVE CONTROL (DoD-5), run against the PRE-CHANGE bundle. The e2e fixture
//      serves packages/web/dist, so reverting the three source files, rebuilding, and re-running this
//      exact spec is a true known-bad state. It must report a NONZERO dwell count — that, not the dwell
//      duration, is the proof the window is long enough for polling to show up in it.
//   2. THE IN-TEST INSTRUMENT CONTROL: assertion 1 requires the counter to have counted a real request
//      (the cold-load seed) before any zero is believed. A route interceptor that silently failed to
//      attach would fail assertion 1 rather than sail through assertion 2 with a meaningless zero.
//
// Every hard assertion is deferred to the END (following worker-diff-staletime.spec.ts): a run against
// the pre-change bundle then walks the WHOLE scenario and prints the real before-number instead of
// aborting on the first divergence.
//
// d90b30d8 then added assertion 1b. C6 left the COLD LOAD costing two identical requests — the provider's
// connect-time `seedStatus()` plus the consumers' own react-query mount fetch, which did not share a
// cache entry with it. Collapsing the three hand-written query configs onto one `orchStatusQuery` factory
// and seeding THROUGH that shared entry makes those two one (measured here: seed 2 -> 1). That is a
// cold-load saving, NOT a poll — one request per page load, not recurring traffic — and it is pinned
// below so a future consumer that hand-writes its own key silently re-adds it and this spec says so.
import { expect, test } from "./fixtures/daemon";

// The slower of the two `refetchInterval`s this card removed (the other was MissionControl's 2s). The
// dwell is sized off the SLOWER one so a pre-change build has several polls' worth of room to reveal
// itself rather than a marginal one.
//
// The naive arithmetic (9000/2000 + 9000/4000) predicts ~7 requests in this window; the control run
// against the pre-change bundle MEASURED 4. The gap is real and expected: both consumers observe the
// SAME `["orchStatus"]` query, so react-query collapses their overlapping refetches into one request
// instead of issuing one per observer. 4 is the number to compare against, not 7.
const REMOVED_SIDEBAR_POLL_MS = 4_000;
const DWELL_MS = REMOVED_SIDEBAR_POLL_MS * 2 + 1_000; // 9s

// Matches the status endpoint EXACTLY (with or without a query string) rather than by prefix, so a
// hypothetical sibling route could never be silently folded into this count.
const STATUS_ENDPOINT = /\/api\/orchestration\/status(\?|$)/;

/**
 * Drive a real orchestration mutation over REST. Deliberately NOT through MissionControl's own
 * pause/resume buttons: their `onSuccess` invalidates ["orchStatus"], which issues a perfectly
 * legitimate one-shot HTTP refetch and would make the request count un-attributable. Going around the UI
 * leaves the socket as the ONLY route by which the mutation can reach the screen.
 */
async function mutate(baseURL: string, action: "pause" | "resume") {
  const res = await fetch(`${baseURL}/api/orchestration/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.ok, `POST /api/orchestration/${action} should succeed`).toBe(true);
}

test.describe("orchestration status feed over /ws/fleet (C6)", () => {
  test.setTimeout(90_000);

  // The loomDaemon fixture is WORKER-scoped — one daemon for the whole suite — and this spec is the only
  // one that mutates global orchestration state. The happy path resumes inline, but a mid-test failure
  // would otherwise strand the daemon PAUSED and leave every later spec rendering a "paused" rail pill.
  // Unconditional, idempotent (resume() is a Set.delete), and best-effort so it can never mask a real
  // failure with a teardown error.
  test.afterEach(async ({ loomDaemon }) => {
    try {
      await fetch(`${loomDaemon.baseURL}/api/orchestration/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch { /* daemon may already be down during teardown */ }
  });

  test("status updates from a real mutation over the socket, and nothing polls /api/orchestration/status while connected", async ({ page, loomDaemon }) => {
    // THE INSTRUMENT. Counts every status request the app actually issues and passes it through to the
    // real daemon (`fallback`, not `fulfill`) — the seed must genuinely work, since the seed landing is
    // what assertion 1 uses to prove this interceptor is attached and counting.
    let statusRequests = 0;
    await page.route(STATUS_ENDPOINT, async (route) => {
      statusRequests++;
      await route.fallback();
    });

    // MissionControl is the index route ("/" — see nav.tsx), and the Sidebar rail renders on every page,
    // so both consumers of the `["orchStatus"]` cache are mounted on this one screen.
    await page.goto(`${loomDaemon.baseURL}/`);

    const railPill = page.locator(".loom-rail-runpill");
    const mcBadge = page.locator("main").getByText(/^orchestration: (running|paused)$/);

    // COLD LOAD. Both consumers render only once status data exists (the rail pill is `{status.data && …}`
    // gated), so seeing them at all is the witness that the HTTP seed path survived — DoD-3.
    await expect(railPill).toHaveText("running");
    await expect(mcBadge).toHaveText("orchestration: running");
    const atSeed = statusRequests;

    // ── ASSERTION 2's WINDOW: dwell, connected, touching nothing. ────────────────────────────────────
    // No navigation, no interaction, no focus change — anything that remounts a consumer would issue a
    // legitimate mount-time fetch and confound the count. Pre-change, 4 poll requests land in here (measured).
    const dwellStartedAt = performance.now();
    await page.waitForTimeout(DWELL_MS);
    const dwellElapsedMs = performance.now() - dwellStartedAt;
    const afterDwell = statusRequests;

    // ── ASSERTION 3's WINDOW: a REAL mutation, delivered while we keep counting. ─────────────────────
    // (See `mutate` above for why this goes over REST rather than through the page's own button.)
    await mutate(loomDaemon.baseURL, "pause");

    // THE OBSERVABLE STATE CHANGE (DoD-4) — in BOTH consumers, from a mutation this page never issued.
    await expect(railPill).toHaveText("paused");
    await expect(mcBadge).toHaveText("orchestration: paused");
    const afterPause = statusRequests;

    // And back — a second mutation, proving the feed keeps working rather than delivering once.
    await mutate(loomDaemon.baseURL, "resume");
    await expect(railPill).toHaveText("running");
    await expect(mcBadge).toHaveText("orchestration: running");
    const afterResume = statusRequests;

    // ── ASSERTION 4's WINDOW: a RAPID BURST, no settle in between. ───────────────────────────────────
    // C5 broadcasts with NO debounce — one frame per pause()/resume() call, and a call re-emits even when
    // it does not change the scope set (it is a Set add/delete followed by an UNCONDITIONAL notify). So
    // this lands three frames while the UI has no opportunity to settle between them.
    //
    // THIS ASSERTS A DIFFERENT CLAIM FROM THE ONES ABOVE, deliberately. "Three frames arrived" and "the
    // UI settled on the right one" are separate propositions, and only the second one matters: a burst
    // must CONVERGE on the FINAL frame, not strand the UI on an earlier one. Mutations are awaited
    // SEQUENTIALLY (not Promise.all) so the server-side order — and therefore the one correct final
    // state — is deterministic; it is the CLIENT that gets no chance to breathe, which is the point.
    //
    // ⚠️ THE SEQUENCE IS resume→resume→pause AND NOT THE OBVIOUS pause→resume→pause. With a BINARY state,
    // an alternating burst of odd length ends where it began, so `paused` would be the answer whether the
    // client converged on the LAST frame or simply kept the FIRST — the assertion could not tell a
    // correct implementation from a badly broken one. Here the state entering the burst is `running`, the
    // first two frames are also `running`, and ONLY the last frame is `paused`. So `paused` is reachable
    // by exactly one route: the final frame won. Nothing-delivered, first-only, and everything-but-the-
    // last all leave `running` and fail.
    await mutate(loomDaemon.baseURL, "resume");
    await mutate(loomDaemon.baseURL, "resume");
    await mutate(loomDaemon.baseURL, "pause");

    // Converged on the LAST frame — unreachable by keeping any earlier one.
    await expect(railPill).toHaveText("paused");
    await expect(mcBadge).toHaveText("orchestration: paused");
    const afterBurst = statusRequests;

    // Leave the shared daemon as we found it (afterEach is the backstop, not the plan).
    await mutate(loomDaemon.baseURL, "resume");
    await expect(railPill).toHaveText("running");

    const dwellPolls = afterDwell - atSeed;
    const pollsPerMin = (dwellPolls / (dwellElapsedMs / 60_000)).toFixed(1);
    // eslint-disable-next-line no-console
    console.log(
      `[measure] GET /api/orchestration/status — seed=${atSeed} ` +
      `dwell=+${dwellPolls} over ${Math.round(dwellElapsedMs)}ms (${pollsPerMin}/min) ` +
      `pause=+${afterPause - afterDwell} resume=+${afterResume - afterPause} ` +
      `burst=+${afterBurst - afterResume} | total=${statusRequests} ` +
      `(expected: seed=1, dwell/pause/resume/burst all +0; MEASURED pre-C6: seed=1, dwell +4, pause +1, ` +
      `resume +1, burst +1; MEASURED at C6: seed=2, everything else +0)`,
    );

    // 1. INSTRUMENT CONTROL, asserted BEFORE any zero is believed: the interceptor counted a real
    //    request. Without this, a detached route handler would report 0 for every window below and read
    //    exactly like a clean pass.
    expect(atSeed, "the cold-load seed must have been counted — otherwise every zero below is meaningless").toBeGreaterThanOrEqual(1);

    // 1b. THE COLD LOAD COSTS EXACTLY ONE REQUEST (d90b30d8). The socket provider's connect-time seed and
    //     the two mounted consumers all observe ONE query now, so they collapse into a single fetch: the
    //     seed joins the mount fetch that is already in flight, or (if it has just landed) is served from
    //     that same entry inside its staleTime. Two here means a consumer or the seed has drifted back off
    //     the shared `orchStatusQuery` factory. Deliberately an EQUALITY and not a ceiling — paired with
    //     assertion 1 above it brackets the count from both sides, so neither a silent duplicate nor a
    //     dead instrument can pass.
    expect(atSeed, "the cold load must issue exactly ONE /api/orchestration/status request").toBe(1);

    // 2. THE CARD'S CENTRAL CLAIM: nothing polls while the socket is open. This is the assertion the
    //    cross-build positive control must break against the pre-change bundle.
    expect(dwellPolls, `no /api/orchestration/status request may be issued while connected (dwelled ${Math.round(dwellElapsedMs)}ms)`).toBe(0);

    // 3. The state change above arrived over the socket and NOT over HTTP. This is what makes assertion 2
    //    a live-feed result rather than a dead-feed one.
    expect(afterPause - afterDwell, "the pause must reach the UI without an HTTP status request").toBe(0);
    expect(afterResume - afterPause, "the resume must reach the UI without an HTTP status request").toBe(0);

    // 4. An undebounced BURST converges on the final state, still without HTTP. Distinct from 3: that one
    //    says a mutation arrives, this one says three in flight do not leave the UI on the wrong one.
    expect(afterBurst - afterResume, "a rapid undebounced burst must converge without an HTTP status request").toBe(0);
  });
});
