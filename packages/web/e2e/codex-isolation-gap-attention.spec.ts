// Codex isolation-gap attention item e2e (card ed0858dc) — the disclosure's NAMED READER, exercised.
//
// Card 7955458e shipped a detector: when a codex session cannot enforce claude's read-denies (or the
// project's authored `permission.deny`), `handleCodexIsolationGapDisclosed` files a durable
// `codex_isolation_gap_disclosed` row. But it only NUDGES a recipient when the session has a
// `parentSessionId`. An agent run (`startRun`) is parentless by design, and card 2127d695 ruled a
// codex-harness run legitimate — so for a run session the disclosure reached NOBODY: nothing under
// packages/web/src read the kind at all. This spec proves it now reaches a human, in the surface a human
// is already looking at: the Mission Control attention queue.
//
// WHY THIS IS A BEFORE/AFTER SPEC, NOT A RENDER CHECK: an inert row — one bound to a filter that always
// answers true, or to a field that never varies — passes any "the page loads and the queue renders"
// assertion forever. So the row is asserted ABSENT for a CLAUDE session that discloses nothing, PRESENT
// for the codex one, and then driven back to ABSENT by clicking its own × (dismiss). Those transitions are
// the evidence; each direction is the other's positive control.
//
// FIXTURE IDENTITY (load-bearing): the e2e daemon is SHARED across spec files, and a sibling spec's codex
// session would render a byte-identical row. So every assertion is scoped by `data-session-id` to THIS
// test's own session, each run mints unique session ids AND a unique `detail.agentId`, and the test asserts
// its own row off the REAL REST read before touching the page — if the wire half were broken, the UI
// assertions would otherwise fail for the wrong reason.
//
// SEEDING: `loomDaemon.seedOrchestrationEvent` inserts through the daemon's own `appendEvent` writer. The
// row's SHAPE is the thing under test, so it is written exactly as `handleCodexIsolationGapDisclosed`
// writes it — `managerSessionId: parentSessionId ?? sessionId` (hence === workerSessionId for a parentless
// session) and `nudged:false`. That daemon-side invariant is pinned independently, with its own negative
// control, in packages/daemon/test/codex-permission-deny-disclosure.mjs section (6); this spec consumes it.
//
// CROSS-SPEC CLEANUP (load-bearing — this item deliberately has NO liveness filter, so unlike the
// `merge_request` item in overview-layout.spec.ts it does NOT self-clean when `archiveSeededSessions`
// archives the session): the afterEach seeds a SUPERSEDING managed-shape disclosure for the same
// (agent, item-set), which is exactly how a real hand-off to a manager clears the human's copy. Without it
// the row would persist into every later spec's attention queue and toast over their bottom-right corner.
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test, type LoomDaemon } from "./fixtures/daemon";

// The two real item ids a codex spawn discloses with an authored project deny (pty/host.ts): the
// unconditional settings-dir read-deny, plus the project's own `permission.deny` rule set. Their real
// `reason` strings are paragraph-length, which is why the row carries the IDS and hovers the reasons.
const GAP_ITEMS = [
  {
    id: "settingsDirReadDeny",
    reason: "claude denies Read() of <LOOM_HOME>/tmp/settings/** for every role (other live sessions' hook tokens, and a secret-bearing spawn's plaintext --mcp-config); codex has no filesystem-deny lever compatible with its \"-s workspace-write\" sandbox mode, so a codex session can read that directory freely via its own shell access.",
  },
  {
    id: "permissionDeny",
    reason: "this project has 2 authored permission.deny rules that codex cannot honour — codex never enforces opts.permission, so these rules would be silently dropped.",
  },
];
const ITEMS_KEY = "permissionDeny,settingsDirReadDeny"; // sorted item ids, exactly as the daemon derives it

const mintId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** The attention row for ONE session — never a text match, which a sibling's identical row would satisfy. */
const gapRowFor = (page: Page, sessionId: string) =>
  page.locator(`[data-testid="attention-row"][data-kind="CODEX ISOLATION GAP"][data-session-id="${sessionId}"]`);

interface WireEvent {
  workerSessionId: string | null;
  managerSessionId: string;
  detail: { agentId?: string | null; itemsKey?: string; nudged?: boolean };
}

