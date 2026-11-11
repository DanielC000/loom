// The Atlas entity tree (card 8cbb2ac2, Atlas build plan P1-1 —
// docs/plans/archive/atlas-ui/03-decomposition.md row P1-1).
//
// Two claims, each derived from the live app and the real declarations rather than a list typed here:
//   1. PLACEMENT. Every NAV_PAGES destination is in EXACTLY ONE Atlas placement — a tree node, a
//      Workspace node tab (card 41eab0eb) or a project node tab (cards 25c08fba, ec1aa18e) — never two
//      and never none, and every extra tree node is a declared Atlas home. Until card acbb6df6 the
//      destination set was collected from the classic rail and a second test fingerprinted each page
//      against its classic route; with the classic shell deleted, NAV_PAGES itself is the set, parsed
//      from source, and there is no classic page left to compare content against.
//   2. KEYBOARD. Tab reaches the tree's one stop, the arrow keys walk the nodes in document order
//      (card fa8a2887; atlas-tree-keyboard.spec.ts owns the full key contract), Enter activates one,
//      and the focused node carries a real computed focus ring.
//
// Every absence/equality claim carries a POSITIVE CONTROL: a fingerprint comparison and a
// zero-console-error count read exactly the same whether the instrument works or is silently broken,
// so each is first shown firing against a known-bad state on the same page at the same moment.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "./fixtures/daemon";
import { nodeTabKeys } from "./helpers/nodeTabs";

// lib/activeProject.tsx owns this key. Hardcoded rather than imported: the e2e tsconfig covers `e2e/`
// only (tsconfig.e2e.json), so a spec cannot pull a `src/` module in.
const PROJECT_KEY = "loom.projectId";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAV_SOURCE = path.resolve(__dirname, "..", "src", "nav.tsx");

