// The Atlas tree as a narrow-width DRAWER — card 49e883a9 (Atlas restructure 7 of 11), closing item 7
// of the Atlas gap audit and the crumb half of superseded backlog card 9477a5ed. Design record:
// docs/decisions/49e883a9-atlas-tree-drawer-at-narrow-widths.md.
//
// What the card claims, and how each half is measured rather than asserted by shape:
//   1. SWITCH ON at 420px — the tree is OUT of flow (an overlay, not a stacked block), so the node
//      head starts directly under the crumb row instead of ~290px down the page; the drawer opens and
//      closes via the toggle, Escape and the scrim, each with a before/after visibility diff; the
//      deepest crumb is not truncated; a tree row navigates AND closes; and a typed draft in the page
//      underneath survives an open/close cycle.
//   2. SWITCH ON at 1440px — the tree is still a persistent rail: in flow, visible, no toggle.
//   3. SWITCH OFF at 420px — the classic Instrument Rail's own narrow behaviour is untouched, and no
//      part of this card's machinery exists anywhere in that shell.
//
// ⛔ VISIBILITY IS THE MEASUREMENT, NOT PRESENCE. The drawer OVERLAYS — it never unmounts the tree,
// the content column or the page panels (the owner's standing rule: no path discards unfinished
// input, and the tree would lose its own branch-expansion state). So `toHaveCount(0)` on the tree is
// the WRONG assertion at every width: the element is always in the document. Each leg reads computed
// `visibility`/`position` off the real box instead, and the draft-survival leg is what proves the
// overlay claim behaviourally rather than by reading the CSS back.
import { expect, test, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

const NARROW = { width: 420, height: 900 };
const WIDE = { width: 1440, height: 1000 };

// The board's own search box. Chosen deliberately: it is a page panel's OWN uncontrolled input, so a
// drawer that unmounted or remounted the content column would lose it — which is exactly the owner
// rule this leg is here to hold, and nothing in the CSS can fake passing it.
const BOARD_SEARCH = "search tasks by id or text…";
const DRAFT = "drawer-must-not-eat-this";

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// Writes only while the key is still absent: addInitScript re-runs on every navigation, `reload()`
// included, so an unconditional write would re-pin on a reload and that leg would be measuring this
// helper instead of the app (measured on P1-4).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

/** The tree's own rendered geometry — the two facts that separate an overlay from a stacked block. */
async function treeBox(page: Page) {
  return page.locator(".loom-atlas-tree").evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      position: cs.position, visibility: cs.visibility,
      box: el.getBoundingClientRect().toJSON() as { top: number; height: number; width: number },
    };
  });
}

/**
 * A project with a realistically-named board. The NAME LENGTH is load-bearing for the crumb leg:
 * decision 1d3192dc deliberately does NOT cap the deepest crumb's width, so a 40-character project
 * name legitimately still ellipsises at 420px and asserting otherwise would be asserting against the
 * design. `atlas-narrow` is 12 characters — representative of a real project name, and the claim
 * "a normal label fits the row the fix freed up" is the claim the card actually makes.
 */
async function seedNarrowProject(loomDaemon: { createProject: (n?: string) => Promise<{ id: string; name: string }>;
  createTask: (p: string, t: { title: string; columnKey: string }) => Promise<unknown> }) {
  const project = await loomDaemon.createProject("atlas-narrow");
  for (const title of ["feat(web): first card", "fix(daemon): second card", "chore(ci): third card"]) {
    await loomDaemon.createTask(project.id, { title, columnKey: "todo" });
  }
  return project;
}

