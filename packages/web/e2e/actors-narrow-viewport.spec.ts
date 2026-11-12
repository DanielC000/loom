// Actors narrow-viewport spec (card a9476319) — /actors must not scroll sideways on a phone.
//
// THE DEFECT this locks down, as measured at 390px in the old classic shell (where the content box was 290px):
//   1. Profiles and Skills share one list→editor shell, written inline as `300px 1fr`. The fixed 300px
//      track is wider than the whole box before the editor gets a pixel, and a fixed track list never
//      reduces its column count.
//   2. `1fr` floors at its content's min-content width under the grid item's default `min-width: auto`,
//      so the editor track resolved to 334px instead of dividing what was left. Document scrollWidth
//      went to 730px = 300 + 16 gap + 334 — and 334 was itself set by the editor's OWN inline `1fr 90px`
//      Name/Icon grid, whose <input>s carry the same intrinsic-width floor (the defect
//      settings-narrow-viewport.spec.ts documents for `.loom-field-grid`).
//   3. Under those, the capability rows' name+badge cluster was a nowrap flex row with no `min-width: 0`,
//      holding 302px inside a 264px panel.
// Fixed in `.loom-actor-split` + `.loom-field-grid-trail` (styles/global.css) and a wrap/min-width pair
// on the capability row (pages/Profiles.tsx).
//
// ⚠️ MEASURE PER BOX, NEVER THE PAGE. A page-level `documentElement.scrollWidth > clientWidth` reading
// was diagnostic in the old classic shell (730 vs 390 pre-fix) but is NON-DIAGNOSTIC under Atlas:
// `.loom-atlas-content` scrolls, so the same broken layout reads a clean 390 vs 390 while its own box
// overflows by 300px. Every assertion here therefore measures PER-BOX fit inside the Actors subtree, and
// one test pins the page reading's blindness so nobody swaps it back in.
//
// INSTRUMENT + CONTROL. Every assertion here is that something is ABSENT, and a broken query returns
// zero exactly like a real fix does — so each measurement is first run against a KNOWN-BAD state at the
// same viewport on the same page (an over-wide element injected, then removed). Only then does a zero
// reading mean anything. Same discipline (and the same reason) as settings-narrow-viewport.spec.ts.
import { expect, test, type Page } from "./fixtures/daemon";
import { openNodeTab } from "./helpers/nodeTabs";

const PHONE = { width: 390, height: 900 };
const DESKTOP = { width: 1280, height: 900 };

// Sub-pixel layout rounding can leave a fraction of a pixel on a page that visually does not scroll.
// 1px is the tolerance for that, not slack for a real overflow — the defect was 340px.
const TOLERANCE_PX = 1;

// A bundled profile that every fresh daemon seeds. Selecting one is load-bearing, not decoration: the
// editor is where two of the three defects lived, and an unselected /actors never mounts it.
const SEEDED_PROFILE = "Orchestrator";

// ── Instruments ────────────────────────────────────────────────────────────────────────────────

type PageOverflow = { viewport: number; overflow: number; offenderCount: number; offenders: string[] };

/** Page-level horizontal overflow, plus WHICH elements cross the right edge. Kept only for the
 *  blindness test below: under Atlas this reading cannot see an overflowing box. */
async function measurePageOverflow(page: Page): Promise<PageOverflow> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const viewport = doc.clientWidth;
    const offenders: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (Math.round(r.right) <= viewport + 1) continue;
      const cls = typeof el.className === "string" && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
      offenders.push(`<${el.tagName.toLowerCase()}${cls}> right=${Math.round(r.right)} "${text}"`);
    }
    return {
      viewport,
      overflow: Math.round(doc.scrollWidth - viewport),
      offenderCount: offenders.length,
      offenders: offenders.slice(0, 8),
    };
  });
}

type BoxOverflow = { boxes: number; offenderCount: number; offenders: string[] };

