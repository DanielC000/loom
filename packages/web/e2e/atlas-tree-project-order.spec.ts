// The Atlas tree's PROJECT ORDER — card ec1aa18e, the owner's own instruction:
//
//   "Currently running projects should be ordered at the top, ordered alphabetically. Above projects
//    that are not currently running."
//
// Record: docs/decisions/ec1aa18e-atlas-tree-lists-running-agents.md. The comparator itself is a pure
// function with its own hermetic unit test (packages/web/test/project-order.mjs); this spec answers
// the question that test CANNOT — whether the rendered rail is actually ordered by it, against a
// liveness reading taken from the real daemon.
//
// EXERCISED, never merely rendered: the order is read four times against four different fleet states
// on the same three projects, and the claim is the TRANSITION each time. A single ordered reading
// would be satisfiable by a build that happened to receive its projects in that order.
//
//   1. nothing running          -> aaa, mmm, zzz   (alphabetical; and the SELECTED project sorts
//                                                   first only because its name says so)
//   2. zzz starts               -> zzz, aaa, mmm   (running first, over both alphabet and selection)
//   3. mmm starts too           -> mmm, zzz, aaa   (alphabetical WITHIN the running group)
//   4. both stop                -> aaa, mmm, zzz   (back, so step 2 was the liveness and not the seed)
//
// ⚠️ Each transition is followed by a RELOAD. The fleet socket keeps `["allSessions"]` warm from the
// daemon's own session lifecycle, and this spec changes that state through the test-seed endpoint,
// which writes the row directly and emits no fleet delta — so a reload is what makes the new state
// reach the page. The ORDER is still a reading of real data either way; only the delivery is manual.
//
// FIXTURE IDENTITY is asserted, not assumed: this daemon is shared across the specs in its worker and
// a sibling's projects are rows in the same list, so every reading below is FILTERED to this spec's
// own three names and the filter is required to find all three.

// @decision ec1aa18e — never re-sort the project tier by anything but `liveByProject`; a second
// notion of liveness lets the rail and a row's own live chip disagree about the same project.
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

/**
 * Three projects whose names sort aaa < mmm < zzz and which share one stamp, so the ONLY thing that
 * can separate them alphabetically is the triple this spec chose. Three rather than two because two
 * cannot tell "running first" apart from "alphabetical within the running group": with one idle and
 * TWO running, those two rules make different predictions, and step 3 above is where they diverge.
 *
 * ⚠️ The names deliberately share no stem with any other spec's: Playwright's text matching is
 * substring + case-insensitive and has hijacked a locator on this suite before (card 921e06b0).
 */
async function seedOrderFixture(loomDaemon: LoomDaemon) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const aaa = await loomDaemon.createProject(`atlasorder-aaa-${stamp}`);
  const mmm = await loomDaemon.createProject(`atlasorder-mmm-${stamp}`);
  const zzz = await loomDaemon.createProject(`atlasorder-zzz-${stamp}`);
  return { aaa, mmm, zzz, stamp };
}

