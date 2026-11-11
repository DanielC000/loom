// Board keyboard navigation (card 591fe6ed): the lane grid is ONE Tab stop with a roving tabindex. Arrows
// move between cards in a lane (↑/↓) and across lanes (←/→, landing on the nearest card by index, or on the
// lane header when the lane is empty or collapsed); Home/End jump to a lane's first/last card; `n` focuses
// the new-card field. Every behaviour runs on BOTH surfaces that mount the board: the Overview embed (the
// owner's primary board) and /board.
//
// Every assertion reads the live `document.activeElement` (its lane and its `data-board-nav` item), never
// a locator's own idea of focus, so a handler that moved focus to the wrong copy of a card fails.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function pin(page: Page, projectId: string, collapsed: string[] = []) {
  await page.addInitScript(({ id, collapsed }) => {
    localStorage.setItem("loom.projectId", id);
    if (collapsed.length) localStorage.setItem(`loom.board.collapsedLanes.${id}`, JSON.stringify(collapsed));
  }, { id: projectId, collapsed });
}

/** Where focus is: the lane it sits in and its board-nav item id (null when outside the grid). */
const active = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  return {
    lane: el?.closest<HTMLElement>("[data-lane-key]")?.dataset.laneKey ?? null,
    item: el?.dataset.boardNav ?? null,
    testid: el?.dataset.testid ?? null,
  };
});
const expectAt = (page: Page, lane: string, item: string) =>
  expect.poll(() => active(page).then((a) => `${a.lane}/${a.item}`)).toBe(`${lane}/${item}`);
/** A lane's navigable items in render order: "head", its card ids, then "more" when a reveal is shown. */
const laneItems = (page: Page, lane: string) =>
  page.locator(`[data-lane-key="${lane}"] [data-board-nav]`).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.boardNav!));
const cardsOf = (items: string[]) => items.filter((i) => i !== "head" && i !== "more");
/** Every element inside the lane grid a Tab key can stop on. */
const gridTabStops = (page: Page) => page.locator(".loom-board-grid:not(.loom-skeleton)").evaluate((g) =>
  [...g.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")]
    .filter((e) => e.tabIndex >= 0 && !(e as HTMLButtonElement).disabled)
    .map((e) => e.dataset.boardNav ?? e.dataset.testid ?? e.tagName));
const focusStop = (page: Page) => page.locator(".loom-board-grid [data-board-nav][tabindex='0']").focus();
/** Where a Tab out of the grid went (card 78eaac95). `wrapped`: it landed BEFORE the grid in document order
 *  (the Tab cycle wrapped). `isFirstStop`: it is the page's first tabbable. `ring`: it is :focus-visible and
 *  paints the shared ring, a solid 2px outline in --loom-ring (or a field's own --loom-ring border). */
const tabbedOut = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  const grid = document.querySelector(".loom-board-grid")!;
  if (!el || el === document.body) return { tag: "BODY", wrapped: false, isFirstStop: false, ring: false };
  const probe = document.createElement("i");
  probe.style.color = "var(--loom-ring)";
  document.body.appendChild(probe);
  const ringColor = getComputedStyle(probe).color;
  probe.remove();
  const s = getComputedStyle(el);
  const ring = el.matches(":focus-visible") && ((s.outlineStyle === "solid" && s.outlineWidth === "2px" && s.outlineColor === ringColor)
    || (el.classList.contains("loom-field") && s.borderColor === ringColor));
  const first = [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")]
    .find((e) => e.tabIndex >= 0 && !(e as HTMLButtonElement).disabled && e.getClientRects().length > 0);
  return { tag: el.tagName, wrapped: !!(grid.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING), isFirstStop: el === first, ring };
});

