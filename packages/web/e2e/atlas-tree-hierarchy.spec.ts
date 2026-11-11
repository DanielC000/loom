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
//   2. EXPANSION IS NOT SELECTION. Opening the branch of the project you are NOT scoped to reveals
//      what is running in it and leaves the active project, the address and the open page's own data
//      alone. Then clicking the ROW re-scopes — and, since card 4a0ad464 removed the branch's `Home`
//      row, also navigates to that project's node, which is the only address its branch has left.
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
import { cssColor } from "./helpers/themeToken";

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
// ⚠️ `/terminals` LEFT this list with card 25c08fba, which took it DOWN to project depth as the
// project node's "Sessions" tab. It stays out: this list's members are all resolved below as a
// WORKSPACE node tab, and a PROJECT node tab (card ec1aa18e's bucket, which atlas-tree.spec.ts
// partitions exhaustively) is not one. Card 5afd71bd's two RETIRED members (`/`, `/projects`) left this
// list when card acbb6df6 deleted their pages; their redirects are atlas-legacy-redirects.spec.ts's.
const RE_HOMED = [
  "/inbox", "/gates", "/actors", "/companion", "/automation", "/usage",
  // The Atlas-only workspace Settings node (card 595e2a47) — a `ROOT_TABS` row in the approved design,
  // so it re-homes with the nine rail destinations above rather than staying the tier's footer.
  "/workspace-settings",
];

