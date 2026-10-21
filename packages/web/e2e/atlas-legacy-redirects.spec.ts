// The Atlas legacy-URL redirects (card 82bde849, Atlas build plan P1-3 —
// docs/plans/atlas-ui/03-decomposition.md row P1-3; the redirect rows are
// 01-parity-checklist.md §A). Each old path must land on the right Atlas node + tab with the switch
// ON, and behave exactly as it does today with it OFF.
//
// Nothing here hand-copies the redirect list. The plan names eight and names them individually, but
// a count in a doc goes stale the moment someone adds a ninth — so the table under test is parsed
// out of `src/nav.tsx`'s own LEGACY_REDIRECTS declaration (the e2e tsconfig covers `e2e/` only, so a
// spec cannot import a `src/` module — the same reason fixtures/daemon.ts hardcodes its own keys).
// A new redirect is therefore covered the day it is declared, with no edit here.
//
// The expectations are derived too: the destination's crumb trail, heading and tree node are all
// read off the RENDERED tree (its own node label, and whether that node sits at workspace or project
// depth), never typed out — a literal "Repository" in this file would keep passing after a rename
// while the crumbs and the tree silently disagreed. The one thing stated rather than derived is the
// OFF-shell behaviour, and it is not stated either: it is CAPTURED from the classic shell first and
// then required of the Atlas shell, so "exactly as today" is a measurement and not a belief.
//
// Every absence/equality claim carries a POSITIVE CONTROL first: a parse that silently matched
// nothing, a fingerprint that collapsed every page to one string, and a zero-console-error count all
// read exactly the same whether the instrument works or is quietly broken.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "./fixtures/daemon";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAV_SOURCE = path.resolve(__dirname, "..", "src", "nav.tsx");

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

// ── Destinations PHASE 2 has deliberately rebuilt (keyed by the redirect's TARGET path) ──────────
// The skeleton equality below is a PHASE-1 contract: phase 1 mounts every destination verbatim under
// both shells, so landing on identical content is what proves a redirect reaches the same page it
// always did. Where a phase-2 card has rebuilt that page behind the switch, the equality inverts —
// a redirect into a rebuilt destination SHOULD land on different content, and sameness would mean the
// rebuild is not what the Atlas shell serves.
//
// Everything else about such a row is still asserted unchanged: it redirects, to the same URL, into
// the Atlas frame rather than the catch-all, marking the right node with the right crumbs. Only the
// page-content comparison flips. ⛔ Add a path here ONLY with the phase-2 card that rebuilds it.
const REBUILT_IN_PHASE_2: Record<string, string> = {
  // Card c07ff42a (P2-4) — /setup is the redirect that lands here.
  "/platform": "c07ff42a — rebuilt as the five-tab Platform node",
};

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
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

// ── The declaration under test ─────────────────────────────────────────────────────────────────
type Redirect = { from: string; to: string };

// Parsed from the real source, with the filtered count checked against the raw marker count: a
// regex that silently stopped matching one row would otherwise return a clean-looking SUBSET, and a
// subset reads exactly like a complete list. The slice is bounded to the declaration's own array so
// an unrelated `redirect(` elsewhere in the file could never be counted as a row.
function parseLegacyRedirects(): { rows: Redirect[]; rawMarkers: number; block: string } {
  const src = readFileSync(NAV_SOURCE, "utf8");
  const start = src.indexOf("export const LEGACY_REDIRECTS");
  if (start < 0) throw new Error(`no LEGACY_REDIRECTS declaration found in ${NAV_SOURCE}`);
  const end = src.indexOf("\n];", start);
  if (end < 0) throw new Error(`LEGACY_REDIRECTS in ${NAV_SOURCE} has no closing "];"`);
  const block = src.slice(start, end);

  const rawMarkers = (block.match(/redirect\(/g) ?? []).length;
  const rows: Redirect[] = [];
  for (const m of block.matchAll(/redirect\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)) {
    rows.push({ from: m[1] ?? "", to: m[2] ?? "" });
  }
  return { rows, rawMarkers, block };
}

/** The pathname half of a redirect target, which is the address the tree holds a node for. */
const pathOf = (to: string) => to.split("?")[0] ?? to;
/** The `?tab=` value a target pins, when it pins one. */
const tabOf = (to: string) => new URLSearchParams(to.split("?")[1] ?? "").get("tab");

// ── Instruments (same shapes as atlas-tree / atlas-param-routes) ───────────────────────────────
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
      // An <svg>'s interior says nothing about page structure; the svg ELEMENT is still recorded.
      if (depth >= depthCap || el.tagName.toLowerCase() === "svg") return;
      for (const child of Array.from(el.children)) walk(child, depth + 1);
    };
    const main = document.querySelector("main");
    if (main) for (const child of Array.from(main.children)) walk(child, 0);
    return out.join("\n");
  }, maxDepth);
}

