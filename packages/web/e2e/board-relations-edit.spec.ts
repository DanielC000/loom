// Relation EDITING from the board card dialog (card 03d9db6e — the owner's "UI Features in board card
// dialog for users to set and adjust Task relations"). The read-only side is board-hierarchy.spec.ts;
// this spec is about the write.
//
// FULLY REAL, in both directions: every edge is created or removed by DRIVING THE UI (the picker, the
// chip's unlink control, Save) against the real daemon, and every claim is then re-read through the real
// `GET /api/tasks/:id`. "A chip appeared" is not evidence an edge was stored, and "a chip vanished" is
// not evidence one was removed — so each leg asserts the UI, then the REST row, then (where the edge has
// a reverse projection the user never wrote) the OTHER card's row too.
//
// The leg that earns this spec its keep is the released:true one. A relation write is a whole-set
// REPLACE, so the dialog has to reconstruct "the set that changes nothing" before adding to it — and an
// auto-released deferral edge must NOT be in that set, or an unrelated edit silently re-declares dead
// history as a live blocker. That damage is invisible on screen (the chips look identical either way)
// and only shows up in the stored `declared`/`released` bits, which is exactly why it is asserted here
// against a real released edge rather than left to the unit tests alone.
//
// Determinism (same as board-hierarchy.spec.ts): the board is scoped to the ACTIVE project
// (localStorage `loom.projectId`) and the worker-scoped daemon is SHARED across specs, so each test
// seeds its OWN project and PINS it active BEFORE navigating.
import { expect, test } from "./fixtures/daemon";
import type { Locator, Page } from "@playwright/test";
import path from "node:path";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// Opt-in visual capture (mirrors board-hierarchy.spec.ts): unset in CI, so a no-op there.
const shotDir = process.env.LOOM_E2E_SHOTS;
const shoot = async (target: Page | Locator, name: string) => {
  if (shotDir) await target.screenshot({ path: path.join(shotDir, name) });
};

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function cardByTitle(page: Page, title: string) {
  return page.locator(".loom-board-card").filter({ has: page.locator('[data-testid="card-title"]', { hasText: title }) });
}
function cardTitleText(page: Page, title: string) {
  return cardByTitle(page, title).locator('[data-testid="card-title"]');
}

