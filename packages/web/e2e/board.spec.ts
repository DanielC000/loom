// Board spec (card fd97f3fc) — drives the real kanban board (/board) against the isolated, seeded daemon
// and asserts on the rendered UI, not just "renders clean". Every interactive control is exercised with an
// OBSERVABLE before/after change (DOM visibility, the live "N of M shown" count, or a REST read-back off the
// same task store the board and the MCP tools share). Builds on the shared `loomDaemon` fixture (card
// c3fd1d68); smoke.spec.ts is the one-card template and settings.spec.ts is the multi-test / active-project
// pattern this follows.
//
// Determinism note (same as settings.spec.ts): the board is scoped to the ACTIVE project (localStorage
// `loom.projectId`, see lib/activeProject.tsx), and the worker-scoped daemon is SHARED across the specs in
// this file — so more than one project exists on it and the auto-resolved "first project" is not stable.
// Every test therefore seeds its OWN project and PINS it active via addInitScript BEFORE navigating, so it
// never races another test's project. Because each project is fresh, the "N of M shown" total is exactly the
// cards that test seeded.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

// The default board (shared/src/config.ts PLATFORM_DEFAULTS.kanbanColumns) a freshly-seeded project resolves
// to. Order + labels are asserted below, so they live in one place.
const DEFAULT_LANES = ["Inbox", "Backlog", "To Do", "In Progress", "Waiting", "Review", "Done"] as const;

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// A board lane (Column) is the `.loom-grid` wrapper whose header carries the lane label. `.loom-grid` is used
// ONLY by board columns on this route (Board.tsx:308; the shared Panel `grid` prop is the only other user and
// the board route never mounts one), and the header label <span> is an exact-text match — so this resolves to
// exactly one element per lane. Scoping a card assertion through it proves the card sits in the RIGHT lane
// (the column filter chips share the label text but live outside `.loom-grid`, so they never interfere).
function lane(page: Page, label: string) {
  return page.locator(".loom-grid").filter({ has: page.getByText(label, { exact: true }) });
}

// A card is a title <span> inside its lane's subtree. Exact match so one title is never a substring of another.
function cardInLane(page: Page, laneLabel: string, title: string) {
  return lane(page, laneLabel).getByText(title, { exact: true });
}

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test("renders the default lanes and each seeded card in its own lane", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-lanes-${Date.now()}`);
  await pinActiveProject(page, project.id);

  // One card per lane-of-interest, each with a unique title so lane membership is unambiguous.
  const inboxTitle = uniq("card-inbox");
  const todoTitle = uniq("card-todo");
  const progressTitle = uniq("card-progress");
  await loomDaemon.createTask(project.id, { title: inboxTitle, columnKey: "inbox" });
  await loomDaemon.createTask(project.id, { title: todoTitle, columnKey: "todo" });
  await loomDaemon.createTask(project.id, { title: progressTitle, columnKey: "in_progress" });

  await page.goto(`${loomDaemon.baseURL}/board`);

  // All seven default lanes render, in order.
  for (const label of DEFAULT_LANES) {
    await expect(lane(page, label)).toBeVisible();
  }

  // Each card renders in the lane it was seeded into…
  await expect(cardInLane(page, "Inbox", inboxTitle)).toBeVisible();
  await expect(cardInLane(page, "To Do", todoTitle)).toBeVisible();
  await expect(cardInLane(page, "In Progress", progressTitle)).toBeVisible();
  // …and NOT in a foreign lane (the grouping is real, not "every card in every column").
  await expect(cardInLane(page, "To Do", inboxTitle)).toHaveCount(0);
  await expect(cardInLane(page, "Inbox", todoTitle)).toHaveCount(0);
});

test("search-by-id filters to a single card and updates the live count", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-search-${Date.now()}`);
  await pinActiveProject(page, project.id);

  const titleA = uniq("alpha");
  const titleB = uniq("bravo");
  const a = await loomDaemon.createTask(project.id, { title: titleA, columnKey: "todo" });
  await loomDaemon.createTask(project.id, { title: titleB, columnKey: "todo" });

  await page.goto(`${loomDaemon.baseURL}/board`);

  // BEFORE: both cards on the board, the count reflects the fresh project's two cards.
  await expect(cardInLane(page, "To Do", titleA)).toBeVisible();
  await expect(cardInLane(page, "To Do", titleB)).toBeVisible();
  await expect(page.getByText("2 of 2 shown")).toBeVisible();

  // Search by the FIRST card's id prefix — the id is a real search handle (taskFilter.ts includes it), and a
  // prefix substring-matches the full lowercase-hex id.
  const search = page.getByLabel("Search tasks by id, title, or description");
  await search.fill(a.id.slice(0, 8));

  // AFTER: only card A survives, card B is filtered out, and the count drops — three independent observables.
  await expect(cardInLane(page, "To Do", titleA)).toBeVisible();
  await expect(cardInLane(page, "To Do", titleB)).toHaveCount(0);
  await expect(page.getByText("1 of 2 shown")).toBeVisible();

  // Clearing restores the full board (the "Clear filters" affordance only appears while a filter is active).
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(cardInLane(page, "To Do", titleB)).toBeVisible();
  await expect(page.getByText("2 of 2 shown")).toBeVisible();
});

