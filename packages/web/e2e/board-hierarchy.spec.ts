// Board hierarchy + relations spec (card 1ae4f88c — the UI half of the owner-directed board hierarchy,
// "no overkill"). A card can name a PARENT, count its CHILDREN's progress, and carry relation edges
// (blocked-by / blocking / related / discovered-from / discoveries). The board card shows a light
// parent chip, child progress and a blocked marker; the drawer shows the full picture with every item
// clickable through to that card.
//
// FULLY REAL: cards, parentage and relation edges are all seeded through the real write route
// (`POST /api/tasks/:id`) against the real daemon, and the assertions read them back through the real
// board and single-task routes. An earlier revision injected the fields with a route intercept because
// the daemon half (card 3df86c87) was still on its own branch; it merged, and only the seeding helper
// changed — the UI assertions stood unaltered.
//
// That swap is worth more than tidiness: real data produces edges NOBODY WROTE ON THE CARD (the reverse
// `blocks` side of a `blockedBy`, and `resolved` DERIVED from the blocker's column rather than stored).
// A mock can only ever return what it was handed, so it is structurally incapable of catching a missing
// reverse edge or a wrongly-derived `resolved` — both of which this spec now asserts directly.
//
// Every assertion is an observable before/after diff against real cards, not "the page rendered".
//
// Determinism (same as board.spec.ts): the board is scoped to the ACTIVE project (localStorage
// `loom.projectId`) and the worker-scoped daemon is SHARED across specs, so each test seeds its OWN
// project and PINS it active BEFORE navigating.
import { expect, test } from "./fixtures/daemon";
import type { Locator, Page } from "@playwright/test";
import path from "node:path";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// Opt-in visual capture (mirrors board.spec.ts / board-merge-meter.spec.ts): unset in CI, so this is a
// no-op there. Set LOOM_E2E_SHOTS to a dir to persist the card + drawer shots for a visual review.
const shotDir = process.env.LOOM_E2E_SHOTS;
const shoot = async (target: Page | Locator, name: string) => {
  if (shotDir) await target.screenshot({ path: path.join(shotDir, name) });
};

// The board card wrapper carries `.loom-board-card`; filter by the card's OWN title element.
//
// NOT `getByText(title)`: a child card's parent chip renders the PARENT's title as card text, so a plain
// text filter resolves the epic's card AND both of its children — caught by this spec's own
// fixture-identity assertion below, which is why `data-testid="card-title"` exists on the title span.
function cardByTitle(page: Page, title: string) {
  return page.locator(".loom-board-card").filter({ has: page.locator('[data-testid="card-title"]', { hasText: title }) });
}
/** The card's own clickable title — the drawer-open target, unambiguous for the same reason as above. */
function cardTitleText(page: Page, title: string) {
  return cardByTitle(page, title).locator('[data-testid="card-title"]');
}

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * Seed a card's STRUCTURE through the real write route (card 3df86c87 is merged, so there is nothing to
 * mock any more): `POST /api/tasks/:id` accepts parentId/blockedBy/blocks/related/discoveredFrom and runs
 * them through the same validator as the MCP tools. Whole-set replace, same as the tools.
 *
 * This spec previously injected these fields with a route intercept because the daemon half was still on
 * its own branch; it was written so ONLY this helper would change when that landed, and this is that
 * change — every assertion below is untouched.
 */
