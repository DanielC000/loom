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
// ⚠️ `/terminals` LEFT this list with card 25c08fba, which took it DOWN to project depth as the
// project node's "Sessions" tab. It stays out: this list's members are all resolved below as either
// a WORKSPACE node tab or a retirement, and a PROJECT node tab (card ec1aa18e's bucket, which that
// card's own spec — atlas-tree.spec.ts — partitions exhaustively) is neither. Card 41eab0eb's seven
// STAY here, because a Workspace node TAB is still not a row, and so do card 5afd71bd's two RETIRED
// ones, which are not a row either — which is what the tab/retired split below records.
const RE_HOMED = [
  "/", "/inbox", "/gates", "/projects", "/actors", "/companion", "/automation", "/usage",
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

// The retired destinations (card 5afd71bd), `from` → the node that absorbed them, with the same
// raw-marker control as the tab parse above: a regex that quietly stopped matching a row hands back a
// plausible SUBSET, and a subset reads exactly like a complete list.
function retirementsUnderTest(): Map<string, string> {
  const src = readFileSync(NAV_SOURCE, "utf8");
  const start = src.indexOf("export const ATLAS_RETIREMENTS");
  if (start < 0) throw new Error(`no ATLAS_RETIREMENTS declaration found in ${NAV_SOURCE}`);
  const end = src.indexOf("\n];", start);
  if (end < 0) throw new Error(`ATLAS_RETIREMENTS in ${NAV_SOURCE} has no closing "];"`);
  const block = src.slice(start, end);
  const rawMarkers = (block.match(/\bfrom:\s*"/g) ?? []).length;
  const rows = [...block.matchAll(/\bfrom:\s*"([^"]+)",\s*to:\s*"([^"]+)"/g)]
    .map((m) => ({ from: m[1] ?? "", to: m[2] ?? "" }));
  expect(rows.length, `the ATLAS_RETIREMENTS parse found no rows. Block:\n${block}`).toBeGreaterThan(0);
  expect(rows.length,
    `the parse returned ${rows.length} row(s) but the declaration contains ${rawMarkers} entries`
    + ` — the pattern is dropping rows. Block:\n${block}`).toBe(rawMarkers);
  return new Map(rows.map((r) => [r.from, r.to]));
}

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
          child: left('[data-testid="atlas-node-/overview"] .loom-atlas-lbl'),
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
      await expect(page.getByTestId(`atlas-node-${bravo.id}/overview`)).toHaveCount(0);

      const urlBefore = page.url();
      await twist(bravo.id).click();

      // After: bravo's own surfaces exist...
      await expect(twist(bravo.id)).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId(`atlas-node-${bravo.id}/overview`),
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
      await expect(page.getByTestId(`atlas-node-${bravo.id}/overview`)).toHaveCount(0);
      await twist(alpha.id).click();
      await expect(twist(alpha.id)).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId("atlas-node-/overview"),
        "collapsing the selected branch left its surfaces in the tree").toHaveCount(0);
      await expect(selected, "collapsing the selected branch unscoped the page").toContainText(alpha.name);
      await expect(card(alphaCard)).toBeVisible();

      // ── CLAIM 2b: clicking INTO an unselected branch re-scopes to it first ──
      // Without this the row would be a lie: the page it lands on reads the ACTIVE project, so it
      // would render alpha's board under a row that named bravo.
      await twist(bravo.id).click();
      await page.getByTestId(`atlas-node-${bravo.id}/overview`).click();
      await expect(card(bravoCard), "a row inside bravo's branch did not re-scope the page to bravo").toBeVisible();
      await expect(card(alphaCard)).toHaveCount(0);
      await expect(selected).toContainText(bravo.name);
      expect(await page.evaluate((k) => localStorage.getItem(k), PROJECT_KEY)).toBe(bravo.id);
      // And exactly one node still reads as landed, with many branches' worth of /overview rows in
      // the tree — the reason a row outside the selected branch is a plain <Link> with no isActive.
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
      // The floor is the two workspace-tier rows the WORKSPACE_TIER loop below then names one by
      // one, plus the selected branch's own two (Home and Overview) — four, since card ec1aa18e took
      // the project node's tabs out of the tree. Expressed against WORKSPACE_TIER so the first half
      // tracks that list rather than a number typed here.
      expect(treeRoutes.length, "the tree-row collector found no rows at all")
        .toBeGreaterThanOrEqual(WORKSPACE_TIER.length + 2);
      for (const kept of WORKSPACE_TIER) {
        expect(treeRoutes, `the tree-row collector missed ${kept}, which deliberately stayed a row`).toContain(kept);
      }
      expect(treeRoutes, "the tree-row collector missed the project-tier Overview row").toContain("/overview");
      // Card ec1aa18e's own claim, in the same collector: a destination the project node carries as
      // a TAB is no longer a row either. The Board is the specimen, and the line above is its
      // positive control — the collector plainly does see a project-tier row.
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
      // ...and which of them is RETIRED outright (card 5afd71bd) — the third answer, parsed from its
      // own declaration the same way. A retired address is neither a row nor a tab nor a hatch entry:
      // it redirects to the node that absorbed it, which is what its leg below asserts instead of
      // reachability.
      const retiredTo = retirementsUnderTest();
      // The two branches that still have members must actually RUN, or one of them is an untested
      // claim hiding behind a list that happens to be all one kind.
      expect(RE_HOMED.filter((r) => tabFor.has(r)).length,
        "no re-homed destination is a Workspace node tab, so that branch never runs").toBeGreaterThan(0);
      expect(RE_HOMED.filter((r) => retiredTo.has(r)).length,
        "no re-homed destination is retired, so that branch never runs").toBeGreaterThan(0);
      // The hatch branch has NO members left, deliberately: card 5afd71bd retired the last two
      // destinations that were in it and deleted the disclosure with them. Asserted rather than left
      // implicit, so the dead branch is a stated fact instead of looking like a collector that broke.
      // ⛔ Do NOT "fix" a future red here by re-adding a hatch — decide the new destination's
      // placement (a tree row, a node tab, or a retirement) the way this card's own card did.
      expect(RE_HOMED.filter((r) => !tabFor.has(r) && !retiredTo.has(r)),
        "a re-homed destination is neither a node tab nor retired, and the escape hatch that used to"
        + " hold such a destination no longer exists — so it is unreachable").toEqual([]);

      // The Workspace node is where a tab can be seen at all; the tree is identical on every route.
      await page.goto(loomDaemon.baseURL + "/home");
      await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();

      for (const gone of RE_HOMED) {
        expect(treeRoutes, `${gone} is still an Atlas tree row`).not.toContain(gone);
        // The other half of the claim depends on which answer the destination got. For a RE-HOMED one
        // it is reachability: removed from the rows, NOT removed from the app (deleting the row and
        // stranding the surface would also satisfy the line above). For a RETIRED one there is nothing
        // left to reach by design, so the claim is that the address LANDS on the node that absorbed
        // it rather than on the catch-all — which is the same guarantee in the only form it can take
        // once the destination itself is gone.
        const key = tabFor.get(gone);
        const to = retiredTo.get(gone);
        if (key) {
          await expect(page.getByTestId(`atlas-tab-${key}`),
            `${gone} left the tree rows without a Workspace node tab — it is now unreachable`).toHaveCount(1);
          await expect(page.getByTestId(`atlas-unhomed-${gone}`),
            `${gone} is a node tab and STILL an escape-hatch entry`).toHaveCount(0);
        } else if (to) {
          await page.goto(loomDaemon.baseURL + gone);
          await expect(page.getByTestId("atlas-shell")).toBeVisible();
          await expect(page.getByTestId("atlas-empty"),
            `the retired ${gone} fell through to the Atlas catch-all instead of redirecting`).toHaveCount(0);
          await expect(page, `the retired ${gone} did not redirect to ${to}`)
            .toHaveURL(loomDaemon.baseURL + to);
          await expect(page.getByTestId(`atlas-unhomed-${gone}`),
            `${gone} is retired and STILL an escape-hatch entry`).toHaveCount(0);
          // Back to the Workspace node, which is where the tab assertions above are readable, so the
          // loop's remaining iterations are not reading a tab row that is not on the page.
          await page.goto(loomDaemon.baseURL + "/home");
          await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();
        }
        // No third branch: the control above has already required this list to be exhaustively
        // covered by the two, so an uncovered member fails there rather than silently skipping here.
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