// ── Readiness: when is a page's fingerprint safe to take? ──────────────────────────────────────
// These destinations are react-query reads, so a fingerprint taken straight after a navigation is a
// coin flip on which parts have resolved. "Two consecutive reads agree" is NOT enough on its own and
// this spec measured it failing (card 625d791c): a page that has not yet received its data is
// perfectly STABLE in its placeholder state, so the poll settles on the placeholder and returns it as
// if it were the finished page. Stability says the page STOPPED CHANGING; it cannot distinguish
// "finished" from "has not started". /repository?tab=git is the specimen — its tablist renders
// synchronously while the body holds a one-<p> placeholder until the git read lands:
//
//     div                               div
//       div[role=tablist]                 div[role=tablist]
//         button[role=tab] x2               button[role=tab] x2
//       div                               div
//         p            <- placeholder       div … input.loom-field …   <- loaded
//
// ⛔ So do NOT "fix" this by lengthening the interval or adding samples — a slower poll settles on
// the same placeholder, just later. Readiness needs a signal about the DATA, not about the DOM
// holding still.
//
// The signal used here is NETWORK QUIESCENCE, deliberately page-agnostic: wait until the page has
// both ISSUED and DRAINED its `/api/` reads, with none in flight across a whole observation window,
// and only then require the fingerprint to be identical across that same window. A per-page
// readiness marker (the card's other option) was rejected: the honest marker differs per destination
// — note above that the obvious generic one, "the first real control", is already satisfied by those
// two tabs while the body is still a placeholder — so it would mean eight hand-written selectors
// that rot independently of the pages, in a spec whose whole design derives its expectations instead.
//
// ⛔ And never make readiness "wait until the fingerprint matches the classic capture": that is the
// assertion itself, and waiting for it would make every comparison below vacuously true.
const SETTLE_INTERVAL_MS = 300;
const SETTLE_MAX_SAMPLES = 40;

/**
 * Tracks in-flight `/api/` requests so a fingerprint is only ever taken on a quiet page.
 *
 * `startedSinceMark` is what stops the gate passing BEFORE the page has asked for anything: right
 * after a navigation the in-flight count is legitimately 0 because no query has fired yet, which is
 * indistinguishable from 0-because-everything-resolved if you only read the count.
 */
function trackApiRequests(page: Page): { inFlight: () => number; startedSinceMark: () => number; mark: () => void } {
  let inFlight = 0;
  let started = 0;
  const isApi = (url: string) => {
    try { return new URL(url).pathname.startsWith("/api/"); } catch { return false; }
  };
  page.on("request", (req) => { if (isApi(req.url())) { inFlight++; started++; } });
  const done = (req: { url: () => string }) => { if (isApi(req.url())) inFlight--; };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return { inFlight: () => inFlight, startedSinceMark: () => started, mark: () => { started = 0; } };
}

/**
 * The fingerprint of a page that has finished loading: identical across one full observation window
 * during which NOTHING was in flight and nothing new started. Checking quiescence only at the two
 * sample instants would accept a window with a request opening and closing inside it, so the window
 * is voided and resampled whenever a request starts during it.
 */
