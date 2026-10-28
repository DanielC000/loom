// The Atlas tree's ENTITY tier — live sessions under the manager that dispatched them (card
// 3b563642, Atlas restructure 8 of 11, epic 9fe8cd4e).
// Design record: docs/decisions/3b563642-atlas-tree-entity-tier.md.
//
// The approved round-4 V2 mockup's tree is FOUR levels deep and its fourth level is not a page:
// `Loom › Orchestrator › (Web Designer, Dev, Bugfix, QA Tester)`. Card 0d0c6cee built the first
// three levels; this one builds the fourth.
//
// 🔴 THE TIER'S OTHER HALF — an open board card under the Board row — IS GONE, deliberately (card
// ec1aa18e, docs/decisions/ec1aa18e-atlas-tree-lists-running-agents.md). The owner's feedback took
// every duplicated project-node TAB out of the tree, the Board row among them, and the card tier had
// nothing left to hang from. The claims that measured it (closed-until-asked, the bound and its
// "+N more" row, the Conventional-Commits prefix trim, the centred dialog) went with it rather than
// being weakened into something that still passes. Do not restore them without restoring the row.
//
// What is measured, and why each measurement can fail:
//   · NESTING IS STRUCTURAL, not visual. The worker's own <li> is compared against the manager's by
//     DOM containment, and the tier depth by counting `ul.loom-atlas-nodes` ancestors — so a flat
//     list that merely renders the worker after the manager fails, which is exactly the shape this
//     card replaced. A session with NO live manager is seeded beside them as the contrast case: if
//     every session nested, the containment check would prove nothing.
//   · ZERO NEW REQUESTS. A second project is expanded and its board route asserted NEVER fetched,
//     with the selected project's own fetch as the positive control — the per-project query card
//     0d0c6cee's record forbids. Its SESSION rows DO render there, because `["allSessions"]` is one
//     cross-project cache entry that is already polled; the split between the two is the claim.
//
// FIXTURE IDENTITY is asserted, not assumed: this daemon is shared across the specs in its worker, so
// every figure read below belongs to a project this spec seeded, and the first claim made is that the
// board on screen is showing its own sentinel card.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Writes only while the key is still absent: addInitScript re-runs on every navigation, so an
// unconditional write would re-pin on a reload and that leg would measure this helper (card e47df20a).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const shortId = (id: string) => id.slice(0, 8);

/**
 * Two projects. ALPHA is the one this spec scopes to and carries everything the tier is made of: a
 * manager, a worker parented to it, and a third live session with no manager at all. BRAVO carries a
 * live manager and exists only to be EXPANDED — it is the contrast that separates "a session row
 * costs nothing, it is one shared cache" from "a per-project read, which no branch may cost".
 *
 * Each project also gets ONE board card. Not for a card tier — there isn't one (see the header) —
 * but as the page-identity sentinel: the `/board` tab this spec lands on must be showing ALPHA's own
 * board, on a daemon shared with every other spec in this worker.
 *
 * ⚠️ Each seeded session gets its OWN `agentName` and its OWN id prefix. Sharing `agentId` makes the
 * fixture report its default "Seeded Agent" for every row, and the default id mint makes every short
 * id read "e2e-live" — either would leave the row assertions below unable to tell two sessions apart
 * (the trap atlas-param-routes.spec.ts hit first).
 */
async function seedEntities(loomDaemon: LoomDaemon) {
  const alpha = await loomDaemon.createProject(uniq("atlasent-alpha"));
  const bravo = await loomDaemon.createProject(uniq("atlasent-bravo"));

  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const mgr = await loomDaemon.seedLiveSession({
    project: alpha, role: "manager", agentName: `AtlasEntMgr-${stamp}`, id: `e2e-entmgr-${stamp}`,
  });
  const worker = await loomDaemon.seedLiveSession({
    project: alpha, role: "worker", agentName: `AtlasEntWorker-${stamp}`, id: `e2e-entwrk-${stamp}`,
    parentSessionId: mgr.sessionId, branch: "loom/atlas-tree-entities",
  });
  // The contrast case for the nesting claim: a live session with no live manager above it. It must
  // sit at the SAME depth as the manager, never inside it.
  const loose = await loomDaemon.seedLiveSession({
    project: alpha, role: "plain", agentName: `AtlasEntLoose-${stamp}`, id: `e2e-entloose-${stamp}`,
  });

  // The page-identity sentinel — a title no other spec on this shared daemon can mint.
  const sentinel = await loomDaemon.createTask(alpha.id, {
    title: uniq("sentinel-ENTCARD"), columnKey: "inbox", priority: "p0",
  });

  const bravoMgr = await loomDaemon.seedLiveSession({
    project: bravo, role: "manager", agentName: `AtlasEntBravoMgr-${stamp}`, id: `e2e-entbravo-${stamp}`,
  });
  await loomDaemon.createTask(bravo.id, { title: uniq("sentinel-BRAVOCARD"), columnKey: "inbox" });

  return { alpha, bravo, mgr, worker, loose, sentinel, bravoMgr };
}

