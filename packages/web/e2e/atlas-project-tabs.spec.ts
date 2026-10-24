// The project node's TEN tabs (card 25c08fba, Atlas restructure 3 of 11 — item 3 of the gap audit at
// $LOOM_PROJECT_WORK_DIR/atlas-gap-audit/REPORT.md).
//
// The approved round-4 V2 design puts every project-scoped surface on the project NODE, as a tab under
// its persistent readout, rather than leaving each one a full page of its own (`atlas.js`'s `PROJ_TABS`
// prepended by `homeTabs("proj")`). This spec is the witness for the four claims that are actually
// this card's:
//
//   1. THE TAB SET. All ten tabs render, in the declared order, with the declared labels — read off
//      src/nav.tsx's own PROJECT_NODE_TABS rather than typed here, so a label or an order change
//      cannot pass by drifting the test alongside the code.
//   2. THE COUNTS ARE REAL. Four seeded populations, at four DELIBERATELY DIFFERENT sizes, each read
//      back off its own tab. Distinct sizes are the discriminator: with equal ones, a derivation that
//      read the wrong population — or one shared figure for all four — would pass. The board seeds a
//      terminal-lane card too, so "open cards" and "total cards" differ and the tab must show open.
//   3. EVERY TAB IS A REAL ADDRESS. Each tab is clicked, the URL is required to become the one the
//      declaration names, and a full RELOAD must come back on the same tab with the same body — which
//      is the claim `?tab=`-as-component-state could not make.
//   4. THE BOARD TAB IS THE WHOLE BOARD, AND A CARD OPENS THE CENTRED DIALOG. Both owner rules, on the
//      tab reached THROUGH the tab row. The lane count is CAPTURED from the classic /board page in the
//      same browser rather than stated, so "all lanes" is a measurement; the dialog's two side margins
//      must be EQUAL, which is the discriminating form of "centred, never a drawer" (a bare
//      `role=dialog` check passes against a slide-over).
//
//   5. …plus the owner directive this card had to design around: UNFINISHED INPUT SURVIVES A TAB
//      SWITCH. Asserted with its own contrast case, because "the text is still there" is also what a
//      page that never cleared anything would report — see the test for how the two are told apart.
//
// Switch OFF, every re-homed path still renders its classic page: the rail, no Atlas element of any
// kind, no node tab row, and the page's own heading. Captured as the OFF polarity of each ON claim
// rather than asserted from memory.
//
// What is deliberately NOT re-asserted here, because it is already covered on this exact address and
// would be a second copy to keep in step: the full centred-dialog geometry sweep across all four board
// surfaces (atlas-board-dialog.spec.ts), the multi-select filter behaviour (atlas-board-filters.spec.ts
// exercises it at `/board`), and the node/hatch partition plus per-destination content identity
// (atlas-tree.spec.ts). This spec asserts the filter controls are PRESENT on the tab and leaves their
// behaviour to that spec.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import { nodeTabKeys, openNodeTab } from "./helpers/nodeTabs";
import type { Locator } from "@playwright/test";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json), so a spec
// cannot pull a `src/` module in — the same reason fixtures/daemon.ts hardcodes its own keys.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAV_SOURCE = path.resolve(__dirname, "..", "src", "nav.tsx");

// Wide enough that the board's seven intrinsic lanes and the ten-tab row both lay out without the
// narrow-breakpoint rules taking over — the dialog's margin equality is measured against it.
const VIEWPORT = { width: 1600, height: 1000 };

// ── The four seeded populations ────────────────────────────────────────────────────────────────
// All DIFFERENT, on purpose. See claim 2 in the header: equal sizes make a wrong-population or
// one-figure-for-everything derivation indistinguishable from a correct one.
const OPEN_CARDS = 3;
const DONE_CARDS = 1;     // a terminal lane, so total (4) != open (3)
const MEMORY_NOTES = 5;
const LIVE_SESSIONS = 2;
const AGENTS = 4;

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Writes only while the key is still absent: addInitScript re-runs on every navigation, reload
// included, so an unconditional write would re-pin on a later leg and that leg would be measuring this
// helper instead of the app (measured on P1-4, card e47df20a).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// ── REST seeding (the same human/loopback endpoints the UI drives) ─────────────────────────────
// Inline rather than added to fixtures/daemon.ts, following atlas-agents.spec.ts / profiles-agents.
async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

