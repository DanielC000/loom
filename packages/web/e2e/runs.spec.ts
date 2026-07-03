// Runs-page e2e spec (card ec114237). The Runs view (/runs, header-active-project scoped like Board/Vault)
// is the READ-ONLY Agent Runs observability surface: a newest-first LIST of the project's `runs` rows (left)
// → a DETAIL drawer (right) rendering the selected run's full input / result / usage / error + chips for
// agent, key, and timestamps. It reads the HUMAN loopback run REST (GET /api/projects/:id/runs) plus the
// project's agents (to render agentId → name).
//
// SEEDING (card 32fd6f4c — the runs gap is now CLOSED): the `runs` table is otherwise filled ONLY by the
// real-spawn-triggering POST /api/runs (forbidden in the isolated fixture, which asserts no real claude ever
// spawns). The test-only POST /internal/test/seed (mounted ONLY under LOOM_TEST=1, which this fixture's
// daemon sets) inserts run rows directly via the daemon's Db (insertRun) — no agent spawns. `runs` FK a
// project + agent, so each test seeds a project (fixture helper) + an agent (REST) FIRST, then the run rows
// INLINE via fetch (the fixture is NOT edited — it's a shared file). See
// Projects/Loom/Design/E2E Test Suite Design.md ("POST /internal/test/seed") + the daemon's insertRun.
//
// Determinism: `loomDaemon` is worker-scoped (one daemon for the whole run), so many projects/runs coexist.
// Every test seeds its OWN project and PINS it active via addInitScript localStorage `loom.projectId` BEFORE
// navigating, so the /runs list is scoped to exactly this test's seeded rows; runs are addressed by their
// returned id, never by list position. The first-run "Welcome to Loom" overlay is dismissed globally by the
// fixture (fixtures/daemon.ts), so no spec re-derives it. Timestamps are rendered
// with toLocaleString (locale/TZ-dependent), so assertions target stable values only — status, ids, agent
// name, input/result/usage content, the "internal" key label — never the formatted date text.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/daemon";

// --- REST seeding helpers (the same human/loopback endpoints the UI + fixture drive) -----------------

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface SeededAgent { id: string; projectId: string; name: string }

const seedAgent = (baseURL: string, projectId: string, name: string) =>
  apiJson<SeededAgent>(`${baseURL}/api/projects/${projectId}/agents`, {
    method: "POST",
    body: JSON.stringify({ name, startupPrompt: "" }),
  });

// Seed run rows directly via the test-only endpoint (bypasses SessionService.startRun/PTY — no agent spawns).
// Returns the inserted run ids, in order, so tests address a specific row by its real id.
const seedRuns = async (baseURL: string, runs: Array<Record<string, unknown>>): Promise<string[]> => {
  const res = await apiJson<{ ok: boolean; runIds: string[] }>(`${baseURL}/internal/test/seed`, {
    method: "POST",
    body: JSON.stringify({ runs }),
  });
  return res.runIds;
};

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

const short = (id: string) => id.slice(0, 8);

// Shared-daemon good-citizenship: `loomDaemon` is worker-scoped, so the `runs` rows this spec seeds live in
// the SAME db the Usage page's "Agent Runs" plane aggregates over its "All projects" scope. That plane is
// WINDOWED by a `since` cutoff (default Last 7 days), while the Runs PAGE list this spec asserts on is NOT
// windowed (GET /api/projects/:id/runs returns every row, newest-first). So we past-date the seeded runs far
// outside any usage window — they still render in full on the Runs list, but never leak into another spec's
// windowed empty-state assertion (e.g. usage.spec.ts's "No agent runs in this window").
const PAST_ISO = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