test.describe("Atlas tree entity tier (card 3b563642)", () => {
  test("switch ON: workers nest under their manager, and a session row is that session's node",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const { alpha, bravo, mgr, worker, loose, sentinel, bravoMgr } = await seedEntities(loomDaemon);

      // Every board read this page makes, collected from the first navigation — the instrument for
      // the "zero new requests" claim at the bottom. Recorded rather than intercepted, so nothing
      // about the app's own behaviour changes under measurement.
      const boardReads: string[] = [];
      page.on("request", (r) => {
        const { pathname } = new URL(r.url());
        if (/^\/api\/projects\/[^/]+\/board$/.test(pathname)) boardReads.push(pathname);
      });

      await seedAtlasOn(page);
      await pinProject(page, alpha.id);
      // Landing on /board, the project node's Board TAB: it gives the fixture-identity read below
      // something project-specific to be measured against, and it is the address whose own tree row
      // card ec1aa18e removed — so the landed-mark claim at the bottom is read where it matters.
      await page.goto(loomDaemon.baseURL + "/board");

      const tree = page.getByTestId("atlas-tree");
      await expect(tree).toBeVisible();
      const sessionRow = (id: string) => page.getByTestId(`atlas-session-${id}`);

      // ── FIXTURE IDENTITY, before any claim about the tier ──
      await expect(page.locator("main").getByText(sentinel.title, { exact: true }),
        "the board is not showing this spec's own seeded project").toBeVisible();
      await expect(page.getByTestId("atlas-project-node")).toContainText(alpha.name);

      // ── CLAIM 0: the Board is a TAB, not a row, and the project Home row is what reads as landed ──
      // Read here rather than left to atlas-tree.spec.ts's own walk because this spec is the one
      // that used to hang a tier off that row: if the row ever comes back, this is where a reader
      // of the entity tier finds out, beside the claims that went with it.
      await expect(page.getByTestId("atlas-node-/board"),
        "the Board is a tree row again, which card ec1aa18e removed").toHaveCount(0);
      await expect(page.getByTestId("atlas-board-twist"),
        "the Board row's card-tier twist is back without the row").toHaveCount(0);
      await expect(page.locator("a.loom-atlas-node.is-active")).toHaveCount(1);
      await expect(page.getByTestId("atlas-home-project"),
        "on a project node tab the project Home row is the one that must read as landed")
        .toHaveClass(/is-active/);

      // ── CLAIM 1: the three live sessions are rows, and the worker is INSIDE the manager ──
      await expect(sessionRow(mgr.sessionId)).toHaveCount(1);
      await expect(sessionRow(worker.sessionId)).toHaveCount(1);
      await expect(sessionRow(loose.sessionId)).toHaveCount(1);

      // Structural, and read in one evaluate so every figure describes the same DOM. `depth` counts
      // the row's `ul.loom-atlas-nodes` ancestors: 1 = the project tier, 2 = a project's own
      // surfaces, 3 = a manager's workers. That is the mockup's four levels counted from the
      // Workspace tier down, and it is a claim a flat sibling list cannot satisfy.
      const shape = await tree.evaluate((root, [mgrId, workerId, looseId]) => {
        const li = (id: string) => root.querySelector(`[data-testid="atlas-session-${id}"]`)?.closest("li") ?? null;
        const depth = (el: Element | null) => {
          if (!el) return -1;
          let n = 0;
          for (let p = el.parentElement; p; p = p.parentElement) {
            if (p.matches("ul.loom-atlas-nodes")) n++;
          }
          return n;
        };
        const projectLi = root.querySelector("div.loom-atlas-noderow.is-branchrow")?.closest("li") ?? null;
        const mgrLi = li(mgrId!), workerLi = li(workerId!), looseLi = li(looseId!);
        return {
          found: !!mgrLi && !!workerLi && !!looseLi,
          distinct: mgrLi !== workerLi,
          workerInsideManager: !!mgrLi && !!workerLi && mgrLi.contains(workerLi),
          looseInsideManager: !!mgrLi && !!looseLi && mgrLi.contains(looseLi),
          projectDepth: depth(projectLi),
          managerDepth: depth(mgrLi),
          workerDepth: depth(workerLi),
          looseDepth: depth(looseLi),
        };
      }, [mgr.sessionId, worker.sessionId, loose.sessionId] as const);

      expect(shape.found, "one of the three seeded live sessions has no tree row at all").toBe(true);
      expect(shape.distinct, "the manager and its worker resolved to the SAME row").toBe(true);
      expect(shape.workerInsideManager,
        "the worker row is a SIBLING of its manager's, not nested under it").toBe(true);
      // The discriminator: if the tier simply nested every session, the line above would be true for
      // a build that knows nothing about who dispatched whom.
      expect(shape.looseInsideManager,
        "a session with no live manager was nested under one anyway").toBe(false);
      // Four levels, counted rather than eyeballed. The project tier's own depth is asserted first so
      // the two below are read against a collector already shown to return a real number.
      expect(shape.projectDepth, "the project tier is not where the depth count thinks it is").toBe(1);
      expect(shape.managerDepth, "a manager row is not at the project's own surface depth").toBe(2);
      expect(shape.looseDepth, "a manager-less session sits at a different depth than a manager").toBe(2);
      expect(shape.workerDepth, "the worker row is not one level below its manager").toBe(3);

      // ── CLAIM 1b: the manager's twist is a real toggle, and only a row with children has one ──
      const mgrTwist = page.getByTestId(`atlas-session-twist-${mgr.sessionId}`);
      await expect(mgrTwist).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId(`atlas-session-twist-${loose.sessionId}`),
        "a session with nothing under it was given a twist that promises an affordance it has not got")
        .toHaveCount(0);
      await mgrTwist.click();
      await expect(mgrTwist).toHaveAttribute("aria-expanded", "false");
      await expect(sessionRow(worker.sessionId), "collapsing the manager left its worker in the tree")
        .toHaveCount(0);
      // ...and collapsing a manager is not selecting anything: the page under it is untouched.
      await expect(page.locator("main").getByText(sentinel.title, { exact: true })).toBeVisible();
      await mgrTwist.click();
      await expect(sessionRow(worker.sessionId)).toHaveCount(1);

      // ── CLAIM 2: the tier's CHROME, read off geometry rather than judged by eye ──
      // A 2px origin drift is invisible in a PNG at any scale and was wrong in the first draft of
      // the tier one level up (card 0d0c6cee), so none of this is left to a screenshot.
      //
      // The destination row measured against is the project HOME row. It used to be the Agents row,
      // which card ec1aa18e removed — and Home is the better reference anyway: it is the one
      // destination row in this tier that cannot be re-homed away, because it IS the node.
      const origins = await tree.evaluate((root, ids) => {
        const left = (sel: string) => root.querySelector(sel)?.getBoundingClientRect().left ?? -1;
        return {
          home: left('[data-testid="atlas-home-project"] .loom-atlas-lbl'),
          manager: left(`[data-testid="atlas-session-${ids.mgr}"] .loom-atlas-lbl`),
          loose: left(`[data-testid="atlas-session-${ids.loose}"] .loom-atlas-lbl`),
          worker: left(`[data-testid="atlas-session-${ids.worker}"] .loom-atlas-lbl`),
        };
      }, { mgr: mgr.sessionId, loose: loose.sessionId, worker: worker.sessionId });
      expect(origins.home, "no destination label was found to measure against").toBeGreaterThan(0);
      // A session row sits on the SAME text origin as the destination rows it shares a tier with —
      // which is the whole reason its twist is laid OVER the anchor's reserved column instead of
      // hoisted out in front of it, and the thing that would break if it were ever hoisted.
      expect(origins.manager, "a manager row and a destination row sit on different text origins")
        .toBe(origins.home);
      // ...including a row with NO twist at all, which renders without the wrapper the other two use.
      expect(origins.loose, "a session row's origin depends on whether it has a twist")
        .toBe(origins.manager);
      // And the fourth level is genuinely indented from the third.
      expect(origins.worker, "a worker row is not indented from its manager").toBeGreaterThan(origins.manager);

      // ── CLAIM 4: a session row IS that session's node, identified by its own id ──
      await sessionRow(worker.sessionId).click();
      await expect.poll(() => new URL(page.url()).pathname,
        { message: "clicking the worker row did not land on its own session address" })
        .toBe(`/session/${worker.sessionId}`);
      // The identity check: the node's heading is built from the session the ROUTE resolved, in the
      // app's own `agent · role · short id` grammar — so a row pointing at the wrong session, or at
      // the right address under the wrong data, fails here rather than passing on "a node rendered".
      await expect(page.locator(".loom-atlas-nodehead h1"))
        .toHaveText(`${worker.agentName} · worker · ${shortId(worker.sessionId)}`);
      // And the tree agrees about where you are: exactly one node reads as landed, and it is this
      // row. Exactly-one is the claim card 0d0c6cee's NavLink/Link split exists to keep true.
      await expect(page.locator("a.loom-atlas-node.is-active")).toHaveCount(1);
      await expect(sessionRow(worker.sessionId)).toHaveClass(/is-active/);

      // ── CLAIM 5: expanding another project costs NO new request ──
      await page.goto(loomDaemon.baseURL + "/board");
      await expect(page.getByTestId("atlas-tree")).toBeVisible();
      await expect(page.locator("main").getByText(sentinel.title, { exact: true })).toBeVisible();
      boardReads.length = 0;
      await page.getByTestId(`atlas-project-twist-${bravo.id}`).click();
      // Bravo's SESSION rows DO appear — `["allSessions"]` is one cross-project cache entry that is
      // already being polled, so a session row in any branch is free. That is the POSITIVE half: the
      // branch really did expand, so the absence below is a claim about the request, not about a
      // branch that rendered nothing.
      await expect(sessionRow(bravoMgr.sessionId),
        "a non-selected branch rendered none of its own live sessions").toHaveCount(1);
      // ⚠️ The wait here is on an OBSERVED EVENT, never a fixed timer: an absence gated on a bare
      // sleep passes identically whether the request never happens or merely has not happened yet.
      // Board.tsx polls its own project's board every 4s, so two of ITS reads landing after the
      // expansion is a witness that any read the expansion itself triggered would already have
      // fired — and it doubles as the positive control that this collector sees board reads at all.
      await expect.poll(() => boardReads.filter((p) => p.includes(alpha.id)).length, {
        message: "the request collector saw no board read at all after the branch was expanded,"
          + " so the absence below would prove nothing",
        timeout: 30_000,
      }).toBeGreaterThanOrEqual(2);
      expect(boardReads.filter((p) => p.includes(bravo.id)),
        "expanding another project's branch issued a board read for it").toEqual([]);

      // The entity collector itself, non-empty — the positive control the switch-OFF test's own
      // zero needs, recorded here on a build where it is known to fire.
      expect(await page.locator("[data-atlas-entity]").count(),
        "the entity-row collector found nothing with the switch ON").toBeGreaterThan(0);
    });

  test("switch OFF: the classic shell renders no entity rows and no Atlas element at all",
    async ({ page, loomDaemon }) => {
      test.setTimeout(120_000);
      const { alpha, mgr, worker, sentinel } = await seedEntities(loomDaemon);
      await pinProject(page, alpha.id);
      await page.goto(loomDaemon.baseURL + "/board");

      // Fixture identity on this side too, so "unchanged" is asserted on a page that really rendered
      // this spec's own data rather than on an empty or errored shell.
      await expect(page.locator(".loom-rail")).toBeVisible();
      await expect(page.locator("main").getByText(sentinel.title, { exact: true })).toBeVisible();

      // Not one element of the new frame exists, asserted on the class PREFIX so the tree, its rows
      // and the shell are all covered by one claim rather than by a list of the ones this spec
      // happened to think of.
      await expect(page.locator("[class*='loom-atlas']"),
        "an Atlas element is mounted with the switch off").toHaveCount(0);
      await expect(page.getByTestId("atlas-tree")).toHaveCount(0);

      // And specifically none of THIS card's rows. The collector is the same one the ON test above
      // reads a non-zero count from, so this zero is a reading rather than a broken selector.
      await expect(page.locator("[data-atlas-entity]"),
        "an entity row is mounted with the switch off").toHaveCount(0);
      await expect(page.getByTestId(`atlas-session-${mgr.sessionId}`)).toHaveCount(0);
      await expect(page.getByTestId(`atlas-session-${worker.sessionId}`)).toHaveCount(0);
    });
});
