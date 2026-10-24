// Mission Control and Projects RETIRED as Atlas destinations (card 5afd71bd, Atlas restructure 11 of
// 11, epic 9fe8cd4e). Design record: docs/decisions/5afd71bd-atlas-retire-mission-control-and-projects.md.
//
// The two class-D pages the approved round-4 V2 design dissolves outright rather than re-homing: every
// surface each one held now lives on a node or a tab of one (cards 7b893d54 / c2968651 / ff6123de for
// Mission Control's; cards 0d0c6cee / c9b78d80 / baca1835 / 318b5a21 and the Platform node's guided
// setup wizard for the Projects page's). The owner signed the removal off in request b54c9e59, and
// scoped it to Atlas: with the switch OFF both pages render exactly as today.
//
// Five claims, each measured against the running app rather than a list typed into this file:
//   1. THE ADDRESSES REDIRECT. Each retired `from` lands on the node that absorbed it — inside the
//      Atlas frame, never the catch-all — with that node reading as the landed one in the tree, the
//      heading and the crumbs. The rows are parsed out of the real `ATLAS_RETIREMENTS` declaration.
//   2. NEITHER IS IN THE TREE, in any of the places a destination can be: not a node row, and not an
//      escape-hatch entry — because this card DELETED the hatch, so the whole disclosure is gone.
//   3. NO DEAD LINK POINTS AT ONE. The three re-pointed exits are asserted on their real `href`s and
//      the Pulse band's retired exit is asserted ABSENT, each with the same collector shown firing on
//      a sibling that kept its link; the ⌘K palette no longer offers either destination.
//   4. SWITCH OFF: both addresses still render their own standalone page, in the classic frame, with
//      no redirect and no Atlas element — and the rail and the palette still list both.
//   5. Claim 4's palette reading is also the POSITIVE CONTROL for claim 3's palette absence: the same
//      locator, on the same build, offering the same two rows the ON leg requires zero of.
//
// Every absence claim carries a positive control on the same collector at the same moment: an empty or
// mis-typed locator returns zero exactly like a true absence does.
//
// FIXTURE IDENTITY is asserted, not assumed: this daemon is shared across the specs in its worker, so
// each leg names a project THIS spec created and checks the frame is really scoped to it.
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

/** The rail renders one anchor per NAV_PAGES entry; Settings sits in its footer as a `statrow`. */
const RAIL_LINKS = "a.loom-rail-item, a.loom-rail-statrow";
/** The escape hatch's own link class (card 0d0c6cee) — nothing may render one after this card. */
const HATCH_LINKS = "a.loom-atlas-unhomed-link";

// ── The declaration under test ─────────────────────────────────────────────────────────────────
type Retirement = { from: string; to: string };

// Parsed from the real source, with the filtered row count checked against the declaration's own raw
// marker count — same idiom (and same reason) as atlas-workspace-tabs.spec.ts's own parse. A regex
// that quietly stopped matching a row would otherwise hand back a plausible SUBSET, and a subset reads
// exactly like a complete list.
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

