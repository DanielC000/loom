// Overview layout e2e (card 12204d22) — the owner's rework of the project Overview page:
//   1. "Fleet" moves BELOW "Board".
//   2. "Attention" is promoted into the slot Fleet vacated (above "Terminals").
//   3. A pending merge in Attention renders as the SAME rich Review-queue card Mission Control uses
//      (the shared <ReviewQueue> / ReviewCard — "Review →" + "Approve & merge"), not a flat AttentionRow.
//
// Seeding (the no-real-claude invariant): a live manager + its live worker are `processState:"live"` DB rows
// via POST /internal/test/seed (never startSession → no `[pty] spawn`), and the MERGE REQUEST attention item
// is driven by a seeded `merge_request` orchestration_events row (loomDaemon.seedOrchestrationEvent) — the
// exact signal useAttention derives a live review from. The seeded worker has no real worktree, so the review
// card's diff reads "unavailable"; that's irrelevant here — the card CHROME (its two action buttons) is the
// witness that the merge item rendered as a review card and not a plain row. All order assertions are scoped
// to <main> so the nav tabs ("Board"/"Overview") can't be mistaken for the page's section headings.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// Minimal REST helpers for the worker-exclusion test below (mirrors profiles-agents.spec.ts) — seed a
// profile with a role + an agent, and bind the profile to the agent, over the same human/loopback endpoints
// the Projects UI drives. The shared fixture is NOT edited (it's a shared file); these live in the spec.
async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}
const seedProfile = (baseURL: string, body: { name: string; role: string; icon?: string }) =>
  apiJson<{ id: string }>(`${baseURL}/api/profiles`, { method: "POST", body: JSON.stringify(body) });
const seedAgent = (baseURL: string, projectId: string, name: string) =>
  apiJson<{ id: string }>(`${baseURL}/api/projects/${projectId}/agents`, { method: "POST", body: JSON.stringify({ name }) });
const assignProfile = (baseURL: string, agentId: string, profileId: string) =>
  apiJson<{ id: string }>(`${baseURL}/api/agents/${agentId}`, { method: "POST", body: JSON.stringify({ profileId }) });

// The vertical position of the first <main>-scoped element whose text matches — used to assert DOM order
// (a lower `y` renders higher up the page) without depending on brittle sibling-index math.
async function topOf(page: Page, matcher: RegExp): Promise<number> {
  const box = await page.locator("main").getByText(matcher).first().boundingBox();
  if (!box) throw new Error(`no <main> element matched ${matcher}`);
  return box.y;
}

test.describe("project Overview layout (card 12204d22)", () => {
  test("Attention sits above Terminals, Fleet sits below Board, and a pending merge renders as a review card", async ({ page, loomDaemon }) => {
    // A live manager + a live worker under it, in one project, with a bound task on the worker.
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "OvMgr" });
    const wkr = await loomDaemon.seedLiveSession({
      project: mgr.project, agentId: mgr.agentId, role: "worker",
      parentSessionId: mgr.sessionId, branch: "loom/ov-merge",
      task: { title: `ov-merge-${Date.now()}` },
    });
    // The pending merge: a manager `merge_request` whose worker is live ⇒ a MERGE REQUEST attention item.
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: mgr.sessionId, kind: "merge_request",
      workerSessionId: wkr.sessionId, taskId: wkr.taskId,
    });

    await pinActiveProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);

    // All four section headings render (scoped to <main> — the nav has its own "Board"/"Overview" tabs).
    const attention = page.locator("main").getByText(/^Attention \(/);
    await expect(attention).toBeVisible();
    await expect(page.locator("main").getByText(/^Terminals/)).toBeVisible();
    await expect(page.locator("main").getByText(/^Board$/)).toBeVisible();
    await expect(page.locator("main").getByText(/^Fleet/)).toBeVisible();

    // (3) The merge renders as a RICH review card — "Review →" + "Approve & merge" are ReviewCard-only
    // (a flat AttentionRow merge item would offer just "Open"), so their presence proves the restyle.
    const reviewBtn = page.getByRole("button", { name: "Review →" });
    const mergeBtn = page.getByRole("button", { name: "Approve & merge" });
    await expect(reviewBtn).toBeVisible();
    await expect(mergeBtn).toBeVisible();

    // (2) Attention is promoted ABOVE Terminals, and its review card sits in that same top slot.
    const yAttention = await topOf(page, /^Attention \(/);
    const yTerminals = await topOf(page, /^Terminals/);
    const yBoard = await topOf(page, /^Board$/);
    const yFleet = await topOf(page, /^Fleet/);
    const yReviewCard = (await reviewBtn.boundingBox())!.y;

    expect(yAttention).toBeLessThan(yTerminals);   // Attention promoted into Fleet's old slot
    expect(yReviewCard).toBeLessThan(yTerminals);  // the review card lives in that promoted Attention block
    expect(yTerminals).toBeLessThan(yBoard);       // Terminals still above Board (unchanged)
    // (1) Fleet moved BELOW Board.
    expect(yBoard).toBeLessThan(yFleet);
  });
});

