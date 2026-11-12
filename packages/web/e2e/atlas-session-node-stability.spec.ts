// The Atlas SESSION NODE holds still — card 4f62b5cb (Atlas audit B: B-01, B-12, B-13, B-16, C-02).
//
//   B-12  the composer sits at ONE y on Terminal, Transcript and Timeline (it used to jump ~290px up on
//         Timeline, whose panel was a 440px-capped box rather than the terminal's own height).
//   B-13  expanding the queue drawer does not move the composer (the pane gives up the queue's height
//         instead of the flowing column pushing the composer below the fold).
//   B-01  at 390px the head's context readout never overlaps a control button.
//   C-02  a busy session's Fork tells a TAP why it won't fork, and the tap forks nothing.
//   B-16  the voice-language picker's label fits its box for a non-curated browser locale.
//
// Every geometric claim carries a positive control that puts the pre-fix shape back on the live page
// and requires the same measure to go RED, so a green is a property of the stylesheet, not of a
// measure that cannot fire.
import { expect, test, type Page } from "./fixtures/daemon";

const PROJECT_KEY = "loom.projectId";

async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([p, id]) => {
    try { localStorage.setItem(p, id); } catch { /* assertions will say so */ }
  }, [PROJECT_KEY, projectId] as const);
}

const tabRow = (page: Page) => page.getByTestId("atlas-node-tabs");
const composerY = async (page: Page) => Math.round((await page.getByTestId("session-node-composer").boundingBox())!.y);