const seedAgent = (baseURL: string, projectId: string, name: string) =>
  apiJson<{ id: string; name: string }>(`${baseURL}/api/projects/${projectId}/agents`,
    { method: "POST", body: JSON.stringify({ name, startupPrompt: "" }) });

// ── The declaration under test ─────────────────────────────────────────────────────────────────
type DeclaredTab = { key: string; label: string; to: string };

/**
 * PROJECT_NODE_TABS, parsed out of the real source — the same idiom (and the same reason) as
 * atlas-tree.spec.ts's `parseAtlasHomes`: the e2e tsconfig cannot import a `src/` module, and a tab
 * list typed into this file would drift alongside the code it is supposed to police.
 *
 * The filtered row count is checked against the declaration's own raw marker count, because a regex
 * that quietly stopped matching a row would otherwise hand back a plausible SUBSET — and a subset of
 * the tab set reads exactly like a complete one.
 *
 * `to` is normalised first: the declaration builds the two home tabs' addresses from
 * PROJECT_NODE_PATH, so their literals are a bare identifier and a template string rather than a
 * plain quoted path. All three forms are read, and the identifier is resolved from its own
 * declaration — the marker-count control above is what caught this being incomplete.
 */
function parseProjectNodeTabs(): { rows: DeclaredTab[]; rawMarkers: number; block: string } {
  const src = readFileSync(NAV_SOURCE, "utf8");
  const nodePath = /export const PROJECT_NODE_PATH = "([^"]+)"/.exec(src)?.[1];
  if (!nodePath) throw new Error(`no PROJECT_NODE_PATH declaration found in ${NAV_SOURCE}`);
  const start = src.indexOf("export const PROJECT_NODE_TABS");
  if (start < 0) throw new Error(`no PROJECT_NODE_TABS declaration found in ${NAV_SOURCE}`);
  const end = src.indexOf("\n];", start);
  if (end < 0) throw new Error(`PROJECT_NODE_TABS in ${NAV_SOURCE} has no closing "];"`);
  const block = src.slice(start, end);

  const rawMarkers = (block.match(/\bkey:\s*"/g) ?? []).length;
  const rows: DeclaredTab[] = [];
  const row = /\bkey:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*to:\s*(?:"([^"]+)"|`([^`]*)`|(PROJECT_NODE_PATH))/g;
  for (const m of block.matchAll(row)) {
    const raw = m[5] ? "${PROJECT_NODE_PATH}" : (m[3] ?? m[4] ?? "");
    rows.push({ key: m[1]!, label: m[2]!, to: raw.replace("${PROJECT_NODE_PATH}", nodePath) });
  }
  return { rows, rawMarkers, block };
}

/**
 * Every NAV_PAGES `to` — the destinations BOTH shells mount. Parsed with the same marker-count control
 * and for the same reason as the tab list above (the idiom atlas-tree-hierarchy.spec.ts establishes).
 *
 * Needed because the re-homed tabs are not all the same KIND of address. Seven came from NAV_PAGES, so
 * the classic shell still serves each at its own path and the switch-OFF claim applies to it verbatim.
 * `/agents` came from ATLAS_HOMES instead — Atlas-ONLY by construction, deliberately never mounted by
 * the classic shell (see that declaration's own anchor in src/nav.tsx) — so under the switch OFF it
 * renders nothing, which is correct and is asserted as its own, different claim. Derived rather than
 * hand-split: a later card re-homing another Atlas-only node must not have to remember to edit a list
 * here, and a NAV_PAGES destination quietly becoming Atlas-only must not slip through as "empty is
 * fine".
 */
