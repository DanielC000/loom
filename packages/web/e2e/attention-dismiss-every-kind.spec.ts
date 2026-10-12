// Every attention-queue item is dismissable (card 611e76ba — owner ruling 2026-10-12). Before this, only
// STUCK-BUSY / CODEX ISOLATION GAP / the archived CRASH-LOOPED variant carried a `dismissKey`; everything
// else rendered with no × and kept re-announcing itself. This spec pins the two kinds the owner named —
// the empty-board one (QUIET BOARD) and a Request — plus the three properties that make the × worth having:
//
//   1. THE ROW HIDES, AND THE UNDERLYING THING IS UNTOUCHED (design rule 3). The Request is still `pending`
//      in the API after its alert is dismissed — the × hides a notification, it does not answer anything.
//   2. NO NOTIFICATION RE-FIRES for a dismissed item — not on the next poll, not across a reload.
//   3. THE DISMISS SURVIVES A RELOAD. This is the real regression risk in this change: `pruneDismissed`
//      drops any stored key it cannot re-derive, and this card widened the prune's load-gate to every
//      query the (now universally dismissable) kinds come from. Get that gate wrong and the key is wiped
//      on the first poll where one source has resolved and another has not — the row silently returns and
//      a dismiss never sticks. (That exact bug is what codex-isolation-gap-attention.spec.ts caught for
//      the single dismissable kind that existed then; this is its generalisation.)
//
// ORDERING IS LOAD-BEARING, and it is the thing to preserve if this spec is ever edited: both items are
// seeded AFTER the page has settled. A cold load seeds `useNewAttention`'s seen-set SILENTLY from the
// first resolved set (card 3157a563), so an item that already existed before `goto` announces nothing and
// could never serve as a notification control. Every notification control below is therefore an item that
// arrives after its page is up — including after the reload, where the recorder starts empty again.
//
// Why the zeros here are falsifiable rather than bare waits (same discipline as
// attention-no-replay-on-load.spec.ts, whose own header explains it):
//   • Each zero is asserted AFTER a positive control whose notification has already been awaited, so a
//     later passive effect has demonstrably flushed and the zero cannot be an un-flushed-effect race.
//   • Every notification assertion filters on a needle unique to THIS test. The e2e daemon is shared
//     worker-scoped state, so a neighbouring spec's pending Request is also in the attention set; without
//     the needle a foreign row could satisfy or break any of these counts.
//   • The row assertions are scoped by `data-kind` and by this test's own needles, never by bare text.
//
// Seeding keeps the no-real-claude invariant: the manager is a `processState:"live"` DB row via
// POST /internal/test/seed (never startSession), the QUIET BOARD item is a seeded `board_quiet_cause`
// orchestration event, and each Request is a seeded question row. `autoIsolation` archives the session and
// answers the questions afterwards. QUIET BOARD needs no afterEach cleanup of its own: it is derived from
// the per-LIVE-manager event fan-out, so archiving the manager drops it from every later spec's set.
import { expect, test } from "./fixtures/daemon";

type Recorded = { title: string; body: string | null };

