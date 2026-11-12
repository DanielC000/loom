// Card ↔ worker ↔ review links (card fa4234ab, Atlas audit B finding G-01).
//
// Three hops the owner makes every day, each EXERCISED rather than only drawn:
//   1. the worker pill on a board card is a link: clicking it lands on that worker's session node;
//   2. the card dialog's Worker row names the worker and links out — "Open session ↗" always, and
//      "Review diff ↗" only while a merge request for THIS worker is pending; with unsaved edits a
//      plain click is held for the discard confirm instead of silently dropping the draft;
//   3. the Overview's Needs-you merge-request row names the CARD, not just "w:<id>".
//
// FIXTURE IDENTITY: the e2e daemon is shared across spec files, so every locator is scoped to this
// run's own session ids or a per-run title, never to text a sibling spec could also render.
import { randomUUID } from "node:crypto";
import { expect, test, type LoomDaemon, type Page } from "./fixtures/daemon";

// lib/activeProject.tsx owns the project key (e2e tsconfig can't import src/).
const PROJECT_KEY = "loom.projectId";

async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([projectKey, id]) => {
    try {
      if (localStorage.getItem(projectKey) === null) localStorage.setItem(projectKey, id);
    } catch { /* storage unavailable — assertions will say so */ }
  }, [PROJECT_KEY, projectId] as const);
}

/** A live manager, a worker with a pending merge request, and a second worker with none. */
async function seed(loomDaemon: LoomDaemon) {
  const run = randomUUID().slice(0, 8);
  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: `LinksMgr-${run}` });
  const reviewer = await loomDaemon.seedLiveSession({
    project: mgr.project, agentId: mgr.agentId, role: "worker", parentSessionId: mgr.sessionId,
    id: `r${run.slice(0, 7)}-${randomUUID()}`, branch: `loom/review-${run}`,
    task: { title: `review-card-${run}` },
  });
  const worker = await loomDaemon.seedLiveSession({
    project: mgr.project, agentId: mgr.agentId, role: "worker", parentSessionId: mgr.sessionId, busy: true,
    id: `w${run.slice(0, 7)}-${randomUUID()}`, branch: `loom/work-${run}`,
    task: { title: `working-card-${run}` },
  });
  await loomDaemon.seedOrchestrationEvent({
    managerSessionId: mgr.sessionId, kind: "merge_request",
    workerSessionId: reviewer.sessionId, taskId: reviewer.taskId,
  });
  return { mgr, reviewer, worker, projectId: mgr.projectId };
}

const card = (page: Page, title: string) => page.locator(".loom-board-card").filter({ hasText: title });
const openCard = (page: Page, title: string) => page.locator(".loom-board-open").filter({ hasText: title }).click();

test.describe("board card links to its worker session and review (card fa4234ab)", () => {
  test("the worker pill on a card opens that worker's session", async ({ page, loomDaemon }) => {
    const s = await seed(loomDaemon);
    await pinProject(page, s.projectId);
    await page.goto(loomDaemon.baseURL + "/board");

    const link = card(page, s.reviewer.taskTitle!).getByTestId("card-worker-link");
    await expect(link).toHaveAttribute("href", `/session/${s.reviewer.sessionId}`);
    // Not a Tab stop: the board keeps its single roving stop (card 591fe6ed).
    await expect(link).toHaveAttribute("tabindex", "-1");
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/session/${s.reviewer.sessionId}$`));
  });

  test("clicking the card's branch chip still opens the card dialog", async ({ page, loomDaemon }) => {
    const s = await seed(loomDaemon);
    await pinProject(page, s.projectId);
    await page.goto(loomDaemon.baseURL + "/board");

    await expect(page.getByTestId("card-worker-row")).toHaveCount(0);
    await card(page, s.worker.taskTitle!).getByText(`loom/work-`).click();
    await expect(page.getByTestId("card-worker-row")).toBeVisible();
    await expect(page).toHaveURL(/\/board/);
  });

  test("the dialog's Worker row: Review diff only while a merge request is pending", async ({ page, loomDaemon }) => {
    const s = await seed(loomDaemon);
    await pinProject(page, s.projectId);
    await page.goto(loomDaemon.baseURL + "/board");

    // The working card: a session link, no review link.
    await openCard(page, s.worker.taskTitle!);
    const workRow = page.getByTestId("card-worker-row");
    await expect(workRow).toContainText("working");
    await expect(workRow.getByTestId("card-worker-session")).toHaveAttribute("href", `/session/${s.worker.sessionId}`);
    await expect(workRow.getByTestId("card-worker-review")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(workRow).toHaveCount(0);

    // The card whose worker asked for review: both links, and Review lands on its diff.
    await openCard(page, s.reviewer.taskTitle!);
    const reviewRow = page.getByTestId("card-worker-row");
    // The workers are seeded on the manager's agent, so that is the name the row must carry.
    await expect(reviewRow).toContainText(s.mgr.agentName);
    await expect(reviewRow.getByTestId("card-worker-session")).toHaveAttribute("href", `/session/${s.reviewer.sessionId}`);
    const review = reviewRow.getByTestId("card-worker-review");
    await expect(review).toHaveAttribute("href", `/review/${s.reviewer.sessionId}`);
    await review.click();
    await expect(page).toHaveURL(new RegExp(`/review/${s.reviewer.sessionId}$`));
  });

  test("with unsaved edits, Open session asks before leaving and keeps the draft on Cancel", async ({ page, loomDaemon }) => {
    const s = await seed(loomDaemon);
    await pinProject(page, s.projectId);
    await page.goto(loomDaemon.baseURL + "/board");

    await openCard(page, s.worker.taskTitle!);
    const titleInput = page.getByTestId("task-edit-column").locator("input").first();
    await titleInput.fill(`${s.worker.taskTitle} draft`);
    await page.getByTestId("card-worker-session").click();

    await expect(page.getByText("Discard unsaved changes and leave the board?")).toBeVisible();
    await expect(page).toHaveURL(/\/board/);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(titleInput).toHaveValue(`${s.worker.taskTitle} draft`);

    await page.getByTestId("card-worker-session").click();
    await page.getByRole("button", { name: "Discard and leave" }).click();
    await expect(page).toHaveURL(new RegExp(`/session/${s.worker.sessionId}$`));
  });

  test("the Overview's merge-request row names the card", async ({ page, loomDaemon }) => {
    const s = await seed(loomDaemon);
    await pinProject(page, s.projectId);
    await page.goto(loomDaemon.baseURL + "/project");

    const row = page.getByTestId("atlas-band-needs")
      .locator(`[data-testid="attention-row"][data-session-id="${s.reviewer.sessionId}"]`);
    await expect(row).toHaveAttribute("data-kind", "MERGE REQUEST");
    await expect(row.getByTestId("attention-row-text"))
      .toHaveText(`${s.reviewer.taskTitle} · w:${s.reviewer.sessionId.slice(0, 8)} · awaiting review`);
  });
});
