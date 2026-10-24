// The Atlas Workspace node's Pulse band reaches an EXITED-but-unarchived manager's orchestration
// events — card ef86b089, closing the one gap card 5afd71bd measured and deliberately left open when
// it retired Mission Control as an Atlas destination.
//
// THE GAP: the band and Mission Control's Activity column shared their derivation byte-for-byte except
// the manager set. Mission Control read every NON-ARCHIVED manager; the band read the LIVE ones. So an
// exited-but-unarchived manager's events were reachable NOWHERE in the Atlas shell. The fix adds a
// second, BOUNDED tier — see docs/decisions/ef86b089-atlas-pulse-exited-managers.md for the trade-off.
//
// WHAT MAKES EACH LEG MORE THAN A RENDER CHECK:
//   * Leg 1 asserts a row for a specific exited manager, addressed by a PER-RUN SENTINEL worker id, and
//     scrolls it into view before asserting visibility — the band is a fixed-height panel owning its own
//     scroll, so "in the DOM" and "reachable" are two different claims. It also asserts the row's own
//     PROJECT CHIP, which is the half that fails if the fan-out widened but `projectByManager` did not.
//     Its POSITIVE CONTROL is classic Mission Control, where that row rendered before this card and must
//     still render after: without it, a zero in the band would not distinguish "the band is blind" from
//     "the seeded event does not render anywhere".
//   * Leg 2 is the MEASUREMENT the card's DoD asks for, and the one that discriminates this shape from a
//     naive widening. With N=12 exited managers and a cap of 8, it counts the DISTINCT managers actually
//     polled over a fixed window and asserts it is the CAP, not N — 0 is the pre-card band, 12 is the
//     unbounded version. It also bounds the REQUEST count over that window, which is what the slow
//     interval buys: at 60s inside a 12s window each capped manager fetches once, against the 4 fetches
//     a 3000ms interval would make.
//
// FIXTURE IDENTITY (load-bearing): the e2e daemon is SHARED across specs, so a sibling's own manager
// rows ride along in this band. Every count here is scoped to THIS run's own seeded session ids, and the
// cap legs rely on specs running sequentially (workers:1, fullyParallel:false) — a sibling's exited
// manager was seeded EARLIER, so its `lastActivity` is older and the recency cap ranks it behind mine.
import { randomUUID } from "node:crypto";
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.ts owns the project key.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

// src/lib/fleet.ts's PULSE_EXITED_MANAGER_CAP. Restated rather than imported for the same tsconfig
// reason — packages/web/test/mission-control-archived.mjs is what pins the real constant's value, so a
// drift between the two fails there rather than silently weakening this spec.
const EXITED_CAP = 8;
// Deliberately > EXITED_CAP: a population at or below the cap cannot tell a capped fan-out from an
// uncapped one, which is the whole claim of leg 2.
const SEEDED_EXITED = 12;
// The measurement window. Long enough that a 3000ms live-tier interval would have fired ~4 times per
// manager, short enough that the 60s exited interval fires exactly once.
const WINDOW_MS = 12_000;

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test.
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Writes only while the key is still absent: addInitScript re-runs on every navigation, so an
// unconditional write would re-pin on a reload and the leg would be measuring this helper.
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

/**
 * One EXITED-but-unarchived manager plus a single orchestration event on it, addressed by a per-run
 * sentinel. `processState:"exited"` is the whole point: a plain `seedLiveSession` would land in the tier
 * the band already read, and a real exit would need a real spawn (which this fixture forbids).
 *
 * The event's worker id is the sentinel: `EventRow` renders `w:<first 8 chars>` as its detail column, so
 * an 8-char-unique prefix makes the row addressable without depending on its kind, its project or its
 * position in a feed every other spec also writes to.
 */
