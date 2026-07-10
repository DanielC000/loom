// Requests Inbox e2e (card 695ebab0 — the durable Requests object generalized from the decision inbox).
// Exercises the four typed requests (decision · input · permission · credential) end-to-end against the
// isolated daemon with NO real claude, every interactive control driven to an OBSERVABLE before/after state
// change (not just "renders clean"):
//   1. The TYPE FILTER narrows the rows (and "all" resets).
//   2. The response MODAL opens in place over /inbox (not a route push).
//   3. permission — the scope toggle (once → standing) ENABLES the expiry select; Authorize resolves it.
//   4. credential — the secret input is MASKED (type=password) with a working show/hide toggle; the
//      never-echo banner + env-var render; Store securely resolves it (readout never shows a value).
//   5. input — a free-text answer is required before Submit enables.
//   6. History — the search box filters the consumed rows.
//   7. Task drawer — the "Linked requests" section lists a request soft-linked to the card + opens its modal.
//
// Seeding (the no-real-claude invariant): a live manager is a `processState:"live"` DB row via the seed
// endpoint; each request is a seeded row via loomDaemon.seedQuestion (deps.db.insertQuestion — the writer
// question_ask uses). Answers go through the real human-only POST /api/questions/:id/answer route.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}
const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe("requests inbox (card 695ebab0)", () => {
  test("the type filter narrows the rows and 'all' resets", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "ReqMgr" });
    const decTitle = uniq("decision-ask");
    const credTitle = uniq("credential-ask");
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title: decTitle, type: "decision", options: ["A", "B"] });
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title: credTitle, type: "credential", credentialEnvVar: "OPENAI_API_KEY" });

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    const main = page.locator("main");
    // Both rows show under "all".
    await expect(main.getByText(decTitle)).toBeVisible();
    await expect(main.getByText(credTitle)).toBeVisible();

    // Filter to credential → the decision row vanishes, the credential row stays (OBSERVABLE narrowing).
    await main.getByRole("button", { name: /^credential/ }).click();
    await expect(main.getByText(credTitle)).toBeVisible();
    await expect(main.getByText(decTitle)).toHaveCount(0);

    // "all" resets → the decision row is back.
    await main.getByRole("button", { name: /^all\b/ }).first().click();
    await expect(main.getByText(decTitle)).toBeVisible();
  });

  test("a permission request opens as a modal; the scope toggle enables the expiry select; Authorize resolves it", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "PermMgr" });
    const title = uniq("permission-ask");
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "permission",
      body: "May I force-push to origin/main to land the release?",
      permissionAction: "git push --force origin main", permissionScope: "once",
    });

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    // "Review →" opens the modal in place — the URL stays /inbox.
    await page.locator("main").getByRole("button", { name: "Review →" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(dialog.getByText("git push --force origin main")).toBeVisible();

    // The expiry select starts DISABLED (scope defaults to "once")…
    const expiry = dialog.getByRole("combobox");
    await expect(expiry).toBeDisabled();
    // …clicking the "standing" scope card ENABLES it (OBSERVABLE toggle).
    await dialog.getByText("standing", { exact: true }).click();
    await expect(expiry).toBeEnabled();

    // Authorize resolves the request — the readout flips to the answered/authorized state.
    await dialog.getByRole("button", { name: "Authorize" }).click();
    await expect(dialog.getByText("ANSWERED", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/authorized/)).toBeVisible();
  });

  test("a permission request can be denied — the recorded outcome reads 'denied'", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "DenyMgr" });
    const title = uniq("permission-deny");
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "permission",
      body: "May I delete the stale feature branch?",
      permissionAction: "git branch -D old-feature", permissionScope: "once",
    });

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    await page.locator("main").getByRole("button", { name: "Review →" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Deny resolves the request — the readout flips to answered/denied (mirrors the Authorize spec above).
    await dialog.getByRole("button", { name: "Deny" }).click();
    await expect(dialog.getByText("ANSWERED", { exact: true })).toBeVisible();
    await expect(dialog.getByText("denied", { exact: true })).toBeVisible();
  });

  test("a standing-scope permission request starts with the expiry select already enabled; Authorize folds scope+expiry into the recorded note", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "StandingMgr" });
    const title = uniq("permission-standing");
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "permission",
      body: "May I keep auto-merging green dependency bumps?",
      permissionAction: "gh pr merge --auto", permissionScope: "standing",
    });

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    await page.locator("main").getByRole("button", { name: "Review →" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Seeded permissionScope:"standing" ⇒ the expiry select starts ENABLED with no click needed — the
    // mirror image of the "once"-seeded Authorize spec above, which starts disabled.
    const expiry = dialog.getByRole("combobox");
    await expect(expiry).toBeEnabled();
    await expiry.selectOption("30d");

    await dialog.getByRole("button", { name: "Authorize" }).click();
    await expect(dialog.getByText("ANSWERED", { exact: true })).toBeVisible();
    // The human's scope/expiry choice is folded into the recorded note (composeNote), never silently
    // dropped — the answer route only carries {decision, note}.
    await expect(dialog.getByText("authorized · scope: standing until 30d", { exact: true })).toBeVisible();
  });

  test("a credential request is masked with a working show/hide toggle and never echoes the value back", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "CredMgr" });
    const title = uniq("credential-ask");
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "credential",
      body: "I need an API key to call the model provider.", credentialEnvVar: "ANTHROPIC_API_KEY",
    });

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    await page.locator("main").getByRole("button", { name: "Provide →" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The never-echo banner + the target env var render.
    await expect(dialog.getByText(/never echoed back/i)).toBeVisible();
    await expect(dialog.getByText("ANTHROPIC_API_KEY")).toBeVisible();

    // The secret input is MASKED by default; typing then "Show" reveals it (OBSERVABLE type flip).
    await expect(dialog.locator('input[type="password"]')).toBeVisible();
    await dialog.locator("input").first().fill("sk-secret-value-123");
    await dialog.getByRole("button", { name: "Show" }).click();
    await expect(dialog.locator('input[type="text"]')).toBeVisible();
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);

    // Store securely resolves it; the readout says provided/encrypted and NEVER shows the value.
    await dialog.getByRole("button", { name: "Store securely" }).click();
    await expect(dialog.getByText(/provided · encrypted, not shown/)).toBeVisible();
    await expect(dialog.getByText("sk-secret-value-123")).toHaveCount(0);
  });

  test("an input request requires a free-text answer before Submit enables", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "InputMgr" });
    const title = uniq("input-ask");
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "input",
      body: "What display name should I use for the new agent?",
    });

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    await page.locator("main").getByRole("button", { name: "Answer →" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const submit = dialog.getByRole("button", { name: "Submit answer" });
    await expect(submit).toBeDisabled();
    await dialog.getByPlaceholder(/type your answer/).fill("Call it Atlas.");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(dialog.getByText("ANSWERED", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/Call it Atlas\./)).toBeVisible();
  });

  test("the history tab lists consumed requests and the search box filters them", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "HistMgr" });
    const keep = uniq("rollback-plan");
    const other = uniq("cache-strategy");
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title: keep, type: "decision", options: ["X"], state: "consumed", chosenOption: "X" });
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title: other, type: "input", state: "consumed", note: "used a CDN" });

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    await page.locator("main").getByRole("button", { name: "History" }).click();
    const main = page.locator("main");
    await expect(main.getByText(keep)).toBeVisible();
    await expect(main.getByText(other)).toBeVisible();

    // Searching narrows to the matching row (OBSERVABLE filter): the other row vanishes.
    await main.getByPlaceholder(/search titles/).fill("rollback-plan");
    await expect(main.getByText(keep)).toBeVisible();
    await expect(main.getByText(other)).toHaveCount(0);
  });

  test("the task drawer lists a soft-linked request and opens its detail modal", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`req-drawer-${Date.now()}`);
    await pinActiveProject(page, project.id);
    const cardTitle = uniq("linked-card");
    const task = await loomDaemon.createTask(project.id, { title: cardTitle, columnKey: "inbox" });
    const mgr = await loomDaemon.seedLiveSession({ project, role: "manager", agentName: "LinkMgr" });
    const reqTitle = uniq("decision-for-card");
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: project.id, title: reqTitle, type: "decision",
      options: ["Ship", "Hold"], taskId: task.id,
    });

    await page.goto(`${loomDaemon.baseURL}/board`);
    // Open the card's drawer.
    await page.locator("main").getByText(cardTitle, { exact: true }).click();
    // The "Linked requests" section lists the request soft-linked to this card. Exact match: the same title
    // also appears (as a substring) in the global attention toast rendered outside the drawer.
    await expect(page.getByText(/Linked requests \(1\)/)).toBeVisible();
    await expect(page.getByText(reqTitle, { exact: true })).toBeVisible();

    // "view ↗" opens the SAME Request detail modal in place.
    await page.getByRole("button", { name: "view ↗" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(reqTitle, { exact: true })).toBeVisible();
    // The reverse link renders: the request header shows the linked-task chip.
    await expect(dialog.getByText(new RegExp(`task #${task.id.slice(0, 8)}`))).toBeVisible();
  });

  test("a request's linked-task chip deep-links to the board and opens that card's drawer, clearing ?task= from the URL", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`req-tasklink-${Date.now()}`);
    const cardTitle = uniq("deep-link-card");
    const task = await loomDaemon.createTask(project.id, { title: cardTitle, columnKey: "todo" });
    const mgr = await loomDaemon.seedLiveSession({ project, role: "manager", agentName: "DeepLinkMgr" });
    const reqTitle = uniq("decision-deep-link");
    const qId = await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: project.id, title: reqTitle, type: "decision",
      options: ["Ship", "Hold"], taskId: task.id,
    });

    // The standalone deep-link page (/question/:id) renders the same detail as the modal.
    await page.goto(`${loomDaemon.baseURL}/question/${qId}`);
    await expect(page.getByText(reqTitle, { exact: true })).toBeVisible();

    // The header's linked-task chip is clickable; click it (OBSERVABLE navigation, not inert metadata).
    const chip = page.getByRole("button", { name: new RegExp(`^task #${task.id.slice(0, 8)}`) });
    await expect(chip).toBeVisible();
    await chip.click();

    // Board opens scoped to the request's project with the RIGHT card's drawer already open, and the
    // ?task= param is consumed + cleared — no lingering query string on the URL.
    await expect(page).toHaveURL(/\/board$/);
    await expect(page.getByText(`Task · ${task.id.slice(0, 8)}`)).toBeVisible();
  });

  test("a dangling (deleted) linked taskId never crashes the request row, its detail, or the board it deep-links to", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "DanglingMgr" });
    const reqTitle = uniq("decision-dangling");
    const bogusTaskId = "no-such-task-deadbeef01"; // soft link — no card was ever created with this id
    const qId = await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title: reqTitle, type: "decision",
      options: ["A", "B"], taskId: bogusTaskId,
    });

    // The inbox row renders fine — the dangling chip is inert metadata there, no crash.
    await page.goto(`${loomDaemon.baseURL}/inbox`);
    const main = page.locator("main");
    await expect(main.getByText(reqTitle, { exact: true })).toBeVisible();
    await expect(main.getByText(`task #${bogusTaskId.slice(0, 8)}`, { exact: true })).toBeVisible();

    // The detail page also renders fine, with a CLICKABLE chip — the title never resolves for a bogus id
    // (the soft-link task lookup simply finds nothing), but the chip itself is never blocked from rendering.
    await page.goto(`${loomDaemon.baseURL}/question/${qId}`);
    await expect(page.getByText(reqTitle, { exact: true })).toBeVisible();
    const chip = page.getByRole("button", { name: new RegExp(`^task #${bogusTaskId.slice(0, 8)}`) });
    await expect(chip).toBeVisible();

    // Clicking still navigates to the board — the dangling id just never resolves against any real card:
    // no drawer opens, nothing throws, and the ?task= param is still consumed/cleared either way.
    await chip.click();
    await expect(page).toHaveURL(/\/board$/);
    await expect(page.getByText(/^Task · /)).toHaveCount(0);
  });
});
