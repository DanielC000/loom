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
import { PAGE_SUB_TAB, expect, test, type Page } from "./fixtures/daemon";

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
  // Card 25c08fba — /vault and /git are the redirects that land here. /repository is now a TAB on the
  // project node, so under Atlas the address renders the node (its tab row + counts) with Repository
  // as the tab body, where the classic shell still renders the bare page. It is the only one of that
  // card's eight re-homed paths any redirect targets, and this map's own positive control above
  // rejects a path that none does.
  "/repository": "25c08fba — a tab on the project node, under its tab row and counts",
  // Card 5afd71bd — /workspace is the redirect that lands here. /projects is RETIRED under Atlas, so
  // the address renders no page of its own at all: it redirects on to the Workspace node, and what
  // this walk fingerprints is that node's content. The divergence is therefore total rather than the
  // dropped-header one card a7f23a2f gave this row before. The redirect and landed-node halves are
  // asserted in the walk's own retired branch; this row is only the CONTENT half, which is all this
  // map can express. (It is still the only one of either card's pages any declared redirect targets,
  // and this map's own positive control above rejects a path that none does.)
  "/projects": "5afd71bd — retired, so the address renders the Workspace node rather than this page",
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
/** A target's own params as a sorted `key=value` list. */
const paramsOf = (to: string) =>
  [...new URLSearchParams(to.split("?")[1] ?? "")].map(([k, v]) => `${k}=${v}`).sort();

/**
 * A landed URL reduced to pathname + SORTED params + hash — card 260fb29a.
 *
 * Order-insensitive on purpose: a carried query is MERGED with the target's own, and where each key
 * lands in the resulting string is an implementation detail of that merge (and of the second Atlas hop
 * that re-keys a sub-tab). Comparing raw strings would make this walk fail over param ORDER, which is
 * not a claim anybody wants to pin. The hash is kept as its own field so the walk can still say
 * something about it rather than quietly folding it in.
 */
function addressOf(url: string): { pathname: string; params: string[]; hash: string } {
  const u = new URL(url);
  return {
    pathname: u.pathname,
    params: [...u.searchParams].map(([k, v]) => `${k}=${v}`).sort(),
    hash: u.hash,
  };
}

// ── Where a target lives under ATLAS, which is no longer always its own path (card 41eab0eb) ───
// Seven cross-project destinations became WORKSPACE NODE TABS, so under Atlas their addresses chain
// one hop further: `/skills` → `/actors?tab=skills` → `/home?tab=actors&sub=skills`. The classic
// shell is untouched, which is the whole point of the card and the reason this cannot be expressed as
// a second LEGACY_REDIRECTS row — that declaration carries ONE target for both shells by design.
//
// Parsed from the real `WORKSPACE_NODE_TABS` declaration, same idiom and same raw-marker control as
// `parseLegacyRedirects` above, so a tab added later is covered here the day it is declared.
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

/** `from` → tab key, with the parse's own controls run at the call site. */
function nodeTabsUnderTest(): Map<string, string> {
  const { rows, rawMarkers, block } = parseWorkspaceNodeTabs();
  expect(rows.length, `the WORKSPACE_NODE_TABS parse found no rows. Block:\n${block}`).toBeGreaterThan(0);
  expect(rows.length,
    `the parse returned ${rows.length} row(s) but the declaration contains ${rawMarkers} entries`
    + ` — the pattern is dropping rows. Block:\n${block}`).toBe(rawMarkers);
  return new Map(rows.map((r) => [r.from, r.key]));
}

// The PROJECT node's own tabs (card 25c08fba), which card ec1aa18e made the sole home of those
// addresses by taking their duplicate tree rows away. Parsed from the same source, with a raw-marker
// control counting quoted `to:`s rather than `key:`s: the two HOME tabs address the node's own path
// through a constant and a template literal, carry no quoted `to`, and are not re-homed addresses —
// so 8 of 8 quoted targets is the real claim, where 8 of 10 `key:` markers would look like a
// dropping pattern. `isRehomedProjectTab` in src/nav.tsx draws the same line in the app.
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