// ── The Atlas-only addresses (card fd99b2d7) ───────────────────────────────────────────────────
// Phase 2 adds tree nodes the classic rail has no equivalent of — the Workspace root and the
// project node here, the Agents node (P2-2) and the Platform node (P2-4) after them. So the parity
// claim below is no longer an EQUALITY against the rail; it is "every rail destination still has a
// node, and every EXTRA node is one `src/nav.tsx` declares as an Atlas home".
//
// Parsed out of the real source (same idiom as atlas-legacy-redirects.spec.ts, for the same reason:
// the e2e tsconfig cannot import a `src/` module), with the filtered row count checked against the
// declaration's own raw marker count — a regex that quietly stopped matching a row would otherwise
// return a plausible SUBSET, and a subset would let a stray node through as "declared".
function parseAtlasHomes(): { paths: string[]; rawMarkers: number; block: string } {
  const src = readFileSync(NAV_SOURCE, "utf8");
  const start = src.indexOf("export const ATLAS_HOMES");
  if (start < 0) throw new Error(`no ATLAS_HOMES declaration found in ${NAV_SOURCE}`);
  const end = src.indexOf("\n];", start);
  if (end < 0) throw new Error(`ATLAS_HOMES in ${NAV_SOURCE} has no closing "];"`);
  const block = src.slice(start, end);
  const rawMarkers = (block.match(/\bkey:\s*"/g) ?? []).length;
  const paths = [...block.matchAll(/\bto:\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
  return { paths, rawMarkers, block };
}

// ── The THIRD home a destination can have (card 41eab0eb) ──────────────────────────────────────
// Phase 2 gave the Workspace node tabs, and seven cross-project destinations moved onto them. Those
// are neither tree nodes nor escape-hatch entries any more, so the partition below is three-way.
//
// Parsed from the same source, the same way, with the same raw-marker control. The TAB is addressed
// by `atlas-tab-<key>` on `/home`, not by a pathname, which is why it needs its own lookup rather
// than another `routesFrom` call.
type NodeTab = { key: string; from: string };

function parseWorkspaceNodeTabs(): { rows: NodeTab[]; rawMarkers: number; block: string } {
  const src = readFileSync(NAV_SOURCE, "utf8");
  const start = src.indexOf("export const WORKSPACE_NODE_TABS");
  if (start < 0) throw new Error(`no WORKSPACE_NODE_TABS declaration found in ${NAV_SOURCE}`);
  const end = src.indexOf("\n];", start);
  if (end < 0) throw new Error(`WORKSPACE_NODE_TABS in ${NAV_SOURCE} has no closing "];"`);
  const block = src.slice(start, end);
  const rawMarkers = (block.match(/\bkey:\s*"/g) ?? []).length;
  const rows = [...block.matchAll(/\bkey:\s*"([^"]+)",\s*from:\s*"([^"]+)"/g)]
    .map((m) => ({ key: m[1] ?? "", from: m[2] ?? "" }));
  return { rows, rawMarkers, block };
}

/** The declared tabs, with the parse's own controls run at the call site that uses them. */
function nodeTabsUnderTest(): Map<string, string> {
  const { rows, rawMarkers, block } = parseWorkspaceNodeTabs();
  expect(rows.length, `the WORKSPACE_NODE_TABS parse found no rows. Block:\n${block}`).toBeGreaterThan(0);
  expect(rows.length,
    `the parse returned ${rows.length} row(s) but the declaration contains ${rawMarkers} entries`
    + ` — the pattern is dropping rows. Block:\n${block}`).toBe(rawMarkers);
  return new Map(rows.map((r) => [r.from, r.key]));
}

// ── The FIFTH home a destination can have (card ec1aa18e) ─────────────────────────────────────
// Card 25c08fba made ten project surfaces TABS on the project node while leaving each one a tree row
// as well. The owner's feedback ended that: a destination the project node already carries as a tab
// is no longer a row, so the project tier lists what is RUNNING instead of a second copy of the tab
// row. Those addresses are therefore in none of the four buckets above, and need their own.
//
// Parsed from the same source, the same way, with a raw-marker control of its own. The control
// counts `to: "` rather than `key: "` deliberately: the two HOME tabs address the node's own path
// through the `PROJECT_NODE_PATH` constant and a template literal, so they carry no quoted `to` for
// the pattern to find — and they are not re-homed addresses, which is exactly what this bucket is
// about. Matching 8 of 10 `key:` markers would look like a dropping pattern; matching 8 of 8 quoted
// `to:`s is the real claim. `isRehomedProjectTab` in src/nav.tsx draws the same line in the app.
function parseProjectNodeTabs(): { rows: NodeTab[]; rawMarkers: number; block: string } {
  const src = readFileSync(NAV_SOURCE, "utf8");
  const start = src.indexOf("export const PROJECT_NODE_TABS");
  if (start < 0) throw new Error(`no PROJECT_NODE_TABS declaration found in ${NAV_SOURCE}`);
  const end = src.indexOf("\n];", start);
  if (end < 0) throw new Error(`PROJECT_NODE_TABS in ${NAV_SOURCE} has no closing "];"`);
  const block = src.slice(start, end);
  const rawMarkers = (block.match(/\bto:\s*"/g) ?? []).length;
  const rows = [...block.matchAll(/\bkey:\s*"([^"]+)",\s*label:\s*"[^"]*",\s*to:\s*"([^"]+)"/g)]
    .map((m) => ({ key: m[1] ?? "", from: m[2] ?? "" }));
  return { rows, rawMarkers, block };
}

/** The declared project tabs (`from` → `key`), with the parse's own controls at the call site. */
function projectNodeTabsUnderTest(): Map<string, string> {
  const { rows, rawMarkers, block } = parseProjectNodeTabs();
  expect(rows.length, `the PROJECT_NODE_TABS parse found no re-homed rows. Block:\n${block}`)
    .toBeGreaterThan(0);
  expect(rows.length,
    `the parse returned ${rows.length} row(s) but the declaration contains ${rawMarkers} quoted`
    + ` addresses — the pattern is dropping rows. Block:\n${block}`).toBe(rawMarkers);
  return new Map(rows.map((r) => [r.from, r.key]));
}

// ── The destinations ───────────────────────────────────────────────────────────────────────────
// Parsed from the real NAV_PAGES declaration (the classic rail they used to be collected from was
// deleted by card acbb6df6), with the filtered row count checked against the raw marker count: a regex
// that silently stopped matching one row would otherwise return a clean-looking SUBSET.
function parseNavPages(): { paths: string[]; rawMarkers: number; block: string } {
  const src = readFileSync(NAV_SOURCE, "utf8");
  const start = src.indexOf("export const NAV_PAGES");
  if (start < 0) throw new Error(`no NAV_PAGES declaration found in ${NAV_SOURCE}`);
  const end = src.indexOf("\n];", start);
  if (end < 0) throw new Error(`NAV_PAGES in ${NAV_SOURCE} has no closing "];"`);
  const block = src.slice(start, end);
  const rawMarkers = (block.match(/\{\s*label:\s*"/g) ?? []).length;
  const paths = [...block.matchAll(/\bto:\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
  return { paths, rawMarkers, block };
}

const TREE_NODES = "a.loom-atlas-node";
// The escape hatch that stood at the foot of the tree (card 0d0c6cee). Card 5afd71bd deleted it, so
// this collector reads ZERO by construction — and that is why it is kept: it pins the hatch as gone.
const UNHOMED_LINKS = "a.loom-atlas-unhomed-link";

async function routesFrom(page: Page, selector: string): Promise<string[]> {
  const hrefs = await page.locator(selector).evaluateAll((els) =>
    els.map((el) => new URL((el as HTMLAnchorElement).href).pathname),
  );
  return [...hrefs].sort();
}

// Pin an active project before anything navigates. The scoped destinations resolve their reads off
// it, so without a pin the OFF capture and the ON capture could legitimately be scoped to DIFFERENT
// projects on this shared worker daemon and differ for a reason that is not the shell.
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

test.describe("Atlas tree nodes (card 8cbb2ac2)", () => {
  test("every destination has exactly one Atlas placement, and the tree is the app's primary nav", async ({ page, loomDaemon }) => {
    await pinProject(page, (await loomDaemon.createProject()).id);

    // The destination set, parsed from the real NAV_PAGES declaration — it used to be collected from the
    // classic rail, which card acbb6df6 deleted. A positive control on the parse: it must find every row
    // the block declares, and rows this spec can name independently.
    const nav = parseNavPages();
    expect(nav.paths.length, `the NAV_PAGES parse found no rows. Block:\n${nav.block}`).toBeGreaterThan(5);
    expect(nav.paths.length,
      `the parse returned ${nav.paths.length} row(s) but the declaration contains ${nav.rawMarkers} entries`
      + ` — the pattern is dropping rows. Block:\n${nav.block}`).toBe(nav.rawMarkers);
    expect(nav.paths, "the NAV_PAGES parse missed a destination known to exist").toContain("/board");
    expect(nav.paths, "the NAV_PAGES parse missed Settings").toContain("/settings");
    // The deleted pages are no destination any more (they are LEGACY_REDIRECTS rows).
    for (const gone of ["/", "/projects", "/overview"]) {
      expect(nav.paths, `${gone} is a NAV_PAGES destination again, which card acbb6df6 deleted`).not.toContain(gone);
    }

    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-tree")).toBeVisible();
    const treeRoutes = await routesFrom(page, TREE_NODES);
    const unhomedRoutes = await routesFrom(page, UNHOMED_LINKS);

    // (a) EXHAUSTIVE PARTITION. Every destination is in EXACTLY ONE placement: a tree node, a Workspace
    //     node tab (card 41eab0eb), or a PROJECT node tab (cards 25c08fba, ec1aa18e). A destination that
    //     fell out of all of them fails here, and so does one in two at once. Each tab placement is
    //     derived from its declaration and then VERIFIED against the rendered tab row, so a declared tab
    //     that never renders fails too. Both nodes are read on their own default (Overview) tab, the one
    //     where card d4350286's width-derived overflow has nothing to fold.
    const nodeTabs = nodeTabsUnderTest();
    const projectTabs = projectNodeTabsUnderTest();
    const renderedTabsOn = async (nodePath: string, min: number) => {
      await page.goto(loomDaemon.baseURL + nodePath);
      await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();
      const keys = new Set(await nodeTabKeys(page));
      expect(keys.size, `the ${nodePath} node's tab collector found no tabs at all`).toBeGreaterThan(min);
      return keys;
    };
    const renderedTabs = await renderedTabsOn("/home", 2);
    const tabbedSet = new Set<string>();
    for (const [from, key] of nodeTabs) {
      expect(renderedTabs.has(key),
        `src/nav.tsx declares ${from} as the "${key}" Workspace node tab, which the node does not render`
        + ` — tabs: ${JSON.stringify([...renderedTabs])}`).toBe(true);
      tabbedSet.add(from);
    }
    const renderedProjectTabs = await renderedTabsOn("/project", 2);
    const projectTabbedSet = new Set<string>();
    for (const [from, key] of projectTabs) {
      expect(renderedProjectTabs.has(key),
        `src/nav.tsx declares ${from} as the "${key}" project node tab, which the node does not render`
        + ` — tabs: ${JSON.stringify([...renderedProjectTabs])}`).toBe(true);
      projectTabbedSet.add(from);
    }
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();

    const homedSet = new Set(treeRoutes);
    const placesFor = (route: string) =>
      [homedSet.has(route), tabbedSet.has(route), projectTabbedSet.has(route)].filter(Boolean).length;
    for (const route of nav.paths) {
      expect(placesFor(route),
        `the destination ${route} is in ${placesFor(route)} of the three Atlas placements — it must be in`
        + ` EXACTLY one (a tree node, a Workspace node tab, or a project node tab). nodes:`
        + ` ${JSON.stringify(treeRoutes)}; workspace tabs: ${JSON.stringify([...tabbedSet])};`
        + ` project tabs: ${JSON.stringify([...projectTabbedSet])}`)
        .toBe(1);
    }
    // POSITIVE CONTROLS on every bucket: a reading of zero would make its disjunct dead and let a
    // destination that simply fell out of the tree pass as "in" it.
    for (const [name, set] of [["tree node", homedSet], ["Workspace tab", tabbedSet], ["project tab", projectTabbedSet]] as const) {
      expect([...set].filter((r) => nav.paths.includes(r)).length,
        `no destination is a ${name}, so that branch of the partition never runs`).toBeGreaterThan(0);
    }
    // The escape hatch is GONE (card 5afd71bd deleted it); asserted rather than left implicit, since a
    // dead collector nobody states is indistinguishable from a broken one.
    expect(unhomedRoutes, "the escape hatch still renders entries, which card 5afd71bd deleted").toEqual([]);
    await expect(page.getByTestId("atlas-unhomed"), "the escape-hatch disclosure is still mounted").toHaveCount(0);
    // Card 0d0c6cee's and ec1aa18e's own claims, stated positively: a cross-project destination and a
    // destination the project node carries as a TAB are not tree rows.
    expect(treeRoutes, "the Inbox destination is still an Atlas tree row").not.toContain("/inbox");
    expect(treeRoutes, "the Board destination is still an Atlas tree row, which card ec1aa18e removed")
      .not.toContain("/board");
    await expect(page.getByTestId("atlas-home-project"),
      "the project branch still carries a Home row, which card 4a0ad464 removed").toHaveCount(0);
    expect(treeRoutes, "the tree node collector missed the Platform node").toContain("/platform");
    expect(treeRoutes, "the tree node collector missed the Workspace home node").toContain("/home");

    // (b) Every EXTRA node must be an address src/nav.tsx declares as an Atlas home — a node pointing at
    //     a page that does not exist, or a typo'd `to`, is in neither set and fails.
    const homes = parseAtlasHomes();
    expect(homes.paths.length, `the ATLAS_HOMES parse found no rows. Block:\n${homes.block}`).toBeGreaterThan(0);
    expect(homes.paths.length,
      `the parse returned ${homes.paths.length} row(s) but the declaration contains ${homes.rawMarkers} entries`
      + ` — the pattern is dropping rows. Block:\n${homes.block}`).toBe(homes.rawMarkers);
    for (const extra of treeRoutes.filter((r) => !nav.paths.includes(r))) {
      expect(homes.paths, `the tree renders an extra node for ${extra}, which src/nav.tsx does not`
        + ` declare as an Atlas home`).toContain(extra);
    }
    //     The other direction: a declared home is a node or a node tab — never missing from all of them.
    // ⚠️ `/project` is reached through the project ROW itself (card 4a0ad464), a <button> invisible to
    //     every link collector here — verified against the rendered control, not excused.
    const projectRowNavigates = await page.getByTestId("atlas-project-node").count() > 0;
    expect(projectRowNavigates, "no project row is rendered, so the exception below is vacuous").toBe(true);
    for (const declared of homes.paths) {
      expect(homedSet.has(declared) || tabbedSet.has(declared) || projectTabbedSet.has(declared)
        || (declared === "/project" && projectRowNavigates),
        `src/nav.tsx declares the Atlas home ${declared}, which the tree renders neither as a node nor as a`
        + ` node tab`).toBe(true);
    }

    // The tree IS navigation, not a complementary region (the P1-0 review finding this card carries).
    const tree = page.getByTestId("atlas-tree");
    expect(await tree.evaluate((el) => el.tagName.toLowerCase())).toBe("nav");

    // Depth: a project branch holds ONLY what is running in it since card 4a0ad464 — no page row.
    const projectNode = page.getByTestId("atlas-project-node");
    await expect(projectNode).toBeVisible();
    const scopedCount = await page.locator("ul.loom-atlas-nodes.is-kids a.loom-atlas-node").count();
    expect(scopedCount, "a destination row is back under the project node, which card 4a0ad464 removed")
      .toBe(0);
    // ...with the positive control that absence needs: this fixture's project has nothing running, so
    // the branch renders that card's idle line instead.
    await expect(page.locator(".loom-atlas-idle").first(),
      "the project branch rendered neither a row nor its empty-branch line").toBeVisible();
    expect(treeRoutes.length, "the workspace tier lost its rows too").toBeGreaterThan(0);

    // There is no way "back" to a classic UI any more (card acbb6df6).
    await expect(page.getByTestId("atlas-leave")).toHaveCount(0);
  });

  test("the tree is navigable by Tab, arrows and Enter, with a visible focus ring", async ({ page, loomDaemon }) => {
    await pinProject(page, (await loomDaemon.createProject()).id);
    await page.goto(loomDaemon.baseURL + "/");
    await expect(page.getByTestId("atlas-tree")).toBeVisible();

    const nodes = page.locator(TREE_NODES);
    const total = await nodes.count();
    // THREE is what a one-project workspace with nothing running renders: the Workspace home, card
    // b439c2dc's Terminals node and the Platform node (it was TWO until that card, card 4a0ad464
    // having removed the project branch's last two page rows, `Home` and `Overview`). Nothing else
    // is an ANCHOR — a project row is a <button> and a session row only exists while something is
    // running. The floor is "more than one", which is all this leg
    // needs, stated against that reading rather than against a row count that moves every time a
    // surface is re-homed.
    expect(total, "no tree nodes to tab through").toBeGreaterThan(1);

    // Land on the tree's LAST node before tabbing, so the Enter assertion at the bottom has a real
    // navigation to observe: the second node is by construction not the last one. Derived rather
    // than hardcoded — landing on whatever route happens to be node 2 today makes that final
    // "it navigated somewhere else" control vacuous the moment the tree's order changes (which is
    // exactly what card fd99b2d7 did when it put a Home node at the head of each tier).
    const landing = await nodes.last().evaluate((el) => new URL((el as HTMLAnchorElement).href).pathname);
    await page.goto(loomDaemon.baseURL + landing);
    await expect(page.getByTestId("atlas-tree")).toBeVisible();

    // Start from the document, not from a programmatic focus(): :focus-visible is what carries the
    // ring, and only a real keyboard interaction sets it. Tab until the tree's ONE stop takes focus
    // (card fa8a2887) — the chrome ahead of the tree (the skip link and friends) owns an unknown number
    // of stops, so counting them here would encode an unrelated component's shape into this assertion.
    // Then Home, the tree-view key for "first node".
    const first = nodes.first();
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() =>
        !!document.activeElement?.closest("[data-testid=atlas-tree]") &&
        document.activeElement.hasAttribute("data-atlas-tree-item"));
    }
    expect(reached, "Tab never reached the tree's stop").toBe(true);
    await page.keyboard.press("Home");
    expect(await first.evaluate((el) => el === document.activeElement),
      "Home did not move focus to the tree's first node").toBe(true);

    // The ring is really painted, read off computed style rather than inferred from the stylesheet.
    const ring = await first.evaluate((el) => {
      const s = getComputedStyle(el);
      return { width: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor };
    });
    expect(ring.style, "the focused tree node has no outline style").not.toBe("none");
    expect(parseFloat(ring.width), "the focused tree node's focus ring has no width").toBeGreaterThan(0);
    // Positive control for that read: an UNfocused node must report no ring, or the assertion above
    // would pass on a node that simply always has an outline.
    const unfocused = await nodes.nth(1).evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(unfocused, "positive control: an unfocused node also reports an outline, so the ring read proves nothing")
      .toBe("none");

    // ArrowDown moves to the NEXT node in document order (document order IS the visual order here; the
    // first two nodes are both workspace-tier anchors, so no project button sits between them).
    await page.keyboard.press("ArrowDown");
    expect(await nodes.nth(1).evaluate((el) => el === document.activeElement),
      "ArrowDown did not advance to the second tree node").toBe(true);
    // ...and ArrowUp comes back, which is also how focus returns to the node Enter is pressed on.
    await page.keyboard.press("ArrowUp");
    expect(await first.evaluate((el) => el === document.activeElement),
      "ArrowUp did not return to the first tree node").toBe(true);

    // Enter activates it — an observable navigation, not just a styled control.
    //
    // ⚠️ The FIRST node, not the second. The page was landed on `nodes.last()` above so that this
    // has a real navigation to observe, and "the second node is by construction not the last" stopped
    // being true when card 4a0ad464 took the project branch's two page rows out and left the tier
    // exactly two anchors deep. The FIRST node is not the last whenever there is more than one,
    // which is the floor this leg already asserts — so this control cannot go vacuous again the next
    // time the row count moves.
    const target = await first.evaluate((el) => new URL((el as HTMLAnchorElement).href).pathname);
    const startedAt = new URL(page.url()).pathname;
    await page.keyboard.press("Enter");
    await expect.poll(() => new URL(page.url()).pathname,
      { message: "Enter on a focused tree node did not navigate" }).toBe(target);
    expect(target, "the keyboard test navigated to the page it was already on, proving nothing")
      .not.toBe(startedAt);
  });
});
