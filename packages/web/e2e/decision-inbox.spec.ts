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
