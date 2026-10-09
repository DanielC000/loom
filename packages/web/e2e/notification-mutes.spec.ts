// Per-kind browser-notification mutes (card 51a80b4d). The owner asked to "turn off browser notifications
// for each specific notification type. General toggles no project specific toggles" — so the mute set is a
// DENYLIST of attention-kind ids stored DAEMON-GLOBALLY in PlatformConfig (human-only REST, not
// localStorage: it survives a browser-data clear and the dev/stable origin split). This spec proves both
// halves end-to-end against the isolated daemon, with NO real claude:
//   1. Settings → "Browser notifications": every kind starts ON; unchecking one persists to the stored
//      override and SURVIVES A RELOAD; re-checking it clears the key entirely (an all-on config stores
//      nothing at all, so it reads identically to a daemon that never had this setting).
//   2. ToastContainer actually SKIPS `new Notification` for a muted kind — asserted in BOTH polarities on
//      one page, because "no notification fired" is unfalsifiable on its own: a muted phase that records
//      zero notifications is only meaningful next to an unmuted phase, on the same stub and the same
//      mechanism, that records one. The request COUNT PILL is the independent witness that the attention
//      item really did arrive and the toast surface really did process it during the muted phase.
//
// Seeding (the no-real-claude invariant, same as attention-toast-collapse.spec.ts): the live manager is a
// `processState:"live"` DB row via POST /internal/test/seed (never startSession, so no `[pty] spawn`), and
// each pending Request is a seeded row via loomDaemon.seedQuestion (deps.db.insertQuestion, the same
// writer question_ask uses). The fixture's `autoIsolation` answers every seeded question after each test;
// the platform-config key this spec writes is daemon-global shared state, so it cleans that up itself.
import { expect, test } from "./fixtures/daemon";

/** Read the STORED override's muted list — `null`/absent means "nothing muted", the default. */
async function readMuted(baseURL: string): Promise<string[] | null> {
  const res = await fetch(`${baseURL}/api/platform/config`);
  if (!res.ok) throw new Error(`GET /api/platform/config -> ${res.status}`);
  const body = (await res.json()) as { override?: { mutedBrowserNotifications?: string[] } };
  return body?.override?.mutedBrowserNotifications ?? null;
}

