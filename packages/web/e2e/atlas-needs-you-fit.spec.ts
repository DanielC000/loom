// Card 104a31a4 (Atlas audit A-07 / A-03 / A-18): the Workspace band's Needs-you panel.
//
//   A-07 — a row's visible text LEADS with the ask; the routing target lives in the hover title.
//   A-03 — the panel renders only whole rows, then an explicit "+N more in Inbox" link row; the × stays on
//          the head line beside the kind label.
//   A-18 — the band aligns to start, so a quiet panel is shorter than a full Needs-you panel.
//
// Measured, not inferred: every layout claim reads getBoundingClientRect off the real DOM. The shared
// e2e daemon can carry other specs' rows, so the "+N" figure is derived from the panel's OWN count and
// the rows it actually rendered, never from how many this spec seeded.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

async function seedRequests(loomDaemon: LoomDaemon) {
  const short = `f${Math.random().toString(36).slice(2, 9)}`;
  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: `NeedsFit-${short}` });
  const longTitle = `Which ${short} bucket should the nightly export write to before we prune cold snapshots older than ninety days?`;
  const types = ["decision", "input", "permission", "decision", "input", "decision", "permission", "decision", "input", "decision"] as const;
  for (const [i, type] of types.entries()) {
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, type,
      title: i === types.length - 1 ? longTitle : `${short} ask ${i}`,
      ...(type === "decision" ? { options: ["A", "B"] } : {}),
      ...(type === "permission" ? { permissionAction: "git push origin hotfix", permissionScopeHint: "once" as const } : {}),
    });
  }
  return { mgr, short, longTitle };
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="atlas-band-needs"]')!;
    const body = panel.querySelector(".loom-bandbody")!.getBoundingClientRect();
    const rows = Array.from(panel.querySelectorAll<HTMLElement>('[data-testid="attention-row"]')).map((r) => {
      const box = r.getBoundingClientRect();
      const x = r.querySelector('[aria-label="Dismiss this alert"]')!.getBoundingClientRect();
      const k = r.querySelector('[data-testid="attention-row-kind"]')!.getBoundingClientRect();
      return {
        session: r.dataset.sessionId ?? "",
        bottom: box.bottom, right: box.right,
        // The × and the kind label share one line box: their vertical centres agree.
        xOffHead: Math.abs((x.top + x.bottom) / 2 - (k.top + k.bottom) / 2),
        xRight: x.right,
      };
    });
    const more = panel.querySelector<HTMLElement>('[data-testid="attention-more"]');
    const band = document.querySelector('[data-testid="atlas-dashboard-band"]')!;
    return {
      count: Number(panel.querySelector(".loom-bandcount")?.textContent ?? "NaN"),
      body: { bottom: body.bottom, right: body.right },
      rows,
      more: more ? { text: more.textContent ?? "", bottom: more.getBoundingClientRect().bottom, href: more.getAttribute("href") } : null,
      panelHeights: Array.from(band.children).map((p) => (p as HTMLElement).getBoundingClientRect().height),
      scrollOverflow: (() => { const b = panel.querySelector<HTMLElement>(".loom-bandbody")!; return b.scrollHeight - b.clientHeight; })(),
    };
  });
}