function parseNavPagePaths(): { paths: string[]; rawMarkers: number; block: string } {
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

/** A tab's address without its query — what the router matches. */
const pathOf = (to: string) => to.split("?")[0] ?? to;

const tabRow = (page: Page) => page.getByTestId("atlas-node-tabs");
const tabLink = (page: Page, key: string) => page.getByTestId(`atlas-tab-${key}`);
const tabPanel = (page: Page, key: string) => page.getByTestId(`atlas-tabpanel-${key}`);

/** The muted count beside a tab's label, or null when the tab renders none. */
async function tabCount(page: Page, key: string): Promise<number | null> {
  const count = tabLink(page, key).locator(".loom-atlas-tabcount");
  if ((await count.count()) === 0) return null;
  return Number.parseInt((await count.innerText()).trim(), 10);
}

// A board lane is the `.loom-grid` wrapper inside `.loom-board-grid`, scoped through the grid so the
// Panels around it can never be counted as lanes (the idiom board.spec.ts / atlas-board-dialog use).
const lanesIn = (scope: Locator) => scope.locator(".loom-board-grid > .loom-grid");
// The card's open target — the role=button region the click handler lives on (pages/Board.tsx `Card`).
// Located by it rather than by title text because a child card renders its parent's title as a chip.
const openTargetIn = (scope: Locator, title: string) => scope.locator(".loom-board-open").filter({ hasText: title });

/**
 * One project carrying all four populations at their four distinct sizes, plus a card in a terminal
 * lane so open != total.
 *
 * ⚠️ The live sessions deliberately REUSE two of the seeded agents' ids: `seedLiveSession` mints a
 * fresh agent when none is given, which would silently push the agent count past AGENTS and make the
 * Agents tab's assertion a test of this helper rather than of the node. And no session is given a
 * `task`, which would seed a board card and inflate the board count the same way.
 */
async function seedProjectNode(loomDaemon: LoomDaemon) {
  const project = await loomDaemon.createProject(uniq("projtabs"));
  const cardTitles: string[] = [];
  for (let i = 0; i < OPEN_CARDS; i++) {
    const title = uniq(`projtabs-open-${i}-SENTINEL`);
    await loomDaemon.createTask(project.id, { title, body: `body ${title}`, columnKey: "todo" });
    cardTitles.push(title);
  }
  for (let i = 0; i < DONE_CARDS; i++) {
    await loomDaemon.createTask(project.id, { title: uniq(`projtabs-done-${i}`), columnKey: "done" });
  }
  await loomDaemon.seedProjectMemory(project.id, Array.from({ length: MEMORY_NOTES }, (_, i) => ({
    key: `projtabs-note-${i}`, text: `note body ${i}`, title: `projtabs note ${i}`,
  })));
  const agents = [];
  for (let i = 0; i < AGENTS; i++) agents.push(await seedAgent(loomDaemon.baseURL, project.id, uniq(`projtabsagent-${i}`)));
  for (let i = 0; i < LIVE_SESSIONS; i++) {
    await loomDaemon.seedLiveSession({
      project, agentId: agents[i]!.id, agentName: agents[i]!.name, role: i === 0 ? "manager" : "worker",
    });
  }
  return { project, cardTitles };
}

test.describe("Atlas project node tabs (card 25c08fba)", () => {
  test("switch ON: the ten declared tabs render with real counts, and each one is a real address",
    async ({ page, loomDaemon }) => {
      // Ten tabs, each clicked and then RELOADED, on a page whose board/memory/agents reads all have to
      // resolve, is well past the 30s default.
      test.setTimeout(240_000);

      const { rows, rawMarkers, block } = parseProjectNodeTabs();
      // POSITIVE CONTROLS on the parse. (a) it found something; (b) it found EVERY row the block
      // declares, so a quietly-narrowed regex cannot hand back a plausible subset; (c) it resolves a
      // row this spec can name independently, so the pattern is shown to WORK and not merely to return
      // the right COUNT of something.
      expect(rows.length, `the PROJECT_NODE_TABS parse found no rows. Block:\n${block}`).toBeGreaterThan(0);
      expect(rows.length,
        `the parse returned ${rows.length} row(s) but the declaration contains ${rawMarkers} key: marker(s)`
        + ` — the pattern is dropping rows. Block:\n${block}`).toBe(rawMarkers);
      expect(rows, "positive control: the parse did not resolve the Board tab, a row the declaration carries")
        .toContainEqual({ key: "board", label: "Board", to: "/board" });
      // The card's own claim is TEN. Stated as a floor on the DECLARATION (not on the DOM) so a
      // shrunk declaration cannot make the DOM comparison below pass vacuously against a shorter list.
      expect(rows.length, "the approved design declares ten project tabs").toBeGreaterThanOrEqual(10);

      const { project } = await seedProjectNode(loomDaemon);
      await seedAtlasOn(page);
      await pinProject(page, project.id);
      await page.setViewportSize(VIEWPORT);
      await page.goto(loomDaemon.baseURL + "/project");
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      // FIXTURE IDENTITY: this really is the project this test seeded, not whichever one the shared
      // worker daemon happened to resolve first.
      await expect(page.getByTestId("atlas-project-name")).toHaveText(project.name);

      // ── 1. THE TAB SET, in order, with the declared labels. ──
      await expect(tabRow(page)).toBeVisible();
      // Read off the ROW, which is the whole set HERE and only here: Overview is the one tab with no
      // KPI strip (card 7874e8c2), so at this width nothing folds into a More menu (card d4350286).
      // Pinned explicitly rather than assumed — otherwise the day Overview grows a strip this
      // becomes a partial check that still reads like a complete one.
      await expect(page.getByTestId("atlas-node-tabs-more"),
        "the Overview tab's row overflowed, so the row alone is no longer the declared tab set")
        .toHaveCount(0);
      const rendered = await tabRow(page).locator('[role="tab"]').evaluateAll((els) =>
        els.map((el) => ({
          key: (el.getAttribute("data-testid") ?? "").replace(/^atlas-tab-/, ""),
          // The label is the tab's own text minus the count span, which is a sibling node.
          label: (Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE)?.textContent ?? "").trim(),
        })),
      );
      expect(rendered.map((t) => t.key), "the rendered tab row is not the declared tab set, in order")
        .toEqual(rows.map((t) => t.key));
      expect(rendered.map((t) => t.label), "a rendered tab label does not match its declaration")
        .toEqual(rows.map((t) => t.label));

      // ── 2. THE COUNTS. Four seeded populations, four distinct sizes, each read off its own tab. ──
      expect(await tabCount(page, "board"),
        `the Board tab must read the ${OPEN_CARDS} OPEN cards, not the ${OPEN_CARDS + DONE_CARDS} total`)
        .toBe(OPEN_CARDS);
      expect(await tabCount(page, "memory"), "the Memory tab's count").toBe(MEMORY_NOTES);
      expect(await tabCount(page, "sessions"), "the Sessions tab's count").toBe(LIVE_SESSIONS);
      expect(await tabCount(page, "agents"), "the Agents tab's count").toBe(AGENTS);
      // The other half of "with counts": a count appears exactly where the design gives one. These
      // four have no natural figure, and a count on them would be invented rather than read.
      for (const key of ["overview", "deck", "repository", "settings"]) {
        expect(await tabCount(page, key),
          `the ${key} tab renders a count, which the approved design does not give it`).toBeNull();
      }

      // ── 3. EVERY TAB IS A REAL ADDRESS. ──
      for (const t of rows) {
        // Through whichever half of the row holds it: landing on a strip-carrying tab collapses the
        // row (card d4350286), so the tabs after the first few live in the More menu by the time the
        // loop reaches them. Every one of the ten is still exercised — that is this section's claim.
        await openNodeTab(page, t.key);
        // The click navigated to exactly the address the declaration names — query included, since a
        // home tab's `?tab=` IS its address.
        await expect(page, `clicking the ${t.key} tab did not land on ${t.to}`)
          .toHaveURL(loomDaemon.baseURL + t.to);
        await expect(tabLink(page, t.key), `the ${t.key} tab is not selected after landing on it`)
          .toHaveAttribute("aria-selected", "true");
        // Exactly one tab reads as selected in the node's own row, so a landing cannot light two.
        await expect(tabRow(page).locator('[role="tab"][aria-selected="true"]'),
          `landing on the ${t.key} tab selected more than one tab`).toHaveCount(1);

        // A RELOAD comes back on the same tab, from the address alone — the claim that makes it an
        // address rather than component state.
        await page.reload();
        await expect(page.getByTestId("atlas-shell")).toBeVisible();
        await expect(tabLink(page, t.key), `a reload of ${t.to} did not come back on the ${t.key} tab`)
          .toHaveAttribute("aria-selected", "true");
        // And the BODY is there, not just the selected tab — a tab row that highlighted correctly over
        // an empty column would satisfy the line above on its own.
        if (pathOf(t.to) === "/project") {
          await expect(page.locator(".loom-atlas-home"), `the ${t.key} tab's body`).toBeVisible();
        } else {
          await expect(tabPanel(page, t.key), `the ${t.key} tab's body`).toBeVisible();
          await expect(tabPanel(page, t.key)).not.toBeEmpty();
        }
      }
    });

  test("switch ON: every tab stays reachable at phone width, and one of the last ones still navigates",
    async ({ page, loomDaemon }) => {
      // Ten tabs is five times what this row was built for, and an unwrapped row is CLIPPED at its
      // container's edge rather than scrolled — so at 420 the tail of the set was simply off-screen,
      // with no scrollbar and no other way to reach it. "They are all in the DOM" is not the claim
      // worth making here; "a reader can see and click the last one" is.
      test.setTimeout(120_000);
      const { rows } = parseProjectNodeTabs();
      const { project } = await seedProjectNode(loomDaemon);
      await seedAtlasOn(page);
      await pinProject(page, project.id);
      await page.setViewportSize({ width: 420, height: 900 });
      await page.goto(loomDaemon.baseURL + "/project");
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(page.getByTestId("atlas-project-name")).toHaveText(project.name);
      await expect(tabRow(page)).toBeVisible();

      // Since card d4350286 the tail of the set lives in a More menu at this width rather than on a
      // second and third wrapped line. "Every tab is laid out inside the viewport" is therefore no
      // longer the whole measurement — a folded tab has no box at all — but the CLAIM is unchanged
      // and is checked in three parts, none of them weaker than the single loop they replace:
      //   (a) nothing the row shows runs off either edge,
      //   (b) row + menu together are still the whole declared set, so nothing is simply lost,
      //   (c) the menu, where the tail now is, is itself inside the viewport, item boxes included.
      // ⛔ Do NOT shrink this back to "the tabs that happen to be in the row fit" — that passes on a
      // row which silently dropped half its tabs, which is the defect this leg exists to catch.
      const rowKeys = await tabRow(page).locator('[role="tab"]').evaluateAll((els) =>
        els.map((el) => (el.getAttribute("data-testid") ?? "").replace(/^atlas-tab-/, "")));
      for (const key of rowKeys) {
        const box = await tabLink(page, key).boundingBox();
        expect(box, `the ${key} tab is not laid out at 420px`).not.toBeNull();
        expect(box!.x, `the ${key} tab starts off the left of a 420px viewport`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width,
          `the ${key} tab runs past the right edge of a 420px viewport (x=${Math.round(box!.x)},`
          + ` w=${Math.round(box!.width)}) — the tab row is clipping its tail`).toBeLessThanOrEqual(420);
      }
      // (b) Nothing is lost: the two halves together are exactly the ten declared tabs.
      expect((await nodeTabKeys(page)).sort(), "a declared tab is in neither the row nor the menu")
        .toEqual(rows.map((t) => t.key).sort());

      // (c) The menu panel and every item in it sit inside the viewport — the same discriminating
      // form as (a), applied to where the tail actually went. A menu hanging off the right edge at
      // phone width is the original defect in a new costume.
      await page.getByTestId("atlas-node-tabs-more").click();
      const menu = page.getByTestId("atlas-node-tabs-menu");
      await expect(menu).toBeVisible();
      const menuBoxes = await menu.evaluate((el) => {
        const own = el.getBoundingClientRect();
        return {
          panel: { l: own.left, r: own.right },
          items: [...el.querySelectorAll('[role="menuitem"]')].map((it) => {
            const r = it.getBoundingClientRect();
            return { key: (it.getAttribute("data-testid") ?? "").replace(/^atlas-more-item-/, ""), l: r.left, r: r.right };
          }),
        };
      });
      expect(menuBoxes.items.length, "the More menu is empty at 420px").toBeGreaterThan(0);
      for (const b of [{ key: "the menu panel", ...menuBoxes.panel }, ...menuBoxes.items]) {
        expect(b.l, `${b.key} starts off the left of a 420px viewport`).toBeGreaterThanOrEqual(0);
        expect(b.r, `${b.key} runs past the right edge of a 420px viewport`).toBeLessThanOrEqual(420);
      }
      await page.keyboard.press("Escape");

      // EXERCISED, not merely measured: the LAST tab — the one a clipped row loses first, and the
      // one that is now folded away — really navigates from this width.
      const last = rows[rows.length - 1]!;
      await openNodeTab(page, last.key);
      await expect(page, `the last tab did not navigate at 420px`).toHaveURL(loomDaemon.baseURL + last.to);
      await expect(tabLink(page, last.key)).toHaveAttribute("aria-selected", "true");

      // CONTRAST CASE: the same ten tabs at 1440 sit on ONE line with NO menu at all, so the fold
      // above is the narrow viewport's answer and not a layout imposed on every width. (This is the
      // Overview tab, the one tab with no KPI strip — a strip-carrying tab folds at 1440 too, by
      // design, and card d4350286's own spec is where that is measured.)
      await page.setViewportSize(VIEWPORT);
      await page.goto(loomDaemon.baseURL + "/project");
      await expect(tabRow(page)).toBeVisible();
      const tops = await tabRow(page).locator('[role="tab"]').evaluateAll((els) =>
        [...new Set(els.map((el) => Math.round(el.getBoundingClientRect().top)))]);
      expect(tops.length, `the ten tabs wrapped onto ${tops.length} lines at ${VIEWPORT.width}px`).toBe(1);
    });

  test("switch ON: the Board tab is the whole board, and a card opens the centred dialog",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const { project, cardTitles } = await seedProjectNode(loomDaemon);
      await pinProject(page, project.id);
      await page.setViewportSize(VIEWPORT);

      // The lane count is MEASURED, on the classic /board page in this same browser against this same
      // build, before any claim about the tab. Stating a number here would make "all lanes" a
      // comparison against this file's memory of the board rather than against the board.
      await page.goto(loomDaemon.baseURL + "/board");
      await expect(page.locator(".loom-rail")).toBeVisible();
      // RETRYING, then counted. `locator.count()` does not auto-wait, so a bare count straight after
      // the rail appears reads whatever the board's own query has resolved so far — measured: it came
      // back 0 and reported "the classic board rendered no lanes" on a page that renders seven. Waiting
      // for the seeded CARD (not merely for a lane) is what proves the board's data actually landed, so
      // the number taken is the settled lane count rather than a partial one.
      await expect(openTargetIn(page.locator("main"), cardTitles[0]!),
        "the classic board never rendered this test's seeded card, so its lane count is not settled")
        .toBeVisible();
      const classicLanes = await lanesIn(page.locator("main")).count();
      expect(classicLanes, "the classic board rendered no lanes, so there is nothing to compare")
        .toBeGreaterThan(1);

      // ON, reached THROUGH the tab row rather than by typing the URL — the affordance this card adds.
      await seedAtlasOn(page);
      await page.goto(loomDaemon.baseURL + "/project");
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(page.getByTestId("atlas-project-name")).toHaveText(project.name);
      await tabLink(page, "board").click();
      await expect(page).toHaveURL(loomDaemon.baseURL + "/board");

      const scope = tabPanel(page, "board");
      await expect(scope).toBeVisible();

      // ALL LANES — the same number the classic page just rendered.
      await expect(lanesIn(scope), "the Board tab clipped the board's lanes").toHaveCount(classicLanes);
      // ALL CARDS — every seeded card, not a summary or a trimmed slice.
      for (const title of cardTitles) {
        await expect(openTargetIn(scope, title), `the Board tab is missing the seeded card ${title}`)
          .toBeVisible();
      }
      // THE SAME MULTI-SELECT FILTERS — present on the tab. Their BEHAVIOUR is atlas-board-filters'
      // claim at this same address; what this card can break is the controls not being here at all.
      await expect(scope.getByLabel("Search tasks by id, title, or description")).toBeVisible();
      await expect(scope.getByRole("button", { name: /^Filter by .+ priority$/ }).first()).toBeVisible();
      await expect(scope.getByRole("button", { name: /^Filter by .+ column$/ }).first()).toBeVisible();

      // THE CENTRED DIALOG, never a drawer. Presence of the card first, then the absence of a dialog,
      // so a still-loading page cannot satisfy the pair (card 625d791c).
      const card = openTargetIn(scope, cardTitles[0]!);
      await expect(card).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await card.click();

      const dialog = page.getByRole("dialog");
      await expect(dialog, "exactly one detail surface, not the shared dialog plus a second one")
        .toHaveCount(1);
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      const panel = await dialog.locator("> div").boundingBox();
      expect(panel, "the dialog panel must be laid out before it can be measured").not.toBeNull();
      const leftGap = panel!.x;
      const rightGap = VIEWPORT.width - (panel!.x + panel!.width);
      expect(leftGap, "the panel is clear of the left edge").toBeGreaterThan(0);
      expect(rightGap, "the panel is clear of the right edge").toBeGreaterThan(0);
      // THE drawer check: a slide-over is flush to one edge, so its two gaps differ by hundreds of px.
      expect(Math.abs(leftGap - rightGap),
        "the Board tab's card detail is anchored to an edge — a drawer, not the centred dialog")
        .toBeLessThan(2);
      // And the board behind it is still whole: a drawer's cost is the reflow, not just the position.
      await expect(lanesIn(scope), "the board reflowed when the dialog opened").toHaveCount(classicLanes);
    });

  test("switch ON: unfinished input on a tab survives switching away and back",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const { project } = await seedProjectNode(loomDaemon);
      await seedAtlasOn(page);
      await pinProject(page, project.id);
      await page.setViewportSize(VIEWPORT);
      await page.goto(loomDaemon.baseURL + "/board");
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(page.getByTestId("atlas-project-name")).toHaveText(project.name);

      // The Board tab's own filter box — real, un-persisted component state, which is exactly what a
      // tab switch would destroy if the body were unmounted.
      const draft = `draft-SENTINEL-${Date.now()}`;
      const search = tabPanel(page, "board").getByLabel("Search tasks by id, title, or description");
      await expect(search).toBeVisible();
      await search.fill(draft);
      await expect(search).toHaveValue(draft);

      // Away to a different tab, and far enough that the Board body is genuinely not the rendered one.
      await tabLink(page, "memory").click();
      await expect(page).toHaveURL(loomDaemon.baseURL + "/memory");
      await expect(tabPanel(page, "memory")).toBeVisible();
      // The Board body is PARKED, not rendered: still in the document (which is what preserves it) and
      // hidden from the reader. `hidden` rather than removed is the whole mechanism.
      await expect(tabPanel(page, "board")).toBeHidden();

      // …and back. The draft is still there.
      await tabLink(page, "board").click();
      await expect(page).toHaveURL(loomDaemon.baseURL + "/board");
      await expect(tabPanel(page, "board").getByLabel("Search tasks by id, title, or description"),
        "the Board tab's unfinished input did not survive a switch away and back")
        .toHaveValue(draft);

      // THE CONTRAST CASE. "Still there" is also what a page that never cleared anything would report,
      // and it would be satisfied by a draft stored globally (a shared store, localStorage) rather than
      // by the body having stayed mounted. A FULL RELOAD discards component state by construction, so
      // the SAME box on the SAME address must come back EMPTY — which is only true if what survived
      // the tab switch was this mounted instance and nothing else.
      await page.reload();
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(tabPanel(page, "board").getByLabel("Search tasks by id, title, or description"),
        "the draft survived a full reload too, so the tab switch proved nothing about staying mounted")
        .toHaveValue("");
    });

  test("switch OFF: every re-homed path renders its classic page, with nothing Atlas mounted",
    async ({ page, loomDaemon }) => {
      test.setTimeout(240_000);
      const { rows } = parseProjectNodeTabs();
      // The addresses this card re-homed: every tab that brought its own path, i.e. everything but the
      // two home tabs on the node's own address (which the classic shell deliberately never mounts).
      const rehomed = [...new Set(rows.map((t) => pathOf(t.to)).filter((p) => p !== "/project"))];
      expect(rehomed.length, "no re-homed path to check, so this test proves nothing")
        .toBeGreaterThanOrEqual(8);

      // Split by KIND, derived from NAV_PAGES — see parseNavPagePaths above for why the two halves
      // carry different claims. Both halves get a floor, so a parse that silently emptied one would
      // fail here rather than reduce that half's walk to nothing.
      const nav = parseNavPagePaths();
      expect(nav.paths.length, `the NAV_PAGES parse found no rows. Block:\n${nav.block}`).toBeGreaterThan(0);
      expect(nav.paths.length,
        `the parse returned ${nav.paths.length} row(s) but NAV_PAGES contains ${nav.rawMarkers} entries`
        + ` — the pattern is dropping rows. Block:\n${nav.block}`).toBe(nav.rawMarkers);
      const bothShells = rehomed.filter((p) => nav.paths.includes(p));
      const atlasOnly = rehomed.filter((p) => !nav.paths.includes(p));
      expect(bothShells.length, "no re-homed NAV_PAGES destination to check").toBeGreaterThanOrEqual(7);
      expect(atlasOnly.length, "no re-homed Atlas-only node to check").toBeGreaterThanOrEqual(1);

      const { project, cardTitles } = await seedProjectNode(loomDaemon);
      await pinProject(page, project.id);
      await page.setViewportSize(VIEWPORT);

      const classicText = new Map<string, string>();
      for (const to of bothShells) {
        await page.goto(loomDaemon.baseURL + to);
        // PRESENCE first: the classic shell really rendered, with real content in it. Deliberately NOT
        // `main h1` — measured: the classic Board page renders no `<h1>` at all, so that probe would
        // have been a check on which pages happen to carry a heading, not on whether they rendered.
        await expect(page.locator(".loom-rail"), `${to} did not render the classic rail`).toBeVisible();
        const text = (await page.locator("main").innerText()).trim();
        expect(text.length, `${to} rendered an empty main column under the classic shell`)
          .toBeGreaterThan(20);
        classicText.set(to, text);
        // …and only THEN the absences. Asserted in every way Atlas could be detected, not just by the
        // shell's own testid: the node tab row this card adds, and the stylesheet classes the Atlas
        // frame is the only consumer of.
        await expect(page.getByTestId("atlas-shell"), `${to} mounted the Atlas shell`).toHaveCount(0);
        await expect(tabRow(page), `${to} rendered the project node's tab row under the classic shell`)
          .toHaveCount(0);
        expect(await page.locator('[class*="loom-atlas"]').count(),
          `${to} rendered an element carrying an Atlas frame class under the classic shell`).toBe(0);
      }

      // DISCRIMINATION CONTROL on that probe: "real content rendered" would also be satisfied by one
      // error panel, or one still-loading shell, served at all eight addresses. Each page must read
      // DIFFERENTLY from the others, so the walk is shown to have visited eight distinct pages rather
      // than the same one eight times.
      expect(new Set(classicText.values()).size,
        `the classic pages collapsed to ${new Set(classicText.values()).size} distinct rendering(s) across`
        + ` ${bothShells.length} addresses — the walk may be reading one shell, not ${bothShells.length} pages`)
        .toBe(bothShells.length);

      // The OTHER half: a re-homed ATLAS-ONLY node. The claim here is not "its classic page is
      // untouched" — it has none, and never did — but that the switch being off still mounts nothing
      // Atlas at that address, so a user who never opted in cannot reach the preview through a tab
      // this card re-homed.
      for (const to of atlasOnly) {
        await page.goto(loomDaemon.baseURL + to);
        await expect(page.locator(".loom-rail"), `${to} did not render the classic rail`).toBeVisible();
        await expect(page.getByTestId("atlas-shell"), `${to} mounted the Atlas shell`).toHaveCount(0);
        await expect(tabRow(page), `${to} rendered the project node's tab row under the classic shell`)
          .toHaveCount(0);
        expect(await page.locator('[class*="loom-atlas"]').count(),
          `${to} rendered an element carrying an Atlas frame class under the classic shell`).toBe(0);
      }

      // FIXTURE IDENTITY, on the one re-homed page that can show it: the walk above really ran against
      // this test's own project, so "the classic page rendered" is a claim about seeded data and not
      // about an empty or errored shell.
      await page.goto(loomDaemon.baseURL + "/board");
      await expect(openTargetIn(page.locator("main"), cardTitles[0]!)).toBeVisible();
      expect(project.name.length, "the seeded project has no name to identify it by").toBeGreaterThan(0);
    });
});
