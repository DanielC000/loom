// Manager→human DECISION INBOX e2e (card 8701bdbb, child B). Exercises the full web flow end-to-end
// against the isolated daemon, with NO real claude:
//   1. A seeded PENDING question surfaces as a "DECISION NEEDED" attention item in Mission Control and
//      badges the Requests nav item (its pending-requests count). (The footer Alerts badge deliberately
//      counts only NON-request heuristic/session attention, so a pending request does NOT badge it — see
//      the nav-cleanup pass; nav-cleanup.spec.ts covers that de-duplication directly.)
//   2. The global /inbox lists it cross-project with a working per-project facet.
//   3. The /question/:id answer page renders the ask + options; picking an option + Submit answer
//      flips the question pending→answered — the OBSERVABLE change: the attention item clears, and the
//      recorded answer persists (visible on a reload of the answer page).
//   4. The pure-blocker (no-options) variant requires a note before Submit is enabled.
//
// Seeding (the no-real-claude invariant): a live manager session is a `processState:"live"` DB row via
// POST /internal/test/seed (never startSession → no `[pty] spawn`), and each question is a seeded row via
// loomDaemon.seedQuestion (deps.db.insertQuestion — the same writer question_ask uses). The ANSWER goes
// through the real human-only POST /api/questions/:id/answer route (the sole chosenOption/note writer).
import { expect, test } from "./fixtures/daemon";

test.describe("decision inbox (card 8701bdbb, child B)", () => {
  test("a pending decision surfaces as an attention item, badges the bell, and answering it clears the item + persists", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "DecMgr" });
    const title = `Rate-limit strategy ${Date.now()}`;
    const id = await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title,
      body: "A worker keeps hitting the 5h rate limit mid-wave. Which recovery strategy?",
      options: ["Keep workers warm", "Fail fast — free the slots now", "Freeze the wave"],
      recommendation: "Fail fast — free the slots now",
    });

    // (1) Mission Control: the DECISION NEEDED attention item renders + the Requests nav item badges it.
    await page.goto(`${loomDaemon.baseURL}/`);
    const attnRow = page.locator("main").getByText("DECISION NEEDED").first();
    await expect(attnRow).toBeVisible();
    await expect(page.locator("main").getByText(title)).toBeVisible();
    // The Requests rail item shows a non-zero pending-requests count — a pending decision IS a request.
    // (The footer Alerts badge is NOT expected to tick here: it counts only non-request attention now.)
    await expect(page.locator(".loom-rail-item", { hasText: "Requests" }).locator(".loom-rail-badge"))
      .toHaveText(/[1-9]/, { timeout: 10_000 });

    // (2) The global inbox lists it with a project facet.
    await page.goto(`${loomDaemon.baseURL}/inbox`);
    await expect(page.locator("main").getByText(/Waiting on me \([1-9]/)).toBeVisible();
    await expect(page.locator("main").getByText(title)).toBeVisible();
    // The per-project facet chip carries the seeded project's name.
    await expect(page.locator("main").getByRole("button", { name: new RegExp(mgr.projectName) })).toBeVisible();

    // (3) The inbox row's "Answer →" opens the detail as a MODAL in place (NOT a route push) — the owner
    // picked "answer without leaving the page you're on". The URL stays /inbox; a dialog appears.
    await page.locator("main").getByRole("button", { name: "Answer →" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(dialog.getByText(title)).toBeVisible();
    // The recommendation is flagged inside the modal.
    await expect(dialog.getByText("recommended")).toBeVisible();

    // Pick an option (click its choice panel) and submit — inside the modal.
    await dialog.getByText("Keep workers warm").click();
    const submit = dialog.getByRole("button", { name: "Submit answer" });
    await expect(submit).toBeEnabled();
    await submit.click();

    // OBSERVABLE state change: the state chip flips to ANSWERED and the recorded-answer readout appears
    // (the pending form unmounts). This is the durable, non-racy witness (vs. the transient success flash).
    await expect(dialog.getByText("ANSWERED", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/waiting on manager pickup/)).toBeVisible();

    // Persistence via GET on the deep-link route: the SAME content renders at /question/:id, and the
    // recorded choice is read back from the daemon (proves the answer durably persisted).
    await page.goto(`${loomDaemon.baseURL}/question/${id}`);
    await expect(page.locator("main").getByText("Keep workers warm")).toBeVisible();
    await expect(page.locator("main").getByText(/Answered/)).toBeVisible();

    // The attention item CLEARS: back on Mission Control, the answered decision no longer surfaces.
    await page.goto(`${loomDaemon.baseURL}/`);
    await expect(page.locator("main").getByText(title)).toHaveCount(0);
  });

  test("the pure-blocker variant (no options) requires a note before Submit is enabled", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "BlockMgr" });
    const title = `Protected main blocks the push ${Date.now()}`;
    const id = await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title,
      body: "The repo's main is branch-protected — I can't push. How do you want me to proceed?",
      options: null, // pure blocker → note-only
    });

    await page.goto(`${loomDaemon.baseURL}/question/${id}`);
    // main-scoped: the title also appears in the transient attention toast (rendered outside <main>).
    await expect(page.locator("main").getByText(title)).toBeVisible();
    await expect(page.locator("main").getByText("note only")).toBeVisible();

    // Submit is disabled until a non-empty note is typed (mirrors the route's 400).
    const submit = page.getByRole("button", { name: "Submit answer" });
    await expect(submit).toBeDisabled();
    await page.getByPlaceholder(/your decision/).fill("Open a PR from the release branch and I'll approve it.");
    await expect(submit).toBeEnabled();
    await submit.click();
    // OBSERVABLE change: the pending form unmounts and the answered readout (with the note) persists.
    await expect(page.locator("main").getByText("ANSWERED", { exact: true })).toBeVisible();
    await expect(page.locator("main").getByText(/Open a PR from the release branch/)).toBeVisible();
  });

  test("an options question can be answered by free-text note alone, with no option picked (owner request, card f4bb2f6f)", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "NoteOnlyMgr" });
    const title = `None of these fit ${Date.now()}`;
    const id = await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title,
      body: "Which of these rollout plans?",
      options: ["Ship all at once", "Phase by cohort", "Dark-launch behind a flag"],
    });

    await page.goto(`${loomDaemon.baseURL}/question/${id}`);
    await expect(page.locator("main").getByText(title)).toBeVisible();

    // Selecting an option is OPTIONAL: with NO pick, typing a note alone enables Submit.
    const submit = page.getByRole("button", { name: "Submit answer" });
    await expect(submit).toBeDisabled();
    await page.getByPlaceholder(/add context for the manager/).fill("None of these — hold off and let's talk first.");
    await expect(submit).toBeEnabled();
    await submit.click();

    // OBSERVABLE change: the pending form unmounts; the answered readout shows the note but NO chosen option.
    await expect(page.locator("main").getByText("ANSWERED", { exact: true })).toBeVisible();
    await expect(page.locator("main").getByText(/None of these — hold off/)).toBeVisible();
    await expect(page.locator("main").getByText(/Chose:/)).toHaveCount(0);
  });
});

