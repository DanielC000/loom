// Atlas audit polish, card 1fe4b596 (epic 898a64ef): the type scale and the shared controls.
//
//   A-23  one xs step: no text below 11px and none of the old 10 / 10.5 / 11.5 in-between sizes.
//   A-33  Workspace Settings carries a sticky "On this page" index in its empty right third.
//   A-39  a tab's explainer is folded to one line plus "More", and the toggle really opens it.
//   A-17  Project Settings column rows: every label input ends at one x, and the WIP field does not clip.
//   A-24  a kit Select draws the kit's own chevron instead of the OS one.
//
// The Inbox Waiting/History Segmented (A-24) is exercised by requests-inbox.spec.ts, which drives it as a
// radio group, and the Kill-all confirm's danger fill (A-41) by atlas-fleet-controls.spec.ts, where the
// live workers it needs are already seeded.
import { expect, test, type Page } from "./fixtures/daemon";

// lib/activeProject.tsx owns the project key.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only, so a spec cannot pull `src/` in.
const PROJECT_KEY = "loom.projectId";

async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([projectKey, id]) => {
    try {
      if (localStorage.getItem(projectKey) === null) localStorage.setItem(projectKey, id);
    } catch { /* storage unavailable: the assertions will say so */ }
  }, [PROJECT_KEY, projectId] as const);
}

/** Every distinct computed font size of a VISIBLE text node on the page (terminals excluded). */
async function textSizes(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim();
      const el = n.parentElement;
      if (!text || !el || el.closest(".xterm")) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const size = getComputedStyle(el).fontSize;
      out[size] ??= text.slice(0, 40);
    }
    return out;
  });
}

test.describe("Atlas type scale and shared controls (card 1fe4b596)", () => {
  test("A-23: no text is set below the xs step, and the old in-between sizes are gone", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`type-scale-${Date.now()}`);
    await pinProject(page, project.id);
    for (const where of ["/home", "/home?tab=settings", "/home?tab=automation", "/settings"]) {
      await page.goto(loomDaemon.baseURL + where);
      await expect(page.getByTestId("atlas-shell")).toBeVisible();
      // Presence first: the tree names the seeded project, so the walk below reads a rendered page.
      await expect(page.getByTestId("atlas-tree").getByText(project.name).first()).toBeVisible();
      const sizes = await textSizes(page);
      const px = Object.keys(sizes).map(parseFloat);
      expect(px.length, `${where}: text was measured`).toBeGreaterThan(3);
      const below = Object.entries(sizes).filter(([s]) => parseFloat(s) < 11);
      expect(below, `${where}: text below 11px`).toEqual([]);
      const between = Object.entries(sizes).filter(([s]) => ["10px", "10.5px", "11.5px"].includes(s));
      expect(between, `${where}: an old in-between size`).toEqual([]);
    }
  });

  test("A-33: the Workspace Settings index jumps to a section, marks it, and stays in view", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`settings-index-${Date.now()}`);
    await pinProject(page, project.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${loomDaemon.baseURL}/home?tab=settings`);
    const index = page.getByTestId("settings-index");
    await expect(index).toBeVisible();
    await expect(index.locator("[aria-current]")).toHaveText("Interface");

    const disk = page.getByTestId("settings-section-disk-reclaim");
    await expect(disk).not.toBeInViewport();
    await page.getByTestId("settings-index-disk-reclaim").click();
    await expect(disk).toBeInViewport();
    await expect(index.locator("[aria-current]")).toHaveText("Disk Reclaim");
    // Sticky: after a jump of thousands of pixels the index is still on screen.
    await expect(index).toBeInViewport();

    // Keyboard reaches it too.
    await page.getByTestId("settings-index-interface").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("settings-section-interface")).toBeInViewport();
    await expect(index.locator("[aria-current]")).toHaveText("Interface");

    // Below 1280px there is no spare third: the index is hidden and the page is one column.
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(index).toBeHidden();
  });

  test("A-39: a tab explainer is one line until More opens it, and Less folds it back", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`explainer-${Date.now()}`);
    await pinProject(page, project.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${loomDaemon.baseURL}/home?tab=automation`);
    const text = page.getByText(/^Cron triggers\. On each due boundary/);
    await expect(text).toBeVisible();
    const box = page.locator(".loom-explainer").filter({ has: text });
    const toggle = box.getByRole("button");
    await expect(toggle).toHaveText("More");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const lineHeight = await text.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    const folded = (await text.boundingBox())!.height;
    expect(folded, "folded to one line").toBeLessThanOrEqual(lineHeight + 1);

    await toggle.click();
    await expect(toggle).toHaveText("Less");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect((await text.boundingBox())!.height, "open wraps to more than one line").toBeGreaterThan(lineHeight * 1.5);

    await toggle.click();
    await expect(toggle).toHaveText("More");
    expect((await text.boundingBox())!.height).toBeLessThanOrEqual(lineHeight + 1);
  });

  test("A-17: column rows align whatever their role chip says, and the WIP field does not clip", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`columns-${Date.now()}`);
    await pinProject(page, project.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${loomDaemon.baseURL}/settings`);
    const labels = page.getByRole("textbox", { name: "Column label" });
    await expect(labels.first()).toBeVisible();
    const rights = await labels.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
    expect(rights.length, "the default board has several lanes").toBeGreaterThan(3);
    expect(new Set(rights).size, `label inputs end at one x: ${rights.join(", ")}`).toBe(1);
    const wip = page.getByRole("spinbutton", { name: "WIP limit" }).first();
    const fit = await wip.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth }));
    expect(fit.sw, "the WIP placeholder fits its field").toBeLessThanOrEqual(fit.cw);
  });

  test("A-24: a kit Select draws the kit chevron, not the OS one", async ({ page, loomDaemon }) => {
    const project = await loomDaemon.createProject(`select-${Date.now()}`);
    await pinProject(page, project.id);
    await page.goto(`${loomDaemon.baseURL}/home?tab=usage`);
    const select = page.locator("main select.loom-field").first();
    await expect(select).toBeVisible();
    const style = await select.evaluate((e) => {
      const cs = getComputedStyle(e);
      return { appearance: cs.appearance, image: cs.backgroundImage, padRight: parseFloat(cs.paddingRight) };
    });
    expect(style.appearance).toBe("none");
    expect(style.image).toContain("linear-gradient");
    expect(style.padRight, "room for the chevron").toBeGreaterThanOrEqual(24);
  });
});
