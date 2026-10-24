// The Atlas parameterized addresses (card 1d3192dc, Atlas build plan P1-2 —
// docs/plans/atlas-ui/03-decomposition.md row P1-2). Homes per 01-parity-checklist.md §A:
// /review/:workerId → the worker node's Diff tab · /question/:id → the Inbox detail (+ its pop-over)
// · /session/:id → the session node itself.
//
// Phase 1 mounts, it does not redesign — so the claim under test is a PARITY claim, and it is
// asserted the same way P1-1's was: capture what each URL renders under the CLASSIC shell, then
// require the Atlas shell to render structurally the SAME thing at the SAME URL, with only the
// frame's crumbs and heading added on top. Nothing here hardcodes a page's expected markup.
//
// That claim EXPIRES one address at a time as phase 2 rebuilds them, and for those the assertion is
// INVERTED rather than skipped — see REBUILT_IN_PHASE_2 below, and the positive control that keeps
// the map from going silent.
//
// Every absence/equality claim carries a POSITIVE CONTROL first: a fingerprint comparison and a
// zero-console-error count read exactly the same whether the instrument works or is silently broken,
// so each is first shown firing against a known-bad state on the same page at the same moment.
import { expect, test, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json), so a spec
// cannot pull a `src/` module in — the same reason fixtures/daemon.ts hardcodes its own keys.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

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

// One file changed: +2 / −1. ReviewPanel parses the patch CLIENT-side (lib/diff), so this must be a
// real unified diff. The seeded worker has no worktree for the daemon to diff — the same reason
// worker-diff-staletime.spec.ts intercepts this endpoint — and without a payload the panel renders
// only its "no diff" rail, which would leave this spec comparing two near-empty pages.
const PATCH = [
  "diff --git a/src/widget.ts b/src/widget.ts",
  "index 1111111..2222222 100644",
  "--- a/src/widget.ts",
  "+++ b/src/widget.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  "",
].join("\n");

async function serveCannedDiff(page: Page) {
  await page.route("**/api/sessions/*/diff", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ filesChanged: 1, insertions: 2, deletions: 1, patch: PATCH, uncommitted: false }),
    }),
  );
}

// ── The page fingerprint ───────────────────────────────────────────────────────────────────────
// Same instrument as atlas-tree.spec.ts: every element under <main>, to a bounded depth, as tag +
// class list + role. NO text, NO ids, NO inline styles — so live data cannot move it while a
// genuinely different page still does. The depth cap keeps a page's deep, volatile row lists out of
// a comparison its identity does not need them for.
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

// These pages are react-query reads (and, on /session/:id, a terminal that mounts asynchronously), so
// a fingerprint taken straight after a navigation is a coin flip on which parts have resolved —
// measured on P1-0, where two identical runs disagreed. Sample until two consecutive reads agree.
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
    probe.id = "loom-param-skeleton-positive-control";
    main.insertBefore(probe, first);
    probe.appendChild(first);
  });
  const during = await pageSkeleton(page, FINGERPRINT_DEPTH);
  await page.evaluate(() => {
    const probe = document.getElementById("loom-param-skeleton-positive-control");
    const main = document.querySelector("main");
    const inner = probe?.firstElementChild;
    if (probe && main && inner) { main.insertBefore(inner, probe); probe.remove(); }
  });
  expect(during, "positive control: an injected wrapper did not move the page fingerprint").not.toBe(before);
  expect(await pageSkeleton(page, FINGERPRINT_DEPTH),
    "positive control: removing the wrapper did not restore the page fingerprint").toBe(before);
}

// Console + page errors, with their own positive control so a zero reading is only ever believed
// from a collector shown to fire.
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
// separator span, so the label is the last NON-hidden span — reading `li.textContent` would prefix
// every crumb with a slash that is presentation, not content.
async function crumbTrail(page: Page): Promise<string[]> {
  return page.getByTestId("atlas-breadcrumb").locator("li").evaluateAll((lis) =>
    lis.map((li) => {
      const spans = Array.from(li.querySelectorAll("span")).filter((s) => !s.hasAttribute("aria-hidden"));
      return (spans[spans.length - 1]?.textContent ?? "").trim();
    }),
  );
}

const nodeHeading = (page: Page) => page.locator(".loom-atlas-nodehead h1");
const shortId = (id: string) => id.slice(0, 8);

