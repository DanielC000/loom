// The classic page header goes INSIDE the Atlas frame (card a7f23a2f, Atlas restructure 4 of 11, epic
// 9fe8cd4e). Design record: docs/decisions/a7f23a2f-atlas-frame-owns-the-node-identity.md.
//
// A page mounted inside the frame is already named three times before it renders a thing — the crumb
// trail, the node head's `<h1>` and its own tab in the node's tab row. The four pages that ALSO carry
// their own title + description block therefore state one identity twice, which is the ~110px of
// duplicated chrome the gap audit measured. `useFrameOwnsNodeIdentity()` (src/lib/atlasNodeHead.ts) is
// the one switch that drops it, and every block it drops carries `data-testid="page-identity"`.
//
// Two claims, each measured against the running app rather than a list typed into this file:
//   1. ONE `<h1>` PER ATLAS DOCUMENT, and it is the FRAME's. The addresses are collected from the
//      rendered tree and the two rendered node tab rows — "every mounted classic page you can reach",
//      literally, so a page re-homed by a later card is covered without this file being edited. The
//      count alone is not the claim: a build that suppressed the FRAME's heading instead of the page's
//      would also read 1, so the surviving `<h1>` is required to be the node head's own.
//   2. NOT ONE `page-identity` BLOCK SURVIVES inside the frame, at any of those addresses.
//
// The classic shell is gone, so the old third leg — the same `page-identity` locator reading the four
// blocks back in the classic rendering, as the positive control for claim 2 — no longer exists. NO LIVE
// SURFACE renders a block any more: every identity-bearing page (Memory, Gates, Inbox) returns it only
// while `useFrameOwnsNodeIdentity()` is false, i.e. outside `AtlasNodeHeadContext`, and every route in
// AtlasShell mounts inside that provider. So claim 2's control is split in two, in a second test:
//   A. LOCATOR + COUNT PATH — a stand-in element carrying the testid is placed inside the live frame
//      and the SAME counting helper the claim uses must read it back as 1. Proves the locator can
//      match; says nothing about the product.
//   B. PRODUCT ATTRIBUTE — the three page sources that emit the block must still contain the literal
//      testid. Proves the attribute the claim looks for has not been renamed; it is a source-text
//      check, NOT a render, so a block emitted another way (new component) is not covered.
// Neither shows the product renders a block under any state; that is unreachable without a src edit.
//
// FIXTURE IDENTITY is asserted, not assumed: this daemon is shared across the specs in its worker, so
// each leg names a project THIS spec created and checks it is the one the frame is scoped to.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "./fixtures/daemon";

const PROJECT_KEY = "loom.projectId";
/** The one testid every suppressible identity block carries (see atlasNodeHead.ts). */
const PAGE_IDENTITY_TESTID = "page-identity";
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** How many identity blocks the document holds — the ONE counter claim 2 and its control share. */
async function countIdentityBlocks(page: Page): Promise<number> {
  return page.getByTestId(PAGE_IDENTITY_TESTID).count();
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
  test("one <h1> per document — the frame's — and no page-identity block anywhere",
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
        const blocks = await countIdentityBlocks(page);
        if (blocks !== 0) offenders.push(`${at} → ${blocks} page-identity block(s) inside the frame`);
      }
      expect(offenders,
        `addresses that carry more than the frame's own <h1>, or a page-identity block:\n${offenders.join("\n")}`)
        .toEqual([]);
    });

  test("positive control for the zero-identity-block claim: the locator matches, and the product still emits the testid",
    async ({ page, loomDaemon }) => {
      // A. Locator + count path, inside the live frame. Zero first, so the 1 is caused by the stand-in.
      await page.goto(loomDaemon.baseURL + "/home");
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      expect(await countIdentityBlocks(page), "the frame already holds an identity block before the stand-in")
        .toBe(0);
      await page.evaluate((id) => {
        const el = document.createElement("div");
        el.setAttribute("data-testid", id);
        el.textContent = "stand-in identity block";
        (document.querySelector("main") ?? document.body).appendChild(el);
      }, PAGE_IDENTITY_TESTID);
      expect(await countIdentityBlocks(page), "the claim's counter did not see a page-identity element")
        .toBe(1);

      // B. Product attribute: each emitter must still carry the literal testid (source text, not a render).
      for (const file of ["pages/Memory.tsx", "pages/Gates.tsx", "pages/RequestsPage.tsx"]) {
        const src = readFileSync(path.join(SRC, file), "utf8");
        expect(src.includes(`data-testid="${PAGE_IDENTITY_TESTID}"`),
          `${file} no longer emits data-testid="${PAGE_IDENTITY_TESTID}" — claim 2's selector would pass vacuously`)
          .toBe(true);
      }
    });
});