// ── DECISION STALE + the owner snooze (card 889ae619) ──────────────────────────────────────────────
// A pending Request that has already crossed staleRequestMinutes (escalatedAt set — seeded directly,
// since the real IdleWatcher tick a spec can't wait out) surfaces as a RED "DECISION STALE" attention
// item, distinct from the ordinary cyan "DECISION NEEDED" row. It carries a "Snooze…" affordance the
// plain row does not. Picking a duration is a DURABLE, non-terminal SNOOZE: the request stays pending
// and fully answerable — it is NOT dismissed, cancelled, or auto-answered — only the STALE presentation
// drops back to ordinary cyan (and, per the design, would re-redden on its own once the snooze expires,
// which this e2e — bounded to real wall-clock time — does not wait out).
test.describe("decision STALE + owner snooze (card 889ae619)", () => {
  test("an escalated pending request shows DECISION STALE with a Snooze control; snoozing drops it to ordinary DECISION NEEDED without answering it", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "StaleMgr" });
    const title = `Escalated ask ${Date.now()}`;
    const id = await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title,
      body: "This has been sitting unanswered a while.",
      options: ["Proceed", "Hold"],
      // Already stale as of seed time — the real escalation path is a staleRequestMinutes-gated tick.
      escalatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    await page.goto(`${loomDaemon.baseURL}/`);
    const main = page.locator("main");
    // `.last()`, not `.first()`: Mission Control ALSO renders a per-manager "waiting on you" mini-card
    // with its OWN "Answer →" button elsewhere on the page, and `title` is nested several ancestor divs
    // deep — `.first()` resolves to an outer wrapping div broad enough to also contain that unrelated
    // button (a strict-mode violation once two matching "Answer →" buttons are in scope). Since ancestor
    // divs precede their own descendants in DOM order, the LAST div still matching `hasText: title` is
    // the innermost one — the AttentionRow's own container, and nothing broader.
    const row = main.locator("div").filter({ hasText: title }).last();
    await expect(row).toBeVisible();
    await expect(row.getByText("DECISION STALE")).toBeVisible();
    await expect(row.getByText("DECISION NEEDED")).toHaveCount(0);

    // The Snooze select is present ONLY on the stale row — pick "1 day" (an OBSERVABLE onChange action,
    // not a submit-button flow: the select fires the mutation directly).
    const snoozeSelect = row.locator("select");
    await expect(snoozeSelect).toBeVisible();
    await snoozeSelect.selectOption("1d");

    // OBSERVABLE change: the row drops from red STALE to ordinary cyan NEEDED, and the Snooze control
    // itself disappears (nothing left to suppress) — while the request is STILL pending and answerable.
    await expect(row.getByText("DECISION NEEDED")).toBeVisible();
    await expect(row.getByText("DECISION STALE")).toHaveCount(0);
    await expect(row.locator("select")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Answer →" })).toBeVisible();

    // Durable + non-destructive: a fresh read of the SAME question confirms it is still pending, still
    // carries its original escalatedAt (a snooze is not a retirement — nothing about the escalation
    // itself was cleared), and now carries a future acknowledgedUntil.
    const res = await page.request.get(`${loomDaemon.baseURL}/api/questions/${id}`);
    const q = await res.json();
    expect(q.state).toBe("pending");
    expect(q.chosenOption).toBeNull();
    expect(q.escalatedAt).not.toBeNull();
    expect(q.acknowledgedUntil).not.toBeNull();
    expect(Date.parse(q.acknowledgedUntil)).toBeGreaterThan(Date.now());
  });

  test("a non-stale pending request never shows a Snooze control", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "NonStaleMgr" });
    const title = `Fresh ask ${Date.now()}`;
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title,
      options: ["A", "B"],
    });

    await page.goto(`${loomDaemon.baseURL}/`);
    const row = page.locator("main").locator("div").filter({ hasText: title }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText("DECISION NEEDED")).toBeVisible();
    await expect(row.locator("select")).toHaveCount(0);
  });
});