/** Read a task back through the real single-task route — the observable for "was it actually stored". */
async function readTask(baseURL: string, secret: string, taskId: string): Promise<Record<string, any>> {
  const res = await fetch(`${baseURL}/api/tasks/${taskId}`, { headers: { authorization: `Bearer ${secret}` } });
  if (!res.ok) throw new Error(`GET /api/tasks/${taskId} -> ${res.status}`);
  return res.json();
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

const dialogOf = (page: Page) => page.getByRole("dialog");
const relationRow = (page: Page, kind: string) => dialogOf(page).getByTestId(`relations-edit-${kind}`);
const picker = (page: Page) => dialogOf(page).getByTestId("relations-picker");

/** Open the picker (it starts on Blocked by) and switch it to `kind`. */
async function openPicker(page: Page, kind: string) {
  await dialogOf(page).getByTestId("relations-add-open").click();
  await expect(picker(page)).toBeVisible();
  if (kind !== "blockedBy") await picker(page).getByLabel("Relation kind").selectOption(kind);
}

/** Pick a card in the open picker by typing part of its title, then clicking the named option. */
async function pickCard(page: Page, query: string, title: string) {
  await picker(page).getByLabel("Find a card to link").fill(query);
  await picker(page).getByRole("option", { name: new RegExp(title) }).click();
}

const saveButton = (page: Page) => dialogOf(page).getByRole("button", { name: "Save" });

test("the dialog adds and removes a blockedBy edge and a parent, each confirmed by a fresh read", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-relations-${Date.now()}`);
  await pinActiveProject(page, project.id);
  const { baseURL, loopbackSecret } = loomDaemon;

  const subjectTitle = uniq("relations-subject");
  const blockerTitle = uniq("relations-blocker");
  const epicTitle = uniq("relations-epic");
  const decoyTitle = uniq("relations-decoy");
  const subject = await loomDaemon.createTask(project.id, { title: subjectTitle, columnKey: "todo" });
  const blocker = await loomDaemon.createTask(project.id, { title: blockerTitle, columnKey: "todo" });
  const epic = await loomDaemon.createTask(project.id, { title: epicTitle, columnKey: "in_progress" });
  // A DECOY that is never linked: "an edge exists" would pass against a dialog that linked whatever it
  // found first, so every read below also asserts the decoy is NOT what landed.
  const decoy = await loomDaemon.createTask(project.id, { title: decoyTitle, columnKey: "todo" });

  // BEFORE: genuinely no relations and no parent, read off the real route rather than assumed.
  const before = await readTask(baseURL, loopbackSecret, subject.id);
  expect(before.parentId).toBeNull();
  expect(before.relations.blockedBy).toEqual([]);

  await page.setViewportSize({ width: 1400, height: 950 });
  await page.goto(`${loomDaemon.baseURL}/board`);
  await expect(page.locator(".loom-board-card")).toHaveCount(4); // fixture identity
  await cardTitleText(page, subjectTitle).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();

  // COLLAPSED AT REST: no row for any kind, just the one ghost link. The rows are genuinely absent from
  // the DOM, not hidden — that is the empty-state cost this design is built around.
  await expect(dialog.getByTestId("task-relations-editor")).toHaveCount(0);
  await expect(dialog.getByTestId("relations-add-open")).toBeVisible();
  await expect(saveButton(page)).toBeDisabled();
  await shoot(dialog, "board-relations-collapsed.png");

  // ── ADD a blockedBy edge through the picker ──────────────────────────────────────────────────────
  await openPicker(page, "blockedBy");
  // The picker never offers the card being edited — a card cannot block itself.
  await expect(picker(page).getByRole("option", { name: new RegExp(subjectTitle) })).toHaveCount(0);
  await pickCard(page, blockerTitle.slice(0, 18), blockerTitle);
  // STAGED, not written: the chip is there and Save is armed, but the server still has nothing.
  await expect(relationRow(page, "blockedBy")).toContainText(blockerTitle);
  await expect(saveButton(page)).toBeEnabled();
  expect((await readTask(baseURL, loopbackSecret, subject.id)).relations.blockedBy,
    "picking a card must stage the edge, never write it").toEqual([]);
  await shoot(dialog, "board-relations-staged.png");

  await picker(page).getByLabel("Close the card picker").click();
  await saveButton(page).click();
  await expect(saveButton(page)).toBeDisabled(); // clean again → the save landed

  // The stored edge, by a FRESH read: the blocker and NOT the decoy.
  await expect.poll(async () => (await readTask(baseURL, loopbackSecret, subject.id)).relations.blockedBy.map((r: any) => r.id))
    .toEqual([blocker.id]);
  // …and its reverse projection on the OTHER card, which nobody wrote — only a real stored edge produces it.
  expect((await readTask(baseURL, loopbackSecret, blocker.id)).relations.blocks.map((r: any) => r.id)).toEqual([subject.id]);
  expect((await readTask(baseURL, loopbackSecret, decoy.id)).relations.blocks).toEqual([]);

  // ── ADD a parent (the pre-existing control, now inside the Relations section) ─────────────────────
  await dialog.getByRole("button", { name: "Set parent…" }).click();
  await dialog.getByLabel("Parent card id").fill(epic.id.slice(0, 8));
  await expect(dialog.getByTestId("parent-resolution")).toHaveText(`→ ${epicTitle}`);
  await saveButton(page).click();
  await expect(dialog.getByTestId("parent-summary")).toContainText(epicTitle);
  await expect.poll(async () => (await readTask(baseURL, loopbackSecret, subject.id)).parentId).toBe(epic.id);
  await shoot(dialog, "board-relations-saved.png");

  // ── REMOVE the blockedBy edge through the chip's unlink control ───────────────────────────────────
  const unlink = relationRow(page, "blockedBy").getByRole("button", { name: new RegExp(`^Unlink Blocked by ${blocker.id.slice(0, 8)}`) });
  await expect(unlink).toBeVisible();
  await unlink.click();
  // Staged again: the row is gone from the editor, but the edge is still stored until Save.
  await expect(relationRow(page, "blockedBy")).toHaveCount(0);
  expect((await readTask(baseURL, loopbackSecret, subject.id)).relations.blockedBy.length,
    "unlinking must stage the removal, never write it").toBe(1);
  await saveButton(page).click();
  await expect.poll(async () => (await readTask(baseURL, loopbackSecret, subject.id)).relations.blockedBy).toEqual([]);
  // The reverse side is gone too — the edge was deleted, not merely hidden from this card.
  expect((await readTask(baseURL, loopbackSecret, blocker.id)).relations.blocks).toEqual([]);

  // ── REMOVE the parent ────────────────────────────────────────────────────────────────────────────
  await dialog.getByTestId("parent-summary").getByRole("button", { name: "Clear parent" }).click();
  await expect(dialog.getByLabel("Parent card id")).toHaveValue("");
  await saveButton(page).click();
  await expect(dialog.getByRole("button", { name: "Set parent…" })).toBeVisible();
  await expect.poll(async () => (await readTask(baseURL, loopbackSecret, subject.id)).parentId).toBeNull();
});

test("a released:true edge is shown as history, cannot be unlinked, and is never re-declared by another edit", async ({ page, loomDaemon }) => {
  // The whole-set-replace trap, end to end. A real released edge is produced the only way one can be:
  // pair the card to a blocker through the `deferredUntilTaskId` alias (a `gates` bit, not a declared
  // one), then release the deferral — which clears `gates` and keeps the row as `released` history.
  const project = await loomDaemon.createProject(`board-relations-released-${Date.now()}`);
  await pinActiveProject(page, project.id);
  const { baseURL, loopbackSecret } = loomDaemon;

  const subjectTitle = uniq("released-subject");
  const oldTitle = uniq("released-history");
  const newTitle = uniq("released-newblocker");
  const subject = await loomDaemon.createTask(project.id, { title: subjectTitle, columnKey: "todo" });
  const old = await loomDaemon.createTask(project.id, { title: oldTitle, columnKey: "todo" });
  const fresh = await loomDaemon.createTask(project.id, { title: newTitle, columnKey: "todo" });

  await setStructure(baseURL, loopbackSecret, subject.id, { deferred: true, deferredUntilTaskId: old.id });
  await setStructure(baseURL, loopbackSecret, subject.id, { deferred: false });

  // FIXTURE IDENTITY: the seeded edge really is released history, not a declared dependency. Without
  // this the test could pass against a plain declared edge and prove nothing about the exclusion.
  const seeded = (await readTask(baseURL, loopbackSecret, subject.id)).relations.blockedBy as any[];
  expect(seeded.map((r) => r.id)).toEqual([old.id]);
  expect(seeded[0].released, "the fixture must be auto-released deferral history").toBe(true);

  await page.setViewportSize({ width: 1400, height: 950 });
  await page.goto(`${loomDaemon.baseURL}/board`);
  await cardTitleText(page, subjectTitle).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();

  // Shown, marked for what it is, and with NO unlink control — there is no live edge there to remove.
  const row = relationRow(page, "blockedBy");
  await expect(row).toContainText(oldTitle);
  await expect(row).toContainText("(released)");
  await expect(row.getByRole("button", { name: /^Unlink / })).toHaveCount(0);
  await shoot(dialog, "board-relations-released.png");

  // Now the real test: add a DIFFERENT blocker and save. The write replaces the declared set for this
  // kind, so a dialog that echoed the released id back would promote it to a live declared blocker.
  await openPicker(page, "blockedBy");
  await pickCard(page, newTitle.slice(0, 18), newTitle);
  await picker(page).getByLabel("Close the card picker").click();
  await saveButton(page).click();

  await expect.poll(async () => {
    const rows = (await readTask(baseURL, loopbackSecret, subject.id)).relations.blockedBy as any[];
    return rows.map((r) => `${r.id === old.id ? "old" : r.id === fresh.id ? "new" : "?"}:${r.released === true}`).sort();
  }).toEqual(["new:false", "old:true"]);
  // Stated the other way round, which is the claim that matters: the released edge is still NOT live.
  const after = (await readTask(baseURL, loopbackSecret, subject.id)).relations.blockedBy as any[];
  expect(after.find((r) => r.id === old.id).released, "the released edge must stay history").toBe(true);
  expect(after.find((r) => r.id === fresh.id).released, "the new edge must be a real declared dependency").toBeUndefined();
});

test("a server-side refusal appears inline, verbatim, where the edit was made", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-relations-refusal-${Date.now()}`);
  await pinActiveProject(page, project.id);
  const { baseURL, loopbackSecret } = loomDaemon;

  const aTitle = uniq("cycle-a");
  const bTitle = uniq("cycle-b");
  const a = await loomDaemon.createTask(project.id, { title: aTitle, columnKey: "todo" });
  const b = await loomDaemon.createTask(project.id, { title: bTitle, columnKey: "todo" });
  // A already blocks B. Declaring A blocked-by B closes the loop, so the daemon's planner refuses it.
  await setStructure(baseURL, loopbackSecret, a.id, { blocks: [b.id] });

  await page.setViewportSize({ width: 1400, height: 950 });
  await page.goto(`${loomDaemon.baseURL}/board`);
  await cardTitleText(page, aTitle).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await expect(relationRow(page, "blocks")).toContainText(bTitle);

  await openPicker(page, "blockedBy");
  await pickCard(page, bTitle.slice(0, 12), bTitle);
  await picker(page).getByLabel("Close the card picker").click();
  await saveButton(page).click();

  // The validator's own wording, placed at the SECTION (a cycle names edges on both sides, so it is not
  // one row's problem) and actionable as written rather than paraphrased into "invalid".
  const refusal = dialog.getByTestId("relations-error-graph");
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText("blocks cycle");
  await expect(refusal).toContainText("drop one of the edges");
  await shoot(dialog, "board-relations-cycle-refused.png");
  // REFUSED, not partially applied: nothing was stored, and the edit is still staged so it can be fixed.
  expect((await readTask(baseURL, loopbackSecret, a.id)).relations.blockedBy).toEqual([]);
  await expect(saveButton(page)).toBeEnabled();

  // ── A FIELD-scoped refusal lands on its OWN ROW instead of the section ───────────────────────────
  // Reached the way it really happens: stage a relation, have the target card disappear underneath you
  // (an agent closing and deleting it), then save. The validator answers with a `blockedBy:`-prefixed
  // message, which is a different placement from the cycle above — and the two placements are the whole
  // point of relationErrorTarget, so both are exercised rather than one assumed from the other.
  const vanishTitle = uniq("cycle-vanishing");
  const vanish = await loomDaemon.createTask(project.id, { title: vanishTitle, columnKey: "todo" });
  await page.reload();
  await cardTitleText(page, aTitle).click();
  await expect(dialog).toBeVisible();
  await openPicker(page, "related");
  await pickCard(page, vanishTitle.slice(0, 18), vanishTitle);
  await picker(page).getByLabel("Close the card picker").click();
  await expect(relationRow(page, "related")).toContainText(vanishTitle);

  const del = await fetch(`${baseURL}/api/tasks/${vanish.id}`, {
    method: "DELETE", headers: { authorization: `Bearer ${loopbackSecret}` },
  });
  expect(del.ok).toBe(true);
  await saveButton(page).click();

  const fieldRefusal = dialog.getByTestId("relations-error-related");
  await expect(fieldRefusal).toBeVisible();
  await expect(fieldRefusal).toContainText("related:");
  await expect(fieldRefusal).toContainText("not found in this project");
  // It sits INSIDE that kind's row, not at the section head — the cycle slot stays empty for this shape.
  await expect(relationRow(page, "related")).toContainText("not found in this project");
  await expect(dialog.getByTestId("relations-error-graph")).toHaveCount(0);
  await shoot(dialog, "board-relations-field-refused.png");
});