/** `from` → project tab key, with the parse's own controls run at the call site. */
function projectNodeTabsUnderTest(): Map<string, string> {
  const { rows, rawMarkers, block } = parseProjectNodeTabs();
  expect(rows.length, `the PROJECT_NODE_TABS parse found no re-homed rows. Block:\n${block}`)
    .toBeGreaterThan(0);
  expect(rows.length,
    `the parse returned ${rows.length} row(s) but the declaration contains ${rawMarkers} quoted`
    + ` addresses — the pattern is dropping rows. Block:\n${block}`).toBe(rawMarkers);
  return new Map(rows.map((r) => [r.from, r.key]));
}

/**
 * The RETIRED destinations (card 5afd71bd), `from` → the node that absorbed them. Parsed from the real
 * `ATLAS_RETIREMENTS` declaration with the same raw-marker control as the tab parse above, for the
 * same reason: a regex that quietly stopped matching a row hands back a plausible SUBSET.
 *
 * This file needs them because one declared redirect targets a retired destination, so the Atlas
 * landing for that row is two hops rather than one.
 */
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

/** The host's sub-key for a guest's own tab — components/AtlasShell.tsx's `WORKSPACE_SUB_KEY`. */
const SUB_KEY = "sub";

/**
 * The ATLAS landing for a declared redirect target. Identical to `to` for a destination that still
 * owns its own address; the node-tab address, with any pinned `?tab=` translated onto `sub`, for one
 * card 41eab0eb re-homed. The translation is the behaviour under test, not an accommodation: a
 * dropped sub-tab would silently land `/skills` on Profiles under one shell and Skills under the other.
 */
function atlasLandingFor(to: string, nodeTabs: Map<string, string>): string {
  // A RETIRED target (card 5afd71bd) is checked FIRST and resolves to the node that absorbed it. One
  // declared redirect targets a retired destination — `/workspace` → `/projects` — so under Atlas that
  // row chains two hops and settles on `/home`. That second hop carries the incoming query too (card
  // 260fb29a): it renders the same `QueryPreservingRedirect` the LEGACY_REDIRECTS row does, so the row
  // chaining through it cannot preserve under one shell and drop under the other.
  const retired = retirementsUnderTest().get(pathOf(to));
  if (retired) return retired;
  const key = nodeTabs.get(pathOf(to));
  if (!key) return to;
  const sub = tabOf(to);
  return `/home?tab=${key}${sub ? `&${SUB_KEY}=${sub}` : ""}`;
}

// ── Instruments (same shapes as atlas-tree / atlas-param-routes) ───────────────────────────────
const FINGERPRINT_DEPTH = 4;

// `root` is what the page's own content hangs off: `main` normally, or a `atlas-tabpanel-<key>`
// wrapper for a destination card 41eab0eb re-homed as a Workspace node tab — its component is mounted
// verbatim inside that wrapper, so the panel's CHILDREN produce the exact string the classic `main`
// walk produces and the identity claim survives the re-frame.
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
      // An <svg>'s interior says nothing about page structure; the svg ELEMENT is still recorded.
      if (depth >= depthCap || el.tagName.toLowerCase() === "svg") return;
      for (const child of Array.from(el.children)) walk(child, depth + 1);
    };
    const host = document.querySelector(rootSelector as string);
    if (host) for (const child of Array.from(host.children)) walk(child, 0);
    return out.join("\n");
  }, [maxDepth, root] as const);
}