// ── Addresses PHASE 2 has deliberately REBUILT ─────────────────────────────────────────────────
// Phase 1's claim is a PARITY claim: the Atlas shell renders the same page the classic shell does at
// the same URL. That expires, one address at a time, as phase-2 cards rebuild them — and for a
// rebuilt address the honest assertion is the INVERSE: identity would mean the rebuild never landed.
//
// Keyed by the address PATTERN rather than the seeded URL, because the ids are minted per run.
//
// ⛔ Add an address here ONLY with the phase-2 card that rebuilds it. An address added to silence a
// red is a regression being filed as an exemption. Same contract, and the same wording, as
// atlas-tree.spec.ts's and atlas-legacy-redirects.spec.ts's own copies.
const REBUILT_IN_PHASE_2: Record<string, string> = {
  // Card 525c8ad9 (P2-7): /session/:id became the session NODE — the frame's own tab row over the
  // terminal, the identity de-duplicated into the crumb + node head, and the queue / wakes / bound
  // task inline below. The classic page still renders its own header row over a bordered card.
  "/session/:id": "525c8ad9 — rebuilt as the Atlas session node, identity de-duplicated",
  // Card 525c8ad9 (P2-7): /review/:workerId IS that node's Diff tab now, so it renders the whole node
  // with the review surface in the pane, not the standalone review page.
  "/review/:workerId": "525c8ad9 — rebuilt as the worker node's Diff tab",
};

