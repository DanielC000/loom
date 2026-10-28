// The Atlas crumb trail at phone width — card 9477a5ed, the crumb half of the backlog card card
// 49e883a9 superseded. Record: docs/decisions/9477a5ed-atlas-crumb-collapse-at-narrow-widths.md.
//
// Decision 1d3192dc's lopsided shrink decides how a DEFICIT is shared out, and it still does. What
// it cannot do is help once the deficit exceeds the row: measured on the pre-change build, a session
// address at 420px gave its four labels 184px between them and the project crumb painted its
// separator and ZERO characters. So the segment COUNT comes down below the narrow breakpoint and the
// leading ancestors move behind a disclosure.
//
// ⚠️ The DoD clause this card was re-scoped around — "the deepest crumb is not truncated" — is
// NON-DISCRIMINATING here and is deliberately NOT the claim under test: 1d3192dc already made it
// true on the pre-change build (the deepest crumb rendered whole while its ancestors went to one
// character and none). What discriminates is the width the ANCESTORS and the SESSION crumb are left
// with, so that is what is measured.
import { expect, test, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported for the same reason every sibling atlas spec hardcodes them: the
// e2e tsconfig covers `e2e/` only, so a spec cannot pull a `src/` module in.
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";
const NARROW = { width: 420, height: 900 };

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

/**
 * Every crumb `<li>`, in trail order, with the geometry of its own label span.
 *
 * `rendered` is read off the computed `display`, NOT off the box: a collapsed segment is
 * `display: none`, whose box is 0×0 — and a 0-width box satisfies `scrollWidth > clientWidth` as
 * `false`, i.e. "not clipped", which is exactly the vacuous green this helper exists to keep out of
 * the assertions below.
 */
async function crumbBoxes(page: Page) {
  return page.getByTestId("atlas-breadcrumb").locator("ol > li").evaluateAll((lis) =>
    lis.map((li) => {
      const spans = Array.from(li.querySelectorAll("span")).filter((s) => !s.hasAttribute("aria-hidden"));
      const el = spans[spans.length - 1] as HTMLElement;
      return {
        text: (el.textContent ?? "").trim(),
        rendered: getComputedStyle(li).display !== "none",
        width: Math.round(el.getBoundingClientRect().width),
        clipped: el.scrollWidth > el.clientWidth,
      };
    }),
  );
}

// A session address is the four-segment case: Workspace / <project> / <session> / <tab>.
async function seedSessionAddress(loomDaemon: {
  seedLiveSession: (o: Record<string, unknown>) => Promise<{
    project: unknown; projectId: string; sessionId: string;
  }>;
}) {
  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "CrumbMgr" });
  const worker = await loomDaemon.seedLiveSession({
    project: mgr.project, role: "worker", agentName: "CrumbWorkerWithALongishName",
    id: `e2e-crumb-${Date.now()}`,
    parentSessionId: mgr.sessionId, branch: "loom/atlas-crumb-collapse",
  });
  return { projectId: mgr.projectId, workerId: worker.sessionId };
}