// ── Readiness: when is a page's fingerprint safe to take? ──────────────────────────────────────
// These destinations are react-query reads, so a fingerprint taken straight after a navigation is a
// coin flip on which parts have resolved. "Two consecutive reads agree" is NOT enough on its own and
// this spec measured it failing (card 625d791c): a page that has not yet received its data is
// perfectly STABLE in its placeholder state, so the poll settles on the placeholder and returns it as
// if it were the finished page. Stability says the page STOPPED CHANGING; it cannot distinguish
// "finished" from "has not started". /repository?tab=git is the specimen — its radiogroup (card
// 3f28f1c3; it was a tablist when this was written) renders synchronously while the body holds a
// one-<p> placeholder until the git read lands:
//
//     div                               div
//       div[role=radiogroup]              div[role=radiogroup]
//         button[role=radio] x2             button[role=radio] x2
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
async function settledPageSkeleton(page: Page, api: ReturnType<typeof trackApiRequests>, root = "main"): Promise<string> {
  let last = await pageSkeleton(page, FINGERPRINT_DEPTH, root);
  let sawRequest = api.startedSinceMark() > 0;
  for (let i = 0; i < SETTLE_MAX_SAMPLES; i++) {
    const quietAtStart = api.inFlight() === 0;
    api.mark();
    await page.waitForTimeout(SETTLE_INTERVAL_MS);
    const startedDuringWindow = api.startedSinceMark();
    if (startedDuringWindow > 0) sawRequest = true;
    const next = await pageSkeleton(page, FINGERPRINT_DEPTH, root);
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

// The selected tab of the PAGE's own sub-tab control — never the Atlas NODE's tab row, and never a
// neighbouring radiogroup. `PAGE_SUB_TAB` lives in fixtures/daemon.ts (read its own doc comment for
// why each of its three filters is load-bearing): this spec and atlas-workspace-tabs.spec.ts both
// read it, so the two kinds of node tab row can never be filtered by two drifting rules.
const pageSubTabs = (page: Page, selected: boolean) => page.locator(PAGE_SUB_TAB(selected));

/**
 * Where the TREE says a destination lives, read off the rendered tree rather than re-derived from
 * nav.tsx's `scoped` flag: the node's own label, and whether it hangs under the project node
 * (`ul.loom-atlas-nodes.is-kids`, AtlasTree's project level) or at workspace depth. That makes the
 * expected crumb trail a statement about tree/frame AGREEMENT — the only thing worth asserting,
 * since a frame that derived its depth from a different input than the tree is exactly the bug.
 *
 * Card 0d0c6cee: a redirect target may no longer BE a tree node. The ten cross-project destinations
 * moved to the escape hatch at the foot of the tree, and a hatch entry carries the same
 * `.loom-atlas-lbl` — derived from the same `NAV_PAGES` row — so the agreement claim survived that
 * move intact rather than degrading to a literal typed in here.
 *
 * Card 41eab0eb: seven of those became WORKSPACE NODE TABS, which is the third place a destination's
 * name can now come from — its tab in the node's own row, whose label is resolved from that same
 * `NAV_PAGES` / `ATLAS_HOMES` row. So the fallback chain is node → hatch entry → node tab, exactly as
 * this function's predecessor predicted it would need to be. WHICH of the three answered is reported
 * back, because it decides what the tree may MARK and what the frame may be HEADED (see the caller).
 *
 * Card ec1aa18e: a PROJECT node tab is the fourth. Card 25c08fba made those tabs while leaving each
 * one a tree row too, so this helper used to resolve them off the row; that card's own duplication
 * is what the owner's feedback removed, so they resolve off the project node's tab row now — the
 * same read the Workspace branch above makes, one tier down.
 */
type TreeAddress = {
  label: string; underProject: boolean; homed: boolean; tabKey?: string; projTabKey?: string;
};

/** A node tab's own label, read off its anchor's TEXT nodes — a count rides inside it as a
 *  `.loom-atlas-tabcount` span, so a bare textContent read returns "Inbox1". */
async function nodeTabLabel(page: Page, key: string, what: string): Promise<string> {
  const tab = page.getByTestId(`atlas-tab-${key}`);
  await expect(tab, `${what} renders no "${key}" tab`).toHaveCount(1);
  const label = await tab.evaluate((el) => Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim());
  expect(label, `${what}'s ${key} tab renders no label`).not.toBe("");
  return label;
}

async function treeNodeAddress(
  page: Page, to: string, nodeTabs: Map<string, string>, projectTabs: Map<string, string>,
): Promise<TreeAddress> {
  const tabKey = nodeTabs.get(to);
  if (tabKey) {
    const label = await nodeTabLabel(page, tabKey, "the Workspace node");
    return { label, underProject: false, homed: false, tabKey };
  }
  const projTabKey = projectTabs.get(to);
  if (projTabKey) {
    // Read while the page is ALREADY on that address, so the tab is the selected one and therefore
    // in the row rather than folded into the overflow menu (card d4350286) — the caller navigates
    // before calling, which is what makes a direct `atlas-tab-<key>` read sound here.
    const label = await nodeTabLabel(page, projTabKey, "the project node");
    return { label, underProject: true, homed: false, projTabKey };
  }
  const node = page.getByTestId(`atlas-node-${to}`);
  const homed = (await node.count()) > 0;
  // There is no second place left to look: card 5afd71bd deleted the escape hatch, so a target that
  // is neither a node nor a tab is one whose placement was never decided. A RETIRED target never
  // reaches this helper — its caller answers it before calling, since it has no row to read.
  await expect(node, `the tree has no node for ${to}, and it is neither a node tab nor`
    + ` retired — the escape hatch that used to hold such a destination is gone`).toHaveCount(1);
  const row = node;
  const label = (await row.locator(".loom-atlas-lbl").innerText()).trim();
  expect(label, `the tree's ${to} row renders no label`).not.toBe("");
  const underProject = homed && await row.evaluate((el) => !!el.closest("ul.loom-atlas-nodes.is-kids"));
  return { label, underProject, homed };
}

test.describe("Atlas legacy redirects (card 82bde849)", () => {
  test("every declared redirect lands on its Atlas node + tab, and is untouched with the switch off", async ({ page, loomDaemon }) => {
    // N redirects × (an off-shell capture with a settle loop + an on-shell capture with one), plus
    // the query-string case, is far past the 30s default.
    test.setTimeout(300_000);
    const consoleErrors = collectConsoleErrors(page);
    const api = trackApiRequests(page);

    // ── The table under test, parsed from the real declaration ──
    const nodeTabs = nodeTabsUnderTest();
    const projectTabs = projectNodeTabsUnderTest();
    // One declared redirect targets a destination card 5afd71bd RETIRED, so its Atlas landing is the
    // node that absorbed that destination rather than the declared target. Derived, so the next card
    // to retire or un-retire something moves this row's expectation by editing src/nav.tsx alone.
    const retirements = retirementsUnderTest();
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

      // Same landing URL as the classic shell produced — the ONE declaration, proven to be one —
      // EXCEPT where card 41eab0eb re-homed the target into a Workspace node tab, which is the one
      // deliberate shell divergence (see `atlasLandingFor`). A retrying assertion, not a bare
      // page.url() read: `goto` resolves on load, and the redirect is a client-side history write
      // that happens on the first render AFTER it.
      const landing = atlasLandingFor(r.to, nodeTabs);
      if (landing === r.to) {
        await expect(page, `${r.from} landed somewhere different under Atlas than under the classic shell`)
          .toHaveURL(classic.get(r.from)?.url ?? "");
      } else {
        await expect(page, `${r.from} did not chain into its Workspace node tab under Atlas`)
          .toHaveURL(loomDaemon.baseURL + landing);
        // The divergence is only ever Atlas-side: the classic landing stays the declared target.
        expect(classic.get(r.from)?.url, `${r.from} redirected differently under the CLASSIC shell too`)
          .toBe(loomDaemon.baseURL + r.to);
      }

      // ── The right NODE: the tree marks it, the heading names it, the crumbs lead to it. ──
      // A RETIRED target (card 5afd71bd) is answered FIRST and separately: it has no tree row and no
      // tab, so `treeNodeAddress` has nothing to resolve for it. What it lands on is the node that
      // absorbed the retired destination — today always the Workspace node, which is its tier's head,
      // so the trail stops at "Workspace" and the heading is that same word.
      const retiredTarget = retirements.get(pathOf(r.to));
      const address = retiredTarget ? null : await treeNodeAddress(page, pathOf(r.to), nodeTabs, projectTabs);
      const { label, underProject, homed, tabKey, projTabKey } = address
        ?? {
          label: "", underProject: false, homed: false,
          tabKey: undefined as string | undefined, projTabKey: undefined as string | undefined,
        };
      if (retiredTarget) {
        expect(retiredTarget,
          `this leg only knows how to check a retirement onto /home, not ${retiredTarget}`).toBe("/home");
        await expect(page.locator("a.loom-atlas-node.is-active"),
          `${r.from} chained through a retired target, so exactly one node may read as landed`).toHaveCount(1);
        await expect(page.getByTestId("atlas-home-workspace")).toHaveClass(/is-active/);
        await expect(nodeHeading(page)).toHaveText("Workspace");
        expect(await crumbTrail(page), `${r.from} produced the wrong breadcrumb trail`).toEqual(["Workspace"]);
        // The node's OWN canonical first tab is selected, not one of the seven re-homed guests: a
        // retirement lands on the node, not on a tab of it. The same `aria-selected` reading is taken
        // on a guest tab in the branch below, which is the control that this attribute is really read.
        await expect(page.getByTestId("atlas-tab-overview"),
          `${r.from} reached the Workspace node without its own Overview tab selected`)
          .toHaveAttribute("aria-selected", "true");
        // The page-content claim still runs below, through REBUILT_IN_PHASE_2's inversion.
      } else if (tabKey) {
        // A node TAB lives on the Workspace node, so that node — and only it — reads as landed, and
        // the frame is headed for the NODE, not the tab. That is the approved design's own shape:
        // every `ROOT_TABS` view declares `node: "root"` and `title: "Workspace"`.
        await expect(page.locator("a.loom-atlas-node.is-active"),
          `${r.from} lands on a Workspace node tab, so exactly one node may read as landed`).toHaveCount(1);
        await expect(page.getByTestId("atlas-home-workspace")).toHaveClass(/is-active/);
        await expect(page.getByTestId(`atlas-tab-${tabKey}`),
          `${r.from} reached the Workspace node without selecting its ${tabKey} tab`)
          .toHaveAttribute("aria-selected", "true");
        await expect(nodeHeading(page)).toHaveText("Workspace");
        expect(await crumbTrail(page), `${r.from} produced the wrong breadcrumb trail`).toEqual(["Workspace"]);
      } else if (projTabKey) {
        // A PROJECT node tab (card 25c08fba) keeps its own address, so unlike a Workspace tab there
        // is no extra hop — but since card ec1aa18e it has no tree row either, so the landed mark is
        // the project HOME row's, exactly as the Workspace home carries it for its own tabs. The
        // heading and the deepest crumb are the TAB's label, under the project's own crumb.
        await expect(page.locator("a.loom-atlas-node.is-active"),
          `${r.from} lands on a project node tab, so exactly one node may read as landed`).toHaveCount(1);
        await expect(page.getByTestId("atlas-home-project")).toHaveClass(/is-active/);
        await expect(page.getByTestId(`atlas-node-${pathOf(r.to)}`),
          `${pathOf(r.to)} is a project node tab and still an Atlas tree row`).toHaveCount(0);
        await expect(page.getByTestId(`atlas-tab-${projTabKey}`),
          `${r.from} reached the project node without selecting its ${projTabKey} tab`)
          .toHaveAttribute("aria-selected", "true");
        await expect(nodeHeading(page)).toHaveText(label);
        expect(await crumbTrail(page), `${r.from} produced the wrong breadcrumb trail`)
          .toEqual(["Workspace", project.name, label]);
      } else {
        if (homed) {
          await expect(page.getByTestId(`atlas-node-${pathOf(r.to)}`),
            `${r.from} landed without marking the ${pathOf(r.to)} node in the tree`).toHaveClass(/is-active/);
          await expect(page.locator("a.loom-atlas-node.is-active"),
            `${r.from} marked more than one tree node`).toHaveCount(1);
        } else {
          // UNREACHABLE as of card 5afd71bd, which deleted the escape hatch — `treeNodeAddress` above
          // already throws for a target that is neither a node nor a tab, so this branch can only be
          // reached by a hatch being re-added. Kept as an explicit failure rather than deleted: a
          // destination with no node is a real state the walk must never silently accept, and the
          // message is what tells the next reader which of the four placements is missing.
          expect(homed,
            `${r.from} lands on ${pathOf(r.to)}, which has no tree node, no Workspace node tab and no`
            + ` retirement — the escape hatch that used to hold such a destination was deleted with`
            + ` card 5afd71bd, so this address is unreachable. Give it one of the four placements.`).toBe(true);
        }
        await expect(nodeHeading(page)).toHaveText(label);
        // Depth comes from the tree itself: a project-level node hangs under the project crumb.
        expect(await crumbTrail(page), `${r.from} produced the wrong breadcrumb trail`)
          .toEqual(["Workspace", ...(underProject ? [project.name] : []), label]);
      }

      // ── The right SUB-TAB, where the target pins one. Chromium folds Segmented's CSS
      // `text-transform: uppercase` into the accessible name, so match case-insensitively — and
      // derive the expected label from the `?tab=` value rather than hand-mapping it. Scoped to the
      // page's own panel where a node tab hosts it: the node's own tab row is a second tab row on
      // that document, so a page-wide count of one would be false for a reason that is not a defect.
      const tab = tabOf(r.to);
      if (tab) {
        // BOTH scopes are needed, because there are two kinds of node tab row above a page now.
        // A WORKSPACE node tab (card 41eab0eb) hosts the page in a panel, so scoping to that panel
        // leaves the node's row outside it. A PROJECT node tab (card 25c08fba) renders the node's row
        // INSIDE `main` — `/repository?tab=git` is exactly that — so the panel scope does not reach
        // it and `PAGE_SUB_TAB`'s own filtering is what keeps the count at one.
        const scope = tabKey
          ? page.getByTestId(`atlas-tabpanel-${tabKey}`)
          : page.locator("main");
        const selected = scope.locator(PAGE_SUB_TAB(true));
        await expect(selected, `${r.from} → ${r.to} did not select exactly one sub-tab`).toHaveCount(1);
        await expect(selected, `${r.from} → ${r.to} selected the wrong sub-tab`)
          .toHaveText(new RegExp(`^${tab}$`, "i"));
      }

      // ── The same PAGE: structurally what the classic redirect landed on — unless a phase-2 card
      //    has rebuilt that destination, in which case the claim inverts (see REBUILT_IN_PHASE_2).
      //    A node-tab destination was re-FRAMED, not rebuilt, so its component is compared at its own
      //    panel wrapper, where the comparison is still exact. ──
      const after = await settledPageSkeleton(page, api,
        tabKey ? `[data-testid="atlas-tabpanel-${tabKey}"]` : "main");
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

    // This walk keeps the KIND-only comparison (card 8cbb2ac2) rather than an absolute zero, even
    // though GET /api/platform/home no longer 404s on this fixture (card 8d82be67 fixed that specific
    // noise source) — some OTHER page in this walk could still log a console error neither shell is
    // answerable for, and the subset claim below stays correct either way. Counts legitimately differ
    // (different poll counts), so the comparison is over kinds. Both walks visit exactly the same
    // URLs, which is what makes it mean anything.
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

  test("every declared redirect carries an incoming query through, identically under both shells", async ({ page, loomDaemon }) => {
    // Card 260fb29a. These redirects USED to resolve a plain path string, which drops the incoming
    // search — so every deep link ever issued at a renamed address landed with nothing selected, in
    // both shells. A legacy redirect is a RENAME, not a hop to a different page, so the params a user
    // pasted at the old address were always meant for the page they land on; they now ride along.
    //
    // ONE LEG PER DECLARED ROW, derived from the parse — not the two polarity cases this test checked
    // while the behaviour was a drop. A row is covered the day it is declared, with no edit here.
    //
    // Measured, not asserted from memory: the classic shell's landing is CAPTURED first and the Atlas
    // shell is then required to agree with it, so "identically under both shells" stays a measurement.
    test.setTimeout(300_000);
    const { rows, rawMarkers, block } = parseLegacyRedirects();
    // The same three positive controls the walk above runs on this parse — this test iterates every
    // row, so a quietly-narrowed regex here would silently shrink the population it checks.
    expect(rows.length, `the LEGACY_REDIRECTS parse found no rows. Block:\n${block}`).toBeGreaterThan(0);
    expect(rows.length,
      `the parse returned ${rows.length} row(s) but the declaration contains ${rawMarkers} redirect( marker(s)`
      + ` — the pattern is dropping rows. Block:\n${block}`).toBe(rawMarkers);
    expect(rows, "positive control: the parse did not resolve /git, a row the declaration is known to carry")
      .toContainEqual({ from: "/git", to: "/repository?tab=git" });

    const nodeTabs = nodeTabsUnderTest();
    const project = await loomDaemon.createProject(`atlas-redirect-query-${Date.now()}`);
    await pinProject(page, project.id);

    // Namespaced sentinel keys, so no page can plausibly read one and act on it — the claim is that
    // the params ARRIVE, never that anything consumes them. A collision probe rides along on a row
    // that pins its own `?tab=`: `tab=deeplinkprobe-loses` must NOT survive, because the row's own tab
    // is the row's whole meaning (`/skills` means "the Skills tab of /actors").
    const KEPT = ["deeplinkprobe=kept", "deeplinkprobe2=also-kept"];
    const COLLIDING_TAB = "tab=deeplinkprobe-loses";
    const HASH = "#section";
    const queryFor = (r: Redirect) =>
      "?" + [...KEPT, ...(tabOf(r.to) ? [COLLIDING_TAB] : [])].join("&");

    // Both polarities are present ACROSS the rows, and that is checked rather than assumed: a run in
    // which every row happened to pin a tab (or none did) would leave one half of the merge rule
    // unexercised while still reporting a full sweep.
    expect(rows.some((r) => tabOf(r.to)),
      "no declared redirect pins a ?tab=, so the collision half of the merge rule is unexercised").toBe(true);
    expect(rows.some((r) => !tabOf(r.to)),
      "every declared redirect pins a ?tab=, so the bare-carry half is unexercised").toBe(true);

    /** What the landing must carry: the target's own params (which WIN) plus the sentinels. */
    const expectedParams = (landing: string) => [...paramsOf(landing), ...KEPT].sort();

    // ── Phase 1: the CLASSIC shell ──
    const classic = new Map<string, ReturnType<typeof addressOf>>();
    for (const r of rows) {
      await page.goto(loomDaemon.baseURL + r.from + queryFor(r) + HASH);
      await expect(page.locator(".loom-rail")).toBeVisible();
      // `goto` resolves on LOAD; the redirect is a client-side history write on the first render
      // after it. Settle on "no longer the old path" rather than on a predicted destination, so the
      // captured address is whatever the app actually chose.
      await page.waitForURL((u) => u.pathname !== r.from);
      const landed = addressOf(page.url());
      expect(landed.params, `${r.from} dropped the incoming query under the classic shell`)
        .toEqual(expectedParams(r.to));
      expect(landed.pathname, `${r.from} did not land on its declared target under the classic shell`)
        .toBe(pathOf(r.to));
      classic.set(r.from, landed);
    }

    // ── Phase 2: the ATLAS shell, same old URLs ──
    await seedAtlasOn(page);
    for (const r of rows) {
      await page.goto(loomDaemon.baseURL + r.from + queryFor(r) + HASH);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(page.getByTestId("atlas-empty")).toHaveCount(0);

      // Where card 41eab0eb re-homed the target into a Workspace node tab, or card 5afd71bd RETIRED
      // it, the Atlas landing chains one hop further — `atlasLandingFor` derives which. BOTH extra
      // hops have to carry the query too, or the row that chains through one would preserve under the
      // classic shell and drop under Atlas: a per-shell divergence in the one place both shells are
      // declared from the same row.
      const landing = atlasLandingFor(r.to, nodeTabs);
      await expect(page, `${r.from} did not reach its Atlas landing`)
        .toHaveURL(new RegExp(`^${loomDaemon.baseURL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${pathOf(landing)}\\?`));
      const landed = addressOf(page.url());
      expect(landed.params, `${r.from} dropped the incoming query under the ATLAS shell`)
        .toEqual(expectedParams(landing));

      // THE COLLISION RULE, where the row pins a tab: the target's own value is what survives, and
      // the incoming one is gone. Read off whichever key actually carries a sub-tab at the landing —
      // `tab=` normally, `sub=` once a Workspace node tab hosts the page and takes `tab=` for itself.
      const pinned = tabOf(r.to);
      if (pinned) {
        const key = atlasLandingFor(r.to, nodeTabs) === r.to ? "tab" : SUB_KEY;
        expect(landed.params, `${r.from}'s own ?tab=${pinned} lost its collision with the incoming one`)
          .toContain(`${key}=${pinned}`);
        expect(landed.params.join("&"), `the incoming ${COLLIDING_TAB} re-pointed ${r.from} at a tab it never named`)
          .not.toContain("deeplinkprobe-loses");
      }

      // Identical to the classic landing, except for the hop the two cards above deliberately added.
      if (landing === r.to) {
        expect(landed, `${r.from} landed differently under Atlas than under the classic shell`)
          .toEqual(classic.get(r.from));
      }

      // The HASH is NOT part of this card's change, and both shells still drop it. Stated as a parity
      // claim only — that the two agree — never that dropping it is independently desirable.
      expect(landed.hash, `${r.from} started carrying ${HASH} under Atlas alone`)
        .toBe(classic.get(r.from)?.hash ?? "");
      expect(landed.hash, `${r.from} carried ${HASH} through; this card changed the SEARCH only`).toBe("");
    }
  });

  test("a redirected destination's own controls still work inside the Atlas frame", async ({ page, loomDaemon }) => {
    // Rendering clean proves the page drew. The sub-tab a redirect lands on is a real control, so it
    // is EXERCISED here with an observable before/after: arriving via /git must select Git, and
    // clicking the other tab must actually move both the selection and the URL.
    test.setTimeout(120_000);
    const { rows } = parseLegacyRedirects();
    const nodeTabs = nodeTabsUnderTest();
    const projectTabs = projectNodeTabsUnderTest();
    const tabbed = rows.find((r) => tabOf(r.to));
    expect(tabbed, "no declared redirect pins a ?tab= to exercise").toBeDefined();
    const target = tabbed!;
    const pinnedTab = tabOf(target.to)!;
    // Where a node tab hosts the page, the node's own tab row is a SECOND tablist on this document,
    // so every locator below is scoped to the page's own panel. Unscoped they would resolve the
    // node's tabs as readily as the page's and the exercise would be measuring the wrong control.
    const hostKey = nodeTabs.get(pathOf(target.to));
    const scope = () => (hostKey ? page.getByTestId(`atlas-tabpanel-${hostKey}`) : page.locator("main"));

    const project = await loomDaemon.createProject(`atlas-redirect-exercise-${Date.now()}`);
    await pinProject(page, project.id);
    await seedAtlasOn(page);

    await page.goto(loomDaemon.baseURL + target.from);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();

    const selected = scope().locator(PAGE_SUB_TAB(true));
    await expect(selected).toHaveText(new RegExp(`^${pinnedTab}$`, "i"));

    // The OTHER tab in the same radiogroup — found by exclusion, so this never names a label.
    const others = scope().locator(PAGE_SUB_TAB(false));
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
      .poll(async () => (await scope().locator(PAGE_SUB_TAB(true)).innerText()).trim().toLowerCase(), {
        message: "clicking the other tab did not move the selection to it",
      })
      .toBe(otherLabel.toLowerCase());
    // The pinned sub-tab is gone from the address — on whichever key actually carries it. Under a
    // node tab the page's own sub-tab rides `sub=`, and `tab=` is the HOST's (which must NOT move).
    await expect(page).not.toHaveURL(new RegExp(`${hostKey ? SUB_KEY : "tab"}=${pinnedTab}`));
    if (hostKey) {
      await expect(page, "the page's own sub-tab click moved the Workspace node off its tab")
        .toHaveURL(new RegExp(`[?&]tab=${hostKey}(&|$)`));
    }
    // Still the same destination, still inside the Atlas frame — switching a tab is not a
    // navigation out. WHICH control carries the mark depends on where cards 0d0c6cee / 41eab0eb left
    // this destination; `treeNodeAddress` answers that off the rendered frame, so this assertion
    // follows the destination rather than assuming where it lives.
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    const landed = await treeNodeAddress(page, pathOf(target.to), nodeTabs, projectTabs);
    if (landed.tabKey) {
      await expect(page.getByTestId(`atlas-tab-${landed.tabKey}`)).toHaveAttribute("aria-selected", "true");
    } else if (landed.projTabKey) {
      // A PROJECT node tab's own mark is on the project Home row (card ec1aa18e) — the tab itself is
      // still what reads selected, which is the claim here.
      await expect(page.getByTestId(`atlas-tab-${landed.projTabKey}`))
        .toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("atlas-home-project")).toHaveClass(/is-active/);
    } else {
      // `treeNodeAddress` already required a node to exist for a non-tab target (the escape hatch it
      // used to fall back to went with card 5afd71bd), so this is the node's own landed mark.
      await expect(page.getByTestId(`atlas-node-${pathOf(target.to)}`)).toHaveClass(/is-active/);
    }
  });
});
