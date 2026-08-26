// Companion ZERO-REPLY alert e2e (card 8bda9fc6) — the detector's NAMED READER, exercised.
//
// Card 48e8d289 shipped a detector for a companion emitting N turns with ZERO chat_reply deliveries. Its
// only outputs were a durable orchestration event and a `console.warn` — nothing read either, so the
// incident that motivated it (113 silent turns, first noticed when the owner typed "Hello?") would have
// recurred identically. This spec proves the alert now reaches a human, in the surface that human is
// already looking at while waiting for the reply that never came: the companion CHAT panel.
//
// WHY THIS IS A BEFORE/AFTER SPEC, NOT A RENDER CHECK: an inert banner — one wired to a route that always
// answers false, or bound to a field that never changes — passes any "the page loads and the panel renders"
// assertion forever. So the first test asserts the alert ABSENT, drives the state, and asserts it PRESENT;
// the second drives it the other way. The transitions are the evidence.
//
// FIXTURE IDENTITY (load-bearing, and it bit this spec during development): the e2e daemon is SHARED across
// spec files, and `archiveSeededSessions` archives a seeded companion's SESSION but leaves its
// `companion_config` row — so the /companion page legitimately lists companions other tests seeded, and it
// focuses one by activity, not by whoever ran last. A sibling's stuck companion renders a byte-identical
// banner. Every assertion here is therefore scoped by `data-session-id` to THIS test's own companion, and
// each test focuses its companion by a UNIQUE name before looking at the panel.
//
// SEEDING: `loomDaemon.seedCompanionTurns` runs REAL completed turns through the daemon's own
// `incrementTurnSeq` + `checkCompanionReplyHealth` pair (the exact two calls `onTurnCompleted` makes in
// production) via the test-only POST /internal/test/seed. The alert flag is never hand-set — a regression
// in the DETECTOR fails this spec too, rather than being masked by a seeded answer.
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/daemon";

// The detector's threshold (DEFAULT_ZERO_REPLY_TURN_THRESHOLD in companion/reply-watch.ts). The first
// completed turn is consumed by the lazy baseline (it seeds the streak start without alerting), so
// THRESHOLD + 1 turns are needed to actually trip it.
const THRESHOLD = 20;
const TURNS_TO_TRIP = THRESHOLD + 1;

// ONE locator builder for every test, so the "it is absent" assertions and the "it is present" assertion
// can never drift apart by a typo — a mistyped selector would report absence everywhere and prove nothing.
// Test 1 drives this exact locator 0 -> 1, which is the positive control for the absence checks elsewhere.
const alertFor = (page: Page, sessionId: string) =>
  page.locator(`[data-testid="companion-zero-reply-alert"][data-session-id="${sessionId}"]`);

// CROSS-SPEC CLEANUP (load-bearing — omitting it broke a SIBLING spec, not this one): the auto-isolation
// fixture archives a seeded companion's SESSION but leaves its `companion_config` row, and the /companion
// page lists companions from those rows. Every leftover row is another candidate in the page's
// "focus the most active companion" tie-break, and this spec seeds SIX. That was enough to flip which
// companion `companion.spec.ts` found focused, failing an assertion that had nothing to do with this change.
// So this spec deletes its own config rows — the same DELETE the Manage tab's "Delete companion" issues.
const seededConfigSessionIds: string[] = [];