test("a column filter chip narrows the board to that lane", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-colfilter-${Date.now()}`);
  await pinActiveProject(page, project.id);

  const todoTitle = uniq("in-todo");
  const reviewTitle = uniq("in-review");
  await loomDaemon.createTask(project.id, { title: todoTitle, columnKey: "todo" });
  await loomDaemon.createTask(project.id, { title: reviewTitle, columnKey: "review" });

  await page.goto(`${loomDaemon.baseURL}/board`);
  await expect(cardInLane(page, "To Do", todoTitle)).toBeVisible();
  await expect(cardInLane(page, "Review", reviewTitle)).toBeVisible();

  // Toggle the "To Do" column filter on (aria-pressed is the toggle's own observable).
  const todoChip = page.getByRole("button", { name: "Filter by To Do column" });
  await expect(todoChip).toHaveAttribute("aria-pressed", "false");
  await todoChip.click();
  await expect(todoChip).toHaveAttribute("aria-pressed", "true");

  // AFTER: only the To Do card survives the filter; the Review card is hidden; the count reflects it.
  await expect(cardInLane(page, "To Do", todoTitle)).toBeVisible();
  await expect(cardInLane(page, "Review", reviewTitle)).toHaveCount(0);
  await expect(page.getByText("1 of 2 shown")).toBeVisible();
});

test("opening a card shows its body in the detail drawer", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-open-${Date.now()}`);
  await pinActiveProject(page, project.id);

  const title = uniq("openable");
  const body = `body text ${uniq("desc")}`;
  const task = await loomDaemon.createTask(project.id, { title, body, columnKey: "todo" });

  await page.goto(`${loomDaemon.baseURL}/board`);

  // Click the card body to open the drawer (the drag grip is a separate span; the title area is the open target).
  await cardInLane(page, "To Do", title).click();

  // The drawer headers with the short task id, and the description textarea carries the seeded body — proving
  // the drawer read the `body` field the card itself never surfaces.
  await expect(page.getByText(`Task · ${task.id.slice(0, 8)}`)).toBeVisible();
  await expect(page.locator("textarea")).toHaveValue(body);
});

test("creating a card through the UI adds it to the Inbox lane and the store", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-create-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/board`);

  const title = uniq("created-via-ui");
  const input = page.getByPlaceholder("new task title");
  await input.fill(title);
  await page.getByRole("button", { name: "Add to Inbox" }).click();

  // Observable #1: the new card renders in the Inbox lane (NewTask posts columnKey "inbox").
  await expect(cardInLane(page, "Inbox", title)).toBeVisible();
  // Observable #2: the compose input clears after a successful add.
  await expect(input).toHaveValue("");
  // Observable #3: it persisted to the shared task store — read it straight back over REST.
  await expect
    .poll(async () => {
      const res = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/tasks`);
      const tasks = (await res.json()) as Array<{ title: string; columnKey: string }>;
      return tasks.find((t) => t.title === title)?.columnKey ?? null;
    })
    .toBe("inbox");
});

test("editing a card's title in the drawer reflects on the board and in the store", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-edit-${Date.now()}`);
  await pinActiveProject(page, project.id);

  const original = uniq("original-title");
  const updated = uniq("updated-title");
  const task = await loomDaemon.createTask(project.id, { title: original, columnKey: "todo" });

  await page.goto(`${loomDaemon.baseURL}/board`);
  await cardInLane(page, "To Do", original).click();

  // The drawer's Title field is the <input> immediately following its "Title" label span (priority/hold/close
  // are buttons and the body is a <textarea>, so this is the only text input in the open drawer).
  const drawerTitle = page.locator('span:text-is("Title") + input');
  await drawerTitle.fill(updated);
  await page.getByRole("button", { name: "Save", exact: true }).click();

  // Observable #1: the board card now shows the new title, and the old title is gone.
  await expect(cardInLane(page, "To Do", updated)).toBeVisible();
  await expect(cardInLane(page, "To Do", original)).toHaveCount(0);
  // Observable #2: the edit persisted to the shared store.
  await expect
    .poll(async () => {
      const res = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/tasks`);
      const tasks = (await res.json()) as Array<{ id: string; title: string }>;
      return tasks.find((t) => t.id === task.id)?.title ?? null;
    })
    .toBe(updated);
});

