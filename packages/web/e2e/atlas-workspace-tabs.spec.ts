// The cross-project surfaces as WORKSPACE NODE TABS (card 41eab0eb, Atlas restructure 2 of 11, epic
// 9fe8cd4e). Design record: docs/decisions/41eab0eb-atlas-workspace-node-tabs.md.
//
// The approved round-4 V2 design makes every cross-project surface a TAB on the Workspace node under
// one persistent readout (`atlas.js`'s own `ROOT_TABS`), never a tree row. This card moves seven of
// them — Inbox, Gates, Automation, Actors, Usage, Companion and the workspace Settings node — onto
// `?tab=` on `/home`, each one's EXISTING component mounted verbatim as the tab body.
//
// Four claims, each measured against the running app rather than a list typed into this file:
//   1. THE WHOLE DECLARED TAB SET, WITH THEIR COUNTS. The re-homed tab KEYS are parsed out of the
//      real `WORKSPACE_NODE_TABS` declaration in src/nav.tsx, and each one's LABEL must equal the
//      label the CLASSIC rail gives that address — so the two surfaces are shown to name one thing
//      rather than a literal being typed here that could keep passing after a rename. Counts are
//      asserted on the three the mockup gives one, against seeded data.
//   2. EACH TAB IS A REAL ADDRESS. Every key survives a reload at its own URL, which is the whole
//      difference between a tab and a piece of component state.
//   3. A VISITED PANEL IS NEVER UNMOUNTED, AND AN UNVISITED ONE IS NEVER MOUNTED. Both halves are
//      exercised with real unfinished input: a draft typed into one tab survives a round trip through
//      another, and a tab nobody has opened has no panel in the DOM at all.
//   4. THE HOST AND ITS GUEST DO NOT COLLIDE ON `?tab=`. Three of the seven own a `?tab=` of their
//      own; under the host they must write a different key, and the node must stay on its own tab.
// Plus the switch-OFF half: `/inbox` still renders the standalone classic page and the classic rail is
// unchanged — asserted from the rail's own rendered rows, not from a list here.
//
// Every absence claim carries a POSITIVE CONTROL on the same collector at the same moment: an empty or
// mis-typed locator returns zero exactly like a true absence does.
//
// FIXTURE IDENTITY is asserted, not assumed: this daemon is shared across the specs in its worker, so
// the Inbox count is checked against a Request THIS spec seeded and names, never against whatever
// number the queue happens to hold.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_SUB_TAB, expect, test, type Page } from "./fixtures/daemon";
import { openNodeTab } from "./helpers/nodeTabs";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json), so a spec
// cannot pull a `src/` module in — the same reason fixtures/daemon.ts hardcodes its own keys.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAV_SOURCE = path.resolve(__dirname, "..", "src", "nav.tsx");

/** The node's own two tabs, which precede the re-homed ones — pages/WorkspaceHome.tsx's `HOME_TABS`. */
const HOME_TAB_KEYS = ["overview", "deck"];
/** The node's own TRAILING tab, which follows them — that file's `REPLAY_TAB` (card ff6123de). Kept a
 *  separate list because the position is the claim: the node's two readings lead, the re-homed seven
 *  hold the middle in the mockup's `ROOT_TABS` order, and the forensic tab trails them all. */
const TRAILING_TAB_KEYS = ["replay"];

/** The rail renders one anchor per NAV_PAGES entry; Settings sits in its footer as a `statrow`. */
const RAIL_LINKS = "a.loom-rail-item, a.loom-rail-statrow";

// ── The declaration under test ─────────────────────────────────────────────────────────────────
type NodeTab = { key: string; from: string };

// Parsed from the real source, with the filtered row count checked against the declaration's own raw
// marker count — same idiom (and same reason) as atlas-tree.spec.ts's `parseAtlasHomes`. A regex that
// quietly stopped matching a row would otherwise hand back a plausible SUBSET, and a subset reads
// exactly like a complete list.
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

/** Parsed once per test file, with its own controls run inside each test that uses it. */
function tabsUnderTest(): NodeTab[] {
  const { rows, rawMarkers, block } = parseWorkspaceNodeTabs();
  expect(rows.length, `the WORKSPACE_NODE_TABS parse found no rows. Block:\n${block}`).toBeGreaterThan(0);
  expect(rows.length,
    `the parse returned ${rows.length} row(s) but the declaration contains ${rawMarkers} entries`
    + ` — the pattern is dropping rows. Block:\n${block}`).toBe(rawMarkers);
  // POSITIVE CONTROL that the pattern resolves a row this spec can name independently, so it is shown
  // to WORK and not merely to return the right COUNT of something.
  expect(rows, "positive control: the parse did not resolve the Inbox row the declaration is known to carry")
    .toContainEqual({ key: "inbox", from: "/inbox" });
  return rows;
}

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

