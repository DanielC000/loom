// Manager→human DECISION INBOX e2e (card 8701bdbb, child B). Exercises the full web flow end-to-end
// against the isolated daemon, with NO real claude:
//   1. A seeded PENDING question surfaces as a "DECISION NEEDED" attention item in Mission Control and
//      badges the shell bell (Alerts N).
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
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title,
      body: "A worker keeps hitting the 5h rate limit mid-wave. Which recovery strategy?",
      options: ["Keep workers warm", "Fail fast — free the slots now", "Freeze the wave"],
      recommendation: "Fail fast — free the slots now",
    });

    // (1) Mission Control: the DECISION NEEDED attention item renders + the bell badges it.
    await page.goto(`${loomDaemon.baseURL}/`);
    const attnRow = page.locator("main").getByText("DECISION NEEDED").first();
    await expect(attnRow).toBeVisible();
    await expect(page.locator("main").getByText(title)).toBeVisible();
    // The shell bell shows a non-zero count (Alerts N). It starts at "Alerts 0" and ticks up on the poll.
    await expect(page.getByRole("button", { name: /Alerts [1-9]/ })).toBeVisible();

    // (2) The global inbox lists it with a project facet.
    await page.goto(`${loomDaemon.baseURL}/inbox`);
    await expect(page.locator("main").getByText(/Waiting on me \([1-9]/)).toBeVisible();
    await expect(page.locator("main").getByText(title)).toBeVisible();
    // The per-project facet chip carries the seeded project's name.
    await expect(page.locator("main").getByRole("button", { name: new RegExp(mgr.projectName) })).toBeVisible();

    // (3) Open the answer page from the inbox row's "Answer →".
    await page.locator("main").getByRole("button", { name: "Answer →" }).first().click();
    await expect(page).toHaveURL(/\/question\//);
    // main-scoped: the same title also appears in the transient attention toast (rendered outside <main>).
    await expect(page.locator("main").getByText(title)).toBeVisible();
    // The recommendation is flagged.
    await expect(page.locator("main").getByText("recommended")).toBeVisible();

    // Pick an option (click its choice panel) and submit.
    await page.locator("main").getByText("Keep workers warm").click();
    const submit = page.getByRole("button", { name: "Submit answer" });
    await expect(submit).toBeEnabled();
    await submit.click();

    // OBSERVABLE state change: the state chip flips to ANSWERED and the recorded-answer readout appears
    // (the pending form unmounts). This is the durable, non-racy witness (vs. the transient success flash).
    await expect(page.locator("main").getByText("ANSWERED", { exact: true })).toBeVisible();
    await expect(page.locator("main").getByText(/waiting on manager pickup/)).toBeVisible();

    // Persistence via GET: reload the answer page — the recorded choice is still there (read back from the daemon).
    await page.reload();
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
});