test("a held card shows as held, and releasing the hold in the drawer clears it", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-held-${Date.now()}`);
  await pinActiveProject(page, project.id);

  const title = uniq("held-card");
  const task = await loomDaemon.createTask(project.id, { title, columnKey: "todo" });
  // `held` has no REST create field — set it through the same PATCH the drawer's Hold switch uses.
  {
    const res = await fetch(`${loomDaemon.baseURL}/api/tasks/${task.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ held: true }),
    });
    expect(res.ok).toBeTruthy();
  }

  await page.goto(`${loomDaemon.baseURL}/board`);

  // BEFORE: the card wears the "held" badge (the owner's-brake signal), in its To Do lane.
  await expect(cardInLane(page, "To Do", title)).toBeVisible();
  await expect(lane(page, "To Do").getByText("held", { exact: true })).toBeVisible();

  // Release the hold through the UI: open the drawer, flip the Hold switch off, Save.
  // Scoped by name — the drawer has a second switch (Defer, card 77d33266), so an unscoped
  // getByRole("switch") would now be ambiguous.
  await cardInLane(page, "To Do", title).click();
  const holdSwitch = page.getByRole("switch", { name: /held/i });
  await expect(holdSwitch).toHaveAttribute("aria-checked", "true");
  await holdSwitch.click();
  await expect(holdSwitch).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  // AFTER (observable #1): the badge is gone from the board.
  await expect(lane(page, "To Do").getByText("held", { exact: true })).toHaveCount(0);
  // AFTER (observable #2): the release persisted to the store.
  await expect
    .poll(async () => {
      const res = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/tasks`);
      const tasks = (await res.json()) as Array<{ id: string; held?: boolean }>;
      return tasks.find((t) => t.id === task.id)?.held ?? false;
    })
    .toBe(false);
});

test("a deferred card shows as deferred (distinct from held), and un-deferring in the drawer clears it", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-deferred-${Date.now()}`);
  await pinActiveProject(page, project.id);

  const title = uniq("deferred-card");
  const task = await loomDaemon.createTask(project.id, { title, columnKey: "todo" });
  // `deferred` has no REST create field — set it through the same PATCH the drawer's Defer switch uses.
  {
    const res = await fetch(`${loomDaemon.baseURL}/api/tasks/${task.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deferred: true }),
    });
    expect(res.ok).toBeTruthy();
  }

  await page.goto(`${loomDaemon.baseURL}/board`);

  // BEFORE: the card wears the "deferred" badge — a DISTINCT marker from "held" (never rendered here).
  await expect(cardInLane(page, "To Do", title)).toBeVisible();
  await expect(lane(page, "To Do").getByText("deferred", { exact: true })).toBeVisible();
  await expect(lane(page, "To Do").getByText("held", { exact: true })).toHaveCount(0);

  // Clear the defer through the UI: open the drawer, flip the Defer switch off, Save.
  await cardInLane(page, "To Do", title).click();
  const deferSwitch = page.getByRole("switch", { name: /deferred/i });
  await expect(deferSwitch).toHaveAttribute("aria-checked", "true");
  // The Hold switch stays untouched (off) — proves the two markers are independent controls.
  await expect(page.getByRole("switch", { name: /held/i })).toHaveAttribute("aria-checked", "false");
  await deferSwitch.click();
  await expect(deferSwitch).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  // AFTER (observable #1): the badge is gone from the board.
  await expect(lane(page, "To Do").getByText("deferred", { exact: true })).toHaveCount(0);
  // AFTER (observable #2): the release persisted to the store.
  await expect
    .poll(async () => {
      const res = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/tasks`);
      const tasks = (await res.json()) as Array<{ id: string; deferred?: boolean }>;
      return tasks.find((t) => t.id === task.id)?.deferred ?? false;
    })
    .toBe(false);
});