test.describe("Atlas crumb trail at 420px (card 9477a5ed)", () => {
  test("a four-segment session address collapses its ancestors and keeps what it renders legible",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const { projectId, workerId } = await seedSessionAddress(loomDaemon);
      await pinProject(page, projectId);
      await seedAtlasOn(page);
      await page.setViewportSize(NARROW);
      await page.goto(`${loomDaemon.baseURL}/review/${workerId}`);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();

      // POSITIVE ANCHOR FIRST: this address really is the four-segment case. Every claim below is
      // about what a FOUR-crumb trail does, and on a shorter trail they would all pass for the wrong
      // reason — the collapse is declared inert below three segments.
      const all = await crumbBoxes(page);
      expect(all.length, "the session address is the four-segment trail this card is about").toBe(4);

      const shown = all.filter((c) => c.rendered);
      expect(shown.map((c) => c.text),
        "the deepest two segments render: the session and the tab within it")
        .toEqual(all.slice(2).map((c) => c.text));
      expect(all.slice(0, 2).every((c) => !c.rendered),
        "the leading ancestors are collapsed, not merely narrowed").toBe(true);

      // ⭐ THE CLAIM THE DoD ASKS FOR, and the reason a bare "is it clipped" read is not enough: a
      // collapsed segment reads as UNCLIPPED. ~3 characters of the 11.5px mono face is ~21px, and
      // this asserts well above it — the point is that each rendered segment keeps REAL width, not
      // that it technically painted something.
      for (const c of shown) {
        expect(c.width, `the rendered crumb "${c.text}" kept real width at 420px`).toBeGreaterThan(25);
      }
      // The deepest is the tab, in full — the segment 1d3192dc protects, still protected.
      expect(shown.at(-1)?.text, "the deepest crumb is the tab this address is").toBe("Diff");
      expect(shown.at(-1)?.clipped, "the deepest crumb is not clipped").toBe(false);

      // ⭐ THE DISCRIMINATING MEASURE. MEASURED on the pre-change build at this width: the session
      // crumb had 89px. Collapsing the two ancestors and shrinking the leave button to an icon is
      // what buys it back, and this is the only assertion here that the pre-change build fails on a
      // rendered segment (the two above it fail on `rendered` instead).
      const sessionCrumb = shown[0];
      if (!sessionCrumb) throw new Error("the collapsed trail rendered no segments");
      expect(sessionCrumb.width,
        `the session crumb is wider than the 89px the four-segment row left it (got ${sessionCrumb.width})`)
        .toBeGreaterThan(110);
    });

  test("the collapsed ancestors sit behind one accessible control, which reveals them in place",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const { projectId, workerId } = await seedSessionAddress(loomDaemon);
      await pinProject(page, projectId);
      await seedAtlasOn(page);
      await page.setViewportSize(NARROW);
      await page.goto(`${loomDaemon.baseURL}/review/${workerId}`);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();

      const more = page.getByTestId("atlas-crumb-more");
      await expect(more).toBeVisible();
      // The name is deliberately GENERIC and does not carry the project or session name — a name
      // that did would be one more live page-wide text match for an unrelated spec's by-name locator
      // (the collision card c6160c7d hit). It is also stable across the open/closed pair in the one
      // way that matters: it never depends on viewport width.
      await expect(more).toHaveAccessibleName("Show the full path");
      await expect(more).toHaveAttribute("aria-expanded", "false");
      // It really controls the trail, rather than being a button that happens to sit beside it.
      const listId = await more.getAttribute("aria-controls");
      expect(listId, "the disclosure names the list it controls").toBeTruthy();
      await expect(page.getByTestId("atlas-breadcrumb").locator("ol")).toHaveAttribute("id", listId!);

      await more.click();
      await expect(more).toHaveAttribute("aria-expanded", "true");
      await expect(more).toHaveAccessibleName("Hide the full path");

      const expanded = await crumbBoxes(page);
      expect(expanded.every((c) => c.rendered),
        "every segment of the path renders once the control is activated").toBe(true);
      // And they are READABLE, not merely present — the expanded trail wraps rather than squeezing
      // four labels into one line, which is what the row did before this card.
      expect(expanded[0]?.width, "the Workspace crumb reads in full once revealed").toBeGreaterThan(50);
      expect(expanded[1]?.width, "the project crumb reads in full once revealed").toBeGreaterThan(50);

      // Reversible, and the control stays the way back.
      await more.click();
      await expect(more).toHaveAttribute("aria-expanded", "false");
      expect((await crumbBoxes(page)).filter((c) => c.rendered).length,
        "collapsing again restores the two-segment trail").toBe(2);
    });

  test("a trail short enough to fit is untouched at 420px, and so is every trail at 1440px",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const { projectId, workerId } = await seedSessionAddress(loomDaemon);
      await pinProject(page, projectId);
      await seedAtlasOn(page);

      // ── The two-segment project trail, at the width the collapse is active at. ──
      await page.setViewportSize(NARROW);
      await page.goto(`${loomDaemon.baseURL}/project`);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      const project = await crumbBoxes(page);
      expect(project.length, "the project node's trail is Workspace / <project>").toBe(2);
      expect(project.every((c) => c.rendered && !c.clipped),
        `both segments of the 2-crumb trail render in full at 420px: ${JSON.stringify(project)}`).toBe(true);
      // No control at all, rather than a hidden one — it is not rendered below four segments.
      await expect(page.getByTestId("atlas-crumb-more")).toHaveCount(0);

      // ── And the wide shell, which this card does not touch. ──
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${loomDaemon.baseURL}/review/${workerId}`);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      const wide = await crumbBoxes(page);
      expect(wide.length, "the four-segment trail is still four segments at 1440px").toBe(4);
      expect(wide.every((c) => c.rendered),
        "nothing is collapsed above the breakpoint").toBe(true);
      // The disclosure is RENDERED here (the trail is long enough) but display:none — the same
      // honest shape the drawer toggle has at this width, and the reason this is not toHaveCount(0).
      await expect(page.getByTestId("atlas-crumb-more")).toBeAttached();
      await expect(page.getByTestId("atlas-crumb-more")).toBeHidden();
      // The leave button is back to its full wording at this width, and its name never moved.
      const leave = page.getByTestId("atlas-leave");
      await expect(leave).toHaveAccessibleName("Switch to the classic UI");
      expect(await leave.evaluate((el) => ({
        full: getComputedStyle(el.querySelector(".loom-atlas-leave-full")!).display,
        icon: getComputedStyle(el.querySelector(".loom-atlas-leave-icon")!).display,
      })), "at 1440px the leave button is its full wording, not the narrow icon")
        .toEqual({ full: "inline", icon: "none" });
    });

  test("switch OFF at 420px: none of this card's machinery exists in the classic shell",
    async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const { projectId, workerId } = await seedSessionAddress(loomDaemon);
      await pinProject(page, projectId);
      await page.setViewportSize(NARROW);
      await page.goto(`${loomDaemon.baseURL}/review/${workerId}`);

      // POSITIVE ANCHOR FIRST — an absence read inside a shell that never mounted passes for the
      // wrong reason and reads identically to a real absence.
      await expect(page.locator(".loom-rail")).toBeVisible();
      await expect(page.getByTestId("atlas-shell")).toHaveCount(0);

      await expect(page.getByTestId("atlas-breadcrumb")).toHaveCount(0);
      await expect(page.getByTestId("atlas-crumb-more")).toHaveCount(0);
      await expect(page.locator(".loom-atlas-leave-icon")).toHaveCount(0);
    });
});
