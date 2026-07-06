// Companion Manage e2e spec (card 0954ed9c) — proves the /companion page renders a seeded companion (not
// the empty create-box), in the single-companion model (Chat/Manage/Terminal tabs, no selector), and that
// its Manage tab surfaces every read plane: run configuration (masked token read-back), the companion's own
// name, memory, reminders, persona/proactive-home settings, and the chat pane.
//
// SEEDING — CRITICAL (no-real-claude invariant): the Manage page only READS DB state (GET
// /api/companion/config, memory, reminders), so it is seeded via DIRECT DB INSERTS through the test-only
// POST /internal/test/seed (extended for this card — see gateway/server.ts), NEVER through
// POST /api/companion/provision (spawns a real assistant session) or POST /api/companion/config (calls
// companion.reconcile() and ARMS the runtime) — either would trip this fixture's `[pty] spawn` no-spawn
// guard. `loomDaemon.seedCompanion` (fixtures/daemon.ts) wraps the seed call: a NOT-LIVE assistant-role
// session bound to a fresh project+agent, a config row (with a bot token, so there's something to mask), one
// authored memory entry, and one reminder.
//
// Companion is a DAEMON-GLOBAL page (like Skills/Profiles) — no active-project pin is needed.
//
// Note on "name surfaced": the companion config's own `name` field is returned (masked) over REST but has
// no dedicated display in the Manage tab today — the page header instead renders the bound session's AGENT
// name. `seedCompanion` gives the seeded agent the SAME name as the companion's configured name (default
// "Ada"), so asserting that name is visible holds regardless of which source a future UI change reads it
// from.
import { expect, test } from "./fixtures/daemon";

// Isolation is baked into the fixture (fixtures/daemon.ts): the first-run "Welcome to Loom" overlay is
// dismissed globally, and the seeded companion (a non-archived assistant-role session that would otherwise
// leak into a sibling spec's global "no live sessions" empty state — the companion→usage leak) is archived
// automatically after each test. This spec re-derives neither.

test("shows the seeded companion (not the empty create-box) with Chat + Manage tabs, no selector", async ({ page, loomDaemon }) => {
  await loomDaemon.seedCompanion();
  await page.goto(`${loomDaemon.baseURL}/companion`);

  // NOT the empty create-box — a companion is already seeded.
  await expect(page.getByText("New companion", { exact: true })).toHaveCount(0);

  // The companion's name renders in the page header.
  await expect(page.getByText("Ada", { exact: true }).first()).toBeVisible();

  // Single-companion model: exactly one tablist, Chat + Manage (+ Terminal) tabs — no companion selector
  // of any kind (there is nothing to pick between).
  const tablist = page.getByRole("tablist", { name: "Companion view" });
  await expect(tablist).toBeVisible();
  await expect(tablist).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "Chat" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Manage" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Terminal" })).toBeVisible();

  // Chat is the default face — the message composer renders straight away.
  await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

  // The companion's name is surfaced INSIDE the chat panel itself (its header strip), not only in the
  // outer CompanionDetail header — scope to the chat tabpanel so this can't pass on the outer header alone.
  await expect(
    page.locator("#companion-panel-chat").getByText("Ada", { exact: true }),
  ).toBeVisible();
});

test("Manage tab surfaces config (masked), memory, reminders, persona, and proactive-home", async ({ page, loomDaemon }) => {
  const companion = await loomDaemon.seedCompanion();
  await page.goto(`${loomDaemon.baseURL}/companion`);

  await page.getByRole("tab", { name: "Manage" }).click();
  await expect(page.getByRole("tab", { name: "Manage" })).toHaveAttribute("aria-selected", "true");

  // ── Run configuration: the MASKED read-back — token last-4 shown, never the plaintext, name surfaced. ──
  await expect(page.getByText("Run configuration", { exact: true })).toBeVisible();
  await expect(page.getByText("••••••••••oken", { exact: true })).toBeVisible(); // last-4 of "123456:e2e-test-token"
  await expect(page.getByText("123456:e2e-test-token")).toHaveCount(0); // the plaintext token never renders
  await expect(page.getByText("Ada", { exact: true }).first()).toBeVisible(); // the companion's name

  // ── Memory: the seeded entry is listed. ──────────────────────────────────────────────────────────────
  await expect(page.getByText("Memory", { exact: true })).toBeVisible();
  await expect(page.locator("code").filter({ hasText: companion.memoryName })).toBeVisible();

  // ── Reminders: the seeded reminder is listed by its label. ───────────────────────────────────────────
  await expect(page.getByText("Reminders", { exact: true })).toBeVisible();
  await expect(page.getByText(companion.reminderLabel, { exact: true })).toBeVisible();

  // ── Persona / proactive-home: both sections render (empty-but-present is fine — no authoring here). ──
  // "Proactive home" appears twice (the section heading AND an inline cross-reference in Run
  // configuration above it) — .last() pins the heading, which is what proves the SECTION itself renders.
  await expect(page.getByText("Persona / prompt", { exact: true })).toBeVisible();
  await expect(page.getByText("Proactive home", { exact: true }).last()).toBeVisible();
});
