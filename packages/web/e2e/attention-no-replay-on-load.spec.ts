// A page load must NOT re-announce attention items that were already pending before it (card 3157a563).
// `useNewAttention` seeded its seen-set on the FIRST EFFECT PASS, which on a cold load runs before
// `allSessions`/`openQuestions` have resolved — so the set seeded EMPTY and every already-pending item was
// treated as brand new once the data landed, raising a browser Notification + a toast for the whole backlog
// on every single load. The fix seeds from the first RESOLVED attention set instead; this spec pins both
// halves of that in one page:
//   • PRE-LOAD items (3 pending requests seeded BEFORE `goto`) raise ZERO notifications.
//   • A POST-LOAD item (a 4th request seeded after the page settled) still raises exactly ONE.
//
// Why the zero is falsifiable rather than a bare wait, two independent reasons:
//   1. THE PILL IS THE WITNESS. The request count pill is level-triggered off the SAME `items` array, in
//      the SAME component (ToastContainer), as the edge-triggered `useNewAttention` call. So the pill
//      reading "3 requests" proves the three items genuinely arrived AND that the render whose effects
//      would have announced them has committed — not merely that nothing happened yet.
//   2. ORDERING. The post-load notification is awaited BEFORE the zero is asserted, so a LATER passive
//      effect has already flushed by then; the zero cannot be an un-flushed-effect race.
// Both polarities therefore fail for a real reason: on pre-fix code the zero reads 3 (the replay), and a
// hook that never fires at all fails the post-load 1.
//
// Seeding (the no-real-claude invariant, as in notification-mutes.spec.ts): the manager is a
// `processState:"live"` DB row via POST /internal/test/seed (never startSession, so no `[pty] spawn`), and
// each request is a seeded row via loomDaemon.seedQuestion. `autoIsolation` answers them after the test.
import { expect, test } from "./fixtures/daemon";

type Recorded = { title: string; body: string | null };

const PRE_LOAD_COUNT = 3;

test("attention items already pending before a page load raise no notifications; one arriving after it does", async ({ page, loomDaemon }) => {
  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "NoReplayMgr" });
  // The daemon is shared worker-scoped state, so a neighbouring spec's pending request is also in the
  // attention set on our load. Every assertion below filters recorded notifications by a needle unique to
  // THIS test, so a foreign item can neither satisfy nor break it.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const preNeedle = `preload-${stamp}`;
  const postNeedle = `postload-${stamp}`;

  // Record `new Notification(...)` instead of raising a real OS one. ToastContainer gates on
  // `typeof Notification !== "undefined" && Notification.permission === "granted"`, so the stub reports
  // granted. Installed BEFORE any page script runs, and re-run on every navigation (which resets the log).
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

  const matching = (needle: string) => page.evaluate((n) =>
    (window as unknown as { __loomNotifications: Recorded[] }).__loomNotifications
      .filter((rec) => (rec.body ?? "").includes(n)), needle) as Promise<Recorded[]>;

  // ---- The backlog: N pending requests that exist BEFORE the page is ever loaded. ----
  for (let i = 0; i < PRE_LOAD_COUNT; i++) {
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, type: "decision",
      title: `Backlog decision ${i + 1} ${preNeedle}`, options: ["A", "B"],
    });
  }

  // /platform is outside the pill's suppression set (/, /overview and /inbox render the attention queue
  // themselves instead), so the pill is available here as the witness.
  await page.goto(`${loomDaemon.baseURL}/platform`);

  // WITNESS (reason 1 above): the three backlog items reached the toast surface. The pill counts EVERY
  // pending request on this shared daemon, ours included, so assert "at least ours" rather than an exact
  // total a neighbouring spec's row could move.
  const pillCount = async () => {
    const text = await page.getByTestId("request-count-pill").textContent();
    return Number(/(\d+)/.exec(text ?? "")?.[1] ?? NaN);
  };
  await expect(page.getByTestId("request-count-pill")).toBeVisible();
  await expect.poll(pillCount).toBeGreaterThanOrEqual(PRE_LOAD_COUNT);
  const pillAfterBacklog = await pillCount();

  // ---- The positive control: a request created AFTER the page settled must still fire. ----
  await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, type: "decision",
    title: `Post-load decision ${postNeedle}`, options: ["A", "B"],
  });
  await expect.poll(async () => (await matching(postNeedle)).length).toBe(1);
  // The pill moved by exactly one, so the backlog items were still present throughout — the zero below is
  // "they never re-fired", not "they had gone away".
  await expect.poll(pillCount).toBe(pillAfterBacklog + 1);

  // ---- THE ASSERTION (ordered after the post-load notification, reason 2 above). ----
  expect(await matching(preNeedle)).toEqual([]);
  // ...and the one that did fire carries its own item's text, i.e. it is the post-load row, not a backlog
  // one that happened to match loosely.
  expect((await matching(postNeedle))[0]!.body).toContain(postNeedle);
});
