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
//   7. Task drawer — the "Connected requests" rail lists a request soft-linked to the card + opens its modal.
//
// Seeding (the no-real-claude invariant): a live manager is a `processState:"live"` DB row via the seed
// endpoint; each request is a seeded row via loomDaemon.seedQuestion (deps.db.insertQuestion — the writer
// question_ask uses). Answers go through the real human-only POST /api/questions/:id/answer route.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import path from "node:path";

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
      permissionAction: "git push --force origin main", permissionScopeHint: "once",
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
      permissionAction: "git branch -D old-feature", permissionScopeHint: "once",
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

  test("a standing-scope permission request starts with the expiry select already enabled; Authorize sends scope+expiry structurally, not folded into the note", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "StandingMgr" });
    const title = uniq("permission-standing");
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "permission",
      body: "May I keep auto-merging green dependency bumps?",
      permissionAction: "gh pr merge --auto", permissionScopeHint: "standing",
    });

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    await page.locator("main").getByRole("button", { name: "Review →" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Seeded permissionScopeHint:"standing" ⇒ the expiry select starts ENABLED with no click needed — the
    // mirror image of the "once"-seeded Authorize spec above, which starts disabled.
    const expiry = dialog.getByRole("combobox");
    await expect(expiry).toBeEnabled();
    await expiry.selectOption("30d");

    // fix(mcp): persist and surface permission-request scope/expiry (card 75b3bde0) — the human's
    // scope/expiry choice now goes to the answer route as STRUCTURED fields (`scope`/`expiresAt`), never
    // folded into free-text `note`. Capture the actual POST body to prove that directly, rather than
    // inferring it from the readout.
    const answerReq = page.waitForRequest((req) => req.url().includes("/answer") && req.method() === "POST");
    await dialog.getByRole("button", { name: "Authorize" }).click();
    const body = (await answerReq).postDataJSON() as { decision: string; scope?: string; expiresAt?: string; note?: string };
    expect(body.decision).toBe("authorize");
    expect(body.scope).toBe("standing");
    expect(body.expiresAt).toBeTruthy();
    expect(Date.parse(body.expiresAt!)).toBeGreaterThan(Date.now());
    expect(body.note).toBeUndefined();

    await expect(dialog.getByText("ANSWERED", { exact: true })).toBeVisible();
    // The note was left blank, so the recorded readout falls back to the no-note phrasing — the
    // scope/expiry the human picked is persisted structurally (proven above), not shown here.
    await expect(dialog.getByText("authorized · this action", { exact: true })).toBeVisible();
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

  test("Dismiss cancels a pending request — it leaves the inbox and lands in history as cancelled", async ({ page, loomDaemon }) => {
    // card feat(orchestration): question_cancel + dismiss — the human-side exit for a moot/superseded
    // pending Request. Drives the REAL POST /api/questions/:id/dismiss route (via the UI button, not a
    // direct API call), then proves the OBSERVABLE before/after: the row leaves the pending inbox and
    // reappears in History as CANCELLED, never confused with an answered/consumed row.
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "DismissMgr" });
    const title = uniq("dismiss-me");
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "decision", options: ["A", "B"] });

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    const main = page.locator("main");
    await expect(main.getByText(title, { exact: true })).toBeVisible();

    // Dismiss is a CONFIRMED action (window.confirm, mirrors Archive.tsx's Delete) — first prove the gate
    // is REAL by declining it: the row must survive a cancelled confirm, not just a click.
    const row = main.locator("div").filter({ hasText: title }).first();
    await expect(row.getByRole("button", { name: "Answer →" })).toBeVisible();
    page.once("dialog", (dialog) => dialog.dismiss());
    await row.getByRole("button", { name: "Dismiss" }).click();
    await expect(main.getByText(title, { exact: true })).toBeVisible();

    // Now accept the confirm — BEFORE: the row is there with its primary action button.
    page.once("dialog", (dialog) => dialog.accept());
    await row.getByRole("button", { name: "Dismiss" }).click();

    // AFTER: the row leaves the default "waiting on me" inbox entirely (not just re-labeled in place).
    await expect(main.getByText(title, { exact: true })).toHaveCount(0);

    // History retains it, correctly labeled CANCELLED (not "answered"/"consumed").
    await page.locator("main").getByRole("button", { name: "History" }).click();
    await expect(main.getByText(title, { exact: true })).toBeVisible();
    const historyRow = main.locator("button").filter({ hasText: title }).first();
    await expect(historyRow).toContainText("cancelled");

    // Opening it shows the dedicated cancelled readout — never the "Answered …" section label.
    await historyRow.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("CANCELLED", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Cancelled · never answered")).toBeVisible();
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
    // The "Connected requests" rail (Dossier right rail, card 8c1f27f0) lists the request soft-linked to
    // this card and its count. Exact match on the title: the same title also appears (as a substring) in
    // the global attention toast rendered outside the drawer.
    const rail = page.getByTestId("task-requests-rail");
    const railHeader = rail.locator("div").first();
    await expect(railHeader).toContainText("Connected requests");
    await expect(railHeader).toContainText("1");
    await expect(page.getByText(reqTitle, { exact: true })).toBeVisible();

    // Expand the row, then "Open request ↗" opens the SAME Request detail modal in place.
    await rail.getByText(reqTitle, { exact: true }).click();
    await rail.getByRole("button", { name: "Open request ↗" }).click();
    // Two dialogs now stack (the task drawer underneath, the request modal above it per Board.tsx's
    // zIndex ordering) — the request modal is the one that opened last.
    const dialog = page.getByRole("dialog").last();
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

  test("the linked-task chip shows the card's CURRENT lane (card 889ae619, iii-b), and follows it when the card moves", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`req-lane-${Date.now()}`);
    const cardTitle = uniq("lane-card");
    const task = await loomDaemon.createTask(project.id, { title: cardTitle, columnKey: "in_progress" });
    const mgr = await loomDaemon.seedLiveSession({ project, role: "manager", agentName: "LaneMgr" });
    const reqTitle = uniq("decision-for-lane-card");
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: project.id, title: reqTitle, type: "decision",
      options: ["Ship", "Hold"], taskId: task.id,
    });

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    const main = page.locator("main");
    await expect(main.getByText(reqTitle, { exact: true })).toBeVisible();
    // The chip carries "task #xxxx · <lane>" — the raw board-column slug, joined server-side.
    await expect(main.getByText(new RegExp(`task #${task.id.slice(0, 8)} · in_progress`))).toBeVisible();

    // The card moves lanes — a REAL POST through the board's own writer, not a re-seed — and the SAME
    // chip (no reload) reflects the new lane on its next poll (openQuestions refetches every 3s).
    // `page.request` is Playwright's OWN network stack, independent of the page's window.fetch (which the
    // loopback token seeded into localStorage authenticates) — the loopback human-only-write guard (card
    // 9ccedbee) would otherwise 401 this write, so the credential is attached explicitly here.
    const patchRes = await page.request.post(`${loomDaemon.baseURL}/api/tasks/${task.id}`, {
      headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` },
      data: { columnKey: "done" },
    });
    expect(patchRes.status()).toBe(200);
    await expect(main.getByText(new RegExp(`task #${task.id.slice(0, 8)} · done`))).toBeVisible({ timeout: 10_000 });
  });
});