/** BOTH shells: every box inside the Actors subtree that overflows its OWN content box while its own
 *  `overflow-x` is `visible` — i.e. content spilling out rather than being deliberately scrolled. A box
 *  that sets its own `overflow-x` (a diff `<pre>`, a scrollable list) is excluded by the test itself,
 *  since scrolling there is the design. Scoped to the Actors subtree deliberately: the classic nav rail
 *  carries its own pre-existing ~3px self-overflows at EVERY width (1280 included), which are clipped by
 *  an ancestor and never reach the page — sweeping the whole document would import that unrelated noise. */
async function measureBoxOverflow(page: Page): Promise<BoxOverflow> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="actors"]');
    if (!root) throw new Error('no [data-testid="actors"] root on the page');
    const all = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
    const offenders: string[] = [];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (getComputedStyle(el).overflowX !== "visible") continue;
      const over = el.scrollWidth - el.clientWidth;
      if (over <= 1) continue;
      const cls = typeof el.className === "string" && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
      offenders.push(`<${el.tagName.toLowerCase()}${cls}> ${el.scrollWidth} in ${el.clientWidth} (+${over}) "${text}"`);
    }
    return { boxes: all.length, offenderCount: offenders.length, offenders: offenders.slice(0, 8) };
  });
}

function reportPage(where: string, m: PageOverflow): string {
  return `${where} @${m.viewport}px: page overflow=${m.overflow}px, ${m.offenderCount} element(s) past the right edge\n  ${m.offenders.join("\n  ")}`;
}

function reportBox(where: string, m: BoxOverflow): string {
  return `${where}: ${m.offenderCount} of ${m.boxes} box(es) in the Actors subtree overflow their own content box\n  ${m.offenders.join("\n  ")}`;
}

// ── Controls ───────────────────────────────────────────────────────────────────────────────────
// Injects an over-wide element inside the Actors root, re-reads, and removes it: the subtree census must
// see a box INSIDE the Actors root fail to contain its content before a zero reading means anything.

const CONTROL_WIDTH = 3000;

async function assertBoxInstrumentFires(page: Page): Promise<void> {
  await page.evaluate((w) => {
    const root = document.querySelector('[data-testid="actors"]');
    if (!root) throw new Error("no Actors root to attach the control to");
    // A wide child inside a normal-width wrapper: the WRAPPER is what the census must catch, which is
    // exactly the shape of the real defect (a track list floored wider than the box holding it).
    const wrap = document.createElement("div");
    wrap.id = "loom-actors-box-control";
    wrap.style.cssText = "display:flex;overflow-x:visible";
    const wide = document.createElement("div");
    wide.style.cssText = `width:${w}px;height:2px;flex:none`;
    wrap.appendChild(wide);
    root.appendChild(wrap);
  }, CONTROL_WIDTH);
  const fired = await measureBoxOverflow(page);
  await page.evaluate(() => document.getElementById("loom-actors-box-control")?.remove());
  expect(fired.offenderCount, `subtree control did not register — ${reportBox("control", fired)}`).toBeGreaterThan(0);
}

// ── Navigation ─────────────────────────────────────────────────────────────────────────────────

const PROFILES_BODY = /Reusable, cross-project rig/;

/** Open the Profiles body with a profile SELECTED, and assert the fixture is the one we think it is:
 *  the named bundled profile really is in this daemon's list, and its editor really did mount (the
 *  editor's own Delete affordance, which only the mounted editor renders). Without this a silent
 *  fallback to an unseeded daemon would measure an empty editor and pass for the wrong reason. */
