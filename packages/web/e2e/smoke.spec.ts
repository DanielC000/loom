// Smoke spec (card c3fd1d68) — proves the whole isolated-daemon harness loop works end to end: seed a
// project + a task straight into the daemon's store via REST, load the real built web app in a real
// browser, and confirm the seeded card renders on the board. Every later per-feature spec (the rollout's
// phase 2) builds on this same `loomDaemon` fixture.
import { expect, test } from "./fixtures/daemon";

test("seeded task renders as a card on the board", async ({ page, loomDaemon }) => {
  const project = await loomDaemon.createProject();
  const task = await loomDaemon.createTask(project.id, { title: `smoke-card-${Date.now()}` });

  // Pin THIS project active before navigating. The worker-scoped daemon is shared across every spec, so
  // several projects exist on it; the board scopes to the active project (localStorage `loom.projectId`,
  // lib/activeProject.tsx), and its no-pin fallback is `listProjects()[0]` = the alphabetically-FIRST project
  // name (db.ts `ORDER BY name`). Relying on that fallback made this test order-fragile — a sibling spec whose
  // project names sort before this one's unnamed `e2e-…` project would steal "active" and hide this card. Every
  // other spec pins its own project for exactly this reason (settings.spec.ts / board.spec.ts).
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);

  await page.goto(`${loomDaemon.baseURL}/board`);

  await expect(page.getByText(task.title, { exact: true })).toBeVisible();
});