/**
 * Read this test's own disclosure back off the REAL route the web app consumes
 * (`GET /api/orchestration/events?kinds=`), selected by the unique `detail.agentId` sentinel. This is the
 * fixture-identity assertion AND the wire half of the feature: it proves the row the UI is about to render
 * is THIS test's, not a sibling's, and that the parentless shape survived the round trip.
 */
async function readOwnDisclosure(baseURL: string, agentSentinel: string): Promise<WireEvent[]> {
  const res = await fetch(`${baseURL}/api/orchestration/events?kinds=codex_isolation_gap_disclosed`);
  if (!res.ok) throw new Error(`GET /api/orchestration/events?kinds= -> ${res.status}`);
  const rows = (await res.json()) as WireEvent[];
  return rows.filter((r) => r.detail?.agentId === agentSentinel);
}

// Every (agentSentinel, workerSessionId) pair this file seeds a PARENTLESS disclosure for, so the afterEach
// can supersede each one. Recorded at seed time rather than rebuilt from the page, so a test that fails
// mid-way still gets its row cleaned up.
const seededGaps: { agentSentinel: string; workerSessionId: string }[] = [];

test.afterEach(async ({ loomDaemon }) => {
  for (const { agentSentinel, workerSessionId } of seededGaps.splice(0)) {
    // A MANAGED-shape disclosure for the same (agent, item-set): managerSessionId !== workerSessionId and
    // nudged:true. Latest-wins per (agent, item-set), so this supersedes the parentless row and the human
    // item clears — the same path a real hand-off to a manager takes.
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: mintId("cig-cleanup-mgr"),
      workerSessionId,
      kind: "codex_isolation_gap_disclosed",
      detail: { items: GAP_ITEMS, agentId: agentSentinel, lineageRootId: workerSessionId, itemsKey: ITEMS_KEY, nudged: true },
    });
    // Fail loudly: a cleanup that quietly no-ops breaks a LATER spec, not this one.
    const rows = await readOwnDisclosure(loomDaemon.baseURL, agentSentinel);
    const newest = rows[0]; // the route orders ts DESC, so the superseding row must now lead
    expect(newest?.managerSessionId, "the superseding managed row must be the newest for this agent").not.toBe(newest?.workerSessionId);
  }
});

// ROLE IS A STAND-IN, stated rather than hidden: a real run session carries `role:"run"` (hardcoded in
// SessionService.startRun), which this fixture's `SeededLiveRole` union cannot mint. `"plain"` is the
// closest honest shape — a session with no manager above it — and nothing under test reads the role at all:
// `activeCodexIsolationGapAlerts` derives everything from the EVENT row. So the role is fabricated
// provenance, never any part of the path being exercised.
const PARENTLESS_ROLE = "plain" as const;

/** Seed a parentless CODEX session plus its isolation-gap disclosure, written in the daemon's own shape. */
async function seedCodexGap(loomDaemon: LoomDaemon, agentName: string) {
  const agentSentinel = `cig-agent-${randomUUID()}`;
  const session = await loomDaemon.seedLiveSession({
    id: mintId("cig-cdx"), role: PARENTLESS_ROLE, harness: "codex", agentName,
    // NO parentSessionId — this is the whole point: a parentless session has no manager to nudge.
  });
  await loomDaemon.seedOrchestrationEvent({
    // The daemon files `managerSessionId: s?.parentSessionId ?? sessionId`, so for a parentless session the
    // row lands under its OWN id. That equality is what identifies it as parentless downstream.
    managerSessionId: session.sessionId,
    workerSessionId: session.sessionId,
    kind: "codex_isolation_gap_disclosed",
    detail: { items: GAP_ITEMS, agentId: agentSentinel, lineageRootId: session.sessionId, itemsKey: ITEMS_KEY, nudged: false },
  });
  seededGaps.push({ agentSentinel, workerSessionId: session.sessionId });
  return { ...session, agentSentinel };
}

