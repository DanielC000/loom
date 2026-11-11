// Card policies e2e (card 61d32daf, epic 8b6c750a): author a rule in Settings, see the unmet badge on a matching card
// (on /board, the project node's Board tab), open the card, waive the requirement
// with a reason, see it waived, then remove the waiver.
//
// WHAT IS DRIVEN FOR REAL: everything. The rule is written by clicking Save (the human config PATCH), the badge and the
// drawer read the daemon's own evaluation (GET /api/projects/:id/card-policy-status, GET /api/tasks/:id/policy), and
// the waiver goes through the human-only waiver route. Every stored-state assertion reads the daemon back, keyed to
// THIS spec's own project and card ids, so a read that resolved a sibling spec's data fails loudly.
//
// WHAT THIS DOES NOT PROVE: that a spawn or merge is actually refused. The fixture forbids real spawns; that half is
// the daemon's own card-policy-enforcement tests. The requirement used here is `approved-request` because it is the
// one the read-only view evaluates (merge-time requirements read "Checked at merge").
import { expect, test, type Page } from "./fixtures/daemon";
import path from "node:path";

// Opt-in screenshots (LOOM_E2E_SHOTS), a no-op in CI — same hook as commit-message-switches.spec.ts.
const shotDir = process.env.LOOM_E2E_SHOTS;
const shoot = async (target: Page | ReturnType<Page["locator"]>, name: string) => { if (shotDir) await target.screenshot({ path: path.join(shotDir, name) }); };

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

async function storedPolicies(baseURL: string, projectId: string): Promise<unknown> {
  const projects = (await (await fetch(`${baseURL}/api/projects`)).json()) as Array<{ id: string; config?: { orchestration?: { cardPolicies?: unknown } } }>;
  const row = projects.find((p) => p.id === projectId);
  if (!row) throw new Error(`project ${projectId} is not on this daemon — wrong daemon or wrong id`);
  return row.config?.orchestration?.cardPolicies ?? null;
}

async function policyStatusOf(baseURL: string, taskId: string): Promise<string | undefined> {
  const body = (await (await fetch(`${baseURL}/api/tasks/${taskId}/policy`)).json()) as { policy: Array<{ requirement: string; status: string }> };
  return body.policy.find((r) => r.requirement === "approved-request")?.status;
}

const cardByTitle = (page: Page, title: string) =>
  page.locator(".loom-board-card").filter({ has: page.locator('[data-testid="card-title"]', { hasText: title }) });

