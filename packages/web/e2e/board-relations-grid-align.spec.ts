// The board card dialog's PARENT row lays out on the SAME grid as the relation editor's rows, so every
// relation in that section states its value on one vertical rule (card e8e6d91e).
//
// Before this, the parent summary was a plain flex row and the editor a `minmax(74px, auto) 1fr` grid:
// the parent's value started at `width("PARENT") + 4` while the editor's started at its own column
// auto-sized by "DISCOVERED FROM" + 10 — two rules ~50px apart inside a block that reads as one list.
//
// What is measured, and why it can fail:
//   · THE RULE — the x of each relation's own `.loom-task-link`, the first thing in the value column on
//     both sides. The SAME element with the SAME padding on the parent row and on every editor chip, so
//     the two numbers are directly comparable; comparing a cell box against a rendered link would not be.
//     Asserted at 1600 AND at 420, because the fix is a shared COLUMN rather than a tuned offset and a
//     constant that happened to line up at one width would pass a single-width check.
//   · NO LABEL OVERFLOW — the shared column is an explicit width (`RELATION_LABEL_COL`), and a label is
//     `nowrap`, so the one way this can rot is a renamed or added label that needs more room and spills
//     into the value beside it. That is this spec's job too: the constant is only safe while something
//     checks it, and nothing else does.
//   · The 420 read is asserted to be a DIFFERENT layout from the 1600 one (the panel's own x moves), so
//     a viewport change that silently did not apply cannot pass as two independent measurements.
//
// Both shells, because there is ONE `<Board>` (card a6d7a102) but the dialog sits in a different frame
// in each: the classic rail page and the Atlas shell hand it different widths at the same viewport.
//
// Presence-first (card 625d791c): every leg asserts the fixture's own cards and rows are really on
// screen before it reads a single box, so a still-loading dialog can never satisfy an alignment check
// by having nothing to misalign.
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";
import type { Locator } from "@playwright/test";
import path from "node:path";

// lib/atlasUi.ts owns this key and the "1" = on encoding; lib/activeProject.tsx owns the project one.
// Hardcoded rather than imported: the e2e tsconfig covers `e2e/` only (tsconfig.e2e.json).
const ATLAS_KEY = "loom.atlasUi";
const PROJECT_KEY = "loom.projectId";

const WIDE = { width: 1600, height: 1000 };
// The narrow end the dialog is designed down to (card 6ed6d8b2 measured the parent row's wrap here).
const NARROW = { width: 420, height: 900 };

// Every row the editor puts on screen for this fixture. "Discovered from" is the widest label the
// column ever carries and is what used to auto-size the editor's column away from the parent's — a
// fixture without it cannot see the defect at all, so all four are seeded and all four are measured.
const EDITOR_KINDS = ["blockedBy", "blocks", "related", "discoveredFrom"] as const;

// The grid items in the shared label column: the parent row's own label and each editor row's label
// (the first child of its `display: contents` wrapper). Both addressed as `:first-child` rather than by
// a new testid, so this selector resolves to the SAME five elements against the PRE-FIX DOM too — a
// count that only matches after the fix would make the mutant below fail structurally, proving nothing
// about alignment.
const LABEL_SELECTOR = '[data-testid="parent-summary"] > span:first-child, [data-testid="task-relations-editor"] > div > span:first-child';

// Opt-in visual capture (mirrors board-hierarchy.spec.ts / board-relations-edit.spec.ts): unset in CI,
// so a no-op there.
const shotDir = process.env.LOOM_E2E_SHOTS;
const shoot = async (target: Page | Locator, name: string) => {
  if (shotDir) await target.screenshot({ path: path.join(shotDir, name) });
};

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Writes only while the key is still absent: addInitScript re-runs on every navigation, so an
// unconditional write would re-pin on a reload and the leg would measure this helper (card e47df20a).
async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, id); } catch { /* storage unavailable — assertions will say so */ }
  }, [PROJECT_KEY, projectId] as const);
}

// Only ever seeded ON. OFF is the default (an empty key), and a "seed off" script would re-clear the
// key on every navigation instead (measured on Atlas P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable */ }
  }, ATLAS_KEY);
}