async function setStructure(baseURL: string, secret: string, taskId: string, structure: Record<string, unknown>) {
  const res = await fetch(`${baseURL}/api/tasks/${taskId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(structure),
  });
  if (!res.ok) throw new Error(`POST /api/tasks/${taskId} -> ${res.status} ${await res.text()}`);
}

/** Read a task back through the real single-task route — used to ASSERT the contract, not just the UI. */
async function readTask(baseURL: string, secret: string, taskId: string): Promise<Record<string, any>> {
  const res = await fetch(`${baseURL}/api/tasks/${taskId}`, { headers: { authorization: `Bearer ${secret}` } });
  if (!res.ok) throw new Error(`GET /api/tasks/${taskId} -> ${res.status}`);
  return res.json();
}

/** The drawer's links block; `data-testid` is on the block itself so its absence is assertable. */
const linksBlock = (page: Page) => page.getByTestId("task-links");
/**
 * One SECTION of the links block (parent / children / blockedBy / blocks / related / discoveredFrom /
 * discoveries). Scoping matters: the same card can legitimately appear in two sections at once — the epic
 * below is both this card's parent AND the card it was discovered from — so an unscoped role+name lookup
 * is genuinely ambiguous rather than merely fragile.
 */
const linkSection = (page: Page, key: string) => page.getByTestId(`links-${key}`);
/** The clickable link to a given card WITHIN one section, addressed by its accessible name. */
const linkTo = (page: Page, section: string, id: string) =>
  linkSection(page, section).getByRole("button", { name: new RegExp(`^Open card ${id.slice(0, 8)} `) });
/**
  * The open drawer's card id, read off the dossier header — the observable for "which card am I on".
  *
  * `textContent`, NOT `innerText`: the header is a SectionLabel, which is `text-transform: uppercase`, and
  * innerText returns the RENDERED (upper-cased) text while the ids being compared are lowercase hex.
  * textContent reads the underlying DOM text, so this compares like with like; the lowercase() is a second
  * belt in case the transform ever moves into the markup itself.
  */
async function openCardId(page: Page): Promise<string> {
  const header = (await page.getByRole("dialog").getByText(/^Task · /).textContent()) ?? "";
  return header.replace(/^Task · /i, "").trim().toLowerCase();
}

test("board cards show parent, child progress and a blocked marker; the drawer links click through", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-hierarchy-${Date.now()}`);
  await pinActiveProject(page, project.id);

  // A real 3-level shape plus a blocker, all real rows on the real daemon:
  //   epic ── childDone (in a done lane) · childOpen (blocked by `blocker`, and itself a parent)
  const epicTitle = uniq("epic-card");
  const doneChildTitle = uniq("child-done");
  const openChildTitle = uniq("child-open");
  const blockerTitle = uniq("blocker-card");
  const grandchildTitle = uniq("grandchild");
  const epic = await loomDaemon.createTask(project.id, { title: epicTitle, columnKey: "in_progress" });
  const doneChild = await loomDaemon.createTask(project.id, { title: doneChildTitle, columnKey: "done" });
  const openChild = await loomDaemon.createTask(project.id, { title: openChildTitle, columnKey: "todo" });
  const blocker = await loomDaemon.createTask(project.id, { title: blockerTitle, columnKey: "todo" });
  const grandchild = await loomDaemon.createTask(project.id, { title: grandchildTitle, columnKey: "todo" });

  // Wire the REAL structure through the REAL write route. `doneChild` sits in the terminal lane, so the
  // edge naming it resolves by DERIVATION (the contract computes `resolved` at read time from the
  // blocker's column — it is never stored), while `blocker` in To Do stays open. That gives one live and
  // one resolved blocker on the same card without fabricating either state.
  const { baseURL, loopbackSecret } = loomDaemon;
  await setStructure(baseURL, loopbackSecret, doneChild.id, { parentId: epic.id });
  await setStructure(baseURL, loopbackSecret, openChild.id, {
    parentId: epic.id,
    blockedBy: [blocker.id, doneChild.id],
    related: [grandchild.id],
    discoveredFrom: epic.id,
  });
  await setStructure(baseURL, loopbackSecret, grandchild.id, { parentId: openChild.id });

  // CONTRACT CHECK, before touching the UI: assert the daemon actually serves the shape this UI reads. A
  // UI assertion alone can't tell "the daemon sent it and we rendered it" from "we rendered a default" —
  // and `resolved` being DERIVED is exactly the kind of thing that could silently come back false.
  const openChildRow = await readTask(baseURL, loopbackSecret, openChild.id);
  expect(openChildRow.parentId).toBe(epic.id);
  expect(openChildRow.parent?.title).toBe(epicTitle);
  expect(openChildRow.children).toMatchObject({ done: 0, total: 1 });
  const seenBlockers = (openChildRow.relations?.blockedBy ?? []) as { id: string; resolved: boolean }[];
  expect(new Set(seenBlockers.map((b) => b.id))).toEqual(new Set([blocker.id, doneChild.id]));
  expect(seenBlockers.find((b) => b.id === blocker.id)?.resolved).toBe(false);
  expect(seenBlockers.find((b) => b.id === doneChild.id)?.resolved).toBe(true);
  // ⚠️ PINNED TO A KNOWN BUG, DELIBERATELY — card dc1e27fe. Read this before "fixing" the assertion.
  //
  // `buildRelationView` (packages/daemon/src/tasks/relations.ts, the `ref()` helper) computes `resolved`
  // from the card it is DISPLAYING rather than from the edge's blocker:
  //   blockedBy → ref(e.fromTaskId) = the blocker  → "has my blocker landed?"    ✅ correct
  //   blocks    → ref(e.toTaskId)   = the blocked  → "is the card I block done?" ❌ the bug
  // So doneChild is terminal, yet its OUTGOING edge reads resolved:false because openChild (To Do) isn't.
  // The decision record is AUTHORITATIVE and correct ("resolved is on the edge's BLOCKER side for both");
  // the code is wrong. Confirmed by the manager and carded as dc1e27fe.
  //
  // This expects `false` — today's buggy value — ON PURPOSE, so the bug cannot quietly persist unnoticed.
  // WHEN dc1e27fe LANDS THIS ASSERTION WILL FAIL. That is the intended signal, not a regression: flip the
  // expected value to `true` (and the UI assertion in the click-through below, which expects no
  // "(resolved)" marker on this card, to expect one). Do NOT weaken it to accept either value — that would
  // throw away the only thing here that will tell anyone the fix actually shipped.
  // The UI needs no change either way: it renders whatever `resolved` says.
  const doneChildRow = await readTask(baseURL, loopbackSecret, doneChild.id);
  const blocksOut = (doneChildRow.relations?.blocks ?? []) as { id: string; resolved: boolean }[];
  expect(blocksOut.map((b) => b.id)).toEqual([openChild.id]);
  expect(blocksOut[0]?.resolved).toBe(false);
  const epicRow = await readTask(baseURL, loopbackSecret, epic.id);
  expect(epicRow.children).toMatchObject({ done: 1, total: 2 });
  expect((epicRow.relations?.discoveries ?? []).map((d: { id: string }) => d.id)).toEqual([openChild.id]);

  await page.setViewportSize({ width: 1400, height: 950 });
  await page.goto(`${loomDaemon.baseURL}/board`);

  // ── BOARD CARDS ───────────────────────────────────────────────────────────────────────────────────
  // FIXTURE IDENTITY: assert we are looking at THIS spec's own seeded data before trusting anything
  // below. A silent fallback to another daemon's board renders identically (a sibling worker runs the
  // same app on this host), so a bare "the marker is visible" could be a confident wrong answer.
  const epicCard = cardByTitle(page, epicTitle);
  await expect(epicCard).toHaveCount(1);
  await expect(page.locator(".loom-board-card")).toHaveCount(5); // exactly the 5 cards seeded above

  // The epic reports child progress and NOTHING else — no parent, no blocker.
  await expect(epicCard.getByText("⊞", { exact: false })).toBeVisible();
  await expect(epicCard.getByText("1/2", { exact: true })).toBeVisible();
  await expect(epicCard.getByText("⊘", { exact: false })).toHaveCount(0);
  await expect(epicCard.getByText("↳", { exact: false })).toHaveCount(0);

  // The open child reports all three: its blocker BY NAME, its own child progress, and its parent BY NAME.
  const openCard = cardByTitle(page, openChildTitle);
  await expect(openCard.getByText(blockerTitle, { exact: false })).toBeVisible(); // ⊘ names the blocker
  await expect(openCard.getByText("0/1", { exact: true })).toBeVisible();
  await expect(openCard.getByText(epicTitle, { exact: false })).toBeVisible(); // ↳ names the parent
  await shoot(openCard, "board-hierarchy-card-open-child.png");
  await shoot(epicCard, "board-hierarchy-card-epic.png");

  // The blocker itself has no hierarchy at all → its card carries no meta row whatsoever. This is the
  // in-test control that the markers above come from the injected data and not from every card.
  const blockerCard = cardByTitle(page, blockerTitle);
  for (const glyph of ["⊘", "⊞", "↳"]) {
    await expect(blockerCard.getByText(glyph, { exact: false })).toHaveCount(0);
  }

  // ── DRAWER: the links block, and CLICK-THROUGH child → parent ─────────────────────────────────────
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await cardTitleText(page, openChildTitle).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(await openCardId(page)).toBe(openChild.id.slice(0, 8));

  const block = linksBlock(page);
  await expect(block).toBeVisible();
  // Every section the contract defines for this card, each naming its target.
  await expect(block.getByText("Parent", { exact: true })).toBeVisible();
  await expect(block.getByText("Children", { exact: true })).toBeVisible();
  await expect(block.getByText("Blocked by", { exact: true })).toBeVisible();
  await expect(block.getByText("Related", { exact: true })).toBeVisible();
  await expect(block.getByText("Discovered from", { exact: true })).toBeVisible();
  await expect(block.getByText("0/1 done", { exact: true })).toBeVisible();
  // The RESOLVED blocker is present as history, explicitly marked — not dropped, and not shown as live.
  await expect(block.getByText("(resolved)", { exact: true })).toBeVisible();
  await expect(linkTo(page, "blockedBy", doneChild.id)).toBeVisible();
  // …and the LIVE blocker sits in the same section, unmuted.
  await expect(linkTo(page, "blockedBy", blocker.id)).toBeVisible();
  // The parent link is in the Parent section; the SAME epic also appears under Discovered from, which is
  // correct and is exactly why both are addressed per-section rather than by name alone.
  await expect(linkTo(page, "parent", epic.id)).toBeVisible();
  await expect(linkTo(page, "discoveredFrom", epic.id)).toBeVisible();
  // A card that HAS a parent shows it as ONE line with edit/clear, not an open field — and the open
  // field is absent from the DOM until one of those is clicked.
  const summary = dialog.getByTestId("parent-summary");
  await expect(summary).toContainText(epicTitle);
  await expect(summary.getByRole("button", { name: "Change parent" })).toBeVisible();
  await expect(summary.getByRole("button", { name: "Clear parent" })).toBeVisible();
  await expect(dialog.getByLabel("Parent card id")).toHaveCount(0);
  await shoot(dialog, "board-hierarchy-drawer-open-child.png");

  // `clear` STAGES the change — it opens the editor emptied and enables Save, rather than writing on the
  // spot. A one-click write hiding among staged ones is what would make Save untrustworthy.
  await summary.getByRole("button", { name: "Clear parent" }).click();
  await expect(dialog.getByLabel("Parent card id")).toHaveValue("");
  await expect(dialog.getByTestId("parent-resolution")).toHaveText("no parent");
  await expect(dialog.getByRole("button", { name: "Save" })).toBeEnabled();
  await dialog.getByRole("button", { name: "cancel" }).click();
  await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();

  // CLICK the parent link → the SAME dialog now shows the EPIC. Before/after on the header id, which is
  // the drawer's own identity, so this can't pass by the dialog merely still being open.
  const before = await openCardId(page);
  await linkTo(page, "parent", epic.id).click();
  await expect(dialog).toBeVisible();
  await expect.poll(() => openCardId(page)).toBe(epic.id.slice(0, 8));
  expect(before).not.toBe(epic.id.slice(0, 8));

  // The epic's own links block lists BOTH children with exact progress, and its discovery.
  const epicBlock = linksBlock(page);
  await expect(epicBlock.getByText("1/2 done", { exact: true })).toBeVisible();
  await expect(linkTo(page, "children", doneChild.id)).toBeVisible();
  await expect(linkTo(page, "children", openChild.id)).toBeVisible();
  await expect(epicBlock.getByText("Discoveries", { exact: true })).toBeVisible();
  // An epic has no parent → that section is absent entirely, not rendered empty.
  await expect(epicBlock.getByText("Parent", { exact: true })).toHaveCount(0);
  await shoot(dialog, "board-hierarchy-drawer-epic.png");

  // ── CLICK-THROUGH parent → child → blocker: the third hop the DoD names ───────────────────────────
  await linkTo(page, "children", openChild.id).click();
  await expect.poll(() => openCardId(page)).toBe(openChild.id.slice(0, 8));
  await linkTo(page, "blockedBy", blocker.id).click();
  await expect.poll(() => openCardId(page)).toBe(blocker.id.slice(0, 8));

  // ── THE REVERSE DIRECTION, which only real data produces ──────────────────────────────────────────
  // "Both directions are computed in this one call": the blocker's OWN drawer names what it blocks, from
  // an edge nobody wrote on this card. The route-mocked version of this spec could not have caught a
  // missing reverse edge at all, because the mock only ever returned what it was handed.
  await expect(linkTo(page, "blocks", openChild.id)).toBeVisible();
  // This blocker sits in To Do, so the edge is LIVE — `resolved` is derived from the BLOCKER's column.
  await expect(linksBlock(page).getByText("(resolved)", { exact: true })).toHaveCount(0);
  await shoot(dialog, "board-hierarchy-drawer-blocker.png");

  // ── The `blocks` direction renders from the same field, whatever it says ──────────────────────────
  // doneChild's outgoing edge reads resolved:false today because of bug dc1e27fe (see the pinned note at
  // the seeding block above), so it renders LIVE here. The point is that the drawer's history split is
  // driven by the served field and nothing else — which is why the UI needs no change when that bug is
  // fixed. FLIP THIS WITH THE PIN ABOVE when dc1e27fe lands: expect the "(resolved)" marker, not its
  // absence.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await cardTitleText(page, doneChildTitle).click();
  await expect.poll(() => openCardId(page)).toBe(doneChild.id.slice(0, 8));
  await expect(linkTo(page, "blocks", openChild.id)).toBeVisible();
  await expect(linksBlock(page).getByText("(resolved)", { exact: true })).toHaveCount(0);
});