test("every attention item can be dismissed; the dismiss sticks and silences its notification", async ({ page, loomDaemon }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestNeedle = `dismiss-req-${stamp}`;
  const controlNeedle = `dismiss-control-${stamp}`;
  const postReloadNeedle = `dismiss-postreload-${stamp}`;
  const seedNeedle = `dismiss-seed-${stamp}`;

  // Record `new Notification(...)` rather than raising a real OS one. ToastContainer gates on
  // `Notification.permission === "granted"`, so the stub reports granted. Installed before any page script
  // and re-run on every navigation — note the log therefore RESETS on reload, which is what makes the
  // post-reload zero meaningful: a re-announcement there would have to be a fresh entry.
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
      .filter((rec) => (rec.body ?? "").includes(n) || rec.title.includes(n)), needle) as Promise<Recorded[]>;

  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: `DismissMgr${stamp.slice(-4)}` });

  // QUIET BOARD's text carries no caller-supplied string, so its notification is identified by the kind in
  // the title PLUS this manager's own id prefix in the body — precise enough that a neighbouring spec's
  // manager could not satisfy it.
  const quietNotifications = () => page.evaluate((idPrefix) =>
    (window as unknown as { __loomNotifications: Recorded[] }).__loomNotifications
      .filter((rec) => rec.title.includes("QUIET BOARD") && (rec.body ?? "").includes(idPrefix)),
    mgr.sessionId.slice(0, 8)) as Promise<Recorded[]>;

  // A throwaway request seeded BEFORE the load, used purely as a readiness witness below.
  await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, type: "decision",
    title: `Seed witness ${seedNeedle}`, options: ["A", "B"],
  });

  // Mission Control renders every kind as a compact AttentionRow (the Overview pulls merge requests out
  // into rich review cards instead), so it is the surface that shows both of ours side by side.
  await page.goto(`${loomDaemon.baseURL}/`);

  // READINESS WITNESS, and the reason the controls below are trustworthy. The witness row is RENDERED
  // (so `items` is populated) and announced NOTHING (so `useNewAttention` has already seeded its seen-set
  // from a resolved set — card 3157a563). Both halves are needed: the row alone would not prove the seed
  // happened, and the silence alone would not prove the data had arrived. Only once the seed has happened
  // does a newly-arriving item reliably announce itself, which every positive control below depends on.
  const seedRow = page.locator('[data-testid="attention-row"]').filter({ hasText: seedNeedle });
  await expect(seedRow).toHaveCount(1);
  expect(await matching(seedNeedle)).toEqual([]);

  // ---- Both items arrive AFTER the load, so each announces itself exactly once (see ORDERING above). ----
  // The empty-board alert the owner named. `board_quiet_cause` is filed once per quiet episode, so this
  // item's dismiss key is that event's own id.
  await loomDaemon.seedOrchestrationEvent({
    managerSessionId: mgr.sessionId, kind: "board_quiet_cause",
    detail: { reason: "nothing-actionable", totalNonTerminal: 0, causeCounts: {}, questionIds: [], releasable: [] },
  });
  // A Request-type item: the kind whose dismiss must provably NOT answer it.
  const questionId = await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, type: "decision",
    title: `Dismissable decision ${requestNeedle}`, options: ["A", "B"],
  });

  const quietRow = page.locator('[data-testid="attention-row"][data-kind="QUIET BOARD"]')
    .filter({ hasText: mgr.sessionId.slice(0, 8) });
  const requestRow = page.locator('[data-testid="attention-row"]').filter({ hasText: requestNeedle });

  await expect(quietRow).toHaveCount(1);
  await expect(requestRow).toHaveCount(1);

  // ---- 1. Both rows carry an × at all. This is the card's headline: before it, neither kind had one. ----
  const quietDismiss = quietRow.getByRole("button", { name: "Dismiss this alert" });
  const requestDismiss = requestRow.getByRole("button", { name: "Dismiss this alert" });
  await expect(quietDismiss).toBeVisible();
  await expect(requestDismiss).toBeVisible();

  // Design rule 3's tooltip, assembled from the kind-specific hint plus the shared invariant.
  await expect(requestDismiss).toHaveAttribute("title", /never answers, cancels, or changes/);

  // Positive controls for the notification channel, BEFORE any zero: each item announced itself, so the
  // recorder, the stub permission and the attention pipeline are all demonstrably working.
  await expect.poll(async () => (await matching(requestNeedle)).length).toBe(1);
  await expect.poll(async () => (await quietNotifications()).length).toBe(1);
  const requestFiredBeforeDismiss = (await matching(requestNeedle)).length;
  const quietFiredBeforeDismiss = (await quietNotifications()).length;

  // ---- 2. Clicking × hides each row. ----
  await quietDismiss.click();
  await expect(quietRow).toHaveCount(0);
  await requestDismiss.click();
  await expect(requestRow).toHaveCount(0);

  // ---- 3. The underlying Request is untouched: still pending, still answerable (design rule 3). ----
  const stillPending = await page.evaluate(async (id) => {
    const res = await fetch(`/api/questions/${id}`);
    const row = await res.json() as { state?: string };
    return row?.state ?? null;
  }, questionId);
  expect(stillPending, "dismissing the alert must not answer or cancel the Request").toBe("pending");

  // ---- 4. No re-fire on a later poll. The control is seeded AFTER the dismiss and its own notification is
  // awaited first, so by the time the zeros are read at least one full attention cycle has run and
  // committed its effects — the counts not moving is a fact about the dismiss, not about timing. ----
  await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, type: "decision",
    title: `Post-dismiss control ${controlNeedle}`, options: ["A", "B"],
  });
  await expect.poll(async () => (await matching(controlNeedle)).length).toBe(1);
  expect(await matching(requestNeedle)).toHaveLength(requestFiredBeforeDismiss);
  expect(await quietNotifications()).toHaveLength(quietFiredBeforeDismiss);

  // ---- 5. The dismiss SURVIVES A RELOAD, and still announces nothing. This is the prune-gate assertion:
  // a `loaded` gate that does not name every query a dismissable kind derives from wipes these keys on the
  // first lopsided poll after the reload, and both rows come back. ----
  await page.reload();
  // The post-dismiss control row is OUR OWN witness that this page's queries have resolved and rendered,
  // so the two zeros below read as "still hidden", not "not loaded yet".
  const controlRow = page.locator('[data-testid="attention-row"]').filter({ hasText: controlNeedle });
  await expect(controlRow).toHaveCount(1);
  await expect(quietRow).toHaveCount(0);
  await expect(requestRow).toHaveCount(0);

  // The recorder was reset by the navigation, and a fresh load seeds its seen-set silently — so the
  // positive control for this zero has to be an item that arrives after the load, which is what this third
  // request is. It proves notifications are live on this page before the zeros below are read.
  await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, type: "decision",
    title: `Post-reload control ${postReloadNeedle}`, options: ["A", "B"],
  });
  await expect.poll(async () => (await matching(postReloadNeedle)).length).toBe(1);
  expect(await matching(requestNeedle), "a dismissed Request must not re-announce on a fresh load").toEqual([]);
  expect(await quietNotifications(), "a dismissed QUIET BOARD must not re-announce on a fresh load").toEqual([]);
});