test("pressing Enter in the new-task field adds the card to Inbox and clears the field", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-enter-${Date.now()}`);
  await pinActiveProject(page, project.id);

  await page.goto(`${loomDaemon.baseURL}/board`);

  const title = uniq("via-enter");
  const input = page.getByPlaceholder("new task title");
  await input.fill(title);
  await input.press("Enter"); // keyboard parity with the "Add to Inbox" button

  // Observable #1: the card lands in the Inbox lane; #2: the field clears on a successful add.
  await expect(cardInLane(page, "Inbox", title)).toBeVisible();
  await expect(input).toHaveValue("");
});

test("an empty lane shows a calm empty state, not a blank column", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-empty-${Date.now()}`);
  await pinActiveProject(page, project.id);

  // One card in Inbox → every other default lane is genuinely empty (no filter active).
  await loomDaemon.createTask(project.id, { title: uniq("lone-card"), columnKey: "inbox" });

  await page.goto(`${loomDaemon.baseURL}/board`);

  // An empty lane reads "no cards yet" (deliberate empty state); the populated lane does not.
  await expect(lane(page, "Backlog").getByText("no cards yet")).toBeVisible();
  await expect(lane(page, "Inbox").getByText("no cards yet")).toHaveCount(0);
});

test("on a narrow viewport the board degrades to a horizontal-scroll lane grid without crushing lanes", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-responsive-${Date.now()}`);
  await pinActiveProject(page, project.id);
  await loomDaemon.createTask(project.id, { title: uniq("resp-card"), columnKey: "inbox" });

  // A phone-sized viewport, set BEFORE navigating so the first layout is the narrow one.
  await page.setViewportSize({ width: 380, height: 820 });
  await page.goto(`${loomDaemon.baseURL}/board`);

  await expect(lane(page, "Inbox")).toBeVisible();

  // The seven default lanes can't fit 380px, so the grid becomes a HORIZONTAL scroll region rather
  // than squeezing every lane to a sliver: its scroll width exceeds its client width.
  const grid = page.locator(".loom-board-grid").first();
  const gridOverflow = await grid.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(gridOverflow).toBeGreaterThan(0);

  // Each lane keeps a usable minimum width (the crush this fix prevents would be ~40px at repeat(7,1fr)).
  const inboxBox = await lane(page, "Inbox").boundingBox();
  expect(inboxBox).not.toBeNull();
  expect(inboxBox!.width).toBeGreaterThanOrEqual(180);

  // And the board's own content region (<main>) never forces the page to scroll sideways — the board
  // scrolls INSIDE its grid box, not by widening the page. (The app header is out of scope here.)
  const mainOverflow = await page.locator("main").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(mainOverflow).toBeLessThanOrEqual(1);
});

test("a Blocked lane added to the board renders and holds a card seeded into it", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject(`board-blocked-${Date.now()}`);
  await pinActiveProject(page, project.id);

  // The default board has no brake/blocked lane; add one through the SAME atomic columns API the board's
  // contextual column editor uses (PUT /api/projects/:id/columns replaces the whole layout). Keeping the
  // required defaultLanding + terminal roles present, we insert a role-less "Blocked" lane before Done.
  const columns = [
    { key: "inbox", label: "Inbox", role: "intake" },
    { key: "backlog", label: "Backlog", role: "defaultLanding" },
    { key: "todo", label: "To Do", role: "workReady" },
    { key: "in_progress", label: "In Progress", role: "active" },
    { key: "waiting", label: "Waiting", role: "parked" },
    { key: "review", label: "Review", role: "review" },
    { key: "blocked", label: "Blocked" },
    { key: "done", label: "Done", role: "terminal" },
  ];
  const putRes = await fetch(`${loomDaemon.baseURL}/api/projects/${project.id}/columns`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ columns }),
  });
  expect(putRes.ok).toBeTruthy();

  // Seed a card straight into the new Blocked lane (columnKey is validated against the now-resolved board).
  const blockedTitle = uniq("blocked-card");
  await loomDaemon.createTask(project.id, { title: blockedTitle, columnKey: "blocked" });

  await page.goto(`${loomDaemon.baseURL}/board`);

  // The Blocked lane is present…
  await expect(lane(page, "Blocked")).toBeVisible();
  // …and the seeded card sits in it (not spilled to the landing lane).
  await expect(cardInLane(page, "Blocked", blockedTitle)).toBeVisible();
  await expect(cardInLane(page, "Backlog", blockedTitle)).toHaveCount(0);
});