async function settledPageSkeleton(page: Page, api: ReturnType<typeof trackApiRequests>): Promise<string> {
  let last = await pageSkeleton(page, FINGERPRINT_DEPTH);
  let sawRequest = api.startedSinceMark() > 0;
  for (let i = 0; i < SETTLE_MAX_SAMPLES; i++) {
    const quietAtStart = api.inFlight() === 0;
    api.mark();
    await page.waitForTimeout(SETTLE_INTERVAL_MS);
    const startedDuringWindow = api.startedSinceMark();
    if (startedDuringWindow > 0) sawRequest = true;
    const next = await pageSkeleton(page, FINGERPRINT_DEPTH);
    const quiet = quietAtStart && startedDuringWindow === 0 && api.inFlight() === 0;
    if (next === last && quiet && sawRequest) return next;
    last = next;
  }
  throw new Error(
    `the page never reached a quiet, stable state over ${(SETTLE_INTERVAL_MS * SETTLE_MAX_SAMPLES) / 1000}s`
    + ` (inFlight=${api.inFlight()}, sawRequest=${sawRequest}). Last read:\n${last}`,
  );
}

// Prove pageSkeleton can report a DIFFERENCE, here, now, on this page: without it an evaluate() that
// silently returned "" would make every comparison below pass.
//
// Takes its own three readings inside ONE quiet window (card 625d791c): the probe asserts that
// wrapping and then unwrapping an element returns the fingerprint to exactly what it was, which is
// only true of a page that is not independently re-rendering. On a still-loading page the data lands
// between the first and last reading and the restore comparison fails — not because the instrument
// is broken, but because the page legitimately grew underneath it. That is a real measured flake
// (1 of 5 runs on the landed spec), and it is the same root cause as the /git comparison below.
//
// A window that turns out not to have been quiet is RETAKEN rather than tolerated: loosening the
// comparison instead would blunt the very control this function exists to be.
const PROBE_MAX_ATTEMPTS = 5;

async function assertSkeletonInstrumentFires(page: Page, api: ReturnType<typeof trackApiRequests>): Promise<void> {
  for (let attempt = 1; attempt <= PROBE_MAX_ATTEMPTS; attempt++) {
    const before = await settledPageSkeleton(page, api);
    api.mark();
    await page.evaluate(() => {
      const main = document.querySelector("main");
      const first = main?.firstElementChild;
      if (!main || !first) throw new Error("positive control: <main> has no element child to wrap");
      const probe = document.createElement("div");
      probe.id = "loom-redirect-skeleton-positive-control";
      main.insertBefore(probe, first);
      probe.appendChild(first);
    });
    const during = await pageSkeleton(page, FINGERPRINT_DEPTH);
    await page.evaluate(() => {
      const probe = document.getElementById("loom-redirect-skeleton-positive-control");
      const main = document.querySelector("main");
      const inner = probe?.firstElementChild;
      if (probe && main && inner) { main.insertBefore(inner, probe); probe.remove(); }
    });
    const after = await pageSkeleton(page, FINGERPRINT_DEPTH);

    // If the app fetched anything while the probe was mid-flight, this window cannot say whether a
    // difference came from the probe or from the app — so it proves nothing either way. Retake it.
    if (api.startedSinceMark() > 0 && attempt < PROBE_MAX_ATTEMPTS) continue;

    expect(during, "positive control: an injected wrapper did not move the page fingerprint").not.toBe(before);
    expect(after, "positive control: removing the wrapper did not restore the page fingerprint").toBe(before);
    return;
  }
}