/** The node's own address for a tab — Overview is canonical and carries no query. */
const hrefFor = (key: string) => (key === "overview" ? "/home" : `/home?tab=${key}`);

/** The tab row's keys, in rendered order, read off the `atlas-tab-<key>` test ids. */
async function renderedTabKeys(page: Page): Promise<string[]> {
  return page.locator('[data-testid="atlas-node-tabs"] [role="tab"]').evaluateAll((els) =>
    els.map((el) => (el.getAttribute("data-testid") ?? "").replace(/^atlas-tab-/, "")));
}

test.describe("Atlas Workspace node tabs (card 41eab0eb)", () => {
  test("switch ON: the declared tab set with its counts, each one a real address", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const rows = tabsUnderTest();
    const project = await loomDaemon.createProject(`atlas-wstabs-${Date.now()}`);
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "AtlasTabsMgr", project });
    // The Inbox count's own fixture identity: a Request THIS spec created, named, and can see on the
    // tab body — so the count below is a reading of this spec's corpus, not of a sibling's.
    const sentinel = `Atlas workspace-tabs request ${Date.now()}`;
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title: sentinel,
      body: "Seeded so the Inbox tab carries a count this spec can name.", options: ["Yes", "No"],
    });
    await pinProject(page, project.id);

    // ── OFF first: capture what the CLASSIC rail calls each of these addresses. Never typed here —
    //    the claim worth making is that the tab and the rail name ONE destination, and a literal in
    //    this file would keep passing after a rename while the two silently disagreed.
    await page.goto(loomDaemon.baseURL + "/");
    await expect(page.locator(".loom-rail")).toBeVisible();
    const railLabels = new Map(await page.locator(RAIL_LINKS).evaluateAll((els) =>
      els.map((el) => [new URL((el as HTMLAnchorElement).href).pathname,
        (el.querySelector(".loom-rail-lbl") ?? el).textContent?.trim() ?? ""] as [string, string])));
    // Positive control on that collector: an empty or mis-typed selector returns an empty map, which
    // would make every label comparison below vacuous.
    expect(railLabels.size, "the rail label collector found no destinations at all").toBeGreaterThan(5);
    expect(railLabels.get("/inbox"), "the rail label collector read no label for /inbox").toBeTruthy();

    // ── ON: the node's whole tab set. ──
    await seedAtlasOn(page);
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();

    // CLAIM 1a — the keys, in order: the node's own two leading readings, the declared re-homed
    // surfaces in their own order, then the node's own trailing forensic tab.
    expect(await renderedTabKeys(page), "the Workspace node's tab row is not the declared ROOT_TABS set")
      .toEqual([...HOME_TAB_KEYS, ...rows.map((r) => r.key), ...TRAILING_TAB_KEYS]);

    // CLAIM 1b — each re-homed tab's label is the one the classic rail gives its own address. The
    // Atlas-only workspace Settings node has no rail row by design (a second Settings row in the rail
    // would reach a user who never opted in), so it is required to be non-empty instead; what that
    // tab actually RENDERS is atlas-settings-scope.spec.ts's exhaustive claim, not duplicated here.
    for (const row of rows) {
      // The anchor's own text nodes only — a count rides inside it as a `.loom-atlas-tabcount` span,
      // so a bare textContent read returns "Inbox1" and a `text=/.+/` descendant read returns "1".
      const label = await page.getByTestId(`atlas-tab-${row.key}`).evaluate((el) =>
        Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent ?? "").join("").trim());
      const expected = railLabels.get(row.from);
      if (expected) {
        expect(label.toLowerCase(),
          `the ${row.key} tab and the classic rail disagree about what ${row.from} is called`)
          .toBe(expected.toLowerCase());
      } else {
        expect(label, `the Atlas-only ${row.from} tab renders no label`).not.toBe("");
      }
    }

    // CLAIM 1c — the three counts the mockup gives, against seeded data.
    const countOf = (key: string) => page.getByTestId(`atlas-tab-${key}`).locator(".loom-atlas-tabcount");
    // Inbox: at LEAST the one this spec seeded. The e2e daemon is shared, so a sibling spec's pending
    // Request legitimately raises it — an equality here would be a flake, and a floor is the honest
    // claim. The row itself is asserted on the tab body below, which is what pins the identity.
    await expect.poll(async () => Number((await countOf("inbox").innerText()).trim()), {
      message: "the Inbox tab never showed a count covering the Request this spec seeded",
    }).toBeGreaterThanOrEqual(1);
    // Gates: the `running·queued` pair, always rendered — the same format the `gate run·queued` KPI
    // tile uses. A live gate has NO seed path on this fixture (the lane-hero reads the in-memory
    // GateSemaphore registry — see gates.spec.ts's own note), so 0·0 is the only reachable reading and
    // the claim here is about the FORMAT being present and well-formed, not about a nonzero figure.
    await expect(countOf("gates"), "the Gates tab's count is not the running·queued pair")
      .toHaveText(/^\d+·\d+$/);
    // Automation: triggers across both tables. Zero on a fresh daemon, so again a shape claim.
    await expect(countOf("automation"), "the Automation tab carries no count").toHaveText(/^\d+$/);
    // POSITIVE CONTROL on that collector, and on the mockup's own placement: every tab the design gives
    // NO count must carry none. Three readings of a working locator and five of an absence, from the
    // same collector on the same page at the same moment.
    for (const bare of ["actors", "usage", "companion", "settings", "replay"]) {
      await expect(countOf(bare), `the ${bare} tab carries a count the approved design does not give it`)
        .toHaveCount(0);
    }

    // The Inbox tab really is showing this spec's own queue — the fixture identity behind claim 1c.
    await page.goto(loomDaemon.baseURL + hrefFor("inbox"));
    await expect(page.locator("main").getByText(sentinel, { exact: true })).toBeVisible();

    // CLAIM 2 — each tab is a real address: it selects on a fresh load AND survives a reload. A tab
    // that were component state would pass the first and fail the second.
    for (const key of [...HOME_TAB_KEYS, ...rows.map((r) => r.key), ...TRAILING_TAB_KEYS]) {
      await page.goto(loomDaemon.baseURL + hrefFor(key));
      await expect(page.getByTestId(`atlas-tab-${key}`),
        `${hrefFor(key)} did not select the ${key} tab`).toHaveAttribute("aria-selected", "true");
      await expect(page.locator('[data-testid="atlas-node-tabs"] [role="tab"][aria-selected="true"]'),
        `${hrefFor(key)} selected more than one Workspace tab`).toHaveCount(1);
      await page.reload();
      await expect(page.getByTestId(`atlas-tab-${key}`),
        `a reload at ${hrefFor(key)} did not land back on the ${key} tab`)
        .toHaveAttribute("aria-selected", "true");
    }
  });

  test("switch ON: a re-homed address redirects into its tab, carrying its own sub-tab", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const rows = tabsUnderTest();
    const project = await loomDaemon.createProject(`atlas-wstabs-redirect-${Date.now()}`);
    await pinProject(page, project.id);
    await seedAtlasOn(page);

    for (const row of rows) {
      await page.goto(loomDaemon.baseURL + row.from);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      // Not the catch-all, which is where an unmounted address lands.
      await expect(page.getByTestId("atlas-empty"),
        `${row.from} fell through to the Atlas catch-all instead of redirecting into its tab`).toHaveCount(0);
      await expect(page, `${row.from} did not redirect into its Workspace node tab`)
        .toHaveURL(loomDaemon.baseURL + hrefFor(row.key));
      await expect(page.getByTestId(`atlas-tab-${row.key}`)).toHaveAttribute("aria-selected", "true");
      // The address is GONE from the tree, in both halves of card 0d0c6cee's partition — it is a tab
      // now, not a row and not an escape-hatch entry.
      await expect(page.getByTestId(`atlas-node-${row.from}`),
        `${row.from} is still an Atlas tree row`).toHaveCount(0);
    }
    // POSITIVE CONTROL on that absence: the same collector DOES still see a row that deliberately
    // stayed, so the zero above did not come from a broken locator.
    await expect(page.getByTestId("atlas-node-/platform"),
      "positive control: the tree-node collector cannot see the Platform node either").toHaveCount(1);
    // The matching hatch assertion — "a tab is not ALSO an escape-hatch entry" — is gone with card
    // 5afd71bd, which retired the last two destinations the hatch held and DELETED the disclosure. It
    // had its own positive control read off the rendered hatch (deliberately not named, because this
    // control had already expired once when card 25c08fba emptied its named specimen out); with
    // nothing left to render, the control can no longer fire and the assertion it guarded can no
    // longer fail. So the claim moved rather than weakening: "no hatch exists anywhere" is asserted
    // document-wide by atlas-tree.spec.ts's partition and by atlas-retired-destinations.spec.ts,
    // which is strictly stronger than this per-row zero was.

    // An incoming `?tab=` is a real address today — `/skills` redirects to `/actors?tab=skills` — so
    // chaining it into the tab must carry the sub-tab across rather than silently dropping it onto the
    // page's default. Both legs asserted: the host's own tab, and the guest's.
    await page.goto(loomDaemon.baseURL + "/skills");
    await expect(page).toHaveURL(loomDaemon.baseURL + "/home?tab=actors&sub=skills");
    await expect(page.getByTestId("atlas-tab-actors")).toHaveAttribute("aria-selected", "true");
    const guestTab = page.getByTestId("atlas-tabpanel-actors").locator(PAGE_SUB_TAB(true));
    await expect(guestTab, "/skills reached the Actors tab but landed on its default sub-tab")
      .toHaveText(/^skills$/i);
  });

  test("switch ON: a visited panel keeps its unfinished input, and an unvisited one is never mounted",
    async ({ page, loomDaemon }) => {
      test.setTimeout(120_000);
      const project = await loomDaemon.createProject(`atlas-wstabs-draft-${Date.now()}`);
      await pinProject(page, project.id);
      await seedAtlasOn(page);
      await page.goto(loomDaemon.baseURL + "/home");
      await expect(page.getByTestId("atlas-node-tabs")).toBeVisible();

      // NEVER MOUNTED UNTIL VISITED. Landing on Overview must not have started the other six.
      const panels = page.locator('[data-testid^="atlas-tabpanel-"]');
      await expect(panels, "a re-homed panel is mounted on a tab nobody has opened").toHaveCount(0);

      // A real draft, in a real field: the companion name input is unsaved user input, and a tab click
      // is not consent to discard it (the owner's standing rule).
      await openNodeTab(page, "companion");
      await expect(page.getByTestId("atlas-tabpanel-companion")).toBeVisible();
      const draft = `half-typed-${Date.now()}`;
      const nameField = page.getByTestId("atlas-tabpanel-companion").locator("input").first();
      await expect(nameField).toBeVisible();
      await nameField.fill(draft);
      await expect(nameField).toHaveValue(draft);

      // Away to a sibling tab, and back. Through `openNodeTab` because the Companion tab carries a
      // KPI strip, which collapses the row behind it (card d4350286) — Usage is in the More menu by
      // the time we get here, and it asserts the tab reads selected afterwards either way.
      await openNodeTab(page, "usage");
      // STILL MOUNTED, and hidden rather than destroyed — asserted both ways, because "not visible" is
      // equally true of a panel that was unmounted outright.
      await expect(page.getByTestId("atlas-tabpanel-companion"),
        "the Companion panel was unmounted by a tab switch").toHaveCount(1);
      await expect(page.getByTestId("atlas-tabpanel-companion"),
        "the inactive Companion panel is still visible").toBeHidden();
      // `hidden` as the ATTRIBUTE, not an inline display: that is what keeps it out of the
      // accessibility tree and the tab order, and an author `display` would out-specify the UA rule.
      await expect(page.getByTestId("atlas-tabpanel-companion")).toHaveAttribute("hidden", /.*/);
      expect(await page.getByTestId("atlas-tabpanel-companion").evaluate((el) =>
        (el as HTMLElement).style.display), "a panel wrapper carries an inline display").toBe("");

      // Back again, likewise through whichever half now holds it: landing on Usage collapsed the row
      // around ITS own strip, so Companion has in turn moved into the menu.
      await openNodeTab(page, "companion");
      await expect(nameField, "the draft typed into the Companion tab did not survive a tab round trip")
        .toHaveValue(draft);

      // NEGATIVE CONTROL for that claim: a tab the reader never opened still has no panel, so the
      // survival above is not simply "every panel is always mounted".
      await expect(page.getByTestId("atlas-tabpanel-automation"),
        "an unvisited panel is mounted after all, so the survival claim above proves nothing")
        .toHaveCount(0);
    });

  test("switch ON: a guest's own sub-tab never steals the host's ?tab=", async ({ page, loomDaemon }) => {
    // The collision this card's `useTabHost` exists to prevent: Actors, Automation and the Companion
    // node each own a `?tab=` of their own, and a bare `tab` write from inside one would replace the
    // node's own tab value and drop the whole node back to Overview. EXERCISED, not merely rendered.
    test.setTimeout(120_000);
    const project = await loomDaemon.createProject(`atlas-wstabs-subkey-${Date.now()}`);
    await pinProject(page, project.id);
    await seedAtlasOn(page);

    for (const { tab, sub } of [{ tab: "actors", sub: "skills" }, { tab: "automation", sub: "events" }]) {
      await page.goto(loomDaemon.baseURL + hrefFor(tab));
      const panel = page.getByTestId(`atlas-tabpanel-${tab}`);
      await expect(panel).toBeVisible();
      // The guest's OWN control, found by exclusion inside its own panel so no label is named here.
      const others = panel.locator(PAGE_SUB_TAB(false));
      await expect(others, `the ${tab} tab body renders no second sub-tab to exercise`).not.toHaveCount(0);
      await others.first().click();

      // OBSERVABLE: the guest moved…
      await expect.poll(async () =>
        (await panel.locator(PAGE_SUB_TAB(true)).innerText()).trim().toLowerCase(), {
        message: `clicking the ${tab} body's other sub-tab did not move its own selection`,
      }).toBe(sub);
      // …the host did NOT…
      await expect(page.getByTestId(`atlas-tab-${tab}`),
        `the ${tab} body's sub-tab click moved the Workspace node off its own tab`)
        .toHaveAttribute("aria-selected", "true");
      // …and the address says both, on two different keys.
      await expect(page).toHaveURL(new RegExp(`[?&]tab=${tab}(&|$)`));
      await expect(page).toHaveURL(new RegExp(`[?&]sub=${sub}(&|$)`));
    }
  });

  test("switch OFF: every re-homed address still renders its standalone classic page, rail unchanged",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const rows = tabsUnderTest();
      const project = await loomDaemon.createProject(`atlas-wstabs-off-${Date.now()}`);
      await pinProject(page, project.id);

      await page.goto(loomDaemon.baseURL + "/");
      await expect(page.locator(".loom-rail")).toBeVisible();
      const railRoutes = await page.locator(RAIL_LINKS).evaluateAll((els) =>
        els.map((el) => new URL((el as HTMLAnchorElement).href).pathname));
      expect(railRoutes.length, "the rail link collector found no destinations at all").toBeGreaterThan(5);

      for (const row of rows) {
        await page.goto(loomDaemon.baseURL + row.from);
        // NO redirect: the address is still its own page under the shell a user who never opted in sees.
        await expect(page, `${row.from} redirected under the CLASSIC shell`)
          .toHaveURL(loomDaemon.baseURL + row.from);
        // The classic page, in the classic frame. Asserted on the `loom-atlas` class PREFIX so the tab
        // row, the node head, the shell and the tree are all covered by one claim.
        await expect(page.locator(".loom-rail"), `${row.from} lost the classic rail`).toBeVisible();
        await expect(page.locator("[class*='loom-atlas']"),
          `${row.from} mounted an Atlas element with the switch off`).toHaveCount(0);

        // Still a RAIL destination, rendering its own page — except the one address that is Atlas-ONLY
        // by design. That one must be in NEITHER the rail (a user who never opted in would see a
        // second Settings row) NOR the classic route table, which is the long-standing contract
        // atlas-settings-scope.spec.ts states from the other side. So its row INVERTS rather than
        // being skipped: an empty <main> is the correct classic-shell outcome for it, and for it alone.
        if (row.from === "/workspace-settings") {
          expect(railRoutes, "the Atlas-only workspace Settings node leaked into the classic rail")
            .not.toContain(row.from);
          await expect(page.locator("main"),
            `${row.from} is Atlas-only, yet the classic shell rendered something for it`).toBeEmpty();
          continue;
        }
        expect(railRoutes, `the classic rail lost ${row.from}, which only the ATLAS shell re-homes`)
          .toContain(row.from);
        await expect(page.locator("main"), `${row.from} rendered an empty page`).not.toBeEmpty();
      }

      // POSITIVE CONTROL on the `not.toBeEmpty` instrument used above: it must be capable of reporting
      // EMPTY, or the six "rendered its own page" readings prove nothing. The Atlas-only row already
      // exercised that polarity inside the loop, so this asserts the loop actually reached it.
      expect(rows.map((r) => r.from),
        "no Atlas-only address in the set, so the empty-<main> polarity above never ran")
        .toContain("/workspace-settings");
    });
});
