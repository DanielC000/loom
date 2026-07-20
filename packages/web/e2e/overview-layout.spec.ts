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

// The compact Attention list (every non-merge AttentionRow) is CAPPED to the first N=5 (card: cap +
// collapse the Overview Attention list) so a project with many open alerts can't grow it unbounded and
// push Fleet/Activity/Schedules below the fold. Past the cap a local "Show M more"/"Collapse" toggle
// reveals the full list. The HEADER count (`Attention (N)`) and the `attention` Stat tile must ALWAYS
// show the true total (projAttention.length), never the capped-visible slice, in BOTH states.
//
// Seeding: one live manager + eight PENDING manager→human questions on it — each is a "DECISION NEEDED"
// attention item (a non-merge AttentionRow, so it lands in the capped list). No real ask runs (seedQuestion
// inserts straight through deps.db.insertQuestion), no `[pty] spawn`.
const ATTENTION_CAP = 5;

test.describe("project Overview — Attention list caps + collapses (unbounded-growth guard)", () => {
  test("caps to 5 rows with a 'Show 3 more' toggle; header count + Stat tile always show the true total (8)", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "AttnMgr" });
    const total = 8;
    for (let i = 0; i < total; i++) {
      await loomDaemon.seedQuestion({
        sessionId: mgr.sessionId, projectId: mgr.projectId, state: "pending",
        title: `attn-decision-${i}-${Date.now()}`, body: `seeded decision #${i} for the Attention-cap e2e`,
      });
    }

    await pinActiveProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);

    // Each DECISION NEEDED item renders its kind label uppercase in its row — count visible rows by it.
    const rows = page.locator("main").getByText("DECISION NEEDED", { exact: true });
    const header = page.locator("main").getByText(/^Attention \(/);
    const statTile = page.locator("main").getByText("attention", { exact: true }).locator("..");
    const showMore = page.getByRole("button", { name: `Show ${total - ATTENTION_CAP} more` });
    const collapse = page.getByRole("button", { name: "Collapse" });

    // Collapsed (default): exactly N rows, the "Show 3 more" affordance, and the TRUE total in the header + tile.
    await expect(header).toHaveText(`Attention (${total})`);
    await expect(rows).toHaveCount(ATTENTION_CAP);
    await expect(showMore).toBeVisible();
    await expect(collapse).toHaveCount(0);
    await expect(statTile).toContainText(String(total));

    // Expand: every row shows, the toggle flips to "Collapse", and the header/tile total is UNCHANGED.
    await showMore.click();
    await expect(rows).toHaveCount(total);
    await expect(collapse).toBeVisible();
    await expect(showMore).toHaveCount(0);
    await expect(header).toHaveText(`Attention (${total})`);
    await expect(statTile).toContainText(String(total));

    // Collapse: back to exactly N rows + the "Show 3 more" affordance, total still honest.
    await collapse.click();
    await expect(rows).toHaveCount(ATTENTION_CAP);
    await expect(showMore).toBeVisible();
    await expect(header).toHaveText(`Attention (${total})`);
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

// The Fleet accordion folds ARCHIVED sessions in alongside the live ones (so Resume has a row to act on —
// finding #15), but it must fold in ONLY the ~10 MOST-RECENT archived, not the project's entire archived
// history (~101 rows on live Loom) — folding everything re-implemented the Archive page inline and made the
// page enormous. The overflow surfaces as a truthful "N more archived → Archive" pointer to the real
// Archive page, and the header "archived" Stat stays wired to the server-side TRUE total (not the slice).
//
// Seeding: one live manager + 12 worker sessions in ONE project, then archived (archived_at set via the
// test-only seed endpoint) so they fold in as archived rows, not live ones. No real claude spawn (seeded
// `processState:"live"` rows + an archive flag, never startSession).
const ARCHIVED_FOLD_CAP = 10;

test.describe("project Overview — Fleet accordion caps the archived fold-in + links to Archive", () => {
  test("folds only the ~10 most recent archived; the rest surface as an 'N more archived → Archive' link", async ({ page, loomDaemon }) => {
    const archivedCount = 12;
    // A live manager keeps the accordion populated with a live row; the workers get archived below.
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "ArchCapMgr" });
    const archivedIds: string[] = [];
    for (let i = 0; i < archivedCount; i++) {
      const w = await loomDaemon.seedLiveSession({ project: mgr.project, agentId: mgr.agentId, role: "worker" });
      archivedIds.push(w.sessionId);
    }
    // Archive them (sets archived_at) so they arrive via the archive query, folding in as the durable-Resume
    // path rather than as live rows.
    await apiJson(`${loomDaemon.baseURL}/internal/test/seed`, { method: "POST", body: JSON.stringify({ archiveSessions: archivedIds }) });

    await pinActiveProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);

    // The header "archived" Stat shows the TRUE server-side total (12), never the capped fold-in slice.
    const archivedStat = page.locator("main").getByText("archived", { exact: true }).locator("..");
    await expect(archivedStat).toContainText(String(archivedCount));

    // The Fleet accordion is expanded by default. It renders the live manager + ONLY the 10 most-recent
    // archived rows (each a collapsed cockpit toggle) → 1 + 10 = 11, NOT 1 + 12. Counting the row toggles
    // is the witness that the fold-in was CAPPED (uncapped would render every archived row).
    const rowToggles = page.locator("main").locator(`button[title="Expand to this session's cockpit"]`);
    await expect(rowToggles).toHaveCount(1 + ARCHIVED_FOLD_CAP);

    // The archived rows beyond the cap (12 − 10 = 2) surface as a truthful pointer to the Archive page.
    const hidden = archivedCount - ARCHIVED_FOLD_CAP;
    const moreLink = page.locator("main").getByRole("button", { name: new RegExp(`${hidden} more archived`) });
    await expect(moreLink).toBeVisible();

    // It routes to the (project-scoped) Archive page.
    await moreLink.click();
    await expect(page).toHaveURL(/\/archive$/);
  });
});

