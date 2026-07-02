// Smoke spec (card c3fd1d68) — proves the whole isolated-daemon harness loop works end to end: seed a
// project + a task straight into the daemon's store via REST, load the real built web app in a real
// browser, and confirm the seeded card renders on the board. Every later per-feature spec (the rollout's
// phase 2) builds on this same `loomDaemon` fixture.
import { expect, test } from "./fixtures/daemon";

test("seeded task renders as a card on the board", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject();
  const task = await loomDaemon.createTask(project.id, { title: `smoke-card-${Date.now()}` });

  await page.goto(`${loomDaemon.baseURL}/board`);

  await expect(page.getByText(task.title, { exact: true })).toBeVisible();
});