test("the drawer's Parent field resolves an id prefix, names the resolved card, and refuses a bad one", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-parent-edit-${Date.now()}`);
  await pinActiveProject(page, project.id);

  const epicTitle = uniq("parent-target");
  const childTitle = uniq("parent-editee");
  const epic = await loomDaemon.createTask(project.id, { title: epicTitle, columnKey: "in_progress" });
  const child = await loomDaemon.createTask(project.id, { title: childTitle, columnKey: "todo" });

  await page.setViewportSize({ width: 1400, height: 950 });
  await page.goto(`${loomDaemon.baseURL}/board`);
  await expect(page.locator(".loom-board-card")).toHaveCount(2); // fixture identity
  await cardTitleText(page, childTitle).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel("Parent card id");
  const resolution = dialog.getByTestId("parent-resolution");
  const save = dialog.getByRole("button", { name: "Save" });

  // COLLAPSED AT REST: a card with no parent costs ONE ghost link, not a labelled field + resolution
  // line. The field is genuinely absent from the DOM, not merely hidden — that's the ~56px this is for.
  await expect(dialog.getByTestId("parent-summary")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Set parent…" })).toBeVisible();
  await expect(field).toHaveCount(0);
  await expect(resolution).toHaveCount(0);
  await shoot(dialog, "board-hierarchy-parent-collapsed.png");

  // Expanding reveals the editor, starting EMPTY → "no parent", Save still disabled (nothing dirty yet).
  await dialog.getByRole("button", { name: "Set parent…" }).click();
  await expect(field).toHaveValue("");
  await expect(resolution).toHaveText("no parent");
  await expect(save).toBeDisabled();

  // A VALID prefix names the card it resolved to — the check that stops a mistyped id landing silently.
  await field.fill(epic.id.slice(0, 8));
  await expect(resolution).toHaveText(`→ ${epicTitle}`);
  await expect(save).toBeEnabled();
  await shoot(dialog, "board-hierarchy-parent-field-ok.png");

  // An UNKNOWN prefix is refused, and Save is BLOCKED rather than saving the other fields while quietly
  // dropping the parent (which would read as "Save did nothing").
  await field.fill("deadbeef");
  await expect(resolution).toHaveText("no card on this board starts with that");
  await expect(save).toBeDisabled();

  // THIS card's own id is refused as self-parenting, distinctly from "unknown".
  await field.fill(child.id.slice(0, 8));
  await expect(resolution).toHaveText("that's this card — a card can't be its own parent");
  await expect(save).toBeDisabled();

  // An AMBIGUOUS prefix reports how many matched — the one failure that's fixed by typing MORE, so it
  // must not read the same as "unknown". Both seeded ids share the empty prefix; use a 1-char prefix that
  // both real uuids can't be guaranteed to share, so derive a genuinely shared one from the two ids.
  const shared = sharedPrefix(epic.id, child.id);
  if (shared.length > 0) {
    await field.fill(shared);
    await expect(resolution).toHaveText(/^2 cards start with that/);
    await expect(save).toBeDisabled();
  }

  // `cancel` abandons the parent edit ALONE and re-collapses — the other fields in the drawer are
  // untouched, which is what makes it distinct from Reset.
  await field.fill(epic.id.slice(0, 8));
  await dialog.getByRole("button", { name: "cancel" }).click();
  await expect(field).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Set parent…" })).toBeVisible();

  // Reset drops the whole edit and also re-collapses the parent editor.
  await dialog.getByRole("button", { name: "Set parent…" }).click();
  await field.fill(epic.id.slice(0, 8));
  await expect(resolution).toHaveText(`→ ${epicTitle}`);
  await dialog.getByRole("button", { name: "Reset" }).click();
  await expect(field).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Set parent…" })).toBeVisible();

  // ── The write actually PERSISTS (only checkable now that the daemon half has merged) ──────────────
  await dialog.getByRole("button", { name: "Set parent…" }).click();
  await field.fill(epic.id.slice(0, 8));
  await save.click();

  // Collapses back to the one-line summary naming the parent, and the links block now exists at all.
  await expect(dialog.getByTestId("parent-summary")).toContainText(epicTitle);
  await expect(linkTo(page, "parent", epic.id)).toBeVisible();
  // Read it back through the REST route: the UI showing a parent is not by itself proof one was stored.
  const { baseURL, loopbackSecret } = loomDaemon;
  expect((await readTask(baseURL, loopbackSecret, child.id)).parentId).toBe(epic.id);
  expect((await readTask(baseURL, loopbackSecret, epic.id)).children).toMatchObject({ done: 0, total: 1 });

  // CLEAR round-trips too — the direction that would silently do nothing if `parentId: null` were being
  // dropped from the patch rather than sent.
  await dialog.getByTestId("parent-summary").getByRole("button", { name: "Clear parent" }).click();
  await expect(field).toHaveValue("");
  await save.click();
  await expect(dialog.getByRole("button", { name: "Set parent…" })).toBeVisible();
  expect((await readTask(baseURL, loopbackSecret, child.id)).parentId).toBeNull();
});

/** The longest common leading substring of two ids — used to build a genuinely AMBIGUOUS prefix. */
function sharedPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

test("a card with NO hierarchy renders the board and drawer exactly as before the feature existed", async ({ page, loomDaemon }) => {
  // The empty-state control: a card with no parent, no children and no relations must be visually
  // indistinguishable from a pre-feature card — which is what keeps the owner's Overview-embedded board
  // from getting denser, since this is the common case.
  //
  // ⚠️ SCOPE, stated precisely: this is EMPTY hierarchy, not ABSENT hierarchy. Now that 3df86c87 has
  // merged, the daemon always sends the fields (as zeros and empty arrays), so this test no longer
  // exercises the older-daemon path it was originally written for. That field-ABSENCE path is covered
  // where it still can be — the unit tests in packages/web/test/task-hierarchy.mjs, which feed
  // taskLinks/boardHierarchy rows with the keys genuinely missing.
  const project = await loomDaemon.createProject(`board-hierarchy-legacy-${Date.now()}`);
  await pinActiveProject(page, project.id);
  const title = uniq("plain-card");
  await loomDaemon.createTask(project.id, { title, body: "a plain card with no hierarchy", columnKey: "todo" });

  await page.setViewportSize({ width: 1400, height: 950 });
  await page.goto(`${loomDaemon.baseURL}/board`);

  const card = cardByTitle(page, title);
  await expect(card).toHaveCount(1); // fixture identity
  // No meta row, in any of its three forms.
  for (const glyph of ["⊘", "⊞", "↳"]) {
    await expect(card.getByText(glyph, { exact: false })).toHaveCount(0);
  }

  // And the drawer carries no links block at all — the field-absent path, not an empty-looking one.
  await cardTitleText(page, title).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(linksBlock(page)).toHaveCount(0);
  // The rest of the drawer is untouched and still editable.
  await expect(page.getByRole("dialog").getByTestId("task-edit-column")).toBeVisible();
  // The parent WRITE is still reachable (it's how you'd create the first link), but collapsed to one line.
  await expect(page.getByRole("dialog").getByRole("button", { name: "Set parent…" })).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("Parent card id")).toHaveCount(0);
});
