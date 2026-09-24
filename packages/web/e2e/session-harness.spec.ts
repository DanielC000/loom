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
// and a worker pinned `"codex"`. The first two must render IDENTICALLY to each other in every case: both
// spawn the same binary, so there is nothing for a fleet reader to act on between them. That half of the
// original decision is untouched, and it is what the per-row assertions below still pin.
//
// WHAT CARD b8e52cfe CHANGED. "claude is never badged" was absolute; it is now conditional on the VIEW
// (@decision b8e52cfe). A view running exactly one harness still badges nothing but codex — badging a
// constant fact spends row width and buys nothing — but a view holding MORE THAN ONE live harness names
// both, because there an unbadged row is ambiguous between "claude" and "a row this surface forgot". This
// spec's own trio is mixed by construction (it seeds a codex row on purpose), so the LIST views below now
// expect claude tags too; the SINGLE-session view, which can never be mixed, still expects none. The two
// halves are asserted separately on purpose — that is what keeps the conditional honest rather than
// collapsing it into "always badge".
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

    // ── THE OBSERVABLE, per row. This trio puts TWO harnesses on screen at once, so the view is mixed and
    // every row is named — but each row must name its OWN value, which is what proves the tag still tracks
    // the field rather than merely "is a session row".
    await expect(codexRow.getByTestId("harness-tag")).toHaveCount(1);
    await expect(codexRow.getByTestId("harness-tag")).toHaveText("codex");
    // The UNSET manager and the explicitly-pinned claude worker still render IDENTICALLY to each other —
    // the collapse this spec has always pinned. What changed is only WHAT that identical render is.
    await expect(claudeRow.getByTestId("harness-tag")).toHaveText("claude");
    await expect(mgrRow.getByTestId("harness-tag")).toHaveText("claude");
    // Exactly three tags on the whole view: one per row, none stray. A per-row check alone would not catch
    // a tag rendered outside these three rows.
    await expect(page.getByTestId("harness-tag")).toHaveCount(3);
  });

  // The same shared <HarnessTag> call, on the OTHER component it was added to: the terminal card's identity
  // line (TileTitle), which backs /session/:id, the /terminals grid and the Overview terminal grid.
  //
  // THIS IS THE NOT-MIXED HALF of the conditional (@decision b8e52cfe), and the pair with the /terminals
  // test below is what makes the conditional falsifiable rather than decorative: the SAME component, fed
  // the SAME two seeded sessions, badges claude on the grid and not here. /session/:id renders ONE session,
  // so it sits under no HarnessMixProvider and can never be mixed — if the claude tag were unconditional
  // (or the provider leaked app-wide) this test would fail while the grid one still passed.
  test("the terminal card's identity line marks a codex session and not a claude one", async ({ page, loomDaemon }) => {
    const { claudeWorker, codexWorker } = await seedTrio(loomDaemon);

    // `tile-identity` is the TILE's own identity node (card ad3157b9). Scoping to it rather than a
    // page-wide `getByText` matters here: `SessionView.tsx:46` renders the same identity string in the
    // PAGE header, so a page-wide match could be satisfied without the tile rendering anything.
    await page.goto(`${loomDaemon.baseURL}/session/${codexWorker.sessionId}`);
    await expect(page.getByTestId("tile-identity")).toContainText(new RegExp(`· ${CODEX}$`));
    await expect(page.getByTestId("harness-tag").first()).toHaveText("codex");

    // Same page, same component, same everything except the stored harness.
    await page.goto(`${loomDaemon.baseURL}/session/${claudeWorker.sessionId}`);
    await expect(page.getByTestId("tile-identity")).toContainText(new RegExp(`· ${CLAUDE}$`));
    await expect(page.getByTestId("harness-tag")).toHaveCount(0);
  });

  // ── The badge's LAYOUT cost (card ad3157b9). The tag is ~55px wide and the grid tile's identity line had
  // only ~51px of slack at the ~584px tile the Terminals / Overview grids lay out, so a codex tile's header
  // wrapped to a SECOND line — costing that one tile ~18px of terminal body while its claude siblings kept
  // one line. TileTitle now splits the identity into an ellipsising prefix + a non-shrinking short id, so
  // the header is structurally single-line at any tile width.
  //
  // THE MEASUREMENT IS THE ASSERTION — the failure was ~4px of slack, so "looks fine" proves nothing. The
  // un-badged claude sibling in the SAME grid is the single-line REFERENCE the codex row is compared
  // against; its own height is bounds-checked first so a layout premise that shifted (a wider sidebar, a
  // bigger type scale) fails loudly here instead of making the comparison vacuously true.
  test("the codex badge does not push the grid tile's header onto a second line", async ({ page, loomDaemon }) => {
    // Pinned: a short project name + a long agent name reproduce the card's measured geometry — a claude
    // tile that fits with a few px to spare and a codex tile that (before the fix) did not.
    const project = await loomDaemon.createProject("Loom");
    const common = { project, role: "worker" as const, agentName: "Web Designer (codescape)" };
    const codexWorker = await loomDaemon.seedLiveSession({ ...common, id: mintId(CODEX), harness: "codex" });
    const claudeWorker = await loomDaemon.seedLiveSession({ ...common, id: mintId(CLAUDE), harness: "claude" });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${loomDaemon.baseURL}/terminals`);
    await page.locator("select").filter({ hasText: "All (" }).selectOption({ label: project.name });
    // Two tags, not one: the filtered grid holds both harnesses, so it is a MIXED view and names both
    // (@decision b8e52cfe). That makes the geometry below a STRICTER test than the original, not a weaker
    // one — the claude sibling now carries a badge of its own (6 chars to codex's 5) and must still fit.
    await expect(page.getByTestId("harness-tag")).toHaveCount(2);

    const header = (shortId: string) =>
      page.getByTestId("tile-identity").filter({ hasText: shortId }).locator("xpath=..").locator("xpath=..");
    const codexHeader = header(CODEX), claudeHeader = header(CLAUDE);

    // FIXTURE IDENTITY: both tiles really are laid out at the ~584px grid width this was measured at. A
    // single-column fallback (a ~1080px tile) has slack to spare and would pass no matter what.
    for (const h of [codexHeader, claudeHeader]) {
      const tileWidth = await h.locator("xpath=..").evaluate((el) => Math.round(el.getBoundingClientRect().width));
      expect(tileWidth).toBeGreaterThanOrEqual(560);
      expect(tileWidth).toBeLessThan(700);
    }

    // THE REGRESSION PIN is now the ABSOLUTE bound, applied to BOTH tiles. The original used the unbadged
    // claude sibling as a single-line reference; in a mixed grid there is no unbadged sibling to compare
    // against, so the single-line fact is asserted directly instead of relatively. Before the ad3157b9 fix
    // the codex header read 36 against an 18 reference, so a <28 ceiling still catches that regression.
    const claudeH = (await claudeHeader.boundingBox())!.height;
    expect(claudeH).toBeLessThan(28);
    const codexH = (await codexHeader.boundingBox())!.height;
    expect(codexH).toBeLessThan(28);
    // …and the two stay in step, so a badge that wrapped only one of them is caught as well.
    expect(Math.abs(codexH - claudeH)).toBeLessThanOrEqual(2);

    // …and the short id — the part that actually tells two tiles apart — survives intact: it is the prefix
    // that gives up space, and the identity never overflows its header.
    await expect(page.getByTestId("tile-identity").filter({ hasText: CODEX })).toContainText(`· ${CODEX}`);
    const clipped = await codexHeader.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped).toBe(false);
  });
});
