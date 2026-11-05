// Board Columns drifted-save e2e spec (card d5946e05) — Settings › Board Columns seeds its rows once, so a
// Save used to PUT a stale whole array and silently DELETE a column an agent created meanwhile (re-homing its
// cards). The daemon now refuses (409, nothing written) when the editor's base key set drifted; the editor
// must then keep the human's staged edits, show what changed, and leave the second Save to the human.
//
//   1. ADDED elsewhere: stage a label edit → an agent adds a lane + a card on it → Save is refused, the
//      notice shows, the new lane appears in the editor, the staged edit is intact, and NOTHING moved server
//      side → Save again lands both the edit and keeps the lane + card.
//   2. REMOVED elsewhere: stage an edit on a lane → an agent deletes it (its card re-homed) → Save is refused,
//      the staged row is kept and FLAGGED "removed elsewhere", the lane is NOT silently re-created → Save
//      again (the human's conscious choice) re-creates it empty, the card stays where the agent's delete put it.
//
// The "agent" writes through the REST twin (PUT /columns with no baseKeys = the legacy blind replace, the very
// same writer board_column_create uses). FIXTURE IDENTITY: every assertion keys on UNIQUE seeded labels.
import { expect, test } from "./fixtures/daemon";

type Page = import("@playwright/test").Page;

const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

async function putColumns(baseURL: string, projectId: string, columns: Record<string, unknown>[]) {
  const res = await fetch(`${baseURL}/api/projects/${projectId}/columns`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ columns }),
  });
  expect(res.ok).toBeTruthy();
}

async function storedKeys(baseURL: string, projectId: string): Promise<string[]> {
  const res = await fetch(`${baseURL}/api/projects`);
  const projects = (await res.json()) as { id: string; config: { kanbanColumns?: { key: string }[] } }[];
  return (projects.find((p) => p.id === projectId)?.config.kanbanColumns ?? []).map((c) => c.key);
}

async function storedLabel(baseURL: string, projectId: string, key: string): Promise<string | undefined> {
  const res = await fetch(`${baseURL}/api/projects`);
  const projects = (await res.json()) as { id: string; config: { kanbanColumns?: { key: string; label: string }[] } }[];
  return projects.find((p) => p.id === projectId)?.config.kanbanColumns?.find((c) => c.key === key)?.label;
}

async function cardColumn(baseURL: string, taskId: string): Promise<string> {
  const res = await fetch(`${baseURL}/api/tasks/${taskId}`);
  return ((await res.json()) as { columnKey: string }).columnKey;
}

test("Board Columns: a column an agent adds while Settings is open survives a stale Save, and the staged edit is kept", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("coldrift-add"));
  const base = [
    { key: "todo", label: uniq("To-do"), role: "defaultLanding" },
    { key: "doing", label: uniq("Doing"), role: "active" },
    { key: "done", label: "Done", role: "terminal" },
  ];
  await putColumns(loomDaemon.baseURL, project.id, base);

  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);
  const labels = page.getByLabel("Column label");
  await expect(labels).toHaveCount(3);
  await expect(labels.nth(0)).toHaveValue(base[0]!.label); // fixture identity

  // The human stages an edit (not saved yet).
  const staged = uniq("Backlog");
  await labels.nth(0).fill(staged);
  const saveLayout = page.getByRole("button", { name: "Save layout" });
  await expect(saveLayout).toBeEnabled();

  // An agent adds a lane and files a card on it, through the same writer board_column_create uses.
  const qaLabel = uniq("QA");
  await putColumns(loomDaemon.baseURL, project.id, [...base, { key: "qa", label: qaLabel }]);
  const card = await loomDaemon.createTask(project.id, { title: uniq("qa card"), columnKey: "qa" });
  expect(await cardColumn(loomDaemon.baseURL, card.id)).toBe("qa");

  // Save → refused, with a notice; nothing is deleted or re-homed.
  await saveLayout.click();
  const notice = page.getByTestId("column-drift-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(qaLabel);
  expect(await storedKeys(loomDaemon.baseURL, project.id)).toEqual(["todo", "doing", "done", "qa"]); // agent appended it; untouched
  expect(await cardColumn(loomDaemon.baseURL, card.id)).toBe("qa");
  expect(await storedLabel(loomDaemon.baseURL, project.id, "todo")).toBe(base[0]!.label); // the edit did not land

  // The editor now lists the agent's lane AND still holds the human's staged edit.
  await expect(labels).toHaveCount(4);
  await expect(labels.nth(2)).toHaveValue(qaLabel);
  await expect(labels.nth(0)).toHaveValue(staged);
  await expect(saveLayout).toBeEnabled();

  // The human presses Save again: the edit lands, the agent's lane and card are untouched.
  await saveLayout.click();
  await expect(saveLayout).toBeDisabled();
  await expect(notice).toBeHidden();
  expect(await storedLabel(loomDaemon.baseURL, project.id, "todo")).toBe(staged);
  expect(await storedKeys(loomDaemon.baseURL, project.id)).toEqual(["todo", "doing", "qa", "done"]);
  expect(await cardColumn(loomDaemon.baseURL, card.id)).toBe("qa");
});