/** Write a card's structure directly, for SEEDING only (never as a stand-in for a UI action). */
async function setStructure(baseURL: string, secret: string, taskId: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseURL}/api/tasks/${taskId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST /api/tasks/${taskId} -> ${res.status} ${await res.text()}`);
}

/**
 * One subject card carrying a parent AND all four writable relation kinds, each pointing at a DIFFERENT
 * card. Distinct targets on purpose: an epic that is both the parent and the `discoveredFrom` (the
 * board-hierarchy fixture's shape) makes one title legitimately appear twice, which would make a
 * per-section locator ambiguous for no gain here.
 */
async function seedFixture(loomDaemon: LoomDaemon, projectId: string) {
  const mk = async (prefix: string, columnKey: string) => {
    const title = uniq(prefix);
    const task = await loomDaemon.createTask(projectId, { title, columnKey });
    return { id: task.id, title };
  };
  const epic = await mk("gridalign-epic", "in_progress");
  const blocker = await mk("gridalign-blocker", "todo");
  const blocked = await mk("gridalign-blocked", "todo");
  const related = await mk("gridalign-related", "todo");
  const origin = await mk("gridalign-origin", "todo");
  const subject = await mk("gridalign-subject", "todo");

  await setStructure(loomDaemon.baseURL, loomDaemon.loopbackSecret, subject.id, {
    parentId: epic.id,
    blockedBy: [blocker.id],
    blocks: [blocked.id],
    related: [related.id],
    // A STRING, not an array: `discoveredFrom` is single-valued on the REST body (tasks/relations.ts's
    // `TaskStructureInput`), unlike the three list kinds above.
    discoveredFrom: origin.id,
  });
  return { subject, epic, cardCount: 6 };
}

const cardTitleText = (page: Page, title: string) =>
  page.locator(".loom-board-card")
    .filter({ has: page.locator('[data-testid="card-title"]', { hasText: title }) })
    .locator('[data-testid="card-title"]');

/**
 * Where a relation's VALUE starts: the x of its own `.loom-task-link`. Rounded, because the two numbers
 * being compared are produced by the same track in the same layout pass — float noise is the only
 * difference a sound alignment can have, and the defect this guards is ~50px wide.
 */
async function valueLeft(scope: Locator, what: string): Promise<number> {
  const link = scope.locator(".loom-task-link").first();
  await expect(link, `${what}: its link must be on screen before its x can be read`).toBeVisible();
  const box = await link.boundingBox();
  expect(box, `${what}: its link must be laid out before its x can be read`).not.toBeNull();
  return Math.round(box!.x);
}

/** The parent row's value x and every editor row's value x, read in one pass over a settled dialog. */
async function readRule(dialog: Locator, label: string) {
  const parent = await valueLeft(dialog.getByTestId("parent-summary"), `${label}: the parent row`);
  const rows: Record<string, number> = {};
  for (const kind of EDITOR_KINDS) {
    rows[kind] = await valueLeft(dialog.getByTestId(`relations-edit-${kind}`), `${label}: the ${kind} row`);
  }
  return { parent, rows };
}

/**
 * Each label's own text width against the column it is laid in. READ here, asserted at the end of the
 * leg, so a red never costs the leg its remaining screenshot — every row it reads has already been
 * awaited visible by the caller, so there is nothing for this to auto-wait on.
 */
async function readLabels(dialog: Locator) {
  return dialog.locator(LABEL_SELECTOR).evaluateAll((els) => els
    .map((el) => ({ text: (el.textContent ?? "").trim(), content: el.scrollWidth, column: el.clientWidth })));
}

type LabelRead = Awaited<ReturnType<typeof readLabels>>;

/**
 * No label spills out of the fixed label column into the value beside it. Presence-first: the element
 * count is pinned to the five labels this fixture renders, so the check can never pass by matching
 * nothing — which is exactly how a selector that drifted off a refactored DOM would read.
 */
function assertNoLabelOverflow(labels: LabelRead, label: string) {
  expect(labels.length, `${label}: the parent label plus one per editor row`).toBe(1 + EDITOR_KINDS.length);
  expect(labels.filter((r) => r.content > r.column),
    `${label}: a label wider than the shared label column collides with the value beside it`).toEqual([]);
}

/** The dialog panel, whose own x moves with the viewport — the witness that a resize really applied. */
const panelOf = (dialog: Locator) => dialog.locator("> div");

async function panelWidth(dialog: Locator): Promise<number> {
  const box = await panelOf(dialog).boundingBox();
  return box ? Math.round(box.width) : -1;
}

/**
 * One shell, end to end: seed, open the subject's dialog, read the rule at 1600 and again at 420.
 *
 * Every measurement is READ, and both screenshots taken, BEFORE the first assertion that can fail:
 * this leg doubles as the before/after capture for the card, and a red at 1600 would otherwise stop
 * the run with the 420 shot never taken. Nothing is skipped by it — both widths are still asserted.
 */
async function assertSharedRule(
  page: Page,
  loomDaemon: LoomDaemon,
  opts: { atlas: boolean; label: string; shot: string },
) {
  const project = await loomDaemon.createProject(uniq(opts.atlas ? "gridalign-atlas" : "gridalign-classic"));
  const fx = await seedFixture(loomDaemon, project.id);

  if (opts.atlas) await seedAtlasOn(page);
  await pinProject(page, project.id);
  await page.setViewportSize(WIDE);
  await page.goto(`${loomDaemon.baseURL}/board`);

  // The shell under measurement is really the one that mounted.
  if (opts.atlas) {
    await expect(page.getByTestId("atlas-shell"), `${opts.label}: the Atlas shell`).toBeVisible();
  } else {
    await expect(page.locator(".loom-rail"), `${opts.label}: the classic rail`).toBeVisible();
    await expect(page.getByTestId("atlas-shell"), `${opts.label}: nothing Atlas is in the document`).toHaveCount(0);
  }
  // Fixture identity: this board, not a sibling spec's leftovers on the shared worker daemon.
  await expect(page.locator(".loom-board-card"), `${opts.label}: the seeded board`).toHaveCount(fx.cardCount);

  await cardTitleText(page, fx.subject.title).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(`Task · ${fx.subject.id.slice(0, 8)}`), `${opts.label}: the subject's own dialog`).toBeVisible();

  // PRESENCE of everything that gets measured, before anything is measured.
  await expect(dialog.getByTestId("parent-summary"), `${opts.label}: the parent row names the epic`).toContainText(fx.epic.title);
  for (const kind of EDITOR_KINDS) {
    await expect(dialog.getByTestId(`relations-edit-${kind}`), `${opts.label}: the ${kind} row`).toBeVisible();
  }
  // The head face loads with `display: swap`, so the labels re-measure when the face lands. The shared
  // column is a fixed width and the two values move together regardless — this only keeps the captured
  // screenshots from showing the fallback face.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  const wide = await readRule(dialog, `${opts.label} @1600`);
  const wideLabels = await readLabels(dialog);
  await shoot(dialog, `${opts.shot}-1600.png`);

  await page.setViewportSize(NARROW);
  // `min(820px, 92vw)` — 92vw of 420 is 386, so the panel really did narrow rather than the resize
  // having silently not applied and both reads being one measurement twice.
  await expect.poll(() => panelWidth(dialog), { message: `${opts.label}: the panel narrowed with the viewport` })
    .toBeLessThan(500);

  const narrow = await readRule(dialog, `${opts.label} @420`);
  const narrowLabels = await readLabels(dialog);
  await shoot(dialog, `${opts.shot}-420.png`);

  assertNoLabelOverflow(wideLabels, `${opts.label} @1600`);
  assertNoLabelOverflow(narrowLabels, `${opts.label} @420`);

  // ── THE assertion: one rule, at both widths ─────────────────────────────────────────────────────
  for (const kind of EDITOR_KINDS) {
    expect(wide.rows[kind], `${opts.label} @1600: the ${kind} row's value starts where the parent's does`).toBe(wide.parent);
    expect(narrow.rows[kind], `${opts.label} @420: the ${kind} row's value starts where the parent's does`).toBe(narrow.parent);
  }
  // …and the two reads were genuinely two layouts: the centred panel's own x moves with the viewport.
  expect(narrow.parent, `${opts.label}: 420 must be a different layout from 1600, not the same read twice`)
    .not.toBe(wide.parent);
}

test.describe("the parent row and the relation editor share one label column (card e8e6d91e)", () => {

  test("switch ON: the Atlas dialog states every relation on one rule, at 1600 and at 420", async ({ page, loomDaemon }) => {
    await assertSharedRule(page, loomDaemon, { atlas: true, label: "Atlas dialog", shot: "atlas" });
  });
});