async function openProfileEditor(page: Page): Promise<void> {
  await expect(page.getByText(PROFILES_BODY)).toBeVisible();
  const row = page.getByRole("button").filter({ hasText: SEEDED_PROFILE }).first();
  await expect(row, `the seeded "${SEEDED_PROFILE}" profile is not in this daemon's list`).toBeVisible();
  await row.click();
  const scope = page.getByTestId("actors");
  await expect(scope.getByRole("button", { name: "Delete", exact: true }),
    `the ${SEEDED_PROFILE} editor did not mount`).toBeVisible();
  await expect(scope.getByText(SEEDED_PROFILE).first()).toBeVisible();
  // ⚠️ The capabilities list arrives on its OWN query, after the editor shell. Waiting only for the
  // shell measures a half-populated editor — and the capability rows are one of the three places this
  // card's defect lived, so a reading taken before they land comes back green for the wrong reason
  // (verified: with this wait removed, a deliberately re-broken capability row measured 0 here while a
  // direct census of the same page saw it at 302px in a 264px panel). Keyed on a seeded capability's
  // own badge, which doubles as the fixture-identity check for this part of the editor.
  // Since eae230d9 the Profiles editor lists only the two BUILTIN capabilities (registry capabilities
  // are granted per AGENT), so the key is the document-conversion row's network badge (python-venv).
  await expect(scope.getByTestId("capability-network-document-conversion"),
    "the document-conversion capability row has not rendered — the editor is only half populated")
    .toBeVisible();
}