test.describe("Atlas Needs-you band: ask first, whole rows, overflow row (card 104a31a4)", () => {
  test("at 1920, 1440, 1024 and 390 the panel shows whole rows only, then '+N more in Inbox'", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    const seeded = await seedRequests(loomDaemon);

    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1024, height: 800 }, { width: 390, height: 844 }] as const) {
      const at = `${viewport.width}x${viewport.height}`;
      await page.setViewportSize(viewport);
      await page.goto(loomDaemon.baseURL + "/home");
      const band = page.getByTestId("atlas-band-needs");
      await expect(band, at).toBeVisible();
      // PRESENCE FIRST, and it is THIS run's row (the shared daemon renders look-alike rows).
      const mine = band.locator(`[data-testid="attention-row"][data-session-id="${seeded.mgr.sessionId}"]`).first();
      await expect(mine, at).toBeVisible();
      const more = band.getByTestId("attention-more");
      await expect(more, at).toBeVisible();

      // Settle: the fit pass runs in a layout effect, and fonts can re-trigger it once. Take the
      // reading until two agree.
      let m = await measure(page);
      await expect.poll(async () => {
        const next = await measure(page);
        const same = next.rows.length === m.rows.length && next.more?.text === m.more?.text;
        m = next;
        return same;
      }, { message: `${at}: band reading settles` }).toBe(true);

      // A-03: every rendered row, and the overflow row, sit wholly inside the body. Nothing scrolls.
      expect(m.rows.length, at).toBeGreaterThanOrEqual(1);
      for (const r of m.rows) {
        expect.soft(r.bottom, `${at}: row bottom vs body bottom ${m.body.bottom}`).toBeLessThanOrEqual(m.body.bottom + 0.5);
        expect.soft(r.xOffHead, `${at}: the × sits on the kind label's line`).toBeLessThan(4);
        expect.soft(r.xRight, `${at}: × right vs body right ${m.body.right}`).toBeLessThanOrEqual(m.body.right + 0.5);
      }
      expect.soft(m.more!.bottom, `${at}: overflow row inside the body`).toBeLessThanOrEqual(m.body.bottom + 0.5);
      expect.soft(m.scrollOverflow, `${at}: nothing hidden behind the body's scroll`).toBeLessThanOrEqual(1);
      // The figure is the panel's own count minus what it rendered: the explicit way to the rest.
      expect(m.more!.text, at).toContain(`+${m.count - m.rows.length} more in Inbox`);
      expect(m.more!.href, at).toBe("/inbox");

      // A-07: this run's newest ask (the long title) LEADS the visible text, and the routing target is
      // in the tooltip, not the line.
      const longRow = band.locator('[data-testid="attention-row-text"]', { hasText: seeded.short }).first();
      await expect(longRow, at).toBeVisible();
      const text = (await longRow.textContent()) ?? "";
      expect(text.startsWith(seeded.longTitle), `${at}: "${text}" leads with the ask`).toBe(true);
      expect(text, at).not.toContain("routed to mgr");
      await expect(longRow, at).toHaveAttribute("title", new RegExp(`routed to mgr ${seeded.mgr.sessionId.slice(0, 8)}`));
      // The ask is READABLE: its own line under the kind label (not squeezed beside it), clamped to two
      // lines, and the long title actually uses both.
      await expect(longRow, at).toHaveCSS("-webkit-line-clamp", "2");
      const ask = await longRow.evaluate((el) => {
        const row = el.closest('[data-testid="attention-row"]')!;
        const k = row.querySelector('[data-testid="attention-row-kind"]')!.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return { top: r.top, kindBottom: k.bottom, width: r.width, height: r.height, lineHeight: parseFloat(getComputedStyle(el).lineHeight) };
      });
      expect.soft(ask.top, `${at}: the ask sits below the kind label`).toBeGreaterThanOrEqual(ask.kindBottom - 0.5);
      // ~240px at 1440 measured; beside the kind label it was ~80px, so 200 discriminates the two shapes.
      expect.soft(ask.width, `${at}: the ask gets a full-width line`).toBeGreaterThan(viewport.width >= 1440 ? 200 : 150);
      expect.soft(Math.round(ask.height / ask.lineHeight), `${at}: the long ask fills two clamped lines`).toBe(2);

      // A-18: on the one-line band, a quiet panel is no longer stretched to Needs-you's height.
      if (viewport.width >= 1440) {
        const [needs = 0, ...others] = m.panelHeights;
        expect.soft(Math.min(...others), `${at}: shortest sibling vs Needs you ${needs}`).toBeLessThan(needs - 40);
      }
    }

    // The overflow row is a real way to the rest: it opens the Inbox.
    await page.getByTestId("atlas-band-needs").getByTestId("attention-more").click();
    await expect(page).toHaveURL(/\/(inbox|home\?tab=inbox)/);
  });

  test("the ⌘K palette leads with the ask and keeps the routing target in the tooltip", async ({ page, loomDaemon }) => {
    const seeded = await seedRequests(loomDaemon);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(loomDaemon.baseURL + "/home");
    await expect(page.getByTestId("atlas-band-needs")).toBeVisible();
    await page.keyboard.press("Control+k");
    const input = page.getByPlaceholder(/Jump to/);
    await expect(input).toBeVisible();
    await input.fill(seeded.short);
    const label = page.locator('[role="option"] span[title]', { hasText: seeded.longTitle }).first();
    await expect(label).toBeVisible();
    const text = (await label.textContent()) ?? "";
    // "<verb> · <Kind> <title> · <project>": the title comes straight after the kind label.
    expect(text).toMatch(new RegExp(`^Answer · \\S+ needed ${seeded.longTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
    await expect(label).toHaveAttribute("title", new RegExp(`routed to mgr ${seeded.mgr.sessionId.slice(0, 8)}`));
  });
});
