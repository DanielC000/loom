// Automation spec (card 0a86869b) — proves the IA consolidation that merges the old /schedules and
// /event-triggers pages into ONE "Automation" destination with a Time (cron) | Events segmented switch.
// Coverage:
//   1. /automation renders the Segmented tabs and defaults to the Time (Schedules) body.
//   2. Switching to the Events tab is an OBSERVABLE state change — the Time body unmounts, the Events body
//      mounts (each keyed on distinctive body copy, so this proves the RIGHT body swapped, not just that a
//      tab highlighted) + the tab is pinned in the URL.
//   3. The old routes redirect: /schedules → /automation (Time tab), /event-triggers → /automation?tab=events.
//   4. Each tab's builder modal opens (an observable — the create/edit dialog mounts on demand).
//   5. PRESERVED gating: the scheduler-off warning still shows on the Time tab. This fixture boots
//      LOOM_SCHEDULER_ENABLED=0 (see fixtures/daemon.ts + schedules.spec.ts), so the honest "will not fire"
//      notice renders — proving the consolidation didn't drop the Time body's state-driven warning.
// Builds on the shared `loomDaemon` fixture; actors.spec.ts is the template. Both tables are god-eye (not
// project-scoped), so no active-project pin is needed. This spec never creates a schedule or trigger (it
// only opens the builder modals), so the shared worker-scoped daemon stays clean — no reset/cleanup step.
import { expect, test } from "./fixtures/daemon";

// Distinctive body copy unique to each tab's page shell — the Schedules blurb vs the Event Triggers blurb.
// Keying on these (not the tab labels) proves which BODY is mounted.
const TIME_BODY = /On each due boundary the daemon boots a manager session/;
const EVENTS_BODY = /React to internal orchestration events/;

test.describe("automation (Schedules + Event Triggers consolidation)", () => {
  // The first-run "Welcome to Loom" overlay is dismissed globally by the fixture (fixtures/daemon.ts).

  test("/automation renders the Segmented tabs and defaults to the Time body", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/automation`);

    // Both tabs render as an accessible tablist (the shared Segmented primitive).
    await expect(page.getByRole("tab", { name: "Time (cron)" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Events" })).toBeVisible();

    // Default tab = Time: the Schedules body is mounted, the Event Triggers body is not.
    await expect(page.getByText(TIME_BODY)).toBeVisible();
    await expect(page.getByText(EVENTS_BODY)).toHaveCount(0);
    // The Time tab reads selected; Events does not.
    await expect(page.getByRole("tab", { name: "Time (cron)" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "false");
  });

  test("switching to the Events tab swaps the mounted body (observable before/after)", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/automation`);

    // BEFORE: the Time body is mounted, the Events body is absent.
    await expect(page.getByText(TIME_BODY)).toBeVisible();
    await expect(page.getByText(EVENTS_BODY)).toHaveCount(0);

    // ACT: click the Events tab.
    await page.getByRole("tab", { name: "Events" }).click();

    // AFTER (observable #1 — DOM swap): the Events body is now mounted and the Time body is gone.
    await expect(page.getByText(EVENTS_BODY)).toBeVisible();
    await expect(page.getByText(TIME_BODY)).toHaveCount(0);
    // AFTER (observable #2 — selection + URL): the Events tab reads selected and the tab is pinned in the URL.
    await expect(page.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/automation\?tab=events/);
  });

  test("the old /schedules and /event-triggers routes redirect to the consolidated Automation page", async ({ page, loomDaemon }) => {
    // /schedules → /automation (Time tab).
    await page.goto(`${loomDaemon.baseURL}/schedules`);
    await expect(page.getByText(TIME_BODY)).toBeVisible();
    await expect(page).toHaveURL(/\/automation$/);

    // /event-triggers → /automation?tab=events (Events tab).
    await page.goto(`${loomDaemon.baseURL}/event-triggers`);
    await expect(page.getByText(EVENTS_BODY)).toBeVisible();
    await expect(page).toHaveURL(/\/automation\?tab=events/);
  });

  test("each tab's builder modal opens on demand", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/automation`);

    // Time tab: the "+ New schedule" builder opens a dialog.
    await page.getByRole("button", { name: /new schedule/i }).click();
    await expect(page.getByRole("dialog", { name: /new schedule/i })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Events tab: the "+ New trigger" builder opens a dialog.
    await page.getByRole("tab", { name: "Events" }).click();
    await expect(page.getByText(EVENTS_BODY)).toBeVisible();
    await page.getByRole("button", { name: /new trigger/i }).click();
    await expect(page.getByRole("dialog", { name: /new event trigger/i })).toBeVisible();
  });

  test("PRESERVED: the scheduler-off warning still shows on the Time tab", async ({ page, loomDaemon }) => {
    // The e2e daemon boots with the cron scheduler OFF (LOOM_SCHEDULER_ENABLED=0). The Time body's honest
    // "will not fire" notice must survive the merge — prove it renders on /automation's default tab.
    await page.goto(`${loomDaemon.baseURL}/automation`);

    await expect(page.getByText(/scheduler off/i).first()).toBeVisible();
    const notice = page.getByRole("status").filter({ hasText: /will not fire/i });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("LOOM_SCHEDULER_ENABLED=1");
  });
});
