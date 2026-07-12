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
  // The cross-channel provenance BADGE — `exact` so it targets the header badge, not the "via Telegram · sent"
  // delivery meta the rebuild now also renders on the owner's Telegram turn (card bbd1ced9).
  await expect(chat.getByText("Telegram", { exact: true })).toBeVisible();
  await expect(chat.locator('[aria-label="Voice message"]')).toBeVisible(); // the 🎤 voice indicator

  // ── The "real chat" rebuild (card bbd1ced9): the transcript is STRUCTURED, not a flat wall. The seed
  // inserts these rows now, so they all fall under a single "Today" day divider — proving the timeline
  // assembly (day dividers + per-group timestamps) renders on real data, not just a bare bubble list. ──────
  await expect(chat.locator('[role="separator"][aria-label="Today"]')).toBeVisible();

  // A past conversation is READ-ONLY — no composer while viewing it.
  await expect(chat.getByRole("textbox", { name: "Message" })).toHaveCount(0);

  // ── Back to the live chat → the composer returns (observable state change). ─────────────────────────────
  await chat.getByRole("button", { name: /Live chat/ }).click();
  await expect(chat.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(chat.getByText("read-only")).toHaveCount(0);
});

test("live chat: a long conversation stays anchored — scrolling up reveals 'Jump to latest', clicking returns to the newest", async ({ page, loomDaemon }) => {
  // The "real chat" rebuild (card bbd1ced9) kills the "endless wall" with a stick-to-bottom + jump-to-latest
  // anchor. Seed the CURRENT (open) conversation with a long back-and-forth so the live chat overflows and is
  // scrollable, then prove the anchor appears only when scrolled up and returns to the newest on click.
  const name = `Ada-${randomUUID().slice(0, 8)}`;
  const companion = await loomDaemon.seedCompanion({ name });
  const longConversation = Array.from({ length: 40 }, (_, i) => ({
    author: (i % 2 === 0 ? "user" : "companion") as "user" | "companion",
    text: `Turn ${i + 1}: ${i % 2 === 0 ? "owner asks about the roadmap" : "companion replies with the rundown"}`,
  }));
  await loomDaemon.seedCompanionConversations(companion.sessionId, [longConversation]); // single batch ⇒ stays open = live chat
  await page.setViewportSize({ width: 820, height: 420 }); // keep the panel short enough that the turns overflow
  await page.goto(`${loomDaemon.baseURL}/companion`);

  // Focus OUR companion (picker renders with >1 companion on the shared daemon).
  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  const pickerBtn = page.getByRole("group", { name: "Select companion" }).getByRole("button", { name });
  if (await pickerBtn.count()) {
    await pickerBtn.click();
    await expect(pickerBtn).toHaveAttribute("aria-pressed", "true");
  }

  const chat = page.locator("#companion-panel-chat");
  const scroll = chat.getByTestId("companion-chat-scroll");
  const jump = chat.locator(".loom-chat-jump");

  // The newest turn renders and the view auto-anchors to the bottom → the jump anchor is NOT engaged.
  await expect(scroll.getByText("Turn 40:", { exact: false })).toBeVisible();
  await expect(jump).not.toHaveClass(/is-shown/);

  // Precondition the mechanic depends on: the transcript actually OVERFLOWS its scroll box (else there's
  // nothing to jump to). Fails loud with the measured heights if the layout didn't bound the panel.
  const overflows = await scroll.evaluate((el) => el.scrollHeight > el.clientHeight + 80);
  expect(overflows, "the seeded transcript should overflow the scroll box").toBe(true);

  // Scroll up off the bottom → the "Jump to latest" anchor engages (observable class-state change). Drive a
  // real 'scroll' event via the wheel (a raw scrollTop assignment can skip React's onScroll in some engines).
  await scroll.hover();
  await page.mouse.wheel(0, -4000);
  await expect(jump).toHaveClass(/is-shown/);
  await expect(jump).toContainText("Jump to latest");

  // Click it → the view snaps back to the newest turn and the anchor disengages.
  await jump.click();
  await expect(jump).not.toHaveClass(/is-shown/);
  await expect(scroll.getByText("Turn 40:", { exact: false })).toBeVisible();
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

test("Capabilities: granting a lever persists across reload + prompts a restart-to-apply, and revoking removes it", async ({ page, loomDaemon }) => {
  // The capability-grant panel (Companion Capability & Permission-Lever Framework): each lever is OFF by
  // default and granted PER PROJECT over the human-only grants REST. A grant takes effect on the companion's
  // NEXT respawn, so the panel must surface an unmistakable "restart to apply" state — never a silent no-op.
  // Seeded companion is provisioned:false + NOT live, so the POST/DELETE grant round-trips (each calls
  // deps.companion.reconcile) run the config path WITHOUT a session stop/spawn — no real claude (the fixture's
  // [pty] spawn no-spawn guard). This drives the full grant→persist→revoke round-trip + the UI states; it does
  // NOT click the actual respawn (that IS the heavy live path — exercised only against a real companion).
  const name = `Ada-${randomUUID().slice(0, 8)}`;
  const companion = await loomDaemon.seedCompanion({ name });
  await page.goto(`${loomDaemon.baseURL}/companion`);

  // Focus OUR companion (the picker renders with >1 companion on the shared worker daemon).
  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  const pickerBtn = page.getByRole("group", { name: "Select companion" }).getByRole("button", { name });
  if (await pickerBtn.count()) {
    await pickerBtn.click();
    await expect(pickerBtn).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("tab", { name: "Manage" }).click();

  // The Capabilities section renders, with the read-only lever flagged read-only and the act-only session
  // control flagged ELEVATED (task DoD: sensitive ACT levers visually flagged).
  await expect(page.getByText("Capabilities", { exact: true })).toBeVisible();
  const fleetCard = page.getByTestId("companion-lever-session-status");
  await expect(fleetCard.getByText("Fleet status", { exact: true })).toBeVisible();
  await expect(fleetCard.getByText("off", { exact: true })).toBeVisible(); // OFF by default
  await expect(page.getByTestId("companion-lever-session-steer").getByText("elevated", { exact: true })).toBeVisible();

  // No restart-to-apply prompt until a grant actually changes.
  await expect(page.getByTestId("companion-grants-apply")).toHaveCount(0);

  // Grant fleet-status on the companion's own seeded project.
  await fleetCard.getByRole("combobox", { name: "Grant Fleet status on a project" }).selectOption(companion.projectId);
  await page.getByTestId("companion-grant-add-session-status").click();

  // The grant persisted (the panel re-reads it via GET) + the restart-to-apply state is unmistakable.
  await expect(fleetCard.getByText("on · 1 project", { exact: true })).toBeVisible();
  await expect(page.getByTestId("companion-grants-apply")).toBeVisible();
  await expect(page.getByTestId("companion-grants-restart")).toBeVisible();

  // Persistence across a FULL reload — a fresh GET, not just the post-mutation optimistic cache.
  await page.reload();
  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  const pickerBtn2 = page.getByRole("group", { name: "Select companion" }).getByRole("button", { name });
  if (await pickerBtn2.count()) {
    await pickerBtn2.click();
    await expect(pickerBtn2).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("tab", { name: "Manage" }).click();
  const fleetCardReloaded = page.getByTestId("companion-lever-session-status");
  await expect(fleetCardReloaded.getByText("on · 1 project", { exact: true })).toBeVisible();

  // Revoke → back to off (observable state change: the DELETE round-trips and the card re-reads empty).
  await fleetCardReloaded.getByRole("button", { name: "Remove" }).click();
  await expect(fleetCardReloaded.getByText("off", { exact: true })).toBeVisible();
  await expect(fleetCardReloaded.getByText("on · 1 project", { exact: true })).toHaveCount(0);
});

test("Capabilities: a lever grants across MULTIPLE projects — the per-lever count and the by-project overview both reflect a second project, and it persists", async ({ page, loomDaemon }) => {
  // Card 324e47ed (epic ccdb1e0c, lever 3): grants are edited PER PROJECT, so the panel must let the owner
  // grant one capability on more than the companion's own bound project — and the cross-project overview must
  // consolidate that N-project picture (which the capability-first lever cards scatter). Same no-spawn seeded-
  // companion path as the single-project round-trip above; we grant fleet-status on the companion's OWN
  // project and then on a SECOND, freshly-created project.
  const name = `Ada-${randomUUID().slice(0, 8)}`;
  const companion = await loomDaemon.seedCompanion({ name });
  const second = await loomDaemon.createProject(`second-${randomUUID().slice(0, 8)}`);
  await page.goto(`${loomDaemon.baseURL}/companion`);

  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  const focus = async () => {
    const pickerBtn = page.getByRole("group", { name: "Select companion" }).getByRole("button", { name });
    if (await pickerBtn.count()) {
      await pickerBtn.click();
      await expect(pickerBtn).toHaveAttribute("aria-pressed", "true");
    }
    await page.getByRole("tab", { name: "Manage" }).click();
  };
  await focus();

  const fleetCard = page.getByTestId("companion-lever-session-status");
  const grantSelect = fleetCard.getByRole("combobox", { name: "Grant Fleet status on a project" });

  // Grant on the companion's own project, then on the SECOND project.
  await grantSelect.selectOption(companion.projectId);
  await page.getByTestId("companion-grant-add-session-status").click();
  await expect(fleetCard.getByText("on · 1 project", { exact: true })).toBeVisible();
  await grantSelect.selectOption(second.id);
  await page.getByTestId("companion-grant-add-session-status").click();

  // The per-lever count reflects BOTH projects (observable state change), and the cross-project overview
  // lists each project as its own row.
  await expect(fleetCard.getByText("on · 2 projects", { exact: true })).toBeVisible();
  const overview = page.getByTestId("companion-grants-by-project");
  await expect(overview).toBeVisible();
  await expect(overview.getByTestId(`companion-grants-project-${companion.projectId}`)).toBeVisible();
  await expect(overview.getByTestId(`companion-grants-project-${second.id}`)).toBeVisible();
  await expect(overview.getByTestId(`companion-grants-project-${second.id}`).getByText(second.name, { exact: false })).toBeVisible();

  // Persistence across a FULL reload — a fresh GET, not the post-mutation optimistic cache.
  await page.reload();
  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  await focus();
  await expect(page.getByTestId("companion-lever-session-status").getByText("on · 2 projects", { exact: true })).toBeVisible();
  await expect(page.getByTestId("companion-grants-by-project").getByTestId(`companion-grants-project-${second.id}`)).toBeVisible();
});

test("Capabilities: decisions-relay act mode reveals the decision-class picker; toggling a class round-trips", async ({ page, loomDaemon }) => {
  // decisions-relay is act-CAPABLE: a read grant lists decisions, an act grant can resolve one — but only for
  // the decision CLASSES the owner explicitly allowlists (an empty set resolves nothing). The panel must (a)
  // offer the read/act mode picker, (b) reveal the class picker only in act mode, and (c) round-trip a class
  // toggle. Same no-spawn seeded-companion path as the grant round-trip above.
  const name = `Ada-${randomUUID().slice(0, 8)}`;
  const companion = await loomDaemon.seedCompanion({ name });
  await page.goto(`${loomDaemon.baseURL}/companion`);

  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  const pickerBtn = page.getByRole("group", { name: "Select companion" }).getByRole("button", { name });
  if (await pickerBtn.count()) {
    await pickerBtn.click();
    await expect(pickerBtn).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("tab", { name: "Manage" }).click();

  const card = page.getByTestId("companion-lever-decisions-relay");
  await card.getByRole("combobox", { name: "Grant Decisions relay on a project" }).selectOption(companion.projectId);
  await page.getByTestId("companion-grant-add-decisions-relay").click();
  await expect(card.getByText("on · 1 project", { exact: true })).toBeVisible();

  // A fresh grant defaults to READ — no decision-class picker yet.
  await expect(card.getByRole("button", { name: "deploy" })).toHaveCount(0);

  // Switch the grant to ACT → the decision-class picker appears (observable state change).
  await card.getByRole("button", { name: "act", exact: true }).click();
  const deployClass = card.getByRole("button", { name: "deploy" });
  await expect(deployClass).toBeVisible();
  await expect(deployClass).toHaveAttribute("aria-pressed", "false");

  // Toggle the "deploy" class ON → it round-trips and reads pressed on the re-read grant.
  await deployClass.click();
  await expect(card.getByRole("button", { name: "deploy" })).toHaveAttribute("aria-pressed", "true");
});

test("Capabilities: granting attention-push (arms live) does NOT raise the restart-to-apply banner", async ({ page, loomDaemon }) => {
  // attention-push is the one lever a daemon watcher arms LIVE (reconcile) with no respawn — so granting it
  // must NOT set the apply-pending state, unlike every respawn-fixed lever. This is the load-bearing focus-4
  // behavior most likely to silently regress (a future refactor that flips every grant to "restart to apply").
  const name = `Ada-${randomUUID().slice(0, 8)}`;
  const companion = await loomDaemon.seedCompanion({ name });
  await page.goto(`${loomDaemon.baseURL}/companion`);

  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  const pickerBtn = page.getByRole("group", { name: "Select companion" }).getByRole("button", { name });
  if (await pickerBtn.count()) {
    await pickerBtn.click();
    await expect(pickerBtn).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("tab", { name: "Manage" }).click();

  const card = page.getByTestId("companion-lever-attention-push");
  await expect(page.getByTestId("companion-grants-apply")).toHaveCount(0); // nothing granted yet
  await card.getByRole("combobox", { name: "Grant Attention push on a project" }).selectOption(companion.projectId);
  await page.getByTestId("companion-grant-add-attention-push").click();

  // Granted (observable) — but because it arms live, NO restart banner is raised.
  await expect(card.getByText("on · 1 project", { exact: true })).toBeVisible();
  await expect(page.getByTestId("companion-grants-apply")).toHaveCount(0);
});

test("Capabilities: an elevated lever (session control) gates its initial grant behind a confirm", async ({ page, loomDaemon }) => {
  // session-steer defaults to an EMPTY roleFilter = ALL roles controllable, and the grant persists (re-arms
  // on any future respawn), so granting it must be deliberate — one click opens a confirm that NAMES the
  // lever + project, it does NOT grant yet (Code Review Major #2).
  const name = `Ada-${randomUUID().slice(0, 8)}`;
  const companion = await loomDaemon.seedCompanion({ name });
  await page.goto(`${loomDaemon.baseURL}/companion`);

  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  const pickerBtn = page.getByRole("group", { name: "Select companion" }).getByRole("button", { name });
  if (await pickerBtn.count()) {
    await pickerBtn.click();
    await expect(pickerBtn).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("tab", { name: "Manage" }).click();

  const card = page.getByTestId("companion-lever-session-steer");
  await card.getByRole("combobox", { name: "Grant Session control on a project" }).selectOption(companion.projectId);
  await page.getByTestId("companion-grant-add-session-steer").click();

  // One click opens a confirm — it does NOT grant yet (still "off").
  const confirm = page.getByTestId("companion-grant-confirm-session-steer");
  await expect(confirm).toBeVisible();
  await expect(card.getByText("off", { exact: true })).toBeVisible();

  // Confirming grants it (observable state change).
  await page.getByTestId("companion-grant-confirm-go-session-steer").click();
  await expect(card.getByText("on · 1 project", { exact: true })).toBeVisible();
});

test("Capabilities: session-spawn (Tier-X) is elevated, flags that it confirms every use, and its grant round-trips", async ({ page, loomDaemon }) => {
  // session-spawn (epic ccdb1e0c lever G) is the highest-privilege lever: elevated (grant-time confirm) AND
  // Tier-X (every USE steps up to a fresh owner confirm, even in a warm trust window). Unlike session-steer
  // — also elevated but friction-FREE per action — its card carries a "confirms each use" badge so the owner
  // isn't misled. Same no-spawn seeded-companion path as the sibling grant tests.
  const name = `Ada-${randomUUID().slice(0, 8)}`;
  const companion = await loomDaemon.seedCompanion({ name });
  await page.goto(`${loomDaemon.baseURL}/companion`);

  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  const focus = async () => {
    const pickerBtn = page.getByRole("group", { name: "Select companion" }).getByRole("button", { name });
    if (await pickerBtn.count()) {
      await pickerBtn.click();
      await expect(pickerBtn).toHaveAttribute("aria-pressed", "true");
    }
    await page.getByRole("tab", { name: "Manage" }).click();
  };
  await focus();

  const card = page.getByTestId("companion-lever-session-spawn");
  // Honest tier/friction labeling: elevated (most powerful) AND confirms every use (Tier-X step-up).
  await expect(card.getByText("elevated", { exact: true })).toBeVisible();
  await expect(card.getByText("confirms each use", { exact: true })).toBeVisible();

  // One click opens a confirm — it does NOT grant yet (still "off").
  await card.getByRole("combobox", { name: "Grant Spawn sessions on a project" }).selectOption(companion.projectId);
  await page.getByTestId("companion-grant-add-session-spawn").click();
  const confirm = page.getByTestId("companion-grant-confirm-session-spawn");
  await expect(confirm).toBeVisible();
  // The confirm honestly reiterates the per-use step-up, so the owner grants it knowing it.
  await expect(confirm.getByText("Every use still asks for your confirmation", { exact: false })).toBeVisible();
  await expect(card.getByText("off", { exact: true })).toBeVisible();

  // Confirming grants it (observable state change).
  await page.getByTestId("companion-grant-confirm-go-session-spawn").click();
  await expect(card.getByText("on · 1 project", { exact: true })).toBeVisible();
  // The granted row shows the fixed act flag (act-only lever, no mode picker).
  await expect(card.getByText("act", { exact: true })).toBeVisible();

  // Persists across a FULL reload.
  await page.reload();
  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  await focus();
  await expect(page.getByTestId("companion-lever-session-spawn").getByText("on · 1 project", { exact: true })).toBeVisible();

  // Revokes cleanly.
  await page.getByTestId("companion-lever-session-spawn").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("companion-lever-session-spawn").getByText("off", { exact: true })).toBeVisible();
});

test("Capabilities: co-granting transcript-read + session control surfaces a grant-time risk banner that persists and clears on revoke", async ({ page, loomDaemon }) => {
  // Card 9beb5ae5 (owner decision 4c33a1bc): the risky PAIR — transcript-read (reads untrusted transcript
  // text into a turn) + session-steer (friction-free cross-session control) — can launder injected
  // instructions into a real action inside one owner turn. The owner chose to KEEP the friction-free model
  // but be WARNED at grant time. The warning is server-computed over the whole grant set and rendered here;
  // the grant still succeeds (a warning, never a block). Same no-spawn seeded-companion path as the sibling
  // grant tests. We grant transcript-read (read-only, direct) then session control (elevated, confirm-gated).
  const name = `Ada-${randomUUID().slice(0, 8)}`;
  const companion = await loomDaemon.seedCompanion({ name });
  await page.goto(`${loomDaemon.baseURL}/companion`);

  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  const focus = async () => {
    const pickerBtn = page.getByRole("group", { name: "Select companion" }).getByRole("button", { name });
    if (await pickerBtn.count()) {
      await pickerBtn.click();
      await expect(pickerBtn).toHaveAttribute("aria-pressed", "true");
    }
    await page.getByRole("tab", { name: "Manage" }).click();
  };
  await focus();

  const banner = page.getByTestId("companion-grants-cogrant-warning");
  // No banner before the risky pair exists.
  await expect(banner).toHaveCount(0);

  // Grant transcript-read (read-only → direct grant, no confirm) on the companion's own project.
  const transcriptCard = page.getByTestId("companion-lever-transcript-read");
  await transcriptCard.getByRole("combobox", { name: "Grant Transcript read on a project" }).selectOption(companion.projectId);
  await page.getByTestId("companion-grant-add-transcript-read").click();
  await expect(transcriptCard.getByText("on · 1 project", { exact: true })).toBeVisible();
  // Still only one side of the pair → no banner yet.
  await expect(banner).toHaveCount(0);

  // Grant session control (elevated → confirm-gated) on the same project, completing the pair.
  const steerCard = page.getByTestId("companion-lever-session-steer");
  await steerCard.getByRole("combobox", { name: "Grant Session control on a project" }).selectOption(companion.projectId);
  await page.getByTestId("companion-grant-add-session-steer").click();
  await page.getByTestId("companion-grant-confirm-go-session-steer").click();
  await expect(steerCard.getByText("on · 1 project", { exact: true })).toBeVisible();

  // The risk banner now renders, naming the specific launder advisory (observable state change).
  await expect(banner).toBeVisible();
  await expect(page.getByTestId("companion-cogrant-warning-transcript-steer-launder")).toBeVisible();

  // Persists across a FULL reload — it's server-derived from the whole grant set, not transient client state.
  await page.reload();
  await expect(page.getByRole("button", { name: "+ New companion" })).toBeVisible();
  await focus();
  await expect(page.getByTestId("companion-grants-cogrant-warning")).toBeVisible();

  // Revoking one side of the pair clears the warning.
  await page.getByTestId("companion-lever-transcript-read").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("companion-lever-transcript-read").getByText("off", { exact: true })).toBeVisible();
  await expect(page.getByTestId("companion-grants-cogrant-warning")).toHaveCount(0);
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
