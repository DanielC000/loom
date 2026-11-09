// Card dialog layout (card 92259dac, Atlas audit B: B-08, B-15, I-01, I-02, G-03).
//
// Every check is an observable state change or a measured position, never "it rendered":
//   B-08  the footer (Save / Reset / unsaved state / Delete) stays inside the viewport on a long card at
//         1024x768, and a staged edit flips it from "saved" to "Unsaved changes" with Save enabled;
//   I-01  the dialog reads Title, then Priority, then Relations, then Children (measured top-to-bottom);
//   I-02  Hold and Defer share one row;
//   G-03  "+ Add child card" creates a REAL child (read back from the daemon with parentId set) and the
//         Children list grows, while Esc in that field closes the field, never the dialog;
//   B-15  below 600px the requests rail is a full-width disclosure row, not a side strip.
//
// FIXTURE IDENTITY: the e2e daemon is shared across spec files, so each test seeds its OWN project, pins
// it active, and asserts on per-run titles.
import { randomUUID } from "node:crypto";
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

const LONG_BODY = Array.from({ length: 40 }, (_, i) =>
  `Line ${i + 1}: a body long enough that the footer would sit below the panel edge without a pinned footer.`).join("\n");

interface Seed { projectId: string; epicId: string; epicTitle: string; childTitles: string[] }

