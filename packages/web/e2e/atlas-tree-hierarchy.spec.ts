// The Atlas tree as an ENTITY hierarchy (card 0d0c6cee, Atlas restructure 1 of 11, epic 9fe8cd4e).
// Design record: docs/decisions/0d0c6cee-atlas-tree-entity-hierarchy.md.
//
// The owner's verdict on the phase-1/2 build was "the worst of both worlds": a tree rail that costs
// 244px and has none of a tree's hierarchy, because its workspace tier was the classic rail's flat
// list of 12 page destinations. This card makes that tier the ENTITIES — the reserved Platform node
// and one row per project — and gives every project its own branch, openable whether or not it is the
// one you are scoped to.
//
// Three claims, each measured against the page's own project-scoped data rather than against "the
// frame re-rendered":
//   1. SIBLING BRANCHES. Two seeded projects are rows in the SAME list (asserted structurally, by
//      comparing the two <li>s' parent element), each carrying its own metrics.
//   2. EXPANSION IS NOT SELECTION. Opening the branch of the project you are NOT scoped to reveals its
//      surfaces and leaves the active project, the address and the open page's own data alone. Then
//      clicking INTO that branch re-scopes, which is the only way those rows can be honest.
//   3. THE CROSS-PROJECT DESTINATIONS ARE NOT TREE ROWS. The workspace tier is exactly two rows, and
//      the ten re-homed destinations are absent from the rows while still reachable from the escape
//      hatch at the foot of the tree (cards 41eab0eb / 25c08fba turn them into node tabs).
// Plus the switch-OFF half: the classic rail renders every NAV_PAGES destination, parsed from the real
// source rather than typed here, and no `loom-atlas` element is mounted at all.
//
// Every absence claim carries a POSITIVE CONTROL on the same collector at the same moment — an empty
// or mis-typed locator returns zero exactly like a true absence does.
//
// FIXTURE IDENTITY is asserted, not assumed: this daemon is shared across the specs in its worker, so
// each project is freshly seeded with its own sentinel card title and every per-project figure is one
// this spec created (3 open cards, 1 agent, 1 live session). A silent fallback to a sibling spec's
// project fails loudly rather than producing a plausible screenshot of someone else's data.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json), so a spec
// cannot pull a `src/` module in — the same reason fixtures/daemon.ts hardcodes its own keys.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAV_SOURCE = path.resolve(__dirname, "..", "src", "nav.tsx");

// The cross-project destinations this card moved OUT of the tree's rows.
//
// Hand-named, deliberately, and only here: this is the card's own claim, and it is an ABSENCE claim —
// if src/nav.tsx later adds an unscoped destination this list does not know about, the cost is that
// the new one simply is not checked HERE, while atlas-tree.spec.ts's exhaustive node/hatch PARTITION
// (derived from the rendered tree, so it cannot go stale) still refuses to let it fall out of both.
// The two together are what make the claim both specific and drift-proof.
const RE_HOMED = [
  "/", "/terminals", "/inbox", "/gates", "/projects", "/actors", "/companion", "/automation", "/usage",
  // The Atlas-only workspace Settings node (card 595e2a47) — a `ROOT_TABS` row in the approved design,
  // so it re-homes with the nine rail destinations above rather than staying the tier's footer.
  "/workspace-settings",
];

// The two that deliberately STAYED as workspace-tier rows, in order: the tier's own home, and the
// reserved Platform home — which the mockup pins "above the project list in the tree, not inside it"
// because it is a sibling ENTITY of the projects (a home with its own agents), not a surface of them.
const WORKSPACE_TIER = ["/home", "/platform"];

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Pins the STARTING project, once — it writes only when the key is still absent. addInitScript re-runs
// on every navigation, `reload()` included, so an unconditional write would re-pin the starting
// project on any later leg and that leg would measure this helper instead of the app (card e47df20a).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Names go into regexes below, and `createProject` hands back whatever the daemon STORED rather than
// what was asked for — so escape rather than assume the stored form is metacharacter-free.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every NAV_PAGES `to`, parsed out of the real source — the same idiom (and the same reason) as
 * atlas-tree.spec.ts's `parseAtlasHomes`: the e2e tsconfig cannot import a `src/` module, and a list
 * typed into this file would go stale in exactly the way the switch-OFF claim exists to catch.
 *
 * The filtered row count is checked against the declaration's own raw marker count, because a regex
 * that quietly stopped matching a row would otherwise return a plausible SUBSET — and a subset would
 * let a destination disappear from the rail unnoticed.
 */
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