test("Board Columns: a lane an agent removes is kept FLAGGED on the staged row, never re-created until the human saves again", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(uniq("coldrift-rm"));
  const base = [
    { key: "todo", label: uniq("To-do"), role: "defaultLanding" },
    { key: "doing", label: uniq("Doing"), role: "active" },
    { key: "done", label: "Done", role: "terminal" },
  ];
  await putColumns(loomDaemon.baseURL, project.id, base);
  const card = await loomDaemon.createTask(project.id, { title: uniq("doing card"), columnKey: "doing" });

  await pinActiveProject(page, project.id);
  await page.goto(`${loomDaemon.baseURL}/settings`);
  const labels = page.getByLabel("Column label");
  await expect(labels).toHaveCount(3);
  await expect(labels.nth(1)).toHaveValue(base[1]!.label); // fixture identity

  // The human edits the lane that is about to disappear.
  const staged = uniq("Doing-renamed");
  await labels.nth(1).fill(staged);
  const saveLayout = page.getByRole("button", { name: "Save layout" });
  await expect(saveLayout).toBeEnabled();

  // An agent deletes that lane; its card is re-homed to the default landing.
  await putColumns(loomDaemon.baseURL, project.id, [base[0]!, base[2]!]);
  expect(await cardColumn(loomDaemon.baseURL, card.id)).toBe("todo");

  await saveLayout.click();
  const notice = page.getByTestId("column-drift-notice");
  await expect(notice).toBeVisible();
  // Nothing was written: the lane is still gone and the card still where the agent's delete put it.
  expect(await storedKeys(loomDaemon.baseURL, project.id)).toEqual(["todo", "done"]);
  expect(await cardColumn(loomDaemon.baseURL, card.id)).toBe("todo");

  // The staged row survives, flagged on the row itself.
  await expect(labels).toHaveCount(3);
  await expect(labels.nth(1)).toHaveValue(staged);
  const flag = page.getByTestId("column-removed-elsewhere");
  await expect(flag).toHaveCount(1);
  await expect(flag).toContainText("Save will re-create");

  // The human's conscious second Save re-creates it (empty); the card is NOT dragged back.
  await expect(saveLayout).toBeEnabled();
  await saveLayout.click();
  await expect(saveLayout).toBeDisabled();
  await expect(flag).toHaveCount(0);
  expect(await storedKeys(loomDaemon.baseURL, project.id)).toEqual(["todo", "doing", "done"]);
  expect(await storedLabel(loomDaemon.baseURL, project.id, "doing")).toBe(staged);
  expect(await cardColumn(loomDaemon.baseURL, card.id)).toBe("todo");
});
