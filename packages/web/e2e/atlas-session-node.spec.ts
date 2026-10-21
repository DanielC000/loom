// The Atlas SESSION NODE — card 525c8ad9 (Atlas build plan P2-7), owner decision "B · Inline"
// (request 36787441). Design record: docs/decisions/525c8ad9-atlas-session-node.md.
//
// The four claims the card makes, and what each is measured against here:
//   1. THE SHAPE IS INLINE, and the tab set is the one the CODE builds — manager Terminal/Transcript/
//      Timeline, worker Terminal/Transcript/Diff, anything else Terminal/Transcript. Asserted as an
//      EXACT list, not a containment: round 2's "5 tabs / 4 tabs" diagram passed every containment
//      check anyone could have written against it. Queue / Wakes / bound task are asserted to be on
//      the page WITH the terminal and NOT in the tab row, which is the whole A-vs-B difference.
//   2. THE IDENTITY IS DE-DUPLICATED, by COUNT. Exactly one <h1> names the session; TileTitle is gone;
//      SessionView's own header row is gone. Each is paired with its CLASSIC leg asserting the
//      opposite, because "it is gone" and "it is gone everywhere" are different claims and the card
//      only wants the first.
//   3. THE DIFF TAB IS THE FULL REVIEW SURFACE, AT ITS OWN ADDRESS. Clicking Diff navigates to
//      /review/:workerId, which still renders the node (tabs + inline strips) with the real
//      ReviewPanel body in the pane — one thing, one address.
//   4. THE 420px DECISION ROW NO LONGER OVERFLOWS, measured soundly (see `overflowingBoxes`).
//
// Draft preservation is asserted directly rather than assumed from the layout: the composer draft must
// survive a tab switch, and the queue editor must still be mounted while the terminal is showing.
//
// Presence-first (card 625d791c): a bare toHaveCount(0) is satisfied by a page that is merely still
// loading, so every absence claim is preceded by something that must BE there.
import { expect, test, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
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
    try { localStorage.setItem(key, id); } catch { /* ditto */ }
  }, [PROJECT_KEY, projectId] as const);
}

/** A canned branch diff, so the review surface renders without a real repo or a real git call. */
async function serveCannedDiff(page: Page) {
  await page.route("**/api/sessions/*/diff", (route) =>
    route.fulfill({
      json: {
        filesChanged: 1, insertions: 2, deletions: 1, merged: false, uncommitted: true,
        patch: [
          "diff --git a/packages/daemon/src/git/batch-merge.ts b/packages/daemon/src/git/batch-merge.ts",
          "--- a/packages/daemon/src/git/batch-merge.ts",
          "+++ b/packages/daemon/src/git/batch-merge.ts",
          "@@ -1,3 +1,4 @@",
          " const head = 1;",
          "-const squash = 2;",
          "+const squash = 3;",
          "+const bounded = 4;",
        ].join("\n"),
      },
    }));
}

const tabRow = (page: Page) => page.getByTestId("atlas-node-tabs");
const nodeHeading = (page: Page) => page.locator(".loom-atlas-nodehead h1");

/**
 * The deepest crumb's LABEL. Every `<li>` past the first also holds an aria-hidden "/" separator span,
 * so `li.textContent` reads "/Terminal" — which silently defeats an exact-match assertion and, worse,
 * makes a NEGATIVE one (`not.toHaveText(/^Terminal$/)`) pass whether or not the tab crumb is there.
 * Same reader atlas-param-routes.spec.ts's own `crumbTrail` uses, for the same reason.
 */
const deepestCrumb = (page: Page) =>
  page.getByTestId("atlas-breadcrumb").locator("li").last().locator("span:not([aria-hidden])").last();

/** A value planted on the live document, so a hop that secretly RELOADED can be told from one that
 *  routed in-app. Every module-level draft store dies on a reload, so without this a draft-survival
 *  test could only ever fail — and a future `page.goto` creeping back in would look like a real bug. */
const SENTINEL = "__loomSessionNodeSpec";

/** Route in-app, without reloading the document — react-router's own history-state shape, then the
 *  popstate it subscribes to. Lifted from composer-draft-per-session.spec.ts, which needs it for the
 *  same reason: the classic shell has no tab row to click. */