/** The classic rail's own destination links — the grouped nav rows plus the footer Settings row. */
const RAIL_LINKS = "a.loom-rail-item, a.loom-rail-statrow";

/**
 * Two projects, each holding board cards only IT has, plus a live session and a pending Request on the
 * FIRST one only — so every metric this card adds has both polarities on one screen rather than an
 * unfalsifiable single reading.
 *
 * ⚠️ The project names deliberately share no stem with the card titles, nor with each other beyond a
 * common prefix: Playwright's `getByText`/`hasText` matching is substring + case-insensitive, and it
 * has hijacked a locator on this suite before when a project's name contained the string the spec was
 * really looking for (card 921e06b0).
 */
async function seedHierarchy(loomDaemon: LoomDaemon) {
  const alpha = await loomDaemon.createProject(uniq("atlastree-alpha"));
  const bravo = await loomDaemon.createProject(uniq("atlastree-bravo"));
  const alphaCard = uniq("sentinel-ALPHA");
  const bravoCard = uniq("sentinel-BRAVO");
  // THREE open cards on alpha, so the Board row's metric is a number this spec chose rather than a
  // 1 that an off-by-one or a hardcoded placeholder would also produce.
  await loomDaemon.createTask(alpha.id, { title: alphaCard, columnKey: "inbox" });
  await loomDaemon.createTask(alpha.id, { title: uniq("filler-ALPHA"), columnKey: "inbox" });
  await loomDaemon.createTask(alpha.id, { title: uniq("filler-ALPHA"), columnKey: "inbox" });
  await loomDaemon.createTask(bravo.id, { title: bravoCard, columnKey: "inbox" });
  const live = await loomDaemon.seedLiveSession({ project: alpha, role: "manager", agentName: "AtlasTreeMgr" });
  await loomDaemon.seedQuestion({ sessionId: live.sessionId, projectId: alpha.id, title: uniq("atlastree-decision") });
  return { alpha, bravo, alphaCard, bravoCard, live };
}