test.describe("codex isolation-gap attention item (card ed0858dc)", () => {
  test("a parentless codex session's dropped protections reach the attention queue; a claude one adds nothing, and × dismisses it", async ({ page, loomDaemon }) => {
    const AGENT_NAME = `CigRunner${Date.now()}`;
    const codex = await seedCodexGap(loomDaemon, AGENT_NAME);

    // The NEGATIVE half, seeded as the real production shape: a claude session discloses NOTHING, because
    // claude actually enforces these denies — no `codex_isolation_gap_disclosed` row is ever filed for it.
    // Same project, same parentlessness, differing only in the harness and the absent disclosure.
    const claude = await loomDaemon.seedLiveSession({
      id: mintId("cig-cld"), role: PARENTLESS_ROLE, harness: "claude", agentName: `${AGENT_NAME}Claude`,
    });

    // A SECOND control, and the stronger one: a codex session that DID disclose, but in the MANAGED shape
    // (managerSessionId !== workerSessionId, nudged:true) — its manager was told, so the human queue must
    // stay silent. This is what proves the surface discriminates on the row's SHAPE rather than merely on
    // "a disclosure exists for this session". No cleanup needed: a managed-shape row can never produce an
    // item, so it cannot leak one into a later spec.
    const managedCodex = await loomDaemon.seedLiveSession({
      id: mintId("cig-mgd"), role: "worker", harness: "codex", agentName: `${AGENT_NAME}Managed`,
    });
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: mintId("cig-realmgr"), // a DIFFERENT id ⇒ this session had a parent
      workerSessionId: managedCodex.sessionId,
      kind: "codex_isolation_gap_disclosed",
      detail: {
        items: GAP_ITEMS, agentId: `cig-agent-${randomUUID()}`,
        lineageRootId: managedCodex.sessionId, itemsKey: ITEMS_KEY, nudged: true,
      },
    });

    // WIRE + FIXTURE IDENTITY, before the page is ever consulted.
    const own = await readOwnDisclosure(loomDaemon.baseURL, codex.agentSentinel);
    expect(own, "exactly one disclosure carries this test's own agent sentinel").toHaveLength(1);
    const wire = own[0];
    expect(wire).toBeDefined();
    expect(wire!.workerSessionId).toBe(codex.sessionId);
    expect(wire!.managerSessionId, "a parentless row files managerSessionId === workerSessionId").toBe(codex.sessionId);
    expect(wire!.detail.nudged, "nudged:false — nobody was told, which is the gap this surfaces").toBe(false);

    await page.goto(`${loomDaemon.baseURL}/`); // Mission Control — the global attention queue

    // PRESENT for the codex session.
    const row = gapRowFor(page, codex.sessionId);
    await expect(row).toBeVisible();

    // It says WHAT is not enforced (the item ids), names the agent the human must edit, and says the gap
    // reached nobody. Deliberately NOT "read-deny"/"can read those files": `permissionDeny` is the
    // project's authored rule set, which can deny edits and commands too — only the other ids are reads.
    const text = (await row.innerText()).replace(/\s+/g, " ");
    expect(text).toContain(AGENT_NAME);
    expect(text).toContain("2 claude protections not enforced");
    expect(text).toContain("settingsDirReadDeny");
    expect(text).toContain("permissionDeny");
    expect(text).toContain("No manager to warn, so nobody was told");
    expect(text).toContain('Set this agent\'s profile harness to "claude"');
    expect(text, "the paragraph-length reasons must NOT be dumped into the row").not.toContain("workspace-write");

    // The full reasons ARE reachable, on hover — the `hoverText` wiring, which a render-only check misses.
    const title = await row.getByTestId("attention-row-text").getAttribute("title");
    expect(title, "the row's hover title carries the full reason text").toContain("codex has no filesystem-deny lever");
    expect(title).toContain("codex never enforces opts.permission");

    // ABSENT for the claude session — nothing disclosed, so nothing to surface.
    await expect(gapRowFor(page, claude.sessionId)).toHaveCount(0);
    // ABSENT for the MANAGED codex session — it disclosed the identical item set, and its manager was
    // nudged. Same page, same poll, same component: the only difference is the row's shape.
    await expect(gapRowFor(page, managedCodex.sessionId)).toHaveCount(0);

    // EXERCISE the interactive control: × dismisses THIS agent's gap, and the row goes away.
    await row.getByRole("button", { name: "Dismiss this alert" }).click();
    await expect(row).toHaveCount(0);

    // And the dismiss is real state, not a render blip: it survives a reload (localStorage-backed).
    await page.reload();
    await expect(gapRowFor(page, codex.sessionId)).toHaveCount(0);
    // Positive control for that absence — the queue itself is alive on the reloaded page, so "not found"
    // means dismissed, not "the page never rendered an attention queue at all".
    await expect(page.getByText(/Attention queue \(/)).toBeVisible();
  });
});
