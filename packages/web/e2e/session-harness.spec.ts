// Per-session harness in the human fleet views (card 8dfaf750) — proves a codex session is visibly
// distinguishable from a claude one wherever the UI lists live sessions, and that the marker tracks the
// session's OWN stored value rather than the page it happens to be rendered on.
//
// WHY AN A/B RATHER THAN A TOGGLE. `harness` is pinned onto the session row at spawn from the resolved
// Profile and is never editable afterwards, so there is no control to click and no before/after to observe
// on one row. The equivalent — and stronger — observable is rows that differ in EXACTLY this one field and
// nothing else: same project, same agent, same manager, same role. If the tag were unconditional (or keyed
// off anything but `harness`) every row would badge; if it never rendered, none would.
//
// THE THREE STATES ARE SEEDED DELIBERATELY. `sessionView.ts` distinguishes UNSET (`null`) from an explicit
// `"claude"`, so this spec seeds all three — a manager with no harness pinned, a worker pinned `"claude"`,
// and a worker pinned `"codex"` — and asserts the first two render IDENTICALLY (no marker). That collapse
// is the product decision this card made explicitly: both spawn the same binary, so there is nothing for a
// fleet reader to act on between them, and badging the majority case would spend row width on the rows
// carrying no information. A future change that starts distinguishing them here has to DELETE an assertion,
// not merely add one.
//
// SEEDING (the no-real-claude invariant): every session is a `processState:"live"` DB row inserted through
// the test-only POST /internal/test/seed (`loomDaemon.seedLiveSession`) — NEVER startSession, which spawns a
// real claude and would trip the fixture's `[pty] spawn` no-spawn guard. THE CODEX ROW IS THEREFORE
// SYNTHETIC: no codex session exists anywhere in this project (every Loom agent resolves `harness:null`), so
// the case is CONSTRUCTED from a seeded row rather than observed. What that still buys is the real thing end
// to end — a real DB row, the real `/api/sessions` projection, the real component — only the session's
// provenance is fabricated, never any part of the path under test.
import { expect, test, type LoomDaemon } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

// Distinct 8-char prefixes: the UI shows `id.slice(0, 8)`, and the fixture's DEFAULT mint would make all
// three rows read "e2e-live" on screen — indistinguishable, so a per-row assertion would be meaningless.
const MGR = "hx-mgr00", CLAUDE = "hx-claud", CODEX = "hx-codex";
const mintId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

interface WireSession { id: string; harness?: "claude" | "codex" }

/**
 * Read the three rows back off the REAL `/api/sessions` projection the web app consumes. This is the
 * fixture-identity assertion AND the wire half of the feature: if `harness` did not survive that projection
 * every UI assertion below would fail for the wrong reason (an absent field renders exactly like a claude
 * row), and this read is the only thing that tells the two apart.
 */
async function readWire(baseURL: string, ids: string[]): Promise<Map<string, WireSession>> {
  const res = await fetch(`${baseURL}/api/sessions`);
  if (!res.ok) throw new Error(`GET /api/sessions -> ${res.status}`);
  const rows = (await res.json()) as WireSession[];
  const wanted = new Set(ids);
  return new Map(rows.filter((r) => wanted.has(r.id)).map((r) => [r.id, r]));
}

/** Seed one manager + a claude worker + a codex worker, all in ONE fresh project. */
async function seedTrio(loomDaemon: LoomDaemon) {
  const manager = await loomDaemon.seedLiveSession({ id: mintId(MGR), role: "manager", agentName: "Fleet Lead" });
  const common = { project: manager.project, agentId: manager.agentId, role: "worker" as const, parentSessionId: manager.sessionId };
  // Pinned EXPLICITLY to "claude" — not merely left unset. Without this row the spec could not tell
  // "renders nothing for claude" apart from "renders nothing for an absent field".
  const claudeWorker = await loomDaemon.seedLiveSession({ ...common, id: mintId(CLAUDE), harness: "claude" });
  const codexWorker = await loomDaemon.seedLiveSession({ ...common, id: mintId(CODEX), harness: "codex" });
  return { manager, claudeWorker, codexWorker };
}