// Worker-role agents are EXCLUDED from the Overview "Agents" spawn grid (owner intake 2026-07-08): workers
// are Loom-DRIVEN — a manager dispatches them via worker_spawn onto isolated worktree branches, never a
// human manual spawn — so a worker spawn card is clutter + a footgun. A non-worker (manager / null-role)
// agent still gets a card. The grid filter is on the agent's PROFILE role; the SESSION-derived "active
// workers" header stat is a SEPARATE code path (session.role) and must still count live workers.
test.describe("project Overview — Agents spawn grid excludes worker-role agents", () => {
  test("a worker-profiled agent gets no spawn card, but a manager agent does and the 'active workers' stat still counts", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`ov-worker-exclude-${Date.now()}`);

    // A manager-role profile + a worker-role profile (the global profiles store), one agent bound to each.
    const mgrProfile = await seedProfile(loomDaemon.baseURL, { name: `OvMgrProfile ${Date.now()}`, role: "manager", icon: "🧭" });
    const wkrProfile = await seedProfile(loomDaemon.baseURL, { name: `OvWkrProfile ${Date.now()}`, role: "worker", icon: "🔧" });
    const mgrName = `OvMgrAgent-${Date.now()}`;
    const wkrName = `OvWorkerRig-${Date.now()}`;
    const mgrAgent = await seedAgent(loomDaemon.baseURL, project.id, mgrName);
    const wkrAgent = await seedAgent(loomDaemon.baseURL, project.id, wkrName);
    await assignProfile(loomDaemon.baseURL, mgrAgent.id, mgrProfile.id);
    await assignProfile(loomDaemon.baseURL, wkrAgent.id, wkrProfile.id);

    // A live worker SESSION in this project so the SESSION-derived "active workers" stat is > 0 — proving
    // the header roll-up (session.role, not the agent's profile) is untouched by the grid filter.
    await loomDaemon.seedLiveSession({ project, role: "worker", agentName: "OvLiveWorker" });

    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/overview`);

    // The Agents section renders; the manager agent gets a spawn card, the worker-profiled agent does NOT
    // (its name appears nowhere on the page — it has no live session either).
    await expect(page.locator("main").getByText("Agents", { exact: true })).toBeVisible();
    await expect(page.locator("main").getByText(mgrName)).toBeVisible();
    await expect(page.locator("main").getByText(wkrName)).toHaveCount(0);

    // The SESSION-derived "active workers" header stat still counts the live worker (grid filter didn't
    // regress it). The Stat renders the value + label as sibling spans in one container.
    const workersStat = page.locator("main").getByText("active workers", { exact: true }).locator("..");
    await expect(workersStat).toContainText("1");
  });
});