async function setParent(baseURL: string, secret: string, taskId: string, parentId: string) {
  const res = await fetch(`${baseURL}/api/tasks/${taskId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ parentId }),
  });
  if (!res.ok) throw new Error(`POST /api/tasks/${taskId} -> ${res.status} ${await res.text()}`);
}

for (const surface of ["/board"] as const) {
  test.describe(`board keyboard navigation on ${surface}`, () => {
    test("one Tab stop; arrows across cards and lanes, Home/End, empty and collapsed lanes", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("kbd-nav"));
      // Inbox: three cards, one of them a CHILD of another (hierarchy must not add a stop or trap focus).
      const parent = await loomDaemon.createTask(project.id, { title: uniq("nav-parent"), columnKey: "inbox" });
      await loomDaemon.createTask(project.id, { title: uniq("nav-sibling"), columnKey: "inbox" });
      const child = await loomDaemon.createTask(project.id, { title: uniq("nav-child"), columnKey: "inbox" });
      await setParent(loomDaemon.baseURL, loomDaemon.loopbackSecret, child.id, parent.id);
      const backlog = await loomDaemon.createTask(project.id, { title: uniq("nav-backlog"), columnKey: "backlog" });
      // todo: empty. in_progress: holds a card but is COLLAPSED, so only its rail is reachable.
      const hiddenInRail = await loomDaemon.createTask(project.id, { title: uniq("nav-collapsed"), columnKey: "in_progress" });
      await loomDaemon.createTask(project.id, { title: uniq("nav-wait-a"), columnKey: "waiting" });
      await loomDaemon.createTask(project.id, { title: uniq("nav-wait-b"), columnKey: "waiting" });
      await pin(page, project.id, ["in_progress"]);
      await page.goto(`${loomDaemon.baseURL}${surface}`);

      // Fixture identity: this is OUR board, with the seeded shape.
      await expect.poll(async () => cardsOf(await laneItems(page, "inbox")).length).toBe(3);
      expect(cardsOf(await laneItems(page, "inbox"))).toContain(child.id);
      expect(await laneItems(page, "backlog")).toEqual(["head", backlog.id]);
      expect(await laneItems(page, "todo")).toEqual(["head"]);
      expect(await laneItems(page, "in_progress")).toEqual(["head"]);
      await expect(page.locator(`[data-board-nav="${hiddenInRail.id}"]`)).toHaveCount(0);
      const inbox = cardsOf(await laneItems(page, "inbox"));
      const waiting = cardsOf(await laneItems(page, "waiting"));
      expect(waiting).toHaveLength(2);
      const pressedBefore = await page.locator("[aria-pressed='true']").count();

      // ONE Tab stop, and by default it is the first lane's first card.
      expect(await gridTabStops(page)).toEqual([inbox[0]]);
      await focusStop(page);
      await expectAt(page, "inbox", inbox[0]!);

      // ↑/↓ within a lane, stopping at the edges; Home/End to its first/last card.
      await page.keyboard.press("ArrowDown"); await expectAt(page, "inbox", inbox[1]!);
      await page.keyboard.press("ArrowDown"); await expectAt(page, "inbox", inbox[2]!);
      await page.keyboard.press("ArrowDown"); await expectAt(page, "inbox", inbox[2]!);
      await page.keyboard.press("ArrowUp"); await expectAt(page, "inbox", inbox[1]!);
      // The Tab stop roves with focus: still exactly one, and it is where we are.
      expect(await gridTabStops(page)).toEqual([inbox[1]]);
      await page.keyboard.press("Home"); await expectAt(page, "inbox", inbox[0]!);
      await page.keyboard.press("End"); await expectAt(page, "inbox", inbox[2]!);
      await page.keyboard.press("Home");
      // ↑ off the first card is the lane header: its ⋯ menu button.
      await page.keyboard.press("ArrowUp"); await expectAt(page, "inbox", "head");
      expect((await active(page)).testid).toBe("lane-menu-button-inbox");
      await expect(page.getByTestId("lane-menu-inbox"), "a plain ↑/↓ on the header no longer opens its menu").toHaveCount(0);
      await page.keyboard.press("ArrowUp"); await expectAt(page, "inbox", "head");
      await page.keyboard.press("ArrowDown"); await expectAt(page, "inbox", inbox[0]!);

      // → from the third card lands on backlog's only card (nearest by index, clamped).
      await page.keyboard.press("End");
      await page.keyboard.press("ArrowRight"); await expectAt(page, "backlog", backlog.id);
      // → into an EMPTY lane lands on its header, and ↓ there goes nowhere.
      await page.keyboard.press("ArrowRight"); await expectAt(page, "todo", "head");
      await page.keyboard.press("ArrowDown"); await expectAt(page, "todo", "head");
      // → into a COLLAPSED lane lands on its rail, and ↑/↓ there go nowhere.
      await page.keyboard.press("ArrowRight"); await expectAt(page, "in_progress", "head");
      expect((await active(page)).testid).toBe("lane-expand-in_progress");
      await page.keyboard.press("ArrowDown"); await expectAt(page, "in_progress", "head");
      // From a header, → goes header to header; then ↓ into that lane's cards.
      await page.keyboard.press("ArrowRight"); await expectAt(page, "waiting", "head");
      await page.keyboard.press("ArrowDown"); await expectAt(page, "waiting", waiting[0]!);
      await page.keyboard.press("ArrowDown"); await expectAt(page, "waiting", waiting[1]!);
      // ← back across the collapsed and empty lanes.
      await page.keyboard.press("ArrowLeft"); await expectAt(page, "in_progress", "head");
      await page.keyboard.press("ArrowLeft"); await expectAt(page, "todo", "head");
      await page.keyboard.press("ArrowLeft"); await expectAt(page, "backlog", "head");
      await page.keyboard.press("ArrowDown"); await expectAt(page, "backlog", backlog.id);
      await page.keyboard.press("ArrowLeft"); await expectAt(page, "inbox", inbox[0]!);
      // ← at the first lane goes nowhere.
      await page.keyboard.press("ArrowLeft"); await expectAt(page, "inbox", inbox[0]!);

      // Tab leaves the grid in one step, onto a real control with a ring, never onto <body> (card 78eaac95:
      // where nothing follows the grid, the browser used to drop focus there, invisibly).
      await page.keyboard.press("Tab");
      await expect.poll(() => active(page).then((a) => a.lane)).toBeNull();
      const out = await tabbedOut(page);
      expect(out.tag, "Tab out of the grid lands on a real control, not <body>").not.toBe("BODY");
      expect(out.ring, "and that control shows the shared ring").toBe(true);
      if (out.wrapped) {
        // Nothing followed the grid: focus went to the page's first stop, the next stop in the Tab cycle.
        expect(out.isFirstStop).toBe(true);
        await focusStop(page);
      } else {
        // A control followed the grid, so Shift+Tab comes straight back to the same card.
        await page.keyboard.press("Shift+Tab");
      }
      await expectAt(page, "inbox", inbox[0]!);

      // None of it touched the filters (decision cea577af) or the lane order.
      await expect(page.getByLabel("Search tasks by id, title, or description")).toHaveValue("");
      await expect(page.locator("[aria-pressed='true']")).toHaveCount(pressedBefore);
      await expect.poll(() => page.locator("[data-lane-key]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.laneKey)))
        .toEqual(["inbox", "backlog", "todo", "in_progress", "waiting", "review", "done"]);
    });

    test("focus returns to the card after its dialog closes, and follows a card moved from the dialog", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("kbd-dialog"));
      await loomDaemon.createTask(project.id, { title: uniq("dlg-a"), columnKey: "inbox" });
      await loomDaemon.createTask(project.id, { title: uniq("dlg-b"), columnKey: "inbox" });
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect.poll(async () => cardsOf(await laneItems(page, "inbox")).length).toBe(2);
      const inbox = cardsOf(await laneItems(page, "inbox"));

      await focusStop(page);
      await page.keyboard.press("ArrowDown"); await expectAt(page, "inbox", inbox[1]!);
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expectAt(page, "inbox", inbox[1]!);

      // Move the card to Backlog from its dialog: on close, the card it was opened from is gone from Inbox,
      // and focus follows the card to its new lane instead of dropping to <body>.
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await page.getByTestId("task-move-lane").selectOption("backlog");
      await expect.poll(async () => laneItems(page, "backlog")).toEqual(["head", inbox[1]]);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expectAt(page, "backlog", inbox[1]!);
      expect(await gridTabStops(page)).toEqual([inbox[1]]);
    });

    test("`n` focuses the new-card field, but never from a field, a dialog or a menu", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("kbd-new"));
      await loomDaemon.createTask(project.id, { title: uniq("new-a"), columnKey: "inbox" });
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect.poll(async () => cardsOf(await laneItems(page, "inbox")).length).toBe(1);
      const newField = page.locator("[data-board-new-task]");
      const isNewField = () => page.evaluate(() => document.activeElement?.hasAttribute("data-board-new-task") ?? false);

      // Positive: from a focused card, `n` lands in the field and types nothing into it.
      await focusStop(page);
      await page.keyboard.press("n");
      await expect.poll(isNewField).toBe(true);
      await expect(newField).toHaveValue("");

      // Typing in another field: the `n` is text, not a shortcut.
      const search = page.getByLabel("Search tasks by id, title, or description");
      await search.focus();
      await page.keyboard.press("n");
      await expect(search).toHaveValue("n");
      await expect(search).toBeFocused();
      expect(await isNewField()).toBe(false);
      await page.keyboard.press("Escape"); // the search box's own clear
      await expect(search).toHaveValue("");

      // A contenteditable region keeps its `n` too.
      await page.evaluate(() => {
        const ed = document.createElement("div");
        ed.contentEditable = "true"; ed.id = "kbd-ce"; document.body.appendChild(ed); ed.focus();
      });
      await page.keyboard.press("n");
      await expect(page.locator("#kbd-ce")).toHaveText("n");
      await expect(page.locator("#kbd-ce")).toBeFocused();
      await page.evaluate(() => document.getElementById("kbd-ce")?.remove());

      // An open card dialog keeps focus.
      await focusStop(page);
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("n");
      expect(await isNewField()).toBe(false);
      await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[role='dialog']"))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      // An open lane menu keeps focus.
      await page.keyboard.press("ArrowUp"); await expectAt(page, "inbox", "head");
      await page.keyboard.press("Enter");
      // Inbox is the first lane, so Move left is disabled and the menu opens on Move right.
      await expect(page.getByTestId("lane-move-right-inbox")).toBeFocused();
      await page.keyboard.press("n");
      await expect(page.getByTestId("lane-menu-inbox")).toBeVisible();
      expect(await isNewField()).toBe(false);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("lane-menu-inbox")).toHaveCount(0);

      // And the control: with nothing open, the same key from the header works again.
      await page.keyboard.press("n");
      await expect.poll(isNewField).toBe(true);
    });

    test("the done lane's window: End stops at the last rendered card, and focus survives 'Show more'", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("kbd-done"));
      for (let i = 0; i < 52; i++) await loomDaemon.createTask(project.id, { title: `fix(daemon): done card ${i}`, columnKey: "done" });
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect.poll(async () => (await laneItems(page, "done")).length).toBe(52); // head + 50 cards + more
      const before = await laneItems(page, "done");
      expect(before.at(-1)).toBe("more");

      // An empty first lane makes its header the default stop.
      expect(await gridTabStops(page)).toEqual(["head"]);
      await focusStop(page);
      await expectAt(page, "inbox", "head");
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
      await expectAt(page, "done", "head");
      await page.keyboard.press("ArrowDown"); await expectAt(page, "done", before[1]!);
      await page.keyboard.press("End"); await expectAt(page, "done", before[50]!);
      await page.keyboard.press("ArrowDown"); await expectAt(page, "done", "more");
      await page.keyboard.press("Enter");
      // The button goes away once the last page is in, and focus lands on the first newly revealed card.
      await expect.poll(async () => cardsOf(await laneItems(page, "done")).length).toBe(52);
      const after = await laneItems(page, "done");
      expect(after).not.toContain("more");
      await expectAt(page, "done", after[51]!);
      expect(before).not.toContain(after[51]);
    });

    test("a one-time key hint on keyboard entry (never on a pointer press), and the shared ring on the grip", async ({ page, loomDaemon }) => {
      const project = await loomDaemon.createProject(uniq("kbd-hint"));
      await loomDaemon.createTask(project.id, { title: uniq("hint-a"), columnKey: "inbox" });
      await loomDaemon.createTask(project.id, { title: uniq("hint-b"), columnKey: "inbox" });
      await pin(page, project.id);
      await page.goto(`${loomDaemon.baseURL}${surface}`);
      await expect.poll(async () => cardsOf(await laneItems(page, "inbox")).length).toBe(2);
      const inbox = cardsOf(await laneItems(page, "inbox"));
      const a = { id: inbox[0]! };
      const hint = page.getByTestId("board-nav-hint");
      const seen = () => page.evaluate(() => localStorage.getItem("loom.boardNavHintSeen"));
      await expect(hint).toHaveCount(0);

      // A pointer press focuses the card without :focus-visible, so no hint. Ctrl+click is the press that
      // focuses a card without opening it; its selection mark renders in the same commit the hint would.
      await page.locator(`[data-board-nav="${a.id}"]`).click({ modifiers: ["Control"] });
      await expectAt(page, "inbox", a.id);
      const cardA = page.locator(".loom-board-card", { has: page.locator(`[data-board-nav="${a.id}"]`) });
      await expect(cardA).toHaveAttribute("data-selected", "");
      await expect(hint).toHaveCount(0);
      expect(await seen()).toBeNull();

      // The first KEYBOARD focus in the grid shows it, naming the real keys (x selects, not Space).
      await page.keyboard.press("Escape");
      await expect(cardA).not.toHaveAttribute("data-selected", "");
      await page.keyboard.press("ArrowDown");
      await expectAt(page, "inbox", inbox[1]!);
      await expect(hint).toBeVisible();
      await expect(hint).toContainText("move");
      await expect(hint).toContainText("Enter");
      await expect(hint).not.toContainText("Space");
      expect(await seen()).toBe("1");
      // It sits above the grid, so it never covers the card that has focus.
      const [hb, gb] = [await hint.boundingBox(), await page.locator(".loom-board-grid").boundingBox()];
      expect(hb!.y + hb!.height).toBeLessThanOrEqual(gb!.y);

      // Leaving the grid takes it away; coming back by keyboard does not bring it back, nor does a reload.
      await page.keyboard.press("Tab");
      await expect(hint).toHaveCount(0);
      await focusStop(page);
      await page.keyboard.press("ArrowUp");
      await expectAt(page, "inbox", inbox[0]!);
      await expect(hint).toHaveCount(0);
      await page.reload();
      await expect.poll(async () => cardsOf(await laneItems(page, "inbox")).length).toBe(2);
      await page.keyboard.press("Shift");
      await focusStop(page);
      await page.keyboard.press("ArrowDown");
      await expectAt(page, "inbox", inbox[1]!);
      await expect(hint).toHaveCount(0);

      // The drag grip (not a Tab stop, but a press focuses it) paints the same ring as the card, inset,
      // instead of Chromium's own 1px auto ring (C-03).
      await page.keyboard.press("Shift");
      const grip = cardA.locator(".loom-card-grip");
      await grip.focus();
      const gripRing = await grip.evaluate((el) => { const s = getComputedStyle(el); return { fv: el.matches(":focus-visible"), style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor }; });
      const cardRing = await page.locator(`[data-board-nav="${a.id}"]`).evaluate((el) => { (el as HTMLElement).focus(); const s = getComputedStyle(el); return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor }; });
      expect(gripRing.fv).toBe(true);
      expect({ style: gripRing.style, width: gripRing.width, color: gripRing.color }).toEqual(cardRing);
      expect(cardRing.style).toBe("solid");
    });
  });
}
