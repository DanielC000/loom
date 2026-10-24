// The classic page header goes INSIDE the Atlas frame (card a7f23a2f, Atlas restructure 4 of 11, epic
// 9fe8cd4e). Design record: docs/decisions/a7f23a2f-atlas-frame-owns-the-node-identity.md.
//
// A page mounted inside the frame is already named three times before it renders a thing — the crumb
// trail, the node head's `<h1>` and its own tab in the node's tab row. The four pages that ALSO carry
// their own title + description block therefore state one identity twice, which is the ~110px of
// duplicated chrome the gap audit measured. `useFrameOwnsNodeIdentity()` (src/lib/atlasNodeHead.ts) is
// the one switch that drops it, and every block it drops carries `data-testid="page-identity"`.
//
// Three claims, each measured against the running app rather than a list typed into this file:
//   1. ONE `<h1>` PER ATLAS DOCUMENT, and it is the FRAME's. The addresses are collected from the
//      rendered tree and the two rendered node tab rows — "every mounted classic page you can reach",
//      literally, so a page re-homed by a later card is covered without this file being edited. The
//      count alone is not the claim: a build that suppressed the FRAME's heading instead of the page's
//      would also read 1, so the surviving `<h1>` is required to be the node head's own.
//   2. NOT ONE `page-identity` BLOCK SURVIVES inside the frame, at any of those addresses.
//   3. SWITCH OFF: every one of those blocks is back, with its text verbatim. This leg is also the
//      POSITIVE CONTROL for claim 2 — the same locator, on the same build, reading the same four
//      blocks it must find ZERO of under Atlas. An empty or mis-typed locator returns zero exactly
//      like a true absence does, so the absence claim means nothing without it.
//
// The verbatim text is read off the CLASSIC rendering at run time, never typed here: the claim worth
// making is that Atlas drops exactly what the classic shell shows, and a literal in this file would
// keep passing after a copy edit while the two silently disagreed.
//
// FIXTURE IDENTITY is asserted, not assumed: this daemon is shared across the specs in its worker, so
// each leg names a project THIS spec created and checks it is the one the frame is scoped to.
import { expect, test, type Page } from "./fixtures/daemon";

const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

/** Only ever seeded ON — off IS the default, and addInitScript re-runs on every navigation. */
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

/**
 * Every address the Atlas frame can reach from its own chrome: the tree's rows plus the two node tab
 * rows. Collected from the RENDERED app, so it tracks whatever the current set of re-homed surfaces
 * happens to be — which is the point, since cards 5-11 keep moving them.
 *
 * It used to include the tree's escape hatch, which card 5afd71bd deleted along with the last two
 * destinations in it. Those two are RETIRED, so they are not addresses the frame can reach any more —
 * which is exactly right for this collector: a retired address redirects, and the node it lands on is
 * already in the list on its own account.
 */
async function reachableAddresses(page: Page, baseURL: string): Promise<string[]> {
  const seen = new Set<string>();
  const collect = async () => {
    const hrefs = await page.locator('[data-testid="atlas-tree"] a[href], [data-testid="atlas-node-tabs"] a[href]')
      .evaluateAll((els) => els.map((el) => {
        const u = new URL((el as HTMLAnchorElement).href);
        return u.pathname + u.search;
      }));
    for (const h of hrefs) seen.add(h);
  };
  // The tree is on every node; the tab rows are not, so both node heads are visited for theirs.
  for (const at of ["/home", "/project"]) {
    await page.goto(baseURL + at);
    await expect(page.getByTestId("atlas-tree")).toBeVisible();
    await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();
    await collect();
  }
  return [...seen].sort();
}

/** The one `<h1>` the frame renders, and whether the document holds any other. */
async function headings(page: Page): Promise<{ all: string[]; inNodeHead: number }> {
  return page.evaluate(() => {
    const h1s = Array.from(document.querySelectorAll("h1"));
    return {
      all: h1s.map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim()),
      inNodeHead: h1s.filter((h) => h.closest(".loom-atlas-nodehead") !== null).length,
    };
  });
}