function collectConsoleErrors(page: Page): { errors: string[]; reset: () => void; assertFires: () => Promise<void> } {
  const errors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push("console.error: " + msg.text()); });
  page.on("pageerror", (err) => { errors.push("pageerror: " + err.message); });
  // Chromium's own "Failed to load resource: 404" console error names no URL, which makes a failure
  // here unactionable — so the failing response is recorded separately.
  page.on("response", (res) => {
    if (res.status() >= 400) errors.push(`http ${res.status()}: ${new URL(res.url()).pathname}`);
  });
  return {
    errors,
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

// The breadcrumb trail as plain labels. Each <li> past the first also holds an aria-hidden "/"
// separator span, so the label is the last NON-hidden span.
async function crumbTrail(page: Page): Promise<string[]> {
  return page.getByTestId("atlas-breadcrumb").locator("li").evaluateAll((lis) =>
    lis.map((li) => {
      const spans = Array.from(li.querySelectorAll("span")).filter((s) => !s.hasAttribute("aria-hidden"));
      return (spans[spans.length - 1]?.textContent ?? "").trim();
    }),
  );
}

const nodeHeading = (page: Page) => page.locator(".loom-atlas-nodehead h1");

/**
 * Where the TREE says a destination lives, read off the rendered tree rather than re-derived from
 * nav.tsx's `scoped` flag: the node's own label, and whether it hangs under the project node
 * (`ul.loom-atlas-nodes.is-kids`, AtlasTree's project level) or at workspace depth. That makes the
 * expected crumb trail a statement about tree/frame AGREEMENT — the only thing worth asserting,
 * since a frame that derived its depth from a different input than the tree is exactly the bug.
 */
async function treeNodeAddress(page: Page, to: string): Promise<{ label: string; underProject: boolean }> {
  const node = page.getByTestId(`atlas-node-${to}`);
  await expect(node, `the tree has no node for ${to}`).toHaveCount(1);
  const label = (await node.locator(".loom-atlas-lbl").innerText()).trim();
  expect(label, `the tree's ${to} node renders no label`).not.toBe("");
  const underProject = await node.evaluate((el) => !!el.closest("ul.loom-atlas-nodes.is-kids"));
  return { label, underProject };
}

test.describe("Atlas legacy redirects (card 82bde849)", () => {
  test("every declared redirect lands on its Atlas node + tab, and is untouched with the switch off", async ({ page, loomDaemon }) => {
    // N redirects × (an off-shell capture with a settle loop + an on-shell capture with one), plus
    // the query-string case, is far past the 30s default.
    test.setTimeout(300_000);
    const consoleErrors = collectConsoleErrors(page);
    const api = trackApiRequests(page);

    // ── The table under test, parsed from the real declaration ──
    const { rows, rawMarkers, block } = parseLegacyRedirects();
    // POSITIVE CONTROLS on the parse. (a) it found something at all; (b) it found EVERY row the
    // block declares, so a quietly-narrowed regex cannot hand back a plausible subset; (c) it
    // resolves a row this spec can name independently, so the pattern is shown to work and not just
    // to return the right COUNT of something.
    expect(rows.length, `the LEGACY_REDIRECTS parse found no rows. Block:\n${block}`).toBeGreaterThan(0);
    expect(rows.length,
      `the parse returned ${rows.length} row(s) but the declaration contains ${rawMarkers} redirect( marker(s)`
      + ` — the pattern is dropping rows. Block:\n${block}`).toBe(rawMarkers);
    expect(rows, "positive control: the parse did not resolve /git, a row the declaration is known to carry")
      .toContainEqual({ from: "/git", to: "/repository?tab=git" });
    // Every target must be a real tree address, or the derivation below is comparing nothing.
    for (const r of rows) expect(pathOf(r.to), `${r.from} redirects to a relative/empty path`).toMatch(/^\//);
    // POSITIVE CONTROL on the carve-out: every REBUILT_IN_PHASE_2 path must be some row's target.
    // Otherwise the map goes SILENT — a redirect retargeted away from a rebuilt destination leaves its
    // inverted assertion unreachable, and this test passes without ever checking that destination.
    const targets = rows.map((r) => pathOf(r.to));
    for (const path of Object.keys(REBUILT_IN_PHASE_2)) {
      expect(targets, `REBUILT_IN_PHASE_2 names ${path}, which no declared redirect targets —`
        + ` its inverted assertion would never run`).toContain(path);
    }

    // A project must exist and be PINNED: a `scoped` destination's crumb names the active project,
    // and the fixture daemon is shared, so the auto-resolved "first project" is not stable.
    const project = await loomDaemon.createProject(`atlas-redirects-${Date.now()}`);
    await pinProject(page, project.id);

    // ── Phase 1: the CLASSIC shell. CAPTURE today's behaviour; never assert it from memory. ──
    await page.goto(loomDaemon.baseURL + "/repository");
    await expect(page.locator(".loom-rail")).toBeVisible();
    await assertSkeletonInstrumentFires(page, api);

    const classic = new Map<string, { url: string; skeleton: string }>();
    for (const r of rows) {
      await page.goto(loomDaemon.baseURL + r.from);
      // The redirect itself: the old URL does not stay in the address bar.
      await expect(page, `${r.from} did not redirect under the classic shell`)
        .toHaveURL(loomDaemon.baseURL + r.to);
      classic.set(r.from, { url: page.url(), skeleton: await settledPageSkeleton(page, api) });
    }

    // Positive control on the fingerprint's DISCRIMINATION: the redirects land on several DIFFERENT
    // destinations, so if every reading were the same string each equality below would pass
    // vacuously. The floor is the number of distinct destination PATHS, not of rows (two redirects
    // onto the same page's two tabs legitimately share a skeleton shape).
    const distinctPaths = new Set(rows.map((r) => pathOf(r.to))).size;
    expect(new Set([...classic.values()].map((c) => c.skeleton)).size,
      `positive control: the fingerprint cannot tell the ${distinctPaths} redirect destinations apart`)
      .toBeGreaterThan(1);

    // ── Phase 2: the ATLAS shell, same old URLs. ──
    // Report what the classic walk logged before discarding it, so a classic-shell error stays
    // visible in the output rather than being silently swallowed by the reset.
    const classicNoise = [...consoleErrors.errors];
    consoleErrors.reset();
    await seedAtlasOn(page);

    for (const r of rows) {
      await page.goto(loomDaemon.baseURL + r.from);

      // A FRESH LOAD of the old URL lands inside the Atlas frame — and NOT on the catch-all panel,
      // which is exactly where all of these went before this card.
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(page.locator(".loom-rail")).toHaveCount(0);
      await expect(page.getByTestId("atlas-empty"),
        `${r.from} still fell through to the Atlas catch-all instead of redirecting`).toHaveCount(0);

      // Same landing URL as the classic shell produced — the ONE declaration, proven to be one.
      // A retrying assertion, not a bare page.url() read: `goto` resolves on load, and the redirect
      // is a client-side history write that happens on the first render AFTER it.
      await expect(page, `${r.from} landed somewhere different under Atlas than under the classic shell`)
        .toHaveURL(classic.get(r.from)?.url ?? "");

      // ── The right NODE: the tree marks it, the heading names it, the crumbs lead to it. ──
      const { label, underProject } = await treeNodeAddress(page, pathOf(r.to));
      await expect(page.getByTestId(`atlas-node-${pathOf(r.to)}`),
        `${r.from} landed without marking the ${pathOf(r.to)} node in the tree`).toHaveClass(/is-active/);
      await expect(page.locator("a.loom-atlas-node.is-active"),
        `${r.from} marked more than one tree node`).toHaveCount(1);
      await expect(nodeHeading(page)).toHaveText(label);
      // Depth comes from the tree itself: a project-level node hangs under the project crumb.
      expect(await crumbTrail(page), `${r.from} produced the wrong breadcrumb trail`)
        .toEqual(["Workspace", ...(underProject ? [project.name] : []), label]);

      // ── The right TAB, where the target pins one. Chromium folds Segmented's CSS
      // `text-transform: uppercase` into the accessible name, so match case-insensitively — and
      // derive the expected label from the `?tab=` value rather than hand-mapping it.
      const tab = tabOf(r.to);
      if (tab) {
        await expect(page.locator('[role="tab"][aria-selected="true"]'),
          `${r.from} → ${r.to} did not select exactly one sub-tab`).toHaveCount(1);
        await expect(page.locator('[role="tab"][aria-selected="true"]'),
          `${r.from} → ${r.to} selected the wrong sub-tab`).toHaveText(new RegExp(`^${tab}$`, "i"));
      }

      // ── The same PAGE: structurally what the classic redirect landed on — unless a phase-2 card
      //    has rebuilt that destination, in which case the claim inverts (see REBUILT_IN_PHASE_2). ──
      const after = await settledPageSkeleton(page, api);
      const rebuilt = REBUILT_IN_PHASE_2[pathOf(r.to)];
      if (rebuilt) {
        expect(classic.get(r.from)?.skeleton,
          `${r.from} rendered nothing under the classic shell`).toBeTruthy();
        expect(after, `${r.from} still lands on the CLASSIC ${pathOf(r.to)} page, but ${rebuilt}`)
          .not.toBe(classic.get(r.from)?.skeleton);
      } else {
        expect(after, `${r.from} rendered different content under Atlas than the classic redirect did.\n`
          + `--- classic shell ---\n${classic.get(r.from)?.skeleton}\n--- atlas shell ---\n${after}\n`)
          .toBe(classic.get(r.from)?.skeleton);
      }
    }

    await page.waitForLoadState("networkidle");
    await consoleErrors.assertFires();

    // An ABSOLUTE zero is the wrong instrument on this fixture: GET /api/platform/home 404s on a
    // non-dev throwaway daemon and Chromium logs a console error per 404 RESPONSE (card 8cbb2ac2).
    // That fires under BOTH shells, so the claim Atlas is answerable for is "no error KIND the
    // classic walk did not already produce". Counts legitimately differ (different poll counts), so
    // the comparison is over kinds. Both walks visit exactly the same URLs, which is what makes it
    // mean anything.
    const introduced = [...new Set(consoleErrors.errors)].filter((e) => !new Set(classicNoise).has(e));
    expect(introduced,
      `the Atlas redirect walk introduced ${introduced.length} error kind(s) the classic walk did not.\n`
      + `atlas (${consoleErrors.errors.length}): ${JSON.stringify([...new Set(consoleErrors.errors)])}\n`
      + `classic (${classicNoise.length}): ${JSON.stringify([...new Set(classicNoise)])}`)
      .toEqual([]);

    // The subset check could be satisfied by a classic walk that already logged everything, so this
    // absolute claim stands beside it: an UNCAUGHT EXCEPTION is never acceptable in either shell.
    expect(consoleErrors.errors.filter((e) => e.startsWith("pageerror:")),
      "the Atlas redirect walk threw an uncaught exception").toEqual([]);
    expect(classicNoise.filter((e) => e.startsWith("pageerror:")),
      "the classic redirect walk threw an uncaught exception, so the contrast case above is not a clean baseline")
      .toEqual([]);
  });

  test("an incoming query string is dropped on redirect, identically under both shells", async ({ page, loomDaemon }) => {
    // These redirects target a plain path string, so react-router resolves it as given: the incoming
    // query and hash go, and a target's own `?tab=` survives. That is what they have always done, so
    // PARITY here means dropping it under Atlas too — the point of this test is that the two shells
    // agree, not that either behaviour is independently desirable.
    //
    // Measured, not assumed: the classic shell's landing URL is captured first and the Atlas shell is
    // then required to reproduce it. If today's behaviour were in fact to preserve the query, this
    // test would still be the right test — it would just record a different URL.
    test.setTimeout(120_000);
    const { rows } = parseLegacyRedirects();
    const project = await loomDaemon.createProject(`atlas-redirect-query-${Date.now()}`);
    await pinProject(page, project.id);

    // Both polarities, so neither outcome can pass by accident: a target that pins its OWN `?tab=`
    // (where a carried query would also have to lose a collision) and one that pins none (where
    // there is nothing for an incoming query to collide WITH, so preserving it would be invisible to
    // a tab assertion). Picked from the parsed rows, never named here.
    const withTab = rows.find((r) => tabOf(r.to));
    const withoutTab = rows.find((r) => !tabOf(r.to));
    expect(withTab, "no declared redirect pins a ?tab=, so the collision case cannot be exercised").toBeDefined();
    expect(withoutTab, "every declared redirect pins a ?tab=, so the bare case cannot be exercised").toBeDefined();

    const QUERY = "?from=legacy&keep=0";
    const HASH = "#section";
    const cases = [withTab!, withoutTab!];

    const classic = new Map<string, string>();
    for (const r of cases) {
      await page.goto(loomDaemon.baseURL + r.from + QUERY + HASH);
      await expect(page.locator(".loom-rail")).toBeVisible();
      // Wait for the redirect to have HAPPENED without saying where to — `goto` resolves on load,
      // and the history write lands on the first render after it. A predicate on "no longer the old
      // path" settles it while still letting the captured URL be whatever the app chose.
      await page.waitForURL((u) => u.pathname !== r.from);
      classic.set(r.from, page.url());
    }

    await seedAtlasOn(page);
    for (const r of cases) {
      await page.goto(loomDaemon.baseURL + r.from + QUERY + HASH);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(page.getByTestId("atlas-empty")).toHaveCount(0);
      await expect(page,
        `${r.from}${QUERY}${HASH} landed on a different URL under Atlas than under the classic shell`)
        .toHaveURL(classic.get(r.from) ?? "");
      // And the landing is still the declared target, so "identical" is not two shells being
      // identically wrong about where the redirect goes. This is also where the drop is PINNED: the
      // declared target carries no `from=legacy`/`keep=0`/`#section`, so an equality with it is the
      // assertion that neither the query nor the hash was carried across.
      await expect(page, `${r.from}${QUERY}${HASH} did not land on its declared target`)
        .toHaveURL(loomDaemon.baseURL + r.to);
    }
  });

  test("a redirected destination's own controls still work inside the Atlas frame", async ({ page, loomDaemon }) => {
    // Rendering clean proves the page drew. The sub-tab a redirect lands on is a real control, so it
    // is EXERCISED here with an observable before/after: arriving via /git must select Git, and
    // clicking the other tab must actually move both the selection and the URL.
    test.setTimeout(120_000);
    const { rows } = parseLegacyRedirects();
    const tabbed = rows.find((r) => tabOf(r.to));
    expect(tabbed, "no declared redirect pins a ?tab= to exercise").toBeDefined();
    const target = tabbed!;
    const pinnedTab = tabOf(target.to)!;

    const project = await loomDaemon.createProject(`atlas-redirect-exercise-${Date.now()}`);
    await pinProject(page, project.id);
    await seedAtlasOn(page);

    await page.goto(loomDaemon.baseURL + target.from);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();

    const selected = page.locator('[role="tab"][aria-selected="true"]');
    await expect(selected).toHaveText(new RegExp(`^${pinnedTab}$`, "i"));

    // The OTHER tab in the same tablist — found by exclusion, so this never names a label.
    const others = page.locator('[role="tab"][aria-selected="false"]');
    await expect(others).not.toHaveCount(0);
    const otherLabel = (await others.first().innerText()).trim();
    expect(otherLabel.toLowerCase(), "the two tabs read the same").not.toBe(pinnedTab.toLowerCase());

    await others.first().click();
    // Observable state change, in the DOM and in the URL: the selection moved off the pinned tab,
    // and the address no longer pins it.
    //
    // Compared through innerText on BOTH sides, lowercased. `otherLabel` above was read with
    // innerText, which folds Segmented's CSS `text-transform: uppercase` into its result ("PROFILES"),
    // while toHaveText compares textContent ("Profiles") — so the two differ by case alone and a
    // direct toHaveText(otherLabel) fails for a purely presentational reason.
    await expect
      .poll(async () => (await page.locator('[role="tab"][aria-selected="true"]').innerText()).trim().toLowerCase(), {
        message: "clicking the other tab did not move the selection to it",
      })
      .toBe(otherLabel.toLowerCase());
    await expect(page).not.toHaveURL(new RegExp(`tab=${pinnedTab}`));
    // Still the same node, still inside the Atlas frame — switching a tab is not a navigation out.
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await expect(page.getByTestId(`atlas-node-${pathOf(target.to)}`)).toHaveClass(/is-active/);
  });
});
