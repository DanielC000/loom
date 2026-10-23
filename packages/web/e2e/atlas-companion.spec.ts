// Card e2af6ad7 (Atlas build plan P2-6) — the Companion's Chat / Manage / Terminal modes on the Atlas
// tree, closing §J.1 of docs/plans/atlas-ui/01-parity-checklist.md. Placement decision + its
// prohibitions: docs/decisions/e2af6ad7-atlas-companion-modes.md.
//
// WHAT IS ACTUALLY AT RISK HERE, and what each test is therefore for:
//   1. REACHABILITY. Every round of mockups homed all twenty Companion write actions to one
//      undifferentiated "Companion tab". If the rebuilt node drops a mode or a Manage section, a real
//      human-only write becomes unreachable with nothing failing — so the §J.1 test is an exhaustive
//      per-section presence sweep, derived from the real declaration rather than typed here.
//   2. GATING. Capability grants, lead mode and restricted tools are human-only trust-boundary controls.
//      Each is exercised to its own confirm step with an observable before/after, so "it rendered" is
//      never mistaken for "it still asks".
//   3. THE READ-ONLY TERMINAL. Its guarantee is a transport-level one, so it is measured on the wire.
//
// 🔴 THE CONTROL THAT MAKES THE TERMINAL'S ZERO MEAN ANYTHING. TerminalPane's stdin write is gated on
// `socket?.readyState === WebSocket.OPEN` (components/Terminal.tsx), so a terminal whose socket never
// opened emits zero stdin frames whether or not the watch-only guard works. A companion seeded the
// ordinary way is an `exited`/`dead` row. So this spec seeds the companion with a CANNED PTY
// (`ptyBytes`), asserts the canned sentinel actually rendered — proving the socket opened and the pane
// attached for real — and only then asserts the zero. The recorder itself is separately proven by a
// POSITIVE CONTROL on a writable worker terminal in the same test.
//
// NO REAL CLAUDE SPAWNS: every row here comes from the test-only POST /internal/test/seed via the
// fixture's own helpers. Nothing calls startSession.
//
// PRESENCE IS SCOPED TO CONTAINERS, ALWAYS. Several Manage section labels collide with Atlas tree node
// labels — "Memory" is a nav destination, "Settings"-adjacent words recur — so a bare getByText would
// resolve against the tree and pass with the panel empty. Every assertion below is scoped to the
// panel's own `data-testid` container.
import { readFileSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding.
const ATLAS_KEY = "loom.atlasUi";

// Only ever seeded ON. Off IS the default (an empty storage key), and addInitScript re-runs on EVERY
// navigation — so a "seed off" script would silently re-clear the key mid-test (measured on P1-0).
async function seedAtlasOn(page: Page) {
  await page.addInitScript((key) => {
    try { localStorage.setItem(key, "1"); } catch { /* storage unavailable — assertions will say so */ }
  }, ATLAS_KEY);
}

// ── The section/group model, parsed out of the real source ─────────────────────────────────────
// The e2e tsconfig covers e2e/ only, so a spec cannot import src/lib/companionManage.ts. Parsing the
// declaration is the idiom this suite already uses for exactly this (e2e/atlas-legacy-redirects.spec.ts
// does it for LEGACY_REDIRECTS): a thirteenth section is then covered the day it is declared, with no
// spec edit, instead of being pinned to a list here that goes quietly stale.
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "companionManage.ts");

function sliceDeclaration(src: string, name: string): string {
  const start = src.indexOf(`export const ${name}`);
  expect(start, `${name} must be declared in src/lib/companionManage.ts`).toBeGreaterThan(-1);
  const end = src.indexOf("\n];", start);
  expect(end, `${name}'s declaration must end with a "\\n];" line`).toBeGreaterThan(start);
  return src.slice(start, end);
}

interface ParsedSection { key: string; group: string }

