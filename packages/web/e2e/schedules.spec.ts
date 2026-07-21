// Schedules UI redesign spec (card 1410f4fe) — proves Direction B (a scannable table + a modal builder,
// every schedule NAMED) does its job with an OBSERVABLE before/after for each new control:
//   1. Build a schedule through the modal — fill Name + pick an agent + a Frequency → the LIVE preview
//      shows the human summary + the generated cron + real next-runs → Create → the row appears in the
//      table AND the REST list carries the right name + cron (the friendly controls composed correctly).
//   2. Name is MANDATORY — the Create button is disabled until a name is typed (observable enable), and the
//      daemon 400s a REST create with no name (the server-side backstop).
//   3. Inline enable/disable — the table's On/Off toggle flips the row AND the REST row's `enabled`.
// Schedules target a project's agents, so the spec seeds a project + agent over REST first and pins it as
// the active project (localStorage `loom.projectId`). Builds on the shared `loomDaemon` fixture;
// profiles-agents.spec.ts / poll-jobs.spec.ts are the templates.
import { expect, test, type Page } from "./fixtures/daemon";

async function seedAgent(baseURL: string, projectId: string, name: string): Promise<{ id: string }> {
  const res = await fetch(`${baseURL}/api/projects/${projectId}/agents`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`seed agent -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

async function listSchedules(baseURL: string): Promise<Array<{ id: string; name: string; cron: string; enabled: boolean }>> {
  const res = await fetch(`${baseURL}/api/schedules`);
  return (await res.json()) as Array<{ id: string; name: string; cron: string; enabled: boolean }>;
}

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// The builder is a role="dialog"; scoping to it keeps locators unambiguous (the table below carries
// look-alike text). The agent picker is the ONLY <select> carrying the "select an agent" placeholder
// (the time-of-day selects that appear for some frequencies don't), so this filter pins it regardless of
// which frequency is active.
const dialog = (page: Page) => page.getByRole("dialog");
const agentSelect = (page: Page) => dialog(page).locator("select").filter({ hasText: "select an agent" });

test.describe("schedules UI (Direction B)", () => {
  test("build a schedule through the modal builder → table + REST", async ({ page, loomDaemon }) => {
    const stamp = Date.now();
    const project = await loomDaemon.createProject(`sched-${stamp}`);
    const agentName = `Orchestrator ${stamp}`;
    await seedAgent(loomDaemon.baseURL, project.id, agentName);
    await pinActiveProject(page, project.id);

    await page.goto(`${loomDaemon.baseURL}/automation`);

    // BEFORE: the empty state (no schedules yet).
    await expect(page.getByText(/no schedules yet/i)).toBeVisible();

    // Open the builder.
    await page.getByRole("button", { name: /new schedule/i }).click();
    await expect(dialog(page)).toBeVisible();

    const create = dialog(page).getByRole("button", { name: /create schedule/i });
    // Name + agent unset → Create is blocked.
    await expect(create).toBeDisabled();

    const name = `Nightly sweep ${stamp}`;
    await dialog(page).getByPlaceholder(/nightly pr sweep/i).fill(name);
    await agentSelect(page).selectOption({ label: agentName });

    // Pick a friendly frequency; the builder composes the cron + the preview updates live.
    await dialog(page).getByRole("button", { name: "Weekdays", exact: true }).click();

    // OBSERVABLE: the live preview shows the human summary AND the generated cron (default 9:00 AM).
    await expect(dialog(page).getByText("Every weekday at 9:00 AM")).toBeVisible();
    await expect(dialog(page).getByText("0 9 * * 1-5")).toBeVisible();
    // The REAL next-runs resolve from the daemon (same matcher the Scheduler uses) — the "computing…"
    // placeholder is replaced by at least one concrete run time.
    await expect(dialog(page).getByText(/computing…/i)).toHaveCount(0, { timeout: 5000 });

    // ACT: create it.
    await expect(create).toBeEnabled();
    await create.click();

    // AFTER (UI): the modal closes and a table row carries the name, the human summary, and the cron.
    await expect(dialog(page)).toHaveCount(0);
    const row = page.locator("tr", { hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByText("Every weekday at 9:00 AM")).toBeVisible();
    await expect(row.getByText("0 9 * * 1-5")).toBeVisible();

    // AFTER (REST): the store the table is built from carries the schedule with its name + composed cron.
    const rows = await listSchedules(loomDaemon.baseURL);
    const created = rows.find((s) => s.name === name);
    expect(created).toBeTruthy();
    expect(created!.cron).toBe("0 9 * * 1-5");
  });

  test("a schedule name is mandatory (client gate + server 400)", async ({ page, loomDaemon }) => {
    const stamp = Date.now();
    const project = await loomDaemon.createProject(`sched-name-${stamp}`);
    const agentName = `Agent ${stamp}`;
    const agent = await seedAgent(loomDaemon.baseURL, project.id, agentName);
    await pinActiveProject(page, project.id);

    await page.goto(`${loomDaemon.baseURL}/automation`);
    await page.getByRole("button", { name: /new schedule/i }).click();
    await expect(dialog(page)).toBeVisible();

    // Choose an agent + a valid frequency but leave the name blank → Create stays disabled (client gate).
    await agentSelect(page).selectOption({ label: agentName });
    await dialog(page).getByRole("button", { name: "Daily", exact: true }).click();
    const create = dialog(page).getByRole("button", { name: /create schedule/i });
    await expect(create).toBeDisabled();

    // Typing a name flips the SAME button to enabled — the observable state change.
    await dialog(page).getByPlaceholder(/nightly pr sweep/i).fill(`Named ${stamp}`);
    await expect(create).toBeEnabled();

    // Server backstop: a REST create with no name is rejected 400 (not silently defaulted).
    const res = await fetch(`${loomDaemon.baseURL}/api/schedules`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, cron: "0 9 * * *" }),
    });
    expect(res.status).toBe(400);
  });

  test("scheduler-off: an honest notice warns that created schedules will not fire", async ({ page, loomDaemon }) => {
    // The e2e daemon boots with LOOM_SCHEDULER_ENABLED=0 and a fresh config (orchestration.schedulerEnabled
    // defaults to false), so the cron ticker is OFF — the live, honest state this notice exists for. Prove
    // the page reflects the REAL resolved gate (from GET /api/orchestration/status), not an unconditional
    // "the backend runs" claim.
    const stamp = Date.now();
    const project = await loomDaemon.createProject(`sched-off-${stamp}`);
    await pinActiveProject(page, project.id);

    await page.goto(`${loomDaemon.baseURL}/automation`);

    // The header status pill reflects the resolved OFF state (distinct from the notice's own badge below).
    await expect(page.getByText(/scheduler off/i).first()).toBeVisible();

    // The inline notice names the consequence AND both ways to turn the scheduler on.
    const notice = page.getByRole("status").filter({ hasText: /will not fire/i });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("LOOM_SCHEDULER_ENABLED=1");
    await expect(notice).toContainText("Settings");

    // REST backstop: the status the UI reads from actually reports the gate as false.
    const status = await fetch(`${loomDaemon.baseURL}/api/orchestration/status`).then((r) => r.json()) as { schedulerEnabled: boolean };
    expect(status.schedulerEnabled).toBe(false);
  });

  test("the table's On/Off toggle enables/disables a schedule", async ({ page, loomDaemon }) => {
    const stamp = Date.now();
    const project = await loomDaemon.createProject(`sched-toggle-${stamp}`);
    const agent = await seedAgent(loomDaemon.baseURL, project.id, `Agent ${stamp}`);
    await pinActiveProject(page, project.id);

    // Seed an ENABLED schedule directly over REST, then flip it from the table.
    const name = `Toggle me ${stamp}`;
    const seeded = await fetch(`${loomDaemon.baseURL}/api/schedules`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, agentId: agent.id, cron: "0 0 1 1 *" }),
    }).then((r) => r.json()) as { id: string };

    await page.goto(`${loomDaemon.baseURL}/automation`);
    const row = page.locator("tr", { hasText: name });
    await expect(row).toBeVisible();

    // BEFORE: the toggle reads ON.
    const toggle = row.getByRole("button", { name: /^on$/i });
    await expect(toggle).toBeVisible();

    // ACT: click it (stopPropagation keeps the row-click editor from opening).
    await toggle.click();

    // AFTER (UI): the toggle now reads OFF.
    await expect(row.getByRole("button", { name: /^off$/i })).toBeVisible();
    // AFTER (REST): the row's enabled flag flipped to false.
    await expect.poll(async () => (await listSchedules(loomDaemon.baseURL)).find((s) => s.id === seeded.id)?.enabled).toBe(false);
  });

  // Deferral observability (card 53edd8d5): a due fire held back by the scheduler's manager-cap budget
  // surfaces as an amber "deferred: <reason>" badge on the row. The e2e daemon boots with the scheduler
  // ticker OFF, so a real deferral can never happen here — seedScheduleDeferral drives the SAME
  // db.markDeferred write path a real tick uses (see the fixture's own doc), proving the UI reads the
  // schedule row's lastDeferredAt/lastDeferredReason correctly.
  test("a budget-deferred schedule shows a 'deferred: <reason>' badge", async ({ page, loomDaemon }) => {
    const stamp = Date.now();
    const project = await loomDaemon.createProject(`sched-deferred-${stamp}`);
    const agent = await seedAgent(loomDaemon.baseURL, project.id, `Agent ${stamp}`);
    await pinActiveProject(page, project.id);

    const name = `Deferred me ${stamp}`;
    const seeded = await fetch(`${loomDaemon.baseURL}/api/schedules`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, agentId: agent.id, cron: "0 0 1 1 *" }),
    }).then((r) => r.json()) as { id: string };

    await page.goto(`${loomDaemon.baseURL}/automation`);
    const row = page.locator("tr", { hasText: name });
    await expect(row).toBeVisible();

    // BEFORE: no deferred badge on a fresh, never-deferred schedule.
    await expect(row.getByText(/deferred:/i)).toHaveCount(0);

    // ACT: seed a deferral (mirrors what Scheduler.tick() writes on a budget-gated transition).
    const reason = "manager cap (3) reached";
    await loomDaemon.seedScheduleDeferral({ scheduleId: seeded.id, reason });

    // AFTER (UI): the badge renders the reason text after a refetch.
    await page.reload();
    const deferredRow = page.locator("tr", { hasText: name });
    await expect(deferredRow.getByText(`deferred: ${reason}`)).toBeVisible();

    // AFTER (REST): the schedule row itself carries the deferred fields (what the badge reads from).
    const rows = await listSchedules(loomDaemon.baseURL);
    const after = rows.find((s) => s.id === seeded.id) as { lastDeferredAt?: string | null; lastDeferredReason?: string | null } | undefined;
    expect(after?.lastDeferredReason).toBe(reason);
    expect(after?.lastDeferredAt).toBeTruthy();
  });

  // Fast-follow fix (card d027577b, CR a3715e68): the badge used to gate ONLY on lastDeferredAt, so a
  // schedule PAUSED mid-deferral still showed "deferred: <reason>" even though it's no longer due at all —
  // an operator who disables a starved schedule shouldn't keep seeing an in-flight-looking amber badge.
  // The render now also gates on s.enabled.
  test("disabling a deferred schedule hides its 'deferred' badge", async ({ page, loomDaemon }) => {
    const stamp = Date.now();
    const project = await loomDaemon.createProject(`sched-defdis-${stamp}`);
    const agent = await seedAgent(loomDaemon.baseURL, project.id, `Agent ${stamp}`);
    await pinActiveProject(page, project.id);

    const name = `Deferred then disabled ${stamp}`;
    const seeded = await fetch(`${loomDaemon.baseURL}/api/schedules`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, agentId: agent.id, cron: "0 0 1 1 *" }),
    }).then((r) => r.json()) as { id: string };

    await loomDaemon.seedScheduleDeferral({ scheduleId: seeded.id, reason: "auditor budget (2) reached" });

    await page.goto(`${loomDaemon.baseURL}/automation`);
    const row = page.locator("tr", { hasText: name });
    await expect(row).toBeVisible();

    // BEFORE: still enabled + deferred → the badge shows.
    await expect(row.getByText(/deferred:/i)).toBeVisible();

    // ACT: pause it via the table's own On/Off toggle (stopPropagation keeps the row editor from opening).
    await row.getByRole("button", { name: /^on$/i }).click();

    // AFTER (UI): the toggle reads Off AND the deferred badge is gone — same page, no reload needed (the
    // toggle mutation already refetches the schedule list).
    await expect(row.getByRole("button", { name: /^off$/i })).toBeVisible();
    await expect(row.getByText(/deferred:/i)).toHaveCount(0);

    // AFTER (REST): the underlying deferral fields are UNTOUCHED by disabling (disable doesn't clear
    // them — only a real fire or a reconcile-advance does) — the fix is purely a RENDER gate.
    const rows = await listSchedules(loomDaemon.baseURL);
    const after = rows.find((s) => s.id === seeded.id) as { enabled: boolean; lastDeferredReason?: string | null } | undefined;
    expect(after?.enabled).toBe(false);
    expect(after?.lastDeferredReason).toBe("auditor budget (2) reached");
  });
});