// Where each of them ACTUALLY lives now. Card 0d0c6cee put all ten in the escape hatch; card 41eab0eb
// then made seven of them Workspace node TABS, which is a different control with a different mark.
// This card's own claim is unchanged either way — they are not tree ROWS — so the split below governs
// only the REACHABILITY half, which is what stops "removed from the rows" being satisfiable by
// stranding the surface.
//
// Card 5afd71bd then RETIRED the last two — Mission Control and Projects — and deleted the hatch
// with them, so the split is now tab-or-retired and the hatch branch is empty by construction.
//
// Derived, not hand-split: the tab set is parsed from the real `WORKSPACE_NODE_TABS` declaration and
// the retired set from `ATLAS_RETIREMENTS`, so a card that changes one of these answers moves a
// destination between the branches by editing src/nav.tsx alone.
function parseWorkspaceNodeTabs(): { rows: { key: string; from: string }[]; rawMarkers: number; block: string } {
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

// The rows that deliberately STAYED at the workspace tier, IN ORDER: the tier's own home, the
// Terminals node, and the reserved Platform home — which the mockup pins "above the project list in
// the tree, not inside it" because it is a sibling ENTITY of the projects (a home with its own
// agents), not a surface of them.
//
// ⭐ THE ORDER IS THE CLAIM, not incidental to it. Card b439c2dc is the owner's own placement —
// "In the left sidebar place it between home and Platform" — and the `toEqual` below is the only
// assertion in the suite that pins it: a Terminals row that drifted above Home or below Platform
// would satisfy every containment check in this file and still be the wrong sidebar.
const WORKSPACE_TIER = ["/home", "/workspace-terminals", "/platform"];

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
      const { alpha, bravo, alphaCard, bravoCard, live } = await seedHierarchy(loomDaemon);

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
      // The per-row metrics that used to sit INSIDE the selected branch — the Board row's open-card
      // count and the Agents row's agent count — went with their rows (card ec1aa18e): both rows
      // were project node TABS the tree was duplicating, and both figures are on that node's own KPI
      // strip. So the branch now carries NO row metric at all, which is asserted rather than left
      // implicit — a figure reappearing here would mean a tab row had crept back in.
      await expect(page.locator("ul.loom-atlas-nodes.is-kids .loom-atlas-nodemeta"),
        "a row inside a project branch carries a metric again").toHaveCount(0);
      // ...with the positive control the absence needs: the collector DOES see the metrics that are
      // still there, one tier up on the project row itself.
      await expect(branch(alpha.name).locator(".loom-atlas-live"),
        "the metric collector finds nothing anywhere, so the zero above proves nothing").toHaveCount(1);

      // ── CLAIM 1c: the hierarchy's chrome, READ OFF COMPUTED STYLE rather than judged by eye ──
      // Both of these are invisible in a screenshot at any scale (a 2px edge, a 2px origin shift) and
      // both were wrong in the first draft of this card — one of them in the direction that LOOKS
      // right. A PNG cannot adjudicate either, so neither is left to review by eye.
      const rowChrome = (name: string) =>
        tree.locator("div.loom-atlas-noderow.is-branchrow").filter({ hasText: new RegExp(escapeRe(name)) })
          .evaluate((el) => getComputedStyle(el).borderLeftColor);
      // The selected branch carries the accent "you are inside this" edge (Graphite: cobalt, since green
      // means live only), at the RAIL's own left edge — which is the whole reason `is-open` is mirrored
      // onto the row now that the twist has been hoisted out of the button that used to draw it.
      expect(await rowChrome(alpha.name), "the selected branch row has no accent left edge")
        .toBe(await cssColor(page, "--loom-accent"));
      // Positive control in the same breath: an unselected row reads transparent, so the above is
      // not simply "every branch row has a coloured border".
      expect(await rowChrome(bravo.name), "an unselected branch row also carries the accent edge")
        .toBe("rgba(0, 0, 0, 0)");
      // One text origin for the whole tier: a branch label and a workspace-tier destination label
      // start at the same x, so rows do not step in and out as branches open and close.
      // Card 4a0ad464 removed every page row from a project branch, so the CHILD measured here is
      // alpha's own live session row — what a branch holds now. (Its label sits on the same origin a
      // page row's did: that is this spec's own claim one tier down, in atlas-tree-entities.)
      const origins = await tree.evaluate((root, sessionId) => {
        const left = (sel: string) => root.querySelector(sel)?.getBoundingClientRect().left ?? -1;
        return {
          branch: left("div.loom-atlas-noderow.is-branchrow .loom-atlas-lbl"),
          destination: left('[data-testid="atlas-home-workspace"] .loom-atlas-lbl'),
          child: left(`[data-testid="atlas-session-${sessionId}"] .loom-atlas-lbl`),
        };
      }, live.sessionId);
      expect(origins.branch, "no branch label was found to measure").toBeGreaterThan(0);
      expect(origins.branch, "a branch label and a workspace-tier destination label sit on different origins")
        .toBe(origins.destination);
      // ...and a CHILD is genuinely indented from its parent, or the measure above would be
      // satisfied by a tree that had lost its indentation entirely.
      expect(origins.child, "a child row is not indented from its branch").toBeGreaterThan(origins.branch);

      // ── CLAIM 2: expanding the branch you are NOT scoped to changes nothing but the branch ──
      // Before: bravo's branch contributes nothing to the tree. Its own content since card 4a0ad464
      // is what is RUNNING in it — nothing, here — so what a reader sees on expanding it is that
      // card's idle line, which is also the one row in this branch a locator can hold.
      await expect(twist(alpha.id)).toHaveAttribute("aria-expanded", "true");
      await expect(twist(bravo.id)).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId(`atlas-branch-idle-${bravo.id}`)).toHaveCount(0);

      const urlBefore = page.url();
      await twist(bravo.id).click();

      // After: bravo's own branch content exists...
      await expect(twist(bravo.id)).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId(`atlas-branch-idle-${bravo.id}`),
        "expanding bravo revealed nothing at all, not even its empty-branch line").toHaveCount(1);
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
      await expect(page.getByTestId(`atlas-branch-idle-${bravo.id}`)).toHaveCount(0);
      await twist(alpha.id).click();
      await expect(twist(alpha.id)).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId(`atlas-session-${live.sessionId}`),
        "collapsing the selected branch left its session rows in the tree").toHaveCount(0);
      await expect(selected, "collapsing the selected branch unscoped the page").toContainText(alpha.name);
      await expect(card(alphaCard)).toBeVisible();

      // ── CLAIM 2b: the project ROW is the node's address, and re-scoping still comes first ──
      // ⭐ CARD 4a0ad464. The branch's `Home` row was the project node's only address in the tree, and
      // this card removed it as a page row the node's own tab row already carries — so the row has to
      // supply that destination or the node is unreachable from the tree it heads. RED before that
      // card: the row re-scoped in place and the address never moved, whatever you were looking at.
      //
      // The rule has TWO halves and both are asserted here, because each is what keeps the other
      // honest: the row takes you to the node, EXCEPT where clicking it has real work of its own to
      // do — re-scoping one of the node's own tabs, which is project-agnostic and reads the active
      // project. Yanking a reader off the Board for picking a different project would lose the
      // surface they deliberately chose; never navigating at all would have made the node
      // unreachable, and would make a click on your OWN row from a tab do nothing whatsoever.

      // (i) FROM A TAB, A DIFFERENT PROJECT: re-scope in place, address unmoved. The older contract
      //     (card e47df20a), still load-bearing — the page reads the ACTIVE project, so without the
      //     re-scope the board would render alpha's cards under a row that named bravo.
      await page.getByTestId("atlas-tab-board").click();
      await expect(page).toHaveURL(/\/board$/);
      await branch(bravo.name).click();
      await expect(page, "clicking another project's row left the tab the reader was on")
        .toHaveURL(/\/board$/);
      await expect(card(bravoCard), "the row did not re-scope the board it left you on").toBeVisible();
      await expect(card(alphaCard)).toHaveCount(0);
      await expect(selected).toContainText(bravo.name);
      expect(await page.evaluate((k) => localStorage.getItem(k), PROJECT_KEY)).toBe(bravo.id);

      // (ii) FROM A TAB, THE PROJECT YOU ARE ALREADY IN: nothing to re-scope, so the row navigates
      //      to the node rather than doing nothing at all.
      await branch(bravo.name).click();
      await expect(page, "clicking the row you are already scoped to from one of its tabs did nothing")
        .toHaveURL(/\/project$/);
      await expect(page.getByTestId("atlas-project-name")).toHaveText(bravo.name);

      // (iii) FROM ANYWHERE THAT IS NOT ONE OF THE NODE'S TABS: always the node.
      await page.getByTestId("atlas-home-workspace").click();
      await expect(page).toHaveURL(/\/home$/);
      await branch(alpha.name).click();
      await expect(page, "clicking a project row from off the node did not open that node")
        .toHaveURL(/\/project$/);
      await expect(page.getByTestId("atlas-project-name"),
        "the project node did not re-scope to the row that was clicked").toHaveText(alpha.name);

      // The landed mark is the project ROW's `aria-current` now — a <button>, so the anchor-scoped
      // `is-active` class this claim used to read cannot carry it — and exactly one row has it.
      await expect(page.getByTestId("atlas-project-node")).toHaveAttribute("aria-current", "true");
      await expect(page.locator('button.loom-atlas-node[aria-current="true"]'),
        "more than one project row reads as the branch you are inside").toHaveCount(1);

      // ── CLAIM 3: the workspace tier is the entities, and the ten destinations have left the rows ──
      // The tier's own list, in order, read off the tree — `WORKSPACE_TIER` above, and nothing else.
      // This is the card's headline claim stated as an equality, so a destination creeping back in
      // fails here even if every absence check below were deleted.
      const tierRoutes = await tree.locator("ul.loom-atlas-nodes").first()
        .locator("> li a.loom-atlas-node")
        .evaluateAll((els) => els.map((el) => new URL((el as HTMLAnchorElement).href).pathname));
      expect(tierRoutes,
        "the workspace tier is no longer exactly the Workspace home, the Terminals node and the Platform node, in that order")
        .toEqual(WORKSPACE_TIER);

      const treeRoutes = await tree.locator("a.loom-atlas-node")
        .evaluateAll((els) => els.map((el) => new URL((el as HTMLAnchorElement).href).pathname));
      // POSITIVE CONTROL on that collector before trusting any absence from it: it does see the rows
      // that are genuinely there. A broken selector returns [] and would "prove" every absence below.
      // The floor is exactly the workspace tier now — card ec1aa18e took the project node's tabs out
      // of the tree and card 4a0ad464 took its last two page rows (`Home`, `Overview`), so a project
      // branch contributes NO destination anchor at all. Expressed against WORKSPACE_TIER rather
      // than as a number typed here.
      expect(treeRoutes.length, "the tree-row collector found no rows at all")
        .toBeGreaterThanOrEqual(WORKSPACE_TIER.length);
      for (const kept of WORKSPACE_TIER) {
        expect(treeRoutes, `the tree-row collector missed ${kept}, which deliberately stayed a row`).toContain(kept);
      }
      // Card 4a0ad464's own claim, in the same collector: the project tier's last page row is gone.
      // The WORKSPACE_TIER loop immediately above is its positive control — the collector plainly
      // does see the rows that stayed.
      expect(treeRoutes, "the project-tier Overview row is back, which card 4a0ad464 removed")
        .not.toContain("/overview");
      // Card ec1aa18e's own claim, same collector: a destination the project node carries as a TAB
      // is no longer a row either. The Board is that card's specimen.
      expect(treeRoutes, "the Board is a project-branch row again, which card ec1aa18e removed")
        .not.toContain("/board");

      // Which of them is a Workspace node TAB and which is still an escape-hatch entry.
      const tabs = parseWorkspaceNodeTabs();
      expect(tabs.rows.length, `the WORKSPACE_NODE_TABS parse found no rows. Block:\n${tabs.block}`)
        .toBeGreaterThan(0);
      expect(tabs.rows.length,
        `the parse returned ${tabs.rows.length} row(s) but the declaration contains ${tabs.rawMarkers}`
        + ` entries — the pattern is dropping rows. Block:\n${tabs.block}`).toBe(tabs.rawMarkers);
      const tabFor = new Map(tabs.rows.map((r) => [r.from, r.key]));
      // Every re-homed destination must be a Workspace node TAB — the escape hatch that used to hold
      // the others is deleted (card 5afd71bd), and the two it retired went with card acbb6df6.
      // ⛔ Do NOT "fix" a future red here by re-adding a hatch — decide the new destination's placement.
      expect(RE_HOMED.filter((r) => !tabFor.has(r)),
        "a re-homed destination is not a Workspace node tab, and nothing else can hold it — so it is"
        + " unreachable").toEqual([]);

      // The Workspace node is where a tab can be seen at all; the tree is identical on every route.
      await page.goto(loomDaemon.baseURL + "/home");
      await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();

      for (const gone of RE_HOMED) {
        expect(treeRoutes, `${gone} is still an Atlas tree row`).not.toContain(gone);
        // Removed from the rows, NOT removed from the app: deleting the row and stranding the surface
        // would also satisfy the line above, so the tab that now holds it must be there.
        const key = tabFor.get(gone);
        await expect(page.getByTestId(`atlas-tab-${key}`),
          `${gone} left the tree rows without a Workspace node tab — it is now unreachable`).toHaveCount(1);
        await expect(page.getByTestId(`atlas-unhomed-${gone}`),
          `${gone} is a node tab and STILL an escape-hatch entry`).toHaveCount(0);
      }
    });
});

