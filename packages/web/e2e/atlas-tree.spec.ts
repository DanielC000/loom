// The Atlas entity tree (card 8cbb2ac2, Atlas build plan P1-1 —
// docs/plans/atlas-ui/03-decomposition.md row P1-1).
//
// The card's claim is a PARITY claim — "every NAV_PAGES entry gets a tree node, and clicking it
// renders the EXISTING component unmodified" — so every assertion here is derived from the live app
// rather than from a list typed into this file:
//   1. REACHABILITY PARITY. The destinations are collected from the CLASSIC rail (switch off) and
//      from the Atlas tree (switch on), in the same browser, against the same build, and the two sets
//      are compared. Nothing hand-copies NAV_PAGES — which matters because the whole failure mode
//      this guards is a count going stale, and a hand-copied list in the test would go stale
//      identically. Since card fd99b2d7 the tree also holds Atlas-ONLY nodes the rail has no
//      equivalent of, and since card 0d0c6cee the ten cross-project destinations are no longer tree
//      rows at all. Card 41eab0eb then made seven of those WORKSPACE NODE TABS, leaving two in the
//      escape hatch at the foot of the tree (card 25c08fba took `/terminals` the other way, down to
//      project depth as a tree ROW again). So the claim is a PARTITION: every rail destination is in
//      EXACTLY ONE Atlas placement, never two and never none — and every extra node is a declared
//      Atlas home. See `parseAtlasHomes` and `parseWorkspaceNodeTabs` below for why that is no
//      weaker than an equality. Card 4a0ad464 added the SIXTH and last placement, PAGE-ONLY — see
//      `PAGE_ONLY_DESTINATIONS` below for what it is and why it is not a fallback bucket.
//   2. CONTENT IDENTITY. For every one of those destinations, the page's rendered structure is
//      fingerprinted at the OLD route (switch off) and again after reaching it under Atlas (switch
//      on), and required to match. "The same content the old route rendered" is asserted against the
//      old route itself, not against a marker someone decided was characteristic of it. A destination
//      a PHASE-2 card has deliberately rebuilt asserts the INVERSE instead — see REBUILT_IN_PHASE_2.
//      A node-TAB destination is fingerprinted at its own `atlas-tabpanel-<key>` wrapper rather than
//      at `main`: card 41eab0eb re-FRAMED those pages without rebuilding them, so the identity claim
//      still holds exactly — it just has to be made about the panel the component is mounted in.
//   3. KEYBOARD. Tab reaches the nodes in document order, Enter activates one, and the focused node
//      carries a real computed focus ring.
//
// Every absence/equality claim carries a POSITIVE CONTROL: a fingerprint comparison and a
// zero-console-error count read exactly the same whether the instrument works or is silently broken,
// so each is first shown firing against a known-bad state on the same page at the same moment.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "./fixtures/daemon";
import { nodeTabKeys } from "./helpers/nodeTabs";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json), so a spec
// cannot pull a `src/` module in — the same reason fixtures/daemon.ts hardcodes its own keys.
const ATLAS_KEY = "loom.atlasUi";
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

// ── The FOURTH home a destination can have — none at all (card 5afd71bd) ───────────────────────
// Mission Control and the Projects page are RETIRED: the approved design dissolves them rather than
// re-homing them, so under Atlas each address REDIRECTS to the node that absorbed its surfaces and
// has no tree row, no tab and no hatch entry. That makes the partition below FOUR-way, and it is the
// card that DELETED the hatch — so the hatch bucket, which used to carry a "> 0" positive control, is
// now asserted EMPTY instead. Its disjunct is kept rather than removed so a destination that fell
// back into a re-added hatch would still be counted somewhere and fail the "exactly one" claim.
//
// Parsed from the same source, the same way, with the same raw-marker control. Keyed `from` → `to`,
// because the landing matters here: a retired address must reach the node that absorbed it, not
// merely vanish.
type Retirement = { from: string; to: string };