// A project with NO schedules used to render a full Schedules section (SectionLabel heading + a Panel whose
// only content was "add one on the Automation page"). Empty, that whole section collapses to a single muted
// pointer line — no heading, no Panel — with a clickable "add one on the Automation page →" that routes to
// Automation. Seed a schedule and the FULL section returns (the cron row renders, the pointer is gone).
test.describe("project Overview — empty Schedules collapses to a one-line pointer", () => {
  test("no schedules → single pointer line to Automation; a seeded schedule → the full section returns", async ({ page, loomDaemon }) => {
    const stamp = Date.now();
    const project = await loomDaemon.createProject(`ov-sched-${stamp}`);
    const agent = await seedAgent(loomDaemon.baseURL, project.id, `SchedAgent-${stamp}`);
    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/overview`);

    // EMPTY: the collapsed pointer is a clickable button routing to Automation — and the OLD full-section
    // empty copy ("No schedules for this project.") is gone, proving the section chrome collapsed.
    const pointer = page.locator("main").getByRole("button", { name: /add one on the Automation page/i });
    await expect(pointer).toBeVisible();
    await expect(page.locator("main").getByText(/No schedules for this project\./i)).toHaveCount(0);

    // It routes to Automation.
    await pointer.click();
    await expect(page).toHaveURL(/\/automation$/);

    // NON-EMPTY: seed a schedule for this project's agent, return to Overview → the FULL section renders its
    // cron row and the collapsed pointer is gone (the section un-collapses when there's content).
    const cron = "0 9 * * *";
    const res = await fetch(`${loomDaemon.baseURL}/api/schedules`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `OvSched ${stamp}`, agentId: agent.id, cron }),
    });
    expect(res.ok).toBeTruthy();

    await page.goto(`${loomDaemon.baseURL}/overview`);
    await expect(page.locator("main").getByText(cron, { exact: true })).toBeVisible();
    await expect(page.locator("main").getByRole("button", { name: /add one on the Automation page/i })).toHaveCount(0);
  });
});