async function seedEpic(loomDaemon: LoomDaemon): Promise<Seed> {
  const run = randomUUID().slice(0, 8);
  const project = await loomDaemon.createProject(`dialog-layout-${run}`);
  const epicTitle = `dialog-epic-${run}`;
  const epic = await loomDaemon.createTask(project.id, { title: epicTitle, body: LONG_BODY, columnKey: "backlog" });
  const childTitles = [`dialog-child-a-${run}`, `dialog-child-b-${run}`];
  for (const title of childTitles) {
    const res = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/tasks`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, columnKey: "backlog", parentId: epic.id }),
    });
    expect(res.ok, `seed child ${title}`).toBe(true);
  }
  return { projectId: project.id, epicId: epic.id, epicTitle, childTitles };
}

async function openCard(page: Page, loomDaemon: LoomDaemon, taskId: string) {
  await page.goto(`${loomDaemon.baseURL}/board?task=${encodeURIComponent(taskId)}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

const topOf = async (page: Page, selector: string) =>
  (await page.locator(selector).first().boundingBox())!.y;

test("a long card keeps its footer in view, reads Title → Priority → Relations → Children, and stages state visibly", async ({ page, loomDaemon }) => {
  const seed = await seedEpic(loomDaemon);
  await pinActiveProject(page, seed.projectId);
  await page.setViewportSize({ width: 1024, height: 768 });
  const dialog = await openCard(page, loomDaemon, seed.epicId);
  // Fixture identity: this run's epic, with this run's two children.
  await expect(dialog.getByRole("textbox").first()).toHaveValue(seed.epicTitle);
  const links = dialog.getByTestId("task-links");
  for (const t of seed.childTitles) await expect(links.getByText(t)).toBeVisible();

  // B-08: the footer is fully on screen, and the content above it really does overflow (so the pinned
  // footer is what keeps it there, not a short card).
  const footer = dialog.getByTestId("task-dialog-footer");
  await expect(footer).toBeInViewport({ ratio: 1 });
  const scroll = dialog.getByTestId("task-dialog-scroll");
  expect(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(footer).toBeInViewport({ ratio: 1 });
  await scroll.evaluate((el) => { el.scrollTop = 0; });

  // I-01: measured order.
  const edit = dialog.getByTestId("task-edit-column");
  const titleY = (await edit.getByText("Title", { exact: true }).boundingBox())!.y;
  const priorityY = (await edit.getByText("Priority", { exact: true }).boundingBox())!.y;
  const relationsY = (await edit.getByText("Relations", { exact: true }).boundingBox())!.y;
  const childrenY = (await links.boundingBox())!.y;
  expect(titleY).toBeLessThan(priorityY);
  expect(priorityY).toBeLessThan(relationsY);
  expect(relationsY).toBeLessThan(childrenY);

  // I-02: one row.
  const hold = dialog.getByRole("switch", { name: "Held — won't be worked or nagged" });
  const defer = dialog.getByRole("switch", { name: "Deferred — sequencing marker, won't nag" });
  const holdBox = (await hold.boundingBox())!;
  const deferBox = (await defer.boundingBox())!;
  expect(Math.abs(holdBox.y - deferBox.y)).toBeLessThan(2);
  expect(deferBox.x).toBeGreaterThan(holdBox.x + holdBox.width - 1);

  // Staging: clean → disabled Save and NO "saved" (nothing has been saved yet, card f58b1250); toggle
  // Hold → "Unsaved changes" + enabled Save + Reset.
  const save = footer.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await expect(footer.getByTestId("task-dialog-saved")).toHaveCount(0);
  await expect(footer.getByTestId("task-dialog-unsaved")).toHaveCount(0);
  await hold.click();
  await expect(hold).toHaveAttribute("aria-checked", "true");
  await expect(footer.getByTestId("task-dialog-unsaved")).toHaveText("Unsaved changes");
  await expect(save).toBeEnabled();
  await expect(footer.getByRole("button", { name: "Reset", exact: true })).toBeVisible();

  // The dirty-Esc guard still fires (kept as-is per the card).
  await page.keyboard.press("Escape");
  await expect(dialog.getByText("Discard unsaved changes?", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // Save lands on the daemon and only now does the footer read "saved".
  await save.click();
  await expect(footer.getByTestId("task-dialog-saved")).toHaveText("saved");
  await expect(footer.getByTestId("task-dialog-unsaved")).toHaveCount(0);
  const stored = await (await fetch(`${loomDaemon.baseURL}/api/tasks/${seed.epicId}`)).json() as { held?: boolean };
  expect(stored.held).toBe(true);
});

test("+ Add child card creates a real child of this card, and Esc closes only the field", async ({ page, loomDaemon }) => {
  const seed = await seedEpic(loomDaemon);
  await pinActiveProject(page, seed.projectId);
  await page.setViewportSize({ width: 1440, height: 900 });
  const dialog = await openCard(page, loomDaemon, seed.epicId);
  const links = dialog.getByTestId("task-links");
  await expect(links.getByText("0/2 done")).toBeVisible();

  // Esc inside the field closes the field and leaves the dialog open.
  await dialog.getByTestId("add-child-open").click();
  const field = dialog.getByRole("textbox", { name: "New child card title" });
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(dialog).toBeVisible();

  const childTitle = `dialog-child-new-${randomUUID().slice(0, 8)}`;
  await dialog.getByTestId("add-child-open").click();
  await field.fill(childTitle);
  await dialog.getByRole("button", { name: "Add child", exact: true }).click();
  await expect(dialog.getByTestId("add-child").getByText(`Added "${childTitle}" to Inbox`)).toBeVisible();
  await expect(field).toHaveValue("");
  await expect(links.getByText(childTitle)).toBeVisible();
  await expect(links.getByText("0/3 done")).toBeVisible();
  // Adding a child is a create, not a staged edit: the dialog stays clean.
  await expect(dialog.getByTestId("task-dialog-unsaved")).toHaveCount(0);

  // Read back from the daemon: a real card, filed under THIS epic.
  const tasks = await (await fetch(`${loomDaemon.baseURL}/api/projects/${seed.projectId}/tasks`)).json() as
    { id: string; title: string; parentId?: string | null; columnKey: string }[];
  const child = tasks.find((t) => t.title === childTitle);
  expect(child, "the new child card exists").toBeTruthy();
  expect(child!.parentId).toBe(seed.epicId);
  expect(child!.columnKey).toBe("inbox");
});

test("below 600px the connected requests are a full-width disclosure row, not a side strip", async ({ page, loomDaemon }) => {
  const seed = await seedEpic(loomDaemon);
  await pinActiveProject(page, seed.projectId);
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = await openCard(page, loomDaemon, seed.epicId);

  await expect(dialog.getByTestId("task-requests-collapsed")).toHaveCount(0);
  const row = dialog.getByTestId("task-requests-disclosure");
  await expect(row).toBeVisible();
  // The form gets the whole scroll width: no 36px strip beside it.
  const edit = (await dialog.getByTestId("task-edit-column").boundingBox())!;
  const scroll = (await dialog.getByTestId("task-dialog-scroll").boundingBox())!;
  expect(edit.width).toBeGreaterThan(scroll.width - 40);
  // Above Description.
  const descY = (await dialog.getByText("Description", { exact: true }).boundingBox())!.y;
  expect((await row.boundingBox())!.y).toBeLessThan(descY);

  await row.click();
  const rail = dialog.getByTestId("task-requests-rail");
  await expect(rail).toBeVisible();
  await expect(row).toHaveCount(0);
  expect((await rail.boundingBox())!.width).toBeGreaterThan(scroll.width - 40);
  await dialog.getByTestId("task-requests-collapse").click();
  await expect(rail).toHaveCount(0);
  await expect(row).toBeVisible();

  await expect(dialog.getByTestId("task-dialog-footer")).toBeInViewport({ ratio: 1 });
  expect(await dialog.getByTestId("task-dialog-scroll").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