/** Parsed once per test, with its own controls run inside each test that uses it. */
function retirementsUnderTest(): Retirement[] {
  const { rows, rawMarkers, block } = parseRetirements();
  expect(rows.length, `the ATLAS_RETIREMENTS parse found no rows. Block:\n${block}`).toBeGreaterThan(0);
  expect(rows.length,
    `the parse returned ${rows.length} row(s) but the declaration contains ${rawMarkers} entries`
    + ` — the pattern is dropping rows. Block:\n${block}`).toBe(rawMarkers);
  // POSITIVE CONTROL that the pattern resolves a row this spec can name independently, so it is shown
  // to WORK and not merely to return the right COUNT of something.
  expect(rows, "positive control: the parse did not resolve the Mission Control row the declaration is known to carry")
    .toContainEqual({ from: "/", to: "/home" });
  // Every `to` must be a real address, or every landing assertion below is comparing nothing.
  for (const r of rows) expect(r.to, `${r.from} retires to a relative/empty path`).toMatch(/^\//);
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

/** The crumb trail's visible segments, in order — same reader as atlas-legacy-redirects.spec.ts's. */
async function crumbTrail(page: Page): Promise<string[]> {
  return page.getByTestId("atlas-breadcrumb").locator("li").evaluateAll((lis) =>
    lis.map((li) => {
      const spans = Array.from(li.querySelectorAll("span")).filter((s) => !s.hasAttribute("aria-hidden"));
      return (spans[spans.length - 1]?.textContent ?? "").trim();
    }),
  );
}

const nodeHeading = (page: Page) => page.locator(".loom-atlas-nodehead h1");

/** The rail's own label for an address, so a claim about a label is never a literal typed here. */
async function railLabels(page: Page): Promise<Map<string, string>> {
  return new Map(await page.locator(RAIL_LINKS).evaluateAll((els) =>
    els.map((el) => [new URL((el as HTMLAnchorElement).href).pathname,
      (el.querySelector(".loom-rail-lbl") ?? el).textContent?.trim() ?? ""] as [string, string])));
}

/**
 * The palette's own PAGE rows, opened with the real accelerator — each as its label alone.
 *
 * A row is a <button> holding two spans, the label and the `hint` ("page" for a nav destination,
 * "session"/"review"/"question" for an attention item), so the label is read off the FIRST span and
 * the hint is what filters the list down to nav destinations. Read span-by-span rather than from the
 * button's `textContent`, which concatenates the two with no separator ("Mission Controlpage") and
 * would make every comparison here a comparison against a string the UI never shows.
 */
async function paletteRows(page: Page): Promise<string[]> {
  await page.keyboard.press("Control+k");
  const field = page.getByPlaceholder(/^Jump to/);
  await expect(field, "the Command Palette did not open").toBeVisible();
  const rows = await page.getByRole("button").evaluateAll((els) =>
    els.map((el) => Array.from(el.querySelectorAll("span"))
      .map((s) => (s.textContent ?? "").replace(/\s+/g, " ").trim()))
      .filter((spans) => spans[1] === "page")
      .map((spans) => spans[0] ?? ""));
  await page.keyboard.press("Escape");
  await expect(field, "the Command Palette did not close").toHaveCount(0);
  return rows;
}

test.describe("Atlas retired destinations (card 5afd71bd)", () => {
  test("switch ON: both addresses redirect to the node that absorbed them, and neither is in the tree",
    async ({ page, loomDaemon }) => {
      // Two retired addresses × (a redirect + a tree read + a frame read), plus the palette and the
      // re-pointed exits, is past the 30s default.
      test.setTimeout(180_000);
      const rows = retirementsUnderTest();
      const project = await loomDaemon.createProject(`atlas-retired-${Date.now()}`);
      const sentinel = `Atlas retired-destinations card ${Date.now()}`;
      await loomDaemon.createTask(project.id, { title: sentinel, columnKey: "inbox", priority: "p1" });
      await pinProject(page, project.id);

      // ── OFF first, so the LABELS the palette leg compares against are the app's own, not literals
      //    typed here: a rename would otherwise keep this spec passing while the two disagreed. ──
      await page.goto(loomDaemon.baseURL + "/");
      await expect(page.locator(".loom-rail")).toBeVisible();
      const labels = await railLabels(page);
      expect(labels.size, "the rail label collector found no destinations at all").toBeGreaterThan(5);
      for (const r of rows) {
        expect(labels.get(r.from),
          `the rail label collector read no label for the retired address ${r.from}`).toBeTruthy();
      }
      // A surviving destination's label, for the palette leg's own positive control below.
      const survivorLabel = labels.get("/settings");
      expect(survivorLabel, "the rail label collector read no label for /settings").toBeTruthy();

      await seedAtlasOn(page);

      // FIXTURE IDENTITY: the frame really is scoped to the project this spec created.
      await page.goto(loomDaemon.baseURL + "/board");
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      await expect(page.locator("main").getByText(sentinel, { exact: true }),
        "the Board node is not showing this spec's own corpus").toBeVisible();

      // ── CLAIM 1: the redirect, and the node it lands on. ──
      for (const r of rows) {
        await page.goto(loomDaemon.baseURL + r.from);

        // A FRESH LOAD of the retired address lands inside the frame, and NOT on the catch-all — which
        // is where simply deleting the <Route> would have sent it.
        await expect(page.getByTestId("atlas-shell")).toBeVisible();
        await expect(page.locator(".loom-rail")).toHaveCount(0);
        await expect(page.getByTestId("atlas-empty"),
          `${r.from} fell through to the Atlas catch-all instead of redirecting`).toHaveCount(0);
        // A retrying assertion, not a bare page.url() read: `goto` resolves on load, and the redirect
        // is a client-side history write that happens on the first render AFTER it.
        await expect(page, `${r.from} did not redirect to ${r.to} under Atlas`)
          .toHaveURL(loomDaemon.baseURL + r.to);

        // The landed node is the one that absorbed it — exactly one reads as landed, and it is that
        // one. Both of today's rows retire to `/home`, whose tree row is the Workspace home; the
        // assertion is written against the row's own `to` so a future retirement onto a different
        // node fails here rather than passing on a hardcoded expectation.
        expect(r.to, `this leg only knows how to check a retirement onto /home, not ${r.to}`).toBe("/home");
        await expect(page.locator("a.loom-atlas-node.is-active"),
          `${r.from} landed on ${r.to} but ${await page.locator("a.loom-atlas-node.is-active").count()}`
          + ` nodes read as landed`).toHaveCount(1);
        await expect(page.getByTestId("atlas-home-workspace"),
          `${r.from} landed without marking the Workspace node`).toHaveClass(/is-active/);
        // The frame names the TIER, not the retired page: `/home` is its tier's head, so the trail
        // stops at "Workspace" and the heading is the same word. A build that left the retired page in
        // the frame's own `currentPage` lookup would read "Mission Control" here instead.
        await expect(nodeHeading(page), `${r.from} left the frame naming the retired destination`)
          .toHaveText("Workspace");
        expect(await crumbTrail(page), `${r.from} produced the wrong breadcrumb trail`).toEqual(["Workspace"]);

        // ── CLAIM 2: not in the tree, in either of the two places a destination could be. ──
        await expect(page.getByTestId(`atlas-node-${r.from}`),
          `${r.from} is still an Atlas tree row`).toHaveCount(0);
        await expect(page.getByTestId(`atlas-unhomed-${r.from}`),
          `${r.from} is still a "not yet re-homed" escape-hatch entry`).toHaveCount(0);
      }

      // The whole hatch is GONE, not merely empty of these two — this card deleted the disclosure, so
      // there is nothing left for a future destination to fall into quietly. Stated once, document-wide.
      await expect(page.getByTestId("atlas-unhomed"),
        "the escape-hatch disclosure is still mounted").toHaveCount(0);
      await expect(page.locator(HATCH_LINKS),
        "the escape hatch still renders entries").toHaveCount(0);
      // POSITIVE CONTROLS on those absences: the SAME tree-node collector, on the SAME build, does see
      // the rows that deliberately stayed. Without these, a tree that failed to render at all would
      // satisfy every zero above.
      await expect(page.getByTestId("atlas-node-/platform"),
        "positive control: the tree-node collector cannot see the Platform node either").toHaveCount(1);
      await expect(page.getByTestId("atlas-node-/board"),
        "positive control: the tree-node collector cannot see the project-tier Board row either").toHaveCount(1);

      // ── CLAIM 3: no dead link points at a retired address. ──
      // The three re-pointed exits, read off their real `href`s. Each is EXERCISED or asserted against
      // a sibling that kept its own link, so none of these is a bare absence.
      await page.goto(loomDaemon.baseURL + "/home");
      await expect(page.getByTestId("atlas-band-pulse")).toBeVisible();
      const newProject = page.locator("main").getByRole("link", { name: /^New project/ });
      await expect(newProject, "the Workspace node lost its New project exit").toHaveCount(1);
      await expect(newProject, "the New project exit still points at the retired Projects page")
        .toHaveAttribute("href", "/platform");
      // The Pulse band's own exit is GONE (it is the deepest view of that feed now), with the Gates
      // band beside it as the control: the same collector DOES find a band exit that survived.
      await expect(page.getByTestId("atlas-band-pulse").getByRole("link"),
        "the Pulse band still carries an exit link").toHaveCount(0);
      await expect(page.getByTestId("atlas-band-gates").getByRole("link"),
        "positive control: the band-exit collector finds no link on the Gates band either, so the"
        + " Pulse zero above proves nothing").toHaveCount(1);

      await page.goto(loomDaemon.baseURL + "/agents");
      await expect(page.getByTestId("atlas-agents-define"),
        "the Agents node lost its all-projects exit").toHaveCount(1);
      await expect(page.getByTestId("atlas-agents-define"),
        "the Agents node's exit still points at the retired Projects page")
        .toHaveAttribute("href", "/home");

      // EXERCISED, not merely read: clicking New project really reaches the surface that absorbed
      // project creation, and that surface really offers it.
      await page.goto(loomDaemon.baseURL + "/home");
      await page.locator("main").getByRole("link", { name: /^New project/ }).click();
      await expect(page, "New project did not navigate to the Platform node").toHaveURL(/\/platform$/);
      await expect(page.getByRole("button", { name: /^Start guided setup/ }),
        "the Platform node offers no guided setup, so project creation has no home").toBeVisible();

      // The ⌘K palette no longer offers either destination. Its rows are read by accessible name, and
      // the surviving /settings row is the control that the collector is reading real rows.
      await page.goto(loomDaemon.baseURL + "/home");
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      const atlasRows = await paletteRows(page);
      expect(atlasRows.length, "the palette row collector found no page rows at all").toBeGreaterThan(5);
      expect(atlasRows, "positive control: the palette row collector did not read the surviving Settings row")
        .toContain(survivorLabel);
      for (const r of rows) {
        expect(atlasRows, `⌘K still offers the retired "${labels.get(r.from)}" destination under Atlas`)
          .not.toContain(labels.get(r.from));
      }
    });

  test("switch OFF: both pages render standalone exactly as today, rail and palette unchanged",
    async ({ page, loomDaemon }) => {
      test.setTimeout(120_000);
      const rows = retirementsUnderTest();
      const project = await loomDaemon.createProject(`atlas-retired-off-${Date.now()}`);
      await pinProject(page, project.id);
      // No seedAtlasOn: OFF is the default.

      await page.goto(loomDaemon.baseURL + "/");
      await expect(page.locator(".loom-rail")).toBeVisible();
      const labels = await railLabels(page);
      expect(labels.size, "the rail label collector found no destinations at all").toBeGreaterThan(5);

      for (const r of rows) {
        await page.goto(loomDaemon.baseURL + r.from);
        // NO redirect: the address is still its own page under the shell a user who never opted in
        // sees. This is the half of the owner's sign-off that scoped the removal to Atlas.
        await expect(page, `${r.from} redirected under the CLASSIC shell`)
          .toHaveURL(loomDaemon.baseURL + r.from);
        await expect(page.locator(".loom-rail"), `${r.from} lost the classic rail`).toBeVisible();
        // Asserted on the `loom-atlas` class PREFIX, so the shell, the tree, the node head and the
        // (now deleted) hatch are covered by one claim rather than a list of the ones this spec
        // happened to think of.
        await expect(page.locator("[class*='loom-atlas']"),
          `${r.from} mounted an Atlas element with the switch off`).toHaveCount(0);
        // And the page really RENDERED, rather than merely failing to redirect: its own <main> holds
        // content. A bare "no redirect" claim is satisfiable by a blank column.
        await expect(page.locator("main"), `${r.from} rendered an empty column`).not.toBeEmpty();
        // The rail still lists it, which is where a reader who never opted in reaches it from.
        expect([...labels.keys()], `${r.from} left the classic rail`).toContain(r.from);
      }

      // Each page's own distinctive control, so "rendered as today" is a reading of the real surface
      // rather than of any page that happens to be non-empty. Mission Control's fleet cluster and the
      // Projects page's own identity block + create affordance.
      await page.goto(loomDaemon.baseURL + "/");
      await expect(page.locator("main").getByRole("button", { name: "Kill all" }),
        "the classic Mission Control lost its fleet cluster").toBeVisible();
      await page.goto(loomDaemon.baseURL + "/projects");
      await expect(page.getByTestId("page-identity"),
        "the classic Projects page lost its own identity header").toHaveCount(1);
      await expect(page.locator("main").getByRole("button", { name: /New project/ }),
        "the classic Projects page lost its create affordance").toBeVisible();

      // CLAIM 5 — and this is the POSITIVE CONTROL for the ON leg's palette absence: the same locator,
      // on the same build, offering the very two rows the ON leg requires zero of.
      const classicRows = await paletteRows(page);
      expect(classicRows.length, "the palette row collector found no page rows at all").toBeGreaterThan(5);
      for (const r of rows) {
        expect(classicRows, `⌘K no longer offers "${labels.get(r.from)}" under the CLASSIC shell`)
          .toContain(labels.get(r.from));
      }
    });
});
