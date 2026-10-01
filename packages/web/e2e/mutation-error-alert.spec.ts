// One alert per failed mutation (card ad42a127). main.tsx installs a global MutationCache `onError` that
// window.alert()s every failure; 27 mutations ALSO passed `onError: alertUnlessCredentialGuard`, which
// alerts too. TanStack v5 runs the cache handler AND the per-mutation one, so those 27 showed the user two
// identical modals for one failure. A second population rendered its error inline without
// `meta.inlineError`, so the user got an inline message AND a modal over it.
//
// This spec pins BOTH polarities by COUNTING `page.on("dialog")` events — the one thing a DOM assertion
// can never see, because Playwright auto-dismisses dialogs (see the [[green-suite-can-hide-what-a-human-sees]]
// project memory: that auto-dismissal is exactly how the original defect shipped past a green suite).
// Every dialog is explicitly accepted so a blocking modal can never wedge the page mid-test.
//
//   1. A cache-owned mutation (the Requests answer path, formerly double-alerting) fails → EXACTLY 1 dialog.
//   2. An inline-error form (the Schedules builder, `meta.inlineError`) fails → the message renders inline
//      and there are ZERO dialogs.
//
// Case 1's failure is the card's own named repro and is produced by the REAL daemon, not a stub: the modal
// is opened while the request is pending, the request is then answered out-of-band over REST, and Submit
// then hits the route's genuine `question is already answered, not pending` 400. Case 2 forces its failure
// with `page.route` because no equivalent natural 500 exists on the create path — the client-side handler
// chain under test is identical either way.
import { expect, test, type Page } from "./fixtures/daemon";

/**
 * Collect every native dialog the page raises, accepting each one. Returns the live array — read it AFTER
 * awaiting an observable settle, never immediately after the click (the handler fires asynchronously).
 */
function collectDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on("dialog", (d) => {
    seen.push(d.message());
    void d.accept();
  });
  return seen;
}

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

test.describe("one alert per failed mutation (card ad42a127)", () => {
  test("a cache-owned mutation that fails shows EXACTLY ONE dialog", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "AlertMgr" });
    const title = `answer-race-${Date.now()}`;
    const questionId = await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "decision", options: ["A", "B"],
    });

    const dialogs = collectDialogs(page);
    await page.goto(`${loomDaemon.baseURL}/inbox`);
    const main = page.locator("main");
    // Earlier specs share this worker's daemon, so /inbox carries their pending rows too. Narrow by the
    // seeded project FIRST: a bare `.first()` would be satisfied by somebody else's request — the exact
    // "a page-wide assertion matched the wrong element" trap this suite has been bitten by before.
    await main.getByRole("button", { name: new RegExp(`^${mgr.projectName}\\b`) }).click();
    await expect(main.getByText(title)).toHaveCount(1);

    await main.getByRole("button", { name: "Answer →" }).click();
    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();
    await expect(modal.getByText(title)).toBeVisible();

    // Answer it OUT OF BAND, behind the open modal's back: the page still holds the stale `pending` view,
    // so its own Submit will hit the real 400. This is the card's named repro (an already-answered Request).
    const outOfBand = await fetch(`${loomDaemon.baseURL}/api/questions/${questionId}/answer`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chosenOption: "A" }),
    });
    expect(outOfBand.ok, "the out-of-band answer must land, or the Submit below would succeed").toBe(true);

    await modal.getByText("A", { exact: true }).click();
    await modal.getByRole("button", { name: /submit/i }).click();

    // Wait on the ALERT ITSELF, not a fixed timeout: a timer that expires before the second modal would
    // have appeared is indistinguishable from there never being one, so a bare wait could pass for the
    // wrong reason every run. Poll until at least one arrives, THEN assert the total is exactly one.
    await expect.poll(() => dialogs.length, { message: "the failure must surface to the user at all" })
      .toBeGreaterThan(0);
    // Give any SECOND alerter a real chance to fire before counting — the two handlers run back to back in
    // the same rejection, so by the time the first dialog is accepted a second would already be queued.
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0], "the surviving alert is the global handler's, prefixed by it").toContain("Action failed:");
    expect(dialogs[0], "and it carries the daemon's real reason").toContain("already answered");
  });

  test("an inline-error form shows its error inline and raises NO dialog", async ({ page, loomDaemon }) => {
    const stamp = Date.now();
    const project = await loomDaemon.createProject(`alert-inline-${stamp}`);
    const agentRes = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/agents`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `Orchestrator ${stamp}` }),
    });
    expect(agentRes.ok).toBe(true);
    await pinActiveProject(page, project.id);

    // The create path has no natural 500, so force one. Scoped to the POST only — the page's own GETs must
    // keep working, or the form would fail to render for an unrelated reason.
    await page.route("**/api/schedules", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "forced failure (card ad42a127)" }) });
    });

    const dialogs = collectDialogs(page);
    await page.goto(`${loomDaemon.baseURL}/automation`);
    await page.getByRole("button", { name: /new schedule/i }).click();
    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();

    await modal.getByPlaceholder(/nightly pr sweep/i).fill(`Forced failure ${stamp}`);
    await modal.locator("select").filter({ hasText: "select an agent" }).selectOption({ index: 1 });
    await modal.getByRole("button", { name: "Daily", exact: true }).click();

    const create = modal.getByRole("button", { name: /create schedule/i });
    await expect(create).toBeEnabled();
    await create.click();

    // The inline message appears...
    await expect(modal.getByText(/forced failure \(card ad42a127\)|daemon rejected the request/i)).toBeVisible();
    // ...and the modal stays open rather than closing over a silent failure.
    await expect(modal).toBeVisible();
    // ...with no blocking dialog on top of it. Asserted AFTER an observable settle, so this is a real
    // absence rather than a race that simply hadn't fired yet.
    expect(dialogs, "an inline-error form must not ALSO alert").toEqual([]);
  });
});