// ── Provenance vs routing (card 5b22b262) ──────────────────────────────────────────────────────────
// A Request carries TWO session ids meaning DIFFERENT things: `filedBySessionId` is the IMMUTABLE seat
// that FILED the ask; `sessionId` is the MUTABLE seat it is currently ROUTED to (`reparentQuestions`
// rewrites it onto a successor on EVERY recycle). The inbox used to render the routing id as the asker,
// so after any recycle it attributed the ask to a seat that never made it — on the screen the human
// answers from. Owner's decision (Request 68b06c50): show BOTH, visibly distinguished.
//
// The seed forces a genuine DIVERGENCE (filer ≠ routing target) rather than hoping one occurs: a real
// divergence only appears after a recycle, which an e2e can't drive without spawning a real claude.
// A third test pins the SPLIT — the ACTION caption must keep naming the ROUTING target, so a blanket
// sessionId → filedBySessionId swap (the tempting "fix") fails here instead of shipping as a regression.
test.describe("request provenance vs routing (card 5b22b262)", () => {
  const short = (id: string) => id.slice(0, 8);
  // Opt-in screenshot capture (LOOM_E2E_SHOTS, same hook board.spec.ts and the requests rail already use):
  // unset in CI, so a no-op there. This is a VISUAL change on the surface the owner answers from, so point
  // it at a directory to persist the rendered diverged / legacy / action-caption states for review.
  const shotDir = process.env.LOOM_E2E_SHOTS;
  const shoot = async (page: import("@playwright/test").Page, name: string) => {
    if (shotDir) await page.screenshot({ path: path.join(shotDir, name), fullPage: true });
  };
  // The FILER is a plain id, NOT a seeded live session — deliberately, twice over. It models the real
  // shape (the original filer is typically a long-retired seat, which is exactly why the inbox LEFT JOINs
  // only on `session_id` and never on this field), and `seedLiveSession` mints every id as
  // `e2e-live-<uuid>`, so two seeded sessions share the same first 8 chars and could not express a
  // divergence at all at the width this UI renders. (That collapse was caught by the identity guard below.)
  const filerId = () => `filer-${randomUUID()}`;

  test("a diverged row shows BOTH the filer and the current routing target, on the row and in the modal", async ({ page, loomDaemon }) => {
    const filed = filerId();
    const routed = await loomDaemon.seedLiveSession({ role: "manager", agentName: "RoutedToMgr" });
    const title = uniq("diverged-provenance");
    await loomDaemon.seedQuestion({
      sessionId: routed.sessionId, filedBySessionId: filed,
      projectId: routed.projectId, title, type: "decision", options: ["A", "B"],
    });
    // Guard the fixture's own identity: a seed that silently collapsed to one id would make every
    // assertion below pass for the wrong reason (both halves would read the same 8 chars).
    expect(short(filed)).not.toEqual(short(routed.sessionId));
    const both = `filed by ${short(filed)} · now routed to ${short(routed.sessionId)}`;

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    const main = page.locator("main");
    await expect(main.getByText(title, { exact: true })).toBeVisible();
    // The row meta carries BOTH ids — the full owner-form text, spelled out.
    await expect(main.getByTitle(both).first()).toBeVisible();
    await expect(main.getByText(both).first()).toBeVisible();
    await shoot(page, "provenance-diverged-row.png");

    // The detail modal header carries the same pair (ONE component, so the two surfaces can't drift).
    await main.getByRole("button", { name: "Answer →" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(both)).toBeVisible();
    await shoot(page, "provenance-diverged-modal.png");
  });

  test("a legacy row whose filer is permanently null reads 'filer unknown' and NEVER falls back to the routing id", async ({ page, loomDaemon }) => {
    const routed = await loomDaemon.seedLiveSession({ role: "manager", agentName: "LegacyFilerMgr" });
    const title = uniq("legacy-provenance");
    await loomDaemon.seedQuestion({
      // Explicit null = a row created before `filed_by_session_id` existed. Its original filer was already
      // overwritten by whatever recycle ran back then: UNRECOVERABLE, not merely unset.
      sessionId: routed.sessionId, filedBySessionId: null,
      projectId: routed.projectId, title, type: "decision", options: ["A", "B"],
    });

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    const main = page.locator("main");
    await expect(main.getByText(title, { exact: true })).toBeVisible();
    // Scope to THIS row. The negative below cannot be page-wide: the shared e2e daemon carries other
    // specs' seeded rows, every one of which legitimately renders a "filed by …" of its own — and since
    // `seedLiveSession` mints every id as `e2e-live-<uuid>`, their filer text is character-identical to
    // what a fallback on THIS row would produce. A page-wide assertion would fail on a correct build.
    const row = main.locator("div").filter({ hasText: title }).last();
    await expect(row).toContainText(`filer unknown · now routed to ${short(routed.sessionId)}`);
    // ⛔ The regression this card removes: the routing id must NEVER appear in the FILER slot. This is the
    // load-bearing assertion — "filer unknown" rendering is worth nothing if a fallback also crept back in.
    // Asserting the WORDS are absent (not one particular id) catches a reconstruction from any source.
    await expect(row).not.toContainText("filed by");
    await shoot(page, "provenance-legacy-unknown.png");
  });

  test("the ACTION caption still names the CURRENT routing target, not the filer", async ({ page, loomDaemon }) => {
    const filed = filerId();
    const routed = await loomDaemon.seedLiveSession({ role: "manager", agentName: "ActionRoutedMgr" });
    const title = uniq("action-target");
    await loomDaemon.seedQuestion({
      sessionId: routed.sessionId, filedBySessionId: filed,
      projectId: routed.projectId, title, type: "permission", permissionAction: "push to origin/main",
      permissionScopeHint: "once",
    });
    expect(short(filed)).not.toEqual(short(routed.sessionId));

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    await page.locator("main").getByRole("button", { name: "Review →" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The decision genuinely GOES to the seat that currently owns the row. Naming the original filer here
    // would point the human at a RETIRED session — actively false, which is why this line was left alone.
    await expect(dialog.getByText(`Sends your decision to agent ${short(routed.sessionId)}.`)).toBeVisible();
    await expect(dialog.getByText(`Sends your decision to agent ${short(filed)}.`)).toHaveCount(0);
    await shoot(page, "provenance-action-caption.png");
  });

  test("the history row renders the COMPACT form — still both ids, never one", async ({ page, loomDaemon }) => {
    const filed = filerId();
    const routed = await loomDaemon.seedLiveSession({ role: "manager", agentName: "HistProvMgr" });
    const title = uniq("history-provenance");
    await loomDaemon.seedQuestion({
      sessionId: routed.sessionId, filedBySessionId: filed,
      projectId: routed.projectId, title, type: "decision", options: ["X"],
      state: "consumed", chosenOption: "X",
    });
    expect(short(filed)).not.toEqual(short(routed.sessionId));

    await page.goto(`${loomDaemon.baseURL}/inbox`);
    const main = page.locator("main");
    await main.getByRole("button", { name: "History" }).click();
    // Narrow to THIS row — the shared daemon's history carries every other spec's resolved requests.
    await main.getByPlaceholder(/search titles/).fill(title);
    await expect(main.getByText(title, { exact: true })).toBeVisible();
    // The history cell is a single ellipsized column, so it renders the COMPACT form: the words drop, the
    // ids do NOT. An ellipsis that ate the routing id would silently restore the one-id rendering this
    // card removes, which is why both are asserted here rather than trusting the roomy form's coverage.
    await expect(main.getByText(`${short(filed)} → ${short(routed.sessionId)}`)).toBeVisible();
    // `exact` pins the COMPONENT's own title: the enclosing history cell carries a superset title
    // (project name + the same text), and a substring match would resolve both under strict mode.
    await expect(main.getByTitle(`filed by ${short(filed)} · now routed to ${short(routed.sessionId)}`, { exact: true })).toBeVisible();
    await shoot(page, "provenance-history-compact.png");
  });

  test("the attention row frames its id as the ROUTING TARGET, and carries only that one", async ({ page, loomDaemon }) => {
    const filed = filerId();
    const routed = await loomDaemon.seedLiveSession({ role: "manager", agentName: "AttnProvMgr" });
    const title = uniq("attention-provenance");
    await loomDaemon.seedQuestion({
      sessionId: routed.sessionId, filedBySessionId: filed,
      projectId: routed.projectId, title, type: "decision", options: ["A", "B"], state: "pending",
    });
    expect(short(filed)).not.toEqual(short(routed.sessionId));
    await pinActiveProject(page, routed.projectId);

    await page.goto(`${loomDaemon.baseURL}/overview`);
    const row = page.locator("main").getByText(title, { exact: false }).first();
    await expect(row).toBeVisible();
    // The attention queue is a COMPACT surface where the roomy "filed by X · now routed to Y" does not
    // fit, so it deliberately carries ONE id — the CURRENT routing target, i.e. who will act on this —
    // and FRAMES it as a destination. The bare `mgr <id>` it replaced read as the asker while carrying a
    // mutable id, which is the same misattribution the rows above fix.
    await expect(row).toContainText(`routed to mgr ${short(routed.sessionId)}`);
    // ⛔ And NOT the filer: on this surface the filer is the id that CANNOT be acted on.
    await expect(row).not.toContainText(short(filed));
    await shoot(page, "provenance-attention-row.png");
  });
});