test.describe("Atlas tree project order (card ec1aa18e)", () => {
  test("switch ON: running projects lead, alphabetical within each group, and the order follows start/stop",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const { aaa, mmm, zzz } = await seedOrderFixture(loomDaemon);
      const mine = [aaa.name, mmm.name, zzz.name];

      await seedAtlasOn(page);
      // AAA is the pinned/selected project throughout. It is deliberately the one whose NAME sorts
      // first: that makes step 2's reading discriminating in two ways at once — a build that floated
      // the selected branch to the top would also fail there, not just one that ignored liveness.
      await pinProject(page, aaa.id);
      await page.goto(loomDaemon.baseURL + "/home");
      const tree = page.getByTestId("atlas-tree");
      await expect(tree).toBeVisible();

      /**
       * This spec's three project rows, in RENDERED order. Filtered to the three names, because the
       * daemon is shared — a sibling spec's projects are rows in the same list and are not this
       * spec's to predict. The filter is required to find all three, so a mis-read that silently
       * dropped one cannot produce a shorter list that happens to be in the right order.
       */
      const order = async (): Promise<string[]> => {
        const labels = await tree.locator("button.loom-atlas-node.is-branch .loom-atlas-lbl")
          .evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()));
        const found = labels.filter((l) => mine.includes(l));
        expect(found.length,
          `the row collector found ${found.length} of this spec's 3 projects — all rows: ${JSON.stringify(labels)}`)
          .toBe(3);
        return found;
      };

      /** Which of this spec's three the rail currently marks as having something live. */
      const liveMarked = async (): Promise<string[]> => {
        const marked = await tree.locator("div.loom-atlas-noderow.is-branchrow").evaluateAll((els) => els
          .filter((el) => !!el.querySelector(".loom-atlas-live"))
          .map((el) => (el.querySelector(".loom-atlas-lbl")?.textContent ?? "").trim()));
        return marked.filter((n) => mine.includes(n));
      };

      // ── FIXTURE IDENTITY, before any claim about the order ──
      await expect(page.getByTestId("atlas-project-node"),
        "the tree is not scoped to this spec's own project").toContainText(aaa.name);

      // ── STEP 1: nothing running. Alphabetical, and selection does not float a row. ──
      expect(await order(), "with nothing running the three rows are not in alphabetical order")
        .toEqual([aaa.name, mmm.name, zzz.name]);
      // The liveness signal the sort reads is the SAME one the row's own chip draws, so the two can
      // be cross-read: with nothing running, none of the three carries a chip. This zero is shown to
      // be a reading rather than a broken collector by step 2, where the same call returns a name.
      expect(await liveMarked(), "a row carries a live chip though nothing was seeded").toEqual([]);

      // ── STEP 2: ZZZ starts. It leads, over both the alphabet and the selection. ──
      const zzzSession = await loomDaemon.seedLiveSession({
        project: zzz, role: "manager", agentName: `AtlasOrderZzzMgr-${Date.now()}`,
      });
      await page.reload();
      await expect(tree).toBeVisible();
      expect(await liveMarked(),
        "the seeded session never reached the rail, so the order below would prove nothing")
        .toEqual([zzz.name]);
      expect(await order(), "the running project did not lead the two idle ones")
        .toEqual([zzz.name, aaa.name, mmm.name]);
      // The selection is untouched by the re-ordering — the rows moved, the scope did not.
      await expect(page.getByTestId("atlas-project-node")).toContainText(aaa.name);

      // ── STEP 3: MMM starts too. The running GROUP is alphabetical; the idle one sinks. ──
      const mmmSession = await loomDaemon.seedLiveSession({
        project: mmm, role: "manager", agentName: `AtlasOrderMmmMgr-${Date.now()}`,
      });
      await page.reload();
      await expect(tree).toBeVisible();
      expect((await liveMarked()).slice().sort(), "both seeded sessions did not reach the rail")
        .toEqual([mmm.name, zzz.name]);
      // THE DISCRIMINATING READING: mmm now leads zzz (alphabetical within the running group) and
      // aaa — the selected project, and the alphabetically first — is last because it is idle.
      expect(await order(), "the running group is not alphabetical, or the idle project did not sink")
        .toEqual([mmm.name, zzz.name, aaa.name]);

      // ── STEP 4: both stop. The order goes back, so step 2 measured liveness, not seed order. ──
      await loomDaemon.archiveSeededSessions();
      await page.reload();
      await expect(tree).toBeVisible();
      expect(await liveMarked(), "the archived sessions are still marked live on the rail").toEqual([]);
      expect(await order(), "stopping the sessions did not restore the alphabetical order")
        .toEqual([aaa.name, mmm.name, zzz.name]);

      // Named so a failure above says WHICH rows were supposed to be live.
      expect([zzzSession.sessionId, mmmSession.sessionId].filter(Boolean),
        "the fixture did not return the two session ids it seeded").toHaveLength(2);
    });
});