test.describe("Atlas parameterized routes (card 1d3192dc)", () => {
  test("each parameterized URL renders the classic page verbatim and lands on its own node + tab", async ({ page, loomDaemon }) => {
    // 3 URLs × (an off-shell capture + an on-shell capture), each with a settle loop, plus a terminal
    // mount on /session/:id, is well past the 30s default.
    test.setTimeout(240_000);
    const consoleErrors = collectConsoleErrors(page);

    // ── Seed the three entities the three addresses name ──
    // Each session gets its OWN agentName and its OWN id prefix, deliberately. Sharing `agentId`
    // across seeded rows makes the fixture report its default "Seeded Agent" rather than the name
    // actually rendered, and the default id mint makes every row's short id read "e2e-live" — both
    // would leave the node-label assertions below unable to tell the two sessions apart.
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "AtlasParamMgr" });
    const worker = await loomDaemon.seedLiveSession({
      project: mgr.project, role: "worker", agentName: "AtlasParamWorker",
      id: `e2e-atlasworker-${Date.now()}`,
      parentSessionId: mgr.sessionId, branch: "loom/atlas-param-routes",
      task: { title: `atlas-param-${Date.now()}` },
    });
    const plain = await loomDaemon.seedLiveSession({
      project: mgr.project, role: "plain", agentName: "AtlasParamPlain",
      id: `e2e-atlasplain-${Date.now()}`,
    });
    const questionTitle = `Atlas param route decision ${Date.now()}`;
    const questionId = await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title: questionTitle,
      body: "Which placement should the parameterized addresses take?",
      options: ["The worker node's Diff tab", "A flat page"],
    });

    await serveCannedDiff(page);
    await pinProject(page, mgr.projectId);

    // The three URLs, each paired with a locator for content that ONLY that page renders — so the
    // structural comparison below is backed by a content claim, not just a matching element tree.
    const reviewUrl = `/review/${worker.sessionId}`;
    const questionUrl = `/question/${questionId}`;
    const sessionUrl = `/session/${plain.sessionId}`;
    // `pattern` is this address's REBUILT_IN_PHASE_2 key; `atlasContent` is the marker to assert under
    // ATLAS for an address whose content a phase-2 card replaced — the classic marker genuinely is gone
    // there, so requiring it would be asserting the rebuild did not happen.
    const addresses = [
      {
        url: reviewUrl,
        pattern: "/review/:workerId",
        content: (p: Page) => p.locator("main").getByText(new RegExp(`worker w:${shortId(worker.sessionId)}`)),
        atlasContent: (p: Page) => p.getByTestId("session-node-pane-diff").getByRole("button", { name: "Approve & merge" }),
      },
      {
        url: questionUrl,
        pattern: "/question/:id",
        content: (p: Page) => p.locator("main").getByText(questionTitle),
      },
      {
        url: sessionUrl,
        pattern: "/session/:id",
        content: (p: Page) => p.getByTestId("tile-identity"),
        atlasContent: (p: Page) => p.getByTestId("session-node-pane-terminal"),
      },
    ];

    // POSITIVE CONTROL on the carve-out itself: every REBUILT_IN_PHASE_2 key must be an address this
    // walk actually visits. Without it the map can go SILENT — an address that stops being walked makes
    // its inverted assertion simply not run, and the spec still reports green for an address nobody
    // checked either way. (atlas-tree.spec.ts installs the same control for the same reason.)
    for (const pattern of Object.keys(REBUILT_IN_PHASE_2)) {
      expect(addresses.map((a) => a.pattern),
        `REBUILT_IN_PHASE_2 names ${pattern}, which this walk does not visit — its inverted assertion`
        + " would never run").toContain(pattern);
    }
    // …and the inverse: a rebuilt address MUST declare what to look for under Atlas, or its own
    // "the page still rendered something" leg would have nothing to assert.
    for (const a of addresses) {
      if (REBUILT_IN_PHASE_2[a.pattern]) {
        expect(a.atlasContent, `${a.pattern} is marked rebuilt but names no Atlas content marker`).toBeTruthy();
      }
    }

    // ── Phase 1: the CLASSIC shell. Capture what each URL renders today. ──
    await page.goto(loomDaemon.baseURL + reviewUrl);
    await expect(page.locator(".loom-rail")).toBeVisible();
    await assertSkeletonInstrumentFires(page);

    const before = new Map<string, string>();
    for (const { url, content } of addresses) {
      await page.goto(loomDaemon.baseURL + url);
      // The classic route still behaves exactly as today — asserted HERE, on the real content, so a
      // regression from this card's own App.tsx route-table refactor fails before any Atlas claim is
      // reached rather than being absorbed into an ON-equals-OFF comparison of two broken pages.
      await expect(content(page)).toBeVisible();
      before.set(url, await settledPageSkeleton(page));
    }

    // Positive control on the fingerprint's DISCRIMINATION: if it collapsed every page to the same
    // string, each equality below would pass vacuously. The three must read differently.
    expect(new Set(before.values()).size,
      "positive control: the fingerprint cannot tell the three parameterized pages apart").toBe(3);

    // ── Phase 2: the ATLAS shell, at the SAME URLs. ──
    // Report what the classic walk logged before discarding it, so a classic-shell error stays
    // visible in the output rather than being silently swallowed by the reset.
    const classicNoise = [...consoleErrors.errors];
    consoleErrors.reset();

    await seedAtlasOn(page);

    // The Inbox node's own label, read off the tree rather than typed here: the /question crumb must
    // name the SAME destination nav.tsx names, and a literal "Inbox" in this file would keep passing
    // after a rename while the crumb and the tree silently disagreed.
    //
    // Read from one of the three addresses, NOT from "/". The tree renders on every Atlas route, so
    // any of them serves — and routing through "/" instead would mount MissionControl, which polls a
    // route neither the classic walk below nor this ATLAS phase would otherwise visit, so a contrast
    // case built on it would be comparing unequal walks rather than attributing anything to Atlas.
    // Both walks visit exactly the same three URLs, which is what makes the comparison mean anything.
    await page.goto(loomDaemon.baseURL + reviewUrl);
    await expect(page.getByTestId("atlas-tree")).toBeVisible();
    // Card 0d0c6cee re-homed /inbox out of the tree's rows; card 41eab0eb then made it the Workspace
    // node's `inbox` TAB, which is where its name lives now. Read off that tab rather than typed
    // here, for the same reason the hatch entry was read before it: the /question crumb must name the
    // SAME destination nav.tsx names, and a literal "Inbox" in this file would keep passing after a
    // rename while the crumb and the frame silently disagreed.
    //
    // Read on the Workspace node — the tab row is that node's own chrome and exists nowhere else.
    // `textContent` over the anchor's own TEXT NODES: a count rides inside it as a
    // `.loom-atlas-tabcount` span, so a plain textContent read returns "Inbox1".
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();
    const inboxLabel = await page.getByTestId("atlas-tab-inbox").evaluate((el) => Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim());
    expect(inboxLabel, "the Workspace node has no Inbox tab to take the detail crumb's label from").not.toBe("");

    const workerNode = `${worker.agentName} · worker · ${shortId(worker.sessionId)}`;
    const plainNode = `${plain.agentName} · ${shortId(plain.sessionId)}`;
    // The heading always names the deepest NODE, and a trail either ENDS at its node (/session/:id)
    // or runs one crumb BELOW it — a node tab (/review → Diff) or a detail row (/question → the
    // request). So each address declares how many crumbs hang below its node and the heading is
    // DERIVED from the trail, never written out a second time where the two could drift apart.
    // `node` is the tree node this address hangs off, when one exists — named by its destination, so
    // the testid is `atlas-node-<to>`. A DETAIL address sits under a real nav destination, so the
    // tree must mark it as landed — NavLink's own isActive cannot, since /question/:id is not a path
    // under /inbox. `null` is the claim that NOTHING is marked, which is a real assertion: marking
    // the nearest-looking node instead would be a lie the tree told about where you are.
    //
    // `nodeTestId` is the same claim for a node that is not a destination at all. Card 3b563642 hung
    // every LIVE session in the tree, so a SESSION address now has a real node — its own entity row,
    // addressed by session id rather than by path. BOTH session addresses mark the SAME row: a
    // worker's `/review/:workerId` IS that worker node's Diff tab, which is why AtlasShell resolves
    // its `activeNodeTo` to `/session/<workerId>` (NavLink's own isActive cannot see that, exactly as
    // it cannot for a detail row). An EXITED session still has no row — /review/:workerId renders one
    // deliberately — and `null` stays the honest answer there.
    //
    // Card 525c8ad9 (P2-7) moved /session/:id from `belowNode: 0` to 1: the session node has TABS now,
    // and a session address always ends on the active one — which is what makes /review/:workerId's
    // own "Diff" crumb read as that same node's tab rather than as a different kind of address.
    //
    // `hatch` was card 0d0c6cee's CONTRAST CASE for `node: null`: all three addresses claimed
    // "nothing is marked", and three zeros from one locator is a claim no broken instrument could
    // fail, so the DETAIL address — whose destination had moved rather than vanished — had to still
    // carry the hatch's own weaker `is-here` mark. Card 3b563642 made the contrast structural as
    // well: the two session addresses now assert a ONE, from the same locator, in the same walk, so
    // the remaining zero is read off an instrument shown firing rather than off three silences.
    //
    // Card 41eab0eb made /inbox a Workspace node TAB, so there is no hatch entry left to mark. The
    // contrast case is kept, and strengthened, by moving it to the tab: a tab that is NOT selected is
    // just as real a reading as one that is, and /question/:id is deliberately NOT the Inbox tab —
    // it is its own address, below that destination rather than on it. So the claim becomes "the
    // Workspace node's Inbox tab exists and reads unselected here", which a broken locator fails.
    // Asserted on the same page at the same moment, with no extra navigation, which would pollute the
    // console-error contrast at the bottom of this test.
    const expected: Record<string, {
      trail: string[]; belowNode: number; node: string | null; nodeTestId?: string; hatch?: string;
    }> = {
      [reviewUrl]: {
        trail: ["Workspace", mgr.projectName, workerNode, "Diff"], belowNode: 1,
        node: null, nodeTestId: `atlas-session-${worker.sessionId}`,
      },
      // `node: null` since card 0d0c6cee: /inbox is no longer a tree ROW, so there is nothing for
      // the tree to mark. The frame still names the destination (the crumb + heading above come
      // from the same NAV_PAGES row they always did) — only the tree's own highlight is gone, and
      // highlighting a nearby row instead would be a lie about where you are.
      [questionUrl]: { trail: ["Workspace", inboxLabel, questionTitle], belowNode: 1, node: null, hatch: "inbox" },
      [sessionUrl]: {
        trail: ["Workspace", mgr.projectName, plainNode, "Terminal"], belowNode: 1,
        node: null, nodeTestId: `atlas-session-${plain.sessionId}`,
      },
    };
    const expectationFor = (url: string) => {
      const e = expected[url];
      if (!e) throw new Error(`no expectation declared for ${url}`);
      return e;
    };
    const headingOf = (url: string) => {
      const { trail, belowNode } = expectationFor(url);
      return trail[trail.length - 1 - belowNode];
    };

    for (const { url, pattern, content, atlasContent } of addresses) {
      await page.goto(loomDaemon.baseURL + url);

      // A FRESH LOAD of the old URL lands inside the Atlas frame — the classic shell is replaced,
      // not merely hidden, and the catch-all's "nothing here yet" panel is gone for these three.
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(page.locator(".loom-rail")).toHaveCount(0);
      await expect(page.getByTestId("atlas-empty")).toHaveCount(0);

      // The RIGHT node + tab: the crumbs read as the path through the tree, and the heading names
      // the node the trail ends at.
      expect(await crumbTrail(page), `the ${url} address produced the wrong breadcrumb trail`)
        .toEqual(expectationFor(url).trail);
      await expect(nodeHeading(page)).toHaveText(headingOf(url) ?? "");

      // The tree agrees with the crumbs about which node this address belongs to — or marks none.
      // A destination node is named by its path, an ENTITY node (a session row, card 3b563642) by
      // its own testid; either way exactly one element may read as landed, and it must be that one.
      const { node, nodeTestId } = expectationFor(url);
      const markedTestId = nodeTestId ?? (node ? `atlas-node-${node}` : null);
      await expect(page.locator("a.loom-atlas-node.is-active")).toHaveCount(markedTestId ? 1 : 0);
      if (markedTestId) await expect(page.getByTestId(markedTestId)).toHaveClass(/is-active/);
      // The contrast case for that zero — see `hatch` in the declaration above. These three
      // addresses render inside the Atlas frame but NOT on the Workspace node, so its tab row is not
      // on the page at all. The collector has already been shown FIRING on this same build:
      // `atlas-tab-inbox` was read for a non-empty label on /home a few lines above. So these zeros
      // are readings, not the silence of a broken locator.
      //
      // The escape hatch's own `is-here` mark used to be asserted absent here too. Card 5afd71bd
      // DELETED the hatch, so that assertion became vacuous — a zero from a selector that can never
      // match anything — and a vacuous assertion carrying a positive-control justification that is no
      // longer true is worse than no assertion. "The hatch does not exist" is now claimed once,
      // document-wide, by atlas-tree.spec.ts's partition and atlas-retired-destinations.spec.ts.
      // ⛔ NOT asserted on `atlas-node-tabs`: that test id is the SHARED one every `NodeTabs` row
      // wears, and a session address legitimately renders its own (card 525c8ad9). The Workspace
      // node's own tabs are what must be absent, and `atlas-tab-<key>` is what names one.
      const hatch = expectationFor(url).hatch;
      await expect(page.getByTestId("atlas-tab-inbox"),
        `the ${url} address rendered the Workspace node's Inbox tab, which is not its node`).toHaveCount(0);
      if (hatch) {
        await expect(page.getByTestId(`atlas-tab-${hatch}`),
          `the ${url} address rendered the Workspace node's ${hatch} tab, which is not where it lives`)
          .toHaveCount(0);
      }

      const rebuilt = REBUILT_IN_PHASE_2[pattern];
      if (rebuilt) {
        // INVERTED for a rebuilt address: identity would mean the rebuild is not what Atlas renders.
        // The address must still render its own real content (the Atlas marker), and the CLASSIC
        // capture must still be non-empty — so this cannot be satisfied by an address that failed to
        // render under EITHER shell, which is the way an inverted claim usually goes vacuous.
        await expect(atlasContent!(page)).toBeVisible();
        expect(before.get(url), `the ${url} address rendered nothing under the classic shell`).toBeTruthy();
        expect(await settledPageSkeleton(page),
          `the ${url} address still renders the CLASSIC page under Atlas, but ${rebuilt}`)
          .not.toBe(before.get(url));
      } else {
        // The SAME content, structurally and by its own key marker.
        await expect(content(page)).toBeVisible();
        const after = await settledPageSkeleton(page);
        expect(after, `the ${url} address rendered different content under Atlas than the classic route did.\n`
          + `--- classic shell ---\n${before.get(url)}\n--- atlas shell ---\n${after}\n`)
          .toBe(before.get(url));
      }
    }

    await page.waitForLoadState("networkidle");
    await consoleErrors.assertFires();

    // This stays a KIND-only comparison rather than an absolute zero — GET /api/platform/home no
    // longer 404s on this fixture (card 8d82be67), but an absolute zero would still be the wrong
    // instrument here: the classic walk is the contrast case for whatever noise a page may still log,
    // so the claim Atlas is answerable for is "no error KIND the classic walk did not already
    // produce". Counts legitimately differ (each walk fires a different number of polls), so the
    // comparison is over kinds.
    const introduced = [...new Set(consoleErrors.errors)].filter((e) => !new Set(classicNoise).has(e));
    expect(introduced,
      `the Atlas walk introduced ${introduced.length} error kind(s) the classic walk did not.\n`
      + `atlas (${consoleErrors.errors.length}): ${JSON.stringify([...new Set(consoleErrors.errors)])}\n`
      + `classic (${classicNoise.length}): ${JSON.stringify([...new Set(classicNoise)])}`)
      .toEqual([]);

    // The subset check above could be satisfied by a classic walk that already logged everything, so
    // this absolute claim stands beside it: an UNCAUGHT EXCEPTION is never acceptable in either shell.
    expect(consoleErrors.errors.filter((e) => e.startsWith("pageerror:")),
      "the Atlas walk threw an uncaught exception").toEqual([]);
    expect(classicNoise.filter((e) => e.startsWith("pageerror:")),
      "the classic walk threw an uncaught exception, so the contrast case above is not a clean baseline")
      .toEqual([]);
  });

  test("the controls on each Atlas-framed address actually work", async ({ page, loomDaemon }) => {
    // Rendering clean proves the page drew. Each address below is EXERCISED through a real control,
    // with an observable before/after, inside the Atlas frame.
    test.setTimeout(120_000);
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "AtlasParamExerciseMgr" });
    const worker = await loomDaemon.seedLiveSession({
      project: mgr.project, role: "worker", agentName: "AtlasExWorker",
      id: `e2e-atlasexwkr-${Date.now()}`,
      parentSessionId: mgr.sessionId, branch: "loom/atlas-param-exercise",
      task: { title: `atlas-param-ex-${Date.now()}` },
    });
    const plain = await loomDaemon.seedLiveSession({
      project: mgr.project, role: "plain", agentName: "AtlasExPlain", id: `e2e-atlasexplain-${Date.now()}`,
    });
    const questionTitle = `Atlas param exercise ${Date.now()}`;
    const questionId = await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title: questionTitle,
      body: "Pick one so the write path is exercised inside the Atlas frame.",
      options: ["Land it", "Hold it"],
    });

    await serveCannedDiff(page);
    await pinProject(page, mgr.projectId);
    await seedAtlasOn(page);

    // ── /review/:workerId — the Request-changes gate flips on a typed note. Read-only on purpose:
    // the two writes this panel offers (Approve & merge, Request changes) both reach the daemon.
    await page.goto(`${loomDaemon.baseURL}/review/${worker.sessionId}`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    const requestChanges = page.getByRole("button", { name: "Request changes" });
    await expect(requestChanges).toBeDisabled();
    await page.getByPlaceholder(/changes to request/).fill("Split the route table change out.");
    await expect(requestChanges).toBeEnabled();

    // ── /session/:id — Maximize swaps the tile for the full-viewport overlay; Esc restores it.
    await page.goto(`${loomDaemon.baseURL}/session/${plain.sessionId}`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await expect(page.getByTitle("Maximize terminal")).toBeVisible();
    await page.getByTitle("Maximize terminal").click();
    await expect(page.getByTitle("Restore terminal (Esc)")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTitle("Restore terminal (Esc)")).toHaveCount(0);
    await expect(page.getByTitle("Maximize terminal")).toBeVisible();

    // ── /question/:id — a real answer, submitted from inside the Atlas frame, read back from the
    // daemon. This is the one write here, and it is the address's whole purpose.
    await page.goto(`${loomDaemon.baseURL}/question/${questionId}`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    const submit = page.getByRole("button", { name: "Submit answer" });
    await expect(submit).toBeDisabled();
    await page.locator("main").getByText("Land it").click();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.locator("main").getByText("ANSWERED", { exact: true })).toBeVisible();

    // Durable, not just optimistic: a fresh load of the same address reads the recorded choice back.
    await page.goto(`${loomDaemon.baseURL}/question/${questionId}`);
    await expect(page.locator("main").getByText(/Answered/)).toBeVisible();
    await expect(page.locator("main").getByText("Land it")).toBeVisible();
  });

  test("the deepest crumb gives up room last, and never room the row had to spare", async ({ page, loomDaemon }) => {
    // Two halves of one claim, and getting the first wrong is how you break the second: /review's
    // FOUR-segment trail is the first long enough to run the row out of width, and under equal shrink
    // its "Diff" tab crumb — the one naming where you actually are — rendered as "D." at 420px. The
    // obvious fix (pin the last crumb and cap it at a fixed `ch` count) then clipped a request title
    // that fitted fine at desktop width, so both widths are measured here, not just the narrow one.
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "AtlasNarrowMgr" });
    const worker = await loomDaemon.seedLiveSession({
      project: mgr.project, role: "worker", agentName: "AtlasNarrowWorkerWithALongishName",
      id: `e2e-atlasnarrow-${Date.now()}`,
      parentSessionId: mgr.sessionId, branch: "loom/atlas-param-narrow",
    });
    const longTitle = "Which placement should the parameterized addresses take in the tree?";
    const questionId = await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title: longTitle,
      body: "A long-but-ordinary request title — the realistic worst case for the detail crumb.",
    });

    await pinProject(page, mgr.projectId);
    await seedAtlasOn(page);

    // Truncation read off the real rendered boxes, not inferred from the stylesheet: an ellipsising
    // span's scrollWidth exceeds the width it was actually given.
    const clippedCrumbs = () => page.getByTestId("atlas-breadcrumb").locator("li").evaluateAll((lis) =>
      lis.map((li) => {
        const spans = Array.from(li.querySelectorAll("span")).filter((s) => !s.hasAttribute("aria-hidden"));
        const el = spans[spans.length - 1] as HTMLElement | undefined;
        return el ? el.scrollWidth > el.clientWidth : false;
      }),
    );

    // ── Narrow: the ancestors give way, the tab crumb does not. ──
    await page.setViewportSize({ width: 420, height: 880 });
    await page.goto(`${loomDaemon.baseURL}/review/${worker.sessionId}`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    const narrow = await clippedCrumbs();
    expect(narrow.length, "no crumbs to measure").toBe(4);
    // POSITIVE CONTROL: the row must genuinely be under width pressure here, or "the last crumb is
    // not clipped" would pass on a row with room to spare and prove nothing about the priority.
    expect(narrow.slice(0, -1).some(Boolean),
      "positive control: no ancestor crumb was clipped at 420px, so the row was never under pressure")
      .toBe(true);
    expect(narrow.at(-1), "the deepest crumb was clipped before its ancestors were").toBe(false);
    // And it is really the tab, in full — scrollWidth parity alone would also hold for an empty span.
    expect((await crumbTrail(page)).at(-1)).toBe("Diff");

    // ── Wide: a long detail crumb the row HAS the width for is not clipped by the cap itself. ──
    await page.setViewportSize({ width: 1500, height: 950 });
    await page.goto(`${loomDaemon.baseURL}/question/${questionId}`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await expect(page.getByTestId("atlas-breadcrumb")).toContainText(longTitle.slice(0, 20));
    const wide = await clippedCrumbs();
    expect(wide.at(-1),
      `the ${longTitle.length}-char detail crumb was clipped at 1500px, where the row had room for it`)
      .toBe(false);
    expect(wide.some(Boolean), "no crumb should be clipped at all on a row this wide").toBe(false);
  });

  test("the Inbox pop-over still answers in place under Atlas, without pushing to /question/:id", async ({ page, loomDaemon }) => {
    // The other half of the /question/:id parity row (01-parity-checklist.md §A): the deep-link page
    // is the durable URL, but the PRIMARY interaction is the modal opened over whatever page you are
    // on. It is mounted by RequestModalProvider at App.tsx's root — outside both shells — so this
    // asserts the shell swap did not strand it, which nothing else in the Atlas specs would notice.
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "AtlasPopoverMgr" });
    const title = `Atlas pop-over request ${Date.now()}`;
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title,
      body: "Answered from the inbox without leaving it.",
      options: ["Yes", "No"],
    });

    await pinProject(page, mgr.projectId);
    await seedAtlasOn(page);
    // Card 41eab0eb: /inbox is the Workspace node's `inbox` TAB under Atlas, so this address
    // redirects there. The subject of the test is unchanged — the modal is mounted at App.tsx's root,
    // outside both shells, and must still open in place wherever the Inbox surface is showing.
    await page.goto(`${loomDaemon.baseURL}/inbox`);
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await expect(page.getByTestId("atlas-tab-inbox")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("main").getByText(title)).toBeVisible();

    await page.locator("main").getByRole("button", { name: "Answer →" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // In PLACE: the address bar never left the Inbox surface.
    await expect(page).toHaveURL(/\/home\?tab=inbox$/);
    // And it is the Atlas frame the dialog opened over, not a shell that silently swapped back.
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await expect(page.locator(".loom-rail")).toHaveCount(0);
  });
});