async function patchMuted(baseURL: string, muted: string[] | null): Promise<void> {
  const res = await fetch(`${baseURL}/api/platform/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: { mutedBrowserNotifications: muted } }),
  });
  // Fail LOUDLY: a cleanup that fails quietly leaves daemon-global state for a later spec file to trip
  // over, where nobody will look for it.
  if (!res.ok) throw new Error(`PATCH /api/platform/config -> ${res.status} ${await res.text()}`);
}

test.describe("per-kind browser-notification mutes (card 51a80b4d)", () => {
  // This key is DAEMON-GLOBAL on the shared worker-scoped daemon, so a leftover mute would silence a
  // later spec's notifications. Always clear it back to the all-on default.
  test.afterEach(async ({ loomDaemon }) => {
    await patchMuted(loomDaemon.baseURL, null);
  });

  test("Settings: a kind unchecked stays unchecked across a reload, and re-checking it clears the stored key", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/settings`);

    // "Quiet board" is the kind under test: nothing else in the suite reads it, and the platform default
    // is unmuted, so "muted" is an unambiguous non-default value.
    const quietBoard = page.getByTestId("notify-quiet-board");
    const count = page.getByTestId("notify-muted-count");
    const globalSave = page.getByRole("button", { name: "Save", exact: true }).last();

    // BEFORE: every kind is on by default and nothing is stored.
    await expect(quietBoard).toBeVisible();
    await expect(quietBoard).toBeChecked();
    await expect(count).toHaveText("all on");
    expect(await readMuted(loomDaemon.baseURL)).toBeNull();

    // MUTE it and save.
    await quietBoard.uncheck();
    await expect(quietBoard).not.toBeChecked();
    await expect(count).toHaveText(/^1 of \d+ muted$/);
    await expect(globalSave).toBeEnabled();
    await globalSave.click();

    // AFTER: the stored override carries exactly this one kind...
    await expect.poll(() => readMuted(loomDaemon.baseURL)).toEqual(["quiet-board"]);
    // ...and it SURVIVES A RELOAD (the DoD's own check: toggle off, reload, still off). This is the
    // assertion that would fail on a localStorage-only or render-only implementation.
    await page.reload();
    await expect(page.getByTestId("notify-quiet-board")).not.toBeChecked();
    await expect(page.getByTestId("notify-muted-count")).toHaveText(/^1 of \d+ muted$/);
    // Its siblings are untouched — unchecking one kind must not mute the rest.
    await expect(page.getByTestId("notify-merge-request")).toBeChecked();
    await expect(page.getByTestId("notify-request")).toBeChecked();

    // UNMUTE: re-checking the last muted kind CLEARS the key outright rather than storing `[]`, so an
    // all-on config leaves nothing behind in the override.
    await page.getByTestId("notify-quiet-board").check();
    await expect(page.getByTestId("notify-muted-count")).toHaveText("all on");
    await page.getByRole("button", { name: "Save", exact: true }).last().click();
    await expect.poll(() => readMuted(loomDaemon.baseURL)).toBeNull();
    await page.reload();
    await expect(page.getByTestId("notify-quiet-board")).toBeChecked();
  });

  test("the bulk actions write the full set, and Mute all covers every rendered kind", async ({ page, loomDaemon }) => {
    await page.goto(`${loomDaemon.baseURL}/settings`);
    const count = page.getByTestId("notify-muted-count");
    await expect(count).toHaveText("all on");

    // How many toggles the panel actually renders — derived from the DOM, never hardcoded here, so this
    // assertion keeps holding when a kind is added to BROWSER_NOTIFICATION_KINDS.
    const boxes = page.locator('input[type="checkbox"][data-testid^="notify-"]');
    const total = await boxes.count();
    expect(total).toBeGreaterThan(1);

    await page.getByTestId("notify-mute-all").click();
    await expect(count).toHaveText(`${total} of ${total} muted`);
    await expect(page.locator('input[type="checkbox"][data-testid^="notify-"]:checked')).toHaveCount(0);
    await page.getByRole("button", { name: "Save", exact: true }).last().click();
    // Every rendered toggle round-trips as a VALID kind id — the daemon validates against the shared
    // BROWSER_NOTIFICATION_KINDS enum, so a stray/typo'd testid would 400 this save instead of persisting.
    await expect.poll(async () => (await readMuted(loomDaemon.baseURL))?.length ?? 0).toBe(total);

    await page.getByTestId("notify-unmute-all").click();
    await expect(count).toHaveText("all on");
    await page.getByRole("button", { name: "Save", exact: true }).last().click();
    await expect.poll(() => readMuted(loomDaemon.baseURL)).toBeNull();
  });

  test("a muted kind fires NO browser Notification, while the same kind unmuted fires one", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "MuteMgr" });
    const stamp = Date.now();

    // Replace window.Notification with a recorder BEFORE any page script runs. ToastContainer gates on
    // `typeof Notification !== "undefined" && Notification.permission === "granted"`, so the stub reports
    // granted and never shows a real OS notification. Re-runs on every reload, which also resets the log.
    await page.addInitScript(() => {
      const recorded: { title: string; body: string | null }[] = [];
      (window as unknown as { __loomNotifications: typeof recorded }).__loomNotifications = recorded;
      class RecordingNotification {
        static permission = "granted";
        static requestPermission() { return Promise.resolve("granted"); }
        constructor(title: string, opts?: { body?: string }) {
          recorded.push({ title, body: opts?.body ?? null });
        }
        close() { /* no-op */ }
      }
      (window as unknown as { Notification: unknown }).Notification = RecordingNotification;
    });

    // Count only the notifications raised for THIS test's own seeded request, matched on its unique
    // stamp in the body. The daemon is shared, so filtering on the kind label alone ("DECISION NEEDED")
    // would let a neighbouring spec's pending request count as ours in either direction.
    const title = `Muted-then-unmuted decision ${stamp}`;
    const ourNotifications = () => page.evaluate((needle) =>
      (window as unknown as { __loomNotifications: { title: string; body: string | null }[] })
        .__loomNotifications.filter((n) => (n.body ?? "").includes(needle)), title);

    // ONE request, observed under BOTH mute states — a stronger contrast than two different requests,
    // because the only thing that differs between the two phases is the config value under test.
    //
    // ⚠️ The phase-B replay this leans on is REAL, OBSERVED behavior of `useNewAttention`, and it is the
    // opposite of what that hook's own comment claims ("seeds the seen-set silently on first load (so a
    // reload doesn't replay the backlog)"): on a COLD load the first effect run sees an EMPTY `items` (the
    // sessions/questions queries haven't resolved yet), so the seen-set seeds empty and every
    // already-pending item is treated as new once the data lands. Reported up as a separate finding — do
    // NOT "fix" that comment-vs-behavior mismatch by changing the hook without re-deriving this phase.

    // ---- PHASE A: `request` MUTED, so the item arrives, the pill shows it, NO Notification fires. ----
    await patchMuted(loomDaemon.baseURL, ["request"]);
    // /platform is outside the pill's suppression set (/, /overview, /inbox render the queue instead), so
    // the pill is available here as the witness.
    await page.goto(`${loomDaemon.baseURL}/platform`);
    const pill = page.getByTestId("request-count-pill");
    await expect(pill).toHaveCount(0);

    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, type: "decision",
      title, options: ["A", "B"],
    });
    // THE WITNESS: the pill proves the new attention item really reached the toast surface during this
    // phase. Without it, the zero below would be indistinguishable from "nothing ever arrived" — which is
    // what makes this a real assertion rather than an unfalsifiable wait.
    await expect(pill).toHaveText(/1\s*request needs you/);
    expect(await ourNotifications()).toEqual([]);

    // ---- PHASE B (the positive control): the SAME request, UNMUTED, DOES raise a Notification. ----
    await patchMuted(loomDaemon.baseURL, null);
    // The reload makes the client re-read the platform config, and re-runs the init script so the recorder
    // starts empty again — so anything it catches now was raised under the unmuted config.
    await page.reload();
    await expect(page.getByTestId("request-count-pill")).toHaveText(/1\s*request needs you/);
    await expect.poll(async () => (await ourNotifications()).length).toBe(1);
    // The body carries the request's own text, so the mute gates the notification without degrading it.
    expect((await ourNotifications())[0]!.body).toContain(title);
  });
});