function parseModel() {
  const src = readFileSync(SRC, "utf8");

  const sectionBlock = sliceDeclaration(src, "COMPANION_MANAGE_SECTIONS");
  const sections: ParsedSection[] = [...sectionBlock.matchAll(/\{\s*key:\s*"([^"]+)",\s*group:\s*"([^"]+)"\s*\}/g)]
    .map((m) => ({ key: m[1]!, group: m[2]! }));
  // ⭐ THE CONTROL THAT MAKES A PARSE TRUSTWORTHY: compare the FILTERED row count against the RAW marker
  // count. A regex that quietly stops matching one row otherwise returns a plausible SUBSET, and a subset
  // reads exactly like a complete list.
  const rawSectionRows = sectionBlock.match(/\{\s*key:/g)?.length ?? 0;
  expect(sections.length, "the section regex matched fewer rows than the declaration has — the parse is a subset")
    .toBe(rawSectionRows);
  expect(sections.length, "COMPANION_MANAGE_SECTIONS should hold the twelve Manage sections").toBeGreaterThan(1);

  const groupBlock = sliceDeclaration(src, "COMPANION_MANAGE_GROUPS");
  const groups = [...groupBlock.matchAll(/\{\s*key:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)]
    .map((m) => ({ key: m[1]!, label: m[2]! }));
  const rawGroupRows = groupBlock.match(/\{\s*key:/g)?.length ?? 0;
  expect(groups.length, "the group regex matched fewer rows than the declaration has").toBe(rawGroupRows);

  // A known row asserted BY NAME, so the pattern is shown to WORK rather than merely to return the right
  // count — a regex matching the wrong capture group would still agree with the raw count above.
  expect(sections.map((s) => s.key)).toContain("capabilities");
  expect(groups.map((g) => g.key)).toContain("trust");

  return { sections, groups };
}

const MODEL = parseModel();

// ── What each section looks like on screen ─────────────────────────────────────────────────────
// Its own <SectionLabel> text. Hand-written (a label is presentation, not data), but the COVERAGE of
// this table against the parsed key set is asserted below — so a new section forces a deliberate edit
// here instead of silently skipping the sweep.
//
// Matched case-insensitively: <SectionLabel> uppercases in CSS, and a text matcher that folds
// `text-transform` would otherwise read "MEMORY" and miss "Memory" (measured on P1-1/P1-3).
const SECTION_LABEL: Record<string, RegExp> = {
  "config": /^Run configuration$/i,
  "home": /^Proactive home$/i,
  "voice": /^Voice provisioning$/i,
  "channels": /^Channels$/i,
  "pairing": /^DM pairing$/i,
  "persona": /^Persona \/ prompt$/i,
  "skills": /^Skills$/i,
  "memory": /^Memory$/i,
  "reminders": /^Reminders$/i,
  "restricted-tools": /^Restrict tools$/i,
  "capabilities": /^Capabilities$/i,
  "delete": /^Delete companion$/i,
};

const node = (page: Page) => page.locator(".loom-companion-node");
// Card 41eab0eb made this node the Workspace node's `companion` TAB, so the document now carries TWO
// `atlas-node-tabs` rows: the Workspace node's own, and this node's modes inside its panel. Every
// locator here is therefore scoped to the Companion node itself — unscoped they resolve both and the
// mode assertions would be reading the host's tab row.
const COMPANION_HOST_TAB = "companion";
const companionPanel = (page: Page) => page.getByTestId(`atlas-tabpanel-${COMPANION_HOST_TAB}`);
const modeTabs = (page: Page) => companionPanel(page).locator('[data-testid="atlas-node-tabs"]');
const modeTab = (page: Page, name: RegExp) => modeTabs(page).getByRole("tab", { name });
const managePanel = (page: Page) => page.locator('[data-testid="companion-mode-panel-manage"]');
const chatPanel = (page: Page) => page.locator('[data-testid="companion-mode-panel-chat"]');
const groupPanel = (page: Page, group: string) => page.locator(`[data-testid="companion-manage-panel-${group}"]`);
const subTab = (page: Page, name: RegExp) =>
  page.locator('[role="tablist"][aria-label="Companion manage sections"]').getByRole("tab", { name });

/**
 * The Companion node's own address for a mode — card 41eab0eb. The node is the Workspace node's
 * `companion` tab now, so the node's path is `/home`, its own `?tab=` is the HOST's, and its modes
 * ride `sub=` (lib/nodeTabHost.tsx). `/companion?tab=X` still works and still lands here, through the
 * Atlas-side redirect that translates the one key onto the other — which is exactly what `openNode`
 * exercises by continuing to navigate the old way.
 */
const modeHref = (mode?: string) => `/home?tab=${COMPANION_HOST_TAB}${mode ? `&sub=${mode}` : ""}`;

/** Open the Atlas Companion node with the companion in focus, asserting WHICH companion we are looking at. */
async function openNode(page: Page, baseURL: string, companionName: string, query = "") {
  await seedAtlasOn(page);
  await page.goto(`${baseURL}/companion${query}`);
  // FIXTURE IDENTITY: a sibling worker's dev server renders this app identically, so pin which companion
  // this is before drawing any conclusion from what is or is not on the page.
  await expect(node(page).getByText(companionName, { exact: true }).first()).toBeVisible();
  return node(page);
}

/** Switch to Manage, then to one of its four sub-sections, and hand back that sub-section's panel. */
async function openManageGroup(page: Page, group: string, label: string): Promise<Locator> {
  await modeTab(page, /^manage$/i).click();
  await expect(managePanel(page)).toBeVisible();
  await subTab(page, new RegExp(`^${label}$`, "i")).click();
  const panel = groupPanel(page, group);
  await expect(panel).toBeVisible();
  return panel;
}

// ── The wire recorders ─────────────────────────────────────────────────────────────────────────
// ONE init script records both sockets this spec cares about, keyed off each instance's own `url`:
// outbound companion-chat frames, and `{type:"stdin"}` frames on any terminal socket. It only RECORDS —
// it never substitutes the socket — so both the chat and the terminal still connect for real, which is
// what makes "the frame went on the wire" a transport fact rather than a React one.
async function recordSockets(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __loomChat: string[]; __loomStdin: string[] };
    w.__loomChat = [];
    w.__loomStdin = [];
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: Parameters<WebSocket["send"]>[0]) {
      try {
        const url = String((this as WebSocket).url ?? "");
        if (typeof data === "string") {
          if (url.includes("/ws/companion")) w.__loomChat.push(data);
          else if (url.includes("/ws/term")) {
            const msg = JSON.parse(data) as { type?: string; data?: string };
            if (msg?.type === "stdin") w.__loomStdin.push(msg.data ?? "");
          }
        }
      } catch { /* binary pty bytes / non-JSON — never one of the frames above */ }
      return origSend.call(this, data);
    };
  });
}