async function seedExitedManagerWithEvent(loomDaemon: LoomDaemon, opts: {
  project?: Awaited<ReturnType<LoomDaemon["seedLiveSession"]>>["project"];
  agentId?: string;
  sentinel: string;
}) {
  const mgr = await loomDaemon.seedLiveSession({
    project: opts.project, agentId: opts.agentId,
    role: "manager", agentName: `PulseExited-${opts.sentinel}`,
    id: `exmgr-${opts.sentinel}-${randomUUID()}`,
    processState: "exited",
  });
  // `worker_report` is an ordinary, inert kind: unlike `merge_request` it derives no attention item, so
  // seeding twelve of them cannot pollute the Needs-you band this spec does not test.
  await loomDaemon.seedOrchestrationEvent({
    managerSessionId: mgr.sessionId, kind: "worker_report",
    workerSessionId: `${opts.sentinel}-${randomUUID()}`,
  });
  return mgr;
}

/**
 * A per-run tag. `EventRow` renders only the worker id's FIRST 8 CHARACTERS (`w:<id.slice(0,8)>`), so a
 * sentinel longer than 8 is silently truncated and two sentinels sharing a prefix become the same row
 * text — which is why leg 2 takes a 7-char base and appends one distinguishing character per manager.
 */
const sentinel = (len = 8) => `px${randomUUID().replace(/-/g, "").slice(0, len - 2)}`;

/** The exact `title` `EventRow` puts on its detail column for a worker id starting with `tag`. */
const detailTitle = (tag: string) => `[data-testid="activity-event-detail"][title^="w:${tag}"]`;

/** Every `managerId` this page has asked `/api/orchestration/events` about, in request order. */
function recordEventPolls(page: Page): string[] {
  const polls: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname !== "/api/orchestration/events") return;
    const id = url.searchParams.get("managerId");
    if (id) polls.push(id);
  });
  return polls;
}