/** Open Mission Control and expand the named project's fleet card into its managers→workers rows. */
async function expandFleetCard(page: Page, baseURL: string, projectName: string) {
  await page.goto(`${baseURL}/`);
  const cardHeader = page.getByTitle(projectName, { exact: true }).locator("xpath=..");
  await expect(cardHeader).toBeVisible();
  await cardHeader.getByTitle("Expand").click();
}

/** One FleetRow, located by the short id it renders — the row `<div>` holding that identity `<span>`. */
const fleetRow = (page: Page, label: string) => page.getByText(label, { exact: true }).locator("xpath=..");

test.describe("session harness in the fleet views", () => {
  test("Mission Control badges the codex row and leaves the claude and unset rows unmarked", async ({ page, loomDaemon }) => {
    const { manager, claudeWorker, codexWorker } = await seedTrio(loomDaemon);

    // ── Fixture identity + the wire. All three rows must come back off /api/sessions carrying exactly the
    // harness they were seeded with, or nothing below means anything.
    const wire = await readWire(loomDaemon.baseURL, [manager.sessionId, claudeWorker.sessionId, codexWorker.sessionId]);
    expect(wire.size).toBe(3);
    expect(wire.get(codexWorker.sessionId)?.harness).toBe("codex");
    expect(wire.get(claudeWorker.sessionId)?.harness).toBe("claude");
    // The manager was seeded with no harness at all: NULL in the row, absent on the wire. This is the state
    // `sessionView.ts` keeps distinct from an explicit "claude", and it must reach the UI as absent rather
    // than being defaulted server-side — otherwise the UI could never make its own choice about it.
    expect(wire.get(manager.sessionId)?.harness ?? null).toBeNull();

    await expandFleetCard(page, loomDaemon.baseURL, manager.projectName);

    // All three rows are actually on screen — so a later "no tag" assertion cannot pass merely because the
    // row never rendered.
    const mgrRow = fleetRow(page, `★ mgr ${MGR}`);
    const claudeRow = fleetRow(page, `w:${CLAUDE}`);
    const codexRow = fleetRow(page, `w:${CODEX}`);
    await expect(mgrRow).toBeVisible();
    await expect(claudeRow).toBeVisible();
    await expect(codexRow).toBeVisible();

    // ── THE OBSERVABLE, per row: the codex worker carries the marker…
    await expect(codexRow.getByTestId("harness-tag")).toHaveCount(1);
    await expect(codexRow.getByTestId("harness-tag")).toHaveText("codex");
    // …and the two rows that differ ONLY in this field carry none, so the marker tracks the VALUE rather
    // than merely "is a session row".
    await expect(claudeRow.getByTestId("harness-tag")).toHaveCount(0);
    await expect(mgrRow.getByTestId("harness-tag")).toHaveCount(0);
    // Nothing else on the whole view is badged either — a per-row check alone would not catch a stray tag
    // rendered outside these three rows.
    await expect(page.getByTestId("harness-tag")).toHaveCount(1);
  });

  // The same shared <HarnessTag> call, on the OTHER component it was added to: the terminal card's identity
  // line (TileTitle), which backs /session/:id, the /terminals grid and the Overview terminal grid.
  test("the terminal card's identity line marks a codex session and not a claude one", async ({ page, loomDaemon }) => {
    const { claudeWorker, codexWorker } = await seedTrio(loomDaemon);

    await page.goto(`${loomDaemon.baseURL}/session/${codexWorker.sessionId}`);
    await expect(page.getByText(new RegExp(`· ${CODEX}$`)).first()).toBeVisible();
    await expect(page.getByTestId("harness-tag").first()).toHaveText("codex");

    // Same page, same component, same everything except the stored harness.
    await page.goto(`${loomDaemon.baseURL}/session/${claudeWorker.sessionId}`);
    await expect(page.getByText(new RegExp(`· ${CLAUDE}$`)).first()).toBeVisible();
    await expect(page.getByTestId("harness-tag")).toHaveCount(0);
  });
});