async function routeInApp(page: Page, path: string) {
  await page.evaluate((to) => {
    const prev = window.history.state as { idx?: number } | null;
    const idx = typeof prev?.idx === "number" ? prev.idx + 1 : 1;
    const key = Math.random().toString(36).slice(2, 10);
    window.history.pushState({ usr: null, key, idx }, "", to);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, path);
}

/** The tab row's labels, in order, with the trailing count span stripped off each. */
async function tabLabels(page: Page): Promise<string[]> {
  return tabRow(page).getByRole("tab").evaluateAll((els) =>
    els.map((el) => {
      const count = el.querySelector(".loom-atlas-tabcount");
      const text = el.textContent ?? "";
      return (count ? text.replace(count.textContent ?? "", "") : text).trim();
    }));
}

/**
 * Boxes that genuinely overflow HORIZONTALLY, restricted to those whose computed `overflow-x` is
 * `visible`.
 *
 * ⛔ The obvious alternative — walk up and skip anything inside an x-scrollable ancestor — is VACUOUS
 * on this page, and was measured to be: `.loom-atlas-content` is `overflow-y: auto`, and CSS promotes
 * the OTHER axis of a box with a non-visible value to `auto` too, so that walk matches every element
 * in the column and greens unconditionally (4 GREEN / 0 RED against known-bad CSS while the mockups
 * for this card were being built). Filtering on the box's OWN computed `overflow-x` instead excludes a
 * diff hunk's legitimately scrolling `<pre>` by construction, and nothing else.
 */
async function overflowingBoxes(page: Page): Promise<{ sel: string; sw: number; cw: number }[]> {
  return page.evaluate(() => {
    const out: { sel: string; sw: number; cw: number }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("main, main *"))) {
      if (getComputedStyle(el).overflowX !== "visible") continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        out.push({
          sel: `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(/\s+/)[0]}` : ""}`,
          sw: el.scrollWidth, cw: el.clientWidth,
        });
      }
    }
    return out;
  });
}

test.describe("Atlas session node (card 525c8ad9)", () => {
  test("the node's shape is inline, and its tab set is the one the code builds", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    // Each session gets its OWN agentName and id prefix: sharing `agentId` makes the fixture report
    // its default "Seeded Agent" rather than the name rendered, and the default mint makes every row's
    // short id read "e2e-live" (card 1d3192dc's measured trap).
    const mgr = await loomDaemon.seedLiveSession({
      role: "manager", agentName: "NodeMgr", id: `e2e-nodemgr-${Date.now()}`,
      ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "mgr ready\r\n",
    });
    const worker = await loomDaemon.seedLiveSession({
      project: mgr.project, role: "worker", agentName: "NodeWkr", id: `e2e-nodewkr-${Date.now()}`,
      parentSessionId: mgr.sessionId, branch: "loom/atlas-session-node",
      task: { title: `atlas-session-node-task-${Date.now()}`, priority: "p0" },
      wake: { note: "parked on run_gate" },
      ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "wkr ready\r\n",
    });
    const plain = await loomDaemon.seedLiveSession({
      project: mgr.project, role: "plain", agentName: "NodePlain", id: `e2e-nodeplain-${Date.now()}`,
      ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "plain ready\r\n",
    });

    await serveCannedDiff(page);
    await seedAtlasOn(page);
    await pinProject(page, mgr.projectId);

    // ── 1a. The EXACT tab set per role. ────────────────────────────────────────────────────────────
    for (const [session, expected] of [
      [mgr, ["Terminal", "Transcript", "Timeline"]],
      [worker, ["Terminal", "Transcript", "Diff"]],
      [plain, ["Terminal", "Transcript"]],
    ] as const) {
      await page.goto(`${loomDaemon.baseURL}/session/${session.sessionId}`);
      await expect(page.getByTestId("session-node")).toBeVisible();
      expect(await tabLabels(page),
        `the ${session.role ?? "plain"} node's tab set is not the one TerminalCard's tabDefs builds`)
        .toEqual([...expected]);
    }

    // POSITIVE CONTROL on the tab reader: it must be able to report a DIFFERENT list, here and now.
    // Without this, a selector that silently matched nothing would make all three equalities above
    // pass as `[] === []`… which they would not, but a reader returning a CONSTANT would.
    await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);
    await expect(page.getByTestId("session-node")).toBeVisible();
    const before = await tabLabels(page);
    await tabRow(page).getByRole("tab").first().evaluate((el) => el.remove());
    expect(await tabLabels(page), "positive control: removing a tab did not change what tabLabels() reads")
      .not.toEqual(before);

    // ── 1b. INLINE, not tabs: queue, wakes and the bound task are on the page WITH the terminal. ───
    // This is the entire A-vs-B difference, so it is asserted on the Terminal tab, where Option A
    // would have put a tab in each of their places instead.
    await page.goto(`${loomDaemon.baseURL}/session/${worker.sessionId}`);
    await expect(page.getByTestId("session-node-pane-terminal")).toBeVisible();
    await expect(page.getByTestId("session-node-task")).toBeVisible();
    await expect(page.getByTestId("session-node-composer")).toBeVisible();
    await expect(page.locator("main").getByText("parked on run_gate")).toBeVisible();
    // …and NONE of them is a tab. Scoped to the tab row, because every one of those words also
    // appears in the strips themselves.
    expect(await tabLabels(page)).toEqual(["Terminal", "Transcript", "Diff"]);

    // ── 1c. Self-hiding is real: the manager has no bound task, so the strip is absent entirely
    //        rather than rendering an empty row. (The fixture binds a task only to the worker.) ────
    await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);
    await expect(page.getByTestId("session-node-composer")).toBeVisible();
    await expect(page.getByTestId("session-node-task")).toHaveCount(0);
  });

  test("the session is named ONCE in the body, and the classic page is untouched", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const worker = await loomDaemon.seedLiveSession({
      role: "worker", agentName: "DedupWkr", id: `e2e-dedup-${Date.now()}`,
      branch: "loom/atlas-session-dedup",
      ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "ready\r\n",
    });
    const label = `${worker.agentName} · worker · ${worker.sessionId.slice(0, 8)}`;
    const url = `${loomDaemon.baseURL}/session/${worker.sessionId}`;

    // ── CLASSIC FIRST, so the Atlas absences below are known to be absences of something that EXISTS.
    // A zero read against a page that never had the thing is not evidence of de-duplication.
    await pinProject(page, worker.projectId);
    await page.goto(url);
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.getByTestId("session-view-header")).toBeVisible();
    await expect(page.getByTestId("tile-identity")).toHaveCount(1);
    await expect(page.locator(".loom-atlas-nodehead h1")).toHaveCount(0);

    // ── ATLAS: the same URL, the same session. ────────────────────────────────────────────────────
    await seedAtlasOn(page);
    await page.goto(url);
    await expect(page.getByTestId("session-node")).toBeVisible();

    // Exactly ONE <h1> on the page, and it is the one naming this session.
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(nodeHeading(page)).toHaveText(label);
    // The crumb trail still names it too — that is the ADDRESS, and the card keeps it deliberately.
    // Its last crumb is the active tab, which is what makes /review/:id's "Diff" crumb consistent.
    await expect(page.getByTestId("atlas-breadcrumb")).toContainText(label);
    await expect(deepestCrumb(page)).toHaveText("Terminal");

    // The two copies this card removes, by COUNT.
    await expect(page.getByTestId("session-view-header")).toHaveCount(0);
    await expect(page.getByTestId("tile-identity")).toHaveCount(0);

    // The <h1> absorbed the state and the lifecycle controls — that is WHY the other two could go.
    const head = page.locator(".loom-atlas-nodehead");
    await expect(head.getByTestId("session-node-state")).toBeVisible();
    await expect(head.getByRole("button", { name: "Fork" })).toBeVisible();
    await expect(head.getByRole("button", { name: "Stop" })).toBeVisible();

    // ── An EXITED session is where SessionView's own header() row is ACTUALLY the thing suppressed.
    // On the live path above, the Atlas branch replaces the page body wholesale, so a header row left
    // un-suppressed would still never render and the count-0 above would pass either way — measured,
    // by restoring the row and watching this spec stay green. This leg is what makes that claim
    // falsifiable, because the ended-session panel is rendered by SessionView itself under BOTH shells.
    const ended = await loomDaemon.seedLiveSession({
      project: worker.project, role: "worker", agentName: "DedupEnded",
      id: `e2e-dedupended-${Date.now()}`, processState: "exited",
    });
    const endedUrl = `${loomDaemon.baseURL}/session/${ended.sessionId}`;
    await page.goto(endedUrl);
    await expect(page.locator("main").getByText("View transcript in Archive →")).toBeVisible();
    await expect(page.getByTestId("session-view-header")).toHaveCount(0);
    // …and the trail does NOT name a tab here, because no tab row renders under it: SessionView's
    // live-or-starting gate shows the ended-session panel instead. A crumb naming "Terminal" over a
    // page with no Terminal tab is the trail claiming a control that is not on the screen.
    await expect(deepestCrumb(page),
      "the trail named a tab for an ended session, which renders no tab row")
      .not.toHaveText(/^(Terminal|Transcript|Timeline|Diff)$/);
    // The live leg is the control that keeps the one above honest — a selector that matched nothing
    // would satisfy it either way.
    await page.goto(url);
    await expect(page.getByTestId("session-node")).toBeVisible();
    await expect(deepestCrumb(page)).toHaveText("Terminal");

    // ── BACK TO CLASSIC, in the same test: the removal is scoped to the Atlas shell, and a reader of
    // this file can see both legs asserted against one seeded session rather than two.
    await page.addInitScript((key) => {
      try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
    }, ATLAS_KEY);
    await page.goto(endedUrl);
    await expect(page.locator("main").getByText("View transcript in Archive →")).toBeVisible();
    await expect(page.getByTestId("session-view-header")).toBeVisible();

    await page.goto(url);
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(page.getByTestId("session-view-header")).toBeVisible();
    await expect(page.getByTestId("tile-identity")).toHaveCount(1);
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);
  });

  test("the worker node's Diff tab IS /review/:workerId, and it is the full review surface", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const worker = await loomDaemon.seedLiveSession({
      role: "worker", agentName: "DiffWkr", id: `e2e-diffwkr-${Date.now()}`,
      branch: "loom/atlas-session-diff",
      ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "ready\r\n",
    });
    await serveCannedDiff(page);
    await pinProject(page, worker.projectId);

    // CLASSIC leg first: /review/:id is the standalone page it has always been, header row and all.
    await page.goto(`${loomDaemon.baseURL}/review/${worker.sessionId}`);
    await expect(page.locator("main").getByText(`worker w:${worker.sessionId.slice(0, 8)}`)).toBeVisible();
    await expect(page.getByTestId("session-node")).toHaveCount(0);

    await seedAtlasOn(page);
    await page.goto(`${loomDaemon.baseURL}/session/${worker.sessionId}`);
    await expect(page.getByTestId("session-node-pane-terminal")).toBeVisible();

    // EXERCISE the tab: it is a real link, and it is a link to the review ADDRESS.
    await tabRow(page).getByRole("tab", { name: /^Diff/ }).click();
    await expect(page).toHaveURL(new RegExp(`/review/${worker.sessionId}$`));

    // Still the node — the tab row and the inline strips came with it, which is what makes the Diff
    // tab a TAB rather than a separate page wearing the node's crumb trail.
    await expect(page.getByTestId("session-node")).toBeVisible();
    expect(await tabLabels(page)).toEqual(["Terminal", "Transcript", "Diff"]);
    await expect(page.getByTestId("session-node-composer")).toBeVisible();
    await expect(deepestCrumb(page)).toHaveText("Diff");

    // And the pane is the FULL review surface — the summary, the risk roll-up and the decision row —
    // not the thin diff panel the Overview cockpit still uses.
    const pane = page.getByTestId("session-node-pane-diff");
    await expect(pane.getByText("Summary", { exact: true })).toBeVisible();
    await expect(pane.getByRole("button", { name: "Approve & merge" })).toBeVisible();
    await expect(pane.getByRole("button", { name: "Request changes" })).toBeVisible();
    // …minus its own identity header, which the crumb and the node head already carry.
    await expect(page.locator("main").getByText(`worker w:${worker.sessionId.slice(0, 8)}`)).toHaveCount(0);

    // The terminal pane really did go — one live pty per node, as the classic cockpit also guarantees.
    await expect(page.getByTestId("session-node-pane-terminal")).toHaveCount(0);

    // Back to Terminal by the tab, so the pair is a round trip rather than a one-way claim.
    await tabRow(page).getByRole("tab", { name: "Terminal" }).click();
    await expect(page).toHaveURL(new RegExp(`/session/${worker.sessionId}$`));
    await expect(page.getByTestId("session-node-pane-terminal")).toBeVisible();
  });

  test("a SAME-ROUTE tab switch keeps the composer draft", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const mgr = await loomDaemon.seedLiveSession({
      role: "manager", agentName: "DraftMgr", id: `e2e-draftmgr-${Date.now()}`,
      ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "ready\r\n",
    });
    await seedAtlasOn(page);
    await pinProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);
    await expect(page.getByTestId("session-node-composer")).toBeVisible();

    const draft = `half-written turn ${Date.now()}`;
    const composer = page.getByTestId("session-node-composer").getByRole("textbox").first();
    await composer.fill(draft);
    await expect(composer).toHaveValue(draft);

    // Terminal⇄Transcript is a SAME-ROUTE switch (`?tab=`), so the node itself never unmounts. That is
    // the weaker of the two cases and it is named as such: the ROUTE-CHANGING hop (Terminal→Diff,
    // which really does unmount the node) is the next test, and it is the one that found a defect.
    await tabRow(page).getByRole("tab", { name: "Transcript" }).click();
    await expect(page.getByTestId("session-node-pane-transcript")).toBeVisible();
    await expect(page.getByTestId("session-node-composer").getByRole("textbox").first()).toHaveValue(draft);

    await tabRow(page).getByRole("tab", { name: "Terminal" }).click();
    await expect(page.getByTestId("session-node-pane-terminal")).toBeVisible();
    await expect(page.getByTestId("session-node-composer").getByRole("textbox").first()).toHaveValue(draft);

    // Clear it, so the shared worker daemon's next spec does not inherit a seeded draft.
    await page.getByTestId("session-node-composer").getByRole("textbox").first().fill("");
  });

  // ── The hop that UNMOUNTS the node, in BOTH shells ────────────────────────────────────────────────
  // Under Atlas the Diff tab is a ROUTE (/review/:workerId), so Terminal→Diff→Terminal tears the whole
  // node down and builds it again; under the classic shell the same round trip between /session/:id and
  // /review/:id does the same to the tile. Either way, two drafts have to come back: the composer's
  // (store-backed since card 14c68c62) and the queue editor's (store-backed by this card's review round
  // 2 — before it, plain useState with no backing store, so this hop destroyed it).
  for (const shell of [{ name: "atlas", atlas: true }, { name: "classic", atlas: false }]) {
    test(`a route-changing hop keeps the composer AND the open queue editor (${shell.name})`, async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const worker = await loomDaemon.seedLiveSession({
        role: "worker", agentName: `HopWkr${shell.name}`, id: `e2e-hop${shell.name}-${Date.now()}`,
        branch: `loom/atlas-session-hop-${shell.name}`,
        ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "ready\r\n",
      });
      // TWO entries, deliberately. The FIRST is DELIVERED straight to an idle session's pty (arming it
      // busy) and so never appears in the queue at all; only the second is HELD. A single enqueue
      // leaves `pending` empty and the ledger bar — which self-hides when empty — never renders.
      // A HUMAN-authored entry is also the only kind the editor will open (agent entries are read-only
      // and Loom nudges are reorder/remove-only), so the species matters as much as the count.
      await loomDaemon.enqueueMessage({ sessionId: worker.sessionId, text: "first turn (delivers)", source: "human", kind: "agent" });
      const held = await loomDaemon.enqueueMessage({ sessionId: worker.sessionId, text: "original queued turn", source: "human", kind: "agent" });
      expect(held.delivered,
        "fixture precondition: the second enqueue was DELIVERED rather than held, so there is no queued"
        + " entry to edit and everything below would be asserting an empty drawer").toBe(false);

      await serveCannedDiff(page);
      await pinProject(page, worker.projectId);
      if (shell.atlas) await seedAtlasOn(page);

      const sessionUrl = `${loomDaemon.baseURL}/session/${worker.sessionId}`;
      const reviewUrl = `${loomDaemon.baseURL}/review/${worker.sessionId}`;
      const queueInput = () => page.getByTestId("queue-editor-input");
      const composerBox = () => (shell.atlas
        ? page.getByTestId("session-node-composer").getByRole("textbox").first()
        : page.locator("main").getByPlaceholder(/Send a turn to this session/));

      await page.goto(sessionUrl);
      await page.evaluate((k) => { (window as unknown as Record<string, unknown>)[k] = "alive"; }, SENTINEL);
      // Open the ledger drawer, then the editor on the seeded row.
      await page.getByTestId("queue-ledger-bar").click();
      await expect(page.getByTestId("queue-drawer")).toBeVisible();
      await page.getByTitle("Edit this queued message").click();
      await expect(queueInput()).toBeVisible();

      const queueDraft = `half-edited queue text ${Date.now()}`;
      const composerDraft = `half-written composer text ${Date.now()}`;
      await queueInput().fill(queueDraft);
      await composerBox().fill(composerDraft);
      await expect(queueInput()).toHaveValue(queueDraft);

      // AWAY and BACK, to the SAME URL in both shells. The MECHANISM differs because the shells do:
      // under Atlas the Diff tab is a real control the user clicks, under classic there is no tab row,
      // so the hop is driven through history the way an in-app deep-link does
      // (composer-draft-per-session.spec.ts's own helper, same shape).
      //
      // ⛔ NOT `page.goto` — that reloads the document, which wipes every module-level draft store and
      // would turn this into a test that can only ever fail. The sentinel below is what keeps that
      // mistake from coming back silently: it is set on the live document and must still be there.
      if (shell.atlas) {
        await tabRow(page).getByRole("tab", { name: /^Diff/ }).click();
      } else {
        await routeInApp(page, `/review/${worker.sessionId}`);
      }
      await expect(page.locator("main").getByRole("button", { name: "Approve & merge" })).toBeVisible();
      if (shell.atlas) {
        await tabRow(page).getByRole("tab", { name: "Terminal" }).click();
      } else {
        await routeInApp(page, `/session/${worker.sessionId}`);
      }
      await expect(page).toHaveURL(sessionUrl);
      const alive = await page.evaluate((k) => (window as unknown as Record<string, unknown>)[k], SENTINEL);
      expect(alive, "the hop reloaded the document, so this test is not exercising an unmount at all")
        .toBe("alive");

      await expect(composerBox(), "the composer draft did not survive the hop").toHaveValue(composerDraft);
      // The editor must come BACK OPEN on the same row, not merely hold the text somewhere unreachable:
      // a restored draft behind a collapsed drawer reads to a user as destroyed.
      await expect(queueInput(), "the queue editor did not reopen with its draft after the hop")
        .toHaveValue(queueDraft);

      // Cancel IS a decision to discard, unlike the hop — so it clears, and the next open reseeds from
      // the entry's real text. This is the other half of the contract and it keeps the store from
      // becoming a thing that can never be emptied.
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByTitle("Edit this queued message").click();
      await expect(queueInput(), "Cancel did not discard the draft").toHaveValue("original queued turn");
      await page.getByRole("button", { name: "Cancel" }).click();
      await composerBox().fill("");
    });
  }

  // ── The merge that ends the session it is about ───────────────────────────────────────────────────
  // A successful merge hard-stops the worker; the exit archives it; `listAllSessions` drops archived
  // rows; the mutation's own onSuccess invalidates ["allSessions"]. So the row the review page was
  // reading DISAPPEARS one refetch after the merge lands — which used to flip this page from the node
  // to a bare ReviewSurface, remounting it and discarding the banner it had just rendered.
  test("a successful merge keeps its result banner and a typed note, after the worker row disappears", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const worker = await loomDaemon.seedLiveSession({
      role: "worker", agentName: "MergeWkr", id: `e2e-mergewkr-${Date.now()}`,
      branch: "loom/atlas-session-merge",
      ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "ready\r\n",
    });
    await serveCannedDiff(page);
    await seedAtlasOn(page);
    await pinProject(page, worker.projectId);

    // Mirror the daemon's own sequence rather than performing it: the merge SUCCEEDS, and from that
    // moment the sessions feed no longer lists this worker. Stubbing the feed is what makes the
    // disappearance deterministic — the real archive-on-exit is the daemon's job, not this claim's.
    let merged = false;
    let servedWithoutWorker = false;
    let workerRow: Record<string, unknown> | undefined;
    await page.route("**/api/sessions", async (route) => {
      const res = await route.fetch();
      const rows = (await res.json()) as Record<string, unknown>[];
      // Keep the REAL row the daemon served, so the archived stub below can hand back that same
      // session rather than a hand-built one that might agree with no field the UI actually reads.
      workerRow ??= rows.find((r) => r.id === worker.sessionId);
      if (merged) servedWithoutWorker = true;
      await route.fulfill({ json: merged ? rows.filter((r) => r.id !== worker.sessionId) : rows });
    });
    // The other half of the daemon's own sequence: a session is ARCHIVED on exit, so once the merge has
    // landed the by-id archived lookup is what resolves this worker — and resolves it as `exited`,
    // which is the fact the node head has to start reporting.
    await page.route(`**/api/archived-sessions/${worker.sessionId}`, (route) =>
      merged && workerRow
        ? route.fulfill({ json: { ...workerRow, processState: "exited", busy: false } })
        : route.fulfill({ status: 404, json: { error: "not archived" } }));
    await page.route("**/api/sessions/*/merge", (route) => {
      merged = true;
      return route.fulfill({ json: { merged: true } });
    });

    await page.goto(`${loomDaemon.baseURL}/review/${worker.sessionId}`);
    const pane = page.getByTestId("session-node-pane-diff");
    const head = page.locator(".loom-atlas-nodehead");
    await expect(pane.getByRole("button", { name: "Approve & merge" })).toBeVisible();

    // POSITIVE CONTROL on the stub: the worker IS in the feed right now, so its disappearance below is
    // a real change of state and not a row that was never there.
    await expect(page.getByTestId("atlas-breadcrumb")).toContainText(worker.sessionId.slice(0, 8));
    // POSITIVE CONTROL on the write controls: they are PRESENT while the worker is live, so their
    // absence after the merge is a state change rather than a selector that never matched.
    await expect(head.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(head.getByTestId("session-node-state")).toContainText(/idle|busy/);
    await expect(page.getByTestId("session-node-composer")).toBeVisible();

    const note = `note still being typed ${Date.now()}`;
    await pane.locator(".rv-changes textarea").fill(note);

    await pane.getByRole("button", { name: "Approve & merge" }).click();
    await expect(pane.getByText("✓ merged to main")).toBeVisible();

    // 🔴 WAIT FOR THE DISAPPEARANCE TO ACTUALLY HAPPEN before asserting anything survived it. The
    // invalidation is asynchronous, so an immediate read would pass while the feed still contained the
    // worker — i.e. it would assert nothing at all. `servedWithoutWorker` flips inside the route
    // handler, so this is a measurement of the real refetch, not a sleep.
    await expect
      .poll(() => servedWithoutWorker, {
        message: "the sessions feed never served a list WITHOUT the merged worker, so nothing below is"
          + " actually testing survival of that event",
        timeout: 30_000,
      })
      .toBe(true);
    await expect(pane.getByText("✓ merged to main"),
      "the merge result banner was lost when the worker row left the sessions feed").toBeVisible();
    await expect(pane.locator(".rv-changes textarea"),
      "the typed note was lost when the worker row left the sessions feed").toHaveValue(note);
    // …and the node chrome is still a node, not a fallback: the tab row survived the row's removal.
    expect(await tabLabels(page)).toEqual(["Terminal", "Transcript", "Diff"]);
    // The LATCH, which is a separate lever from the stable mount above and needs its own witness: the
    // frame derives its heading from the same vanished row, so without it the node the reader is still
    // looking at renames itself to a bare "Session e2e-merg" mid-review.
    await expect(nodeHeading(page), "the node head fell back to a bare id once the worker row left the feed")
      .toHaveText(`${worker.agentName} · worker · ${worker.sessionId.slice(0, 8)}`);

    // 🔴 AND THE NODE MUST NOW READ AS ENDED. Surviving the row's removal is only half of it — the
    // round-2 fix kept the node drawn from the LATCHED copy, which still carried the `processState`
    // and `busy` it had when it was last live, so the head went on offering a Stop, a Fork and a
    // composer for a session the merge had just killed, under a pill that could stick on `busy`
    // forever. The by-id archived lookup resolves the row to what it ACTUALLY is now.
    await expect(head.getByTestId("session-node-state"),
      "the node head still reports a live busy/idle state for a worker the merge ended")
      .toHaveText(/exited|none/);
    await expect(head.getByRole("button", { name: "Stop" }),
      "Stop is still offered for an ended worker — pressing it can only fail").toHaveCount(0);
    await expect(head.getByRole("button", { name: "Fork" }),
      "Fork is still offered for an ended worker").toHaveCount(0);
    await expect(page.getByTestId("session-node-composer"),
      "the turn composer is still mounted under an ended worker — sending can only fail").toHaveCount(0);

    // …while the REVIEW itself stays fully usable, which is the whole point of rendering the node for
    // an ended worker in the first place.
    await expect(pane.getByRole("button", { name: "Request changes" })).toBeVisible();
    await expect(pane.locator(".rv-changes textarea")).toHaveValue(note);
  });

  test("the review decision row fits a 420px column, and the measure can say otherwise", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const worker = await loomDaemon.seedLiveSession({
      role: "worker", agentName: "NarrowWkr", id: `e2e-narrowwkr-${Date.now()}`,
      branch: "loom/atlas-session-narrow",
      ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "ready\r\n",
    });
    await serveCannedDiff(page);
    await seedAtlasOn(page);
    await pinProject(page, worker.projectId);

    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto(`${loomDaemon.baseURL}/review/${worker.sessionId}`);
    const pane = page.getByTestId("session-node-pane-diff");
    await expect(pane.getByRole("button", { name: "Request changes" })).toBeVisible();

    // POSITIVE CONTROL, on this page at this width: put the pre-fix rule back (a fixed 320px textarea
    // in a non-wrapping cluster) and require the measure to go RED. A zero from an instrument never
    // shown to fire is not a result — and this particular instrument has a known vacuous twin (see
    // overflowingBoxes), which is exactly why the control is here rather than assumed.
    await pane.locator(".rv-changes").evaluate((el) => {
      const span = el as HTMLElement;
      span.style.flexWrap = "nowrap";
      span.style.flex = "0 0 auto";
      (span.querySelector("textarea") as HTMLElement).style.flex = "0 0 320px";
      (span.querySelector("textarea") as HTMLElement).style.maxWidth = "none";
    });
    const red = await overflowingBoxes(page);
    expect(red.length,
      "positive control: the pre-fix fixed-width decision row did NOT overflow a 420px column, so the "
      + "green below measures nothing").toBeGreaterThan(0);

    // …and with the shipped CSS restored (a reload is the cheapest restore, and proves the green is a
    // property of the stylesheet rather than of the undo).
    await page.reload();
    await expect(pane.getByRole("button", { name: "Request changes" })).toBeVisible();
    const green = await overflowingBoxes(page);
    const fromDecisionRow = green.filter((b) => b.sel.startsWith("span.rv-changes") || b.sel.startsWith("div.rv-decide"));
    expect(fromDecisionRow,
      `the review decision row still overflows a 420px column: ${JSON.stringify(green)}`).toEqual([]);

    // The button is also genuinely ON SCREEN, which is the user-visible half of the same claim and the
    // one a box measurement alone cannot make.
    const box = (await pane.getByRole("button", { name: "Request changes" }).boundingBox())!;
    expect(box.x + box.width, "the Request-changes button's right edge is off a 420px viewport")
      .toBeLessThanOrEqual(420);
  });
});