test.describe("Atlas Pulse band — exited managers (card ef86b089)", () => {
  test("switch ON: an exited-unarchived manager's event renders in the Pulse band, with its project chip",
    async ({ page, loomDaemon }) => {
      test.setTimeout(120_000);
      const tag = sentinel();
      const mgr = await seedExitedManagerWithEvent(loomDaemon, { sentinel: tag });

      // ── POSITIVE CONTROL FIRST: classic Mission Control already read every non-archived manager, so
      // this exact row rendered there before this card and must still. If it does NOT render here, the
      // band assertion below would be measuring a broken fixture, not a blind band.
      await pinProject(page, mgr.projectId);
      await page.goto(loomDaemon.baseURL + "/");
      await expect(page.locator(detailTitle(tag)).first(),
        "positive control: the seeded exited manager's event does not render on classic Mission Control"
        + " either, so this fixture proves nothing about the Atlas band").toBeVisible({ timeout: 30_000 });

      // ── THE CLAIM: the same event is now reachable from the Atlas band. ──
      const atlas = await page.context().newPage();
      await pinProject(atlas, mgr.projectId);
      await seedAtlasOn(atlas);
      await atlas.goto(loomDaemon.baseURL + "/home");
      const pulse = atlas.getByTestId("atlas-band-pulse");
      await expect(pulse, "the Workspace node's Pulse band is gone").toBeVisible();

      const row = pulse.locator('[data-testid="activity-event"]')
        .filter({ has: atlas.locator(detailTitle(tag)) });
      await expect(row,
        "the Pulse band never rendered the exited manager's event — the 5afd71bd gap is still open")
        .toHaveCount(1, { timeout: 20_000 });
      // REACHABLE, not merely present: the band is a fixed-height panel owning its own scroll, and a
      // shared daemon can easily put this row below the fold.
      await row.scrollIntoViewIfNeeded();
      await expect(row).toBeVisible();

      // The half that fails if only the fan-out widened: `projectByManager` must cover the exited tier
      // too, or the row renders with no owning-project chip in a feed that interleaves every project.
      await expect(row.getByTestId("activity-event-project"),
        "the exited manager's row carries no project chip — projectByManager was not widened with the fan-out")
        .toHaveText(mgr.projectName);
      await atlas.close();
    });

  test("switch ON: the exited tier is CAPPED and SLOW — measured request count stays bounded in N",
    async ({ page, loomDaemon }) => {
      test.setTimeout(120_000);
      // A 7-char base plus one per-manager letter == the 8 characters `EventRow` actually renders, so all
      // twelve rows are individually addressable AND the base alone still prefix-matches the whole set.
      const tag = sentinel(7);
      // ONE project + ONE agent for all twelve, so the fan-out under measurement is the manager count
      // and not a project-creation side effect.
      const first = await seedExitedManagerWithEvent(loomDaemon, { sentinel: `${tag}a` });
      const mine = [first.sessionId];
      for (let i = 1; i < SEEDED_EXITED; i++) {
        const m = await seedExitedManagerWithEvent(loomDaemon, {
          project: first.project, agentId: first.agentId, sentinel: `${tag}${String.fromCharCode(97 + i)}`,
        });
        mine.push(m.sessionId);
      }
      expect(mine, `seeded ${mine.length} exited managers, not ${SEEDED_EXITED}`).toHaveLength(SEEDED_EXITED);

      const polls = recordEventPolls(page);
      await pinProject(page, first.projectId);
      await seedAtlasOn(page);
      await page.goto(loomDaemon.baseURL + "/home");
      const pulse = page.getByTestId("atlas-band-pulse");
      await expect(pulse, "the Workspace node's Pulse band is gone").toBeVisible();
      // Wait for the tier to have actually fetched before timing the window, so WINDOW_MS measures the
      // steady state rather than a mount that had not started yet.
      await expect.poll(() => new Set(polls.filter((id) => mine.includes(id))).size, {
        message: "the band never polled ANY of the seeded exited managers — the exited tier is not wired",
        timeout: 30_000,
      }).toBeGreaterThan(0);

      const atWindowStart = polls.length;
      await page.waitForTimeout(WINDOW_MS);
      const minePolls = polls.filter((id) => mine.includes(id));
      const distinct = new Set(minePolls).size;
      const inWindow = polls.slice(atWindowStart).filter((id) => mine.includes(id)).length;
      // PRINTED, not just asserted: this spec IS the card's request-count measurement, and a bound that
      // only ever appears inside a passing assertion gives a later reader no number to compare against.
      console.log(`[ef86b089] N=${SEEDED_EXITED} exited managers, cap=${EXITED_CAP}:`
        + ` distinct polled=${distinct}, total polls=${minePolls.length},`
        + ` polls in a ${WINDOW_MS}ms steady-state window=${inWindow}`);

      // THE DISCRIMINATING ASSERTION: 0 is the pre-card band, SEEDED_EXITED is the naive widening, and
      // the cap is the shipped policy. Only one of the three passes.
      expect(distinct,
        `the band polled ${distinct} of ${SEEDED_EXITED} exited managers; the cap is ${EXITED_CAP}`
        + " — 0 means the tier is absent, 12 means it is unbounded in N")
        .toBe(EXITED_CAP);

      // WHAT THE SLOW INTERVAL BUYS, measured: at 60s none of the capped managers refetches inside a
      // 12s window, against the ~4 each that a 3000ms interval would have made (≈32 for the cap alone,
      // ≈48 across all twelve). A small allowance covers one boundary refetch, never a whole round.
      expect(inWindow,
        `the exited tier made ${inWindow} requests in ${WINDOW_MS}ms for ${EXITED_CAP} capped managers`
        + " — that is a live-tier cadence, not the slow one")
        .toBeLessThanOrEqual(EXITED_CAP);

      // And the rows actually rendered match the polls: exactly the capped many of this run's sentinels.
      const rendered = await pulse.locator(detailTitle(tag)).count();
      expect(rendered,
        `${rendered} of this run's ${SEEDED_EXITED} sentinel rows rendered; expected the cap (${EXITED_CAP})`)
        .toBe(EXITED_CAP);
    });
});