test.describe("Atlas tree drawer at narrow widths", () => {
  test("switch ON at 420px: the tree is an overlay, so the node head is in the first viewport", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const project = await seedNarrowProject(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.setViewportSize(NARROW);
    await page.goto(loomDaemon.baseURL + "/project");

    // PRESENCE FIRST (card 625d791c): the frame has to be up before any geometry read means anything.
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    await expect(page.getByTestId("atlas-nodehead-extras")).toBeAttached();

    // (1) The tree is OUT of flow. This is the whole mechanism — a `fixed` tree contributes no height
    //     to the frame's grid, which is what a 33dvh stacked strip did.
    const tree = await treeBox(page);
    expect(tree.position, "the tree is an overlay at 420px, not a row in the frame's grid").toBe("fixed");
    expect(tree.visibility, "a closed drawer is not in the tab order or the a11y tree").toBe("hidden");

    // (2) STRUCTURAL: the node head sits directly under the crumb row, with nothing between them.
    //     This is the form that cannot drift — it stays true if a later card re-sizes the crumb row.
    const geom = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      return { crumbsBottom: r(".loom-atlas-crumbs").bottom, headTop: r(".loom-atlas-nodehead").top };
    });
    expect(geom.headTop, "the node head starts at the crumb row's own bottom edge").toBeLessThanOrEqual(geom.crumbsBottom + 2);

    // (3) ABSOLUTE, with its bound justified rather than picked: the only chrome the card permits above
    //     the node head is the crumb row, which is 52px at this width by `.loom-atlas-crumbs`' own
    //     `min-height` (matched to the drawer head's 52px so the toggle and the logo share a centre
    //     line), plus its 1px border. 120px is that ~53px with room for a crumb row that grew, and is
    //     still less than half the ~290px nav block the gap audit measured here. Anything at or near
    //     290 is a stacked tree, which is the regression this number exists to catch.
    expect(geom.headTop, "no ~290px navigation block above the node head").toBeLessThan(120);

    // (4) And the document does not gain a sideways scroll from a 300px panel sitting off-canvas.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "a closed off-canvas drawer adds no horizontal document scroll").toBeLessThanOrEqual(0);
  });

  test("switch ON at 420px: the toggle, Escape and the scrim each open and close the drawer", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const project = await seedNarrowProject(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.setViewportSize(NARROW);
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-shell")).toBeVisible();

    const toggle = page.getByTestId("atlas-tree-toggle");
    const scrim = page.getByTestId("atlas-tree-scrim");
    // ⚠️ The visibility diffs below go through Playwright's own AUTO-WAITING `toBeVisible`/`toBeHidden`
    // rather than a one-shot computed-style read. The drawer holds `visibility: visible` for the 180ms
    // the slide-out takes (that delay is the point — an element yanked from the a11y tree mid-animation
    // flickers), so a bare read taken the instant `aria-expanded` flips measures the transition, not the
    // state. Measured: two legs red on `"visible"` before this. `toBeHidden` treats `visibility: hidden`
    // as hidden, which is exactly the state this card uses to take a closed drawer out of the tab order.
    const treeEl = page.locator(".loom-atlas-tree");
    await expect(toggle).toBeVisible();

    // The CLOSED baseline every diff below is measured against.
    await expect(treeEl).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(scrim).toHaveCount(0);

    // ── OPEN via the toggle. Each close path is then exercised from a freshly-opened drawer, so the
    //    three legs are genuinely independent rather than one long chain where leg 2 only passes
    //    because leg 1 happened to leave the right state behind.
    const open = async () => {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(treeEl).toBeVisible();
      const t = await treeBox(page);
      expect(t.box.width, "the drawer takes real width, not a collapsed box").toBeGreaterThan(200);
      expect(t.box.top, "the drawer covers the frame from the top edge").toBeLessThanOrEqual(0);
      await expect(scrim).toHaveCount(1);
      // Focus moved INTO the drawer, so a keyboard reader is not left behind on the topbar.
      // ⛔ Web-first, never a bare `document.activeElement` read: AtlasTree moves focus from a
      // PASSIVE effect (`useEffect(() => { ... nav.focus(...) }, [open])`), which React runs after
      // the commit `toBeVisible()` above resolves on — the same race card 485d67b4 measured at 4 in
      // 20 runs on the tab-overflow menu's own open.
      await expect(treeEl, "focus moved into the drawer").toBeFocused();
    };
    const expectClosedAndRefocused = async (via: string) => {
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(treeEl, `closed via ${via}`).toBeHidden();
      await expect(scrim).toHaveCount(0);
      // Focus RETURNED to the toggle — every close path removes the element focus was on from view.
      await expect(toggle, `focus returns to the toggle after closing via ${via}`).toBeFocused();
    };

    await open();
    await toggle.click();
    await expectClosedAndRefocused("the toggle");

    await open();
    await page.keyboard.press("Escape");
    await expectClosedAndRefocused("Escape");

    await open();
    // Force: the scrim deliberately sits UNDER the drawer panel, so Playwright's actionability check
    // sees the drawer over part of it. The click lands on the scrim's own exposed area either way;
    // what this leg asserts is that clicking the scrim dismisses, not where a pointer may travel.
    await scrim.click({ position: { x: 380, y: 600 }, force: true });
    await expectClosedAndRefocused("the scrim");
  });

  test("switch ON at 420px: the deepest crumb is not truncated and the leave button yields the room", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const project = await seedNarrowProject(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.setViewportSize(NARROW);
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-shell")).toBeVisible();
    // The trail must actually name this project before its width means anything — a crumb row that is
    // still one segment long would pass a truncation check for the wrong reason.
    await expect(page.getByTestId("atlas-breadcrumb")).toContainText(project.name);

    const crumbs = await page.getByTestId("atlas-breadcrumb").evaluate((nav) =>
      [...nav.querySelectorAll("li")].map((li) => {
        const span = li.querySelector("span:last-child") as HTMLElement;
        return { text: (span.textContent ?? "").trim(), scrollWidth: span.scrollWidth, clientWidth: span.clientWidth };
      }));
    expect(crumbs.length, "the project node's trail is Workspace / <project>").toBeGreaterThanOrEqual(2);

    const deepest = crumbs[crumbs.length - 1];
    if (!deepest) throw new Error("the crumb trail rendered no segments");
    expect(deepest.text, "the deepest crumb is the node this address is").toBe(project.name);
    expect(deepest.scrollWidth,
      `the deepest crumb is not truncated at 420px (rendered ${deepest.scrollWidth} in ${deepest.clientWidth})`)
      .toBeLessThanOrEqual(deepest.clientWidth);
    // A FLOOR on the room it was actually given, not just "it happened to fit": a future control added
    // to this row could shrink the crumb to a few characters and still satisfy the check above once
    // `scrollWidth` collapsed with it. 60px is well under the 12-character label's own ~83px and well
    // over the 17px the gap audit measured the ancestors squeezed to.
    expect(deepest.clientWidth, "the deepest crumb keeps real width, not a few characters").toBeGreaterThan(60);

    // ⭐ THE DISCRIMINATING CLAIM, and the reason the check above is not left to stand alone. MEASURED
    // against the pre-fix build: the deepest crumb was ALREADY untruncated there (83px of 83px) — the
    // lopsided shrink of decision 1d3192dc was doing its job and handing the width to the last segment.
    // What the old row could not do was fit the trail AT ALL: "Workspace" was squeezed to 23px of the
    // 62 it needs. So the DoD's own wording passes on both builds for a label this length, and only the
    // ANCESTORS discriminate.
    //
    // ⚠️ SCOPED TO THIS ADDRESS ON PURPOSE. "No crumb is truncated" is NOT a general invariant and must
    // never be widened into one: a four-segment session address at 420px legitimately ellipsises its
    // ancestors, which is exactly what decision 1d3192dc chose. The claim here is narrower and true —
    // the project node's two-segment trail fits the row this card freed up.
    const squeezed = crumbs.filter((c) => c.scrollWidth > c.clientWidth);
    expect(squeezed, "every segment of the project node's own 2-crumb trail fits at 420px").toEqual([]);

    // WHY the room exists — the crumb half of superseded card 9477a5ed. The full wording is ~110px of
    // this row; this card took it down to "Classic", and card 9477a5ed then took the remaining ~83px
    // by dropping the word entirely below the breakpoint — a four-segment session address needs it
    // (see e2e/atlas-crumb-collapse.spec.ts). The accessible name is the SAME at every width either
    // way, which is the half of the claim that matters and the half neither card moved.
    const leave = page.getByTestId("atlas-leave");
    await expect(leave).toBeVisible();
    await expect(leave).toHaveAccessibleName("Switch to the classic UI");
    const labels = await leave.evaluate((el) => ({
      full: getComputedStyle(el.querySelector(".loom-atlas-leave-full")!).display,
      short: getComputedStyle(el.querySelector(".loom-atlas-leave-short")!).display,
      icon: getComputedStyle(el.querySelector(".loom-atlas-leave-icon")!).display,
    }));
    expect(labels, "at 420px the leave button renders neither wording, only its icon")
      .toEqual({ full: "none", short: "none", icon: "block" });
    // And the room is real, not just the absence of a label: a 34px square, the same as the drawer
    // toggle at the other end of the row, against the ~155px the full wording takes.
    expect(Math.round((await leave.boundingBox())!.width),
      "the narrow leave button is the drawer toggle's own 34px square").toBe(34);
  });

  test("switch ON at 420px: a tree row navigates and closes the drawer, and a typed draft survives", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const project = await seedNarrowProject(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.setViewportSize(NARROW);
    await page.goto(loomDaemon.baseURL + "/board");
    await expect(page.getByTestId("atlas-shell")).toBeVisible();

    // ── The owner rule, measured behaviourally: type into the PAGE, then cycle the drawer over it.
    const search = page.getByPlaceholder(BOARD_SEARCH);
    await expect(search).toBeVisible();
    await search.fill(DRAFT);
    await expect(search).toHaveValue(DRAFT);

    const toggle = page.getByTestId("atlas-tree-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    // The page's own input is still MOUNTED and still holds the draft while the drawer stands over it —
    // an unmount-and-remount drawer would have blanked it here, not on the way back out.
    await expect(search).toHaveValue(DRAFT);
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(search, "a drawer open/close cycle never touches a page draft").toHaveValue(DRAFT);

    // ── A tree row NAVIGATES and closes. Opening a BRANCH must not, which is the other half of the
    //    same handler: card 0d0c6cee's split only means anything if a reader can look before committing.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const twist = page.getByTestId(`atlas-project-twist-${project.id}`);
    await expect(twist).toBeVisible();
    await twist.click();
    await expect(page.locator(".loom-atlas-tree"),
      "collapsing a branch is not navigation — the drawer stays open").toBeVisible();
    await twist.click();

    // Then a real destination row. Read off the RENDERED tree rather than naming a path: which rows the
    // project tier carries is nav.tsx's call, and a name typed here drifts the moment a card moves one.
    const rows = page.locator('.loom-atlas-tree a.loom-atlas-node:not([data-atlas-entity])');
    const targetHref = await rows.evaluateAll((els) => {
      const here = window.location.pathname;
      const hit = els.map((e) => (e as HTMLAnchorElement).getAttribute("href") ?? "")
        .find((h) => h.startsWith("/") && !h.includes("?") && h !== here);
      return hit ?? "";
    });
    expect(targetHref, "the tree offers a destination other than the one we are on").not.toBe("");

    await page.locator(`.loom-atlas-tree a.loom-atlas-node[href="${targetHref}"]`).click();
    await expect(page, "the row LANDED, not merely closed the drawer").toHaveURL(new RegExp(`${targetHref.replace(/\//g, "\\/")}(\\?|$)`));
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".loom-atlas-tree"), "navigating via a tree row closes the drawer").toBeHidden();
  });

  test("switch ON at 1440px: the tree is still a persistent rail and the drawer never appears", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const project = await seedNarrowProject(loomDaemon);
    await seedAtlasOn(page);
    await pinProject(page, project.id);
    await page.setViewportSize(WIDE);
    await page.goto(loomDaemon.baseURL + "/project");
    await expect(page.getByTestId("atlas-shell")).toBeVisible();

    const tree = await treeBox(page);
    expect(tree.position, "the wide tree is a column of the frame's grid, not an overlay").toBe("static");
    expect(tree.visibility, "the wide tree is always visible").toBe("visible");
    expect(tree.box.top, "the rail starts at the top of the frame").toBeLessThanOrEqual(1);
    // 244px is `--loom-atlas-tree-w`; read it back off the custom property so this cannot drift from
    // the token, rather than restating the number.
    const railWidth = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--loom-atlas-tree-w").trim());
    expect(`${Math.round(tree.box.width)}px`, "the rail is the declared tree width").toBe(railWidth);

    // The drawer's whole apparatus is inert here. The toggle is ATTACHED but not displayed, which is
    // the honest assertion — it is one element rendered at every width, hidden by one CSS rule.
    await expect(page.getByTestId("atlas-tree-toggle")).toBeAttached();
    await expect(page.getByTestId("atlas-tree-toggle")).toBeHidden();
    await expect(page.getByTestId("atlas-tree-scrim")).toHaveCount(0);
    // And the leave button is back to its full wording.
    const labels = await page.getByTestId("atlas-leave").evaluate((el) => ({
      full: getComputedStyle(el.querySelector(".loom-atlas-leave-full")!).display,
      short: getComputedStyle(el.querySelector(".loom-atlas-leave-short")!).display,
    }));
    expect(labels, "at 1440px the leave button renders its full wording").toEqual({ full: "inline", short: "none" });
  });

  test("switch OFF at 420px: the classic Instrument Rail's own narrow behaviour is unchanged", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const project = await seedNarrowProject(loomDaemon);
    await pinProject(page, project.id);
    await page.setViewportSize(NARROW);
    await page.goto(loomDaemon.baseURL + "/board");

    // POSITIVE ANCHOR FIRST — an absence read inside a shell that never mounted passes for the wrong
    // reason and reads identically to a real absence.
    const rail = page.locator(".loom-rail");
    await expect(rail).toBeVisible();

    // The rail is what it has always been at every width: a fixed 60px gutter that expands on hover.
    // There is no narrow-specific rail rule in global.css, and this card added none — both widths are
    // read off the SAME `--loom-rail-w` token the stylesheet declares, never a number typed here.
    const railGeom = await rail.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { position: cs.position, left: el.getBoundingClientRect().left, width: Math.round(el.getBoundingClientRect().width) };
    });
    const railToken = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--loom-rail-w").trim());
    expect(railGeom.position, "the classic rail is still fixed at 420px").toBe("fixed");
    expect(railGeom.left, "the classic rail is still flush left").toBe(0);
    expect(`${railGeom.width}px`, "the classic rail is still the collapsed gutter width").toBe(railToken);
    expect(await page.locator(".loom-railgutter").evaluate((el) => Math.round(el.getBoundingClientRect().width)))
      .toBe(parseInt(railToken, 10));

    // And none of this card's machinery exists in the classic shell at all. Here `toHaveCount(0)` IS
    // the right assertion — unlike under Atlas, where the tree is always in the document.
    await expect(page.getByTestId("atlas-shell")).toHaveCount(0);
    await expect(page.locator(".loom-atlas-tree")).toHaveCount(0);
    await expect(page.getByTestId("atlas-tree-toggle")).toHaveCount(0);
    await expect(page.getByTestId("atlas-tree-scrim")).toHaveCount(0);
    await expect(page.locator(".loom-atlas-leave-short")).toHaveCount(0);

    // The classic board still works at this width — the shell this card did not touch still renders
    // its own page, draft box and all.
    await expect(page.getByPlaceholder(BOARD_SEARCH)).toBeVisible();
  });
});