test.describe("Atlas drops the classic page header (card a7f23a2f)", () => {
  test("switch ON: one <h1> per document — the frame's — and no page-identity block anywhere",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const project = await loomDaemon.createProject(`atlas-identity-${Date.now()}`);
      const sentinel = `Atlas page-identity card ${Date.now()}`;
      await loomDaemon.createTask(project.id, { title: sentinel, columnKey: "inbox", priority: "p1" });
      // Memory has NO REST write path, so its rows come from the test-only seed — without them the
      // page renders its empty state and the header this card edits never gets exercised at all.
      await loomDaemon.seedProjectMemory(project.id, [
        { key: `identity-${Date.now()}`, title: "A seeded memory note", text: "Body.", retrievalCount: 2 },
      ]);
      const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "AtlasIdentityMgr", project });
      // The Inbox tab body needs a row for the same reason.
      await loomDaemon.seedQuestion({
        sessionId: mgr.sessionId, projectId: mgr.projectId, title: sentinel,
        body: "Seeded so the Inbox surface renders its own tab row.", options: ["Yes", "No"],
      });
      await pinProject(page, project.id);
      await seedAtlasOn(page);

      const addresses = await reachableAddresses(page, loomDaemon.baseURL);
      // POSITIVE CONTROLS on the collector. A selector that quietly stopped matching would hand back a
      // short list, and a short list passes every assertion below for the wrong reason.
      expect(addresses.length, "the Atlas address collector found almost nothing to visit")
        .toBeGreaterThan(12);
      for (const must of ["/memory", "/board", "/repository", "/runs", "/home?tab=gates"]) {
        expect(addresses, `the collector did not reach ${must}, which the card's DoD names by hand`)
          .toContain(must);
      }
      // FIXTURE IDENTITY: the frame really is scoped to the project this spec created.
      await page.goto(loomDaemon.baseURL + "/board");
      await expect(page.locator("main").getByText(sentinel, { exact: true }),
        "the Board node is not showing this spec's own corpus").toBeVisible();

      const offenders: string[] = [];
      for (const at of addresses) {
        await page.goto(loomDaemon.baseURL + at);
        await expect(page.getByTestId("atlas-shell"), `${at} did not render the Atlas frame`).toBeVisible();

        // CLAIM 1 — exactly one, and it is the frame's. A page that kept its own `<h1>` fails on the
        // count; a build that dropped the FRAME's heading instead, or moved it out of the node head,
        // reads the same count and fails on `inNodeHead`. Both are collected into ONE verdict rather
        // than asserted separately, so neither can short-circuit the other out of ever being measured.
        const h = await headings(page);
        if (h.all.length !== 1 || h.inNodeHead !== 1) {
          offenders.push(`${at} → ${h.all.length} <h1>(s) ${JSON.stringify(h.all)}, ${h.inNodeHead} in the node head`);
        }
        // CLAIM 2 — and no page states its own identity a second time. Collected, not asserted in
        // place, for the same reason: one address's failure must not stop the other twenty being
        // measured, and a reader of a red run wants the whole set, not the first member of it.
        const blocks = await page.getByTestId("page-identity").count();
        if (blocks !== 0) offenders.push(`${at} → ${blocks} page-identity block(s) inside the frame`);
      }
      expect(offenders,
        `addresses that carry more than the frame's own <h1>, or a page-identity block:\n${offenders.join("\n")}`)
        .toEqual([]);
    });

  test("switch OFF: every suppressed header is back, with its text verbatim",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const project = await loomDaemon.createProject(`atlas-identity-off-${Date.now()}`);
      await loomDaemon.seedProjectMemory(project.id, [
        { key: `identity-off-${Date.now()}`, title: "A seeded memory note", text: "Body." },
      ]);
      await pinProject(page, project.id);

      // The four addresses whose pages carry their own identity block. Hardcoded here BY DESIGN: this
      // leg's job is to prove the classic shell still renders what Atlas drops, so the set has to be
      // stated from outside the mechanism under test — deriving it from `page-identity` itself would
      // make a build that rendered none of them pass vacuously.
      const classicAddresses = ["/memory", "/gates", "/inbox", "/projects"];
      const texts = new Map<string, string>();
      for (const at of classicAddresses) {
        await page.goto(loomDaemon.baseURL + at);
        await expect(page.locator(".loom-rail"), `${at} lost the classic rail`).toBeVisible();
        await expect(page.locator("[class*='loom-atlas']"),
          `${at} mounted an Atlas element with the switch off`).toHaveCount(0);

        const block = page.getByTestId("page-identity");
        await expect(block, `${at} renders no identity header under the CLASSIC shell`).toHaveCount(1);
        const text = (await block.innerText()).replace(/\s+/g, " ").trim();
        expect(text.length, `${at}'s identity header is empty`).toBeGreaterThan(4);
        texts.set(at, text);
      }

      // The two that carry an `<h1>` still carry it, and it is the PAGE's own — nothing above it on
      // this shell renders one, so the document's only heading is the page's.
      await page.goto(loomDaemon.baseURL + "/memory");
      expect((await headings(page)).all, "the classic Memory page lost its own <h1>")
        .toEqual(["◈ Memory"]);
      await page.goto(loomDaemon.baseURL + "/gates");
      expect((await headings(page)).all, "the classic Gates page lost its own <h1>")
        .toEqual(["Gates"]);

      // Each block's copy, verbatim — the distinctive clause of each, so a silent truncation of the
      // description (and not only a removal of the whole block) still fails.
      expect(texts.get("/memory"), "the classic Memory header lost its description")
        .toContain("The durable knowledge your fleet writes and recalls");
      expect(texts.get("/gates"), "the classic Gates header lost its subtitle")
        .toContain("Every gate serializes through the GateSemaphore");
      // `innerText` applies CSS `text-transform`, and this one is `uppercase` — so the reading is
      // "INBOX", not the "Inbox" in the source. Compared case-insensitively rather than pinned to the
      // rendered casing, which is a styling choice this card does not own.
      expect(texts.get("/inbox")?.toLowerCase(), "the classic Inbox header lost its name").toBe("inbox");
      expect(texts.get("/projects"), "the classic Projects header lost its description")
        .toContain("create and manage projects and their agents");

      // POSITIVE CONTROL that this leg is the control the ON leg needs: the SAME locator, on the SAME
      // build, found all four. The ON leg requires zero `page-identity` blocks at every address the
      // Atlas frame can reach, which is only meaningful because of this reading.
      //
      // ⚠️ `/projects` is in this leg's four but is no longer among the addresses the ON leg visits:
      // card 5afd71bd RETIRED it, so under Atlas it renders no page at all and there is nothing left
      // to suppress. It stays HERE because this leg's own claim is about the CLASSIC shell, which the
      // retirement deliberately left untouched — so its block must still be there, and that is worth
      // asserting whether or not Atlas still mounts the page.
      expect([...texts.keys()].sort(),
        "the switch-OFF leg did not read all four blocks, so it cannot control the ON leg's absence claim")
        .toEqual([...classicAddresses].sort());
    });
});