test.afterEach(async ({ page, loomDaemon }) => {
  for (const sessionId of seededConfigSessionIds.splice(0)) {
    // The loopback WRITE surface is bearer-gated (reads are not) — without this header the DELETE 401s
    // silently and the rows survive, which is exactly how the sibling-spec breakage above went unnoticed.
    const res = await page.request.delete(`${loomDaemon.baseURL}/api/companion/config/${sessionId}`, {
      headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` },
    });
    expect(res.ok()).toBe(true); // fail loudly: a cleanup that quietly no-ops breaks a LATER spec, not this one
  }
});

/** Seed a companion with a name unique on the shared daemon, and register it for the cleanup above. */
async function seedTracked(
  loomDaemon: { seedCompanion: (o: { name: string }) => Promise<{ sessionId: string }> },
  prefix: string,
) {
  const name = `${prefix}-${randomUUID().slice(0, 8)}`;
  const companion = await loomDaemon.seedCompanion({ name });
  seededConfigSessionIds.push(companion.sessionId);
  return { ...companion, name };
}

/**
 * Focus this test's own companion, and PROVE the selection took.
 *
 * Waits for the chat panel to actually render first: a bare `count()` immediately after `goto` reads 0
 * while React is still mounting, which silently skips the click and leaves a SIBLING's companion focused —
 * exactly the wrong-fixture failure this spec's header warns about, and how it first went wrong here.
 * The picker itself only renders with 2+ companions; with exactly one, that one is necessarily ours.
 */
async function focusCompanion(page: Page, name: string) {
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  const picker = page.getByRole("group", { name: "Select companion" });
  if ((await picker.count()) === 0) return;
  const button = picker.getByRole("button", { name });
  // Fail loudly rather than quietly asserting against whichever companion happened to be focused.
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

test("the chat panel shows no zero-reply alert for a healthy companion, and shows one once the detector trips", async ({ page, loomDaemon }) => {
  const { name, ...companion } = await seedTracked(loomDaemon, "Zeroreply");

  // -- BEFORE ---------------------------------------------------------------------------------------
  // Assert at the API that THIS companion is healthy, before trusting anything on screen.
  const before = await (await page.request.get(`${loomDaemon.baseURL}/api/companion/status/${companion.sessionId}`)).json();
  expect(before.sessionId).toBe(companion.sessionId);
  expect(before.alerting).toBe(false);
  expect(before.threshold).toBe(THRESHOLD);

  await page.goto(`${loomDaemon.baseURL}/companion`);
  // focusCompanion waits for the chat panel (the companion's default face) before selecting.
  await focusCompanion(page, name);
  await expect(alertFor(page, companion.sessionId)).toHaveCount(0);

  // -- DRIVE ----------------------------------------------------------------------------------------
  await loomDaemon.seedCompanionTurns(companion.sessionId, TURNS_TO_TRIP);

  // The detector really fired — checked at the API, so a UI failure below is unambiguously a UI failure.
  const after = await (await page.request.get(`${loomDaemon.baseURL}/api/companion/status/${companion.sessionId}`)).json();
  expect(after.alerting).toBe(true);
  expect(after.turnsSinceLastReply).toBe(THRESHOLD);

  // -- AFTER ----------------------------------------------------------------------------------------
  // The panel polls the status read on an interval, so the banner appears with no reload and no
  // navigation — the owner sitting in the chat waiting for a reply is told, in place.
  const alert = alertFor(page, companion.sessionId);
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(alert).toContainText("has stopped replying");
  // The specifics, not just the shape: the real streak length and the real threshold, read from the daemon.
  await expect(alert).toContainText(`${THRESHOLD} turns have completed with no answer`);
  await expect(alert).toContainText(`threshold ${THRESHOLD}`);
  // Announced, not merely drawn — a companion that has gone silent is a fault, not a status line.
  await expect(alert).toHaveAttribute("role", "alert");
});

test("the alert clears once the companion replies again — it tracks live state, not a one-way latch", async ({ page, loomDaemon }) => {
  // The complement of the test above, and the one that catches a banner hardwired to "on once seen": drive
  // the detector, confirm the alert, then land a genuine chat_reply and confirm the banner goes AWAY. A
  // latch would pass the first test and fail here.
  const { name, ...companion } = await seedTracked(loomDaemon, "Zeroreply");
  await loomDaemon.seedCompanionTurns(companion.sessionId, TURNS_TO_TRIP);

  await page.goto(`${loomDaemon.baseURL}/companion`);
  await focusCompanion(page, name);
  const alert = alertFor(page, companion.sessionId);
  await expect(alert).toBeVisible({ timeout: 15_000 });

  // A genuine delivered reply — `db.recordChatReplyDelivered`, the exact writer chat-gateway.ts calls on a
  // successful deliverReply, which is what ends the streak.
  await loomDaemon.seedCompanionReplyDelivered(companion.sessionId);
  const cleared = await (await page.request.get(`${loomDaemon.baseURL}/api/companion/status/${companion.sessionId}`)).json();
  expect(cleared.alerting).toBe(false);

  await expect(alert).toHaveCount(0, { timeout: 15_000 });
});

test("a companion running turns WITHOUT a silent streak never shows the alert", async ({ page, loomDaemon }) => {
  // NEGATIVE CONTROL for the banner itself: turns alone must not trip it — only turns WITHOUT replies. A
  // banner keyed on the wrong field (turnSeq, say) would light up here.
  const { name, ...companion } = await seedTracked(loomDaemon, "Zeroreply");
  await loomDaemon.seedCompanionTurns(companion.sessionId, 1); // lazy baseline only

  await page.goto(`${loomDaemon.baseURL}/companion`);
  await focusCompanion(page, name);

  const status = await (await page.request.get(`${loomDaemon.baseURL}/api/companion/status/${companion.sessionId}`)).json();
  expect(status.alerting).toBe(false);
  expect(status.turnSeq).toBeGreaterThan(0); // it really did run turns — this isn't a no-op passing by default
  await expect(alertFor(page, companion.sessionId)).toHaveCount(0);
});

test("the companion switcher marks a stuck companion red, so one sitting behind an unselected tab is still visible", async ({ page, loomDaemon }) => {
  // The chat banner is scoped to the FOCUSED companion. With several companions, a silent one the owner
  // isn't currently looking at would show nothing at all — this is the surface that catches it. Seeds a
  // healthy companion alongside a stuck one so the assertion is a CONTRAST, not just "a dot exists".
  const { name: healthyName } = await seedTracked(loomDaemon, "Healthy");
  const { name: stuckName, ...stuck } = await seedTracked(loomDaemon, "Stuck");

  await page.goto(`${loomDaemon.baseURL}/companion`);
  const picker = page.getByRole("group", { name: "Select companion" });
  await expect(picker).toBeVisible(); // two companions exist, so the picker renders

  // BEFORE: neither is flagged. The title is where the state is exposed to a reader (the dot itself is
  // decorative and deliberately kept out of the button's accessible name).
  const stuckButton = picker.getByRole("button", { name: stuckName });
  const healthyButton = picker.getByRole("button", { name: healthyName });
  await expect(stuckButton).toHaveAttribute("title", "enabled");

  await loomDaemon.seedCompanionTurns(stuck.sessionId, TURNS_TO_TRIP);

  // AFTER: only the stuck one changes. The healthy one is the in-test control — a switcher that flagged
  // everything, or nothing, fails one of these two assertions.
  await expect(stuckButton).toHaveAttribute("title", "not replying — open this companion", { timeout: 15_000 });
  await expect(healthyButton).toHaveAttribute("title", "enabled");
});
