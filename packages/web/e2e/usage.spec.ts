// Usage-page e2e spec (card 45e1839a). The Usage page is a "god-eye" console split into three deliberately
// separate planes — INTERACTIVE SESSIONS (est. consumption, from session_usage_samples), LIVE OCCUPANCY
// (a snapshot over /api/sessions), and AGENT RUNS (billed totals, from the `runs` table).
//
// SEEDING GAP (card 32fd6f4c — CLOSED): neither usage plane had a seed path reachable from this harness —
//   • `session_usage_samples` is written ONLY by the internal daemon sampler (db.insertUsageSample) — there
//     was no REST endpoint to append a sample.
//   • the `runs` table fills ONLY via the key-authed POST /api/runs, which STARTS A REAL agent (spawns a
//     real claude) — forbidden in the isolated fixture, which asserts no real claude ever spawns.
// The test-only POST /internal/test/seed (mounted ONLY under LOOM_TEST=1, which this fixture's daemon
// always sets) now closes this: it inserts rows directly via the daemon's own Db handle, bypassing
// SessionService.startRun/PTY entirely, so no agent ever spawns. `loomDaemon.seedUsageSample` (in
// fixtures/daemon.ts) wraps it for the Interactive-sessions plane. See
// Projects/Loom/Design/E2E Test Suite Design.md for the pattern (also usable for `runs` rows).
//
// The FIRST spec below still asserts the DEFAULT / EMPTY state renders with the correct wording, made
// substantive by driving the two scope controls (Window + Project) and asserting an OBSERVABLE before/after
// change in the empty-state copy. The SECOND spec seeds a real usage sample and asserts the plane renders
// actual numbers instead of the empty state.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/daemon";

// The two page-local scope <select>s, located unambiguously by an option each is guaranteed to contain
// (the component renders a native <select>, so selectOption works directly).
const projectSelect = (page: Page) =>
  page.locator("select").filter({ has: page.getByRole("option", { name: "All projects" }) });
const windowSelect = (page: Page) =>
  page.locator("select").filter({ has: page.getByRole("option", { name: "Last 7 days" }) });

test("usage page renders its three consumption planes with the correct empty-state wording", async ({
  page,
  loomDaemon,
}) => {
  // Seed one project so the Project scope select has a real option to switch to (and the god-eye page has a
  // realistic, non-empty project list) — no usage rows are created, so the empty states still hold.
  const project = await loomDaemon.createProject(`usage-${Date.now()}`);

  await page.goto(`${loomDaemon.baseURL}/usage`);

  // ── The three plane headers + their distinguishing tags render (the load-bearing "three separate planes
  //    that must never be summed" structure). Exact match so the headers, not the prose that reuses these
  //    words, are what we assert. ─────────────────────────────────────────────────────────────────────
  await expect(page.getByText("Interactive sessions", { exact: true })).toBeVisible();
  await expect(page.getByText("est. consumption · over time", { exact: true })).toBeVisible();
  await expect(page.getByText("Live occupancy", { exact: true })).toBeVisible();
  await expect(page.getByText("live · now", { exact: true })).toBeVisible();
  await expect(page.getByText("Agent Runs", { exact: true })).toBeVisible();

  // ── The honesty/scope note wording (the page's core "these are different things" framing). ──────────
  await expect(page.getByText(/Project filters all three sections/)).toBeVisible();
  await expect(page.getByText(/cumulative tokens \+ an ESTIMATE of what they'd cost on metered API/)).toBeVisible();
  await expect(page.getByText(/Cumulative BILLED token \+ cost totals from finished Agent Runs/)).toBeVisible();

  // ── Each plane's empty state renders with the right copy (no usage seeded ⇒ all three are empty). ────
  await expect(page.getByText("No interactive-session usage in this window", { exact: true })).toBeVisible();
  await expect(page.getByText("No agent runs in this window", { exact: true })).toBeVisible();
  await expect(page.getByText(/No live sessions/)).toBeVisible();

  // ── OBSERVABLE #1 — Window control drives the historical empty-state copy. Default window is "Last 7
  //    days", so the empty-state bodies read "(past 7 days)". Switching to "Last 24 hours" must flip that
  //    copy to "(past 24 hours)" — proving the Window select is wired to the historical sections. ───────
  await expect(page.getByText(/past 7 days/).first()).toBeVisible();
  await windowSelect(page).selectOption({ label: "Last 24 hours" });
  await expect(page.getByText(/past 24 hours/).first()).toBeVisible();
  await expect(page.getByText(/past 7 days/)).toHaveCount(0);

  // ── OBSERVABLE #2 — Project control drives the scope name in the empty-state copy. Default scope is
  //    "All projects" ⇒ the body names "all projects"; scoping to the seeded project must swap that copy to
  //    the project's own name — proving the Project select filters the sections. ────────────────────────
  await expect(page.getByText(/recorded for all projects/).first()).toBeVisible();
  await projectSelect(page).selectOption({ label: project.name });
  await expect(page.getByText(new RegExp(`recorded for ${project.name}`)).first()).toBeVisible();
  await expect(page.getByText(/recorded for all projects/)).toHaveCount(0);
});

test("usage page renders a seeded interactive-session usage sample instead of the empty state", async ({
  page,
  loomDaemon,
}) => {
  const project = await loomDaemon.createProject(`usage-seeded-${Date.now()}`);
  await loomDaemon.seedUsageSample({
    projectId: project.id,
    model: "claude-sonnet-5",
    inputTokens: 12_000,
    outputTokens: 3_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 4.56,
  });

  await page.goto(`${loomDaemon.baseURL}/usage`);
  await projectSelect(page).selectOption({ label: project.name });

  // The empty-state copy for the Interactive-sessions plane is gone, replaced by the seeded totals.
  await expect(page.getByText("No interactive-session usage in this window")).toHaveCount(0);
  await expect(page.getByText("$4.56", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("samples", { exact: true }).first()).toBeVisible();

  // The Agent Runs plane is untouched by a usage-sample seed (a distinct, never-summed plane) — its
  // empty state still holds, proving the seed landed in the RIGHT table only.
  await expect(page.getByText("No agent runs in this window", { exact: true })).toBeVisible();
});