const chatFrames = (page: Page) => page.evaluate(() => (window as unknown as { __loomChat: string[] }).__loomChat ?? []);
const stdinFrames = (page: Page) => page.evaluate(() => (window as unknown as { __loomStdin: string[] }).__loomStdin ?? []);

/**
 * Assert that NO new stdin frame appears for a bounded window after `before`.
 *
 * ⚠️ `expect.poll(...).toEqual([])` is the WRONG tool for this and is worse than the single sleep it
 * looks like an upgrade from: poll stops at the first PASSING sample, and an already-empty array passes
 * immediately — so it would return without waiting at all and a frame sent 50ms later would be missed.
 * An absence claim needs the window to actually elapse. This samples ACROSS the window and asserts
 * emptiness at every sample, so a frame arriving anywhere inside it fails rather than being averaged
 * away by a single end-of-sleep read.
 *
 * The window's length is only meaningful because of the POSITIVE CONTROL at the call site: a writable
 * terminal's frame lands well inside it, which is what makes "nothing arrived" a measured zero rather
 * than an untested one.
 */
async function expectNoStdinFrames(page: Page, before: number, windowMs = 1200, every = 100) {
  const deadline = Date.now() + windowMs;
  let samples = 0;
  do {
    const seen = (await stdinFrames(page)).slice(before);
    expect(seen, `a keystroke reached the wire ${samples} sample(s) into the watch-only window`).toEqual([]);
    samples++;
    await page.waitForTimeout(every);
  } while (Date.now() < deadline);
  // A window that never actually sampled would be a vacuous pass dressed as a measured zero.
  expect(samples, "the watch-only window must take several samples to mean anything").toBeGreaterThan(3);
}

const xtermRows = (page: Page) => page.locator(".xterm-accessibility-tree > div");

async function typeIntoTerminal(page: Page, text: string) {
  await page.locator(".xterm-screen").first().click({ force: true });
  await page.keyboard.type(text);
}

/**
 * Seed one self-authored companion skill by writing its file directly. Companion skills live at
 * `<LOOM_HOME>/companion-skills/<sessionId>/<name>/SKILL.md` and have NO REST or agent write surface by
 * design (only the companion's own MCP authors them) — the fixture's `loomHome` is exposed for exactly
 * this class of state. Without it the Skills section renders its empty state and its one write (delete a
 * skill) has nothing to exercise.
 */