function parseRetirements(): { rows: Retirement[]; rawMarkers: number; block: string } {
  const src = readFileSync(NAV_SOURCE, "utf8");
  const start = src.indexOf("export const ATLAS_RETIREMENTS");
  if (start < 0) throw new Error(`no ATLAS_RETIREMENTS declaration found in ${NAV_SOURCE}`);
  const end = src.indexOf("\n];", start);
  if (end < 0) throw new Error(`ATLAS_RETIREMENTS in ${NAV_SOURCE} has no closing "];"`);
  const block = src.slice(start, end);
  const rawMarkers = (block.match(/\bfrom:\s*"/g) ?? []).length;
  const rows = [...block.matchAll(/\bfrom:\s*"([^"]+)",\s*to:\s*"([^"]+)"/g)]
    .map((m) => ({ from: m[1] ?? "", to: m[2] ?? "" }));
  return { rows, rawMarkers, block };
}

function retirementsUnderTest(): Map<string, string> {
  const { rows, rawMarkers, block } = parseRetirements();
  expect(rows.length, `the ATLAS_RETIREMENTS parse found no rows. Block:\n${block}`).toBeGreaterThan(0);
  expect(rows.length,
    `the parse returned ${rows.length} row(s) but the declaration contains ${rawMarkers} entries`
    + ` — the pattern is dropping rows. Block:\n${block}`).toBe(rawMarkers);
  return new Map(rows.map((r) => [r.from, r.to]));
}

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// ── Derived destination lists ──────────────────────────────────────────────────────────────────
// The classic rail renders one NavLink per NAV_PAGES entry: the grouped nav rows, plus Settings,
// which the rail pulls out into its footer as a `statrow`. Both are anchors; the footer's Alerts row
// is a <button> with no href, so it is excluded by construction rather than by a filter.
const RAIL_LINKS = "a.loom-rail-item, a.loom-rail-statrow";
const TREE_NODES = "a.loom-atlas-node";
// The escape hatch that stood at the foot of the tree (card 0d0c6cee): the cross-project destinations
// that had LEFT the tree pending cards 41eab0eb / 25c08fba / 5afd71bd. The LAST of those deleted the
// disclosure, so this collector now reads ZERO by construction — and that is exactly why it is kept:
// it is what pins the hatch as gone, and keeps a re-added one from quietly becoming a destination's
// "home" again. Deliberately NOT `.loom-atlas-node`, which is what it never was.
const UNHOMED_LINKS = "a.loom-atlas-unhomed-link";

// ── The SIXTH placement: a destination Atlas keeps as a PAGE but gives no navigation to ─────────
// Card 4a0ad464. The owner read the per-project page rows as redundant with the node's own tab row
// — verbatim: "projects tree on the sidebar show the pages instead of the running agent. We have
// the pages as tabs now. I doubt we need to have the tabs for each project in the sidebar too." —
// so `/overview`'s tree row went with the branch's `Home` row.
//
// It is NOT retired: its address still routes, under BOTH shells, and `SetupWizard` still lands a
// freshly-created project on it. It is NOT a node tab: the project node's own Overview tab is a
// different component. It is simply reachable by URL and not by the tree.
//
// ⛔ THIS IS A NAMED LIST, NOT A FALLBACK. One entry, spelled out, so a destination that falls out
// of the tree by ACCIDENT still fails the partition below — which is exactly what card 5afd71bd's
// own record demands ("never re-add a fallback row"; the same reasoning applies to a fallback
// BUCKET). A second entry here is a design decision someone has to make on purpose.
const PAGE_ONLY_DESTINATIONS = ["/overview"];

// ── Destinations PHASE 2 has deliberately rebuilt ──────────────────────────────────────────────
// Claim 2 above ("the same content the old route rendered") is a PHASE-1 contract: phase 1 mounts
// every destination's existing component verbatim, so content identity is exactly what proves nothing
// was rebuilt. Phase 2 then rebuilds specific destinations behind the same switch, and for those the
// identity check inverts — it is the DIFFERENCE that is now correct, and an equality would mean the
// rebuild never reached the Atlas shell.
//
// So a rebuilt destination is not skipped: its row below asserts the opposite, and every frame check
// (it navigated, the heading filled, exactly one node is active) still runs on it. Keeping the
// assertion rather than the exclusion is what stops this set from quietly becoming "the destinations
// we no longer check".
//
// ⛔ Add a route here ONLY with the phase-2 card that rebuilds it. A route added to silence a red is a
// regression being filed as an exemption.
const REBUILT_IN_PHASE_2: Record<string, string> = {
  // Card c07ff42a (P2-4): the Platform node became a five-tab node (Home / Cadence / History / Board /
  // Findings) carrying both editions, replacing the single-column stack the classic page still renders.
  "/platform": "c07ff42a — rebuilt as the five-tab Platform node",
  // Card e2af6ad7 (P2-6): the Companion node carries its three modes (Chat / Manage / Terminal) on its
  // own `?tab=`, with Manage's twelve sections on a nested `?sec=`, replacing the one bordered card the
  // classic page still renders. Only THIS map — no legacy redirect targets /companion, so naming it in
  // atlas-legacy-redirects.spec.ts's own copy would fail that spec's positive control.
  "/companion": "e2af6ad7 — rebuilt as the Companion node's Chat / Manage / Terminal tabs",
  // Card 595e2a47 (P2-12): under Atlas, /settings is the PROJECT tier's Settings node and carries
  // only the project-scoped sections; the daemon-global ones moved to the Workspace tier's own
  // /workspace-settings node. The classic page still renders both halves in one column. Same
  // one-map-only reasoning as /companion above — no legacy redirect targets /settings either.
  "/settings": "595e2a47 — split by scope; the daemon-global sections moved to /workspace-settings",
  // Card 25c08fba: these six are now TABS on the project node. Each keeps its own address, and that
  // address renders the node — the tab row, the node's counts, and the page itself as the tab body —
  // where the classic shell still renders the bare page. (`/settings` above is in this set too; its
  // own entry already inverts the comparison, so it needs no second row.) `/agents` is re-homed with
  // them but is Atlas-ONLY, so it is not a rail destination this walk visits and must NOT be named
  // here — the positive control above would reject it.
  "/board": "25c08fba — a tab on the project node, under its tab row and counts",
  "/terminals": "25c08fba — re-homed as the project node's Sessions tab, at project depth",
  "/repository": "25c08fba — a tab on the project node, under its tab row and counts",
  "/memory": "25c08fba — a tab on the project node, under its tab row and counts",
  "/runs": "25c08fba — a tab on the project node, under its tab row and counts",
  "/archive": "25c08fba — a tab on the project node, under its tab row and counts",
  // Card a7f23a2f: these three carry their OWN title/description block, which the Atlas frame now
  // suppresses because its crumbs, node head and tab row already name the node — so their Atlas
  // rendering is the classic one MINUS that block, and identity here would mean the suppression never
  // happened. (`/memory` is the fourth such page; its 25c08fba row above already inverts it, and one
  // inversion per path is all this map can express. The other eight pages mounted in the frame carry
  // no identity block at all, so that card leaves their comparison exact.)
  // (/gates diverges TWICE over, and one row is all this map can express: card 5968d7e0 also drops
  // the page's two occupancy lamps inside the frame, because the node's own KPI strip carries
  // running·queued on that same tab row. The classic page keeps head and lamps both.)
  "/gates": "a7f23a2f + 5968d7e0 — the frame names the node and carries its occupancy, so the page drops its own <h1>, subtitle and lamps",
  "/inbox": "a7f23a2f — the frame names the node, so the page drops its own name above its tab row",
  // `/projects` was card a7f23a2f's fourth such page and had a row here. Card 5afd71bd RETIRED it, so
  // under Atlas the address no longer renders that page AT ALL — it redirects — and the walk below
  // takes it down its own retired branch, which makes the same inverted comparison plus the redirect
  // and landed-node claims this map cannot express. A row left here would therefore never run, which
  // is precisely the silent-carve-out this map's positive control exists to catch.
};

async function routesFrom(page: Page, selector: string): Promise<string[]> {
  const hrefs = await page.locator(selector).evaluateAll((els) =>
    els.map((el) => new URL((el as HTMLAnchorElement).href).pathname),
  );
  return [...hrefs].sort();
}

// ── The page fingerprint ───────────────────────────────────────────────────────────────────────
// Serializes the structure of whatever the route table rendered: every element under <main>, to a
// bounded depth, as tag + class list (source order) + role. NO text, NO ids, NO inline styles — so
// live data (counts, timestamps, session names, a react-query refetch landing mid-capture) cannot
// move it, while a genuinely different page still does.
//
// The depth cap is what makes this usable across all 17 destinations: the volatile parts of these
// pages are their deep row lists, and a page's identity is already unambiguous from its top few
// levels of panels. Capping trades fidelity nobody needs for stability this comparison does need.
const FINGERPRINT_DEPTH = 4;

// `root` is what the page's own content hangs off. `main` under the classic shell and under an Atlas
// node that owns the whole column; a `atlas-tabpanel-<key>` wrapper for a destination card 41eab0eb
// re-homed as a Workspace node TAB — its component is mounted verbatim inside that wrapper, so
// walking the wrapper's CHILDREN produces the exact string the classic `main` walk produces, and the
// identity claim survives the re-frame instead of being weakened to "it rendered something".
async function pageSkeleton(page: Page, maxDepth: number, root = "main"): Promise<string> {
  return page.evaluate(([depthCap, rootSelector]) => {
    const out: string[] = [];
    const describe = (el: Element) => {
      const raw = typeof el.className === "string" ? el.className.trim() : "";
      const cls = raw ? "." + raw.split(/\s+/).join(".") : "";
      const role = el.getAttribute("role");
      return el.tagName.toLowerCase() + cls + (role ? "[role=" + role + "]" : "");
    };
    const walk = (el: Element, depth: number) => {
      out.push("  ".repeat(depth) + describe(el));
      // An <svg>'s interior says nothing about page structure and would redden this spec for an
      // unrelated icon tweak; the svg ELEMENT is still recorded.
      if (depth >= depthCap || el.tagName.toLowerCase() === "svg") return;
      for (const child of Array.from(el.children)) walk(child, depth + 1);
    };
    const host = document.querySelector(rootSelector as string);
    if (host) for (const child of Array.from(host.children)) walk(child, 0);
    return out.join("\n");
  }, [maxDepth, root] as const);
}

// These pages have async pieces (every panel is a react-query read), so a fingerprint taken straight
// after a navigation is a coin flip on which of them have resolved — measured on P1-0's own shell
// fingerprint, where two identical runs disagreed. Sample until two consecutive reads agree.
const SETTLE_INTERVAL_MS = 300;
const SETTLE_MAX_SAMPLES = 20;

async function settledPageSkeleton(page: Page, root = "main"): Promise<string> {
  let last = await pageSkeleton(page, FINGERPRINT_DEPTH, root);
  for (let i = 0; i < SETTLE_MAX_SAMPLES; i++) {
    await page.waitForTimeout(SETTLE_INTERVAL_MS);
    const next = await pageSkeleton(page, FINGERPRINT_DEPTH, root);
    if (next === last) return next;
    last = next;
  }
  throw new Error(
    `the page skeleton never settled over ${(SETTLE_INTERVAL_MS * SETTLE_MAX_SAMPLES) / 1000}s. Last read:\n${last}`,
  );
}

// Prove pageSkeleton can report a DIFFERENCE, here, now, on this page: wrap <main>'s first child in
// an extra div and require the fingerprint to move. Without this, an evaluate() that silently
// returned "" would make every comparison below pass.
async function assertSkeletonInstrumentFires(page: Page): Promise<void> {
  const before = await pageSkeleton(page, FINGERPRINT_DEPTH);
  await page.evaluate(() => {
    const main = document.querySelector("main");
    const first = main?.firstElementChild;
    if (!main || !first) throw new Error("positive control: <main> has no element child to wrap");
    const probe = document.createElement("div");
    probe.id = "loom-page-skeleton-positive-control";
    main.insertBefore(probe, first);
    probe.appendChild(first);
  });
  const during = await pageSkeleton(page, FINGERPRINT_DEPTH);
  await page.evaluate(() => {
    const probe = document.getElementById("loom-page-skeleton-positive-control");
    const main = document.querySelector("main");
    const inner = probe?.firstElementChild;
    if (probe && main && inner) { main.insertBefore(inner, probe); probe.remove(); }
  });
  expect(during, "positive control: an injected wrapper did not move the page fingerprint").not.toBe(before);
  expect(await pageSkeleton(page, FINGERPRINT_DEPTH),
    "positive control: removing the wrapper did not restore the page fingerprint").toBe(before);
}

// Console + page errors, collected from before the first navigation, with their own positive control
// so a zero reading is only believed from a collector shown to fire.
function collectConsoleErrors(page: Page): { errors: string[]; reset: () => void; assertFires: () => Promise<void> } {
  const errors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push("console.error: " + msg.text()); });
  page.on("pageerror", (err) => { errors.push("pageerror: " + err.message); });
  // Chromium's own "Failed to load resource: 404" console error names no URL, which makes a failure
  // here unactionable — so the failing response is recorded separately and the two are correlated by
  // order. Without this a red reads "7 console errors" with nothing to go on.
  page.on("response", (res) => {
    if (res.status() >= 400) errors.push(`http ${res.status()}: ${new URL(res.url()).pathname}`);
  });
  return {
    errors,
    // The walk below deliberately visits every destination under the CLASSIC shell first, to capture
    // what each route renders. Anything logged during that phase is the classic UI's, not Atlas's —
    // attributing it to Atlas would be a false positive, and the card's claim is specifically about
    // the switch being ON.
    reset: () => { errors.length = 0; },
    assertFires: async () => {
      const probe = "loom-console-positive-control-" + Date.now();
      await page.evaluate((text) => { console.error(text); }, probe);
      await expect
        .poll(() => errors.some((e) => e.includes(probe)), {
          message: "positive control: the console collector never saw a deliberate console.error",
        })
        .toBe(true);
      const at = errors.findIndex((e) => e.includes(probe));
      if (at >= 0) errors.splice(at, 1);
    },
  };
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
  test("the tree holds exactly the classic rail's destinations, and is the app's primary nav", async ({ page, loomDaemon }) => {
    await pinProject(page, (await loomDaemon.createProject()).id);

    // OFF: the rail's own destination set. Collected before any claim about the tree, so the expected
    // set is the app's, not this file's.
    await page.goto(loomDaemon.baseURL + "/");
    await expect(page.locator(".loom-rail")).toBeVisible();
    const railRoutes = await routesFrom(page, RAIL_LINKS);
    // Positive control for the collector itself: an empty or mis-typed selector returns [], which
    // would compare equal to an equally-broken tree collector and read as a pass.
    expect(railRoutes.length, "the rail link collector found no destinations at all").toBeGreaterThan(5);
    expect(railRoutes, "the rail link collector missed a destination known to exist").toContain("/board");
    expect(railRoutes, "the rail link collector missed the footer Settings row").toContain("/settings");

    // ON: the tree's set.
    await seedAtlasOn(page);
    await page.goto(loomDaemon.baseURL + "/");
    await expect(page.getByTestId("atlas-tree")).toBeVisible();
    const treeRoutes = await routesFrom(page, TREE_NODES);
    // Collected whether or not the disclosure is open: `evaluateAll` reads the DOM, and a closed
    // <details> hides its content without removing it.
    const unhomedRoutes = await routesFrom(page, UNHOMED_LINKS);

    // The parity claim, in two halves since phase 2 began adding Atlas-only nodes (card fd99b2d7),
    // and re-stated as a PARTITION since card 0d0c6cee made the tree an entity hierarchy.
    //
    // (a) EXHAUSTIVE PARTITION. P1-1's claim was "every rail destination has a node"; 0d0c6cee moved
    //     the ten cross-project destinations out of the tree and onto the escape hatch at its foot
    //     (cards 41eab0eb / 25c08fba re-home them as node tabs). So the claim is now that every rail
    //     destination is in EXACTLY ONE of the two places — which is STRONGER than the old
    //     equality-plus-carve-out it replaces, and needs no hand-named exemption list that could go
    //     stale: a destination that fell out of BOTH fails here, and so does one in both at once.
    // Card 41eab0eb added the THIRD half: a destination may now be a Workspace node TAB instead,
    // which is neither a tree row nor a hatch entry. Derived from the declaration, then VERIFIED
    // against the rendered tab row, so a declared tab that never renders fails here too.
    // Card 5afd71bd added the FOURTH: a destination may be RETIRED, which is no home at all — its
    // address redirects to the node that absorbed it. Derived the same way, and VERIFIED by the
    // redirect itself below, so a declared retirement whose address still renders a page fails here.
    // Card ec1aa18e added the FIFTH: a destination may be a PROJECT node tab, which since that card
    // is also no longer a tree row. Derived and verified exactly as the Workspace tabs are.
    // Card 4a0ad464 added the SIXTH: PAGE-ONLY — a destination Atlas still routes and still renders
    // as its own page, but gives no navigation to. Named one by one in PAGE_ONLY_DESTINATIONS above
    // (never derived from "whatever fell out of the tree"), and VERIFIED below: the address must
    // still render a page rather than redirect, or it is a retirement wearing the wrong label.
    const nodeTabs = nodeTabsUnderTest();
    const projectTabs = projectNodeTabsUnderTest();
    const retirements = retirementsUnderTest();
    // Read on each node itself — the tree renders on every Atlas route, but a tab row is that node's
    // own chrome and exists nowhere else. Both nodes are read on their OWN default (Overview) tab,
    // which is the one tab carrying no KPI strip and therefore the one where card d4350286's
    // width-derived overflow has nothing to fold: the whole declared set is in the row here.
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
    const unhomedSet = new Set(unhomedRoutes);
    const retiredSet = new Set(retirements.keys());
    const pageOnlySet = new Set(PAGE_ONLY_DESTINATIONS);
    const placesFor = (route: string) =>
      [homedSet.has(route), unhomedSet.has(route), tabbedSet.has(route), projectTabbedSet.has(route),
        retiredSet.has(route), pageOnlySet.has(route)].filter(Boolean).length;
    for (const route of railRoutes) {
      expect(placesFor(route),
        `the classic destination ${route} is in ${placesFor(route)} of the six Atlas placements — it`
        + ` must be in EXACTLY one (a tree node, a "not yet re-homed" entry, a Workspace node tab, a`
        + ` PROJECT node tab, retired, or page-only). nodes: ${JSON.stringify(treeRoutes)};`
        + ` escape hatch: ${JSON.stringify(unhomedRoutes)}; workspace tabs: ${JSON.stringify([...tabbedSet])};`
        + ` project tabs: ${JSON.stringify([...projectTabbedSet])}; retired: ${JSON.stringify([...retiredSet])};`
        + ` page-only: ${JSON.stringify([...pageOnlySet])}`)
        .toBe(1);
    }
    // POSITIVE CONTROL on the PAGE-ONLY bucket, the same shape the retired and project-tab buckets
    // carry: a reading of zero would make its disjunct dead and let a destination that simply fell
    // out of the tree pass as "page-only" without anyone having decided that.
    expect([...pageOnlySet].filter((r) => railRoutes.includes(r)).length,
      "no page-only address is a rail destination, so that branch of the partition never runs")
      .toBe(pageOnlySet.size);
    // POSITIVE CONTROL on the new bucket, the same shape the retired bucket carries below: a reading
    // of zero would make its disjunct dead and let a destination that simply fell out of the tree
    // pass as "a project tab" without being one.
    expect([...projectTabbedSet].filter((r) => railRoutes.includes(r)).length,
      "no rail destination is a project node tab, so that branch of the partition never runs")
      .toBeGreaterThan(0);
    // The escape hatch is GONE (card 5afd71bd deleted the disclosure along with the last two
    // destinations it held), so its disjunct above is now dead ON PURPOSE — and that is asserted
    // rather than left implicit, because a dead disjunct nobody states is indistinguishable from a
    // broken collector. The hatch bucket stays in the partition so a re-added hatch entry would still
    // be COUNTED and would still fail the "exactly one" claim above.
    expect(unhomedRoutes, "the escape hatch still renders entries, which card 5afd71bd deleted")
      .toEqual([]);
    await expect(page.getByTestId("atlas-unhomed"),
      "the escape-hatch disclosure is still mounted").toHaveCount(0);
    // POSITIVE CONTROL on the RETIRED bucket, which replaced the hatch's own: a reading of zero would
    // make that disjunct dead too and let a destination that fell out of the tree pass as "retired"
    // without being either. Derived from the declaration, so it tracks whatever is retired today.
    expect(retiredSet.size, "the retirement declaration carries no rows at all").toBeGreaterThan(0);
    expect([...retiredSet].filter((r) => railRoutes.includes(r)).length,
      "no retired address is a rail destination, so that branch of the partition never runs")
      .toBe(retiredSet.size);
    // ...and the retirement is REAL, not just declared: the address redirects to the node named in the
    // declaration rather than rendering a page. Checked here so the bucket is a measurement of the
    // running app, the same way the tab bucket is verified against the rendered tab row above.
    for (const [from, to] of retirements) {
      await page.goto(loomDaemon.baseURL + from);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(page, `the retired address ${from} did not redirect to ${to}`)
        .toHaveURL(loomDaemon.baseURL + to);
    }
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();
    // Card 0d0c6cee's own claim, stated positively rather than left implicit in the partition: a
    // cross-project destination is NOT a tree row any more.
    expect(treeRoutes, "the Inbox destination is still an Atlas tree row").not.toContain("/inbox");
    // Card ec1aa18e's own claim, stated the same way: a destination the project node carries as a
    // TAB is not a tree row either — the rail lists what is running, not the tab row again.
    expect(treeRoutes, "the Board destination is still an Atlas tree row, which card ec1aa18e removed")
      .not.toContain("/board");
    // Card 4a0ad464's own claim, same shape again: the project tier's last two PAGE rows are gone,
    // so a project branch holds entities and nothing else.
    expect(treeRoutes, "the project-tier Overview destination is still an Atlas tree row, which card 4a0ad464 removed")
      .not.toContain("/overview");
    await expect(page.getByTestId("atlas-home-project"),
      "the project branch still carries a Home row, which card 4a0ad464 removed").toHaveCount(0);
    // ...with a positive control, since an absence reads the same from a broken collector: the node
    // collector DOES still see the destinations that deliberately stayed, in BOTH tiers.
    expect(treeRoutes, "the tree node collector missed the Platform node").toContain("/platform");
    expect(treeRoutes, "the tree node collector missed the Workspace home node").toContain("/home");
    // ⭐ ...AND THE PAGE-ONLY ADDRESS IS STILL A PAGE, not a retirement by another name: it renders
    // its own content at its own address rather than redirecting. Without this, "no tree row" could
    // be satisfied by a destination that had quietly stopped existing.
    await page.goto(loomDaemon.baseURL + "/overview");
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await expect(page, "the page-only address /overview redirected instead of rendering")
      .toHaveURL(loomDaemon.baseURL + "/overview");
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();

    // (b) Every EXTRA node must be an address src/nav.tsx declares as an Atlas home — a node
    //     pointing at a page that does not exist, or a typo'd `to`, is in neither set and fails.
    const homes = parseAtlasHomes();
    expect(homes.paths.length, `the ATLAS_HOMES parse found no rows. Block:\n${homes.block}`).toBeGreaterThan(0);
    expect(homes.paths.length,
      `the parse returned ${homes.paths.length} row(s) but the declaration contains ${homes.rawMarkers} entries`
      + ` — the pattern is dropping rows. Block:\n${homes.block}`).toBe(homes.rawMarkers);
    const extras = treeRoutes.filter((r) => !railRoutes.includes(r));
    for (const extra of extras) {
      expect(homes.paths, `the tree renders an extra node for ${extra}, which src/nav.tsx does not`
        + ` declare as an Atlas home`).toContain(extra);
    }
    //     The other direction, as the same partition: a declared home is a node, an escape-hatch
    //     entry, or a node tab — never missing from all of them. (The workspace Settings home is a
    //     `ROOT_TABS` row in the approved design, so card 41eab0eb made it the Settings tab; the
    //     Agents home is a `PROJ_TABS` row, and card ec1aa18e took its tree row away accordingly.)
    // ⚠️ `/project` is the exception the rule has to name: card 4a0ad464 took its tree ROW away and
    // gave its address to the project ROW itself, which is a <button> and therefore invisible to
    // every link collector in this file. So a declared home may also be reached that way — verified
    // against the rendered control, not excused, so a project row that stopped navigating fails here.
    const projectRowNavigates = await page.getByTestId("atlas-project-node").count() > 0;
    expect(projectRowNavigates, "no project row is rendered, so the exception below is vacuous").toBe(true);
    for (const declared of homes.paths) {
      expect(homedSet.has(declared) || unhomedSet.has(declared) || tabbedSet.has(declared)
        || projectTabbedSet.has(declared) || retiredSet.has(declared)
        || (declared === "/project" && projectRowNavigates),
        `src/nav.tsx declares the Atlas home ${declared}, which the tree renders neither as a node nor`
        + ` as a "not yet re-homed" entry, and which is neither a node tab nor retired`).toBe(true);
    }

    // The tree IS navigation, not a complementary region (the P1-0 review finding this card carries).
    const tree = page.getByTestId("atlas-tree");
    expect(await tree.evaluate((el) => el.tagName.toLowerCase())).toBe("nav");

    // Depth: a project branch holds ONLY what is running in it since card 4a0ad464 — no page row of
    // any kind. Asserted structurally, over the branch's own child list, rather than by naming which
    // pages are scoped: that is nav.tsx's call, and restating it here is the drift this avoids.
    const projectNode = page.getByTestId("atlas-project-node");
    await expect(projectNode).toBeVisible();
    const scopedCount = await page.locator("ul.loom-atlas-nodes.is-kids a.loom-atlas-node").count();
    expect(scopedCount, "a destination row is back under the project node, which card 4a0ad464 removed")
      .toBe(0);
    // ...with the positive control that absence needs: this fixture's project has nothing running,
    // so the branch renders that card's idle line instead, and the collector above is reading a
    // branch that really is there rather than one that failed to render.
    await expect(page.locator(".loom-atlas-idle").first(),
      "the project branch rendered neither a row nor its empty-branch line").toBeVisible();
    // And the WORKSPACE tier's own rows are unaffected — the depth split still exists, it is just
    // that one side of it now holds entities.
    expect(treeRoutes.length, "the workspace tier lost its rows too").toBeGreaterThan(0);

    // The escape hatch stays reachable from the frame itself, not only via the Settings node.
    await expect(page.getByTestId("atlas-leave")).toBeVisible();
  });

  test("every destination's node renders the same content its old route rendered", async ({ page, loomDaemon }) => {
    // 17 destinations × (an off-shell capture + a node click + an on-shell capture), each with a
    // settle loop, is well past the 30s default.
    test.setTimeout(300_000);
    const consoleErrors = collectConsoleErrors(page);
    await pinProject(page, (await loomDaemon.createProject()).id);

    // ── Phase 1: the OFF shell. Capture each destination's page structure at its own route. ──
    await page.goto(loomDaemon.baseURL + "/");
    await expect(page.locator(".loom-rail")).toBeVisible();
    const routes = await routesFrom(page, RAIL_LINKS);
    expect(routes.length, "no destinations to compare").toBeGreaterThan(5);

    await assertSkeletonInstrumentFires(page);

    // POSITIVE CONTROL on the carve-out itself: every REBUILT_IN_PHASE_2 route must actually be one
    // this walk visits. Without it the map can go SILENT — a route that stops being collected (a rail
    // selector change, a destination moving) makes its inverted row simply not run, and the test still
    // passes, reporting green for a destination nobody checked either way.
    for (const route of Object.keys(REBUILT_IN_PHASE_2)) {
      expect(routes, `REBUILT_IN_PHASE_2 names ${route}, which this walk does not visit —`
        + ` its inverted assertion would never run`).toContain(route);
    }

    const before = new Map<string, string>();
    for (const route of routes) {
      await page.goto(loomDaemon.baseURL + route);
      before.set(route, await settledPageSkeleton(page));
    }

    // Positive control on the fingerprint's DISCRIMINATION, not just its reactivity: if it collapsed
    // every page to the same string, each per-route equality below would pass vacuously. Two
    // structurally unrelated destinations must read differently.
    expect(before.get("/board"), "positive control: the fingerprint cannot tell /board from /usage")
      .not.toBe(before.get("/usage"));
    // And broadly, not just for one hand-picked pair.
    expect(new Set(before.values()).size,
      "positive control: the fingerprint collapsed most destinations to one value").toBeGreaterThan(routes.length / 2);

    // ── Phase 2: the ON shell. Click each node and require the SAME structure. ──
    // Report what the classic walk logged before discarding it, so a classic-shell error is still
    // visible in the output rather than silently swallowed by the reset.
    const classicNoise = [...consoleErrors.errors];
    consoleErrors.reset();

    await seedAtlasOn(page);
    await page.goto(loomDaemon.baseURL + "/");
    await expect(page.getByTestId("atlas-tree")).toBeVisible();
    await expect(page.locator(".loom-rail")).toHaveCount(0);

    // Which half of card 0d0c6cee's partition each destination is in, read off the rendered tree
    // rather than named here — see the parity test above for why that is the stronger form.
    const homedSet = new Set(await routesFrom(page, TREE_NODES));
    const unhomedSet = new Set(await routesFrom(page, UNHOMED_LINKS));
    // The third home (card 41eab0eb) — a Workspace node tab, addressed by its key rather than by a
    // pathname, so it cannot come from `routesFrom`. And the fourth (card 5afd71bd) — RETIRED, which
    // is no home at all: the address redirects, so the walk visits it to assert that rather than to
    // compare a node's content against a page's.
    const nodeTabs = nodeTabsUnderTest();
    const projectTabs = projectNodeTabsUnderTest();
    const retirements = retirementsUnderTest();
    const pageOnly = new Set(PAGE_ONLY_DESTINATIONS);
    for (const route of routes) {
      expect(homedSet.has(route) || unhomedSet.has(route) || nodeTabs.has(route)
        || projectTabs.has(route) || retirements.has(route) || pageOnly.has(route),
        `${route} is reachable from none of the tree, its escape hatch, or either node's tabs,`
        + ` and it is neither retired nor page-only, so this walk cannot visit it`).toBe(true);
    }
    // Positive control on the third bucket: a reading of zero would let a destination that fell out
    // of both tree halves pass the disjunct above without being anywhere.
    expect([...nodeTabs.keys()].filter((r) => routes.includes(r)).length,
      "no rail destination is a Workspace node tab, so that branch of the walk never runs")
      .toBeGreaterThan(0);
    // The same control on the fourth, for the same reason.
    expect([...retirements.keys()].filter((r) => routes.includes(r)).length,
      "no rail destination is retired, so that branch of the walk never runs").toBeGreaterThan(0);
    // ...and on the fifth (card ec1aa18e).
    expect([...projectTabs.keys()].filter((r) => routes.includes(r)).length,
      "no rail destination is a project node tab, so that branch of the walk never runs")
      .toBeGreaterThan(0);
    // ...and on the sixth (card 4a0ad464).
    expect([...pageOnly].filter((r) => routes.includes(r)).length,
      "no rail destination is page-only, so that branch of the walk never runs").toBeGreaterThan(0);

    let previous = "";
    for (const route of routes) {
      const retiredTo = retirements.get(route);
      if (retiredTo) {
        // A RETIRED destination (card 5afd71bd) has no node to click and no content of its own to
        // compare: the address redirects to the node that absorbed its surfaces. So this leg asserts
        // the redirect and the landed node, and then INVERTS the identity claim — the classic capture
        // must still be non-empty, so this cannot be satisfied by a route that rendered nothing under
        // EITHER shell, which is how an inverted claim usually goes vacuous.
        await page.goto(loomDaemon.baseURL + route);
        await expect(page.getByTestId("atlas-shell")).toBeVisible();
        await expect(page.getByTestId("atlas-empty"),
          `the retired ${route} fell through to the Atlas catch-all instead of redirecting`).toHaveCount(0);
        await expect(page, `the retired ${route} did not redirect to ${retiredTo}`)
          .toHaveURL(loomDaemon.baseURL + retiredTo);
        const landed = await settledPageSkeleton(page);
        expect(before.get(route), `the ${route} route rendered nothing under the classic shell`).toBeTruthy();
        expect(landed, `the retired ${route} still renders its own CLASSIC page under Atlas`)
          .not.toBe(before.get(route));
        // The frame agrees it is on the absorbing node, not on the retired destination: exactly one
        // node reads as landed, and the heading is not the retired page's own label.
        await expect(page.locator("a.loom-atlas-node.is-active"),
          `the retired ${route} landed without exactly one node reading as landed`).toHaveCount(1);
        await expect(page.locator(".loom-atlas-nodehead h1")).not.toBeEmpty();
        await expect(page.getByTestId(`atlas-node-${route}`),
          `the retired ${route} is still an Atlas tree row`).toHaveCount(0);
        previous = landed;
        continue;
      }
      if (pageOnly.has(route)) {
        // A PAGE-ONLY destination (card 4a0ad464) has no tree row and no tab, but it is NOT retired:
        // it still renders its own page at its own address. So the identity claim holds for it in
        // the ORDINARY direction — the Atlas shell frames the same component the classic route did
        // — and what is asserted on top is that the tree makes no claim about where you are, since
        // it has no row for this address.
        await page.goto(loomDaemon.baseURL + route);
        await expect(page.getByTestId("atlas-shell")).toBeVisible();
        await expect(page.getByTestId("atlas-empty"),
          `the page-only ${route} fell through to the Atlas catch-all instead of rendering`).toHaveCount(0);
        await expect(page, `the page-only ${route} redirected, so it is a retirement, not page-only`)
          .toHaveURL(loomDaemon.baseURL + route);
        const landed = await settledPageSkeleton(page);
        expect(before.get(route), `the ${route} route rendered nothing under the classic shell`).toBeTruthy();
        expect(landed, `the page-only ${route} node rendered different content than the ${route} route did.\n`
          + `--- classic shell ---\n${before.get(route)}\n--- atlas shell ---\n${landed}\n`)
          .toBe(before.get(route));
        await expect(page.locator("a.loom-atlas-node.is-active"),
          `${route} has no tree row, but the tree marked one as landed anyway`).toHaveCount(0);
        await expect(page.getByTestId(`atlas-node-${route}`),
          `the page-only ${route} is an Atlas tree row again`).toHaveCount(0);
        previous = landed;
        continue;
      }
      const tabKey = nodeTabs.get(route);
      const projTabKey = projectTabs.get(route);
      if (tabKey) {
        // A re-homed destination is reached the way a reader reaches it from anywhere that still
        // links the old address: by the address itself, which the Atlas shell redirects into the tab.
        // There is deliberately NO tree row to click — that is what this card did.
        await page.goto(loomDaemon.baseURL + route);
        await expect(page.getByTestId(`atlas-tab-${tabKey}`),
          `${route} did not land on its "${tabKey}" Workspace node tab`)
          .toHaveAttribute("aria-selected", "true");
      } else if (projTabKey) {
        // A PROJECT node tab (card 25c08fba) KEEPS its own address — it was never redirected — so
        // the address is still what a reader arrives at, and card ec1aa18e took away the tree row
        // that used to duplicate it. The tab must read selected, and the pathname claim below still
        // applies, which is the one way this branch differs from the Workspace-tab branch above.
        await page.goto(loomDaemon.baseURL + route);
        await expect(page.getByTestId(`atlas-tab-${projTabKey}`),
          `${route} did not land on its "${projTabKey}" project node tab`)
          .toHaveAttribute("aria-selected", "true");
      } else if (homedSet.has(route)) {
        await page.getByTestId(`atlas-node-${route}`).click();
      } else {
        // A re-homed destination is reached the way a reader reaches it: through the escape hatch at
        // the foot of the tree, not by typing the URL — so this walk also exercises the one
        // affordance keeping those ten addresses alive until cards 41eab0eb / 25c08fba re-home them.
        // Opened by setting the property rather than clicking the summary, which would TOGGLE: the
        // disclosure auto-opens on whichever of these you are already looking at, so a click is not
        // idempotent here. (The summary's own click is exercised in atlas-tree-hierarchy.spec.ts.)
        await page.getByTestId("atlas-unhomed").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
        await page.getByTestId(`atlas-unhomed-${route}`).click();
      }
      // The click navigated — the row is a real link, not decoration. A re-homed destination's own
      // address is `/home` with its tab pinned, so what is asserted there is the TAB selection
      // above; the pathname claim applies to the two that still have a row.
      if (!tabKey) {
        await expect.poll(() => new URL(page.url()).pathname,
          { message: `clicking the ${route} row did not navigate` }).toBe(route);
      }
      // A re-homed destination's component is mounted verbatim INSIDE its tab panel, so the identity
      // comparison walks that wrapper's children — the exact shape the classic `main` walk produces.
      // Fingerprinting `main` instead would compare the whole Workspace node against one page and
      // reduce this to "it rendered something", which is the claim this test exists not to make.
      const after = await settledPageSkeleton(page,
        tabKey ? `[data-testid="atlas-tabpanel-${tabKey}"]` : "main");

      const rebuilt = REBUILT_IN_PHASE_2[route];
      if (rebuilt) {
        // Inverted for a rebuilt destination: identity here would mean the rebuild is not actually
        // what the Atlas shell renders. The classic capture must still be non-empty, so this cannot
        // be satisfied by a route that failed to render under EITHER shell.
        expect(before.get(route), `the ${route} route rendered nothing under the classic shell`).toBeTruthy();
        expect(after, `the ${route} node still renders the CLASSIC page, but ${rebuilt}`)
          .not.toBe(before.get(route));
      } else {
        expect(after, `the ${route} node rendered different content than the ${route} route did.\n`
          + `--- classic shell ---\n${before.get(route)}\n--- atlas shell ---\n${after}\n`)
          .toBe(before.get(route));
      }

      // EXERCISED, not merely rendered: the content column actually changed from the last node. Only
      // meaningful where the two pages are distinguishable at all, which the control above establishes
      // holds for most pairs but cannot guarantee for every adjacent one.
      if (previous && previous !== after) {
        expect(after, `the ${route} node left the previous node's content in place`).not.toBe(previous);
      }
      previous = after;

      // The frame tracks the landed node: the heading and the last breadcrumb name it.
      await expect(page.getByTestId("atlas-breadcrumb")).toBeVisible();
      await expect(page.locator(".loom-atlas-nodehead h1")).not.toBeEmpty();
      if (tabKey) {
        // A Workspace node TAB lives on `/home`, so the WORKSPACE HOME node is the landed one —
        // exactly one, and it is that row. The approved design says so too: every `ROOT_TABS` view's
        // own node is `root` and its title is "Workspace". Nothing about the tab itself may mark a
        // different row, which is what the count of one pins.
        await expect(page.locator("a.loom-atlas-node.is-active"),
          `${route} is a Workspace node tab, so exactly one node — the Workspace home — may read as landed`)
          .toHaveCount(1);
        await expect(page.getByTestId("atlas-home-workspace")).toHaveClass(/is-active/);
        // And the escape hatch is not ALSO claiming it: a destination lives in one place now.
        await expect(page.getByTestId(`atlas-unhomed-${route}`),
          `${route} is a node tab and still an escape-hatch entry`).toHaveCount(0);
      } else if (projTabKey) {
        // The counterpart one tier down. Card ec1aa18e put this mark on the project HOME row; card
        // 4a0ad464 removed that row, so the PROJECT ROW carries it instead — it is the node's only
        // address in the tree now. It is a <button>, so `a.loom-atlas-node.is-active` (an ANCHOR
        // selector) legitimately reads ZERO here, and the mark is `aria-current` on the row.
        await expect(page.getByTestId("atlas-project-node"),
          `${route} is a project node tab, so the project row must read as the landed branch`)
          .toHaveAttribute("aria-current", "true");
        await expect(page.getByTestId("atlas-home-project"),
          "the project branch grew a Home row back, which card 4a0ad464 removed").toHaveCount(0);
        await expect(page.getByTestId(`atlas-node-${route}`),
          `${route} is a project node tab and still an Atlas tree row`).toHaveCount(0);
      } else if (homedSet.has(route)) {
        // Exactly one node reads as active, and it is this one.
        await expect(page.locator("a.loom-atlas-node.is-active")).toHaveCount(1);
        await expect(page.getByTestId(`atlas-node-${route}`)).toHaveClass(/is-active/);
      } else {
        // A destination still in the escape hatch has no node, so NOTHING may read as the landed node
        // — marking the nearest-looking row instead would be the tree lying about where you are. The
        // hatch's own weaker `is-here` mark is what says which address is showing, and asserting it
        // keeps this from being a bare absence claim that a blank tree would also satisfy.
        await expect(page.locator("a.loom-atlas-node.is-active"),
          `${route} has no tree node, but the tree marked one as landed anyway`).toHaveCount(0);
        await expect(page.getByTestId(`atlas-unhomed-${route}`)).toHaveClass(/is-here/);
      }
    }

    await page.waitForLoadState("networkidle");
    await consoleErrors.assertFires();

    // The card's DoD asks for zero console errors with the switch on. An absolute zero is the WRONG
    // instrument for it on this fixture: GET /api/platform/home no longer produces noise here (card
    // 8d82be67), but some OTHER page this walk visits still could, and that would fire identically
    // under BOTH shells — not something Atlas introduced, and an absolute-zero assertion would redden
    // this spec forever for a condition it does not govern. What Atlas IS answerable for is introducing
    // a NEW error — so the classic walk is the contrast case, and the claim is "no error kind the
    // classic walk did not already produce". Raw counts legitimately differ between the two walks (each
    // fires a different number of polls depending on timing), so the comparison is over KINDS, not counts.
    const introduced = [...new Set(consoleErrors.errors)].filter((e) => !new Set(classicNoise).has(e));
    expect(introduced,
      `the Atlas walk introduced ${introduced.length} error kind(s) the classic walk did not.\n`
      + `atlas (${consoleErrors.errors.length}): ${JSON.stringify([...new Set(consoleErrors.errors)])}\n`
      + `classic (${classicNoise.length}): ${JSON.stringify([...new Set(classicNoise)])}`)
      .toEqual([]);

    // The subset check above could in principle be satisfied by a classic walk that already logged
    // everything, so this second, absolute claim stands beside it: an UNCAUGHT EXCEPTION is never
    // acceptable, in either shell, and neither walk may produce one.
    expect(consoleErrors.errors.filter((e) => e.startsWith("pageerror:")),
      "the Atlas walk threw an uncaught exception").toEqual([]);
    expect(classicNoise.filter((e) => e.startsWith("pageerror:")),
      "the classic walk threw an uncaught exception, so the contrast case above is not a clean baseline")
      .toEqual([]);
  });

  test("the tree is navigable by Tab and Enter, with a visible focus ring", async ({ page, loomDaemon }) => {
    await pinProject(page, (await loomDaemon.createProject()).id);
    await seedAtlasOn(page);
    await page.goto(loomDaemon.baseURL + "/");
    await expect(page.getByTestId("atlas-tree")).toBeVisible();

    const nodes = page.locator(TREE_NODES);
    const total = await nodes.count();
    // TWO is what a one-project workspace with nothing running renders since card 4a0ad464 removed
    // the project branch's last two page rows (`Home` and `Overview`): the Workspace home and the
    // Platform node, and nothing else is an ANCHOR — a project row is a <button> and a session row
    // only exists while something is running. The floor is "more than one", which is all this leg
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
    // ring, and only a real keyboard interaction sets it. Tab until the first node takes focus — the
    // chrome ahead of the tree (the Command Palette and friends) owns an unknown number of stops, so
    // counting them here would encode an unrelated component's shape into this assertion.
    const first = nodes.first();
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await first.evaluate((el) => el === document.activeElement);
    }
    expect(reached, "Tab never reached the tree's first node").toBe(true);

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

    // Tab moves to the NEXT node in document order (document order IS the visual order here).
    await page.keyboard.press("Tab");
    expect(await nodes.nth(1).evaluate((el) => el === document.activeElement),
      "Tab did not advance to the second tree node").toBe(true);
    // ...and Shift+Tab comes back, which is also how focus returns to the node Enter is pressed on.
    await page.keyboard.press("Shift+Tab");
    expect(await first.evaluate((el) => el === document.activeElement),
      "Shift+Tab did not return to the first tree node").toBe(true);

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
