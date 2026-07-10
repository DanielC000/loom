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
import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures/daemon";

// Isolation is baked into the fixture (fixtures/daemon.ts): the first-run "Welcome to Loom" overlay is
// dismissed globally, and the seeded companion (a non-archived assistant-role session that would otherwise
// leak into a sibling spec's global "no live sessions" empty state — the companion→usage leak) is archived
// automatically after each test. This spec re-derives neither.

test("shows the seeded companion (not the empty create-box) with Chat + Manage tabs, no selector", async ({ page, loomDaemon }) => {
  await loomDaemon.seedCompanion();
  await page.goto(`${loomDaemon.baseURL}/companion`);

  // NOT the empty create-box — a companion is already seeded. (The "+ New companion" affordance is present
  // but its label is "+ New companion", never the exact "New companion" the create-box heading uses.)
  await expect(page.getByText("New companion", { exact: true })).toHaveCount(0);

  // The companion's name renders in the page header.
  await expect(page.getByText("Ada", { exact: true }).first()).toBeVisible();

  // Multi-companion: the "+ New companion" affordance is always available so an additional companion can be
  // provisioned. (Whether the picker itself renders depends on how many companions exist — it's gated on
  // length > 1, covered hermetically in test/companion-multi.mjs; the shared e2e daemon can't guarantee a
  // single-companion state, so this spec doesn't assert the picker's absence here.)
  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();

  // Exactly one "Companion view" tablist (one focused companion) — Chat + Manage (+ Terminal) tabs.
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

test("multi-companion: a picker lists every companion and switches the focused one", async ({ page, loomDaemon }) => {
  // Two seeded companions (each its own project+agent+session) — the multi-companion runtime (55f1b62) means
  // the page must list both and let the owner switch which one the Chat/Manage/Terminal panes are scoped to.
  // Names carry a per-run suffix: the e2e worker daemon is SHARED, and the companion-config list does not drop
  // archived rows, so sibling tests' seeded companions also appear in the picker. Unique names let this test
  // target ONLY its own two regardless of what else accumulated (mirrors the ".first()" tolerance elsewhere).
  const suffix = randomUUID().slice(0, 8);
  const nameA = `Ada-${suffix}`;
  const nameB = `Bram-${suffix}`;
  await loomDaemon.seedCompanion({ name: nameA });
  await loomDaemon.seedCompanion({ name: nameB });
  await page.goto(`${loomDaemon.baseURL}/companion`);

  // The picker renders (2+ companions), with an entry for each of THIS test's companions.
  const picker = page.getByRole("group", { name: "Select companion" });
  await expect(picker).toBeVisible();
  const btnA = picker.getByRole("button", { name: nameA });
  const btnB = picker.getByRole("button", { name: nameB });
  await expect(btnA).toBeVisible();
  await expect(btnB).toBeVisible();

  // Focus companion B → the chat pane (a companion's default face) re-scopes to B.
  await btnB.click();
  await expect(btnB).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#companion-panel-chat").getByText(nameB, { exact: true })).toBeVisible();

  // Switch to A → the panes re-scope to A (observable state change: the chat header name flips, B de-selects).
  await btnA.click();
  await expect(btnA).toHaveAttribute("aria-pressed", "true");
  await expect(btnB).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#companion-panel-chat").getByText(nameA, { exact: true })).toBeVisible();
});

test("conversation history: the rail lists an archived conversation, opening it shows a read-only transcript, the live chat stays", async ({ page, loomDaemon }) => {
  // A companion with TWO conversations: an archived one (distinctive first message → its history preview,
  // plus a Telegram VOICE turn to prove cross-channel badge + 🎤 rendering carry through) and the current one
  // (still open = the live chat). Unique name so we can target ONLY our companion on the shared worker daemon.
  const name = `Ada-${randomUUID().slice(0, 8)}`;
  const companion = await loomDaemon.seedCompanion({ name });
  await loomDaemon.seedCompanionConversations(companion.sessionId, [
    [
      { author: "user", text: "Roadmap planning for Q3" },
      { author: "companion", text: "Here is the roadmap summary." },
      { author: "user", text: "voice note please", viaVoice: true, channel: "telegram" },
    ],
    [
      { author: "user", text: "Live and current — hello" },
      { author: "companion", text: "Hi! This is the live reply." },
    ],
  ]);
  await page.goto(`${loomDaemon.baseURL}/companion`);

  // Focus OUR companion. On the shared worker daemon sibling tests leave their own companions in the config
  // list (archived rows aren't dropped), so the page loads focused on whichever is "most active" — usually
  // NOT ours — and the picker (rendered when >1 companion exists) is how we switch to it. Gate on the
  // always-present "+ New companion" affordance first: it renders only once the companion list has loaded and
  // the switcher is in its FINAL form, so the picker-present check below can't race an unrendered picker (the
  // old `if (await pickerBtn.count())` read the count right after goto — before the picker mounted — skipped
  // the click, and left a sibling focused: no history rail, a false failure). In an isolated single-companion
  // run there's no picker and ours is already focused, so the click is legitimately skipped.
  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  const pickerBtn = page.getByRole("group", { name: "Select companion" }).getByRole("button", { name });
  if (await pickerBtn.count()) {
    await pickerBtn.click();
    await expect(pickerBtn).toHaveAttribute("aria-pressed", "true"); // focus actually landed on ours
  }

  const chat = page.locator("#companion-panel-chat");
  const rail = chat.locator('aside[aria-label="Conversation history"]');

  // ── The history rail lists the archived conversation by its first-message preview. ──────────────────────
  await expect(rail.getByText("History", { exact: true })).toBeVisible();
  await expect(rail.getByText("Current", { exact: true })).toBeVisible(); // the live-chat entry
  await expect(rail.getByText("Roadmap planning for Q3")).toBeVisible(); // the archived conversation's preview

  // The live chat is showing (composer present) until we open a past conversation.
  await expect(chat.getByRole("textbox", { name: "Message" })).toBeVisible();

  // ── Open the archived conversation → its read-only transcript renders (companion reply + cross-channel). ──
  await rail.getByText("Roadmap planning for Q3").click();
  await expect(chat.getByText("read-only")).toBeVisible();
  await expect(chat.getByText("Here is the roadmap summary.")).toBeVisible(); // the companion's reply bubble
  await expect(chat.getByText("voice note please")).toBeVisible(); // the Telegram voice turn's text
  await expect(chat.getByText("Telegram")).toBeVisible(); // the cross-channel provenance badge
  await expect(chat.locator('[aria-label="Voice message"]')).toBeVisible(); // the 🎤 voice indicator

  // A past conversation is READ-ONLY — no composer while viewing it.
  await expect(chat.getByRole("textbox", { name: "Message" })).toHaveCount(0);

  // ── Back to the live chat → the composer returns (observable state change). ─────────────────────────────
  await chat.getByRole("button", { name: /Live chat/ }).click();
  await expect(chat.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(chat.getByText("read-only")).toHaveCount(0);
});

test("Manage tab: Delete companion is two-step, names the companion, then removes it (observable)", async ({ page, loomDaemon }) => {
  // Two seeded companions on the SHARED worker daemon (unique-suffixed names so this targets only ours).
  // Deleting one must (a) never fire on a single click — it opens a destructive confirm that NAMES the
  // companion, and (b) as an observable state change, make that companion vanish from the page while the
  // sibling stays. Seeded companions are provisioned:false, so DELETE runs the config/binding cascade +
  // reconcile teardown WITHOUT a session stop — no real claude spawn (the fixture's [pty] spawn guard).
  const suffix = randomUUID().slice(0, 8);
  const nameA = `Doomed-${suffix}`;
  const nameB = `Keeper-${suffix}`;
  await loomDaemon.seedCompanion({ name: nameA });
  await loomDaemon.seedCompanion({ name: nameB });
  await page.goto(`${loomDaemon.baseURL}/companion`);

  // Focus companion A (the picker renders with 2+ companions on the shared daemon).
  const picker = page.getByRole("group", { name: "Select companion" });
  await picker.getByRole("button", { name: nameA }).click();

  // Open its Manage tab; the Delete companion control lives at the bottom.
  await page.getByRole("tab", { name: "Manage" }).click();
  const del = page.getByTestId("companion-delete");
  await expect(del).toBeVisible();

  // One click opens a destructive CONFIRM that NAMES the companion — it does NOT delete yet.
  await del.click();
  const confirm = page.getByRole("alertdialog", { name: `Delete ${nameA}` });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText(`Delete ${nameA}?`, { exact: true })).toBeVisible();
  // Still present until we actually confirm (never a single-click delete).
  await expect(picker.getByRole("button", { name: nameA })).toBeVisible();

  // Confirm → the companion is retired. Observable state change: A vanishes from the page; the sibling stays.
  await page.getByTestId("companion-delete-go").click();
  await expect(page.getByText(nameA, { exact: true })).toHaveCount(0);
  await expect(page.getByText(nameB, { exact: true }).first()).toBeVisible();
});

test("multi-companion: the create form opens over the current companion and cancels back", async ({ page, loomDaemon }) => {
  await loomDaemon.seedCompanion({ name: `Ada-${randomUUID().slice(0, 8)}` });
  await page.goto(`${loomDaemon.baseURL}/companion`);

  // A companion is shown (its Chat pane), not the create box.
  await expect(page.getByText("New companion", { exact: true })).toHaveCount(0);
  await expect(page.locator("#companion-panel-chat")).toBeVisible();

  // "+ New companion" opens the create form OVER the current companion (its heading is the exact "New companion").
  await page.getByRole("button", { name: "+ New companion" }).click();
  await expect(page.getByText("New companion", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create companion" })).toBeVisible();

  // Cancel returns to the existing companion without provisioning anything (no real spawn in this fixture).
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("New companion", { exact: true })).toHaveCount(0);
  await expect(page.locator("#companion-panel-chat")).toBeVisible();
});