function seedCompanionSkill(loomHome: string, sessionId: string, name: string) {
  const dir = path.join(loomHome, "companion-skills", sessionId, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: seeded for the Atlas Companion node e2e spec\n---\n\nSay less.\n`,
    "utf8",
  );
}

test.describe("Atlas Companion node — the three modes and the twelve Manage sections", () => {
  test("switch ON: the three modes are the node's own tab query, linkable and reload-stable", async ({ page, loomDaemon }) => {
    const name = `Mode-${Date.now().toString(36)}`;
    await loomDaemon.seedCompanion({ name });
    await openNode(page, loomDaemon.baseURL, name);

    // All three modes, in the NODE's own tab row (never the tree's and never the HOST node's — the
    // row is container-scoped; see `modeTabs`).
    for (const label of [/^chat$/i, /^manage$/i, /^terminal$/i]) {
      await expect(modeTab(page, label)).toHaveCount(1);
    }
    // The scoping is a real claim, so it gets a positive control: the HOST's tab row exists on this
    // same document, and the node's own row is NOT it.
    await expect(page.locator('[data-testid="atlas-node-tabs"]'),
      "positive control: the document does not carry both the host's tab row and this node's")
      .toHaveCount(2);
    await expect(page.getByTestId(`atlas-tab-${COMPANION_HOST_TAB}`),
      "the Companion node is showing but its host tab is not selected")
      .toHaveAttribute("aria-selected", "true");

    // Chat is canonical: the bare /companion address shows it, and its URL pins no mode at all.
    await expect(chatPanel(page)).toBeVisible();
    await expect(modeTab(page, /^chat$/i)).toHaveAttribute("aria-selected", "true");
    await expect(managePanel(page)).toBeHidden();
    await expect(page.locator('[data-testid="companion-mode-panel-terminal"]')).toHaveCount(0);

    // BEFORE → AFTER on a mode click: the address changes, and so does which panel is showing. The
    // mode rides the node's own key, and the HOST's `tab=` is left exactly where it was — which is
    // the collision card 41eab0eb's `useTabHost` exists to prevent.
    await modeTab(page, /^manage$/i).click();
    await expect(page).toHaveURL(loomDaemon.baseURL + modeHref("manage"));
    await expect(managePanel(page)).toBeVisible();
    // Chat is HIDDEN, not removed from the DOM. ⚠️ This pair is a STRUCTURAL check only: a panel that
    // React tore down and rebuilt is also "count 1 + hidden", so it cannot see draft loss, which is the
    // property the rule actually protects. The test below proves that one, by its own state.
    await expect(chatPanel(page)).toHaveCount(1);
    await expect(chatPanel(page)).toBeHidden();

    // A RELOAD at the deep link lands on the same mode — the whole reason a mode is URL state and not
    // React state. Asserted by navigation rather than by clicking, so no prior client state can carry it.
    await page.reload();
    await expect(managePanel(page)).toBeVisible();
    await expect(modeTab(page, /^manage$/i)).toHaveAttribute("aria-selected", "true");

    // Terminal mounts only while active (the one deliberate exception to keeping panels mounted: it is
    // read-only, so there is no draft to protect, and mounting it costs a live pty attach).
    await modeTab(page, /^terminal$/i).click();
    await expect(page).toHaveURL(loomDaemon.baseURL + modeHref("terminal"));
    await expect(page.locator('[data-testid="companion-mode-panel-terminal"]')).toBeVisible();
    await modeTab(page, /^chat$/i).click();
    await expect(page).toHaveURL(loomDaemon.baseURL + modeHref());
    await expect(page.locator('[data-testid="companion-mode-panel-terminal"]')).toHaveCount(0);
  });

  test("unfinished input survives a mode switch, in both Chat and Manage", async ({ page, loomDaemon }) => {
    // THE OWNER'S STANDING RULE, tested by the thing it protects. The structural pair in the test above
    // (count 1 + hidden) is satisfied just as well by a panel React unmounted and rebuilt, so it can
    // never catch the regression that matters: a tab click silently discarding half-written input.
    // Local component state is what a remount destroys, so local component state is what this reads
    // back — a composer draft in Chat, and an open editor with typed text in Manage.
    const name = `Draft-${Date.now().toString(36)}`;
    await loomDaemon.seedCompanion({ name });
    await openNode(page, loomDaemon.baseURL, name);

    const chatDraft = "a half-written question I have not sent yet";
    const personaDraft = "Warm, brief, never performative. STILL BEING EDITED";

    // (1) Chat: a composer draft.
    const composer = chatPanel(page).getByRole("textbox");
    await composer.fill(chatDraft);
    await expect(composer).toHaveValue(chatDraft);

    // (2) Manage: an editor the user OPENED (itself local state) with text typed into it.
    const persona = await openManageGroup(page, "persona", "Persona");
    await persona.getByRole("button", { name: "Edit", exact: true }).first().click();
    const personaInput = persona.locator('[data-testid="companion-persona-input"]');
    await expect(personaInput).toBeVisible();
    await personaInput.fill(personaDraft);

    // (3) The round trip the rule is about: Manage → Terminal → Manage → Chat. Terminal is deliberately
    // in the middle because it is the one panel that DOES unmount, so this also proves its unmounting
    // cannot take its neighbours with it.
    await modeTab(page, /^terminal$/i).click();
    await expect(page.locator('[data-testid="companion-mode-panel-terminal"]')).toBeVisible();
    await modeTab(page, /^manage$/i).click();
    await expect(managePanel(page)).toBeVisible();

    // The Manage editor is STILL OPEN (the `editing` flag survived) and still holds the typed text —
    // two separate pieces of local state, either of which a remount would have reset.
    await expect(personaInput, "the persona editor must still be open after a mode round trip").toBeVisible();
    await expect(personaInput).toHaveValue(personaDraft);
    // ...and it is still the sub-section we left it on, rather than snapping back to the default.
    await expect(groupPanel(page, "persona")).toBeVisible();

    await modeTab(page, /^chat$/i).click();
    await expect(chatPanel(page)).toBeVisible();
    await expect(composer, "the composer draft must survive a mode round trip").toHaveValue(chatDraft);

    // A RELOAD is the honest boundary: this rule is about tab clicks, not persistence across a reload,
    // and nothing here claims a draft outlives the page. Asserted so the scope is on the record rather
    // than left for a future reader to assume either way.
    await page.reload();
    await expect(chatPanel(page).getByRole("textbox")).toHaveValue("");
  });

  test("a reader at the live edge returns to it when a reply landed while Chat was hidden", async ({ page, loomDaemon }) => {
    // THE COST OF KEEPING CHAT MOUNTED. A hidden pane is display:none, where every scroll measurement
    // reads 0 and `onScroll` never fires — so the autoscroll effect's `scrollTop = scrollHeight` writes
    // 0 to 0 and does nothing, while `atBottomRef` stays true. The browser then RESTORES the pre-hide
    // offset on re-display, which is correct for a reader who scrolled up and wrong for one who was at
    // the live edge: the conversation grew underneath them, the new reply is off-screen, and no unread
    // badge says so (the at-bottom branch never counts one). `CompanionChat`'s `visible` prop re-pins
    // them. This is the test that stops that prop being deleted as dead code.
    //
    // MEASURED, with the re-pin removed and the build's exit code checked: 3017 of a scrollHeight that
    // had grown to 3514, not at the bottom, the reply off-screen. With it: 3068, at the bottom, in view.
    const name = `Edge-${Date.now().toString(36)}`;
    const companion = await loomDaemon.seedCompanion({ name });
    // Enough turns that the pane genuinely scrolls — with a short conversation there is no "bottom" to
    // be away from and the test would pass without exercising anything.
    const turns = Array.from({ length: 40 }, (_, i) => ({
      author: (i % 2 === 0 ? "user" : "companion") as "user" | "companion",
      text: `turn ${i} — ${"filler ".repeat(6)}`,
    }));
    await loomDaemon.seedCompanionConversations(companion.sessionId, [turns]);

    // Capture the live companion socket so the test can hand its own handler a real inbound frame: the
    // fixture companion has no pty, so it can never reply on its own. Records only — never substitutes
    // the socket — so the chat still connects for real.
    await page.addInitScript(() => {
      const w = window as unknown as { __chatSock: WebSocket | null };
      w.__chatSock = null;
      const Native = window.WebSocket;
      const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
        const sock = protocols === undefined ? new Native(url) : new Native(url, protocols);
        if (String(url).includes("/ws/companion")) w.__chatSock = sock;
        return sock;
      } as unknown as typeof WebSocket;
      Patched.prototype = Native.prototype;
      for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
        Object.defineProperty(Patched, k, { value: Native[k] });
      }
      window.WebSocket = Patched;
    });
    await openNode(page, loomDaemon.baseURL, name);
    await expect(chatPanel(page).getByText("connected", { exact: true })).toBeVisible();

    const scroller = page.locator('[data-testid="companion-chat-scroll"]');
    const atBottom = () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    // PRECONDITION, asserted rather than assumed: the pane really does scroll, and we really are at the
    // live edge. Without both, everything below is vacuous.
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 200),
      { message: "the seeded conversation must be long enough to scroll" }).toBe(true);
    await expect.poll(atBottom, { message: "the reader must start at the live edge" }).toBe(true);

    await modeTab(page, /^manage$/i).click();
    await expect(managePanel(page)).toBeVisible();

    const reply = "A REPLY THAT LANDED WHILE THE CHAT WAS HIDDEN";
    const delivered = await page.evaluate((text) => {
      const sock = (window as unknown as { __chatSock: WebSocket | null }).__chatSock;
      if (!sock) return false;
      sock.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "chat", chatId: "", text }) }));
      return true;
    }, reply);
    expect(delivered, "the instrument must have captured the live companion socket").toBe(true);

    await modeTab(page, /^chat$/i).click();
    await expect(chatPanel(page)).toBeVisible();

    // BACK AT THE LIVE EDGE — and the reply is actually ON SCREEN, which is the thing the reader cares
    // about. The scroll offset alone would pass on a pane that happened to be short.
    await expect.poll(atBottom, { message: "a reader at the live edge must return to it, not to a stale offset" }).toBe(true);
    const replyRow = chatPanel(page).getByText(reply, { exact: true }).first();
    await expect(replyRow).toBeVisible();
    await expect.poll(() => replyRow.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const s = el.closest('[data-testid="companion-chat-scroll"]')!.getBoundingClientRect();
      return r.top >= s.top - 4 && r.bottom <= s.bottom + 4;
    }), { message: "the reply that arrived while hidden must be within the scroll viewport" }).toBe(true);
  });

  test("§J.1: every Manage section is reachable, in exactly one sub-section", async ({ page, loomDaemon }) => {
    const name = `Sections-${Date.now().toString(36)}`;
    await loomDaemon.seedCompanion({ name });
    await openNode(page, loomDaemon.baseURL, name);

    // COVERAGE CONTROL on the label table: it must name exactly the parsed section keys. A section added
    // to the model with no label here would otherwise be skipped by the sweep below and read as a pass.
    expect(Object.keys(SECTION_LABEL).sort()).toEqual(MODEL.sections.map((s) => s.key).sort());

    for (const group of MODEL.groups) {
      const panel = await openManageGroup(page, group.key, group.label);
      const mine = MODEL.sections.filter((s) => s.group === group.key);
      expect(mine.length, `group "${group.key}" must hold at least one section`).toBeGreaterThan(0);

      // PRESENT, scoped to THIS sub-section's own panel — so a label that also exists in the tree (e.g.
      // "Memory", a nav destination) cannot satisfy this from outside the panel.
      //
      // 🔴 THE CONTAINER IS WHAT IS ASSERTED, NOT THE TEXT. A section's own prose legitimately names a
      // SIBLING section (the run config's hint points at "Delete companion"), so a text-only sweep reads
      // a cross-reference as a misplaced section — measured, and it is why each section carries its own
      // `companion-section-<key>` wrapper. The label is then asserted INSIDE that wrapper, so the pair
      // still proves the section actually drew its heading rather than merely mounting an empty div.
      for (const s of mine) {
        const section = panel.locator(`[data-testid="companion-section-${s.key}"]`);
        await expect(section, `section "${s.key}" must render in the "${group.key}" sub-section`).toHaveCount(1);
        await expect(section.getByText(SECTION_LABEL[s.key]!, { exact: true }).first(),
          `section "${s.key}" mounted but did not draw its own heading`).toBeVisible();
      }

      // ...and the other groups' sections are NOT in this panel. This is what makes the sweep a PARTITION
      // check rather than twelve independent presence checks that one over-stuffed panel could satisfy.
      for (const other of MODEL.sections.filter((s) => s.group !== group.key)) {
        await expect(panel.locator(`[data-testid="companion-section-${other.key}"]`),
          `section "${other.key}" belongs to "${other.group}", not "${group.key}"`).toHaveCount(0);
      }
    }

    // The sub-section is URL state too, so a colleague can be sent straight to the dangerous one.
    await page.goto(`${loomDaemon.baseURL}/companion?tab=manage&sec=trust`);
    await expect(groupPanel(page, "trust")).toBeVisible();
    await expect(groupPanel(page, "trust").getByText(/^Capabilities$/i, { exact: true }).first()).toBeVisible();
    // An unknown ?sec= falls back to the canonical first group rather than rendering an empty panel.
    await page.goto(`${loomDaemon.baseURL}/companion?tab=manage&sec=not-a-group`);
    await expect(groupPanel(page, MODEL.groups[0]!.key)).toBeVisible();
  });

  test("Chat sends a message over the websocket from the new location", async ({ page, loomDaemon }) => {
    const name = `Chat-${Date.now().toString(36)}`;
    await loomDaemon.seedCompanion({ name });
    await recordSockets(page);
    const n = await openNode(page, loomDaemon.baseURL, name);

    // The REAL socket must be open first: the pill only reads "connected" once ws.onopen fired, so this is
    // the precondition that makes the send below a send rather than a disabled button.
    await expect(chatPanel(page).getByText("connected", { exact: true })).toBeVisible();

    const text = `atlas-companion-${Date.now().toString(36)}`;
    await chatPanel(page).getByRole("textbox").fill(text);
    await n.getByRole("button", { name: "Send", exact: true }).click();

    // (a) THE WIRE — the outbound frame genuinely left the browser on the companion socket. This is the
    // non-REST write §D of the parity checklist flagged, measured at its own transport.
    await expect.poll(() => chatFrames(page).then((f) => f.join("\n")),
      { message: "the chat send must put a frame on the /ws/companion socket" }).toContain(text);

    // (b) THE MESSAGE ROW — and the composer cleared, so this is a before/after and not just an echo of
    // what is still sitting in the box.
    await expect(chatPanel(page).getByText(text, { exact: true }).first()).toBeVisible();
    await expect(chatPanel(page).getByRole("textbox")).toHaveValue("");
  });

  test("the read-only Terminal: typing reaches no pty, measured on the wire", async ({ page, loomDaemon }) => {
    const sentinel = `loom-e2e-companion-watch-${Date.now().toString(36)}`;
    const name = `Watch-${Date.now().toString(36)}`;
    // CANNED PTY: makes the companion's session genuinely attachable. See this file's header for why a
    // zero measured against a dead session would be worthless.
    await loomDaemon.seedCompanion({ name, ptyBytes: `${sentinel}\r\n` });
    const worker = await loomDaemon.seedLiveSession({ role: "worker", agentName: "Writable Worker", ptyBytes: "ready\r\n" });
    await recordSockets(page);

    // ── POSITIVE CONTROL FIRST: a normal session's terminal IS writable. This proves the recorder can
    // record at all — reading zero frames is exactly what a BROKEN recorder returns too. ───────────────
    await page.goto(`${loomDaemon.baseURL}/session/${worker.sessionId}`);
    await expect(page.getByText(new RegExp(worker.sessionId.slice(0, 8))).first()).toBeVisible();
    await typeIntoTerminal(page, "ls");
    await expect.poll(() => stdinFrames(page).then((f) => f.join("")),
      { message: "a writable terminal must emit a stdin frame — otherwise the zero below means nothing" }).toContain("ls");

    // ── THE COMPANION'S OWN TERMINAL MODE, on the Atlas node. ──────────────────────────────────────────
    await openNode(page, loomDaemon.baseURL, name, "?tab=terminal");
    const terminal = page.locator('[data-testid="companion-mode-panel-terminal"]');
    await expect(terminal).toBeVisible();

    // THE ATTACH IS REAL: the canned bytes only reach the screen over a genuinely OPEN /ws/term socket, so
    // this sentinel is simultaneously the fixture-identity assertion and the proof that a broken watch-only
    // guard WOULD have had an open socket to write to.
    await expect(xtermRows(page).filter({ hasText: sentinel }).first()).toBeVisible();

    // (a) The REST surface: the turn-Composer is withheld, exactly as the classic Companion page does.
    await expect(page.getByRole("button", { name: "Send turn" })).toHaveCount(0);
    await expect(terminal.getByText("read-only", { exact: true }).first()).toBeVisible();

    // (b) THE SILENT SURFACE: the daemon drops a companion stdin frame with NO error frame back, so a
    // keystroke that reaches the wire looks to the owner like nothing happening, forever. Nothing may
    // reach the wire at all.
    const before = (await stdinFrames(page)).length;
    await typeIntoTerminal(page, "whoami");
    await expectNoStdinFrames(page, before);
    await expect(page.getByRole("button", { name: "Send turn" })).toHaveCount(0);
  });

  test("every Manage write is reachable and still asks before it fires", async ({ page, loomDaemon }) => {
    const name = `Writes-${Date.now().toString(36)}`;
    const companion = await loomDaemon.seedCompanion({ name });
    // The Skills section's only write is "delete a skill", so it needs a skill to exist.
    seedCompanionSkill(loomDaemon.loomHome, companion.sessionId, "brevity");
    await openNode(page, loomDaemon.baseURL, name);

    // ── Run: config, proactive home, voice ─────────────────────────────────────────────────────────
    const run = await openManageGroup(page, "run", "Run");

    // createCompanionConfig / updateCompanionConfig — Edit opens the form (its Save is the write).
    await run.getByRole("button", { name: "Edit", exact: true }).first().click();
    await expect(run.getByRole("button", { name: /^Save$/ })).toBeVisible();
    await run.getByRole("button", { name: "Cancel", exact: true }).first().click();
    // ...and the enable/disable write's own control, which fires on one click and so is only asserted
    // reachable here rather than driven (it would flip this companion's own run state mid-spec).
    await expect(run.getByRole("button", { name: /^(Disable|Enable)$/ }).first()).toBeEnabled();

    // setCompanionHome / clearCompanionHome — "Set home" opens the form that carries the write.
    await run.getByRole("button", { name: /^(Set home|Change home)$/ }).click();
    await expect(run.getByRole("button", { name: "Save home" })).toBeVisible();
    await run.getByRole("button", { name: "Cancel", exact: true }).first().click();

    // updatePlatformConfig (the voice toggle) — driven for real, then RESTORED. This key is
    // DAEMON-GLOBAL on the shared worker daemon, so leaving it flipped would leak into a later spec.
    const voice = run.locator("section").filter({ hasText: /Voice provisioning/i }).first();
    const voiceToggle = voice.getByRole("button", { name: /^(Enable|Disable)$/ });
    const wasEnabled = (await voiceToggle.innerText()).trim().toLowerCase() === "disable";
    await voiceToggle.click();
    await expect(voiceToggle).toHaveText(wasEnabled ? /^Enable$/i : /^Disable$/i);
    await voiceToggle.click();
    await expect(voiceToggle).toHaveText(wasEnabled ? /^Disable$/i : /^Enable$/i);

    // ── Channels: bindings, allowed senders, pairing ───────────────────────────────────────────────
    const channels = await openManageGroup(page, "channels", "Channels");

    // createCompanionConfig + createCompanionBinding (the Telegram connect pair).
    await channels.getByRole("button", { name: "Connect Telegram" }).click();
    await expect(channels.getByRole("button", { name: /^Connect$/ })).toBeVisible();
    await channels.getByRole("button", { name: "Cancel", exact: true }).first().click();

    // createCompanionBinding (the advanced, any-channel path).
    await channels.getByRole("button", { name: /^Advanced: add a custom binding$/ }).click();
    await expect(channels.getByRole("button", { name: /^Bind$/ })).toBeVisible();
    await channels.getByRole("button", { name: "Cancel", exact: true }).first().click();

    // mintCompanionPairing — a real write, with the minted code as its observable after-state.
    await channels.getByRole("button", { name: "Mint code" }).click();
    await expect(channels.getByRole("button", { name: /^Copy$/ })).toBeVisible();

    // ── Persona: prompt, skills, memory, reminders ─────────────────────────────────────────────────
    const persona = await openManageGroup(page, "persona", "Persona");

    // updateCompanionPrompt.
    await persona.getByRole("button", { name: "Edit", exact: true }).first().click();
    await expect(persona.locator('[data-testid="companion-persona-input"]')).toBeVisible();
    await expect(persona.getByRole("button", { name: "Save prompt" })).toBeVisible();
    await persona.getByRole("button", { name: "Cancel", exact: true }).first().click();

    // deleteCompanionSkill / deleteCompanionMemory / deleteCompanionReminder — three destructive writes
    // behind the same two-step inline confirm. Each row's own Delete must turn into a Confirm, never fire
    // on the first click.
    for (const row of ["brevity", companion.memoryName, companion.reminderLabel]) {
      const scope = persona.locator("section").filter({ hasText: new RegExp(row.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
      await scope.getByRole("button", { name: "Delete", exact: true }).first().click();
      await expect(scope.getByRole("button", { name: /^Confirm$/ }).first(),
        `the destructive write for "${row}" must ask before it fires`).toBeVisible();
      await scope.getByRole("button", { name: "Cancel", exact: true }).first().click();
    }

    // ── Trust: restricted tools, capabilities, delete ──────────────────────────────────────────────
    const trust = await openManageGroup(page, "trust", "Trust");

    // updateCompanionRestrictedTools + restartCompanionSession — flipping the blast radius is a real
    // write, and its observable after-state is the restart-to-apply affordance appearing.
    const restricted = trust.locator('[data-testid="companion-restricted-tools"]');
    const wasRestricted = await restricted.isChecked();
    await restricted.click();
    await expect(trust.locator('[data-testid="companion-restart-to-apply"]')).toBeVisible();
    // Wait for the flip to LAND before clicking back: the box is controlled by the server read, and it is
    // `disabled` while the mutation is in flight — a `setChecked` racing that window clicks a disabled
    // input and reports "clicking did not change its state" (measured).
    await expect(restricted).toBeChecked({ checked: !wasRestricted });
    await restricted.click();
    await expect(restricted, "the companion is left on the blast radius it started with").toBeChecked({ checked: wasRestricted });

    // setCompanionLeadMode — the most consequential control on the page. The confirm is gated on an
    // explicit acknowledgement, so the chain is: enable → disclosure → ack → the confirm becomes live.
    await trust.locator('[data-testid="companion-lead-mode-enable"]').click();
    await expect(trust.locator('[data-testid="companion-lead-mode-disclosure"]')).toBeVisible();
    const confirmLead = trust.locator('[data-testid="companion-lead-mode-confirm"]');
    await expect(confirmLead, "lead mode must not be confirmable before the acknowledgement").toBeDisabled();
    await trust.locator('[data-testid="companion-lead-mode-ack"]').check();
    await expect(confirmLead).toBeEnabled();
    await trust.locator('[data-testid="companion-lead-mode-cancel"]').click();
    await expect(trust.locator('[data-testid="companion-lead-mode-disclosure"]')).toHaveCount(0);

    // upsertCompanionGrant / deleteCompanionGrant / upgradeCompanionSession — one real chain, because the
    // last of the three is only REACHABLE once a grant is actually pending: `showRestart` is derived from a
    // real pending grant, so asserting it on an ungranted companion would be asserting nothing (measured —
    // the affordance genuinely is not in the DOM until then).
    const lever = trust.locator('[data-testid="companion-lever-git-push"]');
    await expect(lever).toBeVisible();
    await lever.getByRole("combobox").selectOption({ index: 1 });

    // (1) An ELEVATED lever's first grant on a project is confirm-gated, and that gate must survive the
    // relocation — the control reads the same component, but "nothing callable from a mode that shouldn't
    // call it" is only true if the confirm is still in the way.
    await lever.locator('[data-testid="companion-grant-add-git-push"]').click();
    await expect(lever.locator('[data-testid="companion-grant-confirm-git-push"]'),
      "granting an elevated capability must ask first").toBeVisible();

    // (2) Through the confirm: a real upsertCompanionGrant, observable as the grant's own scope row
    // (whose Remove button exists only on a granted scope).
    await lever.locator('[data-testid="companion-grant-confirm-go-git-push"]').click();
    const removeGrant = lever.getByRole("button", { name: "Remove", exact: true });
    await expect(removeGrant, "the confirmed grant must land as a scope row").toBeVisible();

    // (3) upgradeCompanionSession — now pending, so its own confirm step is reachable. Driven to the
    // confirm and no further: the "go" would really respawn the companion.
    await expect(trust.locator('[data-testid="companion-grants-apply"]')).toBeVisible();
    await trust.locator('[data-testid="companion-grants-restart"]').click();
    await expect(trust.locator('[data-testid="companion-grants-restart-go"]'),
      "applying a grant change by restart must ask first").toBeVisible();
    await trust.getByRole("button", { name: "Cancel", exact: true }).first().click();

    // (4) deleteCompanionGrant — a one-click revoke by design (removing reach is the safe direction), so
    // the write itself is driven and the row vanishing is the after-state. Also leaves this companion with
    // the reach it started with, on a daemon shared with every other spec in this worker.
    await removeGrant.click();
    await expect(removeGrant, "revoking must drop the scope row").toHaveCount(0);

    // deleteCompanionConfig — the two-step destructive confirm, which must be a confirm and not a click.
    await trust.locator('[data-testid="companion-delete"]').click();
    await expect(trust.locator('[data-testid="companion-delete-confirm"]')).toBeVisible();
    await expect(trust.locator('[data-testid="companion-delete-go"]')).toBeVisible();
  });

  test("switch OFF: the classic Companion page is untouched", async ({ page, loomDaemon }) => {
    const name = `Classic-${Date.now().toString(36)}`;
    await loomDaemon.seedCompanion({ name });
    // No seedAtlasOn — OFF is the default (an empty storage key), which is the state a user who never
    // opted in is in.
    await page.goto(`${loomDaemon.baseURL}/companion`);

    // The classic page's own tabpanel id, which only it renders.
    const classicChat = page.locator("#companion-panel-chat");
    await expect(classicChat).toBeVisible();
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();

    // NONE of the Atlas node's structure exists here.
    await expect(node(page)).toHaveCount(0);
    await expect(modeTabs(page)).toHaveCount(0);
    await expect(managePanel(page)).toHaveCount(0);

    // The classic mode switch still works, and Manage is still ONE column — no sub-section panels, so
    // every section is where it has always been.
    await page.getByRole("tab", { name: "Manage" }).click();
    await expect(page.locator("#companion-panel-manage")).toBeVisible();
    for (const group of MODEL.groups) {
      await expect(groupPanel(page, group.key),
        "the classic column must not grow Atlas sub-section panels").toHaveCount(0);
    }
    // ...and all twelve sections are visible in that one column at once — the thing the sub-sections
    // deliberately change for Atlas and must NOT change here.
    const column = page.locator("#companion-panel-manage");
    for (const s of MODEL.sections) {
      await expect(column.getByText(SECTION_LABEL[s.key]!, { exact: true }).first(),
        `the classic Manage column must still render "${s.key}"`).toBeVisible();
    }
    // The URL never grew a ?tab= either: the classic mode is React state, as it always was.
    await expect(page).toHaveURL(/\/companion$/);
  });
});