async function openAtlasActors(page: Page, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/home`);
  await openNodeTab(page, "actors");
  await expect(page.getByTestId("actors")).toBeVisible();
}

// ── Atlas @390 ─────────────────────────────────────────────────────────────────────────────────

test.describe("Actors narrow viewport (card a9476319)", () => {
  test.use({ viewport: PHONE });

  test("the Skills editor does not overflow at 390px", async ({ page, loomDaemon }) => {
    // `/actors?tab=skills` is a re-homed address: it lands on the Workspace node's Actors tab, Skills sub-tab.
    await page.goto(`${loomDaemon.baseURL}/actors?tab=skills`);
    await expect(page.getByTestId("actors")).toBeVisible();
    // Identity: a bundled skill this daemon really seeds, with its editor really mounted.
    const row = page.getByRole("button").filter({ hasText: "loom-pickup" }).first();
    await expect(row, "the seeded loom-pickup skill is not in this daemon's list").toBeVisible();
    await row.click();
    await expect(page.getByText("· SKILL.md", { exact: false })).toBeVisible();

    await assertBoxInstrumentFires(page);

    const boxM = await measureBoxOverflow(page);
    expect(boxM.offenderCount, reportBox("/actors?tab=skills", boxM)).toBe(0);
  });

  // Not overflowing is only half of it — a collapsed column must still be USABLE. A render-only check
  // passes on a field squeezed to a sliver. Type into the Name field and require an observable state
  // change (the value lands AND the editor's dirty indicator appears). Nothing is saved.
  test("the collapsed editor is still usable at 390px", async ({ page, loomDaemon }) => {
    await openAtlasActors(page, loomDaemon.baseURL);
    await openProfileEditor(page);

    const scope = page.getByTestId("actors");
    const name = scope.locator(`label:has(> span:text-is("Name"))`).locator("input");
    const box = await name.boundingBox();
    expect(box, "the Name field has no layout box at 390px").not.toBeNull();
    expect(box!.width, `the Name field is only ${box!.width}px wide at 390px`).toBeGreaterThan(140);

    // The editor's own dirty pair (Profiles.tsx): clean has Save disabled and no Reset (and no "saved"
    // either: nothing has been saved yet, card f58b1250); dirty shows a Reset button and enables Save.
    // Asserting BOTH sides of the swap, rather than one of them, is what makes this a real before/after
    // rather than a render check.
    const saved = scope.getByText("saved", { exact: true });
    const reset = scope.getByRole("button", { name: "Reset", exact: true });
    const save = scope.getByRole("button", { name: "Save", exact: true });
    await expect(saved).toHaveCount(0);
    await expect(reset).toHaveCount(0);
    await expect(save).toBeDisabled();

    await name.fill(`${SEEDED_PROFILE}-narrow`);
    await expect(name).toHaveValue(`${SEEDED_PROFILE}-narrow`);
    await expect(reset).toHaveCount(1);
    await expect(saved).toHaveCount(0);
    await expect(save).toBeEnabled();
  });

  // The per-box leg (see the header): the page reading is green whatever the layout does, because
  // `.loom-atlas-content` scrolls, so this census is what covers the Profiles editor.
  test("no box in the Actors subtree overflows at 390px", async ({ page, loomDaemon }) => {
    await openAtlasActors(page, loomDaemon.baseURL);
    await openProfileEditor(page);

    await assertBoxInstrumentFires(page);

    const boxM = await measureBoxOverflow(page);
    expect(boxM.boxes, "the Actors subtree is suspiciously small — did the body mount?").toBeGreaterThan(50);
    expect(boxM.offenderCount, reportBox("/home?tab=actors (Profiles editor)", boxM)).toBe(0);
  });

  // The claim the page-level reading CANNOT make under Atlas, stated as its own assertion so a future
  // reader can see why the leg above is shaped the way it is: this reading is green here either way.
  test("the page-level reading is non-diagnostic (it is green regardless)", async ({ page, loomDaemon }) => {
    await openAtlasActors(page, loomDaemon.baseURL);
    await openProfileEditor(page);

    // Inject an over-wide box INSIDE the Atlas content scroller: a real 3000px overflow that the page
    // reading still cannot see, because an ancestor scrolls it. This is the positive control inverted —
    // it proves the page instrument is BLIND here, which is the justification for the per-box leg.
    await page.evaluate((w) => {
      const root = document.querySelector('[data-testid="actors"]');
      if (!root) throw new Error("no Actors root");
      const wide = document.createElement("div");
      wide.id = "loom-atlas-blindness-probe";
      wide.style.cssText = `width:${w}px;height:2px`;
      root.appendChild(wide);
    }, CONTROL_WIDTH);

    const blind = await measurePageOverflow(page);
    const seen = await measureBoxOverflow(page);
    await page.evaluate(() => document.getElementById("loom-atlas-blindness-probe")?.remove());

    expect(blind.overflow, `the page reading saw a 3000px box under Atlas — ${reportPage("atlas", blind)}`)
      .toBeLessThanOrEqual(TOLERANCE_PX);
    expect(seen.offenderCount, `the per-box census missed the same 3000px box — ${reportBox("atlas", seen)}`)
      .toBeGreaterThan(0);
  });
});

// ── Desktop non-regression ─────────────────────────────────────────────────────────────────────

test.describe("Actors wide viewport is not regressed (card a9476319)", () => {
  test.use({ viewport: DESKTOP });

  // The narrow fix must not fold desktop into one column. Witness: the list and the editor share a row
  // (equal `top`, list left of editor) — true of the two-column shell, false of a collapsed one — and
  // the list keeps its 300px track. Asserted from rendered geometry, not from the CSS.
  test("keeps the list beside the editor at 1280px, and still does not overflow", async ({ page, loomDaemon }) => {
    await openAtlasActors(page, loomDaemon.baseURL);
    await openProfileEditor(page);

    const panes = page.locator(".loom-actor-split > *");
    await expect(panes, "the Actors shell should have exactly two panes").toHaveCount(2);
    const list = await panes.nth(0).boundingBox();
    const editor = await panes.nth(1).boundingBox();
    if (!list || !editor) throw new Error("an Actors pane has no layout box at 1280px");

    expect(Math.round(list.y), `panes are stacked (tops ${list.y} / ${editor.y}) — the shell folded at 1280px`)
      .toBe(Math.round(editor.y));
    expect(list.x, "the list is not left of the editor").toBeLessThan(editor.x);
    expect(Math.round(list.width), "the list pane lost its 300px track").toBe(300);

    await assertBoxInstrumentFires(page);
    const boxM = await measureBoxOverflow(page);
    expect(boxM.offenderCount, reportBox("/actors @1280", boxM)).toBe(0);
  });
});