test.describe("runs", () => {
  // The first-run "Welcome to Loom" overlay is dismissed globally by the fixture (fixtures/daemon.ts) — no
  // spec re-derives it.

  test("the runs list renders the seeded run rows with their status, agent, and outcome", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`runs-list-${Date.now()}`);
    const agent = await seedAgent(loomDaemon.baseURL, project.id, "Runner");
    const [completedId, failedId] = await seedRuns(loomDaemon.baseURL, [
      {
        projectId: project.id, agentId: agent.id, status: "completed",
        input: "Summarize the release notes",
        result: { summary: "3 features, 2 fixes" },
        usage: { inputTokens: 12_000, outputTokens: 3_400, turns: 5, model: "claude-sonnet-5", costUsd: 0.42 },
        createdAt: PAST_ISO, startedAt: PAST_ISO, endedAt: PAST_ISO,
      },
      {
        projectId: project.id, agentId: agent.id, status: "failed",
        input: "Do the thing",
        error: "engine exited before submitting a result",
        createdAt: PAST_ISO, startedAt: PAST_ISO, endedAt: PAST_ISO,
      },
    ]);

    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/runs`);

    // The list header carries the exact seeded row count (scoped to this project's runs).
    await expect(page.getByText("Runs (2)", { exact: true })).toBeVisible();

    // Each run's status renders as its own pill — the completed and failed rows both show up, labelled.
    await expect(page.getByText("completed", { exact: true })).toBeVisible();
    await expect(page.getByText("failed", { exact: true })).toBeVisible();

    // Both rows resolve the agentId → the seeded agent's NAME (via the project agents query), not a raw id.
    await expect(page.getByText("Runner")).toHaveCount(2);

    // Each row's short id renders (the mono id peek), and neither run carries a key ⇒ the "internal" chip.
    await expect(page.getByText(short(completedId), { exact: true })).toBeVisible();
    await expect(page.getByText(short(failedId), { exact: true })).toBeVisible();
    await expect(page.getByText("internal", { exact: true })).toHaveCount(2);

    // The single-line outcome peek: the completed run trims its result, the failed run shows its error.
    await expect(page.getByText(/3 features, 2 fixes/)).toBeVisible();
    await expect(page.getByText(/engine exited before submitting a result/)).toBeVisible();
  });

  test("a run's detail view renders the seeded input, result, usage, and labels", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`runs-detail-${Date.now()}`);
    const agent = await seedAgent(loomDaemon.baseURL, project.id, "Runner");
    const [runId] = await seedRuns(loomDaemon.baseURL, [
      {
        projectId: project.id, agentId: agent.id, status: "completed",
        // sessionId left null: a terminal run with no session renders the detail's "No session" transcript
        // fallback deterministically, without the live TranscriptPane fetching a (non-existent) transcript.
        input: "Summarize the release notes",
        result: { summary: "3 features, 2 fixes", risk: "low" },
        usage: { inputTokens: 12_000, outputTokens: 3_400, turns: 5, model: "claude-sonnet-5", costUsd: 0.42 },
        createdAt: PAST_ISO, startedAt: PAST_ISO, endedAt: PAST_ISO,
      },
    ]);

    await pinActiveProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/runs`);

    // BEFORE selecting a run: the detail pane shows its placeholder prompt.
    await expect(page.getByText("Select a run to view its input, result, usage, and transcript.")).toBeVisible();
    await expect(page.getByText(runId, { exact: true })).toHaveCount(0); // the FULL id only shows in the detail

    // ACT: click the run row (clicking the id peek bubbles to the row Panel's onClick, selecting it).
    await page.getByText(short(runId), { exact: true }).click();

    // AFTER (detail): the full run id chip renders (the row only carried the short id) + the status/agent/key.
    // Status/agent/key each now appear in BOTH the row and the detail pane, so scope those to `.first()`.
    await expect(page.getByText(runId, { exact: true })).toBeVisible();
    await expect(page.getByText("completed", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Runner").first()).toBeVisible();
    await expect(page.getByText("internal", { exact: true }).first()).toBeVisible();

    // The Input / Result / Usage fields render the seeded values (Result + Usage as pretty JSON). Target the
    // SPACED pretty-printed form (`"key": value`) so these match the detail pane's <pre>, not the left row's
    // compact peek (`"key":value`), which also carries the result text.
    await expect(page.getByText("Summarize the release notes", { exact: true })).toBeVisible();
    await expect(page.getByText(/"summary": "3 features, 2 fixes"/)).toBeVisible();
    await expect(page.getByText(/"risk": "low"/)).toBeVisible();
    await expect(page.getByText(/"costUsd": 0\.42/)).toBeVisible();
    await expect(page.getByText(/"model": "claude-sonnet-5"/)).toBeVisible();

    // The transcript field renders its no-session fallback (this run was seeded without a sessionId).
    await expect(page.getByText(/No session/)).toBeVisible();
  });
});