test.describe("Atlas session node stability (card 4f62b5cb)", () => {
  // A touch-capable context, so the Fork leg can tap() the way a phone reader does.
  test.use({ hasTouch: true });

  test("the composer holds one position across tabs and queue expansion", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const mgr = await loomDaemon.seedLiveSession({
      role: "manager", agentName: "StillMgr", id: `e2e-stillmgr-${Date.now()}`,
      ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "ready\r\n",
    });
    // Two HUMAN entries: the first is delivered (arming busy), only the second is held — so the ledger
    // bar renders and has a drawer to open (same shape atlas-session-node.spec.ts documents).
    await loomDaemon.enqueueMessage({ sessionId: mgr.sessionId, text: "first turn (delivers)", source: "human", kind: "agent" });
    const held = await loomDaemon.enqueueMessage({ sessionId: mgr.sessionId, text: "a held queued turn", source: "human", kind: "agent" });
    expect(held.delivered, "fixture precondition: the second enqueue must be HELD").toBe(false);
    await page.setViewportSize({ width: 1440, height: 900 });
    await pinProject(page, mgr.projectId);

    await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);
    await expect(page.getByTestId("session-node-pane-terminal")).toBeVisible();
    await expect(page.getByTestId("queue-ledger-bar")).toBeVisible();
    const onTerminal = await composerY(page);

    await tabRow(page).getByRole("tab", { name: "Transcript" }).click();
    await expect(page.getByTestId("session-node-pane-transcript")).toBeVisible();
    expect(await composerY(page), "the composer moved on the Transcript tab").toBe(onTerminal);

    await tabRow(page).getByRole("tab", { name: "Timeline" }).click();
    const timeline = page.getByTestId("session-node-pane-timeline");
    await expect(timeline).toBeVisible();
    expect(await composerY(page), "the composer moved on the Timeline tab").toBe(onTerminal);

    // POSITIVE CONTROL: the pre-fix timeline (a natural-length box, no pinned height) must move it.
    await timeline.evaluate((el) => { (el as HTMLElement).style.height = "auto"; (el as HTMLElement).style.minHeight = "0"; });
    expect(await composerY(page), "positive control: an unpinned timeline box did not move the composer")
      .not.toBe(onTerminal);

    // B-13 — back on Terminal, open the queue drawer.
    await tabRow(page).getByRole("tab", { name: "Terminal" }).click();
    const pane = page.getByTestId("session-node-pane-terminal");
    await expect(pane).toBeVisible();
    const paneBefore = (await pane.boundingBox())!.height;
    expect(await composerY(page)).toBe(onTerminal);
    await page.getByTestId("queue-ledger-bar").click();
    await expect(page.getByTestId("queue-drawer")).toBeVisible();
    // The drawer really did open and the TERMINAL gave up its height — otherwise "the composer did not
    // move" would hold just as well for a drawer that never grew.
    await expect.poll(async () => (await pane.boundingBox())!.height, { message: "the terminal pane did not shrink for the open drawer" })
      .toBeLessThan(paneBefore - 10);
    await expect.poll(() => composerY(page), { message: "expanding the queue moved the composer" }).toBe(onTerminal);
    const input = (await page.getByTestId("session-node-composer").getByRole("textbox").first().boundingBox())!;
    expect(input.y + input.height, "the composer input is cut off by the viewport").toBeLessThanOrEqual(900);

    // POSITIVE CONTROL: with the pane's pre-fix fixed height restored, the open drawer pushes it down.
    await pane.evaluate((el) => { (el as HTMLElement).style.height = "min(58vh, 640px)"; });
    expect(await composerY(page), "positive control: a fixed-height pane did not let the drawer push the composer")
      .toBeGreaterThan(onTerminal);
  });

  test("at 390px the context readout never overlaps the head's controls", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const mgr = await loomDaemon.seedLiveSession({
      role: "manager", agentName: "NarrowHeadMgr", id: `e2e-narrowhead-${Date.now()}`,
      ctxInputTokens: 182_000, ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "ready\r\n",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await pinProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);
    const head = page.locator(".loom-atlas-nodehead");
    await expect(head.getByText(/182\.0k ctx/)).toBeVisible();
    await expect(head.getByRole("button", { name: "Fork" })).toBeVisible();

    const overlaps = () => page.evaluate(() => {
      const state = document.querySelector('.loom-atlas-nodehead [data-testid="session-node-state"]');
      const buttons = [...document.querySelectorAll(".loom-atlas-nodehead button")];
      const hits: string[] = [];
      for (const leaf of state ? [...state.querySelectorAll("*")].filter((e) => e.children.length === 0) : []) {
        const a = leaf.getBoundingClientRect();
        for (const b of buttons) {
          const c = b.getBoundingClientRect();
          if (a.right > c.left && a.left < c.right && a.bottom > c.top && a.top < c.bottom) hits.push(`${leaf.textContent}×${b.textContent}`);
        }
      }
      return hits;
    });
    expect(await overlaps(), "the state run overlaps a head button at 390px").toEqual([]);
    // The readout is one line, not split across two.
    const readout = head.getByText(/182\.0k ctx/);
    const lineH = await readout.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 16);
    expect((await readout.boundingBox())!.height, "the context readout wrapped").toBeLessThan(lineH * 1.5);

    // POSITIVE CONTROL: force the state run to sit ON the button cluster, as the pre-fix row allowed.
    await head.locator('[data-testid="session-node-state"]').evaluate((el) => {
      const btn = document.querySelector(".loom-atlas-nodehead button")!.getBoundingClientRect();
      const me = el.getBoundingClientRect();
      (el as HTMLElement).style.transform = `translate(${btn.left - me.left}px, ${btn.top - me.top}px)`;
    });
    expect((await overlaps()).length, "positive control: an overlapping state run was not detected").toBeGreaterThan(0);
  });

  test("a busy session's Fork explains itself on a tap and forks nothing", async ({ page, loomDaemon }) => {
    test.setTimeout(180_000);
    const mgr = await loomDaemon.seedLiveSession({
      role: "manager", agentName: "BusyForkMgr", id: `e2e-busyfork-${Date.now()}`, busy: true,
      ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "ready\r\n",
    });
    let forkCalls = 0;
    await page.route("**/api/sessions/*/fork", (route) => { forkCalls += 1; return route.fulfill({ status: 500, json: {} }); });
    await page.setViewportSize({ width: 390, height: 844 });
    await pinProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);

    const fork = page.locator(".loom-atlas-nodehead").getByRole("button", { name: "Fork" });
    await expect(fork).toBeVisible();
    await expect(fork).toHaveAttribute("aria-disabled", "true");
    await expect(fork).toHaveAccessibleDescription("Fork is available when the session is idle.");
    const reason = page.getByTestId("fork-blocked-reason");
    const shown = async () => { const b = await reason.boundingBox(); return !!b && b.width > 2 && b.height > 2; };
    expect(await shown(), "the reason was visible before any tap").toBe(false);

    // A real touch tap, not a click — this is the reader the card is for. `force` because Playwright's
    // own actionability check refuses an aria-disabled target; a finger does not.
    await fork.tap({ force: true });
    await expect.poll(shown, { message: "a tap on a busy Fork showed no reason" }).toBe(true);
    await expect(reason).toHaveText("Fork is available when the session is idle.");
    expect(forkCalls, "tapping a busy Fork issued a fork request").toBe(0);
  });

  test.describe("for a browser locale outside the curated list", () => {
    test.use({ locale: "de" });
    test("the voice-language label fits its picker", async ({ page, loomDaemon }) => {
      test.setTimeout(180_000);
      const s = await loomDaemon.seedLiveSession({
        role: "manager", agentName: "VoiceMgr", id: `e2e-voicelang-${Date.now()}`,
        ptyGeometry: { cols: 80, rows: 24 }, ptyBytes: "ready\r\n",
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await pinProject(page, s.projectId);
      await page.goto(`${loomDaemon.baseURL}/session/${s.sessionId}`);
      const select = page.getByTestId("session-node-composer").getByLabel("Voice recognition language");
      await expect(select, "the voice row did not render — the recognizer is unsupported here").toBeVisible();
      await expect(select.locator("option:checked")).toHaveText("Auto · de");
      // The label's own rendered width against the select's CONTENT box (its padding is where the native
      // chevron sits). Not scrollWidth: once the select clips with an ellipsis, scrollWidth reports the
      // clipped box and reads "fits" for any label — measured, via the control below.
      const fits = () => select.evaluate((el) => {
        const sel = el as HTMLSelectElement;
        const cs = getComputedStyle(sel);
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const text = ctx.measureText(sel.options[sel.selectedIndex]!.text).width;
        const content = sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return parseFloat(cs.paddingRight) >= 16 && text <= content;
      });
      expect(await fits(), "the picker's label overflows its box, or leaves the chevron no room").toBe(true);
      // POSITIVE CONTROL: the pre-fix label overflows the same box.
      await select.evaluate((el) => { (el as HTMLSelectElement).options[(el as HTMLSelectElement).selectedIndex]!.text = "de (browser default)"; });
      expect(await fits(), "positive control: the old long label did not overflow").toBe(false);
    });
  });
});