test.describe("Atlas tree entity hierarchy (card 0d0c6cee)", () => {
  test("switch ON: projects are sibling branches, expansion is not selection, and the cross-project destinations have left the rows",
    async ({ page, loomDaemon }) => {
      test.setTimeout(120_000);
      const { alpha, bravo, alphaCard, bravoCard } = await seedHierarchy(loomDaemon);

      await seedAtlasOn(page);
      await pinProject(page, alpha.id);
      // Landing on /board, not /home: every claim below about selection NOT moving is then measured
      // against a real project-scoped READ — the board's own cards — rather than against the frame.
      await page.goto(loomDaemon.baseURL + "/board");

      const tree = page.getByTestId("atlas-tree");
      await expect(tree).toBeVisible();

      // Rows are addressed by a REGEX, not an exact string: a project row's accessible name also
      // carries its metrics ("<project> 1 1"), exactly as the rail chip's dropdown rows carry their
      // own count — so an exact match would resolve for one project and not the other for a reason
      // that has nothing to do with the hierarchy.
      const branch = (name: string) =>
        tree.locator("button.loom-atlas-node.is-branch").filter({ hasText: new RegExp(escapeRe(name)) });
      const twist = (id: string) => page.getByTestId(`atlas-project-twist-${id}`);
      const selected = page.getByTestId("atlas-project-node");
      const card = (title: string) => page.getByText(title, { exact: true });

      // ── FIXTURE IDENTITY, before any claim about the tree ──
      // The board is showing THIS spec's alpha project, so every figure read below is one it seeded.
      await expect(card(alphaCard), "the board is not showing this spec's own seeded project").toBeVisible();
      await expect(card(bravoCard)).toHaveCount(0);
      await expect(selected).toContainText(alpha.name);

      // ── CLAIM 1: the two projects are SIBLING branches ──
      await expect(branch(alpha.name)).toHaveCount(1);
      await expect(branch(bravo.name)).toHaveCount(1);
      // Structural, not visual: the two rows' own <li>s share one parent list. A "both are visible"
      // check would pass just as well if one were nested inside the other, which is precisely the
      // shape this card replaced (the old tier nested every destination under one project).
      const siblings = await tree.evaluate((root, [a, b]) => {
        const rows = Array.from(root.querySelectorAll("button.loom-atlas-node.is-branch"));
        const find = (name: string) =>
          rows.find((r) => (r.querySelector(".loom-atlas-lbl")?.textContent ?? "").trim() === name);
        const rowA = find(a!);
        const rowB = find(b!);
        if (!rowA || !rowB) return { found: false, distinct: false, sameList: false };
        const liA = rowA.closest("li");
        const liB = rowB.closest("li");
        return {
          found: true,
          distinct: !!liA && !!liB && liA !== liB,
          sameList: !!liA && !!liB && liA.parentElement === liB.parentElement,
        };
      }, [alpha.name, bravo.name] as const);
      expect(siblings.found, "one of the two seeded projects has no branch row at all").toBe(true);
      expect(siblings.distinct, "both seeded projects resolved to the SAME row").toBe(true);
      expect(siblings.sameList, "the two seeded projects are not rows in one list — one is nested under the other")
        .toBe(true);

      // ── CLAIM 1b: each row carries ITS OWN metrics, and only its own ──
      // Live marker on the project that HAS the live session, and nowhere else.
      await expect(branch(alpha.name).getByTitle(/1 live session/)).toBeVisible();
      await expect(branch(bravo.name).getByTitle(/live session/)).toHaveCount(0);
      // The attention badge, on the project the seeded Request belongs to. Read as "at least the one
      // this spec filed": the badge counts every attention item for that project, and this shared
      // daemon can legitimately carry others — so the DISCRIMINATING claim is bravo's zero beside it.
      const badge = branch(alpha.name).locator(".loom-atlas-nodebadge");
      await expect(badge).toBeVisible();
      expect(Number((await badge.textContent() ?? "0").trim()),
        "the seeded pending Request did not reach alpha's attention badge").toBeGreaterThanOrEqual(1);
      await expect(branch(bravo.name).locator(".loom-atlas-nodebadge"),
        "bravo carries an attention badge, though nothing was seeded against it").toHaveCount(0);
      // The per-row metrics INSIDE the selected branch, each an exact figure this spec seeded.
      await expect(page.getByTestId("atlas-node-/board").locator(".loom-atlas-nodemeta"),
        "the Board row does not read this spec's own open-card count").toHaveText("3");
      await expect(page.getByTestId("atlas-home-agents").locator(".loom-atlas-nodemeta"),
        "the Agents row does not read this spec's own agent count").toHaveText("1");

      // ── CLAIM 1c: the hierarchy's chrome, READ OFF COMPUTED STYLE rather than judged by eye ──
      // Both of these are invisible in a screenshot at any scale (a 2px edge, a 2px origin shift) and
      // both were wrong in the first draft of this card — one of them in the direction that LOOKS
      // right. A PNG cannot adjudicate either, so neither is left to review by eye.
      const rowChrome = (name: string) =>
        tree.locator("div.loom-atlas-noderow.is-branchrow").filter({ hasText: new RegExp(escapeRe(name)) })
          .evaluate((el) => getComputedStyle(el).borderLeftColor);
      // The selected branch carries the phosphor "you are inside this" edge, at the RAIL's own left
      // edge — which is the whole reason `is-open` is mirrored onto the row now that the twist has
      // been hoisted out of the button that used to draw it.
      expect(await rowChrome(alpha.name), "the selected branch row has no phosphor left edge")
        .toBe("rgb(46, 230, 110)");
      // Positive control in the same breath: an unselected row reads transparent, so the above is
      // not simply "every branch row has a coloured border".
      expect(await rowChrome(bravo.name), "an unselected branch row also carries the phosphor edge")
        .toBe("rgba(0, 0, 0, 0)");
      // One text origin for the whole tier: a branch label and a workspace-tier destination label
      // start at the same x, so rows do not step in and out as branches open and close.
      const origins = await tree.evaluate((root) => {
        const left = (sel: string) => root.querySelector(sel)?.getBoundingClientRect().left ?? -1;
        return {
          branch: left("div.loom-atlas-noderow.is-branchrow .loom-atlas-lbl"),
          destination: left('[data-testid="atlas-home-workspace"] .loom-atlas-lbl'),
          child: left('[data-testid="atlas-node-/board"] .loom-atlas-lbl'),
        };
      });
      expect(origins.branch, "no branch label was found to measure").toBeGreaterThan(0);
      expect(origins.branch, "a branch label and a workspace-tier destination label sit on different origins")
        .toBe(origins.destination);
      // ...and a CHILD is genuinely indented from its parent, or the measure above would be
      // satisfied by a tree that had lost its indentation entirely.
      expect(origins.child, "a child row is not indented from its branch").toBeGreaterThan(origins.branch);

      // ── CLAIM 2: expanding the branch you are NOT scoped to changes nothing but the branch ──
      // Before: only the selected project's surfaces are in the tree.
      await expect(twist(alpha.id)).toHaveAttribute("aria-expanded", "true");
      await expect(twist(bravo.id)).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId(`atlas-node-${bravo.id}/board`)).toHaveCount(0);

      const urlBefore = page.url();
      await twist(bravo.id).click();

      // After: bravo's own surfaces exist...
      await expect(twist(bravo.id)).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId(`atlas-node-${bravo.id}/board`),
        "expanding bravo did not reveal its own surfaces").toHaveCount(1);
      // ...and NOTHING else moved: not the selection, not the stored project, not the address, and
      // not the project-scoped page that was already open.
      await expect(selected, "expanding a branch moved the active-project selection").toContainText(alpha.name);
      await expect(page.locator("button.loom-atlas-node.is-branch.is-open"),
        "expanding a branch left two branches reading as selected").toHaveCount(1);
      expect(await page.evaluate((k) => localStorage.getItem(k), PROJECT_KEY),
        "expanding a branch rewrote the persisted active project").toBe(alpha.id);
      expect(page.url(), "expanding a branch changed the address").toBe(urlBefore);
      await expect(card(alphaCard), "expanding a branch re-scoped the open page").toBeVisible();
      await expect(card(bravoCard)).toHaveCount(0);

      // The twist is a real toggle in BOTH directions, including on the SELECTED branch — which is
      // the other half of "expansion is not selection": collapsing what you are scoped to must not
      // unscope you.
      await twist(bravo.id).click();
      await expect(twist(bravo.id)).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId(`atlas-node-${bravo.id}/board`)).toHaveCount(0);
      await twist(alpha.id).click();
      await expect(twist(alpha.id)).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId("atlas-node-/board"),
        "collapsing the selected branch left its surfaces in the tree").toHaveCount(0);
      await expect(selected, "collapsing the selected branch unscoped the page").toContainText(alpha.name);
      await expect(card(alphaCard)).toBeVisible();

      // ── CLAIM 2b: clicking INTO an unselected branch re-scopes to it first ──
      // Without this the row would be a lie: the page it lands on reads the ACTIVE project, so it
      // would render alpha's board under a row that named bravo.
      await twist(bravo.id).click();
      await page.getByTestId(`atlas-node-${bravo.id}/board`).click();
      await expect(card(bravoCard), "a row inside bravo's branch did not re-scope the page to bravo").toBeVisible();
      await expect(card(alphaCard)).toHaveCount(0);
      await expect(selected).toContainText(bravo.name);
      expect(await page.evaluate((k) => localStorage.getItem(k), PROJECT_KEY)).toBe(bravo.id);
      // And exactly one node still reads as landed, with many branches' worth of /board rows in the
      // tree — the reason a row outside the selected branch is a plain <Link> with no isActive.
      await expect(page.locator("a.loom-atlas-node.is-active")).toHaveCount(1);

      // ── CLAIM 3: the workspace tier is the entities, and the ten destinations have left the rows ──
      // The tier's own list, in order, read off the tree: the Workspace home and the Platform node,
      // and nothing else. This is the card's headline claim stated as an equality, so a destination
      // creeping back in fails here even if every absence check below were deleted.
      const tierRoutes = await tree.locator("ul.loom-atlas-nodes").first()
        .locator("> li a.loom-atlas-node")
        .evaluateAll((els) => els.map((el) => new URL((el as HTMLAnchorElement).href).pathname));
      expect(tierRoutes, "the workspace tier is no longer exactly the Workspace home + the Platform node")
        .toEqual(WORKSPACE_TIER);

      const treeRoutes = await tree.locator("a.loom-atlas-node")
        .evaluateAll((els) => els.map((el) => new URL((el as HTMLAnchorElement).href).pathname));
      // POSITIVE CONTROL on that collector before trusting any absence from it: it does see the rows
      // that are genuinely there. A broken selector returns [] and would "prove" every absence below.
      expect(treeRoutes.length, "the tree-row collector found no rows at all").toBeGreaterThan(5);
      for (const kept of WORKSPACE_TIER) {
        expect(treeRoutes, `the tree-row collector missed ${kept}, which deliberately stayed a row`).toContain(kept);
      }
      expect(treeRoutes, "the tree-row collector missed the project-tier Board row").toContain("/board");

      for (const gone of RE_HOMED) {
        expect(treeRoutes, `${gone} is still an Atlas tree row`).not.toContain(gone);
        // Reachability is the other half of the claim: removed from the rows, NOT removed from the
        // app. (Deleting the row and stranding the surface would also satisfy the line above.)
        await expect(page.getByTestId(`atlas-unhomed-${gone}`),
          `${gone} left the tree rows without an escape-hatch entry — it is now unreachable`).toHaveCount(1);
      }
    });

  test("switch OFF: the classic rail renders every destination and no Atlas element is mounted",
    async ({ page, loomDaemon }) => {
      const { alpha, alphaCard } = await seedHierarchy(loomDaemon);
      await pinProject(page, alpha.id);
      await page.goto(loomDaemon.baseURL + "/board");

      // Fixture identity on this side too, so "the rail is unchanged" is asserted on a page that
      // really rendered this spec's own data rather than on an empty or errored shell.
      await expect(page.locator(".loom-rail")).toBeVisible();
      await expect(page.getByText(alphaCard, { exact: true })).toBeVisible();

      // Not one element of the new frame exists — the DoD's own wording. Asserted on the class
      // PREFIX, so a tree row, the escape hatch, the shell and the node head are all covered by one
      // claim rather than by a list of the ones this spec happened to think of.
      await expect(page.locator("[class*='loom-atlas']"),
        "an Atlas element is mounted with the switch off").toHaveCount(0);
      await expect(page.getByTestId("atlas-tree")).toHaveCount(0);
      await expect(page.getByTestId("atlas-shell")).toHaveCount(0);
      await expect(page.getByTestId("atlas-unhomed")).toHaveCount(0);

      // Every NAV_PAGES destination is still a rail link — including the nine this card removed from
      // the Atlas tree, which is the point: the classic shell is untouched by the restructure.
      const nav = parseNavPages();
      expect(nav.paths.length, `the NAV_PAGES parse found no rows. Block:\n${nav.block}`).toBeGreaterThan(0);
      expect(nav.paths.length,
        `the parse returned ${nav.paths.length} row(s) but the declaration contains ${nav.rawMarkers} entries`
        + ` — the pattern is dropping rows. Block:\n${nav.block}`).toBe(nav.rawMarkers);

      const railRoutes = await page.locator(RAIL_LINKS)
        .evaluateAll((els) => els.map((el) => new URL((el as HTMLAnchorElement).href).pathname));
      expect([...new Set(railRoutes)].sort(), "the classic rail no longer renders exactly the declared destinations")
        .toEqual([...nav.paths].sort());
      for (const gone of RE_HOMED) {
        if (gone === "/workspace-settings") {
          // The one Atlas-ONLY address in that list: it must NOT be in the classic rail, or a user who
          // never opted in would see a second Settings row.
          expect(railRoutes, "the Atlas-only workspace Settings node leaked into the classic rail")
            .not.toContain(gone);
          continue;
        }
        expect(railRoutes, `the classic rail lost ${gone}, which only the ATLAS tree re-homed`).toContain(gone);
      }
    });
});

