// The Atlas entity tree (card 8cbb2ac2, Atlas build plan P1-1 —
// docs/plans/atlas-ui/03-decomposition.md row P1-1).
//
// The card's claim is a PARITY claim — "every NAV_PAGES entry gets a tree node, and clicking it
// renders the EXISTING component unmodified" — so every assertion here is derived from the live app
// rather than from a list typed into this file:
//   1. NODE-SET PARITY. The destinations are collected from the CLASSIC rail (switch off) and from the
//      Atlas tree (switch on), in the same browser, against the same build, and the two sets are
//      compared. Nothing hand-copies NAV_PAGES — which matters because the whole failure mode this
//      guards is a count going stale, and a hand-copied list in the test would go stale identically.
//      Since card fd99b2d7 the tree also holds Atlas-ONLY nodes the rail has no equivalent of, so the
//      claim is "every rail destination has a node, and every extra node is a declared Atlas home"
//      rather than a bare set equality — see `parseAtlasHomes` below for why that is no weaker.
//   2. CONTENT IDENTITY. For every one of those destinations, the page's rendered structure is
//      fingerprinted at the OLD route (switch off) and again after clicking the node (switch on), and
//      required to match. "The same content the old route rendered" is asserted against the old route
//      itself, not against a marker someone decided was characteristic of it. A destination a PHASE-2
//      card has deliberately rebuilt asserts the INVERSE instead — see REBUILT_IN_PHASE_2 below.
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

async function pageSkeleton(page: Page, maxDepth: number): Promise<string> {
  return page.evaluate((depthCap) => {
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
    const main = document.querySelector("main");
    if (main) for (const child of Array.from(main.children)) walk(child, 0);
    return out.join("\n");
  }, maxDepth);
}

// These pages have async pieces (every panel is a react-query read), so a fingerprint taken straight
// after a navigation is a coin flip on which of them have resolved — measured on P1-0's own shell
// fingerprint, where two identical runs disagreed. Sample until two consecutive reads agree.
const SETTLE_INTERVAL_MS = 300;
const SETTLE_MAX_SAMPLES = 20;

async function settledPageSkeleton(page: Page): Promise<string> {
  let last = await pageSkeleton(page, FINGERPRINT_DEPTH);
  for (let i = 0; i < SETTLE_MAX_SAMPLES; i++) {
    await page.waitForTimeout(SETTLE_INTERVAL_MS);
    const next = await pageSkeleton(page, FINGERPRINT_DEPTH);
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

    // The parity claim, in two halves since phase 2 began adding Atlas-only nodes (card fd99b2d7).
    //
    // (a) STRICT, unchanged in strength: every rail destination still has a node. A missing node
    //     fails here exactly as it did when this was a bare equality.
    for (const route of railRoutes) {
      expect(treeRoutes, `the Atlas tree has no node for the classic destination ${route}`).toContain(route);
    }
    // (b) Every EXTRA node must be an address src/nav.tsx declares as an Atlas home. This is what
    //     replaces the equality's other direction — a node pointing at a page that does not exist,
    //     or a typo'd `to`, still fails, because it is in neither set.
    const homes = parseAtlasHomes();
    expect(homes.paths.length, `the ATLAS_HOMES parse found no rows. Block:\n${homes.block}`).toBeGreaterThan(0);
    expect(homes.paths.length,
      `the parse returned ${homes.paths.length} row(s) but the declaration contains ${homes.rawMarkers} entries`
      + ` — the pattern is dropping rows. Block:\n${homes.block}`).toBe(homes.rawMarkers);
    const extras = treeRoutes.filter((r) => !railRoutes.includes(r));
    //     Equality, not a subset, in BOTH directions: a declared home that stopped rendering leaves
    //     `extras` short, and an undeclared node leaves it long.
    expect(extras.sort(), "the tree's extra nodes are not exactly the declared Atlas home nodes")
      .toEqual([...homes.paths].sort());

    // The tree IS navigation, not a complementary region (the P1-0 review finding this card carries).
    const tree = page.getByTestId("atlas-tree");
    expect(await tree.evaluate((el) => el.tagName.toLowerCase())).toBe("nav");

    // Depth: `scoped` destinations hang under the project node, god-eye ones under the workspace root.
    // Asserted structurally (the scoped nodes are inside the project node's child list), not by naming
    // which pages are scoped — that is nav.tsx's call, and restating it here is the drift this avoids.
    const projectNode = page.getByTestId("atlas-project-node");
    await expect(projectNode).toBeVisible();
    const scopedCount = await page.locator("ul.loom-atlas-nodes.is-kids a.loom-atlas-node").count();
    expect(scopedCount, "no destination landed under the project node").toBeGreaterThan(0);
    expect(scopedCount, "every destination landed under the project node").toBeLessThan(treeRoutes.length);

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

    let previous = "";
    for (const route of routes) {
      await page.getByTestId(`atlas-node-${route}`).click();
      // The click navigated — the node is a real link, not decoration.
      await expect.poll(() => new URL(page.url()).pathname,
        { message: `clicking the ${route} node did not navigate` }).toBe(route);
      const after = await settledPageSkeleton(page);

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
      // Exactly one node reads as active, and it is this one.
      await expect(page.locator("a.loom-atlas-node.is-active")).toHaveCount(1);
      await expect(page.getByTestId(`atlas-node-${route}`)).toHaveClass(/is-active/);
    }

    await page.waitForLoadState("networkidle");
    await consoleErrors.assertFires();

    // The card's DoD asks for zero console errors with the switch on. An absolute zero is the WRONG
    // instrument for it on this fixture: the Platform page polls GET /api/platform/home, which 404s on
    // a non-dev throwaway daemon (no reserved dev Platform home exists — gateway/server.ts), and
    // Chromium logs a console error per 404 response. That fires identically under BOTH shells, so it
    // is not something Atlas introduced, and an absolute-zero assertion would redden this spec forever
    // for a condition it does not govern. What Atlas IS answerable for is introducing a NEW error —
    // so the classic walk is the contrast case, and the claim is "no error kind the classic walk did
    // not already produce". Raw counts legitimately differ between the two walks (each fires a
    // different number of polls depending on timing), so the comparison is over KINDS, not counts.
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
    expect(total, "no tree nodes to tab through").toBeGreaterThan(5);

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

    // Enter activates it — an observable navigation, not just a styled control.
    const target = await nodes.nth(1).evaluate((el) => new URL((el as HTMLAnchorElement).href).pathname);
    const startedAt = new URL(page.url()).pathname;
    await page.keyboard.press("Enter");
    await expect.poll(() => new URL(page.url()).pathname,
      { message: "Enter on a focused tree node did not navigate" }).toBe(target);
    expect(target, "the keyboard test navigated to the page it was already on, proving nothing")
      .not.toBe(startedAt);
  });
});