test.describe("Card policies (card 61d32daf)", () => {
  test("author a rule, see unmet on the matching card (board + Overview), waive it with a reason, see it waived", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("cp-ui"));
    const matchTitle = `feat(web): ${uniq("policy target")}`;
    const otherTitle = `docs(web): ${uniq("policy bystander")}`;
    const target = await loomDaemon.createTask(project.id, { title: matchTitle, columnKey: "in_progress" });
    await loomDaemon.createTask(project.id, { title: otherTitle, columnKey: "in_progress" });
    await pinActiveProject(page, project.id);

    // ── Author ──
    await page.goto(`${loomDaemon.baseURL}/settings`);
    const editor = page.getByTestId("card-policies-editor");
    await expect(editor).toBeVisible();
    await expect(editor.getByText("No card policies.")).toBeVisible();
    const save = editor.getByTestId("card-policy-save");
    await expect(save).toBeDisabled();
    await editor.getByTestId("card-policy-add").click();
    const rule = editor.getByTestId("card-policy-rule-0");
    await rule.getByTestId("card-policy-name").fill("Approved web features");
    // An incomplete draft says why it cannot save, before anything is sent.
    await expect(editor.getByTestId("card-policy-draft-error")).toContainText("at least one type");
    await expect(save).toBeDisabled();
    const feat = rule.getByTestId("card-policy-type-feat");
    await expect(feat).toHaveAttribute("aria-pressed", "false");
    await feat.click();
    await expect(feat).toHaveAttribute("aria-pressed", "true");
    await rule.getByTestId("card-policy-scopes").fill("web");
    await expect(editor.getByTestId("card-policy-draft-error")).toContainText("at least one requirement");
    await rule.getByTestId("card-policy-require-approved-request").check();
    await expect(rule.getByText("id approved-web-features (new)")).toBeVisible();
    await shoot(page.getByTestId("card-policies-panel"), "card-policies-settings.png");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(editor.getByText("saved", { exact: true })).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(rule.getByText("id approved-web-features", { exact: true })).toBeVisible();
    expect(await storedPolicies(loomDaemon.baseURL, project.id)).toEqual([
      { id: "approved-web-features", name: "Approved web features", match: { types: ["feat"], scopes: ["web"] }, require: [{ kind: "approved-request" }] },
    ]);

    // ── Badge on /board ──
    await page.goto(`${loomDaemon.baseURL}/board`);
    const card = cardByTitle(page, matchTitle);
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("card-policy-badge")).toHaveText("1 unmet");
    await expect(cardByTitle(page, otherTitle)).toHaveCount(1);
    await expect(cardByTitle(page, otherTitle).getByTestId("card-policy-badge")).toHaveCount(0);
    await shoot(card, "card-policies-board-badge.png");

    // (The classic Overview's embedded board was this badge's second surface until card acbb6df6 deleted
    // that page; the project node's Board tab above is the one board left.)
    await expect(page.getByTestId("card-policy-badge")).toHaveCount(1);

    // ── Drawer: unmet → waive with a reason → waived ──
    await card.getByTestId("card-title").click();
    const dialog = page.getByRole("dialog");
    const block = dialog.getByTestId("card-policy-block");
    await expect(block).toBeVisible();
    await expect(block.getByTestId("card-policy-summary")).toHaveText("1 unmet");
    const req = block.getByTestId("card-policy-req-approved-web-features-approved-request");
    await expect(req).toHaveAttribute("data-status", "unmet");
    await shoot(block, "card-policies-drawer-unmet.png");
    await req.getByRole("button", { name: "Waive…" }).click();
    const waiveBtn = req.getByRole("button", { name: "Waive requirement" });
    await expect(waiveBtn).toBeDisabled(); // a waiver always carries a reason
    await req.getByTestId("card-policy-waive-reason").fill("Approved in the design review");
    await expect(waiveBtn).toBeEnabled();
    await waiveBtn.click();
    await expect(req).toHaveAttribute("data-status", "waived");
    await expect(req.getByText("Waived", { exact: true })).toBeVisible();
    await expect(block.getByTestId("card-policy-summary")).toHaveText("Nothing blocking");
    expect(await policyStatusOf(loomDaemon.baseURL, target.id)).toBe("waived");
    await shoot(block, "card-policies-drawer-waived.png");

    // The badge clears without waiting for the poll: the waiver invalidates the status read.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(card.getByTestId("card-policy-badge")).toHaveCount(0);

    // ── Un-waive: the requirement is unmet again and the badge returns ──
    await card.getByTestId("card-title").click();
    await page.getByRole("dialog").getByTestId("card-policy-req-approved-web-features-approved-request").getByRole("button", { name: "Remove waiver" }).click();
    await expect(page.getByRole("dialog").getByTestId("card-policy-req-approved-web-features-approved-request")).toHaveAttribute("data-status", "unmet");
    expect(await policyStatusOf(loomDaemon.baseURL, target.id)).toBe("unmet");
  });

  test("a card id prefix is stored as the full id, and an unknown id is refused with the daemon's reason", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("cp-ids"));
    const task = await loomDaemon.createTask(project.id, { title: `chore(web): ${uniq("listed card")}`, columnKey: "inbox" });
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/settings`);
    const editor = page.getByTestId("card-policies-editor");
    await editor.getByTestId("card-policy-add").click();
    const rule = editor.getByTestId("card-policy-rule-0");
    await rule.getByTestId("card-policy-name").fill("Listed cards");
    await rule.getByTestId("card-policy-require-approved-request").check();

    await rule.getByTestId("card-policy-cards").fill("deadbeef0000");
    await editor.getByTestId("card-policy-save").click();
    await expect(editor.getByTestId("card-policy-save-error")).toContainText("matches no card on this project");
    expect(await storedPolicies(loomDaemon.baseURL, project.id)).toBeNull();

    await rule.getByTestId("card-policy-cards").fill(task.id.slice(0, 10));
    await editor.getByTestId("card-policy-save").click();
    await expect(editor.getByText("saved", { exact: true })).toBeVisible();
    await expect(rule.getByTestId("card-policy-cards")).toHaveValue(task.id);
    expect(await storedPolicies(loomDaemon.baseURL, project.id)).toEqual([
      { id: "listed-cards", name: "Listed cards", match: { cardIds: [task.id] }, require: [{ kind: "approved-request" }] },
    ]);
  });

  test("a corrupt stored list can be repaired: Save is enabled with an empty draft and unsets the key (card 740eacf5)", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("cp-corrupt"));
    await pinActiveProject(page, project.id);
    // The daemon's own validator refuses to STORE a bad list, so the corrupt value is injected into what the page READS
    // (GET /api/projects); the save still goes to the real daemon, and its PATCH body is what is asserted.
    let corrupt = true;
    await page.route("**/api/projects", async (route) => {
      if (route.request().method() !== "GET" || !corrupt) return route.continue();
      const res = await route.fetch();
      const rows = (await res.json()) as Array<{ id: string; config?: { orchestration?: Record<string, unknown> } }>;
      for (const r of rows) if (r.id === project.id) r.config = { ...(r.config ?? {}), orchestration: { ...(r.config?.orchestration ?? {}), cardPolicies: "not-a-list" } };
      await route.fulfill({ response: res, json: rows });
    });
    await page.goto(`${loomDaemon.baseURL}/settings`);
    const editor = page.getByTestId("card-policies-editor");
    await expect(editor.getByText("can’t be read")).toBeVisible();
    const save = editor.getByTestId("card-policy-save");
    await expect(save).toBeEnabled(); // an empty draft over a corrupt store is the repair
    const patched = page.waitForRequest((r) => r.method() === "PATCH" && r.url().includes(`/api/projects/${project.id}/config`));
    corrupt = false;
    await save.click();
    const body = (await patched).postDataJSON() as { unset?: string[] };
    expect(body.unset).toContain("orchestration.cardPolicies");
    await expect(editor.getByText("saved", { exact: true })).toBeVisible();
  });

  test("a failed status read shows a quiet 'unavailable' note instead of reading as nothing blocking", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(uniq("cp-down"));
    await loomDaemon.createTask(project.id, { title: `feat(web): ${uniq("down target")}`, columnKey: "in_progress" });
    const patch = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/config`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ orchestration: { cardPolicies: [{ id: "down", match: { types: ["feat"] }, require: [{ kind: "approved-request" }] }] } }),
    });
    expect(patch.status).toBe(200);
    await page.route("**/api/projects/*/card-policy-status", (route) => route.fulfill({ status: 500, body: "boom" }));
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/board`);
    await expect(page.getByTestId("card-policy-status-unavailable")).toBeVisible();
    await expect(page.getByTestId("card-policy-badge")).toHaveCount(0);
  });
});
