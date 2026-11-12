// Card 99b98864 (Atlas audit B-14, B-17, G-05, G-06): plain language in the Timeline, Replay, transcript and
// companion states.
//
// - G-05: an event row shows a plain-English label ("Started worker"), keeps the raw kind reachable on its
//   `title` + `data-event-kind`, and its w:/t: tokens are real links that navigate.
// - G-06: the transcript empty state reads as a sentence, not "engine session id not captured".
// - B-17: on Replay at phone width the N/M counter sits inside the viewport and Play stays one line.
// - B-14: an unbound companion's "connected" pill no longer claims reachability (neutral, with a hover
//   that says what it measures), so the "won't reach it" notice is the one voice for reachability.
import { expect, test, type Page } from "./fixtures/daemon";

const PROJECT_KEY = "loom.projectId";

async function pinProject(page: Page, projectId: string) {
  await page.addInitScript(([key, id]) => {
    try { localStorage.setItem(key, id); } catch { /* unavailable */ }
  }, [PROJECT_KEY, projectId] as const);
}

test.describe("plain language in event, transcript and companion states (card 99b98864)", () => {
  test("Timeline rows read as plain English, keep the raw kind, and link the worker and the card",
    async ({ page, loomDaemon }) => {
      test.setTimeout(120_000);
      const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "PlainMgr" });
      const wk = await loomDaemon.seedLiveSession({
        project: mgr.project, role: "worker", agentName: "PlainDev", parentSessionId: mgr.sessionId,
        task: { title: `plain-language card ${Date.now()}` },
      });
      const taskId = wk.taskId!;
      await loomDaemon.seedOrchestrationEvent({ managerSessionId: mgr.sessionId, kind: "spawn_worker", workerSessionId: wk.sessionId, taskId });
      await loomDaemon.seedOrchestrationEvent({ managerSessionId: mgr.sessionId, kind: "worker_report", workerSessionId: wk.sessionId, taskId, detail: { status: "done" } });
      await pinProject(page, mgr.projectId);

      await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);
      await page.getByRole("tab", { name: "Timeline" }).click();
      const rows = page.getByTestId("activity-event");
      // FIXTURE IDENTITY: exactly this manager's two seeded events.
      await expect(rows, "the manager's two seeded events are not on its Timeline").toHaveCount(2);

      const spawn = rows.filter({ has: page.locator('[data-event-kind="spawn_worker"]') });
      const kind = spawn.getByTestId("activity-event-kind");
      await expect(kind).toHaveText("Started worker");
      await expect(kind, "the raw kind is no longer reachable from the row").toHaveAttribute("title", "spawn_worker");
      await expect(rows.filter({ has: page.locator('[data-event-kind="worker_report"]') }).getByTestId("activity-event-kind"))
        .toHaveText("Worker done");
      // Old copy gone: no row prints a snake_case kind as its label.
      await expect(page.getByTestId("activity-event-kind").filter({ hasText: /_/ })).toHaveCount(0);

      // The detail column's text is unchanged (existing identity filters key on it); its tokens are now links.
      await expect(spawn.getByTestId("activity-event-detail")).toHaveText(`w:${wk.sessionId.slice(0, 8)} t:${taskId.slice(0, 8)}`);
      await expect(spawn.getByTestId("activity-event-task-link")).toHaveAttribute("href", `/board?task=${taskId}`);
      const workerLink = spawn.getByTestId("activity-event-worker-link");
      await expect(workerLink).toHaveAttribute("href", `/session/${wk.sessionId}`);

      // EXERCISE it: the link actually navigates to the worker's session node.
      await workerLink.click();
      await expect(page).toHaveURL(new RegExp(`/session/${wk.sessionId}`));
    });

  test("the transcript empty state is a plain sentence", async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "QuietMgr" });
    await pinProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);
    await page.getByRole("tab", { name: "Transcript" }).click();
    await expect(page.getByText("Nothing recorded yet. The transcript appears after this session's first turn.")).toBeVisible();
    await expect(page.getByText(/engine session id not captured/)).toHaveCount(0);
  });

  test("Replay at phone width keeps the counter on screen and Play on one line", async ({ page, loomDaemon }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "NarrowWave" });
    for (const kind of ["spawn_worker", "worker_report", "merge_request", "worker_context_high", "session_recovery_abandoned"]) {
      await loomDaemon.seedOrchestrationEvent({ managerSessionId: mgr.sessionId, kind });
    }
    await pinProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/home?tab=replay`);
    const wave = page.getByTestId("atlas-replay-wave");
    await wave.getByRole("combobox").first().selectOption(mgr.sessionId);
    const position = wave.getByTestId("audit-replay-position");
    await expect(position, "the 5-event wave never loaded").toHaveText("5/5");

    const box = (await position.boundingBox())!;
    expect(box.x + box.width, "the N/M counter runs past the viewport's right edge").toBeLessThanOrEqual(390);
    const play = wave.getByRole("button", { name: /Play/ });
    const stepBack = wave.getByRole("button", { name: "‹" });
    const [playBox, backBox] = [(await play.boundingBox())!, (await stepBack.boundingBox())!];
    expect(Math.round(playBox.height), "Play wrapped onto two lines (taller than its single-line neighbour)")
      .toBeLessThanOrEqual(Math.round(backBox.height) + 1);

    // The Replay row uses the same plain labels, with the raw kind kept on its hover.
    const kind = wave.locator('[data-testid="audit-replay-event-kind"][data-event-kind="spawn_worker"]');
    await expect(kind).toHaveText("Started worker");
    await expect(kind).toHaveAttribute("title", "spawn_worker");
  });

  test("an unbound companion's connected pill does not claim reachability", async ({ page, loomDaemon }) => {
    test.setTimeout(90_000);
    // seedCompanion writes a config with NO in-app binding: the B-14 "not reachable" state.
    await loomDaemon.seedCompanion();
    await page.goto(`${loomDaemon.baseURL}/companion`);
    const conn = page.getByTestId("companion-chat-conn");
    await expect(conn.getByText("connected", { exact: true }), "the chat socket never opened").toBeVisible({ timeout: 30_000 });
    await expect(conn).toHaveAttribute("data-armed", "false");
    await expect(conn).toHaveAttribute("title", /won't reach the companion/);
    // The reachability voice is the notice, and it is on screen beside the neutral pill.
    await expect(page.getByText(/so a message won't reach it/)).toBeVisible();
  });
});
